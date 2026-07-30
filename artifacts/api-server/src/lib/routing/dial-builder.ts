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

import type { RoutingDecision, StaffCandidate } from "./fallback-logic";

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
  /**
   * Phase 3.3 — pass-through the human-readable topic name so the
   * in-app softphone UI can show WHY they're being rung. Emitted as a
   * <Parameter name="topic_name"> child under each <Client>. Ignored
   * for <Number> (custom parameters only work with Twilio Client).
   */
  topicName?: string | null;
  /**
   * Phase 3.4 — pre-dial <Say> line the caller hears BEFORE the ring
   * starts. Without it the caller sits in dead silence for the whole
   * 30s Dial timeout while the browser rings. Null or empty → no
   * <Say> is emitted (preserves the Phase 3.2 shape for tests that
   * don't opt in).
   *
   * Composed by the handler, typically from business_configs
   * .transfer_wait_message with a fallback like "Connecting you now,
   * one moment please."
   */
  waitMessage?: string | null;
  /**
   * Phase 3.4 — ringTone attribute on <Dial>. Twilio's default for a
   * <Client>-only dial is SILENCE (no ringback tone) — the caller
   * hears nothing while the browser is ringing. Setting ringTone
   * makes Twilio synthesize a locale-appropriate ringback: "us" is
   * the North-American double-ring. See
   * https://www.twilio.com/docs/voice/twiml/dial#attributes-ringtone
   * for the enum. Defaults to "us"; pass null to opt out.
   */
  ringTone?: string | null;
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
 * Phase 3.5 — per-candidate whisper URL. Each <Client> / <Number> gets
 * its OWN whisper URL carrying user_id + leg. This is how we attribute
 * the answerer: the whisper by definition fires ONLY on the leg that
 * answered, so whichever whisper handler runs KNOWS which user / leg
 * won the race. Previous code shared one URL across all candidates,
 * so the whisper handler had no way to distinguish who picked up.
 *
 * Twilio does NOT sign whisper GETs (they're fetched from the answering
 * leg's Twilio infra, not the app-signed webhook flow), so the URL
 * carries all identity in the query string itself.
 */
export type WhisperLeg = "client" | "number";

function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${key}=${encodeURIComponent(value)}`;
}

/**
 * Build the per-candidate whisper URL. `whisperUrl` is the caller-
 * supplied base (already carrying `text=...` and any other shared
 * params); we append `user_id` (when known) and `leg`. Preserves the
 * shared-URL behaviour when no leg/user info is available (e.g.
 * legacy_transfer path with no candidate at all).
 */
function whisperUrlFor(
  whisperUrl: string | null,
  ctx: { leg: WhisperLeg; userId?: string | null },
): string | null {
  if (!whisperUrl) return null;
  let url = whisperUrl;
  if (ctx.userId) url = appendQueryParam(url, "user_id", ctx.userId);
  url = appendQueryParam(url, "leg", ctx.leg);
  return url;
}

/**
 * Render <Number> child. Includes url= only when whisperUrl is set.
 */
function renderNumber(
  phone: string,
  whisperUrl: string | null,
  ctx: { leg: WhisperLeg; userId?: string | null },
): string {
  const url = whisperUrlFor(whisperUrl, ctx);
  if (url) {
    return `<Number url="${xmlEscape(url)}">${xmlEscape(phone)}</Number>`;
  }
  return `<Number>${xmlEscape(phone)}</Number>`;
}

/**
 * Phase 3.3 — render <Client> child. Same whisper hook as <Number>
 * (Twilio applies the url= to both leg types identically). Custom
 * <Parameter> children are surfaced to the SDK as CustomParameters on
 * the incoming call event, letting the softphone UI show topic context.
 */
function renderClient(
  identity: string,
  whisperUrl: string | null,
  topicName: string | null | undefined,
  ctx: { leg: WhisperLeg; userId?: string | null },
): string {
  const url = whisperUrlFor(whisperUrl, ctx);
  const attrs = url ? ` url="${xmlEscape(url)}"` : "";
  const params = topicName
    ? `<Parameter name="topic_name" value="${xmlEscape(topicName)}"/>`
    : "";
  return `<Client${attrs}><Identity>${xmlEscape(identity)}</Identity>${params}</Client>`;
}

/**
 * Phase 3.3 — walk one candidate. Emits <Client>, <Number>, or BOTH
 * depending on which fields are populated. Empty when neither is set
 * (caller should have filtered at the query layer, but defensive).
 *
 * Phase 3.5 — each rendered child carries a whisper URL scoped to
 * (candidate.userId, leg), which lets the whisper handler write
 * handled_by_user_id + answered_via correctly.
 */
function renderCandidate(
  c: StaffCandidate,
  whisperUrl: string | null,
  topicName: string | null | undefined,
): string {
  const parts: string[] = [];
  if (c.clientIdentity) {
    parts.push(
      renderClient(c.clientIdentity, whisperUrl, topicName, {
        leg: "client",
        userId: c.userId,
      }),
    );
  }
  if (c.callbackRingNumber) {
    parts.push(
      renderNumber(c.callbackRingNumber, whisperUrl, {
        leg: "number",
        userId: c.userId,
      }),
    );
  }
  return parts.join("");
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
  // Phase 3.4 — default ringback so the caller doesn't sit in silence.
  // ringTone === null (explicitly) suppresses the attribute; undefined
  // (default) emits "us". Twilio accepts au / at / be / br / ca / cl /
  // co / dk / fi / fr / de / gr / hu / il / in / it / jp / mx / nl /
  // no / nz / pt / es / se / uk / us — see Twilio docs.
  const ringTone = opts.ringTone === undefined ? "us" : opts.ringTone;
  if (ringTone) {
    parts.push(`ringTone="${xmlEscape(ringTone)}"`);
  }
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
  let children: string[];
  switch (decision.path) {
    case "topic_match":
    case "any_on_duty": {
      // Phase 3.3: candidates can contribute <Client>, <Number>, or
      // both. Pre-3.3 code required a non-null callbackRingNumber for
      // every candidate — now a candidate with only a live device is
      // valid too. Reject only when NOTHING resolves.
      const rendered = decision.staffCandidates
        .map((c) => renderCandidate(c, opts.whisperUrl, opts.topicName ?? null))
        .filter((s) => s.length > 0);
      if (rendered.length === 0) {
        throw new Error(
          `buildDialTwiml: path=${decision.path} but no dialable candidates (client + number both empty)`,
        );
      }
      children = rendered;
      break;
    }
    case "legacy_transfer":
      if (!decision.legacyPhone) {
        throw new Error(
          "buildDialTwiml: path=legacy_transfer but legacyPhone is null",
        );
      }
      // Whisper still applies to legacy — the phone-number owner is
      // still a human answerer who benefits from context. No user_id
      // on the whisper URL (legacy_transfer has no candidate); the
      // handler will fall back to a Twilio REST child-leg lookup if
      // it needs attribution.
      children = [
        renderNumber(decision.legacyPhone, opts.whisperUrl, { leg: "number" }),
      ];
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
  // Phase 3.4 — pre-dial <Say>: caller hears "Connecting you now…"
  // before the ringback starts. Without this + ringTone, the caller
  // heard 30s of dead air while the browser rang.
  const saySnippet =
    opts.waitMessage && opts.waitMessage.trim()
      ? `<Say>${xmlEscape(opts.waitMessage.trim())}</Say>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${saySnippet}<Dial ${attrs}>${children.join("")}</Dial></Response>`;
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
