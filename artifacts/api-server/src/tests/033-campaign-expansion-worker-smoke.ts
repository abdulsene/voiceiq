/**
 * Phase 2.4 — campaign expansion worker smoke. 13 cases.
 *
 * Exercises runCampaignExpansionSweep against a FakeSupabaseClient.
 * The worker composes placeCall internally; we use the existing
 * __setProviderFactoryForTesting seam from place-call.ts to control
 * provider behavior, and mock all DB tables (outbound_campaigns,
 * outbound_campaign_leads, leads, appointments, business_configs,
 * dnc_list, voice_consent_records, lead_calls, lead_activities,
 * audit_logs) at the FakeSupabaseClient layer.
 *
 *   T1  Happy path: 1 active campaign, 3 eligible leads, all → state='scheduled'
 *   T2  Lock contention — campaign with expansion_running=true is filtered
 *       at SELECT time (eq("expansion_running", false))
 *   T3  No active campaigns → worker no-ops with zero summary fields
 *   T4  Empty segment → release lock, bump last_expansion_at, no junction rows
 *   T5  Segment resolver returns error → Sentry + lock released + target_count
 *       UNCHANGED + no junction writes
 *   T6  Lead absent from schedule map → UPSERT state='skipped',
 *       skip_reason='no_matching_anchor'
 *   T7  Lead fails eligibility (DNC) → UPSERT state='skipped', skip_reason='dnc'
 *   T8  Existing junction in 'scheduled' state → SKIP ENTIRELY (no UPSERT,
 *       no placeCall, no eligibility lookup)
 *   T9  placeCall returns daily_cap_exceeded → UPSERT state='skipped',
 *       skip_reason='daily_cap'. Worker CONTINUES with remaining leads.
 *   T10 placeCall returns provider_failed → UPSERT state='skipped',
 *       skip_reason='provider_failed'. Continues.
 *   T11 Campaign daily_cap reached mid-iteration → subsequent leads on
 *       the SAME target day skip with skip_reason='campaign_daily_cap'.
 *       Cap cache is per-day; in-memory increment after each scheduled.
 *   T12 Pending-first verified: junction is UPSERTed with state='pending'
 *       BEFORE placeCall, then UPSERTed to 'scheduled' after success.
 *   T13 Existing junction in 'pending' state → eligibility lookup is
 *       SKIPPED (resume path). placeCall fires directly. Verifies the R5
 *       reorder + the resume-path short-circuit.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/033-campaign-expansion-worker-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { runCampaignExpansionSweep } from "../cron";
import { __setProviderFactoryForTesting } from "../lib/outbound-voice/place-call";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient ────────────────────────────────────────────────

type FakeCall = {
  op: "select" | "insert" | "update" | "upsert";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  inFilters: Array<{ column: string; value: any[] }>;
  isFilters: Array<{ column: string; value: any }>;
  notFilters: Array<{ column: string; op: string; value: any }>;
  gteFilters: Array<{ column: string; value: any }>;
  ltFilters: Array<{ column: string; value: any }>;
  countMode?: "exact" | "planned" | "estimated";
  headMode?: boolean;
  payload?: any;
  upsertOpts?: { onConflict?: string };
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  count?: number | null;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  select(cols: string, opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    this.call.selectColumns = cols;
    if (opts?.count) this.call.countMode = opts.count;
    if (opts?.head) this.call.headMode = opts.head;
    return this;
  }
  insert(payload: any) { this.call.op = "insert"; this.call.payload = payload; return this; }
  update(payload: any) { this.call.op = "update"; this.call.payload = payload; return this; }
  upsert(payload: any, opts?: { onConflict?: string }) {
    this.call.op = "upsert";
    this.call.payload = payload;
    this.call.upsertOpts = opts;
    return this;
  }
  eq(c: string, v: any) { this.call.eqFilters.push({ column: c, value: v }); return this; }
  neq() { return this; }
  in(c: string, v: any[]) { this.call.inFilters.push({ column: c, value: v }); return this; }
  is(c: string, v: any) { this.call.isFilters.push({ column: c, value: v }); return this; }
  not(c: string, op: string, v: any) { this.call.notFilters.push({ column: c, op, value: v }); return this; }
  gte(c: string, v: any) { this.call.gteFilters.push({ column: c, value: v }); return this; }
  lt(c: string, v: any) { this.call.ltFilters.push({ column: c, value: v }); return this; }
  lte() { return this; }
  gt() { return this; }
  or() { return this; }
  order() { return this; }
  limit() { return this; }
  async maybeSingle() { return this.fake.resolveCall(this.call); }
  async single() { return this.fake.resolveCall(this.call); }
  then(resolve: any, reject: any) { return this.fake.resolveCall(this.call).then(resolve, reject); }
  catch(handler: any) { return this.fake.resolveCall(this.call).catch(handler); }
}

class FakeSupabaseClient {
  responses: FakeResponse[] = [];
  calls: FakeCall[] = [];
  on(match: FakeResponse["match"], spec: Omit<FakeResponse, "match">) {
    this.responses.push({ match, ...spec });
  }
  from(table: string) {
    const call: FakeCall = {
      op: "select",
      table,
      selectColumns: "",
      eqFilters: [],
      inFilters: [],
      isFilters: [],
      notFilters: [],
      gteFilters: [],
      ltFilters: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, count: null, error: null };
    return {
      data: r.data ?? null,
      count: r.count ?? null,
      error: r.error ?? null,
    };
  }
  auth = { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Provider mock (placeCall delegates to provider via the seam) ─────

const placeCallInvocations: Array<{ providerKind: string; opts: any }> = [];
let providerShouldFail: { kind: string; error: string; twilioCode?: number } | null = null;

__setProviderFactoryForTesting((kind: any) => ({
  async placeCall(opts: any) {
    placeCallInvocations.push({ providerKind: kind, opts });
    if (providerShouldFail && providerShouldFail.kind === kind) {
      return { ok: false, provider: kind, error: providerShouldFail.error, twilioCode: providerShouldFail.twilioCode };
    }
    return { ok: true, provider: kind, callSid: `CA_${kind}_${placeCallInvocations.length}` };
  },
} as any));

// ── Env sentinels ────────────────────────────────────────────────────

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven";
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app";

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_033";
const CAMPAIGN = "00000000-0000-0000-0000-000000000c44";
const LEAD_1 = "00000000-0000-0000-0000-000000033001";
const LEAD_2 = "00000000-0000-0000-0000-000000033002";
const LEAD_3 = "00000000-0000-0000-0000-000000033003";
const PHONE_1 = "+12025557701";
const PHONE_2 = "+12025557702";
const PHONE_3 = "+12025557703";

function campaignRow(opts: { dailyCap?: number | null; targetCount?: number; segmentDef?: any; scheduleDef?: any } = {}) {
  return {
    id: CAMPAIGN,
    business_id: BIZ,
    call_objective: "appointment_reminder",
    segment_definition: opts.segmentDef ?? { version: 1, filters: {} },
    schedule_definition: opts.scheduleDef ?? {
      version: 1,
      strategy: "bulk",
      fire_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    schedule_strategy: "bulk",
    daily_cap: opts.dailyCap ?? null,
    target_count: opts.targetCount ?? 0,
  };
}

// Stage the "happy" supporting tables: leads, business_configs (twice
// — once for placeCall's outbound provider read, once for compliance),
// dnc_list (empty), voice_consent_records (empty), business_configs
// for consent default + calling hours.
function stageSupportingTablesHappy(fake: FakeSupabaseClient, leadIds: string[]) {
  // Leads batch (.in() filter — used by the worker's batch read).
  // Also needs to respond to placeCall's per-lead cross-tenant guard
  // SELECT which uses .eq("id", leadId).
  const leadRows = leadIds.map((id, i) => ({
    id,
    business_id: BIZ,
    contact_phone: [PHONE_1, PHONE_2, PHONE_3][i] || `+1202555000${i}`,
    contact_name: `Lead ${i + 1}`,
    reason: "T033",
  }));
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "leads" &&
      c.selectColumns.includes("contact_phone") &&
      c.inFilters.some((f) => f.column === "id"),
    { data: leadRows.map((r) => ({ id: r.id, contact_phone: r.contact_phone })) },
  );
  // placeCall lead lookup per leadId (eq("id", leadId)).
  for (const r of leadRows) {
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.eqFilters.some((f) => f.column === "id" && f.value === r.id),
      { data: r },
    );
  }
  // business_configs — placeCall's outbound provider config.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    {
      data: {
        outbound_voice_enabled: true,
        outbound_provider: "elevenlabs_hosted",
        record_outbound_calls: true,
        agent_id: "agent_test_033",
        business_name: "T033 Biz",
        twilio_phone_number: "+14155556677",
        elevenlabs_phone_number_id: "phnum_test_033",
        max_outbound_calls_per_day: null,
      },
    },
  );
  // business_configs — calling hours (for checkCallingHours + checkCompliance).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_calling_hours_start"),
    {
      data: {
        outbound_voice_enabled: true,
        outbound_calling_hours_start: "00:00:00",
        outbound_calling_hours_end: "23:59:00",
        outbound_calling_hours_days: [1, 2, 3, 4, 5, 6, 7],
      },
    },
  );
  // business_configs — voice_consent_default for checkVoiceConsent fallback.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  // checkDnc reads leads.do_not_call.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("do_not_call"),
    { data: { do_not_call: false } },
  );
  // dnc_list (empty).
  fake.on(
    (c) => c.op === "select" && c.table === "dnc_list",
    { data: null },
  );
  // voice_consent_records (empty).
  fake.on(
    (c) => c.op === "select" && c.table === "voice_consent_records",
    { data: null },
  );
  // placeCall pre-insert into lead_calls.
  fake.on(
    (c) => c.op === "insert" && c.table === "lead_calls",
    { data: { id: "lc_t033_new" } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "lead_calls",
    { data: null },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });
  // outbound_campaign_leads UPSERT.
  fake.on(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads",
    { data: null },
  );
  // outbound_campaign_leads existing batch read returns no rows (fresh).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.selectColumns.includes("state") &&
      c.eqFilters.some((f) => f.column === "campaign_id"),
    { data: [] },
  );
  // outbound_campaign_leads already_in_campaign check (per-lead via
  // .eq("campaign_id").eq("lead_id").in("state", ...)) returns null.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.eqFilters.some((f) => f.column === "lead_id") &&
      c.inFilters.some((f) => f.column === "state"),
    { data: null },
  );
  // Lock acquisition UPDATE on outbound_campaigns.
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  // Lock release UPDATE.
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // SELECT active+unlocked campaigns returns 1.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status" && f.value === "active"),
    { data: [campaignRow()] },
  );
  // Segment lookup against leads — returns 3 lead ids.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "leads" &&
      c.selectColumns === "id" &&
      c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }, { id: LEAD_2 }, { id: LEAD_3 }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1, LEAD_2, LEAD_3]);

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.campaignsProcessed !== 1) failures.push(`campaignsProcessed=${r.campaignsProcessed}`);
  if (r.scheduled !== 3) failures.push(`scheduled=${r.scheduled}`);
  if (r.skipped !== 0) failures.push(`skipped=${r.skipped}`);
  // NOTE: provider is NOT invoked for scheduled-future calls. placeCall
  // short-circuits at step 7 with status='scheduled' and never reaches
  // the provider. The 1.5b fire-time worker invokes the provider later.
  // What we verify here: lead_calls INSERTs happened (3 pre-inserts).
  const leadCallInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (leadCallInserts.length !== 3) failures.push(`lead_calls inserts=${leadCallInserts.length}`);
  // Verify final lock release UPDATE with target_count bumped + last_expansion_at set.
  const releaseUpd = fake.calls.find(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
  );
  if (releaseUpd?.payload?.target_count !== 3) failures.push(`target_count=${releaseUpd?.payload?.target_count}`);
  if (!releaseUpd?.payload?.last_expansion_at) failures.push("missing last_expansion_at");
  record("T1 happy path — 3 eligible leads all scheduled", failures.length === 0, failures.join("; ") || "3 scheduled, 3 lead_calls inserts, target_count bumped, lock released");
}

async function T2() {
  // Lock contention — already-locked campaigns are filtered at SELECT
  // by eq("expansion_running", false). Stage SELECT returning empty.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaigns" &&
      c.eqFilters.some((f) => f.column === "expansion_running" && f.value === false),
    { data: [] },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.campaignsProcessed !== 0) failures.push(`campaignsProcessed=${r.campaignsProcessed}`);
  // SELECT filter included expansion_running=false; confirm.
  const selCall = fake.calls.find((c) => c.op === "select" && c.table === "outbound_campaigns");
  if (!selCall?.eqFilters.some((f) => f.column === "expansion_running" && f.value === false))
    failures.push("missing eq(expansion_running, false) filter");
  if (placeCallInvocations.length !== 0) failures.push("provider invoked");
  record("T2 lock contention — filtered at SELECT", failures.length === 0, failures.join("; ") || "no campaigns selected, no placeCall");
}

async function T3() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    { data: [] },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const ok =
    r.campaignsProcessed === 0 &&
    r.campaignsLocked === 0 &&
    r.scheduled === 0 &&
    r.skipped === 0 &&
    placeCallInvocations.length === 0;
  record("T3 no active campaigns → no-op", ok, JSON.stringify(r));
}

async function T4() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  // Segment returns empty leads array.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "leads" &&
      c.selectColumns === "id" &&
      c.eqFilters.some((f) => f.column === "business_id"),
    { data: [] },
  );
  // Lock acquisition.
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  // Lock release.
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.scheduled !== 0) failures.push(`scheduled=${r.scheduled}`);
  if (r.skipped !== 0) failures.push(`skipped=${r.skipped}`);
  // No junction UPSERTs.
  const upserts = fake.calls.filter((c) => c.op === "upsert" && c.table === "outbound_campaign_leads");
  if (upserts.length !== 0) failures.push(`unexpected ${upserts.length} junction upserts`);
  // Lock release with last_expansion_at + target_count unchanged at 0.
  const releaseUpd = fake.calls.find(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
  );
  if (releaseUpd?.payload?.target_count !== 0) failures.push(`target_count=${releaseUpd?.payload?.target_count}`);
  if (!releaseUpd?.payload?.last_expansion_at) failures.push("missing last_expansion_at");
  record("T4 empty segment → lock released, no upserts", failures.length === 0, failures.join("; ") || "0 upserts, lock released with target_count=0");
}

async function T5() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    {
      data: [campaignRow({ segmentDef: { version: 1, filters: { all: [{ field: "leads.bad", op: "eq", value: "x" }] } } })],
    },
  );
  // Lock acquisition.
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  // Segment parsing fails (leads.bad not in ALLOWED_FIELDS) → no scheduled, no skipped.
  if (r.scheduled !== 0) failures.push(`scheduled=${r.scheduled}`);
  if (r.skipped !== 0) failures.push(`skipped=${r.skipped}`);
  if (placeCallInvocations.length !== 0) failures.push(`placeCalls=${placeCallInvocations.length}`);
  // target_count UNCHANGED.
  const releaseUpd = fake.calls.find(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
  );
  if (releaseUpd?.payload?.target_count !== 0) failures.push(`target_count=${releaseUpd?.payload?.target_count} (expected unchanged 0)`);
  record("T5 segment parse error → lock released, target_count UNCHANGED", failures.length === 0, failures.join("; ") || "no leads processed, lock released, target_count=0");
}

async function T6() {
  // Lead absent from schedule map. We force absence by providing a
  // time_relative schedule with no matching appointments.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  const futureAppt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    {
      data: [campaignRow({
        scheduleDef: {
          version: 1,
          strategy: "time_relative",
          anchor: {
            table: "appointments",
            field: "appointment_datetime",
            lead_join: "lead_id",
            filter: { status: "confirmed" },
          },
          offset_minutes: -60,
        },
      })],
    },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }] },
  );
  // Appointments lookup returns empty.
  fake.on(
    (c) => c.op === "select" && c.table === "appointments",
    { data: [] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.eqFilters.some((f) => f.column === "campaign_id") && c.selectColumns.includes("state"),
    { data: [] },
  );
  // leads batch read.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("contact_phone") && c.inFilters.some((f) => f.column === "id"),
    { data: [{ id: LEAD_1, contact_phone: PHONE_1 }] },
  );
  fake.on(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads",
    { data: null },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );
  // Suppress unused param warning for fixture (futureAppt would be used by a confirmed appt).
  void futureAppt;

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.skipped !== 1) failures.push(`skipped=${r.skipped}`);
  if (placeCallInvocations.length !== 0) failures.push("placeCall invoked despite no schedule");
  // UPSERT junction with skip_reason='no_matching_anchor'.
  const upsert = fake.calls.find(
    (c) =>
      c.op === "upsert" &&
      c.table === "outbound_campaign_leads" &&
      c.payload?.skip_reason === "no_matching_anchor",
  );
  if (!upsert) failures.push("missing junction UPSERT with skip_reason='no_matching_anchor'");
  record("T6 lead absent from schedule → skipped/no_matching_anchor", failures.length === 0, failures.join("; ") || "junction UPSERTed with no_matching_anchor");
}

async function T7() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }] },
  );
  // outbound_campaign_leads batch — no existing junction.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns.includes("state") && c.eqFilters.some((f) => f.column === "campaign_id"),
    { data: [] },
  );
  // leads batch.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("contact_phone") && c.inFilters.some((f) => f.column === "id"),
    { data: [{ id: LEAD_1, contact_phone: PHONE_1 }] },
  );
  // already_in_campaign check returns null (lead is fresh).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.eqFilters.some((f) => f.column === "lead_id") &&
      c.inFilters.some((f) => f.column === "state"),
    { data: null },
  );
  // checkCallingHours business_configs read.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    {
      data: {
        outbound_voice_enabled: true,
        outbound_calling_hours_start: "00:00:00",
        outbound_calling_hours_end: "23:59:00",
        outbound_calling_hours_days: [1, 2, 3, 4, 5, 6, 7],
      },
    },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  // checkDnc → leads.do_not_call=false but dnc_list has a row → blocked.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("do_not_call"),
    { data: { do_not_call: false } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "dnc_list",
    { data: { source: "manual", reason: "customer_request", created_at: "2026-06-01T00:00:00Z" } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "voice_consent_records",
    { data: null },
  );
  fake.on(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads",
    { data: null },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.skipped !== 1) failures.push(`skipped=${r.skipped}`);
  if (placeCallInvocations.length !== 0) failures.push("placeCall invoked despite DNC");
  const upsert = fake.calls.find(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads" && c.payload?.skip_reason === "dnc",
  );
  if (!upsert) failures.push("missing junction UPSERT with skip_reason='dnc'");
  record("T7 lead in DNC → skipped/dnc", failures.length === 0, failures.join("; ") || "junction UPSERTed with skip_reason=dnc");
}

async function T8() {
  // Existing junction in 'scheduled' state — SKIP entirely.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }] },
  );
  // Existing junction batch returns a 'scheduled' row.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns.includes("state") && c.eqFilters.some((f) => f.column === "campaign_id"),
    { data: [{ lead_id: LEAD_1, state: "scheduled" }] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("contact_phone") && c.inFilters.some((f) => f.column === "id"),
    { data: [{ id: LEAD_1, contact_phone: PHONE_1 }] },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === true,
    { data: { id: CAMPAIGN } },
  );
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns" && c.payload?.expansion_running === false,
    { data: null },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.scheduled !== 0) failures.push(`scheduled=${r.scheduled}`);
  if (r.skipped !== 0) failures.push(`skipped=${r.skipped}`);
  // No placeCall.
  if (placeCallInvocations.length !== 0) failures.push(`placeCall invoked ${placeCallInvocations.length}x`);
  // No UPSERTs on outbound_campaign_leads.
  const upserts = fake.calls.filter((c) => c.op === "upsert" && c.table === "outbound_campaign_leads");
  if (upserts.length !== 0) failures.push(`${upserts.length} unexpected junction UPSERTs (existing scheduled should preserve)`);
  // No eligibility lookup (no SELECT on outbound_campaign_leads with .in("state",...)).
  const eligLookups = fake.calls.filter(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.eqFilters.some((f) => f.column === "lead_id") &&
      c.inFilters.some((f) => f.column === "state"),
  );
  if (eligLookups.length !== 0) failures.push(`${eligLookups.length} unexpected eligibility lookups`);
  record("T8 existing scheduled junction → SKIP entirely", failures.length === 0, failures.join("; ") || "no UPSERT, no placeCall, no eligibility");
}

async function T9() {
  // placeCall returns daily_cap_exceeded for the FIRST lead. Loop continues.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }, { id: LEAD_2 }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1, LEAD_2]);
  // Override business_configs to set max_outbound_calls_per_day = 10 so
  // placeCall step 5.5 runs the cap check. We'll inject the cap-exceeded
  // path by staging the count query to return 10.
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: {
      outbound_voice_enabled: true,
      outbound_provider: "elevenlabs_hosted",
      record_outbound_calls: true,
      agent_id: "agent_test_033",
      business_name: "T033 Biz",
      twilio_phone_number: "+14155556677",
      elevenlabs_phone_number_id: "phnum_test_033",
      max_outbound_calls_per_day: 10,
    },
  });
  // Cap count query stages — return 10 for the (always-the-same) target day.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.countMode === "exact" &&
      c.headMode === true,
    { data: null, count: 5 },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  // Both leads will have placeCall called. But max_outbound_calls_per_day=10
  // and our stub returns count=5 (split between two parallel queries — actual
  // total = 10). placeCall returns daily_cap_exceeded.
  const failures: string[] = [];
  // Both leads were attempted (loop continued past the first cap-exceeded).
  if (r.skipped !== 2) failures.push(`skipped=${r.skipped} expected 2`);
  if (r.scheduled !== 0) failures.push(`scheduled=${r.scheduled}`);
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x despite cap`);
  // Two UPSERTs with skip_reason='daily_cap'.
  const capUpserts = fake.calls.filter(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads" && c.payload?.skip_reason === "daily_cap" && c.payload?.state === "skipped",
  );
  if (capUpserts.length < 2) failures.push(`expected 2 daily_cap upserts, got ${capUpserts.length}`);
  record("T9 daily_cap_exceeded → continues loop with skipped/daily_cap", failures.length === 0, failures.join("; ") || "2 leads attempted, both skipped/daily_cap, loop continued");
}

async function T10() {
  // The worker passes scheduledFor in the future → placeCall short-
  // circuits at step 7 before reaching the provider. So provider_failed
  // can't manifest through the worker; it'd surface at the 1.5b fire-
  // time worker. The analogous "placeCall returns non-ok" path that IS
  // reachable from the worker is db_error from pre-insert failure.
  // T10 verifies the loop continues past a placeCall non-ok response.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }, { id: LEAD_2 }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1, LEAD_2]);
  // Override the lead_calls INSERT stub to FAIL — triggers placeCall's
  // step 6 db_error path → result.reason='db_error'.
  fake.responses.unshift({
    match: (c) => c.op === "insert" && c.table === "lead_calls",
    data: null,
    error: { message: "transient pre-insert error" },
  });

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.skipped !== 2) failures.push(`skipped=${r.skipped} expected 2`);
  if (r.scheduled !== 0) failures.push(`scheduled=${r.scheduled}`);
  // Both leads should have UPSERTs with skip_reason='db_error_at_placement'.
  const failUpserts = fake.calls.filter(
    (c) =>
      c.op === "upsert" &&
      c.table === "outbound_campaign_leads" &&
      c.payload?.skip_reason === "db_error_at_placement" &&
      c.payload?.state === "skipped",
  );
  if (failUpserts.length < 2) failures.push(`expected 2 db_error_at_placement upserts, got ${failUpserts.length}`);
  // Both lead_calls INSERTs were attempted (loop continued past first failure).
  const leadCallAttempts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (leadCallAttempts.length !== 2) failures.push(`expected 2 lead_calls insert attempts, got ${leadCallAttempts.length}`);
  record("T10 placeCall returns db_error → continues loop with skipped/db_error_at_placement", failures.length === 0, failures.join("; ") || "2 leads attempted, both skipped/db_error_at_placement, loop continued");
}

async function T11() {
  // Campaign daily_cap=1, 2 leads. First scheduled, second hits cap.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow({ dailyCap: 1 })] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }, { id: LEAD_2 }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1, LEAD_2]);
  // Cap cache lookup — pre-existing count = 0 (cache miss on first query).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.countMode === "exact" &&
      c.headMode === true,
    { data: null, count: 0 },
  );

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.scheduled !== 1) failures.push(`scheduled=${r.scheduled} expected 1`);
  if (r.skipped !== 1) failures.push(`skipped=${r.skipped} expected 1`);
  // First lead reaches placeCall (lead_calls pre-insert fires); second
  // lead's cap-check short-circuits BEFORE placeCall.
  const leadCallAttempts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (leadCallAttempts.length !== 1) failures.push(`expected 1 lead_calls insert (first lead), got ${leadCallAttempts.length}`);
  // Second lead UPSERTed with skip_reason='campaign_daily_cap'.
  const capUpsert = fake.calls.find(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads" && c.payload?.skip_reason === "campaign_daily_cap",
  );
  if (!capUpsert) failures.push("missing campaign_daily_cap UPSERT");
  record("T11 campaign daily_cap reached → second lead skipped/campaign_daily_cap", failures.length === 0, failures.join("; ") || "1 scheduled, 1 skipped/campaign_daily_cap, in-memory cap cache enforced");
}

async function T12() {
  // Pending-first: junction must be UPSERTed with state='pending'
  // BEFORE placeCall fires, then UPSERTed with state='scheduled' after.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1]);

  await runCampaignExpansionSweep({ supabase: asClient(fake) });

  // Find ALL upserts on outbound_campaign_leads for LEAD_1 in order.
  const upserts = fake.calls.filter(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads" && c.payload?.lead_id === LEAD_1,
  );
  // Find placeCall provider invocation timestamp via array index.
  const failures: string[] = [];
  if (upserts.length < 2) failures.push(`expected >= 2 upserts, got ${upserts.length}`);
  // First upsert should be pending.
  if (upserts[0]?.payload?.state !== "pending") failures.push(`first upsert state=${upserts[0]?.payload?.state} (expected pending)`);
  // Last upsert should be scheduled.
  const last = upserts[upserts.length - 1];
  if (last?.payload?.state !== "scheduled") failures.push(`last upsert state=${last?.payload?.state} (expected scheduled)`);
  // Verify pending UPSERT came BEFORE placeCall via fake.calls array
  // index. The provider mock pushes to placeCallInvocations on each
  // call; we can correlate by checking fake.calls indices of insert
  // (lead_calls) operations vs the pending upsert.
  const pendingIdx = fake.calls.findIndex(
    (c) => c.op === "upsert" && c.table === "outbound_campaign_leads" && c.payload?.state === "pending" && c.payload?.lead_id === LEAD_1,
  );
  const leadCallInsertIdx = fake.calls.findIndex(
    (c) => c.op === "insert" && c.table === "lead_calls",
  );
  if (pendingIdx < 0) failures.push("no pending UPSERT found");
  if (leadCallInsertIdx < 0) failures.push("no lead_calls INSERT (placeCall pre-insert) found");
  if (pendingIdx >= 0 && leadCallInsertIdx >= 0 && pendingIdx > leadCallInsertIdx) {
    failures.push(`pending UPSERT (idx ${pendingIdx}) came AFTER lead_calls INSERT (idx ${leadCallInsertIdx}) — order is backwards`);
  }
  record("T12 pending-first — junction pending UPSERTed BEFORE placeCall", failures.length === 0, failures.join("; ") || "pending UPSERT preceded lead_calls INSERT; final state=scheduled");
}

async function T13() {
  // Lead has existing junction in 'pending' state from a previous tick.
  // Eligibility check must NOT run. placeCall fires directly.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.eqFilters.some((f) => f.column === "status"),
    { data: [campaignRow()] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id" && c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ id: LEAD_1 }] },
  );
  // Existing junction batch — returns 'pending' for LEAD_1.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.selectColumns.includes("state") &&
      c.eqFilters.some((f) => f.column === "campaign_id"),
    { data: [{ lead_id: LEAD_1, state: "pending" }] },
  );
  stageSupportingTablesHappy(fake, [LEAD_1]);

  const r = await runCampaignExpansionSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.scheduled !== 1) failures.push(`scheduled=${r.scheduled}`);
  // placeCall fires (lead_calls INSERT). Provider isn't invoked for
  // scheduled-future calls — that's the 1.5b fire-time worker's job.
  const leadCallInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (leadCallInserts.length !== 1) failures.push(`expected 1 lead_calls insert, got ${leadCallInserts.length}`);
  // Critical: ZERO already_in_campaign eligibility lookups should have
  // fired (the per-lead SELECT with .eq('lead_id') + .in('state', ...)).
  // This is the load-bearing assertion that the R5 resume path
  // short-circuited the worker's eligibility check.
  // NOTE: placeCall ALSO runs DNC/consent internally (step 3 compliance);
  // those queries are expected. The unique signature of
  // checkCampaignEligibility's already_in_campaign check is
  // outbound_campaign_leads SELECT with eq(lead_id) + in(state, [pending, scheduled]).
  const eligLookups = fake.calls.filter(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.eqFilters.some((f) => f.column === "lead_id" && f.value === LEAD_1) &&
      c.inFilters.some((f) => f.column === "state"),
  );
  if (eligLookups.length !== 0)
    failures.push(`${eligLookups.length} unexpected already_in_campaign lookups (R5 resume path should skip eligibility)`);
  record("T13 existing pending junction → eligibility SKIPPED (R5 resume path)", failures.length === 0, failures.join("; ") || "placeCall fired, zero already_in_campaign lookups (R5 resume verified)");
}

async function main() {
  await T1();
  await T2();
  await T3();
  await T4();
  await T5();
  await T6();
  await T7();
  await T8();
  await T9();
  await T10();
  await T11();
  await T12();
  await T13();

  // Restore for cleanliness.
  __setProviderFactoryForTesting(null);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
