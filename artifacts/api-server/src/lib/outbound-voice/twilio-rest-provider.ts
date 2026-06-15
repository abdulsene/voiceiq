/**
 * TwilioRestProvider — direct Twilio REST API implementation of
 * ICallProvider.
 *
 * Handles both bridge and automated payloads:
 *   bridge    — `url` is the TwiML URL the staff leg hits; the existing
 *               Slice 2A flow shape (record + recordingStatusCallback +
 *               statusCallback wired to the same handlers we already have).
 *   automated — single customer-leg dial with AMD enabled. machineDetection
 *               defaults to 'DetectMessageEnd' so the caller's AMD webhook
 *               (registered as asyncAmdStatusCallback) fires when the
 *               voicemail beep ends — that's the signal to start the
 *               agent's left-message turn.
 *
 * 21217 retry: Twilio rejects outbound calls whose `from` isn't either
 * Twilio-owned OR a verified OutgoingCallerId resource. The existing
 * `handleInitiateCall` in routes/lead-calls.ts caught code 21217 and
 * retried with a fallback number. That same quirk-handling lives here
 * now so future placeCall sites don't re-implement it.
 *
 * Fallback resolution: when 21217 fires, we retry once with the
 * TWILIO_PHONE_NUMBER env (Neverr's master line) as `from`. Phase 1
 * can replace this with a per-tenant lookup of
 * business_configs.twilio_phone_number; for 0-B the env constant is
 * sufficient and the retry is bounded to a single attempt.
 *
 * Constructor takes an optional twilioClient override for tests — the
 * 020/021/022 smoke harnesses inject a fake client without needing to
 * monkey-patch the module-level getTwilioClient().
 */

import { getTwilioClient } from "../../sms";
import type {
  ICallProvider,
  PlaceCallOptions,
  PlaceCallResult,
  TwilioClient,
} from "./types";

// Twilio error code for "Phone number not verified". Keep as a const so
// future readers don't have to chase the magic number.
const TWILIO_CALLER_ID_NOT_VERIFIED = 21217;

interface TwilioCallsCreateBody {
  to: string;
  from: string;
  url: string;
  record?: boolean;
  recordingChannels?: "mono" | "dual";
  recordingStatusCallback?: string;
  recordingStatusCallbackEvent?: string[];
  recordingStatusCallbackMethod?: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
  statusCallbackMethod?: string;
  machineDetection?: string;
  asyncAmd?: string;
  asyncAmdStatusCallback?: string;
  asyncAmdStatusCallbackMethod?: string;
}

export class TwilioRestProvider implements ICallProvider {
  constructor(private opts: { twilioClient?: TwilioClient } = {}) {}

  private get client(): TwilioClient {
    return this.opts.twilioClient ?? getTwilioClient();
  }

  async placeCall(opts: PlaceCallOptions): Promise<PlaceCallResult> {
    const body = this.buildCallBody(opts);
    return this.dispatch(body);
  }

  private buildCallBody(opts: PlaceCallOptions): TwilioCallsCreateBody {
    const body: TwilioCallsCreateBody = {
      to: opts.to,
      from: opts.from,
      url: opts.payload.twimlUrl,
    };

    if (opts.recording) {
      body.record = true;
      body.recordingChannels = "dual";
      if (opts.payload.recordingStatusCallbackUrl) {
        body.recordingStatusCallback = opts.payload.recordingStatusCallbackUrl;
        body.recordingStatusCallbackEvent = ["completed"];
        body.recordingStatusCallbackMethod = "POST";
      }
    }

    body.statusCallback = opts.payload.statusCallbackUrl;
    body.statusCallbackEvent = [
      "initiated",
      "ringing",
      "answered",
      "completed",
    ];
    body.statusCallbackMethod = "POST";

    // AMD is meaningful only for outbound automated dials. Bridge calls
    // ring the staff first, so AMD against the staff line would mislabel
    // the human/machine result. The payload-kind switch keeps that intent
    // explicit.
    if (opts.payload.kind === "automated") {
      const amdMode = opts.amd ?? "DetectMessageEnd";
      body.machineDetection = amdMode;
      body.asyncAmd = "true";
      if (opts.payload.amdStatusCallbackUrl) {
        body.asyncAmdStatusCallback = opts.payload.amdStatusCallbackUrl;
        body.asyncAmdStatusCallbackMethod = "POST";
      }
    }

    return body;
  }

  private async dispatch(body: TwilioCallsCreateBody): Promise<PlaceCallResult> {
    try {
      const created = await this.client.calls.create(body as any);
      return { ok: true, callSid: created.sid, provider: "twilio" };
    } catch (err: any) {
      const code = err?.code ?? err?.responseDetails?.code ?? null;
      if (code === TWILIO_CALLER_ID_NOT_VERIFIED) {
        return this.retryWithFallbackCallerId(body, err);
      }
      return {
        ok: false,
        error: err?.message || String(err),
        twilioCode: typeof code === "number" ? code : undefined,
        provider: "twilio",
      };
    }
  }

  private async retryWithFallbackCallerId(
    body: TwilioCallsCreateBody,
    originalErr: any,
  ): Promise<PlaceCallResult> {
    const fallback = process.env.TWILIO_PHONE_NUMBER;
    if (!fallback) {
      return {
        ok: false,
        error:
          "Twilio caller ID not verified and no TWILIO_PHONE_NUMBER fallback configured",
        twilioCode: TWILIO_CALLER_ID_NOT_VERIFIED,
        provider: "twilio",
      };
    }
    try {
      const retryBody = { ...body, from: fallback };
      const created = await this.client.calls.create(retryBody as any);
      return { ok: true, callSid: created.sid, provider: "twilio" };
    } catch (retryErr: any) {
      const code = retryErr?.code ?? retryErr?.responseDetails?.code ?? null;
      return {
        ok: false,
        error: `Caller ID retry also failed: ${retryErr?.message || String(retryErr)} (original: ${originalErr?.message || String(originalErr)})`,
        twilioCode: typeof code === "number" ? code : undefined,
        provider: "twilio",
      };
    }
  }
}
