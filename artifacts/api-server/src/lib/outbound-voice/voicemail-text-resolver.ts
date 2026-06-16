/**
 * Phase 2.5 — voicemail text resolution helper.
 *
 * Phase 1.6 hard-coded a single read of business_configs.
 * outbound_voicemail_text. Phase 2.1's migration 029 added
 * outbound_campaigns.voicemail_text_override but never wired it
 * through. Phase 2.5 wires it through here.
 *
 * Resolution flow:
 *   1. Read lead_calls(leadCallId) → { campaign_id, lead_id }
 *   2. If campaign_id is set:
 *      a. Read outbound_campaigns(campaign_id) →
 *         { voicemail_text_override, business_id }
 *      b. If voicemail_text_override is non-NULL and non-empty after
 *         trim → return that text trimmed
 *      c. Otherwise fall through to tenant default using the
 *         campaign's business_id
 *   3. If campaign_id is NULL:
 *      a. Read lead_calls's lead → leads.business_id
 *      b. Fall through to tenant default
 *   4. Read business_configs(business_id).outbound_voicemail_text
 *   5. Return the trimmed string, or null if empty/missing
 *
 * NULL/empty semantics (locked behavior; T17/T15 enforce):
 *   - voicemail_text_override = NULL          → use tenant default
 *   - voicemail_text_override = '' or '   '   → use tenant default
 *     (don't let ops accidentally null-out voicemail by setting an
 *     empty string in the campaign CRUD UI — Phase 2.6)
 *   - voicemail_text_override = 'Hello ...'   → use the override
 *   - business_configs.outbound_voicemail_text = NULL or empty
 *     → return null. Phase 1.6 voicemail flow then renders bare
 *     <Hangup/> TwiML (no message, agent disconnects gracefully).
 *
 * Two SELECTs max in the common path:
 *   - lead_calls (one SELECT)
 *   - EITHER outbound_campaigns (campaign-linked path)
 *     OR leads → business_configs (no-campaign path)
 *   - business_configs fallback (one more SELECT) only when the
 *     campaign override is NULL/empty
 *
 * Never throws. Returns null on any read failure. Caller (Phase 1.6
 * voicemail flow) treats null as "no voicemail" and renders <Hangup/>.
 *
 * Path A note (carries forward from Phase 1.6 + 2.1): this resolver
 * is meaningful only for Path B (TwilioRestProvider). Path A
 * (elevenlabs_hosted) routes through ElevenLabs's own TwiML; AMD +
 * voicemail are configured on their side. The voicemail_text_override
 * column is unused for Path A campaigns; safe to set but ignored.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

interface LeadCallRow {
  campaign_id: string | null;
  lead_id: string | null;
}

interface CampaignRow {
  business_id: string;
  voicemail_text_override: string | null;
}

function trimOrNull(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function resolveVoicemailText(
  supabase: SupabaseClient,
  leadCallId: string,
): Promise<string | null> {
  // (1) Load the lead_call row.
  let lc: LeadCallRow | null;
  try {
    const { data } = await supabase
      .from("lead_calls")
      .select("campaign_id, lead_id")
      .eq("id", leadCallId)
      .maybeSingle();
    lc = data as LeadCallRow | null;
  } catch {
    return null;
  }
  if (!lc) return null;

  let businessId: string | null = null;

  // (2) Campaign path — check for override first.
  if (lc.campaign_id) {
    try {
      const { data: campRow } = await supabase
        .from("outbound_campaigns")
        .select("business_id, voicemail_text_override")
        .eq("id", lc.campaign_id)
        .maybeSingle();
      const camp = campRow as CampaignRow | null;
      if (camp) {
        const override = trimOrNull(camp.voicemail_text_override);
        if (override !== null) {
          // Override wins — return immediately. No tenant-default lookup.
          return override;
        }
        // Override is NULL/empty — fall through to tenant default using
        // the campaign's business_id (saves one SELECT vs going through
        // leads).
        businessId = camp.business_id;
      }
    } catch {
      // Fall through to the no-campaign path with NULL businessId
      // resolution below.
    }
  }

  // (3) No-campaign (or campaign lookup failed) — resolve business_id
  // via lead_calls.lead_id → leads.business_id.
  if (!businessId) {
    if (!lc.lead_id) return null;
    try {
      const { data: leadRow } = await supabase
        .from("leads")
        .select("business_id")
        .eq("id", lc.lead_id)
        .maybeSingle();
      businessId = (leadRow as { business_id?: string } | null)?.business_id ?? null;
    } catch {
      return null;
    }
  }
  if (!businessId) return null;

  // (4-5) Tenant default.
  try {
    const { data: bizRow } = await supabase
      .from("business_configs")
      .select("outbound_voicemail_text")
      .eq("business_id", businessId)
      .maybeSingle();
    const tenantDefault = (bizRow as { outbound_voicemail_text?: string | null } | null)?.outbound_voicemail_text;
    return trimOrNull(tenantDefault);
  } catch {
    return null;
  }
}
