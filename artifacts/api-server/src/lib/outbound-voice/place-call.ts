/**
 * Phase 1.3 — placement primitive for both directions.
 *
 * The architectural keystone of Phase 1. Five downstream consumers
 * call into this single function:
 *   - Phase 1.4: routes/lead-calls.ts handleInitiateCall (refactored
 *                to delegate placement)
 *   - Phase 1.5: scheduled-call worker (cron-driven)
 *   - Phase 1.6: voicemail TwiML route + AMD-machine redirect
 *   - Phase 1.7: dashboard "schedule reminder" button (server-side)
 *   - Phase 2:   campaign engine
 *
 * Invariants:
 *   1. NEVER THROWS. Every code path returns a structured
 *      PlaceCallResponse. Caller branches on the discriminator
 *      (ok / reason).
 *   2. Cross-tenant guard: lead lookup ALWAYS filters by businessId.
 *      A worker-initiated outbound that hands us a leadId/businessId
 *      pair must be authoritative — we trust-but-verify via the
 *      `leads WHERE id=$1 AND business_id=$2` row.
 *   3. inbound_bridge always uses TwilioRestProvider regardless of
 *      business_configs.outbound_provider. That column is an
 *      OUTBOUND knob; bridge calls (staff-initiated callbacks) are
 *      not subject to it. ElevenLabsHostedProvider would refuse a
 *      bridge payload anyway (it's automated-only by design).
 *   4. Recording resolution:
 *        inbound_bridge        — always record (Slice 2A invariant)
 *        outbound_automated    — reads business_configs.record_outbound_calls
 *      No recordingOverride input field; add if a use case emerges.
 *   5. place-call.ts does NOT enforce single-active-call-per-lead.
 *      Consumers needing exclusivity (e.g. dashboard preventing
 *      double-click) must enforce themselves. Matches existing
 *      handleInitiateCall behavior.
 *   6. Lead pre-existence is REQUIRED. place-call refuses to
 *      auto-create leads. Caller must INSERT INTO leads first.
 *      Phase 1.0 design decision A4.
 *   7. NO single-active-call-per-lead enforcement (see 5).
 *
 * Compliance + scheduledFor semantics (CRITICAL for 1.5 implementer):
 *   When scheduledFor is provided, compliance is evaluated against
 *   that moment — so a call scheduled for tomorrow morning is
 *   checked against tomorrow's calling-hours window, not today's.
 *   This is the right behavior for the insert path.
 *
 *   The Phase 1.5 scheduled-call worker MUST call placeCall AGAIN
 *   at fire time with scheduledFor OMITTED. That triggers a SECOND
 *   compliance check at actual placement time — which catches
 *   consent revocations / DNC additions / calling-hours edge cases
 *   that arose in the gap between insert and fire. The worker
 *   MUST NOT skip this second check thinking "we already checked
 *   at insert." That would be a TCPA exposure.
 *
 * Phase 1.5 — existingLeadCallId mode:
 *   The scheduled-call worker locks a row via UPDATE...RETURNING
 *   (status='scheduled' → 'processing'), then calls placeCall with
 *   `existingLeadCallId` set to that row's id. In this mode:
 *     - Idempotency check (step 5) is SKIPPED — worker already chose
 *       the row.
 *     - Pre-insert (step 6) is REPLACED with a cooperative-lock
 *       verification: we SELECT the row, assert status='processing'
 *       and lead_id matches. Mismatches return db_error step=
 *       'existing_row_not_locked' / 'existing_row_lead_mismatch' /
 *       'existing_row_not_found'.
 *     - scheduledFor in the request is IGNORED — the worker fires
 *       NOW; isScheduled is forced to false.
 *     - Success UPDATE (step 12) extends to also set status='initiated'
 *       and started_at — the existing row was 'processing' with no
 *       started_at.
 *     - On any non-ok return EXCEPT provider_failed (step 11 already
 *       UPDATEd) and db_error (left 'processing' for stuck-row
 *       recovery / ops triage), the outer wrapper UPDATEs the row to
 *       status='failed' with an appropriate end_reason so the worker
 *       doesn't re-pick it next tick.
 *
 * 'processing' status semantics:
 *   'processing' is an INTERNAL transient state set by the Phase 1.5
 *   scheduled-call worker between lock acquisition and placement
 *   completion. Any consumer querying lead_calls.status that needs to
 *   be exhaustive across "active call states" must include
 *   'processing' alongside 'initiated', 'ringing', 'in_progress'.
 *   Anything that treats {initiated, ringing, in_progress, completed,
 *   failed} as a closed set will silently miss in-flight scheduled
 *   placements.
 *
 * In scope for 1.3: this file + tests/026-place-call-smoke.ts +
 * barrel re-export in outbound-voice/index.ts.
 * Phase 1.4: handleInitiateCall refactor (landed).
 * Phase 1.5a: existingLeadCallId mode (landed).
 * Phase 2.1: daily cap enforcement (landing in THIS commit).
 *
 * Phase 2.1 — daily cap enforcement:
 *   business_configs.max_outbound_calls_per_day is now enforced at
 *   step 5.5 (AFTER idempotency check, BEFORE pre-insert). Order
 *   moved from 3.5 → 5.5 in Phase 2.1.1: idempotent re-submits must
 *   short-circuit before cap check so a re-submit of an existing
 *   scheduled row when the tenant is at cap returns idempotent:true,
 *   not daily_cap_exceeded. Duplicate detection resolves before
 *   quota allocation. Behavior:
 *     - direction='inbound_bridge': cap is not checked (staff-
 *       initiated bridges aren't part of automated outreach).
 *     - cap === 0: kill-switch. Immediate rejection without a count
 *       query. A tenant setting max=0 in the UI expects calls to
 *       STOP, not "no cap effective".
 *     - cap > 0: count outbound_automated lead_calls for THIS
 *       tenant on the target day (scheduledFor's date if scheduled,
 *       else today). All statuses count — including 'scheduled',
 *       'failed', 'completed'. The count is conservative; rare
 *       end_reason='daily_cap_exceeded' rows count too, but pollution
 *       is rare at pilot scale.
 *     - count >= cap: return daily_cap_exceeded with cap, currentCount,
 *       targetDay surfaced.
 *
 *   Race condition: two concurrent placeCall invocations against the
 *   same tenant can both pass the count check, both INSERT, and end
 *   up at count+2. We accept the race for 2.1 (pilot scale; cap is a
 *   soft tenant-set throttle, not a regulatory ceiling). A post-INSERT
 *   verification fires Sentry "daily_cap_race_observed" when the
 *   observed count exceeds cap — gives us monitoring data without
 *   serialization cost. If this fires in production, Phase 2.2/2.3
 *   promotes to atomic counter (business_configs.outbound_calls_today
 *   + atomic UPDATE..RETURNING + daily reset cron).
 *
 *   Fail-open posture: if the count query errors transiently, we log
 *   + proceed. Cap is a soft cap (asymmetric to compliance which
 *   fails-closed for TCPA safety).
 *
 * Out of scope: 1.5b worker (landed), 1.6 voicemail (landed),
 * 1.7 dashboard (landed), 2.2 appointments table, 2.3+ campaigns.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { getProvider as _getProviderReal, type GetProviderOptions } from "./index";

// Test injection seam — Node 24 ESM namespaces are frozen, so smoke
// tests can't monkey-patch `getProvider`. They call this setter
// instead. Production code never touches it.
type GetProviderFn = (provider: CallProvider, options?: GetProviderOptions) => ICallProvider;
let _getProviderImpl: GetProviderFn = _getProviderReal;
export function __setProviderFactoryForTesting(impl: GetProviderFn | null) {
  _getProviderImpl = impl ?? _getProviderReal;
}
import type {
  AutomatedPayload,
  BridgePayload,
  CallDirection,
  CallProvider,
  ICallProvider,
} from "./types";
import { checkCompliance, type ComplianceDecision } from "./compliance";
import { resolveOutboundCallerId } from "../twilio-caller-id";
import { resolveRecipientTimezone } from "../phone-timezone";
import { getPublicApiBase } from "../public-url";
import { auditLog } from "../../middlewares/audit";

const E164_RE = /^\+[1-9]\d{6,14}$/;

// ── Request / Response types ─────────────────────────────────────────

export interface PlaceCallRequest {
  /** Business that owns this call. Used as cross-tenant guard for leadId. */
  businessId: string;
  /** Existing lead row id. place-call refuses to auto-create — see invariant 6. */
  leadId: string;
  /** 'inbound_bridge' for staff-initiated callbacks; 'outbound_automated' for campaigns. */
  direction: CallDirection;
  /** Required for inbound_bridge (audit + activity attribution). Omit for outbound_automated. */
  staffUserId?: string;
  /** Required for inbound_bridge (Twilio dials this first). Omit for outbound_automated. */
  staffRingNumber?: string;
  /** Required for outbound_automated. e.g. 'appointment_reminder'. */
  callObjective?: string;
  /** Optional for outbound_automated. Sets lead_calls.campaign_id + can override agent_id. */
  campaignId?: string | null;
  /** Optional. NULL = place immediately. Future ISO timestamp = pre-insert with status='scheduled' and DEFER placement. */
  scheduledFor?: Date | null;
  /** Optional. Defaults to 1. Position within a retry sequence. */
  attemptNumber?: number;
  /** Optional. Defaults to 0. Times this (lead, objective) was attempted before. */
  retryCount?: number;
  /**
   * Optional provider override. Defaults to business_configs.outbound_provider
   * for outbound_automated. NEVER honored for inbound_bridge (always twilio).
   */
  providerOverride?: CallProvider;
  /** Optional HTTP request meta for audit_logs. Worker-initiated calls omit. */
  requestMeta?: { ipAddress?: string | null; userAgent?: string | null; sessionId?: string | null };
  /** Set true when the route caller has admin privileges. Surfaces 'admin_raw' as audit source. */
  isAdmin?: boolean;
  /**
   * Phase 1.5: when the scheduled-call worker fires, it passes the
   * pre-locked lead_calls.id here. placeCall then skips pre-insert,
   * verifies the row is in status='processing', and on terminal exit
   * UPDATEs the row instead of inserting a fresh one. See the
   * file-level "existingLeadCallId mode" JSDoc.
   *
   * Pre-1.5 callers (route handler, dashboard) must NOT set this —
   * they want pre-insert behavior.
   */
  existingLeadCallId?: string;
}

export type PlaceCallResponse =
  | {
      ok: true;
      leadCallId: string;
      callSid: string;
      provider: CallProvider;
      status: "placed";
      idempotent?: false;
      /**
       * The E.164 number Twilio actually dialed from. Always present for
       * inbound_bridge. For outbound_automated/twilio it's the tenant's
       * twilio_phone_number. Undefined for outbound_automated/elevenlabs
       * (ElevenLabs hosted resolves from-number from phone_number_id, not
       * an E.164 we surface).
       */
      fromCallerId?: string;
    }
  | { ok: true; leadCallId: string; callSid: null; provider: null; status: "scheduled"; idempotent?: boolean }
  | { ok: false; reason: "lead_not_found" }
  | { ok: false; reason: "lead_phone_invalid" }
  | { ok: false; reason: "business_not_found" }
  | { ok: false; reason: "staff_ring_number_missing" }
  | { ok: false; reason: "caller_id_unresolvable" }
  | { ok: false; reason: "tenant_outbound_disabled" }
  | { ok: false; reason: "non_nanp_number_no_tz_inference" }
  | { ok: false; reason: "compliance_blocked"; blocked_by: "voice_opt_out" | "dnc" | "consent" | "calling_hours"; checks: ComplianceDecision["checks"] }
  | { ok: false; reason: "provider_failed"; provider: CallProvider; providerError: string; twilioCode?: number }
  | { ok: false; reason: "db_error"; step: string; error: string }
  /**
   * Phase 2.1 — tenant's business_configs.max_outbound_calls_per_day
   * was reached for the target day. `cap` is the tenant's limit,
   * `currentCount` is the count we observed (zero when cap===0 kill-
   * switch fires), `targetDay` is the ISO date string the count
   * applies to (scheduledFor's date when scheduling future, today
   * otherwise).
   */
  | { ok: false; reason: "daily_cap_exceeded"; cap: number; currentCount: number; targetDay: string };

// ── Main entry ──────────────────────────────────────────────────────

/**
 * Maps a placeCall failure reason → end_reason value used to UPDATE
 * the existing scheduled row when existingLeadCallId is set. Returns
 * null when the wrapper should NOT UPDATE:
 *   - provider_failed: step 11 already UPDATEd the row to 'failed'.
 *   - db_error: leave row in 'processing' for stuck-row recovery /
 *               manual ops triage. Worker can re-detect on its next
 *               tick if the DB recovers (phase 2 will add automated
 *               recovery sweep).
 *   - staff_ring_number_missing / caller_id_unresolvable: not
 *               legitimately reachable for outbound_automated, and
 *               outbound_automated is the only direction the worker
 *               fires. Defensive null.
 */
function reasonToEndReason(
  reason:
    | "lead_not_found"
    | "lead_phone_invalid"
    | "business_not_found"
    | "staff_ring_number_missing"
    | "caller_id_unresolvable"
    | "tenant_outbound_disabled"
    | "non_nanp_number_no_tz_inference"
    | "compliance_blocked"
    | "provider_failed"
    | "db_error"
    | "daily_cap_exceeded",
): string | null {
  switch (reason) {
    case "compliance_blocked":
      return "compliance_blocked";
    case "lead_not_found":
      return "lead_not_found_at_fire_time";
    case "lead_phone_invalid":
      return "lead_phone_invalid_at_fire_time";
    case "business_not_found":
      return "business_not_found";
    case "tenant_outbound_disabled":
      return "tenant_outbound_disabled";
    case "non_nanp_number_no_tz_inference":
      return "non_nanp_phone";
    case "daily_cap_exceeded":
      // Worker fired and cap was exceeded. Mark terminal — the row
      // shouldn't be re-picked next tick (cap stays full all day in
      // most realistic scenarios). Ops can investigate via end_reason.
      return "daily_cap_exceeded";
    case "provider_failed":
    case "db_error":
    case "staff_ring_number_missing":
    case "caller_id_unresolvable":
      return null;
  }
}

/**
 * Phase 2.1 — count outbound_automated lead_calls for a tenant on the
 * target day. Used by step 3.5 (cap check) and step 6.5 (post-insert
 * race detector).
 *
 * The "target day" for a scheduled call is scheduledFor's date; for an
 * immediate call it's today. The count includes ALL statuses — scheduled
 * rows that will fire on the target day count toward that day's cap, as
 * do already-placed (initiated|ringing|in_progress|completed|failed)
 * rows. Conservative: never over-schedule.
 *
 * Two parallel queries because the supabase-js builder can't express
 * `COALESCE(scheduled_for::date, created_at::date) = $target` cleanly.
 * The two queries are mutually exclusive (one filters scheduled_for IS
 * NOT NULL within the window, the other IS NULL + created_at within the
 * window). Sum = total day count.
 *
 * Returns { count: number } on success, { count: null, error: string }
 * on failure. Callers handle fail-open posture themselves.
 *
 * TODO(2.4): convert day-window computation to tenant-local timezone.
 * Pilot scale (EZ Rentals in Eastern) is essentially UTC-aligned; PST
 * tenants will see cap rollover at 4pm local under UTC math, which is
 * acceptable for pilot but not for general availability. Pull tenant
 * tz from a new business_configs.tz column (Phase 2.4) and bound in
 * tenant-local.
 */
async function countOutboundCallsForDay(
  supabase: SupabaseClient,
  businessId: string,
  targetDay: Date,
): Promise<{ count: number | null; error?: string }> {
  const dayStart = new Date(Date.UTC(
    targetDay.getUTCFullYear(),
    targetDay.getUTCMonth(),
    targetDay.getUTCDate(),
  )).toISOString();
  const dayEnd = new Date(Date.UTC(
    targetDay.getUTCFullYear(),
    targetDay.getUTCMonth(),
    targetDay.getUTCDate() + 1,
  )).toISOString();
  try {
    const [scheduledQ, immediateQ] = await Promise.all([
      supabase
        .from("lead_calls")
        .select("id, leads!inner(business_id)", { count: "exact", head: true })
        .eq("leads.business_id", businessId)
        .eq("direction", "outbound_automated")
        .gte("scheduled_for", dayStart)
        .lt("scheduled_for", dayEnd),
      supabase
        .from("lead_calls")
        .select("id, leads!inner(business_id)", { count: "exact", head: true })
        .eq("leads.business_id", businessId)
        .eq("direction", "outbound_automated")
        .is("scheduled_for", null)
        .gte("created_at", dayStart)
        .lt("created_at", dayEnd),
    ]);
    if (scheduledQ.error || immediateQ.error) {
      return {
        count: null,
        error:
          scheduledQ.error?.message ||
          immediateQ.error?.message ||
          "count query returned error",
      };
    }
    return { count: (scheduledQ.count ?? 0) + (immediateQ.count ?? 0) };
  } catch (err: any) {
    return { count: null, error: err?.message || String(err) };
  }
}

export async function placeCall(
  supabase: SupabaseClient,
  req: PlaceCallRequest,
): Promise<PlaceCallResponse> {
  const response = await placeCallCore(supabase, req);

  // Phase 1.5: existingLeadCallId mode — when the worker fired this
  // call, it has already UPDATEd the row to status='processing'. On
  // any non-ok terminal response (other than provider_failed which
  // step 11 already handled, and db_error which intentionally leaves
  // 'processing' for stuck-row recovery), UPDATE the row to a
  // terminal failed state so the worker doesn't re-pick it next tick.
  if (req.existingLeadCallId && !response.ok) {
    const endReason = reasonToEndReason(response.reason);
    if (endReason) {
      try {
        await supabase
          .from("lead_calls")
          .update({ status: "failed", end_reason: endReason })
          .eq("id", req.existingLeadCallId);
      } catch (e: any) {
        Sentry.captureMessage("place_call_existing_row_failed_update_failed", {
          level: "warning",
          extra: {
            leadCallId: req.existingLeadCallId,
            endReason,
            error: e?.message,
          },
        });
      }
    }
  }

  return response;
}

async function placeCallCore(
  supabase: SupabaseClient,
  req: PlaceCallRequest,
): Promise<PlaceCallResponse> {
  // (1) Input validation — defensive; callers shouldn't pass invalid.
  if (!req.businessId || !req.leadId || !req.direction) {
    return { ok: false, reason: "db_error", step: "input_validation", error: "businessId / leadId / direction required" };
  }
  if (req.direction === "inbound_bridge") {
    if (!req.staffUserId) {
      return { ok: false, reason: "db_error", step: "input_validation", error: "staffUserId required for inbound_bridge" };
    }
    if (!req.staffRingNumber || !E164_RE.test(req.staffRingNumber)) {
      return { ok: false, reason: "staff_ring_number_missing" };
    }
  }
  if (req.direction === "outbound_automated" && !req.callObjective) {
    return { ok: false, reason: "db_error", step: "input_validation", error: "callObjective required for outbound_automated" };
  }

  // (2) Cross-tenant lead guard.
  let leadRow: { id: string; business_id: string; contact_phone: string | null; reason: string } | null;
  try {
    const { data, error } = await supabase
      .from("leads")
      .select("id, business_id, contact_phone, reason")
      .eq("id", req.leadId)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("place_call_lead_lookup_failed", {
        level: "error",
        extra: { businessId: req.businessId, leadId: req.leadId, error: error.message },
      });
      return { ok: false, reason: "db_error", step: "lead_lookup", error: error.message };
    }
    leadRow = data as typeof leadRow;
  } catch (err: any) {
    return { ok: false, reason: "db_error", step: "lead_lookup", error: err?.message || String(err) };
  }
  if (!leadRow) return { ok: false, reason: "lead_not_found" };
  if (!leadRow.contact_phone || !E164_RE.test(leadRow.contact_phone)) {
    return { ok: false, reason: "lead_phone_invalid" };
  }
  const customerPhone = leadRow.contact_phone;

  // (3) outbound_automated gates — business_configs, calling hours, compliance.
  type BusinessRow = {
    outbound_voice_enabled: boolean | null;
    outbound_provider: CallProvider | null;
    record_outbound_calls: boolean | null;
    agent_id: string | null;
    business_name: string | null;
    twilio_phone_number: string | null;
    elevenlabs_phone_number_id: string | null;
    max_outbound_calls_per_day: number | null;
  };
  let businessRow: BusinessRow | null = null;
  if (req.direction === "outbound_automated") {
    try {
      const { data, error } = await supabase
        .from("business_configs")
        .select(
          "outbound_voice_enabled, outbound_provider, record_outbound_calls, agent_id, business_name, twilio_phone_number, elevenlabs_phone_number_id, max_outbound_calls_per_day",
        )
        .eq("business_id", req.businessId)
        .maybeSingle();
      if (error) {
        return { ok: false, reason: "db_error", step: "business_lookup", error: error.message };
      }
      businessRow = data as BusinessRow | null;
    } catch (err: any) {
      return { ok: false, reason: "db_error", step: "business_lookup", error: err?.message || String(err) };
    }
    if (!businessRow) return { ok: false, reason: "business_not_found" };
    if (businessRow.outbound_voice_enabled !== true) {
      return { ok: false, reason: "tenant_outbound_disabled" };
    }

    const recipientTz = resolveRecipientTimezone(customerPhone);
    if (!recipientTz) {
      return { ok: false, reason: "non_nanp_number_no_tz_inference" };
    }

    // Compliance check. `now` is scheduledFor when provided so future
    // scheduled calls are evaluated against their fire-time's window.
    // The Phase 1.5 worker MUST call placeCall again at fire time with
    // scheduledFor omitted to catch consent/DNC changes in the gap.
    let compliance: ComplianceDecision;
    try {
      compliance = await checkCompliance(supabase, {
        businessId: req.businessId,
        phone: customerPhone,
        leadId: req.leadId,
        consentType: req.callObjective!,
        recipientTimezone: recipientTz,
        now: req.scheduledFor ?? new Date(),
      });
    } catch (err: any) {
      // Compliance helpers never throw under normal operation; if they
      // do, fail-closed with synthetic DNC block (safest reason code).
      return {
        ok: false,
        reason: "compliance_blocked",
        blocked_by: "dnc",
        checks: {
          voice_opt_out: { allowed: true },
          dnc: { allowed: false, blocked_by: "tenant_dnc_list" },
          calling_hours: { allowed: false, blocked_by: "tenant_disabled" },
          consent: { allowed: false, blocked_by: "no_record" },
        },
      };
    }
    if (!compliance.allowed) {
      return {
        ok: false,
        reason: "compliance_blocked",
        blocked_by: compliance.blocked_by!,
        checks: compliance.checks,
      };
    }

  }

  // (4) inbound_bridge — resolve outbound caller ID for the customer leg.
  let bridgeCallerIdFrom: string | null = null;
  if (req.direction === "inbound_bridge") {
    const cid = await resolveOutboundCallerId(supabase, req.businessId);
    if (!cid) return { ok: false, reason: "caller_id_unresolvable" };
    bridgeCallerIdFrom = cid.from;
  }

  // (5) Idempotency on scheduled inserts — return existing leadCallId
  // when (leadId, callObjective, scheduledFor) already matches a
  // status='scheduled' row. See design A5.
  // Skipped when existingLeadCallId is set (worker already chose the row).
  if (!req.existingLeadCallId && req.scheduledFor && req.direction === "outbound_automated") {
    try {
      const { data: existing } = await supabase
        .from("lead_calls")
        .select("id")
        .eq("lead_id", req.leadId)
        .eq("call_objective", req.callObjective!)
        .eq("status", "scheduled")
        .eq("scheduled_for", req.scheduledFor.toISOString())
        .maybeSingle();
      if (existing) {
        return {
          ok: true,
          leadCallId: (existing as { id: string }).id,
          callSid: null,
          provider: null,
          status: "scheduled",
          idempotent: true,
        };
      }
    } catch (err: any) {
      return { ok: false, reason: "db_error", step: "idempotency_check", error: err?.message || String(err) };
    }
  }

  // (5.5) Phase 2.1.1 — daily cap enforcement.
  // Moved from step 3.5 to step 5.5 in 2.1.1: idempotent re-submits
  // must short-circuit BEFORE cap check so a re-submit of an
  // already-scheduled row when the tenant is at cap returns
  // idempotent:true (the existing row IS counted toward cap; the
  // re-submit wouldn't insert a new row). Fresh submits at cap still
  // get daily_cap_exceeded. Duplicate detection resolves before
  // quota allocation.
  //
  // outbound_automated only; inbound_bridge bypasses (staff-initiated
  // callbacks are not part of automated outreach).
  if (req.direction === "outbound_automated" && businessRow) {
    const cap = businessRow.max_outbound_calls_per_day;
    const targetDayDate = req.scheduledFor ?? new Date();
    const targetDayStr = targetDayDate.toISOString().slice(0, 10);

    // R6 — cap === 0 is a kill-switch (principle of least surprise).
    // Short-circuit BEFORE the count query so an intentional kill
    // doesn't incur DB cost on every call attempt.
    if (cap === 0) {
      return {
        ok: false,
        reason: "daily_cap_exceeded",
        cap: 0,
        currentCount: 0,
        targetDay: targetDayStr,
      };
    }

    // cap > 0 path — count outbound_automated lead_calls for the
    // target day. NULL cap is treated as "no cap" — fall through.
    if (cap !== null && cap > 0) {
      const { count: dayCount, error: countErr } = await countOutboundCallsForDay(
        supabase,
        req.businessId,
        targetDayDate,
      );
      if (countErr || dayCount === null) {
        // Fail-open: log + proceed. Cap is a soft tenant-set throttle,
        // not a TCPA regulatory ceiling. A flaky count query should
        // not drop calls. (Asymmetric to compliance which fails-closed
        // because TCPA exposure is real.)
        Sentry.captureMessage("daily_cap_count_query_failed", {
          level: "warning",
          extra: {
            businessId: req.businessId,
            error: countErr,
            targetDay: targetDayStr,
          },
        });
      } else if (dayCount >= cap) {
        return {
          ok: false,
          reason: "daily_cap_exceeded",
          cap,
          currentCount: dayCount,
          targetDay: targetDayStr,
        };
      }
    }
  }

  // (6) Pre-insert lead_calls row — OR verify the worker-locked row
  // when existingLeadCallId is set.
  const nowIso = new Date().toISOString();
  // existingLeadCallId implies the worker is firing NOW — ignore any
  // scheduledFor in the request. isScheduled stays false so we fall
  // through to step 8 instead of deferring.
  const isScheduled =
    !req.existingLeadCallId &&
    !!(req.scheduledFor && req.scheduledFor.getTime() > Date.now());

  let leadCallId: string;
  if (req.existingLeadCallId) {
    // Cooperative-lock verification. Worker set status='processing'
    // before invoking placeCall; assert we still own that lock and
    // the row matches the request's leadId.
    try {
      const { data: existing, error: existErr } = await supabase
        .from("lead_calls")
        .select("id, status, lead_id")
        .eq("id", req.existingLeadCallId)
        .maybeSingle();
      if (existErr) {
        return { ok: false, reason: "db_error", step: "existing_row_lookup", error: existErr.message };
      }
      const eRow = existing as { id: string; status: string; lead_id: string } | null;
      if (!eRow) {
        return { ok: false, reason: "db_error", step: "existing_row_not_found", error: "row not found" };
      }
      if (eRow.lead_id !== req.leadId) {
        return { ok: false, reason: "db_error", step: "existing_row_lead_mismatch", error: "lead_id mismatch" };
      }
      if (eRow.status !== "processing") {
        return {
          ok: false,
          reason: "db_error",
          step: "existing_row_not_locked",
          error: `expected status='processing', got '${eRow.status}'`,
        };
      }
      leadCallId = req.existingLeadCallId;
    } catch (err: any) {
      return { ok: false, reason: "db_error", step: "existing_row_lookup", error: err?.message || String(err) };
    }
  } else {
    const preInsertRow: Record<string, unknown> = {
      lead_id: req.leadId,
      direction: req.direction,
      customer_phone: customerPhone,
      status: isScheduled ? "scheduled" : "initiated",
      attempt_number: req.attemptNumber ?? 1,
      retry_count: req.retryCount ?? 0,
    };
    if (req.direction === "inbound_bridge") {
      preInsertRow.staff_user_id = req.staffUserId;
      preInsertRow.staff_ring_number = req.staffRingNumber;
      preInsertRow.from_caller_id = bridgeCallerIdFrom;
      preInsertRow.started_at = nowIso;
    } else {
      preInsertRow.call_objective = req.callObjective;
      if (req.campaignId) preInsertRow.campaign_id = req.campaignId;
      if (req.scheduledFor) preInsertRow.scheduled_for = req.scheduledFor.toISOString();
      if (!isScheduled) preInsertRow.started_at = nowIso;
    }
    try {
      const { data, error } = await supabase
        .from("lead_calls")
        .insert(preInsertRow)
        .select("id")
        .single();
      if (error || !data) {
        return { ok: false, reason: "db_error", step: "pre_insert", error: error?.message || "insert returned no row" };
      }
      leadCallId = (data as { id: string }).id;
    } catch (err: any) {
      return { ok: false, reason: "db_error", step: "pre_insert", error: err?.message || String(err) };
    }
  }

  // (6.5) Phase 2.1 — post-insert race detector for the daily cap.
  // Re-runs the count query AFTER the row is in lead_calls. If the
  // observed count exceeds cap, two concurrent placeCall invocations
  // raced past the pre-insert check. Fire a Sentry warning so we have
  // production monitoring data — if this fires regularly, Phase 2.2/2.3
  // promotes to an atomic counter. Observability only; we don't roll
  // back the INSERT.
  //
  // Skipped for inbound_bridge (no cap) and for existingLeadCallId mode
  // (worker fired an already-counted scheduled row; no fresh INSERT
  // happened here).
  if (
    req.direction === "outbound_automated" &&
    !req.existingLeadCallId &&
    businessRow !== null &&
    businessRow.max_outbound_calls_per_day !== null &&
    businessRow.max_outbound_calls_per_day > 0
  ) {
    const cap = businessRow.max_outbound_calls_per_day;
    const targetDayDate = req.scheduledFor ?? new Date();
    const { count: observedCount, error: raceErr } = await countOutboundCallsForDay(
      supabase,
      req.businessId,
      targetDayDate,
    );
    if (!raceErr && observedCount !== null && observedCount > cap) {
      Sentry.captureMessage("daily_cap_race_observed", {
        level: "warning",
        extra: {
          businessId: req.businessId,
          cap,
          observedCount,
          targetDay: targetDayDate.toISOString().slice(0, 10),
          leadCallId,
        },
      });
    }
    // raceErr we don't surface — the cap check already passed and we're
    // not going to refuse a placed call because the verification query
    // flaked. Sentry already captured the original count-query error if
    // there was one.
  }

  // (7) Defer placement when scheduled in the future.
  // existingLeadCallId forced isScheduled=false above; this branch is
  // skipped naturally for the worker path.
  if (isScheduled) {
    return { ok: true, leadCallId, callSid: null, provider: null, status: "scheduled" };
  }

  // (8) Build provider payload.
  const publicBase = getPublicApiBase();
  let providerToUse: CallProvider;
  let payload: BridgePayload | AutomatedPayload;
  let toNumber: string;
  let fromNumber: string;
  let recording: boolean;

  if (req.direction === "inbound_bridge") {
    // Bridge: dial staff first. customer is connected via answerOnBridge
    // TwiML at the bridge URL.
    providerToUse = "twilio";  // hardcoded per invariant 3
    toNumber = req.staffRingNumber!;
    fromNumber = bridgeCallerIdFrom!;
    recording = true;  // Slice 2A invariant per invariant 4
    payload = {
      kind: "bridge",
      twimlUrl: `${publicBase}/api/twilio/voice/lead-bridge?lead_call_id=${encodeURIComponent(leadCallId)}`,
      statusCallbackUrl: `${publicBase}/api/twilio/call-status?lead_call_id=${encodeURIComponent(leadCallId)}`,
      recordingStatusCallbackUrl: `${publicBase}/api/twilio/recording-status`,
    };
  } else {
    // Outbound automated: dial customer directly. Provider resolves
    // from-number (Twilio: tenant's twilio_phone_number; ElevenLabs:
    // their phone_number_id).
    providerToUse =
      req.providerOverride ?? (businessRow!.outbound_provider as CallProvider) ?? "elevenlabs_hosted";
    toNumber = customerPhone;
    fromNumber = businessRow!.twilio_phone_number ?? "";  // ignored by ElevenLabsHosted
    recording = businessRow!.record_outbound_calls !== false;  // default true
    const agentId = businessRow!.agent_id ?? "";
    payload = {
      kind: "automated",
      agentId,
      callObjective: req.callObjective!,
      twimlUrl: `${publicBase}/api/twilio/outbound-voice/twiml?lead_call_id=${encodeURIComponent(leadCallId)}`,
      statusCallbackUrl: `${publicBase}/api/twilio/outbound-voice/status?lead_call_id=${encodeURIComponent(leadCallId)}`,
      recordingStatusCallbackUrl: `${publicBase}/api/twilio/recording-status`,
      amdStatusCallbackUrl: `${publicBase}/api/twilio/outbound-voice/amd?lead_call_id=${encodeURIComponent(leadCallId)}`,
    };
  }

  // (9) Resolve provider instance + (10) place the call.
  const provider: ICallProvider = _getProviderImpl(providerToUse, { supabase });
  const result = await provider.placeCall({
    provider: providerToUse,
    to: toNumber,
    from: fromNumber,
    businessId: req.businessId,
    leadCallId,
    direction: req.direction,
    recording,
    payload,
  });

  // (11) Provider failure — mark row failed, return structured error.
  if (!result.ok) {
    try {
      await supabase
        .from("lead_calls")
        .update({ status: "failed", end_reason: "twilio_create_failed" })
        .eq("id", leadCallId);
    } catch (e: any) {
      Sentry.captureMessage("place_call_failed_status_update_failed", {
        level: "warning",
        extra: { leadCallId, error: e?.message },
      });
    }
    return {
      ok: false,
      reason: "provider_failed",
      provider: providerToUse,
      providerError: result.error,
      twilioCode: result.twilioCode,
    };
  }

  // (12) Success — UPDATE call_sid. Failure here is non-fatal (call IS
  // placed; orphaned CallSid is recoverable from Twilio side).
  // existingLeadCallId mode: also transition status='processing' →
  // 'initiated' and stamp started_at (the worker-locked row was
  // created at scheduling time with status='scheduled' and no
  // started_at; this UPDATE completes the state machine).
  const successUpdate: Record<string, unknown> = { call_sid: result.callSid };
  if (req.existingLeadCallId) {
    successUpdate.status = "initiated";
    successUpdate.started_at = nowIso;
  }
  try {
    await supabase
      .from("lead_calls")
      .update(successUpdate)
      .eq("id", leadCallId);
  } catch (err: any) {
    Sentry.captureMessage("place_call_callsid_update_failed", {
      level: "warning",
      extra: { leadCallId, callSid: result.callSid, error: err?.message },
    });
  }

  // (13) lead_activities insert. Best-effort.
  const activityMetadata: Record<string, unknown> = {
    lead_call_id: leadCallId,
    call_sid: result.callSid,
    customer_phone: customerPhone,
    direction: req.direction,
    provider: providerToUse,
  };
  if (req.direction === "inbound_bridge") {
    activityMetadata.staff_user_id = req.staffUserId;
    activityMetadata.ring_number = req.staffRingNumber;
    activityMetadata.from_caller_id = bridgeCallerIdFrom;
  } else {
    activityMetadata.call_objective = req.callObjective;
    if (req.campaignId) activityMetadata.campaign_id = req.campaignId;
    activityMetadata.attempt_number = req.attemptNumber ?? 1;
  }
  try {
    await supabase.from("lead_activities").insert({
      lead_id: req.leadId,
      actor_id: req.direction === "inbound_bridge" ? req.staffUserId : null,
      actor_type: req.direction === "inbound_bridge" ? "staff" : "system",
      action: "call_initiated",
      metadata: activityMetadata,
    });
  } catch (err: any) {
    Sentry.captureMessage("place_call_activity_insert_failed", {
      level: "warning",
      extra: { leadCallId, error: err?.message },
    });
  }

  // (14) Audit. Already best-effort internally — wrap defensively anyway.
  try {
    await auditLog({
      userId: req.staffUserId,
      businessId: req.businessId,
      action: "leads.call.initiated",
      ipAddress: req.requestMeta?.ipAddress ?? undefined,
      userAgent: req.requestMeta?.userAgent ?? undefined,
      sessionId: req.requestMeta?.sessionId ?? undefined,
      details: {
        lead_id: req.leadId,
        lead_call_id: leadCallId,
        call_sid: result.callSid,
        direction: req.direction,
        provider: providerToUse,
        call_objective: req.callObjective ?? null,
        campaign_id: req.campaignId ?? null,
        source: req.direction === "outbound_automated"
          ? (req.campaignId ? "campaign" : "system")
          : (req.isAdmin ? "admin_raw" : "customer"),
      },
    });
  } catch {
    // auditLog already swallows; outer try/catch is belt-and-suspenders.
  }

  // (15) Return success.
  // fromCallerId is the actual E.164 we dialed from. For bridge it's the
  // resolved outbound caller ID; for outbound_automated/twilio it's the
  // tenant's twilio_phone_number; for elevenlabs the empty placeholder is
  // not meaningful — omit it so consumers can branch on presence.
  const fromCallerId =
    req.direction === "inbound_bridge"
      ? bridgeCallerIdFrom ?? undefined
      : providerToUse === "twilio"
        ? fromNumber || undefined
        : undefined;
  return {
    ok: true,
    leadCallId,
    callSid: result.callSid,
    provider: providerToUse,
    status: "placed",
    ...(fromCallerId ? { fromCallerId } : {}),
  };
}
