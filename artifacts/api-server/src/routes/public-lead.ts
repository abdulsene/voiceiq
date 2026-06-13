/**
 * Customer trust portal — public, no-auth.
 *
 *   GET  /api/public/lead/:token       → sanitized lead + timeline
 *   POST /api/public/lead/:token/action → rate / reschedule / cancel /
 *                                          mark_urgent
 *
 * Token is HS256-signed by lib/trust-portal-token.ts. No expiry —
 * revocation via business_configs.trust_portal_disabled (tenant-wide)
 * or leads.trust_portal_disabled (per-lead). Either kill switch
 * results in a 404 so leaked tokens become inert without leaking
 * existence.
 *
 * Anti-enumeration: ALL invalid / disabled / unknown tokens return
 * exactly { error: "not_found" } at HTTP 404. No 401, no 403, no
 * distinguishing error message — a leaked URL must look identical
 * to a typo'd URL.
 *
 * Sanitization (THIS IS LOAD-BEARING — review checklist when editing):
 *   - NEVER expose recording URLs, transcripts, or call summaries.
 *   - NEVER expose internal IDs (lead.id, lead_call_id, user uuids,
 *     conversation_id). Pass through a stable activity_id ONLY if the
 *     UI needs an antialias key — Slice 3A's UI doesn't, so we don't.
 *   - Staff identities: FIRST NAME ONLY, never email. Resolved from
 *     auth.users.user_metadata.full_name → split on first space.
 *   - Lead reason text is OK to expose (the customer authored it on
 *     the call), but trim leading PII-looking prefixes if the AI
 *     re-quoted a phone number / SSN-shaped digits.
 *
 * Polling: the dashboard polls this endpoint every 5s while the lead
 * is active. Cheap by design — single GET per lead. SSE migration is
 * a follow-up.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { verifyTrustToken } from "../lib/trust-portal-token";
import {
  expectedCallbackWindow,
  normalizeUrgency,
  type Urgency,
} from "../lib/lead-sla";

const router = Router();

const RATING_MIN = 1;
const RATING_MAX = 5;
const URGENCY_LADDER: Urgency[] = ["low", "medium", "high", "emergency"];

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function firstChunk(s: string): string | null {
  const trimmed = s.trim().split(/\s+/)[0];
  return trimmed || null;
}

/**
 * Extract a customer-presentable first name from a Supabase Auth user.
 *
 * Tries, in order, the field shapes we've actually observed in
 * production:
 *   1. user_metadata.first_name          — explicit field (preferred)
 *   2. user_metadata.given_name          — OAuth-style (Google IdP)
 *   3. user_metadata.full_name           — split on whitespace, take [0]
 *   4. user_metadata.name                — same split
 *   5. user.email local-part             — humanize (strip dots/digits)
 *
 * Returns null when none are usable so the caller can fall back to a
 * neutral label ("Your team"). Order matters: an OAuth signup may
 * have both given_name and full_name; given_name is more accurate.
 */
function firstNameFromUser(
  user: { email?: string | null; user_metadata?: unknown } | null | undefined,
): string | null {
  if (!user) return null;
  const meta = user.user_metadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    for (const field of ["first_name", "given_name"]) {
      const v = m[field];
      if (typeof v === "string" && v.trim()) return firstChunk(v);
    }
    for (const field of ["full_name", "name", "display_name"]) {
      const v = m[field];
      if (typeof v === "string" && v.trim()) return firstChunk(v);
    }
  }
  // Last-ditch: email local-part. "anna.smith+work@x.com" → "Anna".
  // Better than the generic fallback because at least it's specific to
  // the staff member.
  if (typeof user.email === "string" && user.email.includes("@")) {
    const local = user.email.split("@")[0].replace(/\+.*/, "");
    const cleaned = local.replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim();
    if (cleaned) {
      const first = firstChunk(cleaned);
      if (first) return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
  }
  return null;
}

/**
 * Resolve auth.users → first-name in batch. Service-role only.
 * Returns a map userId → firstName (or 'Your team' fallback).
 */
async function resolveStaffFirstNames(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  for (const uid of unique) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(uid);
      if (error || !data?.user) {
        out.set(uid, "Your team");
        continue;
      }
      out.set(uid, firstNameFromUser(data.user) || "Your team");
    } catch {
      out.set(uid, "Your team");
    }
  }
  return out;
}

interface ActivityRow {
  id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface LeadCallRow {
  id: string;
  status: string;
  duration_secs: number | null;
  started_at: string | null;
  ended_at: string | null;
  staff_user_id: string | null;
}

interface LeadRow {
  id: string;
  business_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  reason: string;
  urgency: string;
  status: string;
  preferred_channel: string | null;
  created_at: string;
  first_response_at: string | null;
  trust_portal_disabled: boolean | null;
  outcome_booked: boolean | null;
}

interface BusinessRow {
  business_id: string;
  business_name: string | null;
  phone_number: string | null;
  trust_portal_disabled: boolean | null;
  sla_overrides: Record<string, unknown> | null;
}

/**
 * Load lead + business + activities + calls + outcome (latest) for a
 * verified token. Returns null when either kill switch is set OR the
 * lead doesn't exist. Callers MUST 404 on null without revealing
 * which condition tripped.
 */
async function loadPortalState(
  supabase: SupabaseClient,
  leadId: string,
  businessId: string,
): Promise<{
  business: BusinessRow;
  lead: LeadRow;
  activities: ActivityRow[];
  calls: LeadCallRow[];
  latestOutcome: { outcome: string; recorded_at: string; staff_user_id: string | null } | null;
} | null> {
  const { data: bizRaw } = await supabase
    .from("business_configs")
    .select("business_id, business_name, phone_number, trust_portal_disabled, sla_overrides")
    .eq("business_id", businessId)
    .maybeSingle();
  if (!bizRaw) return null;
  const business = bizRaw as BusinessRow;
  if (business.trust_portal_disabled) return null;

  const { data: leadRaw } = await supabase
    .from("leads")
    .select(
      "id, business_id, contact_name, contact_phone, reason, urgency, status, preferred_channel, created_at, first_response_at, trust_portal_disabled, outcome_booked",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (!leadRaw) return null;
  const lead = leadRaw as LeadRow;
  if (lead.business_id !== businessId) return null;
  if (lead.trust_portal_disabled) return null;

  const [{ data: actRaw }, { data: callRaw }, { data: outcomeRaw }] = await Promise.all([
    supabase
      .from("lead_activities")
      .select("id, actor_id, actor_type, action, metadata, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true }),
    supabase
      .from("lead_calls")
      .select("id, status, duration_secs, started_at, ended_at, staff_user_id")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: true }),
    supabase
      .from("lead_call_outcomes")
      .select("outcome, recorded_at, recorded_by_user_id")
      .eq("lead_id", leadId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    business,
    lead,
    activities: (actRaw as ActivityRow[] | null) || [],
    calls: (callRaw as LeadCallRow[] | null) || [],
    latestOutcome: outcomeRaw
      ? {
          outcome: (outcomeRaw as any).outcome,
          recorded_at: (outcomeRaw as any).recorded_at,
          staff_user_id: (outcomeRaw as any).recorded_by_user_id ?? null,
        }
      : null,
  };
}

interface SanitizedEvent {
  type: string;
  at: string;
  staff_first_name?: string;
  duration_secs?: number;
  outcome?: string;
  channel?: string;
}

function buildSanitizedTimeline(
  activities: ActivityRow[],
  calls: LeadCallRow[],
  staffNames: Map<string, string>,
): SanitizedEvent[] {
  const events: SanitizedEvent[] = [];
  for (const a of activities) {
    const staff =
      a.actor_id ? staffNames.get(a.actor_id) ?? "Your team" : undefined;
    switch (a.action) {
      case "captured":
        events.push({ type: "captured", at: a.created_at });
        break;
      case "claimed":
      case "reassigned":
        events.push({ type: "assigned", at: a.created_at, staff_first_name: staff });
        break;
      case "call_initiated":
        events.push({
          type: "callback_started",
          at: a.created_at,
          staff_first_name: staff,
        });
        break;
      case "call_completed": {
        const callId = (a.metadata?.lead_call_id ?? a.metadata?.call_id) as string | undefined;
        const matchingCall = callId ? calls.find((c) => c.id === callId) : undefined;
        events.push({
          type: "callback_completed",
          at: a.created_at,
          staff_first_name: staff,
          duration_secs: matchingCall?.duration_secs ?? undefined,
        });
        break;
      }
      case "call_failed":
        events.push({ type: "callback_failed", at: a.created_at, staff_first_name: staff });
        break;
      case "sms_sent":
        events.push({ type: "sms_sent", at: a.created_at, channel: "sms" });
        break;
      case "outcome_recorded": {
        const outcomeRaw = (a.metadata?.outcome as string | undefined) ?? undefined;
        events.push({
          type: "outcome_recorded",
          at: a.created_at,
          staff_first_name: staff,
          outcome: outcomeRaw,
        });
        break;
      }
      case "customer_rated":
      case "customer_rescheduled":
      case "customer_cancelled":
      case "customer_marked_urgent":
        events.push({ type: a.action, at: a.created_at });
        break;
      // Everything else (note_added, dismissed, reopened, escalated,
      // etc.) is intentionally NOT surfaced to the customer.
      default:
        break;
    }
  }
  return events;
}

/**
 * Derive the customer-visible status string from lead + calls + outcome.
 * Returns one of the 9 documented Slice 3A states:
 *   captured_awaiting_assignment | assigned | staff_acknowledged |
 *   on_call | resolved | booked | follow_up_scheduled | no_answer |
 *   cancelled
 *
 * Precedence (each branch wins over those below):
 *   1. cancelled — terminal
 *   2. resolved / booked — terminal
 *   3. follow_up_scheduled — staff explicitly scheduled a follow-up
 *   4. no_answer — last call attempt failed to reach the customer
 *   5. on_call — a call is currently ringing or in progress
 *   6. staff_acknowledged — lead.first_response_at is set, no active
 *      call, not yet resolved. Distinct from `assigned` because the
 *      customer wants to know the team has SEEN the request, not just
 *      that someone owns it.
 *   7. assigned — lead.status is claimed/in_progress
 *   8. captured_awaiting_assignment — default for fresh leads
 */
function statusForCustomer(
  lead: LeadRow,
  calls: LeadCallRow[],
  latestOutcome: { outcome: string } | null,
): string {
  if (lead.status === "cancelled") return "cancelled";
  if (lead.status === "resolved") {
    return latestOutcome?.outcome === "booked" ? "booked" : "resolved";
  }
  if (latestOutcome?.outcome === "follow_up_needed") return "follow_up_scheduled";
  if (latestOutcome?.outcome === "no_answer") return "no_answer";
  const onCall = calls.find(
    (c) => c.status === "in_progress" || c.status === "ringing" || c.status === "initiated",
  );
  if (onCall) return "on_call";
  if (lead.first_response_at) return "staff_acknowledged";
  if (lead.status === "claimed" || lead.status === "in_progress") return "assigned";
  return "captured_awaiting_assignment";
}

// ── GET ───────────────────────────────────────────────────────────────

router.get("/public/lead/:token", async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Service unavailable" });
    return;
  }
  const claims = verifyTrustToken(String(req.params.token));
  if (!claims) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const state = await loadPortalState(supabase, claims.lead_id, claims.business_id);
  if (!state) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { business, lead, activities, calls, latestOutcome } = state;
  const staffIds = [
    ...activities.map((a) => a.actor_id).filter((x): x is string => !!x),
    ...calls.map((c) => c.staff_user_id).filter((x): x is string => !!x),
    ...(latestOutcome?.staff_user_id ? [latestOutcome.staff_user_id] : []),
  ];
  const staffNames = await resolveStaffFirstNames(supabase, staffIds);

  const urgency = normalizeUrgency(lead.urgency);
  const win = expectedCallbackWindow(
    urgency,
    new Date(lead.created_at),
    business.sla_overrides,
  );

  res.json({
    business: {
      name: business.business_name || "Your team",
      phone: business.phone_number || null,
    },
    lead: {
      reason: lead.reason,
      urgency,
      preferred_channel: lead.preferred_channel,
      created_at: lead.created_at,
      contact_name: lead.contact_name,
    },
    status: statusForCustomer(lead, calls, latestOutcome),
    expected_callback_window: win,
    timeline: buildSanitizedTimeline(activities, calls, staffNames),
    can_rate:
      (lead.status === "resolved" && !latestOutcome) ||
      latestOutcome?.outcome === "resolved" ||
      latestOutcome?.outcome === "booked",
    can_reschedule: lead.status !== "resolved" && lead.status !== "cancelled",
    can_cancel: lead.status !== "resolved" && lead.status !== "cancelled",
  });
});

// ── POST /action ──────────────────────────────────────────────────────

interface ActionBody {
  action?: unknown;
  score?: unknown;
  comment?: unknown;
  requested_at?: unknown;
}

router.post("/public/lead/:token/action", async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Service unavailable" });
    return;
  }
  const claims = verifyTrustToken(String(req.params.token));
  if (!claims) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const state = await loadPortalState(supabase, claims.lead_id, claims.business_id);
  if (!state) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const body = (req.body || {}) as ActionBody;
  const action = typeof body.action === "string" ? body.action : "";

  switch (action) {
    case "rate": {
      const score = Number(body.score);
      if (!Number.isFinite(score) || score < RATING_MIN || score > RATING_MAX) {
        res.status(400).json({ error: "score must be an integer 1-5" });
        return;
      }
      const comment =
        typeof body.comment === "string" ? body.comment.slice(0, 2000) : null;
      const { error: ratingErr } = await supabase
        .from("lead_ratings")
        .upsert(
          {
            lead_id: state.lead.id,
            business_id: state.lead.business_id,
            score: Math.round(score),
            comment,
            rated_at: new Date().toISOString(),
          },
          { onConflict: "lead_id" },
        );
      if (ratingErr) {
        Sentry.captureMessage("portal_rate_persist_failed", {
          level: "error",
          extra: { leadId: state.lead.id, error: ratingErr.message },
        });
        res.status(500).json({ error: "Failed to save rating" });
        return;
      }
      await supabase.from("lead_activities").insert({
        lead_id: state.lead.id,
        actor_id: null,
        actor_type: "customer",
        action: "customer_rated",
        metadata: { score: Math.round(score), comment_length: comment?.length ?? 0 },
      });
      res.json({ success: true });
      return;
    }
    case "reschedule": {
      if (typeof body.requested_at !== "string") {
        res.status(400).json({ error: "requested_at (ISO8601) is required" });
        return;
      }
      const parsed = new Date(body.requested_at);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "requested_at must be valid ISO8601" });
        return;
      }
      // We don't have a leads.requested_callback_at column today —
      // surface via lead_activities so staff sees it in the timeline.
      // A future migration can add the column when staff UI consumes
      // it explicitly.
      await supabase.from("lead_activities").insert({
        lead_id: state.lead.id,
        actor_id: null,
        actor_type: "customer",
        action: "customer_rescheduled",
        metadata: { requested_at: parsed.toISOString() },
      });
      res.json({ success: true, requested_at: parsed.toISOString() });
      return;
    }
    case "cancel": {
      const { error: updErr } = await supabase
        .from("leads")
        .update({ status: "cancelled" })
        .eq("id", state.lead.id);
      if (updErr) {
        res.status(500).json({ error: "Failed to cancel" });
        return;
      }
      await supabase.from("lead_activities").insert({
        lead_id: state.lead.id,
        actor_id: null,
        actor_type: "customer",
        action: "customer_cancelled",
        metadata: {},
      });
      res.json({ success: true });
      return;
    }
    case "mark_urgent": {
      const currentIdx = URGENCY_LADDER.indexOf(normalizeUrgency(state.lead.urgency));
      const nextIdx = Math.min(currentIdx + 1, URGENCY_LADDER.length - 1);
      const newUrgency = URGENCY_LADDER[nextIdx];
      if (newUrgency === state.lead.urgency) {
        // Already at emergency.
        res.json({ success: true, urgency: newUrgency, changed: false });
        return;
      }
      const { error: updErr } = await supabase
        .from("leads")
        .update({ urgency: newUrgency })
        .eq("id", state.lead.id);
      if (updErr) {
        res.status(500).json({ error: "Failed to update urgency" });
        return;
      }
      await supabase.from("lead_activities").insert({
        lead_id: state.lead.id,
        actor_id: null,
        actor_type: "customer",
        action: "customer_marked_urgent",
        metadata: { from: state.lead.urgency, to: newUrgency },
      });
      res.json({ success: true, urgency: newUrgency, changed: true });
      return;
    }
    default:
      res.status(400).json({ error: "action must be one of: rate, reschedule, cancel, mark_urgent" });
      return;
  }
});

export default router;
