/**
 * Phase 3.3c — explicit AI-receptionist resync.
 *
 * updateAgentTools was previously invoked only as a side-effect of
 * saving a business config (routes/api.ts:1883 during onboarding, etc.).
 * There was no way to say "push my current config to ElevenLabs" once
 * onboarding was done, and no way to see which tools an agent had
 * without opening the ElevenLabs console. Consequence: EZ Rentals
 * shipped without route_to_topic attached and nobody noticed until an
 * inbound call fell through routing.
 *
 * This slice adds two operations:
 *
 *   POST /api/business/agent/resync
 *     requireAuth + requirePermission("settings","write").
 *     Runs updateAgentTools() for the caller's active business, then
 *     re-reads the agent from ElevenLabs and returns the resulting
 *     tool names + timestamp. UI surfaces the tool list so ops can
 *     answer "is route_to_topic attached?" from the dashboard.
 *
 *   GET /api/business/agent/tools
 *     requireAuth + requirePermission("settings","read").
 *     Read-only version of the above — fetches current registered
 *     tools without re-running updateAgentTools. Cheap, safe to poll
 *     from the settings page.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import { updateAgentTools } from "../agents";

const router = Router();

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not set");
  return key;
}

/**
 * Read the current agent from ElevenLabs and extract the tool NAMES
 * (not the full schemas — we only need to answer "is X attached?").
 * Returns null shape when the business has no agent yet (pre-onboarding).
 */
export async function fetchRegisteredToolNames(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; agentId: string | null; toolNames: string[] }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("agent_id")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  const agentId = (data as { agent_id?: string | null } | null)?.agent_id ?? null;
  if (!agentId) return { ok: true, agentId: null, toolNames: [] };

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
      headers: { "xi-api-key": getApiKey() },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: 502,
        error: `ElevenLabs GET failed: HTTP ${res.status} ${body.slice(0, 200)}`,
      };
    }
    const agent: any = await res.json();
    const tools: any[] = Array.isArray(agent?.conversation_config?.agent?.prompt?.tools)
      ? agent.conversation_config.agent.prompt.tools
      : [];
    const names = tools
      .map((t: any) => (typeof t?.name === "string" ? t.name : null))
      .filter((n): n is string => !!n);
    return { ok: true, agentId, toolNames: names };
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "fetchRegisteredToolNames", businessId } });
    return { ok: false, status: 500, error: err?.message || "elevenlabs_fetch_failed" };
  }
}

router.get(
  "/business/agent/tools",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response): Promise<void> => {
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const result = await fetchRegisteredToolNames(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      agent_id: result.agentId,
      registered_tools: result.toolNames,
    });
  },
);

router.post(
  "/business/agent/resync",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response): Promise<void> => {
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const startedAt = new Date();
    const sync = await updateAgentTools(supabase, businessId);
    if (!sync.success) {
      res.status(502).json({
        error: sync.error || "resync_failed",
        started_at: startedAt.toISOString(),
      });
      return;
    }
    // Re-read to report the ACTUAL registered tool set (not just "we
    // sent a PATCH"). If ElevenLabs silently rejected any tool we
    // wanted to register, the returned list will be missing it — the
    // UI can render a warning.
    const readback = await fetchRegisteredToolNames(supabase, businessId);
    const finishedAt = new Date();
    if (!readback.ok) {
      res.status(207).json({
        resync_ok: true,
        readback_ok: false,
        readback_error: readback.error,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
      });
      return;
    }
    res.json({
      resync_ok: true,
      agent_id: readback.agentId,
      registered_tools: readback.toolNames,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
    });
  },
);

export default router;
