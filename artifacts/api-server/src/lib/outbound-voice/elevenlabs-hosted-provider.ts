/**
 * ElevenLabsHostedProvider — implements ICallProvider via ElevenLabs's
 * managed Twilio outbound endpoint.
 *
 *   POST https://api.elevenlabs.io/v1/convai/twilio/outbound_call
 *   Headers: xi-api-key, content-type: application/json
 *   Body: { agent_id, agent_phone_number_id, to_number }
 *
 * ElevenLabs places the Twilio call on our behalf using the
 * agent_phone_number_id (a workspace-side mapping that ties a Twilio
 * phone-number resource to an ElevenLabs agent). The 2xx response
 * includes a `callSid` we can track via our existing Twilio status /
 * recording callbacks — those callbacks fire against our handlers
 * because Twilio's number is still configured to webhook back to us.
 *
 * Phase 0 caveats:
 *   - business_configs.elevenlabs_phone_number_id does NOT yet exist
 *     as a column. The resolver reads it defensively (treats a missing
 *     column as "not configured") and falls back to env
 *     ELEVENLABS_DEFAULT_PHONE_NUMBER_ID. Phase 1 ships the column in
 *     migration 026 with the rest of the outbound config; until then,
 *     env-fallback is the supported path.
 *   - No AMD / recording handling here — those are properties of the
 *     ElevenLabs agent + phone_number_id workspace config, NOT the call
 *     placement request body. Ops sets them on the ElevenLabs side.
 *   - opts.payload.kind MUST be 'automated' — ElevenLabs's hosted
 *     outbound is conversational; bridge calls go through
 *     TwilioRestProvider.
 *   - opts.from is intentionally ignored here. ElevenLabs uses the
 *     phone number bound to agent_phone_number_id; the caller's from
 *     is irrelevant. We do NOT silently fail if it mismatches — the
 *     caller upstream decided the provider.
 *
 * Fail-fast posture: ELEVENLABS_API_KEY presence is checked at first
 * use (NOT at module load — keeps test bootstrap simpler than the
 * elevenlabs-tts pattern). Missing key returns a structured error
 * instead of throwing — the caller can decide whether to surface to
 * staff or just log.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ICallProvider,
  PlaceCallOptions,
  PlaceCallResult,
} from "./types";

const ELEVENLABS_OUTBOUND_URL =
  "https://api.elevenlabs.io/v1/convai/twilio/outbound_call";

export class ElevenLabsHostedProvider implements ICallProvider {
  constructor(private opts: { supabase?: SupabaseClient } = {}) {}

  async placeCall(opts: PlaceCallOptions): Promise<PlaceCallResult> {
    if (opts.payload.kind !== "automated") {
      return {
        ok: false,
        error:
          "ElevenLabsHostedProvider supports automated payloads only; use TwilioRestProvider for bridge calls",
        provider: "elevenlabs_hosted",
      };
    }
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error:
          "ELEVENLABS_API_KEY env var is not set; cannot place ElevenLabs hosted outbound call",
        provider: "elevenlabs_hosted",
      };
    }
    const phoneNumberId = await this.resolvePhoneNumberId(opts.businessId);
    if (!phoneNumberId) {
      return {
        ok: false,
        error:
          "ElevenLabs phone number not configured for tenant; set business_configs.elevenlabs_phone_number_id (Phase 1 migration 026) or ELEVENLABS_DEFAULT_PHONE_NUMBER_ID env",
        provider: "elevenlabs_hosted",
      };
    }

    let response: Response;
    try {
      response = await fetch(ELEVENLABS_OUTBOUND_URL, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          agent_id: opts.payload.agentId,
          agent_phone_number_id: phoneNumberId,
          to_number: opts.to,
        }),
      });
    } catch (err: any) {
      return {
        ok: false,
        error: `Network error calling ElevenLabs outbound endpoint: ${err?.message || String(err)}`,
        provider: "elevenlabs_hosted",
      };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        error: `ElevenLabs outbound endpoint returned HTTP ${response.status}: ${text.slice(0, 500)}`,
        provider: "elevenlabs_hosted",
      };
    }

    let data: any;
    try {
      data = await response.json();
    } catch (err: any) {
      return {
        ok: false,
        error: `ElevenLabs outbound response not valid JSON: ${err?.message || String(err)}`,
        provider: "elevenlabs_hosted",
      };
    }

    // ElevenLabs returns the Twilio CallSid alongside their own
    // conversation_id. The CallSid is the SID our existing callbacks
    // will key off of — that's what we surface as the result.
    const callSid =
      (typeof data?.callSid === "string" && data.callSid) ||
      (typeof data?.call_sid === "string" && data.call_sid) ||
      null;
    if (!callSid) {
      return {
        ok: false,
        error:
          "ElevenLabs outbound response did not include a Twilio CallSid",
        provider: "elevenlabs_hosted",
      };
    }
    return { ok: true, callSid, provider: "elevenlabs_hosted" };
  }

  /**
   * business_configs.elevenlabs_phone_number_id reads. Defensive of
   * the missing-column case (Phase 1 ships it in migration 026); falls
   * back to the env default when the column or row isn't found.
   */
  private async resolvePhoneNumberId(
    businessId: string,
  ): Promise<string | null> {
    const envDefault = process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID || null;
    if (!this.opts.supabase) return envDefault;
    try {
      const { data, error } = await this.opts.supabase
        .from("business_configs")
        .select("elevenlabs_phone_number_id")
        .eq("business_id", businessId)
        .maybeSingle();
      if (error) {
        // Column-doesn't-exist surfaces as PostgREST "column ... does not
        // exist" — treat as "not configured", fall through to env.
        return envDefault;
      }
      const row = data as { elevenlabs_phone_number_id?: string | null } | null;
      const fromConfig = row?.elevenlabs_phone_number_id?.trim() || null;
      return fromConfig || envDefault;
    } catch {
      return envDefault;
    }
  }
}
