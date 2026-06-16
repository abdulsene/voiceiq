/**
 * Phase 2.6a — campaigns CRUD routes smoke. 10 cases.
 *
 * Exercises the exported handler functions from routes/campaigns.ts
 * directly with a FakeSupabaseClient that intercepts .from(table) chains
 * AND .rpc(fn, params). Bypasses requireAuth + requirePermission — the
 * handlers take primitives (supabase, businessId, [userId], body|query)
 * so we don't need to build real req/res. Same convention as 028 / 031.
 *
 *   T1  GET list — returns paginated rows + total for tenant
 *   T2  POST create — valid segment + schedule → 201 + INSERT row, fields
 *       persisted including segment_definition + schedule_definition
 *   T3  POST create — malformed segment_definition → 400 with parse error
 *       (no INSERT issued)
 *   T4  PATCH — partial update persists exactly the supplied fields +
 *       updated_at; absent fields aren't touched
 *   T5  DELETE — invokes RPC delete_campaign_with_cancellations via a
 *       single .rpc() call (NOT 4 separate UPDATEs/DELETEs); returns
 *       counts; 404 when RPC returns empty result set
 *   T6  POST preview — segment_definition only → 200 with count + sample;
 *       schedule_definition adds scheduledFor on sample rows
 *   T7  POST preview — malformed segment_definition → 200 (not 400) with
 *       segment_error inline
 *   T8  Cross-tenant access — GET /:id with a different tenant's campaign
 *       id → 404 (not 403). Cross-tenant PATCH likewise → 404.
 *   T9  GET list — offset/limit + status filter respected and pushed
 *       through to the underlying .range() + .eq("status", ...) calls
 *   T10 GET /:id/leads — verifies tenant ownership, then returns junction
 *       rows with the joined lead (contact_name, contact_phone) columns
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/034-campaigns-routes-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleListCampaigns,
  handleGetCampaign,
  handleCreateCampaign,
  handlePatchCampaign,
  handleDeleteCampaign,
  handlePreviewCampaign,
  handleGetCampaignLeads,
} from "../routes/campaigns";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient ──────────────────────────────────────────────

type FakeCall = {
  op: "select" | "insert" | "update" | "delete" | "rpc";
  table: string;
  selectColumns: string;
  selectOpts?: { count?: string };
  eqFilters: Array<{ column: string; value: any }>;
  inFilters: Array<{ column: string; values: any[] }>;
  orderBy?: { column: string; ascending: boolean };
  rangeFrom?: number;
  rangeTo?: number;
  payload?: any;
  rpcParams?: any;
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  count?: number;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  select(cols: string, opts?: any) {
    this.call.selectColumns = cols;
    if (opts) this.call.selectOpts = opts;
    return this;
  }
  insert(payload: any) { this.call.op = "insert"; this.call.payload = payload; return this; }
  update(payload: any) { this.call.op = "update"; this.call.payload = payload; return this; }
  delete() { this.call.op = "delete"; return this; }
  eq(c: string, v: any) { this.call.eqFilters.push({ column: c, value: v }); return this; }
  in(c: string, vs: any[]) { this.call.inFilters.push({ column: c, values: vs }); return this; }
  is() { return this; }
  neq() { return this; }
  not() { return this; }
  or() { return this; }
  order(column: string, opts?: { ascending?: boolean }) {
    this.call.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  range(from: number, to: number) {
    this.call.rangeFrom = from;
    this.call.rangeTo = to;
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
    const call: FakeCall = { op: "select", table, selectColumns: "", eqFilters: [], inFilters: [] };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async rpc(name: string, params: any) {
    const call: FakeCall = {
      op: "rpc",
      table: name,
      selectColumns: "",
      eqFilters: [],
      inFilters: [],
      rpcParams: params,
    };
    this.calls.push(call);
    return this.resolveCall(call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null, count: 0 };
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? 0 };
  }
  auth = { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Fixtures ────────────────────────────────────────────────────────

const BIZ = "biz_test_034";
const OTHER_BIZ = "biz_other_034";
const USER = "00000000-0000-0000-0000-0000000000aa";
const CAMP1 = "11111111-1111-1111-1111-111111111111";
const CAMP2 = "22222222-2222-2222-2222-222222222222";
const FUTURE_ISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const validSegment = {
  version: 1,
  filters: {
    all: [
      { field: "leads.status", op: "in", value: ["new", "claimed"] },
      { field: "leads.do_not_call", op: "eq", value: false },
    ],
  },
};

const validBulkSchedule = {
  version: 1,
  strategy: "bulk",
  fire_at: FUTURE_ISO,
};

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    {
      data: [
        { id: CAMP1, business_id: BIZ, name: "C1", call_objective: "appointment_reminder", status: "draft" },
        { id: CAMP2, business_id: BIZ, name: "C2", call_objective: "winback", status: "active" },
      ],
      count: 2,
    },
  );

  const result = await handleListCampaigns(asClient(fake), BIZ, {});
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.campaigns.length !== 2) failures.push(`campaigns.length=${result.campaigns.length}`);
    if (result.total !== 2) failures.push(`total=${result.total}`);
  }
  // Verify tenant scoping pushed down.
  const select = fake.calls.find((c) => c.op === "select" && c.table === "outbound_campaigns");
  if (!select?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("missing business_id eq filter");
  }
  if (select?.selectOpts?.count !== "exact") failures.push("count opt not 'exact'");
  record("T1 list returns paginated rows", failures.length === 0, failures.join("; ") || "2 rows + total=2 + tenant scoped");
}

async function T2() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "insert" && c.table === "outbound_campaigns",
    { data: { id: CAMP1, business_id: BIZ, name: "Win-back Q2", call_objective: "winback", status: "draft" } },
  );

  const result = await handleCreateCampaign(asClient(fake), BIZ, USER, {
    name: "Win-back Q2",
    call_objective: "winback",
    segment_definition: validSegment as any,
    schedule_definition: validBulkSchedule as any,
    schedule_strategy: "bulk",
    daily_cap: 100,
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const insert = fake.calls.find((c) => c.op === "insert" && c.table === "outbound_campaigns");
  if (!insert) failures.push("no INSERT issued");
  if (insert?.payload?.business_id !== BIZ) failures.push(`payload.business_id=${insert?.payload?.business_id}`);
  if (insert?.payload?.name !== "Win-back Q2") failures.push(`payload.name=${insert?.payload?.name}`);
  if (insert?.payload?.created_by !== USER) failures.push(`payload.created_by=${insert?.payload?.created_by}`);
  if (insert?.payload?.status !== "draft") failures.push(`payload.status=${insert?.payload?.status}`);
  if (!insert?.payload?.segment_definition) failures.push("payload.segment_definition missing");
  if (!insert?.payload?.schedule_definition) failures.push("payload.schedule_definition missing");
  if (insert?.payload?.daily_cap !== 100) failures.push(`payload.daily_cap=${insert?.payload?.daily_cap}`);
  record("T2 create with segment + schedule", failures.length === 0, failures.join("; ") || "201 + INSERT persisted DSL");
}

async function T3() {
  const fake = new FakeSupabaseClient();
  // parseCreateBody runs in-process; no DB call expected.
  const { parseCreateBody } = await import("../routes/campaigns");
  const parsed = parseCreateBody({
    name: "Bad segment",
    call_objective: "winback",
    segment_definition: { version: 1, filters: { all: [{ field: "leads.nonexistent", op: "eq", value: "x" }] } },
  });
  const failures: string[] = [];
  if (!("error" in parsed)) failures.push("parseCreateBody returned ok unexpectedly");
  else if (!/segment_definition/.test(parsed.error)) failures.push(`error doesn't mention segment_definition: ${parsed.error}`);
  if (fake.calls.length !== 0) failures.push(`unexpected ${fake.calls.length} DB calls during parse`);
  record("T3 malformed segment rejected", failures.length === 0, failures.join("; ") || "400 with parse error, no INSERT");
}

async function T4() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns",
    { data: { id: CAMP1, business_id: BIZ, name: "Renamed", status: "queued" } },
  );

  const beforeUpdate = Date.now();
  const result = await handlePatchCampaign(asClient(fake), BIZ, CAMP1, {
    name: "Renamed",
    status: "queued",
  });
  const afterUpdate = Date.now();
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "outbound_campaigns");
  if (!update) failures.push("no UPDATE issued");
  if (update?.payload?.name !== "Renamed") failures.push(`payload.name=${update?.payload?.name}`);
  if (update?.payload?.status !== "queued") failures.push(`payload.status=${update?.payload?.status}`);
  if ("call_objective" in (update?.payload ?? {})) failures.push("unexpected call_objective in patch payload");
  if (!update?.payload?.updated_at) failures.push("updated_at not set");
  else {
    const ts = new Date(update.payload.updated_at).getTime();
    if (ts < beforeUpdate || ts > afterUpdate) failures.push("updated_at outside expected window");
  }
  // Tenant scoping.
  if (!update?.eqFilters.some((f) => f.column === "id" && f.value === CAMP1)) failures.push("missing id filter");
  if (!update?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("missing business_id filter");
  record("T4 PATCH partial fields", failures.length === 0, failures.join("; ") || "UPDATE name+status+updated_at, tenant scoped");
}

async function T5() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "rpc" && c.table === "delete_campaign_with_cancellations",
    { data: [{ canceled_call_count: 3, deleted_junction_count: 42 }] },
  );

  const result = await handleDeleteCampaign(asClient(fake), BIZ, CAMP1);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.canceled_call_count !== 3) failures.push(`canceled=${result.canceled_call_count}`);
    if (result.deleted_junction_count !== 42) failures.push(`junctions=${result.deleted_junction_count}`);
  }
  // Single RPC call, NOT four separate UPDATEs/DELETEs.
  const rpcCalls = fake.calls.filter((c) => c.op === "rpc");
  const updateCalls = fake.calls.filter((c) => c.op === "update");
  const deleteCalls = fake.calls.filter((c) => c.op === "delete");
  if (rpcCalls.length !== 1) failures.push(`rpc count=${rpcCalls.length} (expected 1)`);
  if (updateCalls.length !== 0) failures.push(`unexpected UPDATE calls=${updateCalls.length}`);
  if (deleteCalls.length !== 0) failures.push(`unexpected DELETE calls=${deleteCalls.length}`);
  // RPC params.
  if (rpcCalls[0]?.rpcParams?.p_campaign_id !== CAMP1) failures.push(`p_campaign_id=${rpcCalls[0]?.rpcParams?.p_campaign_id}`);
  if (rpcCalls[0]?.rpcParams?.p_business_id !== BIZ) failures.push(`p_business_id=${rpcCalls[0]?.rpcParams?.p_business_id}`);

  // 404 case — RPC returns empty result set.
  const fake404 = new FakeSupabaseClient();
  fake404.on((c) => c.op === "rpc" && c.table === "delete_campaign_with_cancellations", { data: [] });
  const result404 = await handleDeleteCampaign(asClient(fake404), BIZ, CAMP1);
  if (result404.ok) failures.push("empty RPC result didn't 404");
  else if (result404.status !== 404) failures.push(`empty RPC status=${result404.status}`);

  record("T5 DELETE via single RPC", failures.length === 0, failures.join("; ") || "single rpc(), counts returned, 404 on empty");
}

async function T6() {
  const fake = new FakeSupabaseClient();
  // resolveSegment SELECT — returns 3 lead ids.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id",
    { data: [{ id: "lead-1" }, { id: "lead-2" }, { id: "lead-3" }] },
  );
  // Sample fetch (id, contact_name, contact_phone) for the sample.
  fake.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("contact_name"),
    {
      data: [
        { id: "lead-1", contact_name: "A", contact_phone: "+1" },
        { id: "lead-2", contact_name: "B", contact_phone: "+2" },
        { id: "lead-3", contact_name: "C", contact_phone: "+3" },
      ],
    },
  );

  // (a) Segment only — count + sample, no scheduledFor.
  const noSched = await handlePreviewCampaign(asClient(fake), BIZ, {
    segment_definition: validSegment,
  });
  const failures: string[] = [];
  if (noSched.count !== 3) failures.push(`count=${noSched.count}`);
  if (noSched.sample.length !== 3) failures.push(`sample.length=${noSched.sample.length}`);
  if (noSched.sample.some((r) => r.scheduledFor)) failures.push("unexpected scheduledFor on no-schedule preview");
  if (noSched.segment_error) failures.push(`segment_error=${noSched.segment_error}`);

  // (b) Schedule applied — scheduledFor merged onto sample rows.
  const fake2 = new FakeSupabaseClient();
  fake2.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "id",
    { data: [{ id: "lead-1" }, { id: "lead-2" }] },
  );
  fake2.on(
    (c) => c.op === "select" && c.table === "leads" && c.selectColumns.includes("contact_name"),
    {
      data: [
        { id: "lead-1", contact_name: "A", contact_phone: "+1" },
        { id: "lead-2", contact_name: "B", contact_phone: "+2" },
      ],
    },
  );
  const withSched = await handlePreviewCampaign(asClient(fake2), BIZ, {
    segment_definition: validSegment,
    schedule_definition: validBulkSchedule,
  });
  if (withSched.count !== 2) failures.push(`withSched.count=${withSched.count}`);
  if (!withSched.sample.every((r) => r.scheduledFor === FUTURE_ISO)) {
    failures.push(`scheduledFor merge failed: ${JSON.stringify(withSched.sample.map((r) => r.scheduledFor))}`);
  }
  if (withSched.schedule_error) failures.push(`schedule_error=${withSched.schedule_error}`);
  record("T6 preview count+sample+scheduledFor", failures.length === 0, failures.join("; ") || "3 (no sched), 2 (with sched merged)");
}

async function T7() {
  const fake = new FakeSupabaseClient();
  const result = await handlePreviewCampaign(asClient(fake), BIZ, {
    segment_definition: { version: 1, filters: { all: [{ field: "leads.bogus", op: "eq", value: "x" }] } },
  });
  const failures: string[] = [];
  if (!result.segment_error) failures.push("segment_error missing");
  if (result.count !== 0) failures.push(`count=${result.count} (expected 0)`);
  if (result.sample.length !== 0) failures.push(`sample.length=${result.sample.length} (expected 0)`);
  // No DB call should have been made — parse failed pre-resolve.
  if (fake.calls.length !== 0) failures.push(`unexpected ${fake.calls.length} DB calls`);
  record("T7 preview parse error inline", failures.length === 0, failures.join("; ") || "200 with segment_error, no DB hit");
}

async function T8() {
  const fake = new FakeSupabaseClient();
  // GET /:id for a campaign that belongs to a different tenant: the
  // .eq("id", X).eq("business_id", BIZ) combo returns no row.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    { data: null },
  );

  const getResult = await handleGetCampaign(asClient(fake), BIZ, CAMP1);
  const failures: string[] = [];
  if (getResult.ok) failures.push("GET unexpectedly ok");
  else if (getResult.status !== 404) failures.push(`GET status=${getResult.status}`);

  // Verify the .eq("business_id", BIZ) was actually applied — not relying
  // on stub behavior. The other-tenant case is symmetric.
  const select = fake.calls.find((c) => c.op === "select" && c.table === "outbound_campaigns");
  if (!select?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("missing business_id filter on GET");
  }
  if (!select?.eqFilters.some((f) => f.column === "id" && f.value === CAMP1)) {
    failures.push("missing id filter on GET");
  }

  // PATCH on cross-tenant: update yields no row. The handler returns
  // 404 (single() returns PGRST116 from PostgREST, but our fake stubs
  // with data=null + error=null which the handler maps via `!data`
  // → 404). Either branch is fine; what matters is no 500.
  const fakePatch = new FakeSupabaseClient();
  fakePatch.on(
    (c) => c.op === "update" && c.table === "outbound_campaigns",
    { data: null },
  );
  const patchResult = await handlePatchCampaign(asClient(fakePatch), OTHER_BIZ, CAMP1, { name: "Renamed" });
  if (patchResult.ok) failures.push("PATCH unexpectedly ok");
  else if (patchResult.status !== 404) failures.push(`PATCH status=${patchResult.status}`);

  record("T8 cross-tenant returns 404", failures.length === 0, failures.join("; ") || "GET 404 + PATCH 404 + tenant filters applied");
}

async function T9() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns",
    { data: [], count: 0 },
  );

  await handleListCampaigns(asClient(fake), BIZ, {
    offset: 100,
    limit: 25,
    status: "active",
  });
  const failures: string[] = [];
  const select = fake.calls.find((c) => c.op === "select" && c.table === "outbound_campaigns");
  if (select?.rangeFrom !== 100) failures.push(`range.from=${select?.rangeFrom}`);
  if (select?.rangeTo !== 124) failures.push(`range.to=${select?.rangeTo} (expected 100 + 25 - 1)`);
  if (select?.orderBy?.column !== "created_at") failures.push(`orderBy.column=${select?.orderBy?.column}`);
  if (select?.orderBy?.ascending !== false) failures.push(`orderBy.ascending=${select?.orderBy?.ascending}`);
  if (!select?.eqFilters.some((f) => f.column === "status" && f.value === "active")) {
    failures.push("missing status=active filter");
  }
  if (!select?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("missing business_id filter");
  }
  // Out-of-range limit clamped.
  const fake2 = new FakeSupabaseClient();
  fake2.on((c) => c.op === "select" && c.table === "outbound_campaigns", { data: [], count: 0 });
  await handleListCampaigns(asClient(fake2), BIZ, { limit: 9999 });
  const select2 = fake2.calls.find((c) => c.op === "select" && c.table === "outbound_campaigns");
  // MAX_LIST_LIMIT = 200, so range(0, 199).
  if (select2?.rangeTo !== 199) failures.push(`clamped limit range.to=${select2?.rangeTo} (expected 199)`);
  record("T9 list offset+limit+filter", failures.length === 0, failures.join("; ") || "range(100,124) + status filter + clamp 200");
}

async function T10() {
  const fake = new FakeSupabaseClient();
  // Owner check.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "outbound_campaigns" &&
      c.selectColumns === "id",
    { data: { id: CAMP1 } },
  );
  // Junction list query.
  fake.on(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads",
    {
      data: [
        {
          id: "ocl-1",
          lead_id: "lead-1",
          state: "pending",
          skip_reason: null,
          scheduled_call_id: null,
          scheduled_for: FUTURE_ISO,
          completed_at: null,
          leads: { contact_name: "Alpha", contact_phone: "+1" },
        },
        {
          id: "ocl-2",
          lead_id: "lead-2",
          state: "skipped",
          skip_reason: "do_not_call",
          scheduled_call_id: null,
          scheduled_for: null,
          completed_at: null,
          leads: { contact_name: "Bravo", contact_phone: "+2" },
        },
      ],
      count: 2,
    },
  );

  const result = await handleGetCampaignLeads(asClient(fake), BIZ, CAMP1, { state: "pending" });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.rows.length !== 2) failures.push(`rows.length=${result.rows.length}`);
    if (result.total !== 2) failures.push(`total=${result.total}`);
    if (result.rows[0]?.leads?.contact_name !== "Alpha") failures.push("joined contact_name missing");
  }
  // Verify the inner-join select includes the leads(...) syntax.
  const listCall = fake.calls.find(
    (c) => c.op === "select" && c.table === "outbound_campaign_leads",
  );
  if (!listCall?.selectColumns.includes("leads!inner")) failures.push("missing leads!inner join");
  if (!listCall?.eqFilters.some((f) => f.column === "campaign_id" && f.value === CAMP1)) {
    failures.push("missing campaign_id filter");
  }
  if (!listCall?.eqFilters.some((f) => f.column === "state" && f.value === "pending")) {
    failures.push("state filter not pushed through");
  }

  // Cross-tenant: owner check returns null → 404 without listing.
  const fakeMiss = new FakeSupabaseClient();
  fakeMiss.on(
    (c) => c.op === "select" && c.table === "outbound_campaigns" && c.selectColumns === "id",
    { data: null },
  );
  const missResult = await handleGetCampaignLeads(asClient(fakeMiss), OTHER_BIZ, CAMP1, {});
  if (missResult.ok) failures.push("cross-tenant unexpectedly ok");
  else if (missResult.status !== 404) failures.push(`cross-tenant status=${missResult.status}`);
  const listProbe = fakeMiss.calls.find((c) => c.table === "outbound_campaign_leads");
  if (listProbe) failures.push("junction list issued despite owner-check miss");

  record("T10 GET /:id/leads + join", failures.length === 0, failures.join("; ") || "2 joined rows + tenant gate + filter pushed");
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

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
