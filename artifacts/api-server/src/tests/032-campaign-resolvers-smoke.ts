/**
 * Phase 2.3 — campaign resolvers + eligibility smoke. 13 cases.
 *
 * Exercises:
 *   - lib/outbound-campaigns/segment-resolver.ts (parser + resolver)
 *   - lib/outbound-campaigns/schedule-resolver.ts (parser + resolver,
 *     bulk + time_relative + earliest-wins)
 *   - lib/outbound-voice/compliance.ts checkCampaignEligibility
 *     (already_in_campaign + DNC delegation)
 *
 * Segment translator (T1-T6 + T12):
 *   T1  filters.all with 2 AND clauses → matching leadIds; verifies
 *       .eq/.eq chain on the supabase-js builder
 *   T2  filters.any with 2 OR clauses → .or() called with comma-joined
 *       PostgREST URL string
 *   T3  empty filters {} → no .or(); returns all business-scoped leads
 *   T4  unknown field → parser error "is not allowed"
 *   T5  wrong op for field type (older_than on text) → parser error
 *       "is not allowed on text field"
 *   T6  older_than "30d" → .lt() called with ISO of (now - 30d) using
 *       deterministic `now` for assertion
 *   T12 value escape rejection — string value with comma → parser
 *       error "reserved character" (load-bearing .or() security guard)
 *
 * Schedule resolver (T7-T9 + T13):
 *   T7  bulk → all leads mapped to fire_at; map.size === leadIds.length
 *   T8  time_relative + lead has matching confirmed appointment →
 *       scheduledFor = appt.appointment_datetime + offset_minutes
 *   T9  time_relative + no matching appointment → absent from map
 *   T13 time_relative + lead has TWO confirmed appointments → uses
 *       the EARLIEST (regression guard for "earliest wins" semantic)
 *
 * checkCampaignEligibility (T10-T11):
 *   T10 lead in DNC list → { skip_reason: 'dnc' }
 *   T11 existing outbound_campaign_leads row with state='pending' →
 *       { skip_reason: 'already_in_campaign' } (short-circuits before
 *       any compliance call)
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/032-campaign-resolvers-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  parseSegmentDefinition,
  resolveSegment,
  parseDuration,
} from "../lib/outbound-campaigns/segment-resolver";
import {
  resolveSchedule,
  type ScheduleDefinition,
} from "../lib/outbound-campaigns/schedule-resolver";
import { checkCampaignEligibility } from "../lib/outbound-voice/compliance";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient ────────────────────────────────────────────────

type FakeCall = {
  op: "select" | "insert" | "update";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  inFilters: Array<{ column: string; value: any[] }>;
  isFilters: Array<{ column: string; value: any }>;
  notFilters: Array<{ column: string; op: string; value: any }>;
  ltFilters: Array<{ column: string; value: any }>;
  lteFilters: Array<{ column: string; value: any }>;
  gtFilters: Array<{ column: string; value: any }>;
  gteFilters: Array<{ column: string; value: any }>;
  neqFilters: Array<{ column: string; value: any }>;
  orStrings: string[];
  orderColumn?: string;
  orderAscending?: boolean;
  payload?: any;
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  select(cols: string) { this.call.selectColumns = cols; return this; }
  insert(payload: any) { this.call.op = "insert"; this.call.payload = payload; return this; }
  update(payload: any) { this.call.op = "update"; this.call.payload = payload; return this; }
  eq(c: string, v: any) { this.call.eqFilters.push({ column: c, value: v }); return this; }
  neq(c: string, v: any) { this.call.neqFilters.push({ column: c, value: v }); return this; }
  in(c: string, v: any[]) { this.call.inFilters.push({ column: c, value: v }); return this; }
  is(c: string, v: any) { this.call.isFilters.push({ column: c, value: v }); return this; }
  not(c: string, op: string, v: any) { this.call.notFilters.push({ column: c, op, value: v }); return this; }
  lt(c: string, v: any) { this.call.ltFilters.push({ column: c, value: v }); return this; }
  lte(c: string, v: any) { this.call.lteFilters.push({ column: c, value: v }); return this; }
  gt(c: string, v: any) { this.call.gtFilters.push({ column: c, value: v }); return this; }
  gte(c: string, v: any) { this.call.gteFilters.push({ column: c, value: v }); return this; }
  or(s: string) { this.call.orStrings.push(s); return this; }
  order(c: string, opts?: { ascending?: boolean }) {
    this.call.orderColumn = c;
    this.call.orderAscending = opts?.ascending ?? true;
    return this;
  }
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
      ltFilters: [],
      lteFilters: [],
      gtFilters: [],
      gteFilters: [],
      neqFilters: [],
      orStrings: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null };
    return { data: r.data ?? null, error: r.error ?? null };
  }
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_032";
const CAMPAIGN = "00000000-0000-0000-0000-000000000c2";
const LEAD_1 = "00000000-0000-0000-0000-000000000a01";
const LEAD_2 = "00000000-0000-0000-0000-000000000a02";

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: [{ id: LEAD_1 }, { id: LEAD_2 }],
  });
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      all: [
        { field: "leads.status", op: "eq", value: "new" },
        { field: "leads.do_not_call", op: "eq", value: false },
      ],
    },
  });
  if ("error" in parsed) {
    record("T1 filters.all 2 AND clauses", false, `parse error: ${parsed.error}`);
    return;
  }
  const r = await resolveSegment(asClient(fake), BIZ, parsed);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  if (r.leadIds.length !== 2) failures.push(`leadIds.length=${r.leadIds.length}`);
  // Verify the .eq() chain: business_id + status + do_not_call.
  const leadsCall = fake.calls.find((c) => c.op === "select" && c.table === "leads");
  if (!leadsCall?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ))
    failures.push("missing .eq(business_id, BIZ)");
  if (!leadsCall?.eqFilters.some((f) => f.column === "status" && f.value === "new"))
    failures.push("missing .eq(status, 'new')");
  if (!leadsCall?.eqFilters.some((f) => f.column === "do_not_call" && f.value === false))
    failures.push("missing .eq(do_not_call, false)");
  if (leadsCall?.orStrings.length !== 0) failures.push(`unexpected .or() calls: ${leadsCall?.orStrings.length}`);
  record("T1 filters.all AND chain", failures.length === 0, failures.join("; ") || "2 leads, .eq chain correct, no .or()");
}

async function T2() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: [{ id: LEAD_1 }],
  });
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      any: [
        { field: "leads.urgency", op: "eq", value: "high" },
        { field: "leads.urgency", op: "eq", value: "emergency" },
      ],
    },
  });
  if ("error" in parsed) {
    record("T2 filters.any OR clauses", false, `parse error: ${parsed.error}`);
    return;
  }
  const r = await resolveSegment(asClient(fake), BIZ, parsed);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  const leadsCall = fake.calls.find((c) => c.op === "select" && c.table === "leads");
  if (leadsCall?.orStrings.length !== 1)
    failures.push(`expected 1 .or() call, got ${leadsCall?.orStrings.length}`);
  const orStr = leadsCall?.orStrings[0];
  if (orStr !== "urgency.eq.high,urgency.eq.emergency")
    failures.push(`.or() arg = ${orStr}`);
  record("T2 filters.any → .or() comma-joined", failures.length === 0, failures.join("; ") || `.or("${orStr}")`);
}

async function T3() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: [{ id: LEAD_1 }, { id: LEAD_2 }],
  });
  const parsed = parseSegmentDefinition({ version: 1, filters: {} });
  if ("error" in parsed) {
    record("T3 empty filters {}", false, `parse error: ${parsed.error}`);
    return;
  }
  const r = await resolveSegment(asClient(fake), BIZ, parsed);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  if (r.leadIds.length !== 2) failures.push(`leadIds.length=${r.leadIds.length}`);
  const leadsCall = fake.calls.find((c) => c.op === "select" && c.table === "leads");
  // Only business_id eq filter.
  if (leadsCall?.eqFilters.length !== 1) failures.push(`expected 1 .eq, got ${leadsCall?.eqFilters.length}`);
  if (leadsCall?.eqFilters[0]?.column !== "business_id") failures.push(`first eq column=${leadsCall?.eqFilters[0]?.column}`);
  if (leadsCall?.orStrings.length !== 0) failures.push(`unexpected .or()`);
  record("T3 empty filters → all business-scoped leads", failures.length === 0, failures.join("; ") || "only business_id filter, no .or()");
}

async function T4() {
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      all: [{ field: "leads.region", op: "eq", value: "us-east" }],
    },
  });
  const ok = "error" in parsed && /is not allowed/i.test(parsed.error) && /leads\.region/.test(parsed.error);
  record("T4 unknown field → parser error", ok, JSON.stringify(parsed));
}

async function T5() {
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      all: [{ field: "leads.status", op: "older_than", value: "30d" }],
    },
  });
  const ok =
    "error" in parsed &&
    /is not allowed/i.test(parsed.error) &&
    /text field/i.test(parsed.error);
  record("T5 older_than on text field → parser error", ok, JSON.stringify(parsed));
}

async function T6() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", { data: [{ id: LEAD_1 }] });
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      all: [{ field: "leads.last_outbound_attempt_at", op: "older_than", value: "30d" }],
    },
  });
  if ("error" in parsed) {
    record("T6 older_than 30d → correct cutoff ISO", false, parsed.error);
    return;
  }
  const fixedNow = new Date("2026-06-16T12:00:00.000Z");
  await resolveSegment(asClient(fake), BIZ, parsed, fixedNow);
  const expectedCutoff = new Date(fixedNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const leadsCall = fake.calls.find((c) => c.op === "select" && c.table === "leads");
  const ltMatch = leadsCall?.ltFilters.find(
    (f) => f.column === "last_outbound_attempt_at" && f.value === expectedCutoff,
  );
  const ok = !!ltMatch;
  record(
    "T6 older_than 30d → .lt(col, now-30d)",
    ok,
    `expected .lt(last_outbound_attempt_at, ${expectedCutoff}); got: ${JSON.stringify(leadsCall?.ltFilters)}`,
  );
}

async function T7() {
  const fake = new FakeSupabaseClient();
  const fireAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const def: ScheduleDefinition = {
    version: 1,
    strategy: "bulk",
    fire_at: fireAt.toISOString(),
  };
  const r = await resolveSchedule(asClient(fake), BIZ, [LEAD_1, LEAD_2], def);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  if (r.scheduledFor.size !== 2) failures.push(`map.size=${r.scheduledFor.size}`);
  if (r.scheduledFor.get(LEAD_1)?.getTime() !== fireAt.getTime())
    failures.push(`L1 scheduledFor mismatch`);
  if (r.scheduledFor.get(LEAD_2)?.getTime() !== fireAt.getTime())
    failures.push(`L2 scheduledFor mismatch`);
  record("T7 bulk → all leads map to fire_at", failures.length === 0, failures.join("; ") || "2 entries, both === fire_at");
}

async function T8() {
  const fake = new FakeSupabaseClient();
  const apptISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  fake.on((c) => c.op === "select" && c.table === "appointments", {
    data: [{ lead_id: LEAD_1, appointment_datetime: apptISO }],
  });
  const def: ScheduleDefinition = {
    version: 1,
    strategy: "time_relative",
    anchor: {
      table: "appointments",
      field: "appointment_datetime",
      lead_join: "lead_id",
      filter: { status: "confirmed" },
    },
    offset_minutes: -60,
  };
  const r = await resolveSchedule(asClient(fake), BIZ, [LEAD_1], def);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  if (r.scheduledFor.size !== 1) failures.push(`map.size=${r.scheduledFor.size}`);
  const expected = new Date(new Date(apptISO).getTime() - 60 * 60 * 1000);
  if (r.scheduledFor.get(LEAD_1)?.getTime() !== expected.getTime())
    failures.push(`scheduledFor=${r.scheduledFor.get(LEAD_1)?.toISOString()} expected=${expected.toISOString()}`);
  // Verify the status='confirmed' filter was applied.
  const apptCall = fake.calls.find((c) => c.op === "select" && c.table === "appointments");
  if (!apptCall?.eqFilters.some((f) => f.column === "status" && f.value === "confirmed"))
    failures.push("missing .eq(status, 'confirmed')");
  record("T8 time_relative + match → scheduledFor = appt + offset", failures.length === 0, failures.join("; ") || "scheduledFor correct, status filter applied");
}

async function T9() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "appointments", { data: [] });
  const def: ScheduleDefinition = {
    version: 1,
    strategy: "time_relative",
    anchor: {
      table: "appointments",
      field: "appointment_datetime",
      lead_join: "lead_id",
    },
    offset_minutes: -60,
  };
  const r = await resolveSchedule(asClient(fake), BIZ, [LEAD_1], def);
  const ok = !r.error && r.scheduledFor.size === 0;
  record("T9 time_relative + no match → absent from map", ok, JSON.stringify({ size: r.scheduledFor.size, error: r.error }));
}

async function T10() {
  const fake = new FakeSupabaseClient();
  // Already-in-campaign check: not in campaign.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads",
    { data: null },
  );
  // checkCompliance calls:
  // 1. checkDnc → reads leads.do_not_call + dnc_list
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("do_not_call"),
    { data: { do_not_call: false } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "dnc_list",
    { data: { source: "manual", reason: "customer_request", created_at: "2026-06-01T00:00:00Z" } },
  );
  // 2. checkCallingHours
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
  // 3. checkVoiceConsent → voice_consent_records + business_configs fallback
  fake.on(
    (c) => c.op === "select" && c.table === "voice_consent_records",
    { data: null },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );

  const r = await checkCampaignEligibility(asClient(fake), {
    campaignId: CAMPAIGN,
    businessId: BIZ,
    leadId: LEAD_1,
    phone: "+12025557777",
    consentType: "appointment_reminder",
    recipientTimezone: "America/New_York",
    scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const ok = !r.eligible && r.skip_reason === "dnc";
  record("T10 lead in DNC → skip_reason='dnc'", ok, JSON.stringify(r));
}

async function T11() {
  const fake = new FakeSupabaseClient();
  // Already-in-campaign returns existing row → short-circuit.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaign_leads" &&
      c.inFilters.some((f) => f.column === "state"),
    { data: { id: "ocl_existing_t11" } },
  );

  const r = await checkCampaignEligibility(asClient(fake), {
    campaignId: CAMPAIGN,
    businessId: BIZ,
    leadId: LEAD_1,
    phone: "+12025557777",
    consentType: "appointment_reminder",
    recipientTimezone: "America/New_York",
    scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const failures: string[] = [];
  if (r.eligible) failures.push("eligible=true unexpectedly");
  if (!r.eligible && r.skip_reason !== "already_in_campaign")
    failures.push(`skip_reason=${r.skip_reason}`);
  // No DNC / consent / calling_hours queries should have fired.
  const otherTables = fake.calls.filter(
    (c) => c.op === "select" && c.table !== "outbound_campaign_leads",
  );
  if (otherTables.length !== 0)
    failures.push(`${otherTables.length} unexpected SELECTs on ${otherTables.map((c) => c.table).join(",")}`);
  record("T11 already_in_campaign → skip short-circuits", failures.length === 0, failures.join("; ") || "skip_reason=already_in_campaign, zero downstream queries");
}

async function T12() {
  // Load-bearing SQL-injection guard: string value with a comma → parser rejects.
  const parsed = parseSegmentDefinition({
    version: 1,
    filters: {
      any: [{ field: "leads.status", op: "eq", value: "new,claimed" }],
    },
  });
  const ok = "error" in parsed && /reserved character/i.test(parsed.error);
  record("T12 string value with comma → parser rejects (load-bearing escape guard)", ok, JSON.stringify(parsed));
}

async function T13() {
  // Multi-appointment lead — earliest-wins (R6 regression guard).
  const fake = new FakeSupabaseClient();
  const earlierISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();   // NOW + 24h
  const laterISO = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();     // NOW + 48h
  // The resolver applies ORDER BY appointment_datetime ASC. The fake doesn't
  // sort — we mirror sorted output by returning rows in ASC order, matching
  // what Postgres would return after applying the ORDER BY clause.
  fake.on((c) => c.op === "select" && c.table === "appointments", {
    data: [
      { lead_id: LEAD_1, appointment_datetime: earlierISO },
      { lead_id: LEAD_1, appointment_datetime: laterISO },
    ],
  });
  const def: ScheduleDefinition = {
    version: 1,
    strategy: "time_relative",
    anchor: {
      table: "appointments",
      field: "appointment_datetime",
      lead_join: "lead_id",
      filter: { status: "confirmed" },
    },
    offset_minutes: -60,
  };
  const r = await resolveSchedule(asClient(fake), BIZ, [LEAD_1], def);
  const failures: string[] = [];
  if (r.error) failures.push(`error: ${r.error}`);
  if (r.scheduledFor.size !== 1) failures.push(`map.size=${r.scheduledFor.size} (expected 1 — no duplicates)`);
  const expectedEarlier = new Date(new Date(earlierISO).getTime() - 60 * 60 * 1000);
  const expectedLater = new Date(new Date(laterISO).getTime() - 60 * 60 * 1000);
  const actual = r.scheduledFor.get(LEAD_1);
  if (actual?.getTime() !== expectedEarlier.getTime())
    failures.push(`scheduledFor=${actual?.toISOString()} expected EARLIER (${expectedEarlier.toISOString()})`);
  if (actual?.getTime() === expectedLater.getTime())
    failures.push("scheduledFor matched LATER appointment — earliest-wins broken");
  // Verify the resolver requested ORDER BY ASC.
  const apptCall = fake.calls.find((c) => c.op === "select" && c.table === "appointments");
  if (apptCall?.orderColumn !== "appointment_datetime") failures.push(`order column=${apptCall?.orderColumn}`);
  if (apptCall?.orderAscending !== true) failures.push("order is not ascending");
  record("T13 multi-appointment lead → earliest wins", failures.length === 0, failures.join("; ") || "single entry per lead, EARLIER appointment chosen, ORDER BY ASC applied");
}

// Sanity check on the duration parser — used internally; not a test
// case but exercised to confirm the regex covers the documented units.
function sanityCheckParseDuration() {
  const cases: Array<[string, number | null]> = [
    ["30d", 30 * 24 * 60 * 60 * 1000],
    ["2h", 2 * 60 * 60 * 1000],
    ["45m", 45 * 60 * 1000],
    ["60s", 60 * 1000],
    ["1w", 7 * 24 * 60 * 60 * 1000],
    ["bad", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    if (parseDuration(input) !== expected) {
      throw new Error(`parseDuration(${JSON.stringify(input)}) = ${parseDuration(input)}, expected ${expected}`);
    }
  }
}

async function main() {
  sanityCheckParseDuration();
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

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
