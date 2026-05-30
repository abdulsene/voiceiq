import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic SDK singleton — Sprint 5 Alex Phase 1 scaffolding.
 *
 * Boot-time contract:
 *   - ANTHROPIC_API_KEY must be present in the environment when this
 *     module is loaded. Missing → fail-loud at boot rather than silently
 *     no-op'ing and surprising callers at request time.
 *   - Importing this module is the trigger. Until routes/chat.ts is
 *     mounted in routes/index.ts, the api-server boot path does NOT
 *     touch this file, so api-server boots normally even if the key
 *     happens to be unset on a given environment.
 *
 * Never log the API key itself. The init log below is intentionally
 * bare — its presence in the logs is the only signal needed to
 * confirm the lib loaded cleanly.
 */

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error(
    "[anthropic] ANTHROPIC_API_KEY is required to initialize the " +
      "Anthropic client. Refusing to load the chat module without it.",
  );
}

export const anthropic = new Anthropic({ apiKey });

// Locked Phase 1 model + decoding params (per Abdul's Phase 1 brief).
// claude-haiku-4-5 is the cost-optimised tier; 1024 max tokens covers a
// long-form Alex reply with headroom; 0.7 keeps Alex personable without
// drifting off-script. Pull these to a single export so any future
// retune (e.g. switching to Sonnet for Phase 2 voice) is one edit.
export const ALEX_MODEL = "claude-haiku-4-5-20251001";
export const ALEX_MAX_TOKENS = 1024;
export const ALEX_TEMPERATURE = 0.7;

// Prompt-context pruning. The system prompt is always sent verbatim
// (via the `system` parameter, not the messages array). On top of that
// we send at most this many of the most recent user/assistant turns so
// the prompt stays bounded as conversations grow.
export const ALEX_PROMPT_CONTEXT_MAX = 20;

console.log(
  "[anthropic] client initialized, model:",
  ALEX_MODEL,
  "max_tokens:",
  ALEX_MAX_TOKENS,
);
