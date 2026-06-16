import * as Sentry from "@sentry/node";

if (process.env.SENTRY_API_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_API_DSN,
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    tracesSampleRate: 0,
    ignoreErrors: [
      "Non-Error promise rejection captured",
      "AbortError",
    ],
    beforeSend(_event, hint) {
      const error = hint.originalException as any;
      if (error?.statusCode >= 400 && error?.statusCode < 500) {
        return null;
      }
      return _event;
    },
  });
  console.log("[Sentry] API error monitoring initialized");
} else {
  console.log("[Sentry] SENTRY_API_DSN not set, monitoring disabled");
}

import app from "./app";
import { scheduleBriefings, scheduleRetentionCron, scheduleOutboundCallWorker } from "./cron";
import { runReconciliation } from "./lib/twilio-reconciliation";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ───────────────────────────────────────────────────────────────────────
// Twilio reconciliation cron (Sprint 2 / Batch C — audit risk #3).
//
// Scheduled separately from the briefing / retention crons (which use
// setTimeout + setInterval in src/cron.ts) because the user spec for
// this feature requested node-cron specifically. Long-term consider
// consolidating onto one scheduling mechanism — flagged in the Batch C
// summary.
//
// Gated to NODE_ENV=production OR explicit ENABLE_RECONCILIATION_CRON
// opt-in so the cron does not fire on every developer's local box
// (it makes real Twilio API calls and can release real DIDs).
//
// Dynamic import of node-cron so the api-server still boots when the
// package hasn't been installed yet (e.g. between this code landing
// and the next pnpm install). If the import fails, scheduling is
// skipped with a loud log; the rest of the server is unaffected.
// ───────────────────────────────────────────────────────────────────────
const RECONCILIATION_CRON_SCHEDULE =
  process.env.RECONCILIATION_CRON_SCHEDULE || "0 3 * * *"; // 3 AM UTC daily.

async function scheduleTwilioReconciliation(): Promise<void> {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ENABLE_RECONCILIATION_CRON !== "true"
  ) {
    console.log(
      "[reconciliation] Skipped (not production and ENABLE_RECONCILIATION_CRON not set)",
    );
    return;
  }

  let cron: { schedule: (expr: string, fn: () => void | Promise<void>) => unknown };
  try {
    cron = (await import("node-cron")).default;
  } catch (err) {
    console.error(
      "[reconciliation] node-cron not installed — scheduling skipped:",
      err,
    );
    return;
  }

  cron.schedule(RECONCILIATION_CRON_SCHEDULE, async () => {
    try {
      console.log("[reconciliation] Starting scheduled run");
      const report = await runReconciliation();
      console.log("[reconciliation] Done:", {
        orphans: report.orphans.length,
        ghosts: report.ghosts.length,
        autoReleased: report.orphansAutoReleasedCount,
        durationMs: report.durationMs,
        errors: report.errors.length,
      });
    } catch (err) {
      console.error("[reconciliation] Cron run failed:", err);
    }
  });
  console.log(
    `[reconciliation] Scheduled with cron: ${RECONCILIATION_CRON_SCHEDULE}`,
  );
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  scheduleBriefings();
  scheduleRetentionCron();
  scheduleOutboundCallWorker();
  // Fire-and-forget — scheduleTwilioReconciliation logs internally
  // and never throws to the caller.
  scheduleTwilioReconciliation().catch((err) => {
    console.error("[reconciliation] schedule setup failed:", err);
  });
});
