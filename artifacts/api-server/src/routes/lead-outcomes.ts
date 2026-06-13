/**
 * Outcome capture per lead-call. Slice 3A pillar 1.
 *
 *   POST /api/business/leads/:id/calls/:callSid/outcome
 *
 * Staff records what happened on a callback. Body:
 *   {
 *     outcome:    'resolved' | 'booked' | 'follow_up_needed' |
 *                 'no_answer' | 'wrong_number' | 'declined' |
 *                 'lost' | 'other'
 *     reason_code?: 'price' | 'timing' | 'competitor' | 'not_qualified'
 *                 | 'changed_mind' | 'other'
 *     reason_note?: string
 *     follow_up_at?: ISO8601   (required iff outcome === 'follow_up_needed')
 *   }
 *
 * Behaviour:
 *   - Verifies the lead belongs to req.businessId AND the callSid
 *     belongs to that lead. Cross-tenant call ids return 404 (anti-
 *     enumeration; never confirm existence).
 *   - UPSERTs lead_call_outcomes on lead_call_id UNIQUE — re-recording
 *     overwrites.
 *   - Updates leads.status + leads.outcome_booked per the mapping
 *     in the spec:
 *       resolved          → status='resolved'
 *       booked            → status='resolved'  + outcome_booked=true
 *       follow_up_needed  → status stays 'open' / current
 *       no_answer | wrong_number | declined | lost | other
 *                         → status stays current (auto-close cron lands later)
 *   - Writes lead_activities row (action='outcome_recorded').
 *
 * RBAC: requireAuth + requirePermission('calls','write') — same bucket
 * that owns initiating the bridge.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";

const router = Router();

const OUTCOME_VALUES = new Set([
  "resolved",
  "booked",
  "follow_up_needed",
  "no_answer",
  "wrong_number",
  "declined",
  "lost",
  "other",
]);

const REASON_VALUES = new Set([
  "price",
  "timing",
  "competitor",
  "not_qualified",
  "changed_mind",
  "other",
]);

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

interface OutcomeBody {
  outcome?: unknown;
  reason_code?: unknown;
  reason_note?: unknown;
  follow_up_at?: unknown;
}

function validateBody(raw: OutcomeBody): { ok: true; value: {
  outcome: string;
  reason_code: string | null;
  reason_note: string | null;
  follow_up_at: string | null;
} } | { ok: false; error: string } {
  if (typeof raw.outcome !== "string" || !OUTCOME_VALUES.has(raw.outcome)) {
    return { ok: false, error: "outcome must be one of: " + Array.from(OUTCOME_VALUES).join(", ") };
  }
  const outcome = raw.outcome;

  let reason_code: string | null = null;
  if (raw.reason_code !== undefined && raw.reason_code !== null && raw.reason_code !== "") {
    if (typeof raw.reason_code !== "string" || !REASON_VALUES.has(raw.reason_code)) {
      return { ok: false, error: "reason_code must be one of: " + Array.from(REASON_VALUES).join(", ") };
    }
    reason_code = raw.reason_code;
  }

  let reason_note: string | null = null;
  if (raw.reason_note !== undefined && raw.reason_note !== null && raw.reason_note !== "") {
    if (typeof raw.reason_note !== "string") {
      return { ok: false, error: "reason_note must be a string" };
    }
    reason_note = raw.reason_note.slice(0, 2000);
  }

  let follow_up_at: string | null = null;
  if (outcome === "follow_up_needed") {
    if (typeof raw.follow_up_at !== "string") {
      return { ok: false, error: "follow_up_at (ISO8601) is required when outcome=follow_up_needed" };
    }
    const parsed = new Date(raw.follow_up_at);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: "follow_up_at must be a valid ISO8601 timestamp" };
    }
    follow_up_at = parsed.toISOString();
  } else if (raw.follow_up_at !== undefined && raw.follow_up_at !== null && raw.follow_up_at !== "") {
    // Allow ignoring follow_up_at on non-follow_up outcomes (forgiving),
    // but don't persist it — it would be confusing on the lead detail.
    follow_up_at = null;
  }

  return { ok: true, value: { outcome, reason_code, reason_note, follow_up_at } };
}

/**
 * Translate outcome → lead row mutation. Returns the update payload
 * (or null when no lead-level state change is needed).
 */
function leadUpdateForOutcome(outcome: string, userId: string): Record<string, unknown> | null {
  const nowIso = new Date().toISOString();
  switch (outcome) {
    case "resolved":
      return {
        status: "resolved",
        resolved_at: nowIso,
        outcome_booked: false,
      };
    case "booked":
      return {
        status: "resolved",
        resolved_at: nowIso,
        outcome_booked: true,
      };
    case "follow_up_needed":
      // Lead stays open. The follow_up_at on lead_call_outcomes is the
      // canonical reschedule time — no need to mirror on leads.
      return null;
    case "no_answer":
    case "wrong_response":
    case "wrong_number":
    case "declined":
    case "lost":
    case "other":
      return null;
    default:
      return null;
  }
}

router.post(
  "/business/leads/:id/calls/:callSid/outcome",
  requireAuth,
  requirePermission("calls", "write"),
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
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const leadId = String(req.params.id);
    const callSid = String(req.params.callSid);

    const validated = validateBody((req.body || {}) as OutcomeBody);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }

    // Cross-tenant guard: load the lead first to confirm it's this
    // tenant's. Anti-enumeration — return 404 on mismatch.
    const { data: leadRow, error: leadErr } = await supabase
      .from("leads")
      .select("id, business_id, status")
      .eq("id", leadId)
      .maybeSingle();
    if (leadErr) {
      Sentry.captureMessage("outcome_lead_lookup_failed", {
        level: "error",
        extra: { leadId, error: leadErr.message },
      });
      res.status(500).json({ error: "Lookup failed" });
      return;
    }
    if (!leadRow || (leadRow as { business_id: string }).business_id !== businessId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    // Confirm the call_sid belongs to this lead.
    const { data: callRow, error: callErr } = await supabase
      .from("lead_calls")
      .select("id, lead_id, call_sid")
      .eq("call_sid", callSid)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (callErr) {
      Sentry.captureMessage("outcome_call_lookup_failed", {
        level: "error",
        extra: { leadId, callSid, error: callErr.message },
      });
      res.status(500).json({ error: "Lookup failed" });
      return;
    }
    if (!callRow) {
      res.status(404).json({ error: "Call not found for this lead" });
      return;
    }
    const leadCallId = (callRow as { id: string }).id;

    const { outcome, reason_code, reason_note, follow_up_at } = validated.value;

    // UPSERT outcome row. lead_call_outcomes has UNIQUE(lead_call_id).
    const { error: upsertErr } = await supabase
      .from("lead_call_outcomes")
      .upsert(
        {
          lead_call_id: leadCallId,
          lead_id: leadId,
          outcome,
          reason_code,
          reason_note,
          follow_up_at,
          recorded_by_user_id: userId,
          recorded_at: new Date().toISOString(),
        },
        { onConflict: "lead_call_id" },
      );
    if (upsertErr) {
      Sentry.captureMessage("outcome_upsert_failed", {
        level: "error",
        extra: { leadId, leadCallId, outcome, error: upsertErr.message },
      });
      res.status(500).json({ error: "Failed to save outcome" });
      return;
    }

    // Lead-level mutation (status / outcome_booked).
    const leadUpdate = leadUpdateForOutcome(outcome, userId);
    if (leadUpdate) {
      const { error: leadUpdErr } = await supabase
        .from("leads")
        .update(leadUpdate)
        .eq("id", leadId);
      if (leadUpdErr) {
        // Outcome row is already persisted; log loudly and respond
        // success so staff isn't asked to re-record. Operator can
        // reconcile lead.status by hand if needed.
        console.error("[outcomes] lead update failed:", leadUpdErr.message);
        Sentry.captureMessage("outcome_lead_update_failed", {
          level: "warning",
          extra: { leadId, outcome, error: leadUpdErr.message },
        });
      }
    }

    // Activity timeline row. Best-effort.
    const { error: actErr } = await supabase.from("lead_activities").insert({
      lead_id: leadId,
      actor_id: userId,
      actor_type: "staff",
      action: "outcome_recorded",
      metadata: {
        lead_call_id: leadCallId,
        call_sid: callSid,
        outcome,
        reason_code,
        follow_up_at,
      },
      note: reason_note,
    });
    if (actErr) {
      console.error("[outcomes] activity insert failed:", actErr.message);
    }

    res.json({
      success: true,
      lead_id: leadId,
      lead_call_id: leadCallId,
      outcome,
      reason_code,
      follow_up_at,
    });
  },
);

export default router;
