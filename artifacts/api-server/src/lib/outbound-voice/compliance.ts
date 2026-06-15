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
