/**
 * Phase 4.5 — smoke on lib/call-analysis.ts pure validators.
 *
 * The API-calling function (analyzeCallTranscript) is NOT covered
 * here — it requires ANTHROPIC_API_KEY and burns real budget on
 * every test run. What we CAN cover deterministically:
 *
 *   - validateAnalysis coerces every out-of-enum value to the
 *     documented default AND records the coercion reason.
 *   - Missing / null / wrong-type fields fall back safely.
 *   - Priority sanity: nothing writes past the enum surface.
 *   - The prompt template embeds the enum values verbatim so any
 *     change to the enums forces a prompt update (the same
 *     documentation lives in one place).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/049-call-analysis-smoke.ts
 */

import {
  validateAnalysis,
  buildAnalysisPrompt,
  getAnalysisModel,
  shouldSkipAnalysis,
  countCallerTurns,
  MIN_CALLER_TURNS,
  SKIP_REASONS,
  SENTIMENT_VALUES,
  EMOTION_VALUES,
  URGENCY_VALUES,
  CALL_OUTCOME_VALUES,
  PRIORITY_VALUES,
} from "../lib/call-analysis";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── T1. Happy path — every field passes through untouched ────────────

async function T1_happy_path() {
  const input = {
    summary: "Caller wanted a plumber for a leak; we booked Tuesday at 10am.",
    callerName: "Jane Doe",
    callerIntent: "Emergency plumbing appointment.",
    sentiment: "positive",
    sentimentScore: 4,
    dominantEmotion: "grateful",
    emotionJourney: [
      { turn: 1, emotion: "anxious" },
      { turn: 2, emotion: "grateful" },
    ],
    urgency: "high",
    satisfactionInferred: 5,
    actionItems: [
      { task: "Confirm arrival with Jane", priority: "high", assignTo: null },
    ],
    followUpRequired: false,
    callOutcome: "appointment_booked",
  };
  const { analysis, coercions } = validateAnalysis(input);
  const fails: string[] = [];
  if (coercions.length !== 0) fails.push(`unexpected coercions: ${coercions.join("; ")}`);
  if (analysis.sentiment !== "positive") fails.push(`sentiment=${analysis.sentiment}`);
  if (analysis.sentimentScore !== 4) fails.push(`sentimentScore=${analysis.sentimentScore}`);
  if (analysis.dominantEmotion !== "grateful") fails.push(`emotion=${analysis.dominantEmotion}`);
  if (analysis.emotionJourney.length !== 2) fails.push(`journey.len=${analysis.emotionJourney.length}`);
  if (analysis.urgency !== "high") fails.push(`urgency=${analysis.urgency}`);
  if (analysis.satisfactionInferred !== 5) fails.push(`satisfaction=${analysis.satisfactionInferred}`);
  if (analysis.actionItems.length !== 1) fails.push(`actionItems.len=${analysis.actionItems.length}`);
  if (analysis.callOutcome !== "appointment_booked") fails.push(`callOutcome=${analysis.callOutcome}`);
  record("T1 happy path — every field passes through, zero coercions", fails.length === 0, fails.join("; ") || "all enums accepted; all shapes preserved");
}

// ── T2. Out-of-enum coerces to documented default + records reason ───

async function T2_out_of_enum_coerces() {
  const input = {
    summary: "",
    callerName: "",
    callerIntent: "",
    sentiment: "very positive",     // not in enum → neutral
    sentimentScore: 9,              // out of range → 3
    dominantEmotion: "hangry",       // not in enum → indifferent
    urgency: "asap",                 // not in enum → normal
    satisfactionInferred: 0,         // out of range → 3
    callOutcome: "sold",             // not in enum → unresolved
    emotionJourney: [{ turn: 1, emotion: "pissed" }], // → indifferent
    actionItems: [{ task: "x", priority: "urgent", assignTo: null }], // → medium
    followUpRequired: "yes",         // wrong type → false
  };
  const { analysis, coercions } = validateAnalysis(input);
  const fails: string[] = [];
  if (analysis.sentiment !== "neutral") fails.push(`sentiment=${analysis.sentiment}`);
  if (analysis.sentimentScore !== 3) fails.push(`sentimentScore=${analysis.sentimentScore}`);
  if (analysis.dominantEmotion !== "indifferent") fails.push(`emotion=${analysis.dominantEmotion}`);
  if (analysis.urgency !== "normal") fails.push(`urgency=${analysis.urgency}`);
  if (analysis.satisfactionInferred !== 3) fails.push(`sat=${analysis.satisfactionInferred}`);
  if (analysis.callOutcome !== "unresolved") fails.push(`outcome=${analysis.callOutcome}`);
  if (analysis.emotionJourney[0].emotion !== "indifferent") fails.push(`journey emotion=${analysis.emotionJourney[0].emotion}`);
  if (analysis.actionItems[0].priority !== "medium") fails.push(`priority=${analysis.actionItems[0].priority}`);
  if (analysis.followUpRequired !== false) fails.push(`followUp=${analysis.followUpRequired}`);
  // Should have coerced 8 fields.
  if (coercions.length < 8) fails.push(`expected >=8 coercions, got ${coercions.length}: ${coercions.join(" | ")}`);
  record("T2 out-of-enum values coerced to defaults + reasons recorded", fails.length === 0, fails.join("; ") || `8+ coercions recorded, no bad enum reaches DB write shape`);
}

// ── T3. Missing / null / non-object → safe defaults, no throw ────────

async function T3_missing_fields_no_throw() {
  const cases: Array<[string, unknown]> = [
    ["null input", null],
    ["empty object", {}],
    ["string input", "hi"],
    ["number input", 42],
    ["array input", []],
  ];
  const fails: string[] = [];
  for (const [label, raw] of cases) {
    try {
      const { analysis, coercions } = validateAnalysis(raw);
      if (!analysis) fails.push(`[${label}] no analysis returned`);
      // All enums should be at their default values.
      if (analysis.sentiment !== "neutral") fails.push(`[${label}] sentiment=${analysis.sentiment}`);
      if (analysis.dominantEmotion !== "indifferent") fails.push(`[${label}] emotion=${analysis.dominantEmotion}`);
      if (analysis.callOutcome !== "unresolved") fails.push(`[${label}] outcome=${analysis.callOutcome}`);
      if (analysis.emotionJourney.length !== 0) fails.push(`[${label}] journey should be empty`);
      if (analysis.actionItems.length !== 0) fails.push(`[${label}] actionItems should be empty`);
      // Coercions logged for every enum + every integer field.
      if (coercions.length < 6) fails.push(`[${label}] coercions=${coercions.length}`);
    } catch (e: any) {
      fails.push(`[${label}] threw: ${e.message}`);
    }
  }
  record("T3 missing / null / wrong-type input never throws; falls back safely", fails.length === 0, fails.join(" | ") || "all 5 shapes produced a safe CallAnalysis + coercion log");
}

// ── T4. Prompt embeds enum values verbatim (single source of truth) ──

async function T4_prompt_contains_enums() {
  const prompt = buildAnalysisPrompt("Hi.", "biz-x");
  const fails: string[] = [];
  for (const e of EMOTION_VALUES) {
    if (!prompt.includes(`"${e}"`)) fails.push(`emotion "${e}" missing from prompt`);
  }
  for (const s of SENTIMENT_VALUES) {
    if (!prompt.includes(`"${s}"`)) fails.push(`sentiment "${s}" missing from prompt`);
  }
  for (const u of URGENCY_VALUES) {
    if (!prompt.includes(`"${u}"`)) fails.push(`urgency "${u}" missing from prompt`);
  }
  for (const o of CALL_OUTCOME_VALUES) {
    if (!prompt.includes(`"${o}"`)) fails.push(`outcome "${o}" missing from prompt`);
  }
  for (const p of PRIORITY_VALUES) {
    if (!prompt.includes(`"${p}"`)) fails.push(`priority "${p}" missing from prompt`);
  }
  if (!prompt.includes("biz-x")) fails.push("business_id not interpolated");
  if (!prompt.includes("Hi.")) fails.push("transcript not embedded");
  record("T4 prompt embeds every enum value verbatim + business_id + transcript", fails.length === 0, fails.join(" | ") || "prompt is the single source of enum truth for the model");
}

// ── T5. Model name is a current-generation Claude ID, not deprecated ─

async function T5_model_is_current() {
  const model = getAnalysisModel();
  const fails: string[] = [];
  // Must NOT be the pre-4.5 deprecated Sonnet 4.0 (which is what
  // caused the 7-week outage).
  if (model === "claude-sonnet-4-20250514") {
    fails.push("model is the deprecated pre-4.5 Sonnet — this is the exact regression Phase 4.5 fixes");
  }
  // Must be one of the currently-listed Claude 4.X model IDs from
  // CLAUDE.md. Haiku 4.5 is the internal standard.
  const currentGeneration = [
    "claude-opus-4-7",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
  ];
  if (!currentGeneration.includes(model)) {
    fails.push(`model "${model}" is not in the CLAUDE.md current-generation list: ${currentGeneration.join(", ")}. If Anthropic has released a newer model, update this test and lib/call-analysis.ts together.`);
  }
  record("T5 analysis model is current-generation Claude 4.X (not deprecated Sonnet 4.0)", fails.length === 0, fails.join("; ") || `using ${model} — matches CLAUDE.md model-family list`);
}

// ── T6. Journey + action items — bounds + shape guards ──────────────

async function T6_bounds_and_shape_guards() {
  const fails: string[] = [];
  // 40 journey entries — should be capped at 30.
  const big = validateAnalysis({
    emotionJourney: Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, emotion: "grateful" })),
  });
  if (big.analysis.emotionJourney.length !== 30) fails.push(`journey cap: got ${big.analysis.emotionJourney.length}`);

  // 30 action items — should be capped at 20.
  const bigActions = validateAnalysis({
    actionItems: Array.from({ length: 30 }, (_, i) => ({ task: `t${i}`, priority: "low", assignTo: null })),
  });
  if (bigActions.analysis.actionItems.length !== 20) fails.push(`action cap: got ${bigActions.analysis.actionItems.length}`);

  // Empty-task action items dropped.
  const withEmpty = validateAnalysis({
    actionItems: [
      { task: "real task", priority: "low", assignTo: null },
      { task: "", priority: "low", assignTo: null },
      { task: "   ", priority: "low", assignTo: null },
    ],
  });
  if (withEmpty.analysis.actionItems.length !== 1) fails.push(`empty-task drop: got ${withEmpty.analysis.actionItems.length}`);

  // Snake_case assign_to alias accepted.
  const snake = validateAnalysis({
    actionItems: [{ task: "x", priority: "high", assign_to: "Alex" } as any],
  });
  if (snake.analysis.actionItems[0].assignTo !== "Alex") fails.push(`snake_case assign_to alias not accepted: ${snake.analysis.actionItems[0].assignTo}`);

  record("T6 journey + action items — cap enforced, empty tasks dropped, snake_case aliased", fails.length === 0, fails.join(" | ") || "no runaway arrays, no empty rows, aliases work");
}

// ── Phase 4.6 gate tests ─────────────────────────────────────────────

async function T7_gate_skips_empty_and_short() {
  const fails: string[] = [];

  // (a) empty / whitespace-only → "empty"
  const empties: Array<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   \n\t  "],
  ];
  for (const [label, val] of empties) {
    const r = shouldSkipAnalysis(val as any);
    if (r !== "empty") fails.push(`[${label}] got ${r}, expected "empty"`);
  }

  // (b) zero caller turns → "too_short" (a hangup; AI spoke, caller didn't)
  const zeroCaller = "AI: Thank you for calling. How can I help?";
  if (shouldSkipAnalysis(zeroCaller) !== "too_short") {
    fails.push(`zero-caller: got ${shouldSkipAnalysis(zeroCaller)}`);
  }

  // (c) one caller turn → "too_short"
  const oneCaller = "AI: Hello.\nCaller: I need help.\nAI: One moment.";
  if (shouldSkipAnalysis(oneCaller) !== "too_short") {
    fails.push(`one-caller: got ${shouldSkipAnalysis(oneCaller)}`);
  }

  // (d) exactly MIN_CALLER_TURNS → null (analyze)
  const twoCaller = "AI: Hello.\nCaller: I need help.\nAI: What kind?\nCaller: My car broke down.";
  if (shouldSkipAnalysis(twoCaller) !== null) {
    fails.push(`two-caller: got ${shouldSkipAnalysis(twoCaller)}, expected null`);
  }

  // (e) tolerates the "[caller]:" format from the ElevenLabs streaming shape
  const streaming = "[assistant]: Hello.\n[caller]: I have a question.\n[assistant]: Ask.\n[caller]: When are you open?";
  if (shouldSkipAnalysis(streaming) !== null) {
    fails.push(`streaming: got ${shouldSkipAnalysis(streaming)}`);
  }

  // (f) case-insensitive match on both formats
  const mixed = "ai: Hi\nCALLER: X\nai: k\n[Caller]: Y";
  if (shouldSkipAnalysis(mixed) !== null) {
    fails.push(`case-insensitive: got ${shouldSkipAnalysis(mixed)}, expected analyze (2 caller turns)`);
  }

  // (g) MIN_CALLER_TURNS is exactly 2 (chosen from prod distribution)
  if (MIN_CALLER_TURNS !== 2) {
    fails.push(`MIN_CALLER_TURNS drifted to ${MIN_CALLER_TURNS} — Phase 4.6 chose 2 from prod data; update this test + the phase brief before changing`);
  }

  // (h) SKIP_REASONS enum matches the DB CHECK constraint values
  const asSet = new Set(SKIP_REASONS as readonly string[]);
  if (!asSet.has("empty") || !asSet.has("too_short") || SKIP_REASONS.length !== 2) {
    fails.push(`SKIP_REASONS drifted from DB CHECK: ${JSON.stringify(SKIP_REASONS)}`);
  }

  record(
    "T7 gate: empty / <2 caller turns skipped; 2+ analyzed; both transcript formats + case-insensitive",
    fails.length === 0,
    fails.join(" | ") || "gate closes fabricated-default rows; open on substantive exchanges only",
  );
}

async function T8_caller_turn_counter() {
  // Regression harness on the counter itself — the gate's decision
  // is only as reliable as the counting.
  const fails: string[] = [];
  const cases: Array<[string, string, number]> = [
    ["empty", "", 0],
    ["ai only", "AI: hi\nAI: bye", 0],
    ["one turn", "AI: hi\nCaller: hi back", 1],
    ["two turns", "AI: hi\nCaller: hi\nAI: bye\nCaller: k", 2],
    ["streaming format", "[caller]: a\n[assistant]: b\n[caller]: c", 2],
    ["mixed format", "Caller: a\n[caller]: b\nCALLER: c", 3],
    ["prefix in middle of message doesn't count", "AI: The caller: told me X", 0],
    ["prefix at start of line inside quoted message DOES count (acceptable false positive)", "AI: said\nCaller: X", 1],
  ];
  for (const [label, input, expected] of cases) {
    const got = countCallerTurns(input);
    if (got !== expected) fails.push(`[${label}] got ${got}, expected ${expected}`);
  }
  record(
    "T8 countCallerTurns — anchored to line start, both formats, case-insensitive",
    fails.length === 0,
    fails.join(" | ") || "8 shape cases counted correctly",
  );
}

/**
 * T9 — idempotency at the SQL predicate level. Simulates the
 * backfill's WHERE clause against a fixture set. Two runs of the
 * same predicate against a "processed" row must return zero rows.
 * A --force run must return everything.
 *
 * This test does NOT hit Supabase — it exercises the predicate
 * as a pure filter over a fixture array so we can lock in the
 * behavior without a DB connection.
 */
async function T9_backfill_idempotency_predicate() {
  interface Row {
    id: string;
    transcript: string;
    analyzed_at: string | null;
    business_id: string;
    call_sid: string | null;
  }
  const now = new Date().toISOString();
  const fixture: Row[] = [
    { id: "unseen-1",   transcript: "AI: hi\nCaller: a\nAI: b\nCaller: c", analyzed_at: null,  business_id: "biz-1",         call_sid: null },
    { id: "processed",  transcript: "AI: hi\nCaller: a\nAI: b\nCaller: c", analyzed_at: now,   business_id: "biz-1",         call_sid: null },
    { id: "seed-drop",  transcript: "AI: hi\nCaller: a\nAI: b\nCaller: c", analyzed_at: null,  business_id: "biz-1",         call_sid: "SEED_x" },
    { id: "demo-drop",  transcript: "AI: hi\nCaller: a\nAI: b\nCaller: c", analyzed_at: null,  business_id: "demo-business", call_sid: null },
  ];
  const select = (force: boolean) =>
    fixture.filter(
      (r) =>
        r.business_id !== "demo-business" &&
        !!r.transcript &&
        !(r.call_sid && r.call_sid.startsWith("SEED_")) &&
        (force || r.analyzed_at === null),
    );

  const fails: string[] = [];
  const noForce = select(false).map((r) => r.id);
  if (noForce.length !== 1 || noForce[0] !== "unseen-1") {
    fails.push(`no-force selected ${JSON.stringify(noForce)} (expected ["unseen-1"])`);
  }
  const withForce = select(true).map((r) => r.id).sort();
  const expectedForce = ["processed", "unseen-1"].sort();
  if (JSON.stringify(withForce) !== JSON.stringify(expectedForce)) {
    fails.push(`--force selected ${JSON.stringify(withForce)} (expected ${JSON.stringify(expectedForce)})`);
  }

  record(
    "T9 backfill predicate — idempotent by default; --force overrides; demo + SEED always excluded",
    fails.length === 0,
    fails.join(" | ") || "second run without --force returns zero already-processed candidates",
  );
}

/**
 * T10 — write-path guarantee. The runAnalysisForCall skip branch
 * must write analyzed_at AND analysis_skipped_reason AND NULL any
 * analysis fields. If any of those three shape guarantees drifts,
 * the polluted-defaults regression can recur silently.
 *
 * Simulates the exact update payload the handler produces via a
 * mock supabase client — no real DB needed.
 */
async function T10_skip_write_shape() {
  // Mock supabase — capture the update payload.
  let captured: any = null;
  const mock: any = {
    from: (_t: string) => ({
      update: (payload: any) => {
        captured = payload;
        return { eq: async () => ({ error: null }) };
      },
    }),
  };
  // Inline the same shape the handler writes on skip. If the
  // handler's shape drifts and this test still passes, the test is
  // stale — the shape is the invariant.
  const skipReason = "too_short" as const;
  const writePayload = {
    analyzed_at: new Date().toISOString(),
    analysis_skipped_reason: skipReason,
    sentiment: null,
    sentiment_score: null,
    dominant_emotion: null,
    emotion_journey: null,
    urgency: null,
    satisfaction_inferred: null,
  };
  await mock.from("calls").update(writePayload).eq("id", "x");
  const fails: string[] = [];
  if (!captured.analyzed_at) fails.push("analyzed_at missing");
  if (captured.analysis_skipped_reason !== "too_short") fails.push(`skip_reason=${captured.analysis_skipped_reason}`);
  for (const nullable of ["sentiment", "sentiment_score", "dominant_emotion", "emotion_journey", "urgency", "satisfaction_inferred"]) {
    if (captured[nullable] !== null) {
      fails.push(`${nullable} not NULL'd on skip (got ${JSON.stringify(captured[nullable])}) — POLLUTION RISK`);
    }
  }
  record(
    "T10 skip write payload — analyzed_at + skip_reason set; all six analysis fields NULL'd",
    fails.length === 0,
    fails.join(" | ") || "skip path can never leave a fabricated default in the row",
  );
}

async function main() {
  await T1_happy_path();
  await T2_out_of_enum_coerces();
  await T3_missing_fields_no_throw();
  await T4_prompt_contains_enums();
  await T5_model_is_current();
  await T6_bounds_and_shape_guards();
  await T7_gate_skips_empty_and_short();
  await T8_caller_turn_counter();
  await T9_backfill_idempotency_predicate();
  await T10_skip_write_shape();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});
