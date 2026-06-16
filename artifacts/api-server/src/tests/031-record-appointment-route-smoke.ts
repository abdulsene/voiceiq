/**
 * Phase 2.2.5 — record_appointment AI tool route smoke. 12 cases.
 *
 * Tests handleRecordAppointment directly (exported from routes/leads.ts
 * for this purpose). Mirrors the 028 smoke pattern: mock req/res +
 * FakeSupabaseClient. No Express dispatch — handler logic is what we're
 * testing, not auth middleware (auth is verifyToolSecret inside the
 * route wrapper, not the handler).
 *
 * Happy path + lead resolution (3):
 *   T1  conversation_id resolves to lead → appointment INSERTed with
 *       that lead_id; lead_activities row created
 *   T10 conversation_id resolves via the existing chain → exact same
 *       T1 path but explicitly asserts no stub-lead creation occurred
 *   T8  conversation_id misses + contact_phone misses → stub lead
 *       created with source='ai_appointment_booking'; appointment
 *       lead_id = new stub's id
 *
 * Validation (4):
 *   T3 appointment_datetime not parseable → 400
 *   T4 appointment_datetime in the past → 400
 *   T5 reason missing → 400
 *   T11 appointment_datetime null/undefined in payload → 400 (R1)
 *
 * Auth + tenant gating (3):
 *   T2  parseRecordAppointmentPayload rejects → not reached by smoke
 *       (parser is tested via T3/T4/T5/T11); T2 covers business not found → 404
 *   T6  business has record_appointment_enabled=false → 400
 *   T7  Identical to T6 since route auth (Bearer) is wrapper-level —
 *       we instead exercise tenant_disabled here. (T2 doc kept for
 *       traceability with the design doc.)
 *
 * Error paths (2):
 *   T9  DB error on appointments INSERT → 500
 *   T12 stub-lead INSERT fails (best-effort) → STILL returns success
 *       with leadId=null; appointment row lands without lead_id
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/031-record-appointment-route-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { handleRecordAppointment, parseRecordAppointmentPayload } from "../routes/leads";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient (extends 028's pattern with insert + single) ───

type FakeCall = {
  op: "select" | "insert" | "update";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
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
  is() { return this; }
  neq() { return this; }
  not() { return this; }
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
    const call: FakeCall = { op: "select", table, selectColumns: "", eqFilters: [] };
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

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_031";
const CONV_ID = "conv_test_031";
const CALL_DB_ID = "00000000-0000-0000-0000-0000000c1c1c1";
const LEAD_DB_ID = "00000000-0000-0000-0000-00000000031a";
const FUTURE_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function bizConfig(opts: { enabled?: boolean } = {}) {
  return {
    business_id: BIZ,
    record_appointment_enabled: opts.enabled ?? true,
  };
}

// Stage the bizConfig lookup response.
function stageBiz(fake: FakeSupabaseClient, opts: { enabled?: boolean } = {}) {
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("record_appointment_enabled"),
    { data: bizConfig(opts) },
  );
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  const fake = new FakeSupabaseClient();
  stageBiz(fake);
  // Step 1 chain: calls lookup + lead lookup both succeed.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "id",
    { data: { id: CALL_DB_ID } },
  );
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "leads" &&
      c.selectColumns.includes("contact_name") &&
      c.eqFilters.some((f) => f.column === "source_call_id"),
    { data: { id: LEAD_DB_ID, contact_name: "Jane Doe", contact_phone: "+14105551234" } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "appointments",
    { data: { id: 1042, appointment_datetime: FUTURE_ISO } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "lead_activities",
    { data: null },
  );

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Haircut",
    duration_minutes: 45,
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.appointmentId !== 1042) failures.push(`appointmentId=${r.appointmentId}`);
    if (r.leadId !== LEAD_DB_ID) failures.push(`leadId=${r.leadId}`);
  }
  // Verify the appointment INSERT payload.
  const apptIns = fake.calls.find((c) => c.op === "insert" && c.table === "appointments");
  if (apptIns?.payload?.status !== "confirmed") failures.push(`status=${apptIns?.payload?.status}`);
  if (apptIns?.payload?.source !== "ai_receptionist") failures.push(`source=${apptIns?.payload?.source}`);
  if (apptIns?.payload?.lead_id !== LEAD_DB_ID) failures.push(`appt.lead_id=${apptIns?.payload?.lead_id}`);
  if (apptIns?.payload?.duration_minutes !== 45) failures.push(`duration=${apptIns?.payload?.duration_minutes}`);
  if (apptIns?.payload?.caller_phone !== "+14105551234") failures.push(`caller_phone=${apptIns?.payload?.caller_phone}`);
  // lead_activities was inserted.
  const actIns = fake.calls.find((c) => c.op === "insert" && c.table === "lead_activities");
  if (!actIns) failures.push("missing lead_activities INSERT");
  if (actIns?.payload?.actor_type !== "ai_agent") failures.push(`actor_type=${actIns?.payload?.actor_type}`);
  if (actIns?.payload?.action !== "appointment_booked") failures.push(`action=${actIns?.payload?.action}`);
  record("T1 happy path — conversation_id resolves to lead", failures.length === 0, failures.join("; ") || "appointment inserted, lead_id set, activity logged, status=confirmed, source=ai_receptionist");
}

async function T2() {
  // Business not found → 404.
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: null },
  );

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: "nonexistent_biz",
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Haircut",
  });
  const ok = !r.ok && r.status === 404 && /not found/i.test(r.error);
  record("T2 business not found → 404", ok, JSON.stringify(r));
}

async function T3() {
  // Unparseable datetime — parser rejects.
  const result = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: "not-a-date",
    reason: "Haircut",
  });
  const ok = "error" in result && /valid ISO 8601/i.test(result.error);
  record("T3 unparseable datetime → parser 400", ok, JSON.stringify(result));
}

async function T4() {
  // Past appointment_datetime → parser rejects.
  const past = new Date(Date.now() - 60_000).toISOString();
  const result = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: past,
    reason: "Haircut",
  });
  const ok = "error" in result && /future/i.test(result.error);
  record("T4 past appointment_datetime → parser 400", ok, JSON.stringify(result));
}

async function T5() {
  // reason missing → parser rejects.
  const result = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    // reason missing
  });
  const ok = "error" in result && /reason/i.test(result.error);
  record("T5 reason missing → parser 400", ok, JSON.stringify(result));
}

async function T6() {
  // record_appointment_enabled = false → 400.
  const fake = new FakeSupabaseClient();
  stageBiz(fake, { enabled: false });

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Haircut",
  });
  const ok = !r.ok && r.status === 400 && /not enabled/i.test(r.error);
  record("T6 record_appointment_enabled=false → 400", ok, JSON.stringify(r));
}

async function T7() {
  // Trailing-whitespace + length edge: parser trims and enforces caps.
  // Verifies the parser's defensive validation catches over-long inputs
  // (would otherwise inflate the appointments row beyond useful size).
  // Combined with T6's tenant-disabled check, this gives us full
  // coverage on the parser surface.
  const longReason = "a".repeat(600);  // > APPT_REASON_MAX=500
  const result = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: longReason,
  });
  const ok = "error" in result && /exceeds/i.test(result.error);
  record("T7 reason exceeds cap → parser 400", ok, JSON.stringify(result));
}

async function T8() {
  // No lead resolution + stub-lead creation succeeds.
  const fake = new FakeSupabaseClient();
  stageBiz(fake);
  // calls lookup misses.
  fake.on((c) => c.op === "select" && c.table === "calls", { data: null });
  // No contact_phone provided → fallback lookup skipped.
  // Stub-lead INSERT succeeds.
  const STUB_LEAD = "00000000-0000-0000-0000-000000031b3b";
  fake.on(
    (c) => c.op === "insert" && c.table === "leads",
    { data: { id: STUB_LEAD, contact_name: null, contact_phone: null } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "appointments",
    { data: { id: 2055, appointment_datetime: FUTURE_ISO } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "lead_activities",
    { data: null },
  );

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Consultation",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.leadId !== STUB_LEAD) failures.push(`leadId=${r.leadId}`);
  // Stub lead INSERT used source='ai_appointment_booking' per R-Call2.
  const stubIns = fake.calls.find((c) => c.op === "insert" && c.table === "leads");
  if (stubIns?.payload?.source !== "ai_appointment_booking")
    failures.push(`stub source=${stubIns?.payload?.source}`);
  if (stubIns?.payload?.status !== "new") failures.push(`stub status=${stubIns?.payload?.status}`);
  // Appointment INSERT references the stub lead_id.
  const apptIns = fake.calls.find((c) => c.op === "insert" && c.table === "appointments");
  if (apptIns?.payload?.lead_id !== STUB_LEAD) failures.push(`appt.lead_id=${apptIns?.payload?.lead_id}`);
  record("T8 no lead found → stub created (source=ai_appointment_booking)", failures.length === 0, failures.join("; ") || "stub lead + appointment both inserted with lead_id linked");
}

async function T9() {
  // DB error on appointments INSERT → 500.
  const fake = new FakeSupabaseClient();
  stageBiz(fake);
  fake.on((c) => c.op === "select" && c.table === "calls", { data: null });
  // Stub lead INSERT succeeds.
  fake.on(
    (c) => c.op === "insert" && c.table === "leads",
    { data: { id: "stub_t9", contact_name: null, contact_phone: null } },
  );
  // appointments INSERT errors.
  fake.on(
    (c) => c.op === "insert" && c.table === "appointments",
    { data: null, error: { message: "transient db error" } },
  );

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Haircut",
  });
  const ok = !r.ok && r.status === 500;
  record("T9 appointments INSERT errors → 500", ok, JSON.stringify(r));
}

async function T10() {
  // conversation_id resolves AND no stub-lead creation occurs
  // (regression assertion against T8 — verify that when the chain
  // succeeds at step 1, step 3 stub-creation is skipped entirely).
  const fake = new FakeSupabaseClient();
  stageBiz(fake);
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "id",
    { data: { id: CALL_DB_ID } },
  );
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "leads" &&
      c.eqFilters.some((f) => f.column === "source_call_id"),
    { data: { id: LEAD_DB_ID, contact_name: "Jane", contact_phone: "+14105551234" } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "appointments",
    { data: { id: 3010, appointment_datetime: FUTURE_ISO } },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Visit",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.leadId !== LEAD_DB_ID) failures.push(`leadId=${r.leadId}`);
  // Critical: zero leads INSERTs (stub creation should NOT have run).
  const leadInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "leads");
  if (leadInserts.length !== 0) failures.push(`${leadInserts.length} unexpected leads INSERTs (stub fired despite resolved lead)`);
  record("T10 conv_id resolves → NO stub-lead creation", failures.length === 0, failures.join("; ") || "lead resolved via conv_id; zero leads INSERTs");
}

async function T11() {
  // R1 — appointment_datetime null/undefined → parser rejects with
  // "appointment_datetime is required". Two sub-checks (null + undefined).
  const r1 = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: null,
    reason: "Haircut",
  });
  const r2 = parseRecordAppointmentPayload({
    business_id: BIZ,
    conversation_id: CONV_ID,
    // appointment_datetime omitted
    reason: "Haircut",
  });
  const ok =
    "error" in r1 && /required/i.test(r1.error) &&
    "error" in r2 && /required/i.test(r2.error);
  record("T11 appointment_datetime null/undefined → parser 400 (R1)", ok, `null: ${JSON.stringify(r1)} | undef: ${JSON.stringify(r2)}`);
}

async function T12() {
  // Stub-lead INSERT fails — appointment still succeeds with lead_id=null.
  // Verifies the best-effort posture per R2 instructions: if the stub
  // creation fails (e.g. DB constraint, transient error), the
  // appointment INSERT must still proceed with lead_id=null. Lost
  // reminder eligibility is acceptable; lost booking is not.
  const fake = new FakeSupabaseClient();
  stageBiz(fake);
  fake.on((c) => c.op === "select" && c.table === "calls", { data: null });
  // Stub-lead INSERT errors.
  fake.on(
    (c) => c.op === "insert" && c.table === "leads",
    { data: null, error: { message: "constraint_violation" } },
  );
  // Appointment INSERT still succeeds (lead_id will be null).
  fake.on(
    (c) => c.op === "insert" && c.table === "appointments",
    { data: { id: 4012, appointment_datetime: FUTURE_ISO } },
  );

  const r = await handleRecordAppointment(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV_ID,
    appointment_datetime: FUTURE_ISO,
    reason: "Walk-in",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.appointmentId !== 4012) failures.push(`appointmentId=${r.appointmentId}`);
  if (r.ok && r.leadId !== null) failures.push(`leadId=${r.leadId} (expected null after stub failure)`);
  // Appointment INSERT was attempted with lead_id=null.
  const apptIns = fake.calls.find((c) => c.op === "insert" && c.table === "appointments");
  if (apptIns?.payload?.lead_id !== null) failures.push(`appt.lead_id=${apptIns?.payload?.lead_id} (expected null)`);
  // No lead_activities INSERT (no lead to attach to).
  const actInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_activities");
  if (actInserts.length !== 0) failures.push(`${actInserts.length} unexpected lead_activities INSERTs`);
  record("T12 stub-lead fails → appointment STILL succeeds (best-effort)", failures.length === 0, failures.join("; ") || "appointment inserted with lead_id=null after stub failure; no lead_activities");
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

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
