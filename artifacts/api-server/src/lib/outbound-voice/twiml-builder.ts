/**
 * Phase 0 Commit 0-D — TwiML builders for the outbound voice routes.
 *
 * Two pure functions, both string-returning, both deterministic given
 * their inputs. Extracted from the route so unit tests don't need
 * supertest — they call the builder directly and string-match.
 *
 * The outbound_automated TwiML connects Twilio's media stream to an
 * ElevenLabs-signed conversation URL. The signed URL is fetched
 * server-side via lib/outbound-voice/elevenlabs-signed-url.ts and
 * passed in here as `signedStreamUrl` — keeping the network I/O out
 * of the builder.
 *
 * Stream parameters carry per-call context to the agent (lead_call_id,
 * business_id, call_objective, plus any campaign-supplied custom
 * context). These land in the `conversation_initiation_client_data`
 * field the agent sees at start of stream.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

export interface BuildOutboundAutomatedTwimlOptions {
  signedStreamUrl: string;
  businessId: string;
  leadCallId: string;
  callObjective: string;
  customContext?: Record<string, string | number | boolean>;
}

/**
 * Build a <Connect><Stream> TwiML that hands the call to ElevenLabs.
 * Stream parameters are XML-escaped to survive special characters in
 * customContext values.
 */
export function buildOutboundAutomatedTwiml(
  opts: BuildOutboundAutomatedTwimlOptions,
): string {
  const params: Record<string, string | number | boolean> = {
    lead_call_id: opts.leadCallId,
    business_id: opts.businessId,
    call_objective: opts.callObjective,
    ...(opts.customContext ?? {}),
  };
  const paramTags = Object.entries(params)
    .map(([name, value]) =>
      `<Parameter name="${xmlEscape(name)}" value="${xmlEscape(String(value))}"/>`,
    )
    .join("");
  return `${XML_HEADER}<Response><Connect><Stream url="${xmlEscape(opts.signedStreamUrl)}">${paramTags}</Stream></Connect></Response>`;
}

/**
 * Fail-closed TwiML — returned whenever we can't safely place the
 * caller on a stream (missing lead_call row, wrong direction, signed
 * URL fetch failed, agent_id missing). Twilio hangs up the call.
 *
 * Critical: this is what the customer hears if anything upstream
 * misconfigures. Phase 1 can replace with a polite voice prompt
 * ("we couldn't connect; please call back") via <Say> + <Hangup/>.
 * Phase 0 keeps it silent.
 */
export function buildHangupTwiml(): string {
  return `${XML_HEADER}<Response><Hangup/></Response>`;
}

/**
 * Empty-Response 2xx body. Used by the AMD + status webhook handlers
 * which don't return TwiML logic to Twilio — they just need a 2xx
 * acknowledgment.
 */
export function buildEmptyResponseTwiml(): string {
  return `${XML_HEADER}<Response/>`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
