import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";
import { sendSMS } from "./sms";
import { contactPool } from "./routes/api";
import { DataRetentionManager } from "./security/retention";
import { placeCall, type PlaceCallResponse } from "./lib/outbound-voice";
import {
  parseSegmentDefinition,
  resolveSegment,
  type SegmentDefinition,
} from "./lib/outbound-campaigns/segment-resolver";
import {
  parseScheduleDefinition,
  resolveSchedule,
  type ScheduleDefinition,
} from "./lib/outbound-campaigns/schedule-resolver";
import { checkCampaignEligibility } from "./lib/outbound-voice/compliance";
import { resolveRecipientTimezone } from "./lib/phone-timezone";

// Test injection seam — Node 24 ESM namespaces are frozen, so smoke
// tests can't monkey-patch this module's getSupabase. They call this
// setter instead. Production code never touches it.
let _supabaseForTesting: SupabaseClient | null = null;
export function __setSupabaseForTesting(client: SupabaseClient | null) {
  _supabaseForTesting = client;
}

function getSupabase(): SupabaseClient | null {
  if (_supabaseForTesting) return _supabaseForTesting;
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
      Sentry.captureException(err, {
        extra: { route: "cron.sendDailyBriefings", businessId: biz.business_id },
      });
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
    Sentry.captureException(err, { extra: { route: "cron.runScheduledRetention.query" } });
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
      Sentry.captureException(err, {
        extra: { route: "cron.runScheduledRetention.executeRetention", jobId: row.id, businessId: row.business_id },
      });
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

// ===== Scheduled outbound-call worker (Phase 1.5) =====
//
// Fires lead_calls rows that were inserted with status='scheduled' and
// have reached their scheduled_for timestamp. Composes with the
// Phase 1.3 placeCall() primitive via its existingLeadCallId mode
// (Phase 1.5a):
//
//   per-row protocol:
//     1. SELECT due rows JOINed with leads to grab business_id.
//     2. For each row: UPDATE..RETURNING set status='processing' WHERE
//        id=$1 AND status='scheduled'. RETURNING empty → another worker
//        grabbed it (or the dashboard cancelled), skip.
//     3. placeCall(supabase, { existingLeadCallId: row.id, ... }) — the
//        wrapper handles compliance re-check + provider dispatch + the
//        existing row's terminal-state UPDATE on failure.
//
// Status state machine (lead_calls.status — open TEXT, no CHECK):
//   scheduled → processing → initiated | failed
//
// 'processing' is a transient state. If the worker process crashes
// between the lock UPDATE and the placeCall return, the row sits in
// 'processing' indefinitely — stuck-row recovery is deferred to
// Phase 2 (an automated 'processing' → 'scheduled' rollback sweep for
// rows older than ~5 minutes). For pilot scale, manual ops via the
// Supabase dashboard handles it.
//
// 'processing' must be included in any "active call states" enumeration
// alongside {initiated, ringing, in_progress}. See place-call.ts JSDoc.
//
// Cadence: recursive-setTimeout at 60s, NOT setInterval. A slow sweep
// (100 rows × 2s Twilio latency = 200s) would overlap with the next
// setInterval tick. Recursive setTimeout fires the next tick AFTER
// the current one returns — natural backpressure.

export async function runScheduledCallSweep(opts: { supabase?: SupabaseClient } = {}): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  locked: number;
}> {
  const summary = { processed: 0, succeeded: 0, failed: 0, locked: 0 };
  const supabase = opts.supabase ?? getSupabase();
  if (!supabase) {
    console.log("[OutboundCall] No supabase client; skipping sweep.");
    return summary;
  }

  const dueAt = new Date().toISOString();
  type DueRow = {
    id: string;
    lead_id: string;
    scheduled_for: string | null;
    call_objective: string | null;
    campaign_id: string | null;
    attempt_number: number | null;
    retry_count: number | null;
    leads: { business_id: string } | { business_id: string }[] | null;
  };

  let dueRows: DueRow[];
  try {
    const { data, error } = await supabase
      .from("lead_calls")
      .select(
        "id, lead_id, scheduled_for, call_objective, campaign_id, attempt_number, retry_count, leads!inner(business_id)",
      )
      .eq("direction", "outbound_automated")
      .eq("status", "scheduled")
      .lte("scheduled_for", dueAt)
      .order("scheduled_for", { ascending: true })
      .limit(100);
    if (error) {
      Sentry.captureException(error, { extra: { route: "cron.runScheduledCallSweep.query" } });
      console.error("[OutboundCall] Query failed:", (error as { message?: string }).message);
      return summary;
    }
    dueRows = (data ?? []) as unknown as DueRow[];
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "cron.runScheduledCallSweep.query" } });
    console.error("[OutboundCall] Query exception:", err?.message || err);
    return summary;
  }

  if (dueRows.length === 0) {
    return summary;
  }

  console.log(`[OutboundCall] Found ${dueRows.length} due row(s).`);

  for (const row of dueRows) {
    // (1) Cooperative lock — UPDATE..RETURNING from 'scheduled' to 'processing'.
    let lockOk = false;
    try {
      const { data, error } = await supabase
        .from("lead_calls")
        .update({ status: "processing" })
        .eq("id", row.id)
        .eq("status", "scheduled")
        .select("id")
        .single();
      if (error || !data) {
        summary.locked++;
        Sentry.addBreadcrumb({
          category: "outbound-call-worker",
          level: "info",
          message: "row_lock_failed",
          data: { leadCallId: row.id, errorMessage: (error as { message?: string } | null)?.message },
        });
        continue;
      }
      lockOk = true;
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { route: "cron.runScheduledCallSweep.lock", leadCallId: row.id },
      });
      continue;
    }
    if (!lockOk) continue;

    // (2) Resolve businessId from the joined leads embed. supabase-js
    // returns either an object or an array depending on the FK shape
    // — normalize both.
    const leadsAny = row.leads;
    const businessId =
      leadsAny && Array.isArray(leadsAny)
        ? leadsAny[0]?.business_id
        : (leadsAny as { business_id?: string } | null)?.business_id;
    if (!businessId) {
      summary.failed++;
      Sentry.captureMessage("scheduled_call_worker_missing_business_id", {
        level: "error",
        extra: { leadCallId: row.id, leadId: row.lead_id },
      });
      try {
        await supabase
          .from("lead_calls")
          .update({ status: "failed", end_reason: "missing_business_id" })
          .eq("id", row.id);
      } catch {
        /* best-effort */
      }
      continue;
    }

    // (3) Fire placeCall with existingLeadCallId. The wrapper handles
    // the existing row's terminal-state UPDATE on failure paths.
    summary.processed++;
    try {
      const result = await placeCall(supabase, {
        businessId,
        leadId: row.lead_id,
        direction: "outbound_automated",
        callObjective: row.call_objective ?? "campaign_call",
        campaignId: row.campaign_id ?? undefined,
        attemptNumber: row.attempt_number ?? 1,
        retryCount: row.retry_count ?? 0,
        existingLeadCallId: row.id,
      });
      if (result.ok) {
        summary.succeeded++;
      } else {
        summary.failed++;
        Sentry.addBreadcrumb({
          category: "outbound-call-worker",
          level: "warning",
          message: "placement_failed",
          data: { leadCallId: row.id, reason: result.reason },
        });
      }
    } catch (err: any) {
      // placeCall guarantees never-throws (invariant 1); defensive.
      summary.failed++;
      Sentry.captureException(err, {
        extra: { route: "cron.runScheduledCallSweep.placeCall", leadCallId: row.id },
      });
    }
  }

  console.log(
    `[OutboundCall] Sweep complete: processed=${summary.processed} succeeded=${summary.succeeded} failed=${summary.failed} locked=${summary.locked}`,
  );
  return summary;
}

export function scheduleOutboundCallWorker(): void {
  const INTERVAL_MS = 60_000;
  const FIRST_RUN_DELAY_MS = 60_000;

  async function tick() {
    try {
      await runScheduledCallSweep();
    } catch (err: any) {
      Sentry.captureException(err, { extra: { route: "cron.scheduleOutboundCallWorker.tick" } });
      console.error("[OutboundCall] Tick failed:", err?.message || err);
    } finally {
      setTimeout(tick, INTERVAL_MS);
    }
  }

  setTimeout(tick, FIRST_RUN_DELAY_MS);
  console.log(
    `[OutboundCall] Worker registered (every ${INTERVAL_MS / 1000}s, first sweep in ~${FIRST_RUN_DELAY_MS / 1000}s)`,
  );
}

// ===== Campaign expansion worker (Phase 2.4) =====
//
// Composes the Phase 2.1-2.3 primitives into a cron-driven
// materialization loop:
//   - Picks campaigns with status='active' AND expansion_running=false
//   - Per-campaign cooperative lock via UPDATE-RETURNING (same atomic
//     pattern as 1.5b's row-level lock on lead_calls)
//   - resolveSegment → leadIds; resolveSchedule → Map<leadId, Date>
//   - Per-eligible lead: pending-first UPSERT → placeCall →
//     reconcile junction to 'scheduled' or 'skipped'
//
// R5 reorder: eligibility runs BEFORE the pending UPSERT for fresh
// leads. The naive "UPSERT first, then eligibility" order self-collides
// because checkCampaignEligibility's state IN ('pending', 'scheduled')
// filter would match the row we just created. R5 fixes this:
//   1. Skip rule (existing state in scheduled|completed|skipped|opted_out → SKIP)
//   2. Schedule lookup
//   3. If existing state !== 'pending': resolve tz + run eligibility
//      (pending state means previous-tick orphan; skip eligibility,
//      use the resume path → placeCall directly)
//   4. Campaign daily_cap pre-check (in-memory cache by target day)
//   5. UPSERT pending (now safe — no double-eligibility)
//   6. placeCall
//   7. Reconcile junction to 'scheduled' (ok) or 'skipped' (!ok)
//
// Stuck-row recovery deferred to Phase 3 (matches 1.5b's 'processing'
// posture). If a worker crashes mid-tick with expansion_running=TRUE,
// ops manually resets via SQL.
//
// Performance: at pilot scale (1 campaign × ~200 leads × 5min cadence)
// the per-lead eligibility runs ~200 sequential SELECT roundtrips per
// tick. Acceptable. Phase 3 batch-eligibility optimization if any
// tenant grows past 1000 leads in a single campaign.

interface CampaignRow {
  id: string;
  business_id: string;
  call_objective: string | null;
  segment_definition: unknown;
  schedule_definition: unknown;
  schedule_strategy: string;
  daily_cap: number | null;
  target_count: number | null;
}

interface ExistingJunctionRow {
  lead_id: string;
  state: string;
}

interface LeadRow {
  id: string;
  contact_phone: string | null;
}

interface CampaignExpansionSummary {
  campaignsProcessed: number;   // campaigns where lock was acquired and segment ran
  campaignsLocked: number;      // lock acquisition failed (someone else has it)
  scheduled: number;            // leads transitioned to state='scheduled' this sweep
  skipped: number;              // leads transitioned to state='skipped' this sweep
}

/**
 * Maps placeCall failure reasons to outbound_campaign_leads.skip_reason
 * vocabulary. Centralized so future placeCall reason additions get a
 * single edit point.
 */
function mapPlaceCallReasonToSkipReason(reason: string, blockedBy?: string): string {
  switch (reason) {
    case "compliance_blocked":
      return blockedBy ?? "compliance_blocked";  // dnc | consent | calling_hours
    case "daily_cap_exceeded":
      return "daily_cap";  // tenant-level cap (different from campaign_daily_cap)
    case "provider_failed":
      return "provider_failed";
    case "lead_not_found":
      return "lead_not_found";
    case "lead_phone_invalid":
      return "lead_phone_invalid";
    case "business_not_found":
      return "business_not_found";
    case "tenant_outbound_disabled":
      return "tenant_outbound_disabled";
    case "non_nanp_number_no_tz_inference":
      return "non_nanp_phone";
    case "db_error":
      return "db_error_at_placement";
    case "staff_ring_number_missing":
    case "caller_id_unresolvable":
      return "unexpected_placecall_reason";
    default:
      return "unknown";
  }
}

export async function runCampaignExpansionSweep(
  opts: { supabase?: SupabaseClient } = {},
): Promise<CampaignExpansionSummary> {
  const summary: CampaignExpansionSummary = {
    campaignsProcessed: 0,
    campaignsLocked: 0,
    scheduled: 0,
    skipped: 0,
  };
  const supabase = opts.supabase ?? getSupabase();
  if (!supabase) {
    console.log("[CampaignExpansion] No supabase client; skipping sweep.");
    return summary;
  }

  // (1) Pick active, unlocked campaigns. Modest per-tick cap to bound
  //     sweep wall time; Phase 3 can raise.
  let campaigns: CampaignRow[];
  try {
    const { data, error } = await supabase
      .from("outbound_campaigns")
      .select(
        "id, business_id, call_objective, segment_definition, schedule_definition, schedule_strategy, daily_cap, target_count",
      )
      .eq("status", "active")
      .eq("expansion_running", false)
      .limit(50);
    if (error) {
      Sentry.captureException(error, { extra: { route: "cron.runCampaignExpansionSweep.query" } });
      console.error("[CampaignExpansion] Query failed:", (error as { message?: string }).message);
      return summary;
    }
    campaigns = (data ?? []) as unknown as CampaignRow[];
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "cron.runCampaignExpansionSweep.query" } });
    console.error("[CampaignExpansion] Query exception:", err?.message || err);
    return summary;
  }

  if (campaigns.length === 0) return summary;

  console.log(`[CampaignExpansion] Found ${campaigns.length} active+unlocked campaign(s).`);

  for (const campaign of campaigns) {
    await expandOneCampaign(supabase, campaign, summary);
  }

  console.log(
    `[CampaignExpansion] Sweep complete: processed=${summary.campaignsProcessed} locked=${summary.campaignsLocked} scheduled=${summary.scheduled} skipped=${summary.skipped}`,
  );
  return summary;
}

async function expandOneCampaign(
  supabase: SupabaseClient,
  campaign: CampaignRow,
  summary: CampaignExpansionSummary,
): Promise<void> {
  // (2) Cooperative lock — UPDATE...RETURNING with idempotency guard.
  try {
    const { data: locked, error: lockErr } = await supabase
      .from("outbound_campaigns")
      .update({ expansion_running: true })
      .eq("id", campaign.id)
      .eq("expansion_running", false)
      .select("id")
      .single();
    if (lockErr || !locked) {
      summary.campaignsLocked++;
      Sentry.addBreadcrumb({
        category: "campaign-expansion-worker",
        level: "info",
        message: "lock_acquisition_failed",
        data: { campaignId: campaign.id },
      });
      return;
    }
  } catch (err: any) {
    summary.campaignsLocked++;
    Sentry.captureException(err, {
      extra: { route: "cron.expandOneCampaign.lock", campaignId: campaign.id },
    });
    return;
  }

  // From here on, we MUST release the lock before returning. Track newly-
  // scheduled count for target_count bump at the end.
  let newlyScheduledThisTick = 0;
  try {
    summary.campaignsProcessed++;

    // (3) Parse segment_definition + schedule_definition.
    const segParsed = parseSegmentDefinition(campaign.segment_definition);
    if ("error" in segParsed) {
      Sentry.captureMessage("campaign_segment_definition_invalid", {
        level: "error",
        extra: { campaignId: campaign.id, error: segParsed.error },
      });
      return;
    }
    const schedParsed = parseScheduleDefinition(campaign.schedule_definition);
    if ("error" in schedParsed) {
      Sentry.captureMessage("campaign_schedule_definition_invalid", {
        level: "error",
        extra: { campaignId: campaign.id, error: schedParsed.error },
      });
      return;
    }

    // (4) Resolve segment + schedule.
    const segResult = await resolveSegment(
      supabase,
      campaign.business_id,
      segParsed as SegmentDefinition,
    );
    if (segResult.error) {
      Sentry.captureMessage("campaign_segment_resolution_failed", {
        level: "error",
        extra: { campaignId: campaign.id, error: segResult.error },
      });
      return;
    }
    if (segResult.leadIds.length === 0) {
      // Empty segment — release lock, bump last_expansion_at, no junction
      // rows written.
      return;
    }
    const schedResult = await resolveSchedule(
      supabase,
      campaign.business_id,
      segResult.leadIds,
      schedParsed as ScheduleDefinition,
    );
    if (schedResult.error) {
      Sentry.captureMessage("campaign_schedule_resolution_failed", {
        level: "error",
        extra: { campaignId: campaign.id, error: schedResult.error },
      });
      return;
    }

    // (5) Batch read existing junction rows + lead contact info.
    const existingByLead = new Map<string, ExistingJunctionRow>();
    try {
      const { data: existingRows } = await supabase
        .from("outbound_campaign_leads")
        .select("lead_id, state")
        .eq("campaign_id", campaign.id)
        .in("lead_id", segResult.leadIds);
      for (const r of (existingRows ?? []) as ExistingJunctionRow[]) {
        existingByLead.set(r.lead_id, r);
      }
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { route: "cron.expandOneCampaign.existingJunctionBatch", campaignId: campaign.id },
      });
      return;
    }

    const leadById = new Map<string, LeadRow>();
    try {
      const { data: leadRows } = await supabase
        .from("leads")
        .select("id, contact_phone")
        .in("id", segResult.leadIds);
      for (const r of (leadRows ?? []) as LeadRow[]) {
        leadById.set(r.id, r);
      }
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { route: "cron.expandOneCampaign.leadBatch", campaignId: campaign.id },
      });
      return;
    }

    // (6) In-memory campaign-cap cache. Lazily populated per target day.
    const capCacheByDay = new Map<string, number>();

    // (7) Per-lead loop in R5 order.
    for (const leadId of segResult.leadIds) {
      const result = await processOneLead(
        supabase,
        campaign,
        leadId,
        leadById.get(leadId),
        schedResult.scheduledFor.get(leadId),
        existingByLead.get(leadId),
        capCacheByDay,
      );
      if (result === "scheduled") {
        newlyScheduledThisTick++;
        summary.scheduled++;
      } else if (result === "skipped") {
        summary.skipped++;
      }
      // result === 'noop' means we hit the existing-active-or-terminal
      // skip rule — no UPSERT, no summary change.
    }
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "cron.expandOneCampaign", campaignId: campaign.id },
    });
  } finally {
    // (8) Release lock + bump last_expansion_at + target_count.
    try {
      const newTargetCount = (campaign.target_count ?? 0) + newlyScheduledThisTick;
      await supabase
        .from("outbound_campaigns")
        .update({
          expansion_running: false,
          last_expansion_at: new Date().toISOString(),
          target_count: newTargetCount,
        })
        .eq("id", campaign.id);
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { route: "cron.expandOneCampaign.releaseLock", campaignId: campaign.id },
      });
    }
  }
}

type LeadProcessResult = "scheduled" | "skipped" | "noop";

async function processOneLead(
  supabase: SupabaseClient,
  campaign: CampaignRow,
  leadId: string,
  lead: LeadRow | undefined,
  scheduledFor: Date | undefined,
  existing: ExistingJunctionRow | undefined,
  capCacheByDay: Map<string, number>,
): Promise<LeadProcessResult> {
  // (R5.1) Skip rule — terminal or active states get preserved verbatim.
  const existingState = existing?.state;
  if (
    existingState === "scheduled" ||
    existingState === "completed" ||
    existingState === "skipped" ||
    existingState === "opted_out"
  ) {
    return "noop";
  }

  // (R5.2) Schedule lookup.
  if (!scheduledFor) {
    await upsertJunction(supabase, campaign.id, leadId, {
      state: "skipped",
      skip_reason: "no_matching_anchor",
    });
    return "skipped";
  }

  // (R5.3) Fresh-lead eligibility (skip on the resume path for pending).
  if (existingState !== "pending") {
    if (!lead || !lead.contact_phone) {
      await upsertJunction(supabase, campaign.id, leadId, {
        state: "skipped",
        skip_reason: "lead_phone_invalid",
      });
      return "skipped";
    }
    const recipientTz = resolveRecipientTimezone(lead.contact_phone);
    if (!recipientTz) {
      await upsertJunction(supabase, campaign.id, leadId, {
        state: "skipped",
        skip_reason: "non_nanp_phone",
      });
      return "skipped";
    }
    const elig = await checkCampaignEligibility(supabase, {
      campaignId: campaign.id,
      businessId: campaign.business_id,
      leadId,
      phone: lead.contact_phone,
      consentType: campaign.call_objective ?? "campaign_call",
      recipientTimezone: recipientTz,
      scheduledFor,
    });
    if (!elig.eligible) {
      await upsertJunction(supabase, campaign.id, leadId, {
        state: "skipped",
        skip_reason: elig.skip_reason,
      });
      return "skipped";
    }
  }

  // (R5.4) Campaign daily_cap pre-check. NULL = no campaign cap.
  if (campaign.daily_cap !== null) {
    const targetDayStr = scheduledFor.toISOString().slice(0, 10);
    let consumed = capCacheByDay.get(targetDayStr);
    if (consumed === undefined) {
      consumed = await fetchCampaignCapacityForDay(supabase, campaign.id, targetDayStr);
      capCacheByDay.set(targetDayStr, consumed);
    }
    if (consumed >= campaign.daily_cap) {
      await upsertJunction(supabase, campaign.id, leadId, {
        state: "skipped",
        skip_reason: "campaign_daily_cap",
      });
      return "skipped";
    }
  }

  // (R5.5) UPSERT pending — between here and step 7 is the recoverable
  // crash window (orphan-pending stays in the table; next tick processes
  // via the resume path).
  await upsertJunction(supabase, campaign.id, leadId, {
    state: "pending",
    scheduled_for: scheduledFor.toISOString(),
  });

  // (R5.6) placeCall.
  let result: PlaceCallResponse;
  try {
    result = await placeCall(supabase, {
      businessId: campaign.business_id,
      leadId,
      direction: "outbound_automated",
      callObjective: campaign.call_objective ?? "campaign_call",
      scheduledFor,
      campaignId: campaign.id,
    });
  } catch (err: any) {
    // placeCall guarantees never-throws (invariant 1); defensive.
    Sentry.captureException(err, {
      extra: { route: "cron.processOneLead.placeCall", campaignId: campaign.id, leadId },
    });
    await upsertJunction(supabase, campaign.id, leadId, {
      state: "skipped",
      skip_reason: "placement_threw",
    });
    return "skipped";
  }

  // (R5.7) Reconcile junction to terminal state.
  if (result.ok) {
    // Both 'scheduled' (defer-branch) and 'placed' (rare immediate) map to
    // the same outcome — the lead is now in the campaign.
    await upsertJunction(supabase, campaign.id, leadId, {
      state: "scheduled",
      scheduled_call_id: result.leadCallId,
      scheduled_for: scheduledFor.toISOString(),
    });
    // Update cap cache so subsequent same-day leads see the increment.
    if (campaign.daily_cap !== null) {
      const targetDayStr = scheduledFor.toISOString().slice(0, 10);
      capCacheByDay.set(targetDayStr, (capCacheByDay.get(targetDayStr) ?? 0) + 1);
    }
    return "scheduled";
  }
  const blockedBy = result.reason === "compliance_blocked" ? result.blocked_by : undefined;
  const skipReason = mapPlaceCallReasonToSkipReason(result.reason, blockedBy);
  await upsertJunction(supabase, campaign.id, leadId, {
    state: "skipped",
    skip_reason: skipReason,
  });
  return "skipped";
}

async function fetchCampaignCapacityForDay(
  supabase: SupabaseClient,
  campaignId: string,
  targetDayStr: string,
): Promise<number> {
  const dayStart = `${targetDayStr}T00:00:00.000Z`;
  const dayEndDate = new Date(`${targetDayStr}T00:00:00.000Z`);
  dayEndDate.setUTCDate(dayEndDate.getUTCDate() + 1);
  const dayEnd = dayEndDate.toISOString();
  try {
    const { count } = await supabase
      .from("outbound_campaign_leads")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("state", ["scheduled", "completed"])
      .gte("scheduled_for", dayStart)
      .lt("scheduled_for", dayEnd);
    return count ?? 0;
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "cron.fetchCampaignCapacityForDay", campaignId, targetDayStr },
    });
    // Fail-open on count query error — same posture as placeCall step 5.5.
    return 0;
  }
}

async function upsertJunction(
  supabase: SupabaseClient,
  campaignId: string,
  leadId: string,
  fields: {
    state: string;
    skip_reason?: string;
    scheduled_call_id?: string;
    scheduled_for?: string;
  },
): Promise<void> {
  try {
    await supabase
      .from("outbound_campaign_leads")
      .upsert(
        {
          campaign_id: campaignId,
          lead_id: leadId,
          ...fields,
        },
        { onConflict: "campaign_id,lead_id" },
      );
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "cron.upsertJunction", campaignId, leadId, state: fields.state },
    });
  }
}

export function scheduleCampaignExpansionWorker(): void {
  const INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes
  const FIRST_RUN_DELAY_MS = 60_000;

  async function tick() {
    try {
      await runCampaignExpansionSweep();
    } catch (err: any) {
      Sentry.captureException(err, { extra: { route: "cron.scheduleCampaignExpansionWorker.tick" } });
      console.error("[CampaignExpansion] Tick failed:", err?.message || err);
    } finally {
      setTimeout(tick, INTERVAL_MS);
    }
  }

  setTimeout(tick, FIRST_RUN_DELAY_MS);
  console.log(
    `[CampaignExpansion] Worker registered (every ${INTERVAL_MS / 1000}s, first sweep in ~${FIRST_RUN_DELAY_MS / 1000}s)`,
  );
}
