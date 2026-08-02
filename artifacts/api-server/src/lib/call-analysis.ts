/**
 * Phase 4.5 — post-call transcript analysis via Claude Haiku.
 *
 * Replaces the pre-4.5 inline `analyzeWithClaude` in routes/api.ts
 * which pointed at `claude-sonnet-4-20250514` — a model that
 * silently stopped responding around 2026-06-13, causing seven
 * weeks of zero sentiment/summary/intent coverage in production
 * while nobody noticed because the old handler did
 * `catch (err) { return null; }` and every caller no-op'd on null.
 *
 * Design principles this file enforces:
 *
 *   1. USE THE CURRENT MODEL. `claude-haiku-4-5-20251001` is the
 *      internal standard already used by lib/call-summary.ts for
 *      lead-bridge transcripts. Same model, same client, same
 *      failure semantics. When the CLAUDE.md model-family list
 *      updates, update BOTH places together.
 *
 *   2. FAIL LOUD, NOT SILENT. This function THROWS on API failure;
 *      the caller MUST catch and Sentry.captureException with call
 *      context. The previous swallow-and-return-null was the exact
 *      pattern that hid the 7-week stoppage — never again.
 *
 *   3. CONSTRAIN OUTPUT VIA ENUMS. Free-text emotion values will
 *      fragment (`"anger"` vs `"frustrated"` vs `"pissed off"`)
 *      and be useless for aggregation. Every enum below is
 *      documented in the prompt AND validated in code after the
 *      model responds. Unknown values are coerced to the enum's
 *      neutral default rather than passed through.
 *
 *   4. MACHINE / HUMAN COLUMN SEPARATION. `satisfaction_inferred`
 *      (this file) writes into a separate column from
 *      `satisfaction_rating` (survey ground truth). Same discipline
 *      as Phase 3.12 call_outcome vs disposition. When both are set,
 *      disagreement is the reporting signal — never overwrite.
 */

import Anthropic from "@anthropic-ai/sdk";

// Keep in sync with lib/call-summary.ts and CLAUDE.md model-family
// list. Haiku 4.5 is the cheapest current-generation model and is
// more than capable of structured JSON output from a short
// transcript. Sonnet-scale reasoning is not required here.
const ANALYSIS_MODEL = "claude-haiku-4-5-20251001";

// 2048 tokens is enough for the biggest fixture output we've seen
// (summary + 5 action items + full 20-turn emotion journey ≈ 800
// tokens). Cap prevents runaway completions.
const ANALYSIS_MAX_TOKENS = 2048;

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for call analysis but not set",
    );
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

/**
 * Enumerations — the model is told to pick from these and each is
 * validated in code before we write to the DB. Anything unknown
 * gets coerced to the neutral default listed with each enum.
 */

export const SENTIMENT_VALUES = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENT_VALUES)[number];

/**
 * 1..5 integer. 1 = very negative, 3 = neutral, 5 = very positive.
 * Column: sentiment_score. Written for the FIRST time by this file
 * — the pre-4.5 job never populated it despite the column being
 * present since Sprint 3.
 */
export type SentimentScore = 1 | 2 | 3 | 4 | 5;

/**
 * Eight-slot emotional space. Chosen to be non-overlapping enough
 * that aggregation is meaningful, small enough that a model can
 * pick one reliably. Neutral default: "indifferent" — the correct
 * label when nothing else fits.
 */
export const EMOTION_VALUES = [
  "satisfied",     // pleased with the outcome, warm tone
  "frustrated",    // repeated failed attempts, exasperation
  "angry",         // hostile, hostile language, escalation asks
  "confused",      // asking for clarification, uncertain
  "anxious",       // worried, time-pressured, distressed
  "grateful",      // thankful, explicit appreciation
  "disappointed",  // expected more, resigned
  "indifferent",   // matter-of-fact, no emotional load
] as const;
export type Emotion = (typeof EMOTION_VALUES)[number];

export const URGENCY_VALUES = ["low", "normal", "high", "critical"] as const;
export type Urgency = (typeof URGENCY_VALUES)[number];

/**
 * 1..5 integer. AI's read of how satisfied the caller was, distinct
 * from any survey response. Column: satisfaction_inferred (added
 * in migration 048). MUST NOT be written to satisfaction_rating.
 */
export type SatisfactionInferred = 1 | 2 | 3 | 4 | 5;

/**
 * Emotion journey — a per-turn arc. Small object per turn so we can
 * plot "started confused → grew frustrated → ended angry" as a mini
 * timeline on the call detail page. Stored as JSONB in
 * calls.emotion_journey.
 *
 * Kept intentionally simple: turn index + emotion tag. Not adding
 * a numeric score per turn — the aggregate sentiment_score already
 * captures magnitude; the journey captures the shape.
 */
export interface EmotionJourneyTurn {
  turn: number;
  emotion: Emotion;
}

/**
 * Action-item shape. `priority` constrained to the same three-slot
 * enum the old code used (kept identical so downstream consumers
 * — email templates, sequences enrollment — don't need to change).
 */
export const PRIORITY_VALUES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITY_VALUES)[number];

export interface ActionItem {
  task: string;
  priority: Priority;
  assignTo: string | null;
}

/**
 * Call outcome enum — kept in shape parity with pre-4.5 so the
 * lead-scoring logic + webhook payload + email templates that
 * conditional on this string don't need to change.
 */
export const CALL_OUTCOME_VALUES = [
  "resolved",
  "transferred",
  "voicemail",
  "callback_requested",
  "appointment_booked",
  "lead_captured",
  "unresolved",
] as const;
export type CallOutcome = (typeof CALL_OUTCOME_VALUES)[number];

/**
 * Full analysis result. Every field is required — the model MUST
 * populate all of them. Missing / unknown enum values are coerced
 * to the documented default so the caller never has to worry about
 * partial output.
 */
export interface CallAnalysis {
  summary: string;
  callerName: string;
  callerIntent: string;
  sentiment: Sentiment;
  sentimentScore: SentimentScore;
  dominantEmotion: Emotion;
  emotionJourney: EmotionJourneyTurn[];
  urgency: Urgency;
  satisfactionInferred: SatisfactionInferred;
  actionItems: ActionItem[];
  followUpRequired: boolean;
  callOutcome: CallOutcome;
}

/**
 * Build the analysis prompt. Enums documented inline so the model
 * knows the exact vocabulary. Kept as a function (not a string
 * constant) so tests can snapshot the exact text sent to the API
 * without importing the private const.
 */
export function buildAnalysisPrompt(transcript: string, businessId: string): string {
  return `Analyze the following phone call transcript for the business "${businessId}".

Transcript:
${transcript}

Return a JSON object matching this exact schema. Every field is REQUIRED. Enum fields MUST use one of the listed values exactly — do not invent new values.

{
  "summary": string,                              // 2-3 sentence summary of what happened and what the caller needs
  "callerName": string,                           // caller's name if mentioned, otherwise "Unknown"
  "callerIntent": string,                         // 1-sentence "what the caller wanted"
  "sentiment": "positive" | "neutral" | "negative",
  "sentimentScore": integer 1-5,                  // 1 = very negative, 3 = neutral, 5 = very positive
  "dominantEmotion": one of ${JSON.stringify(EMOTION_VALUES)},
  "emotionJourney": [                             // array, one entry per meaningful turn (~3-8 entries typical)
    { "turn": integer starting at 1, "emotion": one of the emotion enum values }
  ],
  "urgency": "low" | "normal" | "high" | "critical",
  "satisfactionInferred": integer 1-5,            // your read of how satisfied the CALLER was leaving the call
  "actionItems": [                                // 0-5 items typical
    { "task": string, "priority": "high" | "medium" | "low", "assignTo": string or null }
  ],
  "followUpRequired": boolean,
  "callOutcome": one of ${JSON.stringify(CALL_OUTCOME_VALUES)}
}

Return ONLY valid JSON. No prose before or after, no code fences.`;
}

/**
 * Validate + coerce a raw model response into a CallAnalysis. Any
 * enum value outside the documented set is coerced to the neutral
 * default rather than passed through — a bad enum in the DB would
 * fragment aggregation forever, coercion is loud (Sentry-loggable
 * from the caller) but recoverable.
 *
 * Returns { analysis, coercions } where `coercions` is a list of
 * `"<field>: got=X, coerced=Y"` strings the caller should log if
 * non-empty. Empty means the model behaved.
 */
export function validateAnalysis(raw: unknown): {
  analysis: CallAnalysis;
  coercions: string[];
} {
  const coercions: string[] = [];
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const coerceEnum = <T extends string>(
    field: string,
    got: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    if (typeof got === "string" && (allowed as readonly string[]).includes(got)) {
      return got as T;
    }
    coercions.push(`${field}: got=${JSON.stringify(got)}, coerced=${fallback}`);
    return fallback;
  };

  const coerceInt = (field: string, got: unknown, lo: number, hi: number, fallback: number): number => {
    const n = typeof got === "number" ? got : typeof got === "string" ? Number(got) : NaN;
    if (Number.isFinite(n) && n >= lo && n <= hi && Number.isInteger(n)) return n;
    coercions.push(`${field}: got=${JSON.stringify(got)}, coerced=${fallback}`);
    return fallback;
  };

  const summary = typeof src.summary === "string" ? src.summary : "";
  const callerName = typeof src.callerName === "string" ? src.callerName : "Unknown";
  const callerIntent = typeof src.callerIntent === "string" ? src.callerIntent : "";

  const sentiment = coerceEnum("sentiment", src.sentiment, SENTIMENT_VALUES, "neutral");
  const sentimentScore = coerceInt("sentimentScore", src.sentimentScore, 1, 5, 3) as SentimentScore;
  const dominantEmotion = coerceEnum("dominantEmotion", src.dominantEmotion, EMOTION_VALUES, "indifferent");
  const urgency = coerceEnum("urgency", src.urgency, URGENCY_VALUES, "normal");
  const satisfactionInferred = coerceInt("satisfactionInferred", src.satisfactionInferred, 1, 5, 3) as SatisfactionInferred;
  const callOutcome = coerceEnum("callOutcome", src.callOutcome, CALL_OUTCOME_VALUES, "unresolved");

  const followUpRequired = typeof src.followUpRequired === "boolean" ? src.followUpRequired : false;

  const emotionJourneyRaw = Array.isArray(src.emotionJourney) ? src.emotionJourney : [];
  const emotionJourney: EmotionJourneyTurn[] = emotionJourneyRaw.slice(0, 30).map((entry, i) => {
    const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const turnRaw = e.turn;
    const turn = typeof turnRaw === "number" && Number.isFinite(turnRaw) ? Math.floor(turnRaw) : i + 1;
    const emotion = coerceEnum(`emotionJourney[${i}].emotion`, e.emotion, EMOTION_VALUES, "indifferent");
    return { turn, emotion };
  });

  const actionItemsRaw = Array.isArray(src.actionItems) ? src.actionItems : [];
  const actionItems: ActionItem[] = actionItemsRaw.slice(0, 20).map((entry, i) => {
    const a = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const task = typeof a.task === "string" ? a.task : typeof (a as any).description === "string" ? (a as any).description : "";
    const priority = coerceEnum(`actionItems[${i}].priority`, a.priority, PRIORITY_VALUES, "medium");
    const assignToRaw = a.assignTo ?? (a as any).assign_to ?? null;
    const assignTo = typeof assignToRaw === "string" && assignToRaw.trim() ? assignToRaw : null;
    return { task, priority, assignTo };
  }).filter((a) => a.task.trim().length > 0);

  return {
    analysis: {
      summary,
      callerName,
      callerIntent,
      sentiment,
      sentimentScore,
      dominantEmotion,
      emotionJourney,
      urgency,
      satisfactionInferred,
      actionItems,
      followUpRequired,
      callOutcome,
    },
    coercions,
  };
}

/**
 * Analyse a call transcript. Throws on API failure or non-JSON
 * response — the caller MUST catch and Sentry-log with context.
 * See the file header for why silent-null-return is banned.
 *
 * Returns the validated + coerced CallAnalysis plus the coercion
 * list. If `coercions.length > 0` the caller should log it as a
 * warning breadcrumb (the analysis is still safe to persist).
 */
export async function analyzeCallTranscript(
  transcript: string,
  businessId: string,
): Promise<{ analysis: CallAnalysis; coercions: string[]; model: string }> {
  if (!transcript || transcript.trim().length === 0) {
    throw new Error("analyzeCallTranscript: transcript is empty");
  }

  const client = getClient();
  const prompt = buildAnalysisPrompt(transcript, businessId);

  const response = await client.messages.create({
    model: ANALYSIS_MODEL,
    max_tokens: ANALYSIS_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });

  const block = response.content[0];
  const rawText = block && block.type === "text" ? block.text : "";
  const trimmed = rawText.trim();

  // Defensive: model occasionally wraps in a code fence even when
  // told not to. Strip if present. If parsing still fails we throw
  // with the raw text (truncated) so the Sentry breadcrumb is
  // actionable.
  const cleaned = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e: any) {
    throw new Error(
      `analyzeCallTranscript: model returned non-JSON — first 200 chars: ${cleaned.slice(0, 200)}`,
    );
  }

  const { analysis, coercions } = validateAnalysis(parsed);
  return { analysis, coercions, model: ANALYSIS_MODEL };
}

/**
 * Exported so ops can query "what model are we using?" without
 * importing the private const. Referenced in tests + reporting.
 */
export function getAnalysisModel(): string {
  return ANALYSIS_MODEL;
}

// ── Phase 4.6: minimum viable transcript gate ────────────────────────

/**
 * Reason for skipping analysis. Kept as string literal union so both
 * the DB column (CHECK constraint values 'empty' | 'too_short') and
 * the code refer to the same vocabulary. See migration 049.
 */
export const SKIP_REASONS = ["empty", "too_short"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/**
 * Minimum caller turns required to run analysis.
 *
 * Chosen from the length distribution over 33 real prod inbound
 * calls in production (Phase 4.6 audit):
 *   0 caller turns: 18 rows (54%) — hangups
 *   1 caller turn:   3 rows        — one utterance then hangup
 *   2+ caller turns: 12 rows       — actual conversations
 *
 * 2 is the natural cliff. Below 2 the model has no exchange to
 * reason about and Haiku falls back to mid-scale defaults
 * (sentiment=neutral, sentiment_score=3, dominant_emotion=indifferent,
 * satisfaction_inferred=3). Those fabricated defaults are what
 * inflated the aggregate satisfaction average from 2.43 to 2.72 in
 * the Phase 4.5 backfill. Never again.
 */
export const MIN_CALLER_TURNS = 2;

/**
 * Detect caller turns in a transcript, tolerant of both known
 * production formats:
 *   "Caller: ..."    — the format written by api.ts:788 (ElevenLabs
 *                      post-call webhook mapper)
 *   "[caller]: ..."  — the ElevenLabs streaming format sometimes
 *                      captured when the connection drops mid-call
 *
 * Case-insensitive. Whole-line prefix required (^ anchor) so
 * "the Caller: X" inside a message body doesn't false-match.
 */
const CALLER_TURN_RE = /^(?:caller|\[caller\]):/gim;

export function countCallerTurns(transcript: string): number {
  return (transcript.match(CALLER_TURN_RE) ?? []).length;
}

/**
 * Should this transcript be analyzed? Returns the skip reason if
 * it should NOT be, or null if analysis should proceed.
 *
 * MUST be called by both the live analyzer (runAnalysisForCall in
 * routes/api.ts) AND the backfill script before invoking Haiku.
 * Calling one without the other is the exact regression this
 * function exists to prevent.
 */
export function shouldSkipAnalysis(transcript: string | null | undefined): SkipReason | null {
  if (!transcript || transcript.trim().length === 0) return "empty";
  if (countCallerTurns(transcript) < MIN_CALLER_TURNS) return "too_short";
  return null;
}
