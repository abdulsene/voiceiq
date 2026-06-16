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
 * In scope for 1.3: this file + tests/026-place-call-smoke.ts +
 * barrel re-export in outbound-voice/index.ts.
 * Out of scope: 1.4 handleInitiateCall refactor (Phase 1.4),
 * 1.5 worker, 1.6 voicemail, 1.7 dashboard.
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
}

export type PlaceCallResponse =
  | { ok: true; leadCallId: string; callSid: string; provider: CallProvider; status: "placed"; idempotent?: false }
  | { ok: true; leadCallId: string; callSid: null; provider: null; status: "scheduled"; idempotent?: boolean }
  | { ok: false; reason: "lead_not_found" }
  | { ok: false; reason: "lead_phone_invalid" }
  | { ok: false; reason: "business_not_found" }
  | { ok: false; reason: "staff_ring_number_missing" }
  | { ok: false; reason: "caller_id_unresolvable" }
  | { ok: false; reason: "tenant_outbound_disabled" }
  | { ok: false; reason: "non_nanp_number_no_tz_inference" }
  | { ok: false; reason: "compliance_blocked"; blocked_by: "dnc" | "consent" | "calling_hours"; checks: ComplianceDecision["checks"] }
  | { ok: false; reason: "provider_failed"; provider: CallProvider; providerError: string; twilioCode?: number }
  | { ok: false; reason: "db_error"; step: string; error: string };

// ── Main entry ──────────────────────────────────────────────────────

export async function placeCall(
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
  };
  let businessRow: BusinessRow | null = null;
  if (req.direction === "outbound_automated") {
    try {
      const { data, error } = await supabase
        .from("business_configs")
        .select(
          "outbound_voice_enabled, outbound_provider, record_outbound_calls, agent_id, business_name, twilio_phone_number, elevenlabs_phone_number_id",
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
  if (req.scheduledFor && req.direction === "outbound_automated") {
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

  // (6) Pre-insert lead_calls row.
  const nowIso = new Date().toISOString();
  const isScheduled = !!(req.scheduledFor && req.scheduledFor.getTime() > Date.now());
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
  let leadCallId: string;
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

  // (7) Defer placement when scheduled in the future.
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
  try {
    await supabase
      .from("lead_calls")
      .update({ call_sid: result.callSid })
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
  return {
    ok: true,
    leadCallId,
    callSid: result.callSid,
    provider: providerToUse,
    status: "placed",
  };
}
