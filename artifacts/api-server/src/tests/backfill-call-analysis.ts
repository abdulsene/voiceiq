/**
 * Phase 4.5 — one-shot backfill: run analysis for every call that
 * has a transcript but never got analyzed. Cheap at current volume
 * (~22 candidates), makes the detail page useful immediately.
 *
 * SELECT criteria — matches the "unanalyzed with transcript" set
 * we identified in the Phase 4.5 investigation:
 *   business_id != 'demo-business'
 *   AND (call_sid IS NULL OR call_sid NOT LIKE 'SEED_%')
 *   AND transcript IS NOT NULL AND length(transcript) > 0
 *   AND sentiment IS NULL   -- proxy for "Claude analysis never ran"
 *
 * The write path is the SAME lib the live handlers now use
 * (runAnalysisForCall was too tightly coupled to the api.ts scope
 * to re-export, so we inline the equivalent DB write here — one
 * place to keep in sync if the schema changes, but not blocking).
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/tests/backfill-call-analysis.ts [--dry-run] [--limit=N]
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY.
 *
 * Safety:
 *   - Idempotent: re-running only picks up rows where sentiment is
 *     still NULL, so a partial run + re-run picks up where you
 *     left off.
 *   - Sequential (no parallelism) so we don't spike Anthropic
 *     rate-limits during backfill. At 22 candidates this takes
 *     ~30-60 seconds.
 *   - Never writes to satisfaction_rating (survey column). Only
 *     satisfaction_inferred (machine column, migration 048).
 */

import { createClient } from "@supabase/supabase-js";
import { analyzeCallTranscript, getAnalysisModel } from "../lib/call-analysis";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
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

  console.log(`[backfill-analysis] model=${getAnalysisModel()} dry_run=${DRY_RUN} limit=${LIMIT}`);

  const { data, error } = await supa
    .from("calls")
    .select("id, business_id, call_sid, transcript, created_at")
    .neq("business_id", "demo-business")
    .not("transcript", "is", null)
    .is("sentiment", null)
    .order("created_at", { ascending: true })
    .limit(LIMIT);

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
  }>;

  // Exclude SEED_* client-side (the .not query above doesn't
  // support NOT LIKE cleanly).
  const candidates = candidatesRaw.filter(
    (c) => !(c.call_sid && c.call_sid.startsWith("SEED_")),
  );
  console.log(`[backfill-analysis] selected ${candidates.length} candidates`);

  if (DRY_RUN) {
    console.log("[backfill-analysis] dry-run — no writes. Candidates:");
    for (const c of candidates) {
      console.log(`  ${c.id}  biz=${c.business_id}  created=${c.created_at}  tx_len=${(c.transcript || "").length}`);
    }
    return;
  }

  let ok = 0;
  let failed = 0;
  let empty = 0;
  let totalCoercions = 0;

  for (const c of candidates) {
    const transcript = (c.transcript || "").trim();
    if (!transcript) {
      empty += 1;
      console.log(`  SKIP  ${c.id} — empty transcript after trim`);
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
      ok += 1;
      console.log(
        `  OK    ${c.id}  sentiment=${analysis.sentiment}/${analysis.sentimentScore}  emotion=${analysis.dominantEmotion}  urgency=${analysis.urgency}  sat=${analysis.satisfactionInferred}  outcome=${analysis.callOutcome}  elapsed_ms=${elapsed}  coercions=${coercions.length}`,
      );
    } catch (err: any) {
      failed += 1;
      console.log(`  FAIL  ${c.id} — analysis threw: ${err?.message ?? err}`);
    }
  }

  console.log("");
  console.log(`[backfill-analysis] done: ok=${ok} failed=${failed} empty=${empty} total_coercions=${totalCoercions}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[backfill-analysis] crashed:", err);
  process.exit(2);
});
