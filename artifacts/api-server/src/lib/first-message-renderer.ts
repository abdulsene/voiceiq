/**
 * Sprint 4 — pure renderers for the literal opening line ElevenLabs
 * speaks on every inbound call (conversation_config.agent.first_message).
 *
 * Two renderers, two audiences:
 *   - renderFirstMessage: production agents (customer signup,
 *     /onboard, admin sales-demo provisioning, the agents.ts default
 *     fallback). Universal recording-disclosure greeting; no
 *     per-industry tone variation.
 *   - renderPreviewFirstMessage: short-TTL preview/demo agents on the
 *     marketing site. Preserves the existing marketing copy but
 *     prepends the disclosure sentence so prospects also hear it.
 *
 * Why universal disclosure: address-string parsing for state
 * detection is unreliable ("Md" vs "baltimore, MD"), two-party-consent
 * state laws vary (MD, CA, IL, MA, PA, WA, FL, CT, DE, MT, NH, NV at
 * time of writing), and disclosure is a cultural norm everywhere. The
 * ~4-second audio cost is acceptable as a floor for every customer.
 *
 * Why a dedicated file (not folded into prompt-renderer.ts):
 * first_message is a separate ElevenLabs config field with its own
 * update path and edit lifecycle. Mixing the two renderers would
 * couple unrelated concerns and obscure call sites' intent.
 *
 * Pure functions: no I/O, no env reads, no side effects. Callers own
 * persistence and the ElevenLabs PATCH (via lib/elevenlabs-agent.ts
 * updateAgentFirstMessage).
 */

/**
 * Production greeting. Every customer-facing agent uses this exact
 * template so the recording disclosure is a non-negotiable floor.
 * Drops the "Hello," prefix the legacy greetings.ts used — keeps the
 * tone professional and lets the sentence flow into the disclosure
 * without an awkward conjunction.
 *
 * Throws on empty/missing business_name because the alternative is
 * rendering an agent that says "Thank you for calling ." — better to
 * fail loud at create-time than silently ship a broken greeting.
 */
export function renderFirstMessage(config: {
  business_name: string;
}): string {
  const name = (config.business_name ?? "").trim();
  if (!name) {
    throw new Error("renderFirstMessage: business_name is required");
  }
  return `Thank you for calling ${name}. This call may be recorded for quality and training purposes. How can I help you today?`;
}

/**
 * Preview/demo greeting for short-TTL marketing-site agents. The
 * existing copy ("Hi! This is a live preview...") stays — prospects
 * expect that framing — but we prepend the disclosure sentence so
 * even ad-hoc test callers from two-party-consent states get notice
 * before the marketing pitch.
 *
 * English-only by design: localized previews used to live at
 * api.ts:1890 (FIRST_MESSAGES map across en/es/fr/pt/zh/ar/de). That
 * map is being removed in this commit; non-English previews will now
 * also open in English. If localized previews come back later, this
 * renderer needs a `language` param and per-language disclosure copy.
 */
export function renderPreviewFirstMessage(config: {
  industry_name: string;
}): string {
  const name = (config.industry_name ?? "").trim();
  if (!name) {
    throw new Error("renderPreviewFirstMessage: industry_name is required");
  }
  return `This call may be recorded for quality and training purposes. Hi! This is a live preview of your ${name} AI receptionist. Ask me anything to see how I'd handle calls for your business.`;
}
