/**
 * Claude Haiku call-summary wrapper.
 *
 * Inputs the transcript text (already speaker-labeled by transcription.ts)
 * and returns a 2-3 sentence summary capturing outcome + commitments.
 * Used by the lead-bridge flow's post-transcription step.
 *
 * Why Haiku, not Sonnet:
 *   The output is 2-3 sentences. Sonnet would be overkill at 10× the
 *   price. Haiku 4.5 (claude-haiku-4-5-20251001) is the current
 *   cheapest model in the family and is more than competent for
 *   "summarize this transcript in 2-3 sentences."
 *
 * Why Anthropic SDK, not direct fetch:
 *   The SDK is already in use elsewhere in the codebase (api.ts
 *   imports Anthropic) and adds proper error typing + retry behavior
 *   we'd otherwise reimplement.
 */
import Anthropic from "@anthropic-ai/sdk";

const SUMMARY_MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_MAX_TOKENS = 300;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required for call summary but not set");
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export interface CallSummaryResult {
  summary: string;
  model: string;          // echoed back for audit (used to populate lead_calls.summary_model)
}

/**
 * Summarize a transcribed call. Strict 2-3 sentence cap enforced via the
 * system prompt — the SDK's max_tokens=300 is a hard ceiling. The prompt
 * asks for outcome + commitments only, no embellishment.
 */
export async function summarizeCallTranscript(transcript: string): Promise<CallSummaryResult> {
  if (!transcript || transcript.trim().length === 0) {
    return { summary: "Call connected but no audio was captured.", model: SUMMARY_MODEL };
  }
  const client = getClient();
  const response = await client.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: SUMMARY_MAX_TOKENS,
    system: [
      "You summarize callback phone calls between a business team member (\"Staff\") and a customer (\"Customer\").",
      "Output STRICTLY 2-3 sentences capturing:",
      "  1. What the customer wanted / why the staff member called.",
      "  2. The outcome — was it resolved, or what was promised next.",
      "  3. Any specific commitments (e.g., 'callback by Tuesday', 'send quote', 'visit Friday').",
      "Do NOT embellish. Do NOT speculate. Do NOT add headers or bullet points.",
      "If the transcript is empty or incoherent, say 'Call connected but content unclear.'",
    ].join(" "),
    messages: [
      {
        role: "user",
        content: `Summarize this call transcript in 2-3 sentences:\n\n${transcript}`,
      },
    ],
  });

  // SDK returns content as an array of blocks. For text-only response
  // we expect one text block.
  const textBlock = response.content.find((b) => b.type === "text");
  const summary = textBlock && textBlock.type === "text"
    ? textBlock.text.trim()
    : "Call summary unavailable.";

  return { summary, model: SUMMARY_MODEL };
}
