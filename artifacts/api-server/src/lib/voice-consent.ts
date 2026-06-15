/**
 * Phase 0 Commit 0-C — Voice consent gate.
 *
 * TCPA / 2024 FCC closed-loop consent requires evidence of consent
 * for outbound voice traffic. Two sources, in priority order:
 *   1. voice_consent_records — explicit per-phone, per-consent_type
 *      grant. The most recent matching row wins (granted=TRUE rows
 *      with revoked_at IS NULL → allowed; revoked rows → blocked).
 *   2. business_configs.voice_consent_default — tenant-level fallback
 *      for industries where every lead grants consent during inbound
 *      (e.g. a verbal "yes we can call you back about this" on the
 *      original call). Cautious default FALSE on every tenant from
 *      migration 025.
 *
 * The result carries either the explicit record's id (auditable) OR
 * a via_tenant_default flag (also auditable, just less specific).
 * Both paths are TCPA-defensible IF the tenant has the underlying
 * evidence trail; the via_tenant_default path puts the burden on the
 * tenant to show that evidence in a compliance audit.
 *
 * Fail-closed: DB error returns blocked=no_record (the safer default).
 * Never throws.
 *
 * Phone normalization: opts.phone MUST already be E.164. Same
 * rationale as dnc-check.ts.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceConsentCheckResult {
  allowed: boolean;
  blocked_by?: "no_record" | "revoked";
  consent_record_id?: string;
  via_tenant_default?: boolean;
}

export interface CheckVoiceConsentOptions {
  businessId: string;
  /** E.164 — assumed canonical. */
  phone: string;
  /** appointment_reminder | callback | marketing | survey | ... */
  consentType: string;
}

export async function checkVoiceConsent(
  supabase: SupabaseClient,
  opts: CheckVoiceConsentOptions,
): Promise<VoiceConsentCheckResult> {
  let consentRow: { id: string; revoked_at: string | null } | null;
  try {
    const { data, error } = await supabase
      .from("voice_consent_records")
      .select("id, revoked_at")
      .eq("business_id", opts.businessId)
      .eq("phone", opts.phone)
      .eq("consent_type", opts.consentType)
      .eq("granted", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { allowed: false, blocked_by: "no_record" };
    consentRow = data as { id: string; revoked_at: string | null } | null;
  } catch {
    return { allowed: false, blocked_by: "no_record" };
  }

  if (consentRow) {
    if (consentRow.revoked_at) {
      return {
        allowed: false,
        blocked_by: "revoked",
        consent_record_id: consentRow.id,
      };
    }
    return { allowed: true, consent_record_id: consentRow.id };
  }

  // No explicit record → check tenant default.
  let defaultRow: { voice_consent_default: boolean | null } | null;
  try {
    const { data, error } = await supabase
      .from("business_configs")
      .select("voice_consent_default")
      .eq("business_id", opts.businessId)
      .maybeSingle();
    if (error) return { allowed: false, blocked_by: "no_record" };
    defaultRow = data as { voice_consent_default: boolean | null } | null;
  } catch {
    return { allowed: false, blocked_by: "no_record" };
  }

  if (defaultRow?.voice_consent_default === true) {
    return { allowed: true, via_tenant_default: true };
  }
  return { allowed: false, blocked_by: "no_record" };
}
