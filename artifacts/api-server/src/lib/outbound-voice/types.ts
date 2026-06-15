/**
 * Type contract for the outbound-voice provider abstraction.
 *
 * Two providers implement ICallProvider:
 *   - TwilioRestProvider          — direct Twilio REST API, full control
 *     over TwiML / AMD / recording / status callbacks. Used for
 *     outbound_bridge + future custom outbound flows.
 *   - ElevenLabsHostedProvider    — POSTs to ElevenLabs's hosted
 *     /v1/convai/twilio/outbound_call endpoint. They place the Twilio
 *     call on our behalf using our agent_phone_number_id. Returns a
 *     Twilio CallSid we track via existing callbacks.
 *
 * Provider selection is per-call via PlaceCallOptions.provider — campaigns
 * can pin a provider per objective without changing the call-placement
 * code path.
 *
 * Design notes:
 *   - HTTP req/res are intentionally NOT in this interface. The provider
 *     is transport-agnostic; callers (route handlers, cron jobs) own
 *     their own HTTP shape.
 *   - The lead_calls row is pre-inserted by the caller BEFORE placeCall.
 *     The provider just returns the Twilio CallSid; the caller UPDATEs
 *     the row. This keeps the provider's responsibility narrow and the
 *     DB-write surface uniform across both providers.
 *   - Caller ID resolution (the resolveOutboundCallerId pattern from
 *     lib/twilio-caller-id.ts) happens UPSTREAM of placeCall. By the time
 *     placeCall is called, `from` is already a valid E.164 number.
 *   - The 21217 "caller ID not verified" retry is encapsulated INSIDE
 *     TwilioRestProvider — see its implementation. Callers don't need
 *     to know about that quirk.
 */

import type twilio from "twilio";

export type CallDirection =
  | "inbound_bridge"
  | "outbound_automated"
  | "outbound_bridge";

export type CallProvider = "twilio" | "elevenlabs_hosted";

/**
 * Twilio AMD modes. See https://www.twilio.com/docs/voice/answering-machine-detection
 *   Enable             — fires AMD callback when human/machine decided
 *   DetectMessageEnd   — also fires when the voicemail beep ends, so
 *                        the caller knows when to start the agent message.
 *                        Phase 0 default.
 */
export type AmdMode = "Enable" | "DetectMessageEnd";

/**
 * Bridge call payload — staff-leg first, customer-leg connected via
 * answerOnBridge TwiML. Mirrors the Slice 2A shape.
 */
export interface BridgePayload {
  kind: "bridge";
  twimlUrl: string;
  statusCallbackUrl: string;
  recordingStatusCallbackUrl?: string;
}

/**
 * Automated outbound payload — single customer leg with AMD. The
 * twimlUrl returns TwiML that connects to an AI agent (ElevenLabs WSS
 * or a custom <Connect><Stream> path). Phase 0-B leaves the route that
 * generates this TwiML for 0-D — placeCall just uses whichever URL the
 * caller provides.
 */
export interface AutomatedPayload {
  kind: "automated";
  agentId: string;
  callObjective: string;
  twimlUrl: string;
  statusCallbackUrl: string;
  recordingStatusCallbackUrl?: string;
  amdStatusCallbackUrl?: string;
  customContext?: Record<string, string | number | boolean>;
}

export interface PlaceCallOptions {
  provider: CallProvider;
  to: string;
  from: string;
  businessId: string;
  leadCallId: string;
  direction: CallDirection;
  recording: boolean;
  amd?: AmdMode;
  payload: BridgePayload | AutomatedPayload;
}

export type PlaceCallResult =
  | { ok: true; callSid: string; provider: CallProvider }
  | {
      ok: false;
      error: string;
      twilioCode?: number;
      provider: CallProvider;
    };

export interface ICallProvider {
  placeCall(opts: PlaceCallOptions): Promise<PlaceCallResult>;
}

// Re-export the twilio client constructor type so providers can accept
// a mock override without importing twilio at every call site.
export type TwilioClient = ReturnType<typeof twilio>;
