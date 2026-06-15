/**
 * Phase 0 Commit 0-C — Do-Not-Call gate.
 *
 * Two suppression sources, in priority order:
 *   1. leads.do_not_call BOOLEAN (per-lead override; staff-set or
 *      auto-set by future voice-STOP handlers).
 *   2. dnc_list table (per-tenant phone-level registry from migration
 *      025; populated by inbound STOP, SMS opt-outs that converted to
 *      voice DNC, manual entries, future federal/state DNC scrubs).
 *
 * Either source blocks the call. The check returns the FIRST matching
 * source so the caller can present a precise reason ("blocked because
 * this lead has do_not_call=true" vs "blocked because phone is on the
 * tenant DNC list since 2026-06-15").
 *
 * Fail-closed posture: any DB error returns { allowed: false } with
 * blocked_by='tenant_dnc_list' and no dnc_record. Phase 0 + 1 favor
 * the false-block over the false-allow during transient DB blips —
 * a TCPA violation costs more than a missed campaign call.
 *
 * Phone normalization: opts.phone MUST already be E.164. Normalizing
 * inside the helper risks a sneak-through if two paths normalize
 * differently. Callers normalize once upstream and pass the canonical
 * form. (Both lib/twilio-caller-id.ts and the campaign engine in
 * Phase 1 do this.)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface DncCheckResult {
  allowed: boolean;
  blocked_by?: "lead_marked" | "tenant_dnc_list";
  dnc_record?: {
    source: string | null;
    reason: string | null;
    created_at: string;
  };
}

export interface CheckDncOptions {
  businessId: string;
  /** E.164 — assumed canonical, NOT normalized inside this helper. */
  phone: string;
  /** Optional. When set, the per-lead do_not_call flag is checked first. */
  leadId?: string;
}

export async function checkDnc(
  supabase: SupabaseClient,
  opts: CheckDncOptions,
): Promise<DncCheckResult> {
  if (opts.leadId) {
    try {
      const { data, error } = await supabase
        .from("leads")
        .select("do_not_call")
        .eq("id", opts.leadId)
        .maybeSingle();
      if (error) return failClosed();
      const row = data as { do_not_call?: boolean | null } | null;
      if (row?.do_not_call === true) {
        return { allowed: false, blocked_by: "lead_marked" };
      }
    } catch {
      return failClosed();
    }
  }

  try {
    const { data, error } = await supabase
      .from("dnc_list")
      .select("source, reason, created_at")
      .eq("business_id", opts.businessId)
      .eq("phone", opts.phone)
      .limit(1)
      .maybeSingle();
    if (error) return failClosed();
    if (data) {
      const row = data as {
        source: string | null;
        reason: string | null;
        created_at: string;
      };
      return {
        allowed: false,
        blocked_by: "tenant_dnc_list",
        dnc_record: {
          source: row.source,
          reason: row.reason,
          created_at: row.created_at,
        },
      };
    }
  } catch {
    return failClosed();
  }

  return { allowed: true };
}

function failClosed(): DncCheckResult {
  return { allowed: false, blocked_by: "tenant_dnc_list" };
}
