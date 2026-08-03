/**
 * Phase 0 Commit 0-C — Voice consent gate.
 * Phase 5.1 — tenant-default bypass RETIRED.
 *
 * TCPA / 2024 FCC closed-loop consent requires evidence of consent
 * for outbound voice traffic. ONE source now:
 *   1. voice_consent_records — explicit per-phone, per-consent_type
 *      grant. The most recent matching row wins (granted=TRUE rows
 *      with revoked_at IS NULL → allowed; revoked rows → blocked).
 *
 * Retired in Phase 5.1: the `business_configs.voice_consent_default`
 * fallback. Rationale: the column is FALSE on all 48 production
 * businesses (verified 2026-08), so no live behaviour changes. But
 * the bypass shape itself was a compliance liability — a single ops
 * SQL flip converted "no consent evidence" into "call anyone" with
 * no per-phone audit trail. Removed the branch; column stays with a
 * deprecated comment.
 *
 * If a tenant needs bulk-import consent (their industry has inbound
 * verbal consent as the norm), they express it via per-phone
 * voice_consent_records rows with source='import' + evidence_text
 * pointing at the batch attestation. No tenant-wide bypass.
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
  /**
   * Phase 5.1 — RETIRED. Preserved on the type for backwards compat
   * with any caller destructuring it; the checker no longer sets it
   * to true (always undefined or false).
   */
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

  // Phase 5.1 — no explicit consent record → BLOCKED.
  // (Prior behaviour consulted business_configs.voice_consent_default;
  // that fallback was retired because the tenant-wide bypass had no
  // per-phone audit trail. See file header.)
  return { allowed: false, blocked_by: "no_record" };
}
