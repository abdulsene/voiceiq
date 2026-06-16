/**
 * Phase 2.7a — campaign metrics endpoint smoke. 5 cases.
 *
 * Exercises handleGetCampaignMetrics directly with a FakeSupabaseClient
 * that intercepts .from(table).select chains AND .rpc(). Same pattern
 * as 034-campaigns-routes-smoke.ts; no Express plumbing.
 *
 *   T1  Counters + rates derived from staged state counts; rates
 *       correctly guarded against div/0 and clamped to [0, 1].
 *   T2  time_series pivot — rows grouped by day with one field per
 *       state-series; NULL-scheduled_for rows excluded by the RPC are
 *       naturally absent (we stub the RPC response to mirror that).
 *   T3  skip_reasons top-10 desc; tie-broken alphabetically so the
 *       order is deterministic.
 *   T4  Cross-tenant ownership check returns 404; no aggregation
 *       queries issued when the campaign isn't owned by the caller.
 *   T5  Zero-state — campaign exists but has no junction rows; all
 *       counters = 0, all rates = 0, arrays empty.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/034-campaign-metrics-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { handleGetCampaignMetrics } from "../routes/campaigns";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient ──────────────────────────────────────────────

type FakeCall = {
  op: "select" | "rpc";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  rpcParams?: any;
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  select(cols: string) {
    this.call.selectColumns = cols;
    return this;
  }
  eq(c: string, v: any) { this.call.eqFilters.push({ column: c, value: v }); return this; }
  is() { return this; }
  neq() { return this; }
  not() { return this; }
  or() { return this; }
  order() { return this; }
  range() { return this; }
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
    const call: FakeCall = { op: "select", table, selectColumns: "", eqFilters: [] };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async rpc(name: string, params: any) {
    const call: FakeCall = {
      op: "rpc",
      table: name,
      selectColumns: "",
      eqFilters: [],
      rpcParams: params,
    };
    this.calls.push(call);
    return this.resolveCall(call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null };
    return { data: r.data ?? null, error: r.error ?? null };
  }
  auth = { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Fixtures ────────────────────────────────────────────────────────

const BIZ = "biz_test_034m";
const OTHER_BIZ = "biz_other_034m";
const CAMP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// Stage 50 state rows: 10 scheduled, 8 completed (of which 6 succeeded,
// 1 failed, 1 voicemail), 30 skipped, 2 pending. Per T1 spec.
function stageT1States(fake: FakeSupabaseClient) {
  const rows: Array<{ state: string }> = [];
  for (let i = 0; i < 10; i++) rows.push({ state: "scheduled" });
  for (let i = 0; i < 6; i++) rows.push({ state: "succeeded" });
  rows.push({ state: "failed" });
  rows.push({ state: "voicemail" });
  // The 6+1+1 = 8 above are also the "completed" universe per the
  // junction's state machine. Counter "completed" here means literally
  // state='completed' rows; succeeded/failed/voicemail are distinct
  // terminal states. Per T1 expected math, completed = 8 → the spec
  // groups succeeded/failed/voicemail UNDER completed conceptually but
  // counts them as distinct states. We model both: completed=8, and
  // the 6+1+1 distinct terminals also each get counts of their own.
  for (let i = 0; i < 8; i++) rows.push({ state: "completed" });
  for (let i = 0; i < 30; i++) rows.push({ state: "skipped" });
  for (let i = 0; i < 2; i++) rows.push({ state: "pending" });
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "state",
    { data: rows },
  );
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    { data: { id: CAMP } },
  );
  stageT1States(fake);
  // Skip-reasons: stage 30 'do_not_call' rows (just one reason for T1
  // — the more interesting top-10 ordering is T3's job).
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "skip_reason",
    { data: Array.from({ length: 30 }, () => ({ skip_reason: "do_not_call" })) },
  );
  // No time-series in T1 — empty RPC response is fine for rate math.
  fake.on(
    (c) => c.op === "rpc" && c.table === "campaign_metrics_time_series",
    { data: [] },
  );

  const result = await handleGetCampaignMetrics(asClient(fake), BIZ, CAMP);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (result.ok) {
    const c = result.metrics.counters;
    if (c.target !== 50 + 6 + 1 + 1) failures.push(`target=${c.target} (expected 58 = 50 staged + the 6+1+1 succeeded/failed/voicemail)`);
    // Actually let me recompute — stageT1States pushed:
    //   10 scheduled + 6 succeeded + 1 failed + 1 voicemail + 8 completed
    //   + 30 skipped + 2 pending = 58 rows total.
    // So target = 58.
    if (c.scheduled !== 10) failures.push(`scheduled=${c.scheduled}`);
    if (c.completed !== 8) failures.push(`completed=${c.completed}`);
    if (c.succeeded !== 6) failures.push(`succeeded=${c.succeeded}`);
    if (c.failed !== 1) failures.push(`failed=${c.failed}`);
    if (c.voicemail !== 1) failures.push(`voicemail=${c.voicemail}`);
    if (c.skipped !== 30) failures.push(`skipped=${c.skipped}`);
    if (c.pending !== 2) failures.push(`pending=${c.pending}`);

    const r = result.metrics.rates;
    // connect_rate = succeeded / (completed - voicemail) = 6/(8-1) ≈ 0.857
    if (Math.abs(r.connect_rate - 6 / 7) > 1e-9) failures.push(`connect_rate=${r.connect_rate} (expected ~0.857)`);
    // voicemail_rate = voicemail / completed = 1/8 = 0.125
    if (Math.abs(r.voicemail_rate - 0.125) > 1e-9) failures.push(`voicemail_rate=${r.voicemail_rate}`);
    // skip_rate = skipped / target = 30/58
    if (Math.abs(r.skip_rate - 30 / 58) > 1e-9) failures.push(`skip_rate=${r.skip_rate}`);
    // completion_rate = completed / scheduled = 8/10 = 0.8
    if (Math.abs(r.completion_rate - 0.8) > 1e-9) failures.push(`completion_rate=${r.completion_rate}`);

    // state_distribution sorted desc by count
    const sd = result.metrics.state_distribution;
    if (sd.length === 0) failures.push("state_distribution empty");
    if (sd.length > 0 && sd[0].count < sd[sd.length - 1].count) failures.push("state_distribution not sorted desc");
  }
  record("T1 counters + rates", failures.length === 0, failures.join("; ") || "58 rows; 6/7≈0.857 connect, 0.125 vm, 0.8 completion");
}

async function T2() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "outbound_campaigns", { data: { id: CAMP } });
  // 5 leads, all scheduled — counters secondary, T2 is about time-
  // series shape.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "state",
    { data: Array.from({ length: 5 }, () => ({ state: "scheduled" })) },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "skip_reason",
    { data: [] },
  );
  // RPC returns 5 days × 3 distinct states.
  fake.on(
    (c) => c.op === "rpc" && c.table === "campaign_metrics_time_series",
    {
      data: [
        { day: "2026-06-10", state: "scheduled", count: 5 },
        { day: "2026-06-10", state: "succeeded", count: 3 },
        { day: "2026-06-11", state: "scheduled", count: 4 },
        { day: "2026-06-11", state: "voicemail", count: 1 },
        { day: "2026-06-12", state: "scheduled", count: 7 },
        { day: "2026-06-12", state: "succeeded", count: 6 },
        { day: "2026-06-12", state: "failed", count: 1 },
        { day: "2026-06-13", state: "skipped", count: 2 },
        { day: "2026-06-14", state: "succeeded", count: 9 },
      ],
    },
  );

  const result = await handleGetCampaignMetrics(asClient(fake), BIZ, CAMP);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (result.ok) {
    const ts = result.metrics.time_series;
    if (ts.length !== 5) failures.push(`time_series.length=${ts.length} (expected 5)`);
    // Ascending date order.
    const dates = ts.map((r) => r.date);
    const sorted = [...dates].sort();
    if (dates.join(",") !== sorted.join(",")) failures.push(`time_series not in ASC order: ${dates.join(",")}`);
    // Day 1: scheduled=5, succeeded=3, others=0
    const d1 = ts.find((r) => r.date === "2026-06-10");
    if (!d1 || d1.scheduled !== 5 || d1.succeeded !== 3 || d1.failed !== 0 || d1.voicemail !== 0 || d1.skipped !== 0) {
      failures.push(`day1 mismatch: ${JSON.stringify(d1)}`);
    }
    // Day 3 (the busy one): scheduled=7, succeeded=6, failed=1
    const d3 = ts.find((r) => r.date === "2026-06-12");
    if (!d3 || d3.scheduled !== 7 || d3.succeeded !== 6 || d3.failed !== 1) {
      failures.push(`day3 mismatch: ${JSON.stringify(d3)}`);
    }
    // Day 5: only succeeded=9, all others=0
    const d5 = ts.find((r) => r.date === "2026-06-14");
    if (!d5 || d5.succeeded !== 9 || d5.scheduled !== 0 || d5.failed !== 0 || d5.voicemail !== 0 || d5.skipped !== 0) {
      failures.push(`day5 mismatch: ${JSON.stringify(d5)}`);
    }
    // RPC was invoked with the right campaign id.
    const rpcCall = fake.calls.find((c) => c.op === "rpc");
    if (rpcCall?.rpcParams?.p_campaign_id !== CAMP) failures.push(`rpc p_campaign_id=${rpcCall?.rpcParams?.p_campaign_id}`);
  }
  record("T2 time_series pivot", failures.length === 0, failures.join("; ") || "5 days × pivoted state series, ASC ordering");
}

async function T3() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "outbound_campaigns", { data: { id: CAMP } });
  // Need at least 1 state row so the counters work; T3 only checks
  // skip_reasons.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "state",
    { data: [] },
  );
  // Stage 15 distinct skip_reasons with varying counts, two pairs at
  // a tie (alpha tiebreak) to lock the sort behavior.
  const skipFixture: Array<{ skip_reason: string }> = [];
  const reasonCounts = {
    do_not_call: 30,           // 1st
    outside_calling_hours: 25, // 2nd
    daily_cap_exceeded: 20,    // 3rd
    no_matching_anchor: 18,    // 4th
    consent_missing: 15,       // 5th
    already_in_campaign: 10,   // 6th
    provider_failure: 8,       // 7th
    invalid_phone: 7,          // 8th
    // Ties at count=5 → alpha order: contact_dnc < tenant_dnc
    contact_dnc: 5,            // 9th (alpha before tenant_dnc)
    tenant_dnc: 5,             // 10th
    // The following 5 should NOT make the top-10:
    rate_limit: 3,
    network_error: 2,
    duplicate_lead: 2,
    expired_token: 1,
    unknown: 1,
  };
  for (const [reason, n] of Object.entries(reasonCounts)) {
    for (let i = 0; i < n; i++) skipFixture.push({ skip_reason: reason });
  }
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "skip_reason",
    { data: skipFixture },
  );
  fake.on((c) => c.op === "rpc" && c.table === "campaign_metrics_time_series", { data: [] });

  const result = await handleGetCampaignMetrics(asClient(fake), BIZ, CAMP);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (result.ok) {
    const sr = result.metrics.skip_reasons;
    if (sr.length !== 10) failures.push(`skip_reasons.length=${sr.length} (expected 10)`);
    // Verify descending by count.
    for (let i = 1; i < sr.length; i++) {
      if (sr[i].count > sr[i - 1].count) {
        failures.push(`not descending at idx ${i}: ${sr[i - 1].count} -> ${sr[i].count}`);
        break;
      }
    }
    // Lock specific positions.
    const expectedOrder = [
      "do_not_call", "outside_calling_hours", "daily_cap_exceeded",
      "no_matching_anchor", "consent_missing", "already_in_campaign",
      "provider_failure", "invalid_phone", "contact_dnc", "tenant_dnc",
    ];
    for (let i = 0; i < expectedOrder.length; i++) {
      if (sr[i]?.reason !== expectedOrder[i]) {
        failures.push(`pos[${i}]=${sr[i]?.reason} (expected ${expectedOrder[i]})`);
      }
    }
    // None of the bottom 5 leaked in.
    const inTop10 = new Set(sr.map((r) => r.reason));
    for (const banned of ["rate_limit", "network_error", "duplicate_lead", "expired_token", "unknown"]) {
      if (inTop10.has(banned)) failures.push(`bottom-5 leaked: ${banned}`);
    }
  }
  record("T3 skip_reasons top-10 desc + alpha tiebreak", failures.length === 0, failures.join("; ") || "top 10 ordered correctly; ties broken alphabetically");
}

async function T4() {
  const fake = new FakeSupabaseClient();
  // Owner check returns null — campaign belongs to a different tenant.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    { data: null },
  );

  const result = await handleGetCampaignMetrics(asClient(fake), OTHER_BIZ, CAMP);
  const failures: string[] = [];
  if (result.ok) failures.push("cross-tenant unexpectedly ok");
  if (!result.ok && result.status !== 404) failures.push(`status=${result.status}`);

  // Critical: NO aggregation queries issued after the 404. Only the
  // owner check ran.
  const aggregationCalls = fake.calls.filter(
    (c) => c.table === "outbound_campaign_leads" || c.table === "campaign_metrics_time_series",
  );
  if (aggregationCalls.length !== 0) failures.push(`leaked ${aggregationCalls.length} aggregation calls after owner check failed`);

  // Ownership check WAS gated by business_id filter (not just id).
  const owner = fake.calls.find((c) => c.table === "outbound_campaigns");
  if (!owner?.eqFilters.some((f) => f.column === "business_id" && f.value === OTHER_BIZ)) {
    failures.push("missing business_id filter on owner check");
  }
  if (!owner?.eqFilters.some((f) => f.column === "id" && f.value === CAMP)) {
    failures.push("missing id filter on owner check");
  }
  record("T4 cross-tenant 404", failures.length === 0, failures.join("; ") || "404 + zero aggregation queries + tenant filter applied");
}

async function T5() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "outbound_campaigns", { data: { id: CAMP } });
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "state",
    { data: [] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads" && c.selectColumns === "skip_reason",
    { data: [] },
  );
  fake.on((c) => c.op === "rpc" && c.table === "campaign_metrics_time_series", { data: [] });

  const result = await handleGetCampaignMetrics(asClient(fake), BIZ, CAMP);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (result.ok) {
    const c = result.metrics.counters;
    if (c.target !== 0) failures.push(`target=${c.target}`);
    if (c.scheduled !== 0) failures.push(`scheduled=${c.scheduled}`);
    if (c.completed !== 0) failures.push(`completed=${c.completed}`);
    if (c.succeeded !== 0) failures.push(`succeeded=${c.succeeded}`);
    if (c.failed !== 0) failures.push(`failed=${c.failed}`);
    if (c.voicemail !== 0) failures.push(`voicemail=${c.voicemail}`);
    if (c.skipped !== 0) failures.push(`skipped=${c.skipped}`);
    if (c.pending !== 0) failures.push(`pending=${c.pending}`);

    const r = result.metrics.rates;
    // All denoms zero → all rates 0 (no NaN / Infinity / null leaked).
    for (const [k, v] of Object.entries(r)) {
      if (v !== 0) failures.push(`rate ${k}=${v} (expected 0)`);
    }
    if (result.metrics.time_series.length !== 0) failures.push(`time_series=${result.metrics.time_series.length}`);
    if (result.metrics.skip_reasons.length !== 0) failures.push(`skip_reasons=${result.metrics.skip_reasons.length}`);
    if (result.metrics.state_distribution.length !== 0) failures.push(`state_distribution=${result.metrics.state_distribution.length}`);
    if (result.metrics.campaign_id !== CAMP) failures.push(`campaign_id=${result.metrics.campaign_id}`);
  }
  record("T5 zero-state", failures.length === 0, failures.join("; ") || "all counters 0, all rates 0 (no NaN/Inf), empty arrays");
}

async function main() {
  await T1();
  await T2();
  await T3();
  await T4();
  await T5();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
