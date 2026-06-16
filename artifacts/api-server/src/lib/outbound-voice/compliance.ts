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

export interface ComplianceDecision {
  allowed: boolean;
  checks: {
    dnc: DncCheckResult;
    calling_hours: CallingHoursCheckResult;
    consent: VoiceConsentCheckResult;
  };
  blocked_by?: "dnc" | "calling_hours" | "consent";
}

export interface CheckComplianceOptions {
  businessId: string;
  /** E.164 — assumed canonical. */
  phone: string;
  /** Optional. When set, lead-level do_not_call flag is checked. */
  leadId?: string;
  /** appointment_reminder | callback | marketing | survey | ... */
  consentType: string;
  /** IANA name e.g. 'America/New_York'. REQUIRED. */
  recipientTimezone: string;
  /** Defaults to new Date(). Pass a fixed instant for deterministic tests. */
  now?: Date;
}

export async function checkCompliance(
  supabase: SupabaseClient,
  opts: CheckComplianceOptions,
): Promise<ComplianceDecision> {
  const [dnc, calling_hours, consent] = await Promise.all([
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
    checkVoiceConsent(supabase, {
      businessId: opts.businessId,
      phone: opts.phone,
      consentType: opts.consentType,
    }),
  ]);

  const checks = { dnc, calling_hours, consent };

  if (!dnc.allowed) return { allowed: false, checks, blocked_by: "dnc" };
  if (!consent.allowed) return { allowed: false, checks, blocked_by: "consent" };
  if (!calling_hours.allowed) return { allowed: false, checks, blocked_by: "calling_hours" };

  return { allowed: true, checks };
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
