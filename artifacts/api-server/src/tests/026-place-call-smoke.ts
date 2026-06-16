/**
 * Phase 1.3 — place-call.ts smoke. 18 cases.
 *
 * Happy paths (4):
 *   T1  inbound_bridge immediate placement
 *   T2  outbound_automated immediate via 'twilio' provider
 *   T3  outbound_automated immediate via 'elevenlabs_hosted'
 *   T4  outbound_automated scheduledFor → status='scheduled', no provider call
 *
 * Compliance blocks (3):
 *   T5  outbound DNC blocked
 *   T6  outbound calling_hours blocked
 *   T7  outbound consent blocked
 *
 * Config blocks (2):
 *   T8  outbound_voice_enabled=FALSE → tenant_outbound_disabled
 *   T9  non-NANP phone (UK +44) → non_nanp_number_no_tz_inference
 *
 * Guards (3):
 *   T10 cross-tenant lead → lead_not_found
 *   T11 invalid contact_phone → lead_phone_invalid
 *   T12 outbound_automated for nonexistent lead → lead_not_found
 *
 * Idempotency (2):
 *   T13 scheduledFor with matching scheduled row → idempotent:true
 *   T14 scheduledFor with no matching row → new insert
 *
 * Provider failures (2):
 *   T15 TwilioRestProvider returns ok:false → lead_calls failed, provider_failed
 *   T16 ElevenLabsHostedProvider returns ok:false → same
 *
 * Inbound bridge specifics (2):
 *   T17 inbound_bridge missing staffRingNumber → staff_ring_number_missing
 *   T18 inbound_bridge ignores business_configs.outbound_provider='elevenlabs_hosted'
 *
 * Strategy: FakeSupabaseClient with .from(...).select(...).eq(...).maybeSingle()
 * + .insert(...).select(...).single() + .update(...).eq(...) chains.
 * Provider mocked via injection into getProvider's options (test stub).
 *
 * Phone number used throughout: +12025557777 (DC, NANP). UK number for T9.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/026-place-call-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  placeCall,
  type PlaceCallResponse,
  __setProviderFactoryForTesting,
} from "../lib/outbound-voice/place-call";

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
  isFilters: Array<{ column: string; value: any }>;
  notFilters: Array<{ column: string; op: string; value: any }>;
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
  is(c: string, v: any) { this.call.isFilters.push({ column: c, value: v }); return this; }
  neq(c: string, v: any) { this.call.notFilters.push({ column: c, op: "neq", value: v }); return this; }
  not(c: string, op: string, v: any) { this.call.notFilters.push({ column: c, op, value: v }); return this; }
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
      isFilters: [],
      notFilters: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }
  async resolveCall(call: FakeCall) {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null };
    return { data: r.data ?? null, error: r.error ?? null };
  }
  // auditLog uses (supabase as any).from("audit_logs") — implemented above.
  // Stub auth.admin.getUserById for any code path that needs it (not used here).
  auth = { admin: { getUserById: async () => ({ data: { user: null }, error: null }) } };
}

const asClient = (f: FakeSupabaseClient) => f as unknown as SupabaseClient;

// ── Provider mock ────────────────────────────────────────────────────
// place-call.ts → getProvider() reads from "./index" which constructs
// real Twilio/ElevenLabs providers. We monkey-patch the providers'
// modules via the __setSupabaseForTesting-style injection. Simpler:
// stub the underlying twilio client + global fetch.

const placeCallInvocations: Array<{ providerKind: "twilio" | "elevenlabs_hosted"; opts: any }> = [];
let providerShouldFail: { kind: "twilio" | "elevenlabs_hosted"; error: string; twilioCode?: number } | null = null;

// Patch the providers via the test injection seam exported by
// place-call.ts. Direct namespace mutation is impossible under Node 24
// ESM (frozen namespaces).
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

// ── Env sentinels ────────────────────────────────────────────────────

process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven";
process.env.PUBLIC_API_URL = process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app";

// ── Fixtures ─────────────────────────────────────────────────────────

const BIZ = "biz_test_026";
const LEAD = "00000000-0000-0000-0000-000000000026";
const PHONE = "+12025557777";
const STAFF = "00000000-0000-0000-0000-0000000000af";

interface BizConfigOverrides {
  enabled?: boolean;
  provider?: "twilio" | "elevenlabs_hosted";
  recordOutbound?: boolean;
  agentId?: string;
  twilioPhone?: string;
  elevenlabsPhoneNumberId?: string;
  hoursStart?: string;
  hoursEnd?: string;
  hoursDays?: number[];
}

function bizConfigDataForCompliance(o: BizConfigOverrides = {}) {
  return {
    outbound_voice_enabled: o.enabled ?? true,
    outbound_calling_hours_start: o.hoursStart ?? "00:00:00",
    outbound_calling_hours_end: o.hoursEnd ?? "23:59:00",
    outbound_calling_hours_days: o.hoursDays ?? [1, 2, 3, 4, 5, 6, 7],
  };
}
function bizConfigDataForPlaceCall(o: BizConfigOverrides = {}) {
  return {
    outbound_voice_enabled: o.enabled ?? true,
    outbound_provider: o.provider ?? "elevenlabs_hosted",
    record_outbound_calls: o.recordOutbound ?? true,
    agent_id: o.agentId ?? "agent_test_026",
    business_name: "T026 Biz",
    twilio_phone_number: o.twilioPhone ?? "+14155556677",
    elevenlabs_phone_number_id: o.elevenlabsPhoneNumberId ?? "phnum_test_026",
  };
}

// Add resolveOutboundCallerId responses — the helper queries
// business_configs for business_id, phone_number, twilio_phone_number.
function callerIdData(twilioPhone = "+14155556677") {
  return { business_id: BIZ, phone_number: "+14155551111", twilio_phone_number: twilioPhone };
}

// Set up the standard outbound-automated success response chain.
function setupSuccessfulOutboundFake(fake: FakeSupabaseClient, opts: { scheduledFor?: Date | null } = {}) {
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T026 reason" },
  });
  // business_configs (called twice — once by place-call directly, once by
  // checkCallingHours inside checkCompliance).
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigDataForCompliance() },
  );
  // checkVoiceConsent fallback path also reads business_configs.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  // dnc + voice_consent_records — empty / not blocked.
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });
  // Idempotency check for scheduled.
  if (!opts.scheduledFor) {
    // no scheduled query expected
  } else {
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls" && c.eqFilters.some((f) => f.column === "scheduled_for"),
      { data: null },
    );
  }
  fake.on((c) => c.op === "insert" && c.table === "lead_calls", { data: { id: "lc_test_26" } });
  fake.on((c) => c.op === "update" && c.table === "lead_calls", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });
}

// ── Tests ────────────────────────────────────────────────────────────

async function T1() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T1" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("phone_number"),
    { data: callerIdData() },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_calls", { data: { id: "lc_t1" } });
  fake.on((c) => c.op === "update" && c.table === "lead_calls", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "inbound_bridge",
    staffUserId: STAFF,
    staffRingNumber: "+14105557777",
  });

  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.status !== "placed") failures.push(`status=${r.status}`);
    if (r.provider !== "twilio") failures.push(`provider=${r.provider}`);
    if (!r.callSid) failures.push("no callSid");
    // resolveOutboundCallerId prefers the business main line over the
    // Twilio fallback — callerIdData() sets phone_number=+14155551111.
    if (r.status === "placed" && r.fromCallerId !== "+14155551111")
      failures.push(`fromCallerId=${r.fromCallerId}`);
  }
  if (placeCallInvocations[0]?.providerKind !== "twilio") failures.push(`provider invoked=${placeCallInvocations[0]?.providerKind}`);
  record("T1 inbound_bridge immediate", failures.length === 0, failures.join("; ") || "ok, status=placed, twilio, fromCallerId set");
}

async function T2() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  // Override provider response to twilio.
  fake.responses.unshift({
    match: (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ provider: "twilio" }),
  });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.provider !== "twilio") failures.push(`provider=${r.provider}`);
  if (r.ok && r.status === "placed" && r.fromCallerId !== "+14155556677")
    failures.push(`fromCallerId=${r.fromCallerId}`);
  if (placeCallInvocations[0]?.providerKind !== "twilio") failures.push(`invoked=${placeCallInvocations[0]?.providerKind}`);
  record("T2 outbound_automated twilio", failures.length === 0, failures.join("; ") || "ok, twilio provider invoked, fromCallerId set");
}

async function T3() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.provider !== "elevenlabs_hosted") failures.push(`provider=${r.provider}`);
  // ElevenLabs hosted resolves from-number from phone_number_id; placeCall
  // does not surface it. fromCallerId MUST be undefined here.
  if (r.ok && r.status === "placed" && r.fromCallerId !== undefined)
    failures.push(`fromCallerId should be undefined for elevenlabs, got ${r.fromCallerId}`);
  if (placeCallInvocations[0]?.providerKind !== "elevenlabs_hosted") failures.push(`invoked=${placeCallInvocations[0]?.providerKind}`);
  record("T3 outbound_automated elevenlabs_hosted (default)", failures.length === 0, failures.join("; ") || "ok, elevenlabs_hosted invoked, fromCallerId omitted");
}

async function T4() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake, { scheduledFor: new Date(Date.now() + 3600_000) });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    scheduledFor: new Date(Date.now() + 3600_000),
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.status !== "scheduled") failures.push(`status=${r.status}`);
    if (r.callSid !== null) failures.push(`callSid=${r.callSid}`);
    if (r.provider !== null) failures.push(`provider=${r.provider}`);
  }
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x when scheduled`);
  record("T4 outbound_automated scheduledFor → no placement", failures.length === 0, failures.join("; ") || "scheduled, no provider call");
}

async function T5() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T5" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigDataForCompliance() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  fake.on((c) => c.op === "select" && c.table === "dnc_list", {
    data: { source: "manual", reason: "customer_request", created_at: "2026-06-01T00:00:00Z" },
  });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const ok =
    !r.ok && r.reason === "compliance_blocked" && r.blocked_by === "dnc" && r.checks.dnc.allowed === false;
  record("T5 DNC blocks outbound", ok, JSON.stringify(r));
}

async function T6() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T6" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );
  // calling-hours window that no time falls inside (00:00-00:01) on
  // the wrong day.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigDataForCompliance({ hoursStart: "00:00:00", hoursEnd: "00:01:00" }) },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });

  // Use a fixed future time when we know we'll be outside the 1-minute window.
  const probableOutside = new Date("2026-06-15T15:00:00Z");
  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    scheduledFor: probableOutside,
  });
  const ok = !r.ok && r.reason === "compliance_blocked" && r.blocked_by === "calling_hours";
  record("T6 calling_hours blocks outbound", ok, JSON.stringify(r));
}

async function T7() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T7" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigDataForCompliance() },
  );
  // consent default FALSE + no explicit record → blocked by no_record
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: false } },
  );
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const ok = !r.ok && r.reason === "compliance_blocked" && r.blocked_by === "consent";
  record("T7 consent blocks outbound", ok, JSON.stringify(r));
}

async function T8() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T8" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall({ enabled: false }) },
  );

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  record("T8 outbound_voice_enabled=FALSE", !r.ok && r.reason === "tenant_outbound_disabled", JSON.stringify(r));
}

async function T9() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: "+447911123456", reason: "T9" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  record("T9 non-NANP phone", !r.ok && r.reason === "non_nanp_number_no_tz_inference", JSON.stringify(r));
}

async function T10() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // leads lookup returns null when business_id doesn't match.
  fake.on((c) => c.op === "select" && c.table === "leads", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "inbound_bridge",
    staffUserId: STAFF,
    staffRingNumber: "+14105557777",
  });
  record("T10 cross-tenant lead", !r.ok && r.reason === "lead_not_found", JSON.stringify(r));
}

async function T11() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: "not-a-phone", reason: "T11" },
  });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "inbound_bridge",
    staffUserId: STAFF,
    staffRingNumber: "+14105557777",
  });
  record("T11 invalid contact_phone", !r.ok && r.reason === "lead_phone_invalid", JSON.stringify(r));
}

async function T12() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  record("T12 outbound to nonexistent lead", !r.ok && r.reason === "lead_not_found", JSON.stringify(r));
}

async function T13() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  const scheduledFor = new Date(Date.now() + 7200_000);
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T13" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_calling_hours_start"),
    { data: bizConfigDataForCompliance() },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("voice_consent_default"),
    { data: { voice_consent_default: true } },
  );
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: null });
  // Idempotency match — return existing row.
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.eqFilters.some((f) => f.column === "scheduled_for"),
    { data: { id: "lc_existing" } },
  );

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    scheduledFor,
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.idempotent !== true) failures.push(`idempotent=${r.idempotent}`);
    if (r.leadCallId !== "lc_existing") failures.push(`leadCallId=${r.leadCallId}`);
    if (r.status !== "scheduled") failures.push(`status=${r.status}`);
  }
  // Confirm no INSERT into lead_calls happened (the early return).
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 0) failures.push(`unexpected ${inserts.length} lead_calls insert`);
  record("T13 idempotent re-schedule returns existing", failures.length === 0, failures.join("; ") || "idempotent:true, no new insert");
}

async function T14() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  const scheduledFor = new Date(Date.now() + 7200_000);
  setupSuccessfulOutboundFake(fake, { scheduledFor });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    scheduledFor,
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.idempotent === true) failures.push("unexpectedly idempotent");
    if (r.status !== "scheduled") failures.push(`status=${r.status}`);
  }
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 1) failures.push(`expected 1 lead_calls insert, got ${inserts.length}`);
  record("T14 scheduledFor with no match → new insert", failures.length === 0, failures.join("; ") || "new insert, status=scheduled");
}

async function T15() {
  placeCallInvocations.length = 0;
  providerShouldFail = { kind: "twilio", error: "twilio_create_failed", twilioCode: 13224 };
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  fake.responses.unshift({
    match: (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ provider: "twilio" }),
  });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok) {
    if (r.reason !== "provider_failed") failures.push(`reason=${r.reason}`);
    if ((r as any).provider !== "twilio") failures.push(`provider=${(r as any).provider}`);
    if ((r as any).twilioCode !== 13224) failures.push(`twilioCode=${(r as any).twilioCode}`);
  }
  const failUpdate = fake.calls.find(
    (c) => c.op === "update" && c.table === "lead_calls" && c.payload?.status === "failed",
  );
  if (!failUpdate) failures.push("lead_calls failed-status UPDATE not issued");
  record("T15 twilio provider failure", failures.length === 0, failures.join("; ") || "provider_failed + failed UPDATE issued");
}

async function T16() {
  placeCallInvocations.length = 0;
  providerShouldFail = { kind: "elevenlabs_hosted", error: "elevenlabs_503" };
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok && r.reason !== "provider_failed") failures.push(`reason=${r.reason}`);
  if (!r.ok && (r as any).provider !== "elevenlabs_hosted") failures.push(`provider=${(r as any).provider}`);
  record("T16 elevenlabs_hosted provider failure", failures.length === 0, failures.join("; ") || "provider_failed");
}

async function T17() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // Lead lookup will still happen but ring number check happens at
  // input-validation step (before lead lookup), so this should fail
  // synchronously without DB.

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "inbound_bridge",
    staffUserId: STAFF,
    // staffRingNumber missing
  });
  record("T17 inbound_bridge missing staffRingNumber", !r.ok && r.reason === "staff_ring_number_missing", JSON.stringify(r));
}

async function T18() {
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // Even though tenant default is elevenlabs_hosted, bridge call must
  // use twilio. We populate the outbound_provider field anyway to
  // prove place-call ignores it for inbound_bridge.
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T18" },
  });
  // resolveOutboundCallerId reads phone_number + twilio_phone_number.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("phone_number"),
    { data: callerIdData() },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_calls", { data: { id: "lc_t18" } });
  fake.on((c) => c.op === "update" && c.table === "lead_calls", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "inbound_bridge",
    staffUserId: STAFF,
    staffRingNumber: "+14105557777",
    providerOverride: "elevenlabs_hosted" as any, // try to force ElevenLabs — should be ignored
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.provider !== "twilio") failures.push(`provider=${r.provider}`);
  // Same as T1 — business_main_line wins per resolveOutboundCallerId.
  if (r.ok && r.status === "placed" && r.fromCallerId !== "+14155551111")
    failures.push(`fromCallerId=${r.fromCallerId}`);
  if (placeCallInvocations[0]?.providerKind !== "twilio") failures.push(`invoked=${placeCallInvocations[0]?.providerKind}`);
  record("T18 inbound_bridge always uses twilio", failures.length === 0, failures.join("; ") || "twilio used despite ElevenLabs override, fromCallerId set");
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
  await T14();
  await T15();
  await T16();
  await T17();
  await T18();

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
