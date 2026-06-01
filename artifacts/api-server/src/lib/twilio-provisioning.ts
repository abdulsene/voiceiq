/**
 * Twilio DID provisioning for business_configs rows.
 *
 * Sprint 2 introduces auto-wired Twilio number provisioning at signup
 * (and a one-off admin backfill endpoint). This module is the single
 * place that:
 *
 *   1. Looks for an available DID in the customer's requested area
 *      code, then falls back to other area codes in the same US state,
 *      then to toll-free. Never falls back to "any US local from any
 *      state" — geographic match or toll-free, nothing else.
 *   2. Purchases the DID via Twilio's IncomingPhoneNumbers API, with
 *      voiceUrl + statusCallback wired to the api-server's voice
 *      webhook routes at provisioning time (single .create() call).
 *   3. Persists state to public.business_configs (the columns added
 *      by migration 017): twilio_phone_number, twilio_phone_sid,
 *      provisioning_status, provisioning_started_at,
 *      provisioning_completed_at, provisioning_error,
 *      provisioning_area_code.
 *   4. Rolls back a purchased number on DB persistence failure (with
 *      orphan-tracking when even the rollback release fails).
 *
 * Idempotent: if a row already has twilio_phone_number populated, the
 * existing value is returned without re-purchasing.
 *
 * NOT in this module (separate Sprint 2 steps):
 *   - Wiring this into the signup / auth handler.
 *   - Admin backfill endpoint.
 *   - The /api/twilio/voice + /api/twilio/status webhook handlers
 *     themselves. This module only configures the URLs Twilio will
 *     POST to — the handlers are a separate deliverable.
 */

import twilio from 'twilio';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ───────────────────────────────────────────────────────────────────────
// Constants

/**
 * US state postal code → ordered list of area codes assigned to that
 * state. Ordering within a state is roughly by population / primacy
 * (Maryland intentionally matches the EZ Rentals scenario:
 * 443's same-state fallbacks are 410, 240, 301).
 *
 * Used to constrain fallback to geographic neighbours. If a requested
 * area code is not in any state's list, the lookup falls straight to
 * toll-free — we do NOT silently pick a random US local from a
 * different state.
 *
 * Coverage: all 50 states + DC. Includes overlay area codes (e.g.
 * California's 279/341/657/820 overlays). Territories (PR, GU, etc.)
 * intentionally omitted — Neverr is US-only for Sprint 2.
 */
export const STATE_AREA_CODES: Record<string, readonly string[]> = {
  AK: ['907'],
  AL: ['205', '251', '256', '334', '659', '938'],
  AR: ['479', '501', '870'],
  AZ: ['480', '520', '602', '623', '928'],
  CA: [
    '213', '310', '323', '415', '619', '650', '707', '714', '760', '805',
    '818', '831', '858', '909', '916', '925', '949', '951', '209', '408',
    '424', '442', '510', '530', '559', '562', '626', '628', '657', '661',
    '669', '747', '279', '341', '820',
  ],
  CO: ['303', '719', '720', '970'],
  CT: ['203', '475', '860', '959'],
  DC: ['202'],
  DE: ['302'],
  FL: [
    '305', '321', '352', '386', '407', '561', '689', '727', '754', '772',
    '786', '813', '850', '863', '904', '941', '954', '239',
  ],
  GA: ['404', '470', '478', '678', '706', '762', '770', '912', '229'],
  HI: ['808'],
  IA: ['319', '515', '563', '641', '712'],
  ID: ['208', '986'],
  IL: ['217', '224', '309', '312', '331', '618', '630', '708', '773', '779', '815', '847', '872'],
  IN: ['219', '260', '317', '463', '574', '765', '812', '930'],
  KS: ['316', '620', '785', '913'],
  KY: ['270', '364', '502', '606', '859'],
  LA: ['225', '318', '337', '504', '985'],
  MA: ['339', '351', '413', '508', '617', '774', '781', '857', '978'],
  // Per spec: 443 falls back to 410, 240, 301 (Baltimore-area overlay
  // then DC-suburb codes). Order matters — first-listed wins when the
  // requested code is absent from the array.
  MD: ['410', '443', '240', '301'],
  ME: ['207'],
  MI: ['231', '248', '269', '313', '517', '586', '616', '679', '734', '810', '906', '947', '989'],
  MN: ['218', '320', '507', '612', '651', '763', '952'],
  MO: ['314', '417', '573', '636', '660', '816'],
  MS: ['228', '601', '662', '769'],
  MT: ['406'],
  NC: ['252', '336', '704', '743', '828', '910', '919', '980', '984'],
  ND: ['701'],
  NE: ['308', '402', '531'],
  NH: ['603'],
  NJ: ['201', '551', '609', '640', '732', '848', '856', '862', '908', '973'],
  NM: ['505', '575'],
  NV: ['702', '725', '775'],
  NY: [
    '212', '315', '332', '347', '516', '518', '585', '607', '631', '646',
    '680', '716', '718', '838', '845', '914', '917', '929', '934',
  ],
  OH: ['216', '220', '234', '283', '326', '330', '380', '419', '436', '440', '513', '567', '614', '740', '937'],
  OK: ['405', '539', '572', '580', '918'],
  OR: ['458', '503', '541', '971'],
  PA: ['215', '223', '267', '272', '412', '445', '484', '570', '582', '610', '717', '724', '814', '835', '878'],
  RI: ['401'],
  SC: ['803', '821', '839', '843', '854', '864'],
  SD: ['605'],
  TN: ['423', '615', '629', '731', '865', '901', '931'],
  TX: [
    '210', '214', '254', '281', '325', '346', '361', '409', '430', '432',
    '469', '512', '682', '713', '726', '737', '806', '817', '830', '832',
    '903', '915', '936', '940', '945', '956', '972', '979',
  ],
  UT: ['385', '435', '801'],
  VA: ['276', '434', '540', '571', '703', '757', '804', '826', '948'],
  VT: ['802'],
  WA: ['206', '253', '360', '425', '509', '564'],
  WI: ['262', '274', '414', '534', '608', '715', '920'],
  WV: ['304', '681'],
  WY: ['307'],
};

/**
 * Reverse lookup from area code → state postal code. Built once at
 * module load from STATE_AREA_CODES. If an area code maps to multiple
 * states (shouldn't happen for current US assignments, but defensive)
 * the first state encountered during construction wins.
 */
export const AREA_CODE_TO_STATE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
    for (const code of codes) {
      if (!map[code]) map[code] = state;
    }
  }
  return map;
})();

// ───────────────────────────────────────────────────────────────────────
// Error class

export class TwilioProvisioningError extends Error {
  constructor(
    public subcode:
      | 'no_inventory'
      | 'purchase'
      | 'persistence'
      | 'webhook'
      | 'in_progress',
    message: string,
    public twilioSid?: string,
  ) {
    super(message);
    this.name = 'TwilioProvisioningError';
  }
}

/**
 * Subcodes that map to a `failed_*` provisioning_status value in the
 * DB. `markFailure` accepts only these — `'in_progress'` is excluded
 * because it represents a row already owned by another writer; we
 * must never overwrite that writer's `provisioning_status` (and there
 * is no `failed_in_progress` value in the migration-017 CHECK
 * constraint to map to). Narrowing this at the type level prevents a
 * future caller from accidentally passing `'in_progress'` to
 * `markFailure`.
 */
type FailureSubcode = Exclude<TwilioProvisioningError['subcode'], 'in_progress'>;

// ───────────────────────────────────────────────────────────────────────
// Validation / sanitization helpers (audit risks #2, #6)

/**
 * Validate the shape of a Twilio IncomingPhoneNumbers.create response
 * before we trust it. Twilio's SDK is statically typed but at runtime
 * can return objects with undefined fields if the upstream API ever
 * changes shape or returns a partial response. Without this check we
 * could persist NULL sid/phoneNumber into a row marked 'provisioned',
 * which is unrecoverable without manual Twilio-dashboard cleanup
 * (the SID is the only handle we have to release the DID).
 *
 * Throws TwilioProvisioningError('purchase', ...) with no `twilioSid`
 * field — by definition we don't have a usable SID if validation
 * fails.
 */
function validateTwilioPurchaseResponse(
  response: unknown,
): { sid: string; phoneNumber: string } {
  if (!response || typeof response !== 'object') {
    throw new TwilioProvisioningError(
      'purchase',
      'Twilio purchase returned non-object response',
    );
  }
  const r = response as Record<string, unknown>;
  if (typeof r.sid !== 'string' || r.sid.length === 0) {
    throw new TwilioProvisioningError(
      'purchase',
      'Twilio purchase response missing or invalid sid',
    );
  }
  if (typeof r.phoneNumber !== 'string' || !r.phoneNumber.startsWith('+')) {
    throw new TwilioProvisioningError(
      'purchase',
      `Twilio purchase response missing or invalid phoneNumber: ${r.phoneNumber}`,
    );
  }
  return { sid: r.sid, phoneNumber: r.phoneNumber };
}

/**
 * Sanitize an error before persisting it to business_configs.provisioning_error.
 *
 * Strips Twilio Account SIDs (`AC` + 32 hex) and standalone 32-char
 * hex strings (heuristic match for Twilio Auth Tokens — the lookbehind
 * `(?<![A-Z])` skips the hex portion of any prefixed SID like
 * PN/IM/MG/RE/SM so we keep those visible for debugging). Truncates
 * to 500 characters total.
 *
 * Accepts `unknown` so callers can pass raw thrown values without
 * pre-stringifying.
 */
export function sanitizeErrorForPersistence(err: unknown): string {
  let msg: string;
  if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'string') {
    msg = err;
  } else {
    msg = String(err);
  }

  // Twilio Account SIDs.
  msg = msg.replace(/AC[a-f0-9]{32}/gi, 'AC[REDACTED]');

  // Standalone 32-char hex strings (likely Auth Tokens). The
  // (?<![A-Z]) lookbehind skips hex preceded by an uppercase letter
  // (i.e. the hex tail of an SID like PNxxx) so SIDs for resources we
  // genuinely want to log stay intact after the AC redaction above.
  msg = msg.replace(/(?<![A-Z])[a-f0-9]{32}(?![A-Za-z0-9])/g, '[REDACTED]');

  // Truncate.
  if (msg.length > 500) {
    msg = msg.slice(0, 497) + '...';
  }

  return msg;
}

// ───────────────────────────────────────────────────────────────────────
// Clients — lazy singletons, mirror sms.ts (twilio) +
// pii-redact-transcript.ts (supabase) patterns.

let _twilioClient: ReturnType<typeof twilio> | null = null;
function getTwilioClient(): ReturnType<typeof twilio> {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables are required for provisioning but not set',
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
      'SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required for provisioning but not set',
    );
  }
  _supabase = createClient(url, key);
  return _supabase;
}

// Test-only override hooks. `undefined` = use real getter; explicit
// value = use the override (including `null` to simulate "not
// configured", though provisioning treats unconfigured Supabase /
// Twilio as a hard error rather than a soft fallback).
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

function resolveTwilioClient(): ReturnType<typeof twilio> {
  return _twilioOverride ?? getTwilioClient();
}
function resolveSupabaseClient(): SupabaseClient {
  return _supabaseOverride ?? defaultGetSupabase();
}

// ───────────────────────────────────────────────────────────────────────
// BASE_URL resolution (audit risk #4)

/**
 * Resolve and validate the api-server's public base URL for Twilio
 * webhook configuration.
 *
 * Returns `null` ONLY if neither BASE_URL nor API_URL is set in the
 * environment — callers treat that case as a 'webhook' precondition
 * failure and bail before any Twilio call.
 *
 * If a value IS set but fails validation (wrong scheme, malformed
 * hostname, or points at localhost in production), throws
 * TwilioProvisioningError('webhook', ...) immediately. This is a hard
 * fail: a misconfigured webhook URL means Twilio would happily sell us
 * a DID whose calls never reach the api-server, leaving the row
 * `provisioned`-but-dead.
 *
 * Validation rules:
 *   1. Must use `https://` scheme (Twilio won't deliver to plain http
 *      in production anyway, and we want to fail at provisioning time
 *      rather than at first-call time).
 *   2. Hostname shape must match the conservative pattern
 *      /^https:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.
 *   3. When NODE_ENV === 'production', hostname must NOT be
 *      localhost / 127.0.0.1 (catches misconfigured prod deploys that
 *      shipped a dev URL).
 */
const BASE_URL_PATTERN = /^https:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/;

function resolveBaseUrl(): string | null {
  const raw = process.env.BASE_URL || process.env.API_URL;
  if (!raw) return null;

  // Trim trailing slashes so concatenation with '/api/twilio/voice' is clean.
  const url = raw.replace(/\/+$/, '');

  if (!url.startsWith('https://')) {
    throw new TwilioProvisioningError(
      'webhook',
      `BASE_URL invalid: ${url} (reason: must use https:// scheme)`,
    );
  }
  if (!BASE_URL_PATTERN.test(url)) {
    throw new TwilioProvisioningError(
      'webhook',
      `BASE_URL invalid: ${url} (reason: malformed hostname)`,
    );
  }
  if (process.env.NODE_ENV === 'production') {
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      throw new TwilioProvisioningError(
        'webhook',
        `BASE_URL invalid: ${url} (reason: NODE_ENV=production but URL points at localhost/127.0.0.1)`,
      );
    }
  }
  return url;
}

// ───────────────────────────────────────────────────────────────────────
// DB helpers

interface BusinessConfigRow {
  twilio_phone_number: string | null;
  twilio_phone_sid: string | null;
  provisioning_status: string | null;
  provisioning_area_code: string | null;
}

async function readBusinessConfig(
  sb: SupabaseClient,
  businessId: string,
): Promise<BusinessConfigRow | null> {
  const { data, error } = await sb
    .from('business_configs')
    .select('twilio_phone_number, twilio_phone_sid, provisioning_status, provisioning_area_code')
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) throw new Error(`business_configs read failed: ${error.message}`);
  return data as BusinessConfigRow | null;
}

/**
 * Statuses from which `markStarted` is allowed to claim the row.
 * `'pending'` is the initial state from migration 017's DEFAULT.
 * The four `'failed_*'` values are retry-eligible — a prior attempt
 * landed in one of those terminal failure states and a new caller
 * (signup retry, admin backfill) wants to try again.
 *
 * Not in this list: `'provisioning'` (another writer owns the row)
 * and `'provisioned'` (already complete — the idempotency check
 * upstream should have caught this; defense in depth at the SQL
 * filter level too).
 */
const CLAIMABLE_STATUSES = [
  'pending',
  'failed_no_inventory',
  'failed_purchase',
  'failed_persistence',
  'failed_webhook',
] as const;

/**
 * Claim the row for provisioning via a conditional UPDATE.
 *
 * Returns `{ claimed: true }` if exactly one row transitioned into
 * `'provisioning'`. Returns `{ claimed: false }` if the row was not
 * in a claimable state (typically because a concurrent caller owns
 * it, or it's already `'provisioned'`). Caller must re-read to
 * disambiguate — see provisionTwilioNumberForBusiness for the
 * canonical handling.
 *
 * Mitigates audit risk #1 (concurrent provisioning races) and the
 * related #5 (read-then-write race window). The conditional UPDATE
 * serializes on the same row at the DB level: two concurrent
 * UPDATEs against the same row block each other; whichever commits
 * first flips status to `'provisioning'`, at which point the second
 * UPDATE's WHERE filter no longer matches and it affects 0 rows.
 *
 * Throws a non-TwilioProvisioningError on hard DB errors or on the
 * data-corruption case where count > 1 (which is impossible since
 * `business_configs.business_id` has a UNIQUE constraint — but if
 * it ever happens we want the loud failure rather than silently
 * claiming multiple rows).
 */
async function markStarted(
  sb: SupabaseClient,
  businessId: string,
  requestedAreaCode: string,
): Promise<{ claimed: boolean }> {
  const { error, count } = await sb
    .from('business_configs')
    .update(
      {
        provisioning_status: 'provisioning',
        provisioning_started_at: new Date().toISOString(),
        provisioning_area_code: requestedAreaCode,
        provisioning_error: null,
      },
      { count: 'exact' },
    )
    .eq('business_id', businessId)
    .in('provisioning_status', CLAIMABLE_STATUSES as unknown as string[]);

  if (error) {
    throw new Error(`business_configs mark-started failed: ${error.message}`);
  }

  // count: 'exact' is documented to return a number; a null here would
  // indicate a Supabase client / transport oddity. Treat conservatively
  // as a failed claim so we re-read and either return the winner's
  // result or throw 'in_progress'.
  if (count === null || count === undefined) {
    return { claimed: false };
  }

  if (count === 0) {
    return { claimed: false };
  }

  if (count > 1) {
    // business_configs.business_id has a UNIQUE constraint, so this
    // is unreachable in a healthy DB. Loud failure beats silent
    // multi-row claim.
    throw new Error(
      `business_configs mark-started affected ${count} rows for business_id=${businessId} (expected 1) — data corruption (business_id is supposed to be unique)`,
    );
  }

  return { claimed: true };
}

async function markFailure(
  sb: SupabaseClient,
  businessId: string,
  subcode: FailureSubcode,
  errorMessage: unknown,
): Promise<void> {
  // Map error subcode → DB status. Spec'd CHECK constraint allows
  // the four failed_* values; migration 017 enforces this. The
  // `FailureSubcode` type excludes 'in_progress' so this mapping is
  // exhaustive at compile time.
  const status = `failed_${subcode === 'no_inventory' ? 'no_inventory' : subcode}`;

  // Defensive started_at backfill (audit risk #7). Most failure paths
  // run AFTER markStarted, so provisioning_started_at is already set
  // and we must not overwrite it (we'd lose the original timestamp).
  // But the BASE_URL precondition fires BEFORE markStarted, so on that
  // path started_at is still NULL and a failed_webhook row would
  // otherwise violate the started_at_consistency invariant. We read
  // the row first and conditionally include started_at in the UPDATE.
  // Best-effort: if the read fails we proceed without it — markFailure
  // must never throw and mask the original error.
  let ensureStartedAt = false;
  try {
    const { data: existing } = await sb
      .from('business_configs')
      .select('provisioning_started_at')
      .eq('business_id', businessId)
      .maybeSingle();
    if (existing && !(existing as { provisioning_started_at: string | null }).provisioning_started_at) {
      ensureStartedAt = true;
    }
  } catch (readErr) {
    console.error(
      `[twilio-provisioning] started_at backfill read failed for ${businessId}:`,
      readErr,
    );
  }

  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> = {
    provisioning_status: status,
    provisioning_completed_at: nowIso,
    provisioning_error: sanitizeErrorForPersistence(errorMessage),
  };
  if (ensureStartedAt) {
    update.provisioning_started_at = nowIso;
  }

  const { error } = await sb
    .from('business_configs')
    .update(update)
    .eq('business_id', businessId);
  // Best-effort: callers should not let a mark-failure failure mask the
  // original error. We log but do not throw here.
  if (error) {
    console.error(
      `[twilio-provisioning] failed to mark ${businessId} as ${status}:`,
      error.message,
    );
  }
}

async function markProvisioned(
  sb: SupabaseClient,
  businessId: string,
  phoneNumber: string,
  twilioSid: string,
): Promise<void> {
  const { error } = await sb
    .from('business_configs')
    .update({
      twilio_phone_number: phoneNumber,
      twilio_phone_sid: twilioSid,
      provisioning_status: 'provisioned',
      provisioning_completed_at: new Date().toISOString(),
      provisioning_error: null,
    })
    .eq('business_id', businessId);
  if (error) throw new Error(`business_configs mark-provisioned failed: ${error.message}`);
}

// ───────────────────────────────────────────────────────────────────────
// Twilio search helpers

interface TwilioListedNumber {
  phoneNumber: string;
}

async function searchLocalNumbers(
  client: ReturnType<typeof twilio>,
  areaCode: string,
): Promise<string | null> {
  const results = (await client
    .availablePhoneNumbers('US')
    .local.list({
      areaCode: Number.parseInt(areaCode, 10),
      smsEnabled: true,
      voiceEnabled: true,
      limit: 1,
    })) as TwilioListedNumber[];
  return results[0]?.phoneNumber ?? null;
}

async function searchTollFree(
  client: ReturnType<typeof twilio>,
): Promise<string | null> {
  const results = (await client
    .availablePhoneNumbers('US')
    .tollFree.list({
      smsEnabled: true,
      voiceEnabled: true,
      limit: 1,
    })) as TwilioListedNumber[];
  return results[0]?.phoneNumber ?? null;
}

/**
 * Find an available number using the spec'd fallback chain:
 *   (a) requested area code → (b) same-state nearby area codes →
 *   (c) toll-free → (d) null (caller throws no_inventory).
 *
 * Returns { phoneNumber, areaCode } where areaCode is the area code
 * actually fulfilled (may differ from requested if we fell through to
 * a nearby code; reports 'TOLLFREE' if we landed on a toll-free number).
 */
async function findAvailableNumber(
  client: ReturnType<typeof twilio>,
  requestedAreaCode: string,
): Promise<{ phoneNumber: string; areaCode: string } | null> {
  // (a) Try requested area code first.
  const direct = await searchLocalNumbers(client, requestedAreaCode);
  if (direct) return { phoneNumber: direct, areaCode: requestedAreaCode };

  // (b) Same-state fallback. Look up the state for this area code; if
  // not in our table, skip straight to toll-free (no random-state
  // fallback by spec).
  const state = AREA_CODE_TO_STATE[requestedAreaCode];
  if (state) {
    const codes = STATE_AREA_CODES[state] ?? [];
    for (const code of codes) {
      if (code === requestedAreaCode) continue;
      const found = await searchLocalNumbers(client, code);
      if (found) return { phoneNumber: found, areaCode: code };
    }
  }

  // (c) Toll-free.
  const toll = await searchTollFree(client);
  if (toll) return { phoneNumber: toll, areaCode: 'TOLLFREE' };

  // (d) Nothing anywhere.
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// Main entry point

/**
 * Provision a Twilio DID for a business. Idempotent — if the row
 * already has twilio_phone_number, returns it without re-purchasing.
 *
 * On any failure the business_configs row is updated with the
 * matching `failed_*` status and a human-readable error in
 * provisioning_error; the function throws TwilioProvisioningError so
 * callers (signup handler, admin endpoint) can react / retry.
 *
 * @param businessId          business_configs.business_id (e.g.
 *                            'biz_1779288494109_z4z979' for EZ Rentals)
 * @param requestedAreaCode   3-digit US area code (e.g. '443'); caller
 *                            is responsible for extracting this from
 *                            the customer's existing phone_number.
 * @returns the provisioned (or pre-existing) DID details.
 *
 * @remarks Idempotent on (businessId): if the row already has
 * twilio_phone_number set, this function returns that existing
 * number regardless of the requestedAreaCode parameter. Callers
 * wanting to forcibly change a business's number must release
 * the existing DID via Twilio AND null both twilio_phone_number
 * and twilio_phone_sid in the DB BEFORE calling this function.
 * A safer reprovisionTwilioNumberForBusiness wrapper is not yet
 * implemented (see audit Risk #8).
 */
export async function provisionTwilioNumberForBusiness(
  businessId: string,
  requestedAreaCode: string,
): Promise<{ phoneNumber: string; twilioSid: string; areaCode: string }> {
  const sb = resolveSupabaseClient();

  // ── (1) Idempotency check.
  const existing = await readBusinessConfig(sb, businessId);
  if (!existing) {
    throw new Error(`business_configs row not found for business_id=${businessId}`);
  }
  if (existing.twilio_phone_number) {
    // Audit risk #8: surface a warning when the caller asked for a
    // different area code than the one we already have on file. This
    // is the documented behaviour ("returns existing regardless of
    // requestedAreaCode") but easy for a caller to miss; the warning
    // gives ops a breadcrumb when a "change my number" request
    // silently no-ops.
    if (
      existing.provisioning_area_code &&
      existing.provisioning_area_code !== requestedAreaCode
    ) {
      console.warn(
        `[twilio-provisioning] Idempotency hit for ${businessId}: ` +
          `requested area code ${requestedAreaCode}, returning existing ` +
          `${existing.twilio_phone_number} (originally provisioned for ` +
          `${existing.provisioning_area_code})`,
      );
    }
    return {
      phoneNumber: existing.twilio_phone_number,
      twilioSid: existing.twilio_phone_sid ?? '',
      // We don't store the area code separately in the idempotent
      // return path — derive it from the E.164 number (strip +1, take
      // first 3 digits) so callers get a consistent shape.
      areaCode: deriveAreaCodeFromE164(existing.twilio_phone_number),
    };
  }

  // Fail loudly before any Twilio call if BASE_URL is missing or
  // malformed. This prevents buying numbers with broken webhooks
  // (audit risk #4). resolveBaseUrl() returns null when both env
  // vars are unset, and throws TwilioProvisioningError('webhook')
  // when a value is set but fails validation (bad scheme, malformed
  // host, or localhost in production).
  let baseUrl: string | null;
  try {
    baseUrl = resolveBaseUrl();
  } catch (urlErr) {
    if (urlErr instanceof TwilioProvisioningError) {
      await markFailure(sb, businessId, 'webhook', urlErr.message);
      throw urlErr;
    }
    throw urlErr;
  }
  if (!baseUrl) {
    const msg = 'BASE_URL not configured (neither BASE_URL nor API_URL env var is set)';
    await markFailure(sb, businessId, 'webhook', msg);
    throw new TwilioProvisioningError('webhook', msg);
  }

  // ── (2) Mark in-flight (claim the row).
  //
  // The conditional UPDATE in markStarted serializes concurrent
  // callers for the same business_id (audit risks #1, #5). If we
  // lose the claim it means another caller transitioned the row
  // out of a claimable state between our idempotency check above
  // and this UPDATE — either they're still working on it
  // ('provisioning' state) or they finished it ('provisioned'). We
  // re-read to disambiguate and never call markFailure on this
  // path — the row is owned by another writer and we must not
  // overwrite their status.
  const { claimed } = await markStarted(sb, businessId, requestedAreaCode);
  if (!claimed) {
    const reread = await readBusinessConfig(sb, businessId);
    if (reread?.twilio_phone_number) {
      // The race winner completed the full provisioning lifecycle
      // between our idempotency check and our markStarted attempt.
      // Return their result — same shape as the idempotent return
      // path above (audit risk #8 documents the area-code-mismatch
      // semantics; we deliberately don't re-emit the warning log
      // here since the race-loser path is a different signal).
      return {
        phoneNumber: reread.twilio_phone_number,
        twilioSid: reread.twilio_phone_sid ?? '',
        areaCode: deriveAreaCodeFromE164(reread.twilio_phone_number),
      };
    }
    // Another caller is currently in 'provisioning' state (or the
    // row landed in an unexpected state we don't want to clobber).
    // Surface 'in_progress' so the caller can decide whether to
    // poll, retry-with-backoff, or surface to the user. Crucially,
    // do NOT call markFailure here — the row belongs to the other
    // writer and there is no 'failed_in_progress' status to map to.
    throw new TwilioProvisioningError(
      'in_progress',
      `Provisioning already in progress for ${businessId}`,
    );
  }

  // ── (3) Search Twilio for an available number.
  const client = resolveTwilioClient();
  let found: { phoneNumber: string; areaCode: string } | null;
  try {
    found = await findAvailableNumber(client, requestedAreaCode);
  } catch (searchErr: any) {
    const msg = `Twilio AvailablePhoneNumbers search failed: ${searchErr?.message ?? String(searchErr)}`;
    await markFailure(sb, businessId, 'no_inventory', msg);
    throw new TwilioProvisioningError('no_inventory', msg);
  }
  if (!found) {
    const msg = `No inventory in area code ${requestedAreaCode}, any same-state fallback, or toll-free`;
    await markFailure(sb, businessId, 'no_inventory', msg);
    throw new TwilioProvisioningError('no_inventory', msg);
  }

  // ── (4) Purchase.
  let purchased: { sid: string; phoneNumber: string };
  try {
    const result = await client.incomingPhoneNumbers.create({
      phoneNumber: found.phoneNumber,
      voiceUrl: `${baseUrl}/api/twilio/voice`,
      voiceMethod: 'POST',
      statusCallback: `${baseUrl}/api/twilio/status`,
      statusCallbackMethod: 'POST',
    });
    // Validate response shape (audit risk #2). A malformed response
    // here is unrecoverable — without a valid sid we can't release
    // the DID, so we treat it as a 'purchase' failure even though
    // Twilio's .create() call itself returned. validateTwilio*
    // throws TwilioProvisioningError('purchase', ...) which the
    // catch below handles uniformly.
    purchased = validateTwilioPurchaseResponse(result);
  } catch (purchaseErr) {
    const msg =
      purchaseErr instanceof TwilioProvisioningError
        ? purchaseErr.message
        : `Twilio IncomingPhoneNumbers.create failed for ${found.phoneNumber}: ${
            purchaseErr instanceof Error ? purchaseErr.message : String(purchaseErr)
          }`;
    await markFailure(sb, businessId, 'purchase', msg);
    throw new TwilioProvisioningError('purchase', msg);
  }

  // ── (5) Persist to DB. Rollback the Twilio purchase on failure.
  try {
    await markProvisioned(sb, businessId, purchased.phoneNumber, purchased.sid);
  } catch (persistErr: any) {
    const originalMsg = persistErr?.message ?? String(persistErr);
    let releaseSucceeded = false;
    try {
      await client.incomingPhoneNumbers(purchased.sid).remove();
      releaseSucceeded = true;
    } catch (releaseErr: any) {
      // Loud — admin needs to know there's a paid-for DID with no
      // corresponding business_configs row.
      console.error(
        `[twilio-provisioning] ORPHAN: failed to release ${purchased.sid} (${purchased.phoneNumber}) after persistence failure for business_id=${businessId}.`,
        'Release error:', releaseErr?.message ?? releaseErr,
        '| Original persistence error:', originalMsg,
      );
    }

    const finalMsg = releaseSucceeded
      ? originalMsg
      : `ORPHAN: ${purchased.sid}: ${originalMsg}`;
    await markFailure(sb, businessId, 'persistence', finalMsg);
    throw new TwilioProvisioningError('persistence', finalMsg, purchased.sid);
  }

  // ── (6) Done.
  return {
    phoneNumber: purchased.phoneNumber,
    twilioSid: purchased.sid,
    areaCode: found.areaCode,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Tiny helper exported for tests

/**
 * Extract a 3-digit area code from an E.164 US number. Returns
 * 'TOLLFREE' if the number's NPA is one of the US toll-free codes,
 * 'UNKNOWN' if the input can't be parsed.
 *
 * Used only for the idempotent return path (we don't store
 * provisioning_area_code on the original purchase row's success in a
 * way we can re-read here without an extra DB hop).
 */
export function deriveAreaCodeFromE164(e164: string): string {
  // Strip everything but digits, drop leading country code (1) for US.
  const digits = e164.replace(/\D/g, '');
  const us = digits.startsWith('1') && digits.length === 11 ? digits.slice(1) : digits;
  if (us.length !== 10) return 'UNKNOWN';
  const npa = us.slice(0, 3);
  // US toll-free NPAs per NANPA.
  if (['800', '833', '844', '855', '866', '877', '888'].includes(npa)) return 'TOLLFREE';
  return npa;
}
