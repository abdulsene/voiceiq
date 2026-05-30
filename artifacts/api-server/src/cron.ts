import { createClient } from "@supabase/supabase-js";
import { sendSMS } from "./sms";
import { contactPool } from "./routes/api";
import { DataRetentionManager } from "./security/retention";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function calculateNeverrScoreServer(calls: any[]) {
  if (!calls || calls.length === 0) return { score: 0, grade: "N/A" };
  const total = calls.length;
  const answered = calls.filter((c) => c.status !== "missed").length;
  const leads = calls.filter((c) => c.caller_name && c.caller_name !== "Unknown").length;
  const booked = calls.filter((c) => c.call_outcome?.includes("book") || c.call_outcome?.includes("appoint")).length;
  const followedUp = calls.filter((c) => c.follow_up_required && c.status === "completed").length;
  const positive = calls.filter((c) => c.sentiment === "positive").length;
  const answerRate = (answered / total) * 20;
  const leadCapture = Math.min((leads / total) * 25, 20);
  const bookingRate = Math.min((booked / total) * 40, 20);
  const followUpRate = followedUp > 0 ? Math.min(((total - followedUp) / total) * 25, 20) : 20;
  const sentimentScore = (positive / total) * 20;
  const score = Math.round(answerRate + leadCapture + bookingRate + followUpRate + sentimentScore);
  let grade = "F";
  if (score >= 90) grade = "A+";
  else if (score >= 80) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 50) grade = "D";
  return { score, grade };
}

export async function sendDailyBriefings() {
  const supabase = getSupabase();
  if (!supabase) return;

  console.log("[Briefing] Running daily briefing job...");

  const { data: businesses } = await supabase
    .from("business_configs")
    .select("business_id, business_name, notification_phone, phone_number, timezone")
    .eq("status", "active")
    .not("notification_phone", "is", null);

  if (!businesses || businesses.length === 0) {
    console.log("[Briefing] No businesses with notification_phone configured");
    return;
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  for (const biz of businesses) {
    try {
      const { data: calls } = await supabase
        .from("calls")
        .select("*")
        .eq("business_id", biz.business_id)
        .gte("created_at", yesterdayStr + "T00:00:00")
        .lte("created_at", yesterdayStr + "T23:59:59");

      const total = calls?.length || 0;
      const leads = calls?.filter((c: any) => c.caller_name && c.caller_name !== "Unknown").length || 0;
      const booked = calls?.filter((c: any) => c.call_outcome?.includes("book") || c.call_outcome?.includes("appoint")).length || 0;

      const { data: last30Calls } = await supabase
        .from("calls")
        .select("*")
        .eq("business_id", biz.business_id)
        .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());

      const scoreData = calculateNeverrScoreServer(last30Calls || []);

      const msg = `Good morning! Neverr daily briefing for ${biz.business_name}:\n\n\ud83d\udcde ${total} calls yesterday\n\ud83d\udc64 ${leads} leads captured\n\ud83d\udcc5 ${booked} appointments booked\n\u2b50 Neverr Score: ${scoreData.score}/100 (Grade: ${scoreData.grade})\n\nLog in: ${process.env.BASE_URL || "https://neverr.ai"}/dashboard`;

      const phone = biz.notification_phone || biz.phone_number;
      if (phone) {
        await sendSMS(phone, msg);
        console.log("[Briefing] Sent to:", biz.business_name, phone);
      }
    } catch (err: any) {
      console.error("[Briefing] Error for", biz.business_id, err.message);
    }
  }

  console.log("[Briefing] Daily briefing complete");
}

export function scheduleBriefings() {
  const now = new Date();
  const next7am = new Date();
  next7am.setHours(7, 0, 0, 0);
  if (next7am <= now) next7am.setDate(next7am.getDate() + 1);

  const msUntil7am = next7am.getTime() - now.getTime();
  console.log(`[Briefing] Next briefing in ${Math.round(msUntil7am / 1000 / 60)} minutes`);

  setTimeout(() => {
    sendDailyBriefings();
    setInterval(sendDailyBriefings, 24 * 60 * 60 * 1000);
  }, msUntil7am);
}

// ===== Scheduled retention sweep =====
//
// Sprint 5 enterprise readiness: claim "Configurable data retention" on the
// /enterprise page is only honest if scheduled retention jobs auto-execute.
// Endpoint #14 (POST /enterprise/security/retention/schedule) inserts rows
// into enterprise_retention_jobs with status='scheduled'. Endpoint #15
// (POST /enterprise/security/retention/:jobId/execute) runs them on demand.
// This cron sweeps every 6h and runs every job whose scheduled_at has passed.
//
// State machine (already implemented inside DataRetentionManager.executeRetention):
//   scheduled -> running -> completed | failed
// The cron does NOT write status itself — it only invokes executeRetention(),
// which handles the full transition + result persistence atomically.
//
// Per-job try/catch ensures one failing job doesn't block the rest of the sweep.

let _retention: DataRetentionManager | null = null;
function retention(): DataRetentionManager {
  if (_retention) return _retention;
  _retention = new DataRetentionManager(contactPool);
  return _retention;
}

export async function runScheduledRetention(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const summary = { processed: 0, succeeded: 0, failed: 0 };

  let dueRows: { id: string; business_id: string }[] = [];
  try {
    const { rows } = await contactPool.query<{ id: string; business_id: string }>(
      `SELECT id, business_id
         FROM enterprise_retention_jobs
        WHERE status = 'scheduled' AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC
        LIMIT 100`,
    );
    dueRows = rows;
  } catch (err: any) {
    // ensureTables() is idempotent and called from inside DataRetentionManager
    // methods, but the SELECT here runs before any manager call — if the table
    // doesn't exist yet (fresh boot, no scheduled job ever created), the query
    // will throw 42P01. Treat as "no due jobs" and move on.
    if (err && /relation .* does not exist/i.test(err.message)) {
      console.log("[Retention] Table not yet created — no due jobs.");
      return summary;
    }
    console.error("[Retention] Failed to query due jobs:", err?.message || err);
    return summary;
  }

  if (dueRows.length === 0) {
    console.log("[Retention] No due jobs.");
    return summary;
  }

  console.log(`[Retention] Found ${dueRows.length} due job(s).`);
  const mgr = retention();

  for (const row of dueRows) {
    summary.processed++;
    try {
      const report = await mgr.executeRetention(row.business_id, row.id);
      const hasCritical = report.errors.some((e) => e.severity === "critical");
      if (hasCritical) {
        summary.failed++;
        console.error(
          `[Retention] FAIL job=${row.id} biz=${row.business_id} ` +
            `errors=${JSON.stringify(report.errors).slice(0, 200)}`,
        );
      } else {
        summary.succeeded++;
        console.log(
          `[Retention] OK job=${row.id} biz=${row.business_id} ` +
            `processed=${report.recordsProcessed} deleted=${report.recordsDeleted} ` +
            `archived=${report.recordsArchived}`,
        );
      }
    } catch (err: any) {
      summary.failed++;
      console.error(
        `[Retention] EXCEPTION job=${row.id} biz=${row.business_id}: ${err?.message || err}`,
      );
    }
  }

  console.log(
    `[Retention] Sweep complete: ${summary.succeeded}/${summary.processed} succeeded, ${summary.failed} failed.`,
  );
  return summary;
}

export function scheduleRetentionCron() {
  // Match scheduleBriefings()'s setTimeout+setInterval pattern.
  // First run: 60s after boot (lets app finish init + handle traffic spikes).
  // Recurring: every 6h.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const FIRST_RUN_DELAY_MS = 60_000;

  setTimeout(() => {
    runScheduledRetention().catch((err) =>
      console.error("[Retention] Initial sweep failed:", err?.message || err),
    );
    setInterval(() => {
      runScheduledRetention().catch((err) =>
        console.error("[Retention] Interval sweep failed:", err?.message || err),
      );
    }, SIX_HOURS_MS);
  }, FIRST_RUN_DELAY_MS);

  console.log("[Retention] Cron registered (every 6h, first sweep in ~1min)");
}
