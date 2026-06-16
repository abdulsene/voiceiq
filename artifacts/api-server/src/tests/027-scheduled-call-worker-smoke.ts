/**
 * Phase 1.5b — scheduled-call worker smoke. 11 cases.
 *
 * The worker fires lead_calls rows with status='scheduled' and
 * scheduled_for <= NOW(). It locks each row via UPDATE..RETURNING
 * (status='scheduled' → 'processing'), then invokes placeCall with
 * existingLeadCallId set so the wrapper handles compliance re-check,
 * provider dispatch, and terminal-state UPDATE on failure.
 *
 * Selection / filtering (4):
 *   T1  Empty due rows → {processed:0, succeeded:0, failed:0, locked:0}
 *   T2  One due row → lock + placeCall succeeds → succeeded:1
 *   T3  worker query filters scheduled_for <= NOW() (lte predicate)
 *   T4  worker query filters direction='outbound_automated' (eq predicate)
 *   T5  worker query filters status='scheduled' (eq predicate)
 *
 * Lock semantics (1):
 *   T6  UPDATE..RETURNING returns null (parallel worker won) → locked:1
 *
 * Outcomes via placeCall (2):
 *   T7  Compliance re-check blocks at fire time → failed:1
 *   T8  Provider failure → failed:1
 *
 * Query construction (2):
 *   T9   Worker SELECT uses .limit(100)
 *   T10  Worker SELECT uses .order("scheduled_for", asc=true)
 *
 * Cron lifecycle (1):
 *   T11  scheduleOutboundCallWorker registers a ~60s setTimeout
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/027-scheduled-call-worker-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runScheduledCallSweep,
  scheduleOutboundCallWorker,
  __setSupabaseForTesting,
} from "../cron";
import { __setProviderFactoryForTesting } from "../lib/outbound-voice/place-call";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient (extends 026's pattern with lte/order/limit args) ──

type FakeCall = {
  op: "select" | "insert" | "update";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  lteFilters: Array<{ column: string; value: any }>;
  orderColumn?: string;
  orderAscending?: boolean;
  limitValue?: number;
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
  lte(c: string, v: any) { this.call.lteFilters.push({ column: c, value: v }); return this; }
  order(c: string, opts?: { ascending?: boolean }) {
    this.call.orderColumn = c;
    this.call.orderAscending = opts?.ascending ?? true;
    return this;
  }
  limit(n: number) { this.call.limitValue = n; return this; }
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
      lteFilters: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null };
    return { data: r.data ?? null, error: r.error ?? null };
  }
  auth = { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Provider mock ─────────────────────────────────────────────────────

const placeCallInvocations: Array<{ providerKind: string; opts: any }> = [];
let providerShouldFail: { kind: string; error: string; twilioCode?: number } | null = null;

__setProviderFactoryForTesting((kind: any) => {
  return {
    async placeCall(opts: any) {
      placeCallInvocations.push({ providerKind: kind, opts });
      if (providerShouldFail && providerShouldFail.kind === kind) {
        return { ok: false, provider: kind, error: providerShouldFail.error, twilioCode: providerShouldFail.twilioCode };
      }
      return { ok: true, provider: kind, callSid: `CA_${kind}_${placeCallInvocations.length}` };
    },
  } as any;
});

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven";
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app";

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_027";
const LEAD = "00000000-0000-0000-0000-000000000027";
const PHONE = "+12025557777";

function bizConfigForPlaceCall(opts: { enabled?: boolean } = {}) {
  return {
    outbound_voice_enabled: opts.enabled ?? true,
    outbound_provider: "elevenlabs_hosted",
    record_outbound_calls: true,
    agent_id: "agent_test_027",
    business_name: "T027 Biz",
    twilio_phone_number: "+14155556677",
    elevenlabs_phone_number_id: "phnum_test_027",
  };
}

function bizConfigForCompliance() {
  return {
    outbound_voice_enabled: true,
    outbound_calling_hours_start: "00:00:00",
    outbound_calling_hours_end: "23:59:00",
    outbound_calling_hours_days: [1, 2, 3, 4, 5, 6, 7],
  };
}

function dueRow(id: string, scheduledFor: string) {
  return {
    id,
    lead_id: LEAD,
    scheduled_for: scheduledFor,
    call_objective: "appointment_reminder",
    campaign_id: null,
    attempt_number: 1,
    retry_count: 0,
    leads: { business_id: BIZ },
  };
}

// Stage the entire compliance + placeCall happy-path response chain.
function setupHappyPath(fake: FakeSupabaseClient) {
  // placeCall's lead lookup.
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T027" },
  });
  // business_configs lookups.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigForCompliance() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });
  // Cooperative-lock SELECT (placeCall step 6 in existingLeadCallId mode).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.selectColumns.includes("status") &&
      c.selectColumns.includes("lead_id"),
    { data: { id: "any", status: "processing", lead_id: LEAD } },
  );
  // Generic UPDATEs to lead_calls — covers worker lock + placeCall step 12 + wrapper failed-UPDATE.
  fake.on(
    (c) => c.op === "update" && c.table === "lead_calls",
    { data: { id: "any" } },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // Worker SELECT returns empty.
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );

  const r = await runScheduledCallSweep({ supabase: asClient(fake) });
  const ok =
    r.processed === 0 && r.succeeded === 0 && r.failed === 0 && r.locked === 0 &&
    placeCallInvocations.length === 0;
  record("T1 empty scan", ok, JSON.stringify(r));
}

async function T2() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // Worker SELECT returns one due row.
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [dueRow("lc_due_t2", "2026-06-15T00:00:00Z")] },
  );
  setupHappyPath(fake);

  const r = await runScheduledCallSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.processed !== 1) failures.push(`processed=${r.processed}`);
  if (r.succeeded !== 1) failures.push(`succeeded=${r.succeeded}`);
  if (r.failed !== 0) failures.push(`failed=${r.failed}`);
  if (r.locked !== 0) failures.push(`locked=${r.locked}`);
  if (placeCallInvocations.length !== 1) failures.push(`invocations=${placeCallInvocations.length}`);
  // Worker called lock UPDATE with status='processing'.
  const lockUpd = fake.calls.find(
    (c) =>
      c.op === "update" &&
      c.table === "lead_calls" &&
      c.payload?.status === "processing" &&
      c.eqFilters.some((f) => f.column === "id" && f.value === "lc_due_t2") &&
      c.eqFilters.some((f) => f.column === "status" && f.value === "scheduled"),
  );
  if (!lockUpd) failures.push("missing lock UPDATE status='processing'");
  record("T2 one due row succeeds", failures.length === 0, failures.join("; ") || "processed=1 succeeded=1");
}

async function T3() {
  // Verify the SELECT query uses .lte("scheduled_for", <some ISO>).
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );
  await runScheduledCallSweep({ supabase: asClient(fake) });
  const sel = fake.calls.find((c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"));
  const ok = !!sel && sel.lteFilters.some((f) => f.column === "scheduled_for");
  record("T3 SELECT filters scheduled_for <= NOW", ok, JSON.stringify(sel?.lteFilters || []));
}

async function T4() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );
  await runScheduledCallSweep({ supabase: asClient(fake) });
  const sel = fake.calls.find((c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"));
  const ok = !!sel && sel.eqFilters.some((f) => f.column === "direction" && f.value === "outbound_automated");
  record("T4 SELECT filters direction='outbound_automated'", ok, JSON.stringify(sel?.eqFilters || []));
}

async function T5() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );
  await runScheduledCallSweep({ supabase: asClient(fake) });
  const sel = fake.calls.find((c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"));
  const ok = !!sel && sel.eqFilters.some((f) => f.column === "status" && f.value === "scheduled");
  record("T5 SELECT filters status='scheduled'", ok, JSON.stringify(sel?.eqFilters || []));
}

async function T6() {
  // Lock conflict — UPDATE..RETURNING returns null (no row matched).
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [dueRow("lc_locked_t6", "2026-06-15T00:00:00Z")] },
  );
  // Lock UPDATE returns no row (someone else already grabbed it).
  fake.on(
    (c) => c.op === "update" && c.table === "lead_calls" && c.payload?.status === "processing",
    { data: null },
  );

  const r = await runScheduledCallSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.processed !== 0) failures.push(`processed=${r.processed}`);
  if (r.succeeded !== 0) failures.push(`succeeded=${r.succeeded}`);
  if (r.failed !== 0) failures.push(`failed=${r.failed}`);
  if (r.locked !== 1) failures.push(`locked=${r.locked}`);
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x`);
  record("T6 lock conflict → locked:1", failures.length === 0, failures.join("; ") || "locked=1, no placeCall");
}

async function T7() {
  // Compliance re-check blocks at fire time — DNC added in the gap.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [dueRow("lc_dnc_t7", "2026-06-15T00:00:00Z")] },
  );
  // placeCall happy-path responses EXCEPT DNC now blocks.
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T7" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigForCompliance() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  // DNC NOW BLOCKS.
  fake.on((c) => c.op === "select" && c.table === "dnc_list", {
    data: { source: "manual", reason: "customer_request", created_at: "2026-06-15T00:00:00Z" },
  });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });
  fake.on(
    (c) => c.op === "update" && c.table === "lead_calls",
    { data: { id: "lc_dnc_t7" } },
  );

  const r = await runScheduledCallSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.processed !== 1) failures.push(`processed=${r.processed}`);
  if (r.failed !== 1) failures.push(`failed=${r.failed}`);
  if (r.succeeded !== 0) failures.push(`succeeded=${r.succeeded}`);
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x on compliance block`);
  // Wrapper UPDATEd row to failed/compliance_blocked.
  const terminalUpd = fake.calls.find(
    (c) =>
      c.op === "update" &&
      c.table === "lead_calls" &&
      c.payload?.status === "failed" &&
      c.payload?.end_reason === "compliance_blocked",
  );
  if (!terminalUpd) failures.push("missing wrapper UPDATE status=failed/end_reason=compliance_blocked");
  record("T7 compliance blocks at fire time", failures.length === 0, failures.join("; ") || "failed=1, row terminal");
}

async function T8() {
  // Provider failure — step 11 of placeCall UPDATEs row to failed.
  placeCallInvocations.length = 0;
  providerShouldFail = { kind: "elevenlabs_hosted", error: "elevenlabs_503" };
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [dueRow("lc_provfail_t8", "2026-06-15T00:00:00Z")] },
  );
  setupHappyPath(fake);

  const r = await runScheduledCallSweep({ supabase: asClient(fake) });
  const failures: string[] = [];
  if (r.processed !== 1) failures.push(`processed=${r.processed}`);
  if (r.failed !== 1) failures.push(`failed=${r.failed}`);
  if (r.succeeded !== 0) failures.push(`succeeded=${r.succeeded}`);
  if (placeCallInvocations.length !== 1) failures.push(`invocations=${placeCallInvocations.length}`);
  record("T8 provider failure → failed:1", failures.length === 0, failures.join("; ") || "failed=1");
}

async function T9() {
  // Worker SELECT uses .limit(100).
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );
  await runScheduledCallSweep({ supabase: asClient(fake) });
  const sel = fake.calls.find((c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"));
  const ok = !!sel && sel.limitValue === 100;
  record("T9 SELECT uses .limit(100)", ok, `limit=${sel?.limitValue}`);
}

async function T10() {
  // Worker SELECT uses .order("scheduled_for", asc=true).
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"),
    { data: [] },
  );
  await runScheduledCallSweep({ supabase: asClient(fake) });
  const sel = fake.calls.find((c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns.includes("leads!inner"));
  const ok = !!sel && sel.orderColumn === "scheduled_for" && sel.orderAscending === true;
  record("T10 SELECT uses .order(scheduled_for, asc)", ok, `order=${sel?.orderColumn}/asc=${sel?.orderAscending}`);
}

async function T11() {
  // scheduleOutboundCallWorker registers a ~60s setTimeout.
  const orig = globalThis.setTimeout;
  const captured: Array<{ delay: number }> = [];
  const fakeTimer: any = (_cb: any, delay: number) => {
    captured.push({ delay });
    return 0;  // fake handle; we never fire
  };
  globalThis.setTimeout = fakeTimer;
  try {
    scheduleOutboundCallWorker();
  } finally {
    globalThis.setTimeout = orig;
  }
  const ok = captured.length === 1 && captured[0].delay === 60_000;
  record("T11 scheduleOutboundCallWorker registers 60s timer", ok, JSON.stringify(captured));
}

async function main() {
  __setSupabaseForTesting(null);  // clean start

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

  // Restore for cleanliness.
  __setProviderFactoryForTesting(null);
  __setSupabaseForTesting(null);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
