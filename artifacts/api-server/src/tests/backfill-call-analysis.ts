/**
 * Phase 4.5 → 4.6 — one-shot backfill for post-call analysis.
 *
 * Phase 4.6 changes vs the original 4.5 implementation:
 *
 *   * Predicate is now `analyzed_at IS NULL` (was `sentiment IS NULL`,
 *     which sort-of worked but couldn't distinguish "never analyzed"
 *     from "analyzed and legitimately produced NULL"). Migration 049
 *     backfills analyzed_at on all pre-4.6 processed rows so this
 *     predicate is correctly idempotent from day one.
 *   * Gate check per row (shouldSkipAnalysis) BEFORE calling Haiku.
 *     Empty / < 2 caller turns → skip written (analyzed_at +
 *     analysis_skipped_reason), no model call. This kills the
 *     fabricated-defaults-for-thin-transcripts pattern that
 *     inflated Phase 4.5's aggregate satisfaction average.
 *   * `--force` flag reprocesses rows regardless of analyzed_at.
 *     Default MUST NOT overwrite existing values — that was the
 *     Phase 4.5 "not idempotent despite the claim" bug.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/tests/backfill-call-analysis.ts [--dry-run] [--limit=N] [--force]
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY.
 *
 * Safety:
 *   - Idempotent by default. Second run picks up ONLY rows added
 *     between runs (analyzed_at IS NULL). Same 20 candidates on
 *     the second run WITHOUT --force is a bug — the smoke tests
 *     assert this.
 *   - Sequential. At current volume takes ~30-60s.
 *   - Never writes to satisfaction_rating (survey column). Only
 *     satisfaction_inferred (machine column, migration 048).
 *   - Skips action_items + webhook fires + email — those trigger
 *     side effects that would spam customers for weeks-old calls.
 */

import { createClient } from "@supabase/supabase-js";
import {
  analyzeCallTranscript,
  getAnalysisModel,
  shouldSkipAnalysis,
} from "../lib/call-analysis";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const LIMIT = (() => {
  const flag = args.find((a) => a.startsWith("--limit="));
  if (!flag) return 100;
  const n = parseInt(flag.split("=")[1] || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY. Set them and retry.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY. Set it and retry.");
    process.exit(1);
  }

  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  console.log(
    `[backfill-analysis] model=${getAnalysisModel()} dry_run=${DRY_RUN} force=${FORCE} limit=${LIMIT}`,
  );

  // Idempotency predicate. `analyzed_at IS NULL` is the new
  // canonical "never touched" signal (Phase 4.6, migration 049).
  // With --force we take everything with a transcript regardless
  // of prior state — used to reprocess after a prompt or model
  // change.
  let query = supa
    .from("calls")
    .select("id, business_id, call_sid, transcript, created_at, analyzed_at, analysis_skipped_reason, sentiment")
    .neq("business_id", "demo-business")
    .not("transcript", "is", null)
    .order("created_at", { ascending: true })
    .limit(LIMIT);
  if (!FORCE) {
    query = query.is("analyzed_at", null);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[backfill-analysis] select failed:", error.message);
    process.exit(1);
  }

  const candidatesRaw = (data ?? []) as Array<{
    id: string;
    business_id: string;
    call_sid: string | null;
    transcript: string | null;
    created_at: string;
    analyzed_at: string | null;
    analysis_skipped_reason: string | null;
    sentiment: string | null;
  }>;

  const candidates = candidatesRaw.filter(
    (c) => !(c.call_sid && c.call_sid.startsWith("SEED_")),
  );
  console.log(`[backfill-analysis] selected ${candidates.length} candidates`);

  if (DRY_RUN) {
    console.log("[backfill-analysis] dry-run — no writes. Candidates:");
    for (const c of candidates) {
      const preSkip = shouldSkipAnalysis(c.transcript ?? "");
      const preLen = (c.transcript ?? "").length;
      const preAnalyzed = c.analyzed_at ? "already-analyzed" : "never";
      console.log(
        `  ${c.id}  biz=${c.business_id}  tx_len=${preLen}  gate=${preSkip ?? "analyze"}  status=${preAnalyzed}`,
      );
    }
    return;
  }

  let analyzed = 0;
  let skippedEmpty = 0;
  let skippedTooShort = 0;
  let failed = 0;
  let totalCoercions = 0;

  for (const c of candidates) {
    const transcript = (c.transcript || "").trim();

    // Gate FIRST. Skipping is a fast path — no model call, no
    // fabricated defaults. Writes analyzed_at + skip reason so
    // future runs correctly filter this out.
    const skip = shouldSkipAnalysis(transcript);
    if (skip) {
      const { error: skipErr } = await supa
        .from("calls")
        .update({
          analyzed_at: new Date().toISOString(),
          analysis_skipped_reason: skip,
          // Defensive NULLing — should already be NULL post-migration
          // 049 but a re-run with --force could have re-populated.
          sentiment: null,
          sentiment_score: null,
          dominant_emotion: null,
          emotion_journey: null,
          urgency: null,
          satisfaction_inferred: null,
        })
        .eq("id", c.id);
      if (skipErr) {
        failed += 1;
        console.log(`  FAIL  ${c.id} — skip write failed: ${skipErr.message}`);
        continue;
      }
      if (skip === "empty") skippedEmpty += 1;
      else skippedTooShort += 1;
      console.log(`  SKIP  ${c.id}  reason=${skip}  tx_len=${transcript.length}`);
      continue;
    }

    try {
      const t0 = Date.now();
      const { analysis, coercions } = await analyzeCallTranscript(transcript, c.business_id);
      const elapsed = Date.now() - t0;
      totalCoercions += coercions.length;

      const { error: upd } = await supa
        .from("calls")
        .update({
          summary: analysis.summary,
          caller_name: analysis.callerName,
          caller_intent: analysis.callerIntent,
          sentiment: analysis.sentiment,
          sentiment_score: analysis.sentimentScore,
          dominant_emotion: analysis.dominantEmotion,
          emotion_journey: analysis.emotionJourney,
          urgency: analysis.urgency,
          satisfaction_inferred: analysis.satisfactionInferred,
          call_outcome: analysis.callOutcome,
          follow_up_required: analysis.followUpRequired,
          analyzed_at: new Date().toISOString(),
          // Clear any prior skip marker if --force is reprocessing
          // a previously-skipped row.
          analysis_skipped_reason: null,
        })
        .eq("id", c.id);

      if (upd) {
        failed += 1;
        console.log(`  FAIL  ${c.id} — DB write failed: ${upd.message}`);
        continue;
      }

      // Skip action_items on backfill — those trigger side effects
      // (webhooks, email) that would spam customers for calls that
      // already happened weeks ago. Analysis fields only.
      analyzed += 1;
      console.log(
        `  OK    ${c.id}  sentiment=${analysis.sentiment}/${analysis.sentimentScore}  emotion=${analysis.dominantEmotion}  urgency=${analysis.urgency}  sat=${analysis.satisfactionInferred}  outcome=${analysis.callOutcome}  elapsed_ms=${elapsed}  coercions=${coercions.length}`,
      );
    } catch (err: any) {
      failed += 1;
      console.log(`  FAIL  ${c.id} — analysis threw: ${err?.message ?? err}`);
    }
  }

  console.log("");
  console.log(
    `[backfill-analysis] done: analyzed=${analyzed} skipped_empty=${skippedEmpty} skipped_too_short=${skippedTooShort} failed=${failed} total_coercions=${totalCoercions}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill-analysis] crashed:", err);
  process.exit(2);
});
