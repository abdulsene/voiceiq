/**
 * Sprint 2 integration tests — provisioning + reconciliation.
 *
 * Covers the 8 audit risks identified in the Sprint 2 audit:
 *   #1 race conditions             — describe('Audit risk #1 …')
 *   #2 partial Twilio responses    — describe('Audit risk #2 …')
 *   #3 orphan handling             — describe('Audit risk #3 …')
 *   #4 webhook misconfiguration    — describe('Audit risk #4 …')
 *   #6 error sanitization          — describe('Audit risk #6 …')
 *   #7 state machine integrity     — describe('Audit risk #7 …')
 *   #8 idempotency edge cases      — describe('Audit risk #8 …')
 * Plus core happy/idempotency paths and soft-fail behaviour.
 *
 * Tests run against the in-memory mocks in `./helpers/twilio-mock.ts`
 * and `./helpers/supabase-mock.ts`, wired through the production
 * code's existing `_setTwilioClientForTests` / `_setSupabaseClientForTests`
 * hooks. No live Twilio, no live Supabase.
 *
 * HTTP-level tests (signup soft-fail + voice webhook routing) live as
 * `it.todo` entries — see "Voice webhook routing" and "Soft-fail
 * behaviour" describes for the infrastructure each one requires.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  provisionTwilioNumberForBusiness,
  TwilioProvisioningError,
  _setTwilioClientForTests as setProvisioningTwilioForTests,
  _setSupabaseClientForTests as setProvisioningSupabaseForTests,
} from '../lib/twilio-provisioning';
import {
  runReconciliation,
  _setTwilioClientForTests as setReconciliationTwilioForTests,
  _setSupabaseClientForTests as setReconciliationSupabaseForTests,
} from '../lib/twilio-reconciliation';
import {
  createTwilioMock,
  type TwilioMockHandle,
} from './helpers/twilio-mock';
import {
  createSupabaseMock,
  type SupabaseMockHandle,
  type RecordedSupabaseCall,
} from './helpers/supabase-mock';

// ───────────────────────────────────────────────────────────────────────
// Common fixtures

const BIZ = 'biz_test_001';
const AREA = '443';

/** A typical pre-provisioning row stub for readBusinessConfig. */
const FRESH_ROW = {
  twilio_phone_number: null,
  twilio_phone_sid: null,
  provisioning_status: 'pending',
  provisioning_area_code: null,
};

/** A row that already has a provisioned number — used for idempotency tests. */
const PROVISIONED_ROW = {
  twilio_phone_number: '+14435551234',
  twilio_phone_sid: 'PN' + 'a'.repeat(32),
  provisioning_status: 'provisioned',
  provisioning_area_code: '443',
};

/**
 * Find a recorded supabase call by (table, op) + an optional value
 * predicate. Returns the first match; useful when the test cares
 * about a specific UPDATE in a sequence.
 */
function findCall(
  calls: RecordedSupabaseCall[],
  table: string,
  op: RecordedSupabaseCall['op'],
  predicate?: (call: RecordedSupabaseCall) => boolean,
): RecordedSupabaseCall | undefined {
  return calls.find(
    (c) => c.table === table && c.op === op && (!predicate || predicate(c)),
  );
}

// ───────────────────────────────────────────────────────────────────────
// Per-test setup: env, mocks, hooks.

let twilioMock: TwilioMockHandle;
let sbMock: SupabaseMockHandle;

beforeEach(() => {
  // Sane BASE_URL for happy-path tests. Individual webhook-misconfig
  // tests override via vi.stubEnv.
  vi.stubEnv('BASE_URL', 'https://api.test.example.com');
  vi.stubEnv('NODE_ENV', 'test');
  // Required by lazy singletons inside the production modules; the
  // hooks bypass the actual `twilio(sid, token)` / createClient(url, key)
  // calls, but the env-check inside the getter still gates on these.
  vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC' + 'b'.repeat(32));
  vi.stubEnv('TWILIO_AUTH_TOKEN', 'c'.repeat(32));
  vi.stubEnv('SUPABASE_URL', 'https://stub.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'stub_service_key');

  twilioMock = createTwilioMock({
    localInventory: { [AREA]: [{ phoneNumber: '+14435551234' }] },
  });
  sbMock = createSupabaseMock();

  setProvisioningTwilioForTests(twilioMock.client as never);
  setProvisioningSupabaseForTests(sbMock.client as never);
  setReconciliationTwilioForTests(twilioMock.client as never);
  setReconciliationSupabaseForTests(sbMock.client as never);
});

afterEach(() => {
  setProvisioningTwilioForTests(undefined);
  setProvisioningSupabaseForTests(undefined);
  setReconciliationTwilioForTests(undefined);
  setReconciliationSupabaseForTests(undefined);
  vi.unstubAllEnvs();
});

// ───────────────────────────────────────────────────────────────────────
// Core happy path

describe('Core happy path', () => {
  test('provisions successfully when Twilio has inventory in requested area code', async () => {
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null }, // initial read
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 1 }, // markStarted (claim)
      { error: null }, // markProvisioned
    );

    const result = await provisionTwilioNumberForBusiness(BIZ, AREA);

    expect(result).toMatchObject({
      phoneNumber: '+14435551234',
      areaCode: '443',
    });
    expect(result.twilioSid).toMatch(/^PN/);

    // Twilio side: one local search at the requested area code, one
    // purchase. No toll-free fallback, no fallback area-code search.
    expect(twilioMock.calls.localList).toEqual([
      expect.objectContaining({ areaCode: 443 }),
    ]);
    expect(twilioMock.calls.tollFreeListCount).toBe(0);
    expect(twilioMock.calls.create).toHaveLength(1);
    expect(twilioMock.calls.create[0]).toMatchObject({
      phoneNumber: '+14435551234',
      voiceUrl: 'https://api.test.example.com/api/twilio/voice',
      statusCallback: 'https://api.test.example.com/api/twilio/status',
    });

    // DB side: row was marked 'provisioned' with both DID columns set.
    const markProvisioned = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'provisioned',
    );
    expect(markProvisioned).toBeDefined();
    expect((markProvisioned!.values as Record<string, unknown>).twilio_phone_number).toBe(
      '+14435551234',
    );
    expect((markProvisioned!.values as Record<string, unknown>).twilio_phone_sid).toMatch(/^PN/);
  });

  test('idempotency: second call returns existing number, no re-purchase', async () => {
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: PROVISIONED_ROW, error: null },
    );

    const result = await provisionTwilioNumberForBusiness(BIZ, AREA);

    expect(result.phoneNumber).toBe(PROVISIONED_ROW.twilio_phone_number);
    expect(result.twilioSid).toBe(PROVISIONED_ROW.twilio_phone_sid);
    expect(result.areaCode).toBe('443'); // derived from E.164

    // Critically: no Twilio API calls at all.
    expect(twilioMock.calls.localList).toHaveLength(0);
    expect(twilioMock.calls.create).toHaveLength(0);
    // No DB writes either.
    const updates = sbMock.calls.filter((c) => c.op === 'update');
    expect(updates).toHaveLength(0);
  });

  test.todo(
    'auto-wired signup: complete-onboarding returns new number in response — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #1: race conditions

describe('Audit risk #1: race conditions', () => {
  test('concurrent calls for same business: loser returns winner result OR throws in_progress', async () => {
    // Scenario A: loser arrives AFTER winner completed. The
    // markStarted UPDATE affects 0 rows (status now 'provisioned',
    // filter doesn't match). Re-read sees the winner's number — loser
    // returns it without re-purchasing.
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null }, // initial read (pre-claim)
      { data: PROVISIONED_ROW, error: null }, // re-read after failed claim
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 0 }, // markStarted: claim lost
    );

    const resultA = await provisionTwilioNumberForBusiness(BIZ, AREA);
    expect(resultA.phoneNumber).toBe(PROVISIONED_ROW.twilio_phone_number);
    expect(twilioMock.calls.create).toHaveLength(0); // no double-purchase

    // Scenario B: loser arrives WHILE winner still in-flight. Re-read
    // shows the row stuck in 'provisioning' with no phone — function
    // throws 'in_progress' so the caller can back off.
    sbMock.reset();
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null },
      { data: { ...FRESH_ROW, provisioning_status: 'provisioning' }, error: null },
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 0 },
    );

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'in_progress',
    });
    expect(twilioMock.calls.create).toHaveLength(0);
  });

  test('claim-row UPDATE filter constrains by claimable statuses (provisioning/provisioned excluded)', async () => {
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null },
      { data: { ...FRESH_ROW, provisioning_status: 'provisioning' }, error: null },
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 0 },
    );

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toThrow(
      TwilioProvisioningError,
    );

    // Inspect the markStarted UPDATE: it must include an `in()` filter
    // restricting provisioning_status to the claimable subset (pending
    // + the four failed_* values).
    const markStartedCall = findCall(sbMock.calls, 'business_configs', 'update');
    expect(markStartedCall).toBeDefined();
    const inFilter = markStartedCall!.filters.find((f) => f.kind === 'in');
    expect(inFilter).toBeDefined();
    const statusList = inFilter!.args[1] as readonly string[];
    expect(statusList).toEqual(
      expect.arrayContaining([
        'pending',
        'failed_no_inventory',
        'failed_purchase',
        'failed_persistence',
        'failed_webhook',
      ]),
    );
    // 'provisioning' and 'provisioned' must NOT be in the claimable set.
    expect(statusList).not.toContain('provisioning');
    expect(statusList).not.toContain('provisioned');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #2: partial Twilio responses

describe('Audit risk #2: partial Twilio responses', () => {
  function setupPurchasePath(): void {
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null }, // initial read
      { data: { provisioning_started_at: '2026-06-01T00:00:00Z' }, error: null }, // markFailure's started_at lookup
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 1 }, // markStarted claim
      { error: null }, // markFailure update
    );
  }

  test('purchase response missing sid throws TwilioProvisioningError(purchase)', async () => {
    twilioMock = createTwilioMock({
      localInventory: { [AREA]: [{ phoneNumber: '+14435551234' }] },
      purchaseBehavior: { kind: 'malformed', response: { phoneNumber: '+14435551234' } },
    });
    setProvisioningTwilioForTests(twilioMock.client as never);
    setupPurchasePath();

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'purchase',
      message: expect.stringMatching(/missing or invalid sid/i),
    });
  });

  test('purchase response missing phoneNumber throws TwilioProvisioningError(purchase)', async () => {
    twilioMock = createTwilioMock({
      localInventory: { [AREA]: [{ phoneNumber: '+14435551234' }] },
      purchaseBehavior: { kind: 'malformed', response: { sid: 'PN' + 'a'.repeat(32) } },
    });
    setProvisioningTwilioForTests(twilioMock.client as never);
    setupPurchasePath();

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'purchase',
      message: expect.stringMatching(/missing or invalid phoneNumber/i),
    });
  });

  test('purchase response with non-E.164 phoneNumber throws TwilioProvisioningError(purchase)', async () => {
    twilioMock = createTwilioMock({
      localInventory: { [AREA]: [{ phoneNumber: '+14435551234' }] },
      purchaseBehavior: {
        kind: 'malformed',
        response: { sid: 'PN' + 'a'.repeat(32), phoneNumber: '4435551234' /* no + */ },
      },
    });
    setProvisioningTwilioForTests(twilioMock.client as never);
    setupPurchasePath();

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'purchase',
      message: expect.stringMatching(/missing or invalid phoneNumber/i),
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #3: orphan handling (reconciliation)

describe('Audit risk #3: orphan handling (reconciliation)', () => {
  test('reconciliation finds orphan and releases when older than threshold', async () => {
    const orphanSid = 'PN' + 'd'.repeat(32);
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    twilioMock = createTwilioMock({
      listAll: [
        { sid: orphanSid, phoneNumber: '+14435559999', dateCreated: fortyEightHoursAgo },
      ],
    });
    setReconciliationTwilioForTests(twilioMock.client as never);
    sbMock.setResponses('business_configs', 'select', { data: [], error: null });
    sbMock.setResponses('reconciliation_reports', 'insert', { error: null });

    const report = await runReconciliation({
      autoRelease: true,
      autoReleaseMinAgeHours: 24,
    });

    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0]).toMatchObject({
      sid: orphanSid,
      phoneNumber: '+14435559999',
      autoReleased: true,
    });
    expect(report.orphansAutoReleasedCount).toBe(1);
    expect(twilioMock.calls.remove).toEqual([orphanSid]);
  });

  test('reconciliation reports orphan but skips release when younger than threshold', async () => {
    const orphanSid = 'PN' + 'e'.repeat(32);
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    twilioMock = createTwilioMock({
      listAll: [
        { sid: orphanSid, phoneNumber: '+14435559998', dateCreated: oneHourAgo },
      ],
    });
    setReconciliationTwilioForTests(twilioMock.client as never);
    sbMock.setResponses('business_configs', 'select', { data: [], error: null });
    sbMock.setResponses('reconciliation_reports', 'insert', { error: null });

    const report = await runReconciliation({
      autoRelease: true,
      autoReleaseMinAgeHours: 24,
    });

    expect(report.orphans).toHaveLength(1);
    expect(report.orphans[0].autoReleased).toBe(false);
    expect(report.orphansAutoReleasedCount).toBe(0);
    // Critically: no release call fired.
    expect(twilioMock.calls.remove).toEqual([]);
  });

  test('reconciliation persists report to reconciliation_reports table', async () => {
    twilioMock = createTwilioMock({
      listAll: [
        {
          sid: 'PN' + 'f'.repeat(32),
          phoneNumber: '+14435559997',
          dateCreated: new Date(Date.now() - 48 * 60 * 60 * 1000),
        },
      ],
    });
    setReconciliationTwilioForTests(twilioMock.client as never);
    sbMock.setResponses('business_configs', 'select', { data: [], error: null });
    sbMock.setResponses('reconciliation_reports', 'insert', { error: null });

    await runReconciliation({ autoRelease: true, autoReleaseMinAgeHours: 24 });

    const insertCall = findCall(sbMock.calls, 'reconciliation_reports', 'insert');
    expect(insertCall).toBeDefined();
    const row = insertCall!.values as Record<string, unknown>;
    expect(row).toMatchObject({
      twilio_numbers_count: 1,
      db_numbers_count: 0,
      orphans_count: 1,
      ghosts_count: 0,
      orphans_auto_released_count: 1,
    });
    expect(typeof row.run_at).toBe('string');
    expect(typeof row.run_duration_ms).toBe('number');

    // dryRun must NOT persist — sanity check the other half.
    sbMock.reset();
    sbMock.setResponses('business_configs', 'select', { data: [], error: null });
    twilioMock = createTwilioMock({ listAll: [] });
    setReconciliationTwilioForTests(twilioMock.client as never);

    await runReconciliation({ dryRun: true });
    const inserts = sbMock.calls.filter(
      (c) => c.table === 'reconciliation_reports' && c.op === 'insert',
    );
    expect(inserts).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #4: webhook misconfiguration

describe('Audit risk #4: webhook misconfiguration', () => {
  test('BASE_URL http (not https) throws TwilioProvisioningError(webhook) before Twilio call', async () => {
    vi.stubEnv('BASE_URL', 'http://api.test.example.com');
    sbMock.setResponses('business_configs', 'select',
      { data: FRESH_ROW, error: null },
      { data: { provisioning_started_at: null }, error: null }, // markFailure's started_at read
    );
    sbMock.setResponses('business_configs', 'update', { error: null });

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'webhook',
      message: expect.stringMatching(/https:\/\/ scheme/),
    });
    // No Twilio API calls at all.
    expect(twilioMock.calls.localList).toHaveLength(0);
    expect(twilioMock.calls.create).toHaveLength(0);
  });

  test('BASE_URL with localhost in NODE_ENV=production throws', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('BASE_URL', 'https://localhost:8080');
    sbMock.setResponses('business_configs', 'select',
      { data: FRESH_ROW, error: null },
      { data: { provisioning_started_at: null }, error: null },
    );
    sbMock.setResponses('business_configs', 'update', { error: null });

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'webhook',
      message: expect.stringMatching(/localhost\/127\.0\.0\.1/),
    });
    expect(twilioMock.calls.create).toHaveLength(0);
  });

  test('BASE_URL empty (neither BASE_URL nor API_URL set): returns failed_webhook', async () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('API_URL', '');
    sbMock.setResponses('business_configs', 'select',
      { data: FRESH_ROW, error: null },
      { data: { provisioning_started_at: null }, error: null },
    );
    sbMock.setResponses('business_configs', 'update', { error: null });

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toMatchObject({
      name: 'TwilioProvisioningError',
      subcode: 'webhook',
      message: expect.stringMatching(/BASE_URL not configured/),
    });

    // markFailure UPDATE wrote failed_webhook with a sanitized error
    // message — verify both.
    const markFailure = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'failed_webhook',
    );
    expect(markFailure).toBeDefined();
    expect((markFailure!.values as Record<string, unknown>).provisioning_error).toContain(
      'BASE_URL not configured',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #6: error message sanitization

describe('Audit risk #6: error message sanitization', () => {
  function setupFailingPurchase(error: Error): void {
    twilioMock = createTwilioMock({
      localInventory: { [AREA]: [{ phoneNumber: '+14435551234' }] },
      purchaseBehavior: { kind: 'throw', error },
    });
    setProvisioningTwilioForTests(twilioMock.client as never);
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null },
      { data: { provisioning_started_at: '2026-06-01T00:00:00Z' }, error: null },
    );
    sbMock.setResponses(
      'business_configs',
      'update',
      { error: null, count: 1 }, // markStarted claim
      { error: null }, // markFailure
    );
  }

  test('Twilio error containing AC<32hex> is redacted to AC[REDACTED]', async () => {
    const realSid = 'AC' + 'a'.repeat(32);
    setupFailingPurchase(new Error(`Account ${realSid} is not authorized to purchase this number`));

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toThrow(
      TwilioProvisioningError,
    );

    const markFailure = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'failed_purchase',
    );
    expect(markFailure).toBeDefined();
    const persistedError = (markFailure!.values as Record<string, unknown>)
      .provisioning_error as string;
    expect(persistedError).not.toContain(realSid);
    expect(persistedError).toContain('AC[REDACTED]');
  });

  test('Standalone 32-char hex (auth-token shape) is redacted to [REDACTED]', async () => {
    const fakeToken = 'deadbeef'.repeat(4); // 32 hex chars, no AC prefix
    setupFailingPurchase(new Error(`Authentication failed with token ${fakeToken} for this account`));

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toThrow(
      TwilioProvisioningError,
    );

    const markFailure = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'failed_purchase',
    );
    const persistedError = (markFailure!.values as Record<string, unknown>)
      .provisioning_error as string;
    expect(persistedError).not.toContain(fakeToken);
    expect(persistedError).toContain('[REDACTED]');
  });

  test('Long error message is truncated to 500 characters (ending in "...")', async () => {
    const longMsg = 'x'.repeat(800);
    setupFailingPurchase(new Error(longMsg));

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toThrow(
      TwilioProvisioningError,
    );

    const markFailure = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'failed_purchase',
    );
    const persistedError = (markFailure!.values as Record<string, unknown>)
      .provisioning_error as string;
    expect(persistedError.length).toBe(500);
    expect(persistedError.endsWith('...')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #7: state machine integrity

describe('Audit risk #7: state machine integrity', () => {
  test('BASE_URL precondition path: row ends in failed_webhook with started_at backfilled', async () => {
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('API_URL', '');
    sbMock.setResponses(
      'business_configs',
      'select',
      { data: FRESH_ROW, error: null }, // initial read
      // markFailure's started_at read: NULL since markStarted didn't run
      { data: { provisioning_started_at: null }, error: null },
    );
    sbMock.setResponses('business_configs', 'update', { error: null });

    await expect(provisionTwilioNumberForBusiness(BIZ, AREA)).rejects.toThrow(
      TwilioProvisioningError,
    );

    const markFailure = findCall(
      sbMock.calls,
      'business_configs',
      'update',
      (c) =>
        !!c.values &&
        typeof c.values === 'object' &&
        (c.values as Record<string, unknown>).provisioning_status === 'failed_webhook',
    );
    expect(markFailure).toBeDefined();
    const values = markFailure!.values as Record<string, unknown>;
    expect(values.provisioning_status).toBe('failed_webhook');
    // The Batch A fix: markFailure backfilled started_at because it
    // saw null. Without this fix, started_at would be missing and
    // migration 018's CHECK constraint would have rejected the row.
    expect(typeof values.provisioning_started_at).toBe('string');
    expect(values.provisioning_completed_at).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Audit risk #8: idempotency with a different requested area code

describe('Audit risk #8: idempotency with different area code', () => {
  test('provision(443) then provision(617): returns existing 443 number and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    sbMock.setResponses(
      'business_configs',
      'select',
      { data: PROVISIONED_ROW, error: null }, // already provisioned for 443
    );

    const result = await provisionTwilioNumberForBusiness(BIZ, '617');

    expect(result.phoneNumber).toBe(PROVISIONED_ROW.twilio_phone_number);
    expect(result.areaCode).toBe('443'); // derived from the stored 443 number
    expect(twilioMock.calls.create).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Idempotency hit for biz_test_001.*requested area code 617/),
    );
    warnSpy.mockRestore();
  });
});

// ───────────────────────────────────────────────────────────────────────
// Soft-fail behaviour

describe('Soft-fail behaviour', () => {
  test.todo(
    'signup soft-fail: complete-onboarding returns 200 with neverr_phone=null + provisioning_status set — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );

  test.todo(
    'welcome SMS variant: failed provisioning sends "being set up" message not "live, forward to X" — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );

  test('contract: TwilioProvisioningError has subcode + message fields that auth.ts soft-fail consumes', async () => {
    // Auth.ts catch block reads err.subcode and err.message off
    // TwilioProvisioningError. This test pins the contract: every
    // failure path throws an instance with both fields populated.
    vi.stubEnv('BASE_URL', '');
    vi.stubEnv('API_URL', '');
    sbMock.setResponses('business_configs', 'select',
      { data: FRESH_ROW, error: null },
      { data: { provisioning_started_at: null }, error: null },
    );
    sbMock.setResponses('business_configs', 'update', { error: null });

    try {
      await provisionTwilioNumberForBusiness(BIZ, AREA);
      throw new Error('Expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TwilioProvisioningError);
      const e = err as TwilioProvisioningError;
      expect(e.subcode).toBe('webhook');
      expect(typeof e.message).toBe('string');
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// Voice webhook routing

describe('Voice webhook routing', () => {
  test.todo(
    'known DID: To matches business_configs.twilio_phone_number → resolves business_id correctly — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );

  test.todo(
    'shared support DID: To matches process.env.TWILIO_PHONE_NUMBER → routes to demo-business — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );

  test.todo(
    'unknown DID: responds with TwiML hangup, logs warning — HTTP-LEVEL (see "Flagged HTTP-level tests" in suite header)',
  );
});

/*
 * ─── Flagged HTTP-level tests ──────────────────────────────────────────
 *
 * Five tests are marked test.todo (above) because they exercise Express
 * route handlers, not pure functions. Implementing them properly
 * requires either:
 *
 *   (a) supertest + module-level vi.mock for:
 *         - '@supabase/supabase-js' (createClient → mock client)
 *         - '../sms' (sendSMS → spyable mock)
 *         - '../lib/twilio-provisioning' (provisionTwilioNumberForBusiness)
 *         - '../scraping', '../agents', etc. (auth.ts dependency chain)
 *         - global fetch (for ElevenLabs in api.ts)
 *       Plus mounting just the relevant router onto a fresh Express()
 *       instance — importing app.ts pulls Sentry init + module-load
 *       env checks that aren't worth fighting in unit tests.
 *
 *   (b) Refactoring auth.ts / api.ts to extract the handler logic
 *       into testable named functions. Out of scope per the user
 *       brief ("don't refactor production code beyond exposing test
 *       hooks").
 *
 * The contract test above ("TwilioProvisioningError has subcode +
 * message fields …") partially covers the auth.ts side by verifying
 * the failure shape that auth.ts's catch block consumes. The voice
 * routing logic is mechanical (`.eq('twilio_phone_number', To)` +
 * fallback chain) and is best validated via a real end-to-end smoke
 * test against the deployed api-server with a known DID dialed from
 * a phone.
 */
