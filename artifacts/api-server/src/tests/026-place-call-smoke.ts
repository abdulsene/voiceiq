/**
 * Phase 1.3 — place-call.ts smoke. 29 cases.
 * 18 from 1.3 + T19/T20 from 1.5a + T21-T28 from 2.1 (daily cap) +
 * T29 from 2.1.1 (cap-vs-idempotency ordering fix).
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
 * Phase 1.5a — existingLeadCallId path (2):
 *   T19 worker-locked row succeeds — no INSERT, UPDATE call_sid + status='initiated' + started_at
 *   T20 worker-locked row hits DNC at fire time — wrapper UPDATEs row to failed + compliance_blocked
 *
 * Phase 2.1 — daily cap enforcement (8):
 *   T21 cap=100, today=50 → placeCall proceeds (under cap)
 *   T22 cap=100, today=100 → daily_cap_exceeded with cap+currentCount+targetDay
 *   T23 cap=100, today=99 → placeCall proceeds (boundary; >= cap, not > cap)
 *   T24 inbound_bridge with cap=0 → placeCall proceeds (cap NOT checked for bridge)
 *   T25 cap=100, today=100 but scheduledFor=tomorrow (tomorrow=50) → proceeds (target-day count)
 *   T26 existingLeadCallId + cap=100 + count=100 → daily_cap_exceeded + wrapper UPDATEs row terminal
 *   T27 cap=100, count query errors → fail-open + Sentry, placeCall proceeds
 *   T28 cap=0 kill-switch → daily_cap_exceeded WITHOUT running the count query (short-circuit)
 *
 * Phase 2.1.1 — cap-vs-idempotency ordering (1):
 *   T29 idempotent re-submit at cap → returns idempotent:true (NOT daily_cap_exceeded).
 *       Cap check moved from step 3.5 to step 5.5 so duplicate detection
 *       resolves before quota allocation. Verifies zero count queries ran
 *       (idempotency short-circuited cap check).
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
  // Phase 2.1 — daily cap count queries use .gte/.lt for date windows.
  gteFilters: Array<{ column: string; value: any }>;
  ltFilters: Array<{ column: string; value: any }>;
  // Phase 2.1 — count mode + head-only (no rows) for the cap count query:
  //   .select(cols, { count: "exact", head: true })
  countMode?: "exact" | "planned" | "estimated";
  headMode?: boolean;
  payload?: any;
};
type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  // Phase 2.1 — count value returned when the SELECT was in count mode.
  count?: number | null;
  error?: { message: string } | null;
};

class FakeBuilder {
  constructor(private fake: FakeSupabaseClient, private call: FakeCall) {}
  // .select(cols) OR .select(cols, { count, head }) — supabase-js overloads.
  select(cols: string, opts?: { count?: "exact" | "planned" | "estimated"; head?: boolean }) {
    this.call.selectColumns = cols;
    if (opts?.count) this.call.countMode = opts.count;
    if (opts?.head) this.call.headMode = opts.head;
    return this;
  }
  insert(payload: any) { this.call.op = "insert"; this.call.payload = payload; return this; }
  update(payload: any) { this.call.op = "update"; this.call.payload = payload; return this; }
  eq(c: string, v: any) { this.call.eqFilters.push({ column: c, value: v }); return this; }
  is(c: string, v: any) { this.call.isFilters.push({ column: c, value: v }); return this; }
  neq(c: string, v: any) { this.call.notFilters.push({ column: c, op: "neq", value: v }); return this; }
  not(c: string, op: string, v: any) { this.call.notFilters.push({ column: c, op, value: v }); return this; }
  gte(c: string, v: any) { this.call.gteFilters.push({ column: c, value: v }); return this; }
  lt(c: string, v: any) { this.call.ltFilters.push({ column: c, value: v }); return this; }
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
  // Phase 2.1 — tenant daily cap. null = no cap. 0 = kill-switch.
  maxOutboundCallsPerDay?: number | null;
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
    // Phase 2.1 — daily cap. null = no cap (existing tests pre-2.1).
    max_outbound_calls_per_day:
      o.maxOutboundCallsPerDay === undefined ? null : o.maxOutboundCallsPerDay,
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
  // Phase 5.1 — voice_opt_outs (internal DNC) + voice_consent_records.
  // The tenant-default bypass on business_configs.voice_consent_default
  // was retired in Phase 5.1, so successful paths now require an
  // explicit granted+unrevoked consent row.
  fake.on((c) => c.op === "select" && c.table === "voice_opt_outs", { data: null });
  fake.on((c) => c.op === "select" && c.table === "dnc_list", { data: null });
  fake.on(
    (c) => c.op === "select" && c.table === "voice_consent_records",
    { data: { id: "consent_026_stub", revoked_at: null } },
  );
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });

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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });

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
  // Phase 5.1 — no explicit consent record → blocked_by=no_record.
  // (Tenant default was retired; consent = explicit record only.)
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
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

// ── Phase 1.5a: existingLeadCallId path ─────────────────────────────

async function T19() {
  // Worker has locked an existing row (status='processing'). placeCall
  // should NOT INSERT — it should verify the lock, run compliance,
  // place the call, and UPDATE the row to call_sid + status='initiated'
  // + started_at.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T19" },
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
  // Cooperative-lock SELECT — return the locked row.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.selectColumns.includes("status") &&
      c.eqFilters.some((f) => f.column === "id" && f.value === "lc_existing"),
    { data: { id: "lc_existing", status: "processing", lead_id: LEAD } },
  );
  fake.on((c) => c.op === "update" && c.table === "lead_calls", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "lead_activities", { data: null });
  fake.on((c) => c.op === "insert" && c.table === "audit_logs", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    existingLeadCallId: "lc_existing",
  });

  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok) {
    if (r.status !== "placed") failures.push(`status=${r.status}`);
    if (r.leadCallId !== "lc_existing") failures.push(`leadCallId=${r.leadCallId}`);
  }
  // No INSERT into lead_calls — only UPDATEs.
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 0) failures.push(`unexpected ${inserts.length} lead_calls INSERT`);
  // Success UPDATE includes call_sid + status='initiated' + started_at.
  const successUpd = fake.calls.find(
    (c) => c.op === "update" && c.table === "lead_calls" && c.payload?.call_sid && c.payload?.status === "initiated" && c.payload?.started_at,
  );
  if (!successUpd) failures.push("success UPDATE missing call_sid/status/started_at");
  if (placeCallInvocations.length !== 1) failures.push(`provider called ${placeCallInvocations.length}x (expected 1)`);
  record("T19 existingLeadCallId success path", failures.length === 0, failures.join("; ") || "no INSERT, UPDATE sets call_sid + initiated + started_at");
}

async function T20() {
  // Worker locked an existing row, but DNC was added in the gap →
  // compliance now blocks. placeCall must UPDATE the existing row to
  // status='failed' + end_reason='compliance_blocked' so the worker
  // doesn't re-pick it next tick.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T20" },
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
  // DNC now BLOCKS — entry added in the gap.
  fake.on((c) => c.op === "select" && c.table === "dnc_list", {
    data: { source: "manual", reason: "customer_request", created_at: "2026-06-15T00:00:00Z" },
  });
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
  fake.on((c) => c.op === "update" && c.table === "lead_calls", { data: null });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    existingLeadCallId: "lc_existing_blocked",
  });

  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok && r.reason !== "compliance_blocked") failures.push(`reason=${r.reason}`);
  if (!r.ok && r.reason === "compliance_blocked" && r.blocked_by !== "dnc")
    failures.push(`blocked_by=${r.blocked_by}`);
  // Provider must NOT be invoked when compliance blocks.
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x on compliance block`);
  // Outer wrapper UPDATEd row to failed + compliance_blocked.
  const failUpdate = fake.calls.find(
    (c) =>
      c.op === "update" &&
      c.table === "lead_calls" &&
      c.payload?.status === "failed" &&
      c.payload?.end_reason === "compliance_blocked" &&
      c.eqFilters.some((f) => f.column === "id" && f.value === "lc_existing_blocked"),
  );
  if (!failUpdate) failures.push("missing terminal UPDATE to failed/compliance_blocked");
  record("T20 existingLeadCallId compliance-blocked", failures.length === 0, failures.join("; ") || "compliance_blocked + row UPDATEd to failed/compliance_blocked");
}

// ── Phase 2.1: daily cap enforcement (T21-T28) ───────────────────────

// Helper — stage the parallel scheduled/immediate count-query responses
// for a given target day. Matches on countMode + headMode + gte filter
// column to disambiguate "scheduled_for window query" from "created_at
// window query" and to support T25's today-vs-tomorrow distinction.
function stageCapCount(
  fake: FakeSupabaseClient,
  targetDay: Date,
  opts: { scheduledCount: number; immediateCount: number; error?: { message: string } },
) {
  const dayStart = new Date(Date.UTC(
    targetDay.getUTCFullYear(),
    targetDay.getUTCMonth(),
    targetDay.getUTCDate(),
  )).toISOString();
  // Scheduled-rows query: gte("scheduled_for", dayStart)
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.countMode === "exact" &&
      c.headMode === true &&
      c.gteFilters.some((f) => f.column === "scheduled_for" && f.value === dayStart),
    opts.error
      ? { data: null, count: null, error: opts.error }
      : { data: null, count: opts.scheduledCount },
  );
  // Immediate-rows query: is("scheduled_for", null) + gte("created_at", dayStart)
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.countMode === "exact" &&
      c.headMode === true &&
      c.gteFilters.some((f) => f.column === "created_at" && f.value === dayStart),
    opts.error
      ? { data: null, count: null, error: opts.error }
      : { data: null, count: opts.immediateCount },
  );
}

async function T21() {
  // cap=100, current=50 → proceeds normally.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  // Override the bizConfigForPlaceCall response so it carries a cap of 100.
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }),
  });
  stageCapCount(fake, new Date(), { scheduledCount: 20, immediateCount: 30 });  // total 50

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.status !== "placed") failures.push(`status=${r.status}`);
  record("T21 cap=100, under cap → proceeds", failures.length === 0, failures.join("; ") || "placed normally with cap=100 count=50");
}

async function T22() {
  // cap=100, current=100 → daily_cap_exceeded.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }),
  });
  stageCapCount(fake, new Date(), { scheduledCount: 50, immediateCount: 50 });  // total 100

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok) {
    if (r.reason !== "daily_cap_exceeded") failures.push(`reason=${r.reason}`);
    if (r.reason === "daily_cap_exceeded") {
      if (r.cap !== 100) failures.push(`cap=${r.cap}`);
      if (r.currentCount !== 100) failures.push(`currentCount=${r.currentCount}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.targetDay)) failures.push(`targetDay=${r.targetDay}`);
    }
  }
  // Provider must NOT be invoked when cap blocks.
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x on cap`);
  // No INSERT either.
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 0) failures.push(`${inserts.length} unexpected lead_calls INSERTs`);
  record("T22 cap=100, hit → daily_cap_exceeded", failures.length === 0, failures.join("; ") || "daily_cap_exceeded, cap=100, currentCount=100, targetDay set");
}

async function T23() {
  // cap=100, current=99 → boundary, proceeds (>= cap, not > cap).
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }),
  });
  stageCapCount(fake, new Date(), { scheduledCount: 50, immediateCount: 49 });  // total 99

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.status !== "placed") failures.push(`status=${r.status}`);
  record("T23 cap=100, boundary count=99 → proceeds", failures.length === 0, failures.join("; ") || "placed at count=99 (99 < 100)");
}

async function T24() {
  // inbound_bridge bypasses the cap entirely. cap=0 would normally kill;
  // here we set cap=0 on the BIZ but use direction='inbound_bridge'.
  // outbound_automated would short-circuit; inbound_bridge skips the
  // whole step 3 block including cap.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  // Bridge needs: lead lookup + caller-ID lookup + insert + activity + audit.
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T24" },
  });
  // resolveOutboundCallerId queries business_configs for phone_number.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("phone_number"),
    { data: { business_id: BIZ, phone_number: "+14155551111", twilio_phone_number: "+14155556677" } },
  );
  fake.on((c) => c.op === "insert" && c.table === "lead_calls", { data: { id: "lc_t24" } });
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
  if (r.ok && r.status !== "placed") failures.push(`status=${r.status}`);
  // The whole outbound step 3 block (which contains the cap check)
  // shouldn't have run — no count query should appear in fake.calls.
  const countQueries = fake.calls.filter(
    (c) => c.op === "select" && c.table === "lead_calls" && c.countMode === "exact",
  );
  if (countQueries.length !== 0) failures.push(`${countQueries.length} unexpected count queries on inbound_bridge`);
  record("T24 inbound_bridge bypasses cap entirely", failures.length === 0, failures.join("; ") || "inbound_bridge placed, no count query ran");
}

async function T25() {
  // Today's count is at cap (100), tomorrow's count is 50.
  // scheduledFor=tomorrow → cap check queries tomorrow's count → proceeds.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  setupSuccessfulOutboundFake(fake, { scheduledFor: tomorrow });
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }),
  });
  // Today is FULL.
  stageCapCount(fake, new Date(), { scheduledCount: 50, immediateCount: 50 });
  // Tomorrow has 50.
  stageCapCount(fake, tomorrow, { scheduledCount: 25, immediateCount: 25 });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    scheduledFor: tomorrow,
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)}`);
  if (r.ok && r.status !== "scheduled") failures.push(`status=${r.status}`);
  // Confirm we queried tomorrow's window, not today's.
  const tomorrowStart = new Date(Date.UTC(
    tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(),
  )).toISOString();
  const queriedTomorrow = fake.calls.some(
    (c) =>
      c.op === "select" &&
      c.table === "lead_calls" &&
      c.countMode === "exact" &&
      c.gteFilters.some((f) => f.column === "scheduled_for" && f.value === tomorrowStart),
  );
  if (!queriedTomorrow) failures.push("did not query tomorrow's day window");
  record("T25 scheduledFor=tomorrow counts tomorrow's cap, not today's", failures.length === 0, failures.join("; ") || "queried tomorrow's window, placed at count=50");
}

async function T26() {
  // existingLeadCallId + cap exceeded at fire time → wrapper UPDATEs the
  // existing row to status='failed' end_reason='daily_cap_exceeded'.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T26" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }) },
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
  // Cap is FULL.
  stageCapCount(fake, new Date(), { scheduledCount: 50, immediateCount: 50 });
  // Wrapper UPDATE to terminal failed.
  fake.on(
    (c) => c.op === "update" && c.table === "lead_calls" && c.payload?.status === "failed",
    { data: null },
  );

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
    existingLeadCallId: "lc_existing_t26",
  });
  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok && r.reason !== "daily_cap_exceeded") failures.push(`reason=${r.reason}`);
  // Wrapper terminal UPDATE with end_reason='daily_cap_exceeded'.
  const terminal = fake.calls.find(
    (c) =>
      c.op === "update" &&
      c.table === "lead_calls" &&
      c.payload?.status === "failed" &&
      c.payload?.end_reason === "daily_cap_exceeded" &&
      c.eqFilters.some((f) => f.column === "id" && f.value === "lc_existing_t26"),
  );
  if (!terminal) failures.push("missing wrapper UPDATE status=failed/end_reason=daily_cap_exceeded");
  // Provider not invoked.
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x on cap`);
  record("T26 existingLeadCallId + cap exceeded → wrapper terminalizes row", failures.length === 0, failures.join("; ") || "daily_cap_exceeded + row UPDATEd to failed/daily_cap_exceeded");
}

async function T27() {
  // Count query errors → fail-open. Sentry fires; placeCall proceeds.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  setupSuccessfulOutboundFake(fake);
  fake.responses.unshift({
    match: (c) =>
      c.op === "select" &&
      c.table === "business_configs" &&
      c.selectColumns.includes("outbound_provider"),
    data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }),
  });
  // Stage cap count to return an error from both parallel queries.
  stageCapCount(fake, new Date(), {
    scheduledCount: 0,
    immediateCount: 0,
    error: { message: "transient" },
  });

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (!r.ok) failures.push(`!ok: ${JSON.stringify(r)} — expected fail-open`);
  if (r.ok && r.status !== "placed") failures.push(`status=${r.status}`);
  // The provider WAS invoked — fail-open path proceeded all the way.
  if (placeCallInvocations.length !== 1) failures.push(`provider invoked ${placeCallInvocations.length}x (expected 1 on fail-open)`);
  record("T27 count query errors → fail-open + proceeds", failures.length === 0, failures.join("; ") || "fail-open, placed normally");
}

async function T28() {
  // cap=0 kill-switch — short-circuits BEFORE the count query.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T28" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 0 }) },
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
  // DO NOT stage cap count — verifying it's never invoked.

  const r = await placeCall(asClient(fake), {
    businessId: BIZ,
    leadId: LEAD,
    direction: "outbound_automated",
    callObjective: "appointment_reminder",
  });
  const failures: string[] = [];
  if (r.ok) failures.push("ok=true unexpectedly");
  if (!r.ok && r.reason !== "daily_cap_exceeded") failures.push(`reason=${r.reason}`);
  if (!r.ok && r.reason === "daily_cap_exceeded") {
    if (r.cap !== 0) failures.push(`cap=${r.cap}`);
    if (r.currentCount !== 0) failures.push(`currentCount=${r.currentCount}`);
  }
  // The R6 kill-switch must short-circuit BEFORE the count query runs.
  const countQueries = fake.calls.filter(
    (c) => c.op === "select" && c.table === "lead_calls" && c.countMode === "exact",
  );
  if (countQueries.length !== 0) failures.push(`${countQueries.length} unexpected count queries (kill-switch should short-circuit)`);
  if (placeCallInvocations.length !== 0) failures.push(`provider invoked ${placeCallInvocations.length}x on kill-switch`);
  record("T28 cap=0 kill-switch short-circuits", failures.length === 0, failures.join("; ") || "daily_cap_exceeded, cap=0, no count query ran");
}

// ── Phase 2.1.1: cap-vs-idempotency ordering (T29) ───────────────────

async function T29() {
  // Idempotent re-submit at cap → returns idempotent:true, NOT
  // daily_cap_exceeded. Cap check (step 5.5) must run AFTER idempotency
  // check (step 5), so a matching scheduled row short-circuits before
  // any cap evaluation. Existing row is already counted against cap;
  // re-submit wouldn't insert a new row, so cap is irrelevant.
  placeCallInvocations.length = 0;
  providerShouldFail = null;
  const fake = new FakeSupabaseClient();
  const scheduledFor = new Date(Date.now() + 7200_000);

  fake.on((c) => c.op === "select" && c.table === "leads", {
    data: { id: LEAD, business_id: BIZ, contact_phone: PHONE, reason: "T29" },
  });
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("outbound_provider"),
    { data: bizConfigDataForPlaceCall({ maxOutboundCallsPerDay: 100 }) },
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
  fake.on((c) => c.op === "select" && c.table === "voice_consent_records", { data: { id: "consent_stub_026", revoked_at: null } });
  // Idempotency match — existing scheduled row.
  fake.on(
    (c) => c.op === "select" && c.table === "lead_calls" && c.eqFilters.some((f) => f.column === "scheduled_for"),
    { data: { id: "lc_existing_t29" } },
  );
  // If cap check ran (which it MUST NOT), it would hit count=100 → daily_cap_exceeded.
  // Stage it anyway to prove the check was never invoked.
  stageCapCount(fake, scheduledFor, { scheduledCount: 50, immediateCount: 50 });

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
    if (r.status !== "scheduled") failures.push(`status=${r.status}`);
    if (r.idempotent !== true) failures.push(`idempotent=${r.idempotent}`);
    if (r.leadCallId !== "lc_existing_t29") failures.push(`leadCallId=${r.leadCallId}`);
  }
  // Cap count queries must NOT have run — idempotency short-circuited.
  const countQueries = fake.calls.filter(
    (c) => c.op === "select" && c.table === "lead_calls" && c.countMode === "exact",
  );
  if (countQueries.length !== 0) failures.push(`${countQueries.length} unexpected count queries (idempotency should short-circuit cap check)`);
  // No new lead_calls INSERT.
  const inserts = fake.calls.filter((c) => c.op === "insert" && c.table === "lead_calls");
  if (inserts.length !== 0) failures.push(`${inserts.length} unexpected lead_calls INSERTs`);
  record("T29 idempotent re-submit at cap → idempotent:true (not daily_cap_exceeded)", failures.length === 0, failures.join("; ") || "idempotent:true, zero count queries, zero inserts");
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
  await T19();
  await T20();
  await T21();
  await T22();
  await T23();
  await T24();
  await T25();
  await T26();
  await T27();
  await T28();
  await T29();

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
