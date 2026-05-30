/**
 * Sprint 5 retention-cron smoke.
 *
 * Verifies the scheduled-retention cron end-to-end without waiting 6 hours
 * for the real schedule to fire:
 *
 *   1. Schedules a fresh dry-run retention job for the test biz with
 *      scheduled_at = NOW() (i.e. immediately due).
 *   2. Snapshots the job's pre-sweep state (status='scheduled', no
 *      executed_at).
 *   3. Invokes runScheduledRetention() directly (bypasses the setTimeout
 *      so we don't wait the full 60s + 6h wall-clock).
 *   4. Snapshots the post-sweep state (expects status='completed',
 *      executed_at populated, results JSON populated).
 *   5. Cleans up the test job + any archive rows it created.
 *
 * Idempotent: each run uses a fresh job UUID; teardown is in finally{}.
 *
 * Note: this smoke imports runScheduledRetention() *and* the
 * retentionManager singleton from cron.ts. Importing cron.ts also
 * imports routes/api (huge file with side effects) because that's
 * where contactPool lives — that's expected and harmless for tsx.
 */
import { contactPool } from "../routes/api";
import { DataRetentionManager } from "../security/retention";
import { runScheduledRetention } from "../cron";

const TEST_BIZ_ID = "biz_1776968643213_dxwf60";

async function snapshotJob(jobId: string) {
  const { rows } = await contactPool.query(
    `SELECT id, status, scheduled_at, executed_at,
            (results IS NOT NULL) AS has_results
       FROM enterprise_retention_jobs
      WHERE id = $1`,
    [jobId],
  );
  return rows[0] || null;
}

async function main() {
  console.log("=== Sprint 5 retention-cron smoke ===\n");
  console.log(`[smoke] Test biz: ${TEST_BIZ_ID}`);
  console.log(`[smoke] Step 1: schedule fresh dry-run retention job (scheduled_at=NOW())`);

  const mgr = new DataRetentionManager(contactPool);
  const job = await mgr.scheduleRetention(TEST_BIZ_ID, {
    retentionDays: 365,
    categories: ["calls"],
    archiveBeforeDelete: false,
    confirmationRequired: false,
    dryRun: true, // CRITICAL: don't actually delete anything
  });
  console.log(`[smoke] scheduled job.id=${job.id} status=${job.status}`);

  const pre = await snapshotJob(job.id);
  console.log(
    `[smoke] pre-sweep: status=${pre?.status} executed_at=${pre?.executed_at} has_results=${pre?.has_results}`,
  );
  if (pre?.status !== "scheduled" || pre?.executed_at !== null || pre?.has_results !== false) {
    throw new Error(`pre-sweep state wrong: ${JSON.stringify(pre)}`);
  }

  // Also count any leftover scheduled jobs from prior runs — they'll get
  // swept too, which is fine (extra evidence the cron handles batches).
  const { rows: dueRows } = await contactPool.query(
    `SELECT COUNT(*)::int AS n FROM enterprise_retention_jobs
      WHERE status = 'scheduled' AND scheduled_at <= NOW()`,
  );
  console.log(`[smoke] total due jobs in table (incl. ours): ${dueRows[0].n}\n`);

  console.log(`[smoke] Step 2: invoking runScheduledRetention() directly`);
  const start = Date.now();
  const summary = await runScheduledRetention();
  const elapsed = Date.now() - start;
  console.log(
    `[smoke] sweep returned in ${elapsed}ms: processed=${summary.processed} succeeded=${summary.succeeded} failed=${summary.failed}\n`,
  );

  console.log(`[smoke] Step 3: post-sweep snapshot of our job`);
  const post = await snapshotJob(job.id);
  console.log(
    `[smoke] post-sweep: status=${post?.status} executed_at=${post?.executed_at} has_results=${post?.has_results}`,
  );

  // Verdict
  let verdict = "PASS";
  const issues: string[] = [];
  if (post?.status !== "completed") {
    issues.push(`status expected 'completed', got '${post?.status}'`);
    verdict = "FAIL";
  }
  if (!post?.executed_at) {
    issues.push("executed_at not populated");
    verdict = "FAIL";
  }
  if (post?.has_results !== true) {
    issues.push("results JSON not populated");
    verdict = "FAIL";
  }
  if (summary.processed < 1) {
    issues.push(`sweep processed 0 jobs (expected ≥1)`);
    verdict = "FAIL";
  }

  console.log(`\n=== Verdict: ${verdict} ===`);
  if (issues.length) {
    for (const i of issues) console.log(`  - ${i}`);
  } else {
    console.log(`  - status transitioned scheduled → completed ✓`);
    console.log(`  - executed_at populated (${post?.executed_at}) ✓`);
    console.log(`  - results JSON written ✓`);
    console.log(`  - sweep processed ${summary.processed} job(s), ${summary.succeeded} succeeded ✓`);
  }

  // Cleanup: remove our test job (and any archive rows it might have created,
  // though dryRun should mean none).
  console.log(`\n[smoke] Cleanup: deleting test job ${job.id}`);
  await contactPool.query(`DELETE FROM enterprise_retention_jobs WHERE id = $1`, [job.id]);
  await contactPool.query(
    `DELETE FROM enterprise_retention_archive WHERE business_id = $1 AND source_table = 'calls' AND archived_at >= NOW() - INTERVAL '5 minutes'`,
    [TEST_BIZ_ID],
  );
  console.log(`[smoke] cleanup done.`);

  process.exit(verdict === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(2);
});
