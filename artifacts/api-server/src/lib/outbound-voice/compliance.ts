/**
 * Phase 0 Commit 0-C — Compliance orchestrator.
 *
 * Composes the three pure-function gates (DNC, calling-hours, voice
 * consent) into a single decision. The campaign engine in Phase 1
 * calls this once per recipient BEFORE invoking getProvider() —
 * placeCall never runs against a blocked recipient.
 *
 * The orchestrator runs all three checks in PARALLEL via Promise.all.
 * That's intentional: even when one fails, surfacing the full set in
 * the returned `checks` field is more useful for the campaign log
 * ("blocked because DNC AND outside hours" is more informative than
 * "blocked because DNC, didn't check the rest"). The performance
 * cost is two extra DB roundtrips when the first check already blocks
 * — at <100ms per check this is well under any human-visible
 * threshold and gives operations the full picture.
 *
 * Priority for blocked_by: dnc > consent > calling_hours. Reasoning:
 *   - DNC is the strongest signal — never call this number under any
 *     conditions. Surfacing it first means staff don't waste cycles
 *     wondering about hours.
 *   - Consent is next — calling without consent is a TCPA violation
 *     regardless of hours.
 *   - Calling hours is last because the call is RETRYABLE at a
 *     different time, unlike the other two.
 *
 * No DB writes here. Audit-trail responsibility lives in the campaign
 * engine: it persists the full ComplianceDecision next to the
 * lead_calls row so a future audit can show exactly why a call was
 * (or wasn't) placed.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkDnc, type DncCheckResult } from "../dnc-check";
import { checkCallingHours, type CallingHoursCheckResult } from "../calling-hours";
import { checkVoiceConsent, type VoiceConsentCheckResult } from "../voice-consent";
import { checkVoiceOptOut, type VoiceOptOutCheckResult } from "../voice-opt-out";

export interface ComplianceDecision {
  allowed: boolean;
  checks: {
    /** Phase 5.1 — internal DNC (§64.1200(d)) — highest priority. */
    voice_opt_out: VoiceOptOutCheckResult;
    dnc: DncCheckResult;
    calling_hours: CallingHoursCheckResult;
    consent: VoiceConsentCheckResult;
  };
  blocked_by?: "voice_opt_out" | "dnc" | "calling_hours" | "consent";
}

export interface CheckComplianceOptions {
  businessId: string;
  /** E.164 — assumed canonical. */
  phone: string;
  /** Optional. When set, lead-level do_not_call flag is checked. */
  leadId?: string;
  /**
   * appointment_reminder | callback | marketing | survey | ...
   *
   * Phase 5.1 — pass 'staff_manual_dial' for softphone/manually-
   * initiated calls where TCPA §227(b)(1)(A) does NOT apply
   * (person-to-person, no autodialer). In that mode the consent
   * check is bypassed (voice_opt_out + DNC + calling_hours still
   * gate). Any other value goes through the full consent check.
   */
  consentType: string;
  /** IANA name e.g. 'America/New_York'. REQUIRED. */
  recipientTimezone: string;
  /** Defaults to new Date(). Pass a fixed instant for deterministic tests. */
  now?: Date;
}

/**
 * The literal consentType value that means "human at a keyboard
 * clicked Dial." Kept as a const so the check is grep-able + can't
 * drift by accidental string edit.
 */
export const STAFF_MANUAL_DIAL_CONSENT_TYPE = "staff_manual_dial" as const;

export async function checkCompliance(
  supabase: SupabaseClient,
  opts: CheckComplianceOptions,
): Promise<ComplianceDecision> {
  // Phase 5.1 — four gates in parallel now (added voice_opt_out).
  // Order-independent at execution; PRIORITY is applied on the return
  // side so `blocked_by` is stable regardless of check completion order.
  //
  // For staff_manual_dial (person-initiated, not autodialer per TCPA
  // §227(b)(1)(A) after Facebook v. Duguid), ONLY the consent gate is
  // bypassed. The consent requirement targets autodialers; a person
  // clicking Dial is outside that regime. Everything else STILL gates:
  //   - voice_opt_out — a customer who said "never call me" means it,
  //     even for a person-to-person call. The strongest possible "no."
  //   - dnc — regulatory registry / do-not-call lead flag apply
  //     regardless of dialer type.
  //   - calling_hours — tenant-configured window; a manual dial outside
  //     hours is still an operationally-suspect call. If a staff member
  //     needs an after-hours emergency exception, that's a per-tenant
  //     policy call, not a compliance bypass.
  const isStaffManual = opts.consentType === STAFF_MANUAL_DIAL_CONSENT_TYPE;
  const [voice_opt_out, dnc, calling_hours, consent] = await Promise.all([
    checkVoiceOptOut(supabase, {
      businessId: opts.businessId,
      phone: opts.phone,
    }),
    checkDnc(supabase, {
      businessId: opts.businessId,
      phone: opts.phone,
      leadId: opts.leadId,
    }),
    checkCallingHours(supabase, {
      businessId: opts.businessId,
      recipientTimezone: opts.recipientTimezone,
      now: opts.now,
    }),
    isStaffManual
      ? Promise.resolve<VoiceConsentCheckResult>({ allowed: true, via_tenant_default: false })
      : checkVoiceConsent(supabase, {
          businessId: opts.businessId,
          phone: opts.phone,
          consentType: opts.consentType,
        }),
  ]);

  const checks = { voice_opt_out, dnc, calling_hours, consent };

  // Phase 5.1 — priority: voice_opt_out > dnc > consent > calling_hours.
  // voice_opt_out is now the highest-priority signal because a customer
  // who explicitly asked to be removed is the strongest possible "no."
  // DNC is next (regulatory registry / do-not-call lead flag), then
  // consent (never call without it), then calling_hours (retryable at
  // a different time).
  if (!voice_opt_out.allowed) return { allowed: false, checks, blocked_by: "voice_opt_out" };
  if (!dnc.allowed) return { allowed: false, checks, blocked_by: "dnc" };
  if (!consent.allowed) return { allowed: false, checks, blocked_by: "consent" };
  if (!calling_hours.allowed) return { allowed: false, checks, blocked_by: "calling_hours" };

  return { allowed: true, checks };
}

// ── Phase 5.1: enforceOutboundEligibility — THROWING gate ────────────
//
// Every outbound call path (campaign expansion, softphone dial, lead-
// bridge, future manual buttons) MUST route through here or through
// placeCall (which internally runs the same checks). This function
// exists specifically for the "manual dial" paths that don't currently
// go through placeCall — softphone /voice/outbound in particular.
//
// Throws (not returns boolean) so a caller cannot silently ignore the
// result. On block, throws OutboundEligibilityError with the
// ComplianceDecision attached so the caller can log the reason.
//
// Callers that need a soft/silent check (e.g. UI preview of a campaign
// segment's expected pass rate) should call checkCompliance directly.

export class OutboundEligibilityError extends Error {
  constructor(
    message: string,
    public readonly decision: ComplianceDecision,
  ) {
    super(message);
    this.name = "OutboundEligibilityError";
  }
}

export async function enforceOutboundEligibility(
  supabase: SupabaseClient,
  opts: CheckComplianceOptions,
): Promise<ComplianceDecision> {
  const decision = await checkCompliance(supabase, opts);
  if (!decision.allowed) {
    const err = new OutboundEligibilityError(
      `outbound blocked: ${decision.blocked_by}`,
      decision,
    );
    throw err;
  }
  return decision;
}

// ── Phase 2.3: checkCampaignEligibility ──────────────────────────────
//
// Composes `already_in_campaign` (cheap, single SELECT) with
// checkCompliance (DNC + consent + calling_hours) for the Phase 2.4
// expansion worker's per-lead eligibility decision.
//
// Order: already_in_campaign first (single-row primary-key-style
// lookup on outbound_campaign_leads), then delegate to checkCompliance
// for the remaining three checks. Reuses checkCompliance so DNC/
// consent/calling_hours stays in sync with placeCall step 3 — no fork.
//
// NOT checked here: daily_cap. placeCall step 5.5 handles it at the
// actual call placement boundary. Adding it here would duplicate the
// count query + create double-counting concerns when the worker
// triggers placeCall right after.
//
// `opted_out` (Phase 3 reserved state on outbound_campaign_leads) is
// not a skip_reason vocabulary entry — no current code path triggers
// it. The state CHECK includes it for future-proofing.

export type CampaignSkipReason =
  | "voice_opt_out"
  | "dnc"
  | "consent"
  | "calling_hours"
  | "already_in_campaign";

export interface CheckCampaignEligibilityOptions {
  campaignId: string;
  businessId: string;
  leadId: string;
  /** E.164 — for DNC + consent + recipient-tz lookups via checkCompliance. */
  phone: string;
  /** = campaign.call_objective. Threaded to checkVoiceConsent. */
  consentType: string;
  /** IANA name e.g. 'America/New_York'. Caller resolves via lib/phone-timezone. */
  recipientTimezone: string;
  /** When the call would fire. Used for calling_hours window check. */
  scheduledFor: Date;
}

export type CampaignEligibilityResult =
  | { eligible: true }
  | { eligible: false; skip_reason: CampaignSkipReason };

export async function checkCampaignEligibility(
  supabase: SupabaseClient,
  opts: CheckCampaignEligibilityOptions,
): Promise<CampaignEligibilityResult> {
  // 1. already_in_campaign — cheap single-row lookup via the UNIQUE
  //    index. We treat ANY active state (pending or scheduled) as
  //    "already in campaign"; terminal states (completed, skipped,
  //    opted_out) don't block re-enrollment.
  try {
    const { data: existing } = await supabase
      .from("outbound_campaign_leads")
      .select("id")
      .eq("campaign_id", opts.campaignId)
      .eq("lead_id", opts.leadId)
      .in("state", ["pending", "scheduled"])
      .maybeSingle();
    if (existing) {
      return { eligible: false, skip_reason: "already_in_campaign" };
    }
  } catch {
    // DB error on the eligibility lookup is treated as already-in-
    // campaign defensively — we'd rather skip a lead than double-
    // schedule. Worker can retry next tick when the DB recovers.
    return { eligible: false, skip_reason: "already_in_campaign" };
  }

  // 2-4. DNC + consent + calling_hours via the parallel checkCompliance.
  const decision = await checkCompliance(supabase, {
    businessId: opts.businessId,
    phone: opts.phone,
    leadId: opts.leadId,
    consentType: opts.consentType,
    recipientTimezone: opts.recipientTimezone,
    now: opts.scheduledFor,
  });
  if (!decision.allowed) {
    return { eligible: false, skip_reason: decision.blocked_by! };
  }
  return { eligible: true };
}
