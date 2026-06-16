/**
 * Phase 1.7a — POST /api/business/leads/:id/schedule-call smoke. 8 cases.
 *
 * The route delegates to placeCall with scheduledFor + direction=
 * 'outbound_automated'. placeCall's step-7 defer-branch pre-inserts a
 * lead_calls row with status='scheduled'; the cron worker (Phase 1.5b)
 * picks it up at fire time and re-invokes placeCall via
 * existingLeadCallId mode.
 *
 * Tests exercise handleScheduleCall directly with mock req/res +
 * FakeSupabaseClient (same pattern as 026/027 internal-function smokes).
 * Bypasses the requireAuth + requirePermission middleware — those are
 * Express plumbing concerns, not handler logic. The 028b sibling smoke
 * covers the /configure POST extensions.
 *
 *   T1  Happy path — valid body → placeCall pre-inserts, route returns
 *       200 + { success, lead_call_id, scheduled_for }, lead_activities
 *       insert records source='dashboard' + scheduling_notes
 *   T2  Missing scheduled_for → 400 BEFORE placeCall invocation
 *   T3  scheduled_for in the past → 400 BEFORE placeCall invocation
 *   T4  Invalid call_objective ('marketing_blast') → 400 BEFORE placeCall
 *   T5  Cross-tenant lead → 404 (placeCall returns lead_not_found)
 *   T6  Tenant outbound_voice_enabled=false → 400 (placeCall returns
 *       tenant_outbound_disabled)
 *   T7  Compliance blocks (DNC) → 409 with checks payload
 *   T8  Idempotent re-submit → 200 with idempotent:true; no
 *       lead_activities insert this time
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/028-schedule-call-route-smoke.ts
 */

import type { Request, Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleScheduleCall } from "../routes/lead-calls";

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven";
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient (extends 026's pattern; supports insert+update chains) ──

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

// ── Mock req/res ─────────────────────────────────────────────────────

interface CapturedResponse {
  status: number;
  body: any;
}

function mockReqRes(body: any): { req: Request; res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 200, body: null };
  const req = {
    method: "POST",
    headers: {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    body,
  } as unknown as Request;
  const res = {
    status(code: number) { captured.status = code; return this; },
    json(payload: any) { captured.body = payload; return this; },
  } as unknown as Response;
  return { req, res, captured };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_028";
const LEAD = "00000000-0000-0000-0000-000000000028";
const PHONE = "+12025557777";
const STAFF = "00000000-0000-0000-0000-0000000000af";
const FUTURE_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

function bizConfigForPlaceCall(opts: { enabled?: boolean } = {}) {
  return {
    outbound_voice_enabled: opts.enabled ?? true,
    outbound_provider: "elevenlabs_hosted",
    record_outbound_calls: true,
    agent_id: "agent_test_028",
    business_name: "T028 Biz",
    twilio_phone_number: "+14155556677",
    elevenlabs_phone_number_id: "phnum_test_028",
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

function stageHappyComplianceChain(fake: FakeSupabaseClient) {
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T028" },
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
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  const fake = new FakeSupabaseClient();
  stageHappyComplianceChain(fake);
  // No existing scheduled row matches (idempotency miss).
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.eqFilters.some((f) => f.column === "scheduled_for"),
    { data: null },
  );
  // Pre-insert returns a new row id.
  fake.on(
    (c) => c.op === "insert" && c.table === "lead_calls",
    { data: { id: "lc_t1_028" } },
  );
  fake.on(
    (c) => c.op === "insert" && c.table === "lead_activities",
    { data: null },
  );

  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "appointment_reminder",
    notes: "Reminder for tomorrow's appointment at 2pm",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const failures: string[] = [];
  if (captured.status !== 200) failures.push(`status=${captured.status}`);
  if (captured.body?.success !== true) failures.push(`success=${captured.body?.success}`);
  if (captured.body?.lead_call_id !== "lc_t1_028") failures.push(`lead_call_id=${captured.body?.lead_call_id}`);
  if (captured.body?.idempotent) failures.push(`unexpectedly idempotent`);
  // lead_activities INSERT with metadata.scheduling_notes.
  const activityInsert = fake.calls.find((c) => c.op === "insert" && c.table === "lead_activities");
  if (!activityInsert) failures.push("missing lead_activities INSERT");
  if (activityInsert?.payload?.action !== "call_scheduled") failures.push(`action=${activityInsert?.payload?.action}`);
  if (activityInsert?.payload?.metadata?.scheduling_notes !== "Reminder for tomorrow's appointment at 2pm")
    failures.push(`notes=${activityInsert?.payload?.metadata?.scheduling_notes}`);
  if (activityInsert?.payload?.metadata?.source !== "dashboard")
    failures.push(`source=${activityInsert?.payload?.metadata?.source}`);
  record("T1 happy path schedule", failures.length === 0, failures.join("; ") || "200 + lead_call_id + activity logged");
}

async function T2() {
  const fake = new FakeSupabaseClient();
  const { req, res, captured } = mockReqRes({
    call_objective: "appointment_reminder",
    // scheduled_for missing
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  // placeCall must NOT have been called — no DB queries hit the fake.
  const ok = captured.status === 400 && /scheduled_for/.test(captured.body?.error || "");
  if (fake.calls.length !== 0) {
    record("T2 missing scheduled_for", false, `unexpected ${fake.calls.length} DB calls: status=${captured.status}`);
    return;
  }
  record("T2 missing scheduled_for → 400", ok, `status=${captured.status} error=${captured.body?.error}`);
}

async function T3() {
  const fake = new FakeSupabaseClient();
  const { req, res, captured } = mockReqRes({
    scheduled_for: new Date(Date.now() - 60_000).toISOString(),  // 1 minute ago
    call_objective: "appointment_reminder",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const ok = captured.status === 400 && /future/.test(captured.body?.error || "");
  if (fake.calls.length !== 0) {
    record("T3 past scheduled_for", false, `unexpected ${fake.calls.length} DB calls`);
    return;
  }
  record("T3 past scheduled_for → 400", ok, `status=${captured.status} error=${captured.body?.error}`);
}

async function T4() {
  const fake = new FakeSupabaseClient();
  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "marketing_blast",  // not in known set
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const ok = captured.status === 400 && /call_objective/.test(captured.body?.error || "");
  if (fake.calls.length !== 0) {
    record("T4 invalid call_objective", false, `unexpected ${fake.calls.length} DB calls`);
    return;
  }
  record("T4 invalid call_objective → 400", ok, `status=${captured.status} error=${captured.body?.error}`);
}

async function T5() {
  const fake = new FakeSupabaseClient();
  // Lead lookup returns null — cross-tenant or non-existent.
  fake.on((c) => c.op === "select" && c.table === "leads", { data: null });

  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "appointment_reminder",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const ok = captured.status === 404 && /Lead not found/i.test(captured.body?.error || "");
  record("T5 cross-tenant lead → 404", ok, `status=${captured.status} error=${captured.body?.error}`);
}

async function T6() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T6" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigForPlaceCall({ enabled: false }) },
  );

  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "appointment_reminder",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const ok = captured.status === 400 && /Outbound voice not enabled/i.test(captured.body?.error || "");
  record("T6 outbound disabled → 400", ok, `status=${captured.status} error=${captured.body?.error}`);
}

async function T7() {
  const fake = new FakeSupabaseClient();
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
  // DNC entry blocks.
  fake.on((c) => c.op === "select" && c.table === "dnc_list", {
    data: { source: "manual", reason: "customer_request", created_at: "2026-06-15T00:00:00Z" },
  });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });

  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "appointment_reminder",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const failures: string[] = [];
  if (captured.status !== 409) failures.push(`status=${captured.status}`);
  if (captured.body?.error !== "compliance_blocked") failures.push(`error=${captured.body?.error}`);
  if (captured.body?.blocked_by !== "dnc") failures.push(`blocked_by=${captured.body?.blocked_by}`);
  if (!captured.body?.checks) failures.push("missing checks payload");
  record("T7 compliance blocks → 409", failures.length === 0, failures.join("; ") || "409 + compliance_blocked + dnc + checks");
}

async function T8() {
  const fake = new FakeSupabaseClient();
  stageHappyComplianceChain(fake);
  // Idempotency check finds an existing scheduled row — placeCall
  // returns ok:true + idempotent:true without inserting.
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.eqFilters.some((f) => f.column === "scheduled_for"),
    { data: { id: "lc_existing_028" } },
  );

  const { req, res, captured } = mockReqRes({
    scheduled_for: FUTURE_ISO,
    call_objective: "appointment_reminder",
    notes: "duplicate submit",
  });
  await handleScheduleCall({
    req, res, supabase: asClient(fake),
    businessId: BIZ, leadId: LEAD, staffUserId: STAFF, isAdmin: false,
  });
  const failures: string[] = [];
  if (captured.status !== 200) failures.push(`status=${captured.status}`);
  if (captured.body?.idempotent !== true) failures.push(`idempotent=${captured.body?.idempotent}`);
  if (captured.body?.lead_call_id !== "lc_existing_028") failures.push(`lead_call_id=${captured.body?.lead_call_id}`);
  // No lead_calls INSERT (idempotency short-circuited placeCall).
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 0) failures.push(`unexpected ${inserts.length} lead_calls INSERTs`);
  // No lead_activities INSERT on idempotent re-submit (R2 design).
  const activityInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_activities");
  if (activityInserts.length !== 0) failures.push(`unexpected ${activityInserts.length} lead_activities INSERTs on idempotent`);
  record("T8 idempotent re-submit", failures.length === 0, failures.join("; ") || "200 + idempotent:true + no inserts");
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

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
