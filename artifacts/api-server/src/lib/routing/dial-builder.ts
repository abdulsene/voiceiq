/**
 * Phase 3.2a — pure TwiML builder for the routing dial leg.
 *
 * Consumes a RoutingDecision (from fallback-logic.ts) plus business
 * context (whisper text, caller ID, record flag) and produces a TwiML
 * string that Twilio will execute when we redirect the call away from
 * ElevenLabs to the staff bridge.
 *
 * Only the three "actually dial someone" paths go through here:
 *   - topic_match       → simultaneous <Dial><Number>...</Number>... rings
 *   - any_on_duty       → same, over the fallback candidate pool
 *   - legacy_transfer   → single <Number> pointing at transfer_to_phone
 *
 * The other two paths (after_hours_callback, graceful_hangup) don't
 * dial — the handler signals the LLM to stay on the call and either
 * take a callback (existing request_callback tool) or wrap up
 * gracefully. Those paths never invoke this builder.
 *
 * Warm transfer whisper: Twilio's <Dial><Number> supports a `url`
 * attribute that Twilio fetches WHEN THE STAFF ANSWERS, before
 * bridging to the customer. The URL's TwiML is played to the staff
 * only (the customer keeps hearing hold audio / silence). We route
 * this through a tiny whisper endpoint that echoes the requested
 * message via <Say>. The endpoint URL and message are passed in from
 * the handler.
 *
 * Pure — no I/O, no logging. XML-escapes every dynamic value.
 */

import type { RoutingDecision } from "./fallback-logic";

export interface DialBuilderOptions {
  /**
   * Twilio caller ID to present on the outbound leg. Should be the
   * business's Neverr-provisioned number so the staff sees the
   * business's caller ID (not the customer's), matching the existing
   * lead-bridge pattern.
   */
  callerId: string;
  /**
   * URL for the staff-side whisper TwiML. Twilio calls this URL when
   * the staff picks up; the endpoint should return TwiML with a
   * <Say> that reads whisperText. Null → no whisper (silent bridge).
   */
  whisperUrl: string | null;
  /** URL Twilio POSTs when the recording completes. Null → no recording. */
  recordingStatusUrl: string | null;
  /** URL Twilio POSTs at each Dial status event (ringing, in-progress, completed). Null → no status callback. */
  dialStatusUrl: string | null;
  /**
   * Per-call ring timeout in seconds. Twilio default is 30; the routing
   * tool timeout is 45s so this defaults to 30 to leave room for the
   * HTTP round-trip.
   */
  timeoutSecs?: number;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function xmlEscape(input: string): string {
  return input.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Render <Number> child. Includes url= only when whisperUrl is set.
 */
function renderNumber(phone: string, whisperUrl: string | null): string {
  if (whisperUrl) {
    return `<Number url="${xmlEscape(whisperUrl)}">${xmlEscape(phone)}</Number>`;
  }
  return `<Number>${xmlEscape(phone)}</Number>`;
}

/**
 * Render the <Dial> attributes block. Only includes optional
 * attributes when their inputs are non-null.
 */
function renderDialAttrs(opts: DialBuilderOptions): string {
  const parts: string[] = [
    'answerOnBridge="true"',
    `callerId="${xmlEscape(opts.callerId)}"`,
    `timeout="${opts.timeoutSecs ?? 30}"`,
  ];
  if (opts.recordingStatusUrl) {
    parts.push(
      `record="record-from-ringing-dual"`,
      `recordingStatusCallback="${xmlEscape(opts.recordingStatusUrl)}"`,
      `recordingStatusCallbackEvent="completed"`,
      `recordingStatusCallbackMethod="POST"`,
    );
  }
  if (opts.dialStatusUrl) {
    parts.push(
      `action="${xmlEscape(opts.dialStatusUrl)}"`,
      `method="POST"`,
    );
  }
  return parts.join(" ");
}

/**
 * Produce the TwiML string for a routing decision that involves
 * dialing. Throws for non-dial paths so the handler doesn't
 * accidentally call this on after_hours / graceful_hangup.
 */
export function buildDialTwiml(
  decision: RoutingDecision,
  opts: DialBuilderOptions,
): string {
  let numbers: string[];
  switch (decision.path) {
    case "topic_match":
    case "any_on_duty":
      if (decision.staffPhones.length === 0) {
        throw new Error(
          `buildDialTwiml: path=${decision.path} but staffPhones is empty`,
        );
      }
      numbers = decision.staffPhones.map((p) => renderNumber(p, opts.whisperUrl));
      break;
    case "legacy_transfer":
      if (!decision.legacyPhone) {
        throw new Error(
          "buildDialTwiml: path=legacy_transfer but legacyPhone is null",
        );
      }
      // Whisper still applies to legacy — the phone-number owner is
      // still a human answerer who benefits from context.
      numbers = [renderNumber(decision.legacyPhone, opts.whisperUrl)];
      break;
    case "after_hours_callback":
    case "graceful_hangup":
      throw new Error(
        `buildDialTwiml: path=${decision.path} does not dial; handler should not call this builder`,
      );
    default: {
      const _exhaustive: never = decision.path;
      throw new Error(`buildDialTwiml: unknown path ${_exhaustive}`);
    }
  }

  const attrs = renderDialAttrs(opts);
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial ${attrs}>${numbers.join("")}</Dial></Response>`;
}

/**
 * Produce the whisper TwiML that the whisperUrl endpoint should return
 * when Twilio fetches it (i.e. when the staff answers, before bridging).
 * Exposed here so the whisper endpoint (whether it ships in 3.2a or
 * 3.2b) can compose the same string this builder anticipates.
 */
export function buildWhisperTwiml(whisperText: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(whisperText)}</Say></Response>`;
}

/**
 * Compose the default whisper text from a template. Applied at TwiML
 * render time so the topic/business context is baked into the URL query
 * that reaches the whisper endpoint.
 *
 * Template variables: {business_name}, {topic_name}.
 * If no template override is provided, uses the Phase A default:
 *   "Incoming call for {business_name} about {topic_name}. Connecting now."
 */
export function composeWhisperText(opts: {
  businessName: string;
  topicName: string;
  overrideTemplate?: string | null;
}): string {
  const template =
    opts.overrideTemplate?.trim() ||
    "Incoming call for {business_name} about {topic_name}. Connecting now.";
  return template
    .replace(/\{business_name\}/g, opts.businessName)
    .replace(/\{topic_name\}/g, opts.topicName);
}
