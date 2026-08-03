/**
 * Phase 5.1 — Voice opt-out gate.
 *
 * Consults `voice_opt_outs` (per-tenant TCPA §64.1200(d) internal DNC
 * list) for an active opt-out on this phone. Parallel to
 * `lib/dnc-check.ts` and `lib/voice-consent.ts`. Composed into
 * `checkCompliance()` in lib/outbound-voice/compliance.ts.
 *
 * "Active" opt-out = `resubscribed_at IS NULL`. Rows never delete
 * (5-year retention per §64.1200(d)(6)); resubscribe sets the column
 * so a subsequent granted consent moves the row out of the active set
 * but preserves the audit trail.
 *
 * Fail-closed: DB error returns blocked. Never throws. Same discipline
 * as checkVoiceConsent and checkDnc.
 *
 * Phone normalization: opts.phone MUST already be E.164 (matches
 * voice-consent.ts + dnc-check.ts convention).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface VoiceOptOutCheckResult {
  allowed: boolean;
  blocked_by?: "voice_opt_out" | "db_error";
  /** Set when an opt-out row was found. Lets the campaign log point at it. */
  opt_out_id?: string;
  /** Set when found — informs UI/logs of the opt-out source. */
  source?: string | null;
}

export interface CheckVoiceOptOutOptions {
  businessId: string;
  /** E.164 — assumed canonical. */
  phone: string;
}

export async function checkVoiceOptOut(
  supabase: SupabaseClient,
  opts: CheckVoiceOptOutOptions,
): Promise<VoiceOptOutCheckResult> {
  try {
    const { data, error } = await supabase
      .from("voice_opt_outs")
      .select("id, source, resubscribed_at")
      .eq("business_id", opts.businessId)
      .eq("phone", opts.phone)
      .is("resubscribed_at", null)
      .order("opted_out_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { allowed: false, blocked_by: "db_error" };
    }
    if (!data) {
      return { allowed: true };
    }
    const row = data as { id: string; source: string | null; resubscribed_at: string | null };
    return {
      allowed: false,
      blocked_by: "voice_opt_out",
      opt_out_id: row.id,
      source: row.source,
    };
  } catch {
    return { allowed: false, blocked_by: "db_error" };
  }
}
