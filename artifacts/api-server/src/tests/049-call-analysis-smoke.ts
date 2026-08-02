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

async function main() {
  await T1_happy_path();
  await T2_out_of_enum_coerces();
  await T3_missing_fields_no_throw();
  await T4_prompt_contains_enums();
  await T5_model_is_current();
  await T6_bounds_and_shape_guards();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});
