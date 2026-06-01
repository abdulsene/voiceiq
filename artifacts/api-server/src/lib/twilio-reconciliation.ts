/**
 * Twilio DID reconciliation — nightly catch-net for orphaned
 * resources (audit risk #3).
 *
 * Two failure classes this module catches that the application-side
 * defenses in twilio-provisioning.ts cannot:
 *
 *   1. Process death between Twilio purchase and DB persistence.
 *      IncomingPhoneNumbers.create() succeeded, the api-server was
 *      SIGKILLed (OOM, autoscale rotation, deploy) before
 *      markProvisioned() landed, so we own a DID on Twilio's side
 *      with no business_configs row referencing it. Application
 *      rollback can't fire — the process is gone. We bill ~$1/month
 *      indefinitely until someone notices.
 *
 *   2. Out-of-band DB writes / Twilio releases. Admin manually
 *      releases a number via the Twilio console without nulling the
 *      DB row; or a billing dispute reclaims a number; or someone
 *      hand-edits business_configs to clear twilio_phone_number
 *      without releasing the DID. These produce "ghosts" (DB → no
 *      Twilio) or "orphans" (Twilio → no DB) that the live code
 *      paths never see.
 *
 * Algorithm:
 *   1. List every IncomingPhoneNumber on our Twilio account.
 *   2. Read every business_configs row with a non-NULL
 *      twilio_phone_number.
 *   3. Cross-reference by phone number (E.164):
 *      - On Twilio but not in DB → orphan.
 *      - In DB but not on Twilio → ghost.
 *   4. For each orphan older than autoReleaseMinAgeHours (default 24h),
 *      release the DID via Twilio. The age window protects against a
 *      provisioning-in-progress orphan (race between purchase and
 *      persist on a live request) from being prematurely released.
 *   5. Persist the report to reconciliation_reports (migration 019).
 *   6. If anything was found and we're not in dry-run, email an
 *      alert to ADMIN_ALERT_EMAIL (best-effort; alert failure does
 *      not fail the run).
 *
 * Per-stage error handling: every stage wraps its IO in try/catch
 * and pushes failures into report.errors. The run continues with
 * whatever partial data it has — a partial report is more useful
 * for ops triage than a hard abort.
 *
 * NOT in this module:
 *   - The cron schedule itself (src/index.ts).
 *   - The admin trigger endpoint (src/routes/admin.ts).
 *   - Any provisioning-flow changes; this is purely read-mostly
 *     reconciliation downstream of provisioning.
 */

import twilio from 'twilio';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { sanitizeErrorForPersistence } from './twilio-provisioning.js';
import { getUncachableSendGridClient } from '../integrations/sendgrid.js';

// ───────────────────────────────────────────────────────────────────────
// Types

export interface Orphan {
  sid: string;
  phoneNumber: string;
  /** ISO-8601 from Twilio's dateCreated. */
  dateCreated: string;
  /** Computed at report time (now - dateCreated, hours). */
  ageHours: number;
  autoReleased: boolean;
  releaseError?: string;
}

export interface Ghost {
  businessId: string;
  phoneNumber: string;
  sid: string | null;
}

export interface ReconciliationReport {
  runAt: string;
  durationMs: number;
  twilioNumbersCount: number;
  dbNumbersCount: number;
  orphans: Orphan[];
  ghosts: Ghost[];
  orphansAutoReleasedCount: number;
  errors: Array<{ stage: string; message: string }>;
}

export interface ReconciliationOpts {
  /** Default true. Release orphans that pass the age threshold. */
  autoRelease?: boolean;
  /**
   * Default 24. Only release orphans whose Twilio-side dateCreated
   * is at least this many hours in the past. Protects in-flight
   * provisioning attempts from being prematurely released.
   */
  autoReleaseMinAgeHours?: number;
  /**
   * Default false. When true, skip every side effect (Twilio
   * releases, DB persist, email alert). Used by the admin endpoint
   * for "what would happen" previews.
   */
  dryRun?: boolean;
}

// ───────────────────────────────────────────────────────────────────────
// Clients — lazy singletons mirroring twilio-provisioning.ts.

let _twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilioClient(): ReturnType<typeof twilio> {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables are required for reconciliation but not set',
    );
  }
  _twilioClient = twilio(sid, token);
  return _twilioClient;
}

let _supabase: SupabaseClient | null = null;
function defaultGetSupabase(): SupabaseClient {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required for reconciliation but not set',
    );
  }
  _supabase = createClient(url, key);
  return _supabase;
}

let _twilioOverride: ReturnType<typeof twilio> | undefined = undefined;
let _supabaseOverride: SupabaseClient | undefined = undefined;

/** @internal exported for tests */
export function _setTwilioClientForTests(client: ReturnType<typeof twilio> | undefined): void {
  _twilioOverride = client;
}
/** @internal exported for tests */
export function _setSupabaseClientForTests(client: SupabaseClient | undefined): void {
  _supabaseOverride = client;
}

function resolveTwilio(): ReturnType<typeof twilio> {
  return _twilioOverride ?? getTwilioClient();
}
function resolveSupabase(): SupabaseClient {
  return _supabaseOverride ?? defaultGetSupabase();
}

// ───────────────────────────────────────────────────────────────────────
// Stages

interface TwilioRecord {
  sid: string;
  phoneNumber: string;
  dateCreated: Date;
}

async function listTwilioNumbers(
  errors: Array<{ stage: string; message: string }>,
): Promise<TwilioRecord[]> {
  try {
    const client = resolveTwilio();
    // twilio SDK auto-paginates within a list() call when given a
    // high limit. 1000 is comfortably more than we expect this
    // account to hold for the foreseeable future; if we ever grow
    // past it the SDK's .each() iterator is the right upgrade.
    const list = await client.incomingPhoneNumbers.list({ limit: 1000 });
    return list.map((n) => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      dateCreated: n.dateCreated,
    }));
  } catch (err) {
    errors.push({
      stage: 'twilio_list',
      message: sanitizeErrorForPersistence(err),
    });
    return [];
  }
}

interface DbRecord {
  business_id: string;
  twilio_phone_number: string;
  twilio_phone_sid: string | null;
}

async function listDbNumbers(
  errors: Array<{ stage: string; message: string }>,
): Promise<DbRecord[]> {
  try {
    const sb = resolveSupabase();
    const { data, error } = await sb
      .from('business_configs')
      .select('business_id, twilio_phone_number, twilio_phone_sid')
      .not('twilio_phone_number', 'is', null);
    if (error) {
      throw new Error(error.message);
    }
    return (data ?? []) as DbRecord[];
  } catch (err) {
    errors.push({
      stage: 'db_select',
      message: sanitizeErrorForPersistence(err),
    });
    return [];
  }
}

async function persistReport(
  report: ReconciliationReport,
): Promise<void> {
  const sb = resolveSupabase();
  const { error } = await sb.from('reconciliation_reports').insert({
    run_at: report.runAt,
    run_duration_ms: report.durationMs,
    twilio_numbers_count: report.twilioNumbersCount,
    db_numbers_count: report.dbNumbersCount,
    orphans_count: report.orphans.length,
    ghosts_count: report.ghosts.length,
    orphans_auto_released_count: report.orphansAutoReleasedCount,
    orphans_details: report.orphans,
    ghosts_details: report.ghosts,
    errors: report.errors,
  });
  if (error) throw new Error(error.message);
}

/**
 * Best-effort alert via SendGrid. Returns the error (if any) so the
 * caller can attach it to the report's errors array. Never throws —
 * the cron must not fail on alert delivery problems.
 *
 * Skips entirely when ADMIN_ALERT_EMAIL is unset (e.g. local dev),
 * which is not considered an error.
 */
async function sendAlertEmailOrSkip(
  report: ReconciliationReport,
): Promise<{ sent: boolean; skipped: boolean; error?: unknown }> {
  const recipient = process.env.ADMIN_ALERT_EMAIL;
  if (!recipient) {
    console.warn(
      '[reconciliation] ADMIN_ALERT_EMAIL not set — skipping alert email',
    );
    return { sent: false, skipped: true };
  }
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    const subject = `[Neverr] Twilio reconciliation: ${report.orphans.length} orphan(s), ${report.ghosts.length} ghost(s)`;
    const lines: string[] = [
      `Reconciliation completed at ${report.runAt}`,
      `Duration: ${report.durationMs}ms`,
      `Twilio numbers: ${report.twilioNumbersCount}`,
      `DB numbers: ${report.dbNumbersCount}`,
      `Orphans: ${report.orphans.length} (${report.orphansAutoReleasedCount} auto-released)`,
      `Ghosts: ${report.ghosts.length}`,
      '',
    ];
    if (report.orphans.length > 0) {
      lines.push('Orphan details:');
      lines.push(JSON.stringify(report.orphans, null, 2));
      lines.push('');
    }
    if (report.ghosts.length > 0) {
      lines.push('Ghost details:');
      lines.push(JSON.stringify(report.ghosts, null, 2));
      lines.push('');
    }
    if (report.errors.length > 0) {
      lines.push('Stage errors:');
      lines.push(JSON.stringify(report.errors, null, 2));
    }
    await client.send({
      to: recipient,
      from: fromEmail,
      subject,
      text: lines.join('\n'),
    });
    return { sent: true, skipped: false };
  } catch (err) {
    console.error('[reconciliation] Alert email send failed:', err);
    return { sent: false, skipped: false, error: err };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Main entry point

/**
 * Run a single reconciliation pass.
 *
 * Returns the report whether or not stages failed — partial reports
 * are useful for ops. Only throws on programmer error (e.g.
 * env-var resolution failures from inside the client singletons,
 * which would otherwise prevent the function from doing anything
 * useful anyway).
 *
 * @param opts.autoRelease              default true — release stale orphans
 * @param opts.autoReleaseMinAgeHours   default 24 — minimum orphan age to release
 * @param opts.dryRun                   default false — skip all writes / releases / emails
 */
export async function runReconciliation(
  opts?: ReconciliationOpts,
): Promise<ReconciliationReport> {
  const startTime = Date.now();
  const autoRelease = opts?.autoRelease ?? true;
  const autoReleaseMinAgeHours = opts?.autoReleaseMinAgeHours ?? 24;
  const dryRun = opts?.dryRun ?? false;

  const errors: Array<{ stage: string; message: string }> = [];

  // ── (1) Twilio side. Failure here yields an empty list but does
  // not abort; ghosts can still be computed from the DB side alone
  // would NOT actually be meaningful with an empty Twilio set
  // (every DB number would look like a ghost), so callers should
  // check errors for 'twilio_list' before acting on ghosts. We
  // surface the data anyway for diagnostic completeness.
  const twilioNumbers = await listTwilioNumbers(errors);

  // ── (2) DB side. Symmetric to (1).
  const dbRows = await listDbNumbers(errors);

  // ── (3) Reconcile by E.164 phone number.
  const dbPhoneSet = new Set(dbRows.map((r) => r.twilio_phone_number));
  const twilioPhoneSet = new Set(twilioNumbers.map((n) => n.phoneNumber));

  const now = Date.now();
  const orphans: Orphan[] = twilioNumbers
    .filter((n) => !dbPhoneSet.has(n.phoneNumber))
    .map((n) => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      dateCreated: n.dateCreated.toISOString(),
      ageHours: (now - n.dateCreated.getTime()) / 3_600_000,
      autoReleased: false,
    }));

  const ghosts: Ghost[] = dbRows
    .filter((r) => !twilioPhoneSet.has(r.twilio_phone_number))
    .map((r) => ({
      businessId: r.business_id,
      phoneNumber: r.twilio_phone_number,
      sid: r.twilio_phone_sid,
    }));

  // ── (4) Auto-release stale orphans. Per-orphan try/catch so one
  // failure doesn't block the rest. We mutate the orphan objects in
  // place to set autoReleased / releaseError on the same instance
  // we return.
  let orphansAutoReleasedCount = 0;
  if (autoRelease && !dryRun && orphans.length > 0) {
    let client: ReturnType<typeof twilio>;
    try {
      client = resolveTwilio();
    } catch (err) {
      errors.push({
        stage: 'twilio_client_for_release',
        message: sanitizeErrorForPersistence(err),
      });
      client = null as unknown as ReturnType<typeof twilio>;
    }
    if (client) {
      for (const orphan of orphans) {
        if (orphan.ageHours < autoReleaseMinAgeHours) continue;
        try {
          await client.incomingPhoneNumbers(orphan.sid).remove();
          orphan.autoReleased = true;
          orphansAutoReleasedCount++;
        } catch (err) {
          orphan.releaseError = sanitizeErrorForPersistence(err);
        }
      }
    }
  }

  // ── (5) Build report.
  const durationMs = Date.now() - startTime;
  const report: ReconciliationReport = {
    runAt: new Date(startTime).toISOString(),
    durationMs,
    twilioNumbersCount: twilioNumbers.length,
    dbNumbersCount: dbRows.length,
    orphans,
    ghosts,
    orphansAutoReleasedCount,
    errors,
  };

  // ── (6) Persist (skip in dry-run).
  if (!dryRun) {
    try {
      await persistReport(report);
    } catch (err) {
      errors.push({
        stage: 'persist',
        message: sanitizeErrorForPersistence(err),
      });
    }
  }

  // ── (7) Alert email (skip in dry-run and when nothing notable).
  if (!dryRun && (orphans.length > 0 || ghosts.length > 0)) {
    const alertResult = await sendAlertEmailOrSkip(report);
    if (alertResult.error) {
      errors.push({
        stage: 'alert_email',
        message: sanitizeErrorForPersistence(alertResult.error),
      });
    }
  }

  return report;
}
