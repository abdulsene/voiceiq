/**
 * Phase 3.1a — customer service topic catalogue endpoints.
 *
 *   GET   /api/business/topics             — current + industry defaults
 *   PATCH /api/business/topics             — full replacement of the list
 *   POST  /api/business/topics/reset       — restore industry defaults
 *
 * Topics live on business_configs.departments (JSONB array of {slug,
 * name, description, example_utterances}). Industry defaults live on
 * industry_templates.default_topics (populated by migration 036).
 *
 * PATCH is a bulk replace, not a differential update — the UI sends the
 * full list, we write it verbatim after validation. This matches the
 * settings-page mental model ("edit the list, hit save") and avoids
 * merge conflicts across concurrent editors.
 *
 * Slug validation rules:
 *   * snake_case: /^[a-z][a-z0-9_]*$/
 *   * unique within the list
 *   * max 12 topics per business (soft product cap — bump if needed)
 *
 * Handlers exported as pure functions for the 035 smoke.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";

const router = Router();

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const MAX_TOPICS = 12;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const UTTERANCE_MAX = 200;
const MAX_UTTERANCES = 10;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Types ────────────────────────────────────────────────────────────

export interface Topic {
  slug: string;
  name: string;
  description: string;
  example_utterances: string[];
}

// ── Validation ───────────────────────────────────────────────────────

export function parseTopicsBody(body: unknown): { topics: Topic[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.topics)) return { error: "topics must be an array" };
  if (b.topics.length > MAX_TOPICS) return { error: `at most ${MAX_TOPICS} topics per business` };

  const out: Topic[] = [];
  const seenSlugs = new Set<string>();
  for (const raw of b.topics as unknown[]) {
    if (!raw || typeof raw !== "object") return { error: "each topic must be an object" };
    const t = raw as Record<string, unknown>;

    const slug = typeof t.slug === "string" ? t.slug.trim() : "";
    if (!SLUG_RE.test(slug)) return { error: `invalid slug "${slug}" (expected snake_case)` };
    if (seenSlugs.has(slug)) return { error: `duplicate slug "${slug}"` };
    seenSlugs.add(slug);

    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return { error: `topic "${slug}" is missing name` };
    if (name.length > NAME_MAX) return { error: `topic "${slug}" name exceeds ${NAME_MAX} chars` };

    const description = typeof t.description === "string" ? t.description.trim() : "";
    if (description.length > DESCRIPTION_MAX) {
      return { error: `topic "${slug}" description exceeds ${DESCRIPTION_MAX} chars` };
    }

    let example_utterances: string[] = [];
    if (Array.isArray(t.example_utterances)) {
      example_utterances = t.example_utterances
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
      if (example_utterances.length > MAX_UTTERANCES) {
        return { error: `topic "${slug}" has too many example_utterances (max ${MAX_UTTERANCES})` };
      }
      for (const u of example_utterances) {
        if (u.length > UTTERANCE_MAX) {
          return { error: `topic "${slug}" utterance exceeds ${UTTERANCE_MAX} chars` };
        }
      }
    }

    out.push({ slug, name, description, example_utterances });
  }
  return { topics: out };
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function handleGetTopics(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; topics: Topic[]; industry_defaults: Topic[]; industry_id: string | null }
  | { ok: false; status: number; error: string }
> {
  try {
    const bizResp = await supabase
      .from("business_configs")
      .select("departments, industry")
      .eq("business_id", businessId)
      .maybeSingle();
    if (bizResp.error) {
      Sentry.captureMessage("topics_get_biz_failed", {
        level: "error",
        extra: { businessId, error: bizResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const bizRow = bizResp.data as { departments?: unknown; industry?: string | null } | null;
    if (!bizRow) return { ok: false, status: 404, error: "Business not found" };

    const topics = normalizeTopicsJsonb(bizRow.departments);
    const industryId = bizRow.industry || null;

    let industry_defaults: Topic[] = [];
    if (industryId) {
      const indResp = await supabase
        .from("industry_templates")
        .select("default_topics")
        .eq("industry_id", industryId)
        .maybeSingle();
      if (!indResp.error && indResp.data) {
        industry_defaults = normalizeTopicsJsonb((indResp.data as any).default_topics);
      }
    }
    return { ok: true, topics, industry_defaults, industry_id: industryId };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handlePatchTopics(
  supabase: SupabaseClient,
  businessId: string,
  topics: Topic[],
): Promise<{ ok: true; topics: Topic[] } | { ok: false; status: number; error: string }> {
  try {
    const { data, error } = await supabase
      .from("business_configs")
      .update({ departments: topics })
      .eq("business_id", businessId)
      .select("departments")
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("topics_patch_failed", {
        level: "error",
        extra: { businessId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (!data) return { ok: false, status: 404, error: "Business not found" };
    return { ok: true, topics: normalizeTopicsJsonb((data as any).departments) };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleResetTopics(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; topics: Topic[]; source: "industry_defaults" | "empty" }
  | { ok: false; status: number; error: string }
> {
  try {
    const bizResp = await supabase
      .from("business_configs")
      .select("industry")
      .eq("business_id", businessId)
      .maybeSingle();
    if (bizResp.error) return { ok: false, status: 500, error: "Database error" };
    if (!bizResp.data) return { ok: false, status: 404, error: "Business not found" };
    const industryId = (bizResp.data as any).industry as string | null;

    let defaults: Topic[] = [];
    let source: "industry_defaults" | "empty" = "empty";
    if (industryId) {
      const indResp = await supabase
        .from("industry_templates")
        .select("default_topics")
        .eq("industry_id", industryId)
        .maybeSingle();
      if (!indResp.error && indResp.data) {
        defaults = normalizeTopicsJsonb((indResp.data as any).default_topics);
        if (defaults.length > 0) source = "industry_defaults";
      }
    }

    const { error: updateErr } = await supabase
      .from("business_configs")
      .update({ departments: defaults })
      .eq("business_id", businessId);
    if (updateErr) {
      Sentry.captureMessage("topics_reset_failed", {
        level: "error",
        extra: { businessId, error: updateErr.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    return { ok: true, topics: defaults, source };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

function normalizeTopicsJsonb(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  for (const t of raw as any[]) {
    if (!t || typeof t !== "object") continue;
    const slug = typeof t.slug === "string" ? t.slug : "";
    const name = typeof t.name === "string" ? t.name : "";
    if (!slug || !name) continue;
    out.push({
      slug,
      name,
      description: typeof t.description === "string" ? t.description : "",
      example_utterances: Array.isArray(t.example_utterances)
        ? (t.example_utterances as unknown[]).filter((u): u is string => typeof u === "string")
        : [],
    });
  }
  return out;
}

// ── Route registrations ─────────────────────────────────────────────

router.get(
  "/business/topics",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleGetTopics(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      topics: result.topics,
      industry_defaults: result.industry_defaults,
      industry_id: result.industry_id,
    });
  },
);

router.patch(
  "/business/topics",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const parsed = parseTopicsBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handlePatchTopics(supabase, businessId, parsed.topics);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ topics: result.topics });
  },
);

router.post(
  "/business/topics/reset",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleResetTopics(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ topics: result.topics, source: result.source });
  },
);

export default router;
