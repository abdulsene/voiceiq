/**
 * Phase 3.2a — routing engine smoke. 21 cases (T1-T21) covering:
 *   - Pure decision function (fallback-logic.decideRouting)
 *   - Pure TwiML builder (dial-builder.buildDialTwiml, composeWhisperText)
 *   - Handler (routes/routing.handleRouteToTopic) with FakeSupabaseClient
 *   - Body validation (routes/routing.parseRouteBody)
 *
 *   T1  Single match — one on-duty for topic → topic_match path
 *   T2  Multiple matches (3) — TwiML contains 3 <Number>
 *   T3  No topic match + on-duty exists → any_on_duty fallback
 *   T4  No on-duty + business open + transfer_to_phone → legacy_transfer
 *   T5  No on-duty + business closed → after_hours_callback (twiml=null)
 *   T6  No on-duty + no transfer_to_phone + business open → graceful_hangup
 *   T7  Topic match TwiML shape — timeout, callerId, recording attrs
 *   T8  Cross-tenant: topic from another business doesn't match
 *   T9  On-duty for topic but callback_ring_number NULL → skipped
 *   T10 topic_slug not in departments → any_on_duty w/ topic_no_longer_configured
 *   T11 rung_user_ids logged with all dialed user ids
 *   T12 topic_slug + handoff_reason written to calls on every routing attempt
 *   T13 transfer_status = 'routing_topic_match' on the topic-match path
 *   T14 handoff_reason accurately reflects each fallback path
 *   T15 topic_slug written even when no match found (topic_no_longer_configured)
 *   T16 parseRouteBody rejects missing fields / wrong types
 *   T17 buildDialTwiml includes timeout attribute (Phase A: 30s default)
 *   T18 buildDialTwiml includes recordingStatusCallback + record attrs
 *   T19 after_hours path: twiml=null, message_for_llm asks for callback
 *   T20 handler is pure (two independent invocations don't interfere)
 *   T21 topic cleared mid-call: departments has other topics but not this
 *       one → any_on_duty w/ handoff_reason=topic_no_longer_configured
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/040-routing-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideRouting,
  type RoutingInputs,
  type StaffCandidate,
} from "../lib/routing/fallback-logic";
import {
  buildDialTwiml,
  buildWhisperTwiml,
  composeWhisperText,
} from "../lib/routing/dial-builder";
import {
  handleRouteToTopic,
  parseRouteBody,
} from "../routes/routing";

// ── Test harness ────────────────────────────────────────────────────

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient ──────────────────────────────────────────────

type FakeCall = {
  op: "select" | "insert" | "update" | "upsert" | "delete";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  inFilters: Array<{ column: string; values: any[] }>;
  orderBy?: { column: string; ascending: boolean };
  payload?: any;
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
  insert(payload: any) {
    this.call.op = "insert";
    this.call.payload = payload;
    return this;
  }
  update(payload: any) {
    this.call.op = "update";
    this.call.payload = payload;
    return this;
  }
  delete() {
    this.call.op = "delete";
    return this;
  }
  eq(c: string, v: any) {
    this.call.eqFilters.push({ column: c, value: v });
    return this;
  }
  in(c: string, vs: any[]) {
    this.call.inFilters.push({ column: c, values: vs });
    return this;
  }
  is() { return this; }
  neq() { return this; }
  order(column: string, opts?: { ascending?: boolean }) {
    this.call.orderBy = { column, ascending: opts?.ascending ?? true };
    return this;
  }
  limit() { return this; }
  async maybeSingle() {
    return this.fake.resolveCall(this.call);
  }
  async single() {
    return this.fake.resolveCall(this.call);
  }
  then(resolve: any, reject: any) {
    return this.fake.resolveCall(this.call).then(resolve, reject);
  }
  catch(handler: any) {
    return this.fake.resolveCall(this.call).catch(handler);
  }
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

// ── Fixtures ────────────────────────────────────────────────────────

const BIZ = "biz_test_040";
const OTHER_BIZ = "biz_other_040";
const CONV = "conv_test_040";
const CALL_ID = "call_test_040";

const USER_A = "00000000-0000-0000-0000-0000000000aa";
const USER_B = "00000000-0000-0000-0000-0000000000bb";
const USER_C = "00000000-0000-0000-0000-0000000000cc";

const PHONE_A = "+14155550001";
const PHONE_B = "+14155550002";
const PHONE_C = "+14155550003";
const LEGACY_PHONE = "+14155559999";

const TOPIC_ROADSIDE = "roadside_breakdown";
const TOPIC_PAYMENTS = "payments";

const BIZ_DEPARTMENTS = [
  { slug: TOPIC_ROADSIDE, name: "Roadside & breakdown" },
  { slug: TOPIC_PAYMENTS, name: "Payments & billing" },
];

/**
 * Stub the business_configs + business_hours + calls interactions the
 * handler makes. Callers add per-test overrides on top.
 */
function stubDefaultBusiness(
  fake: FakeSupabaseClient,
  opts: {
    departments?: Array<{ slug: string; name: string }>;
    legacyTransferToPhone?: string | null;
    hoursOpen?: boolean;
    hoursRows?: any[];
    businessName?: string;
  } = {},
) {
  const departments = opts.departments ?? BIZ_DEPARTMENTS;
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns.includes("departments"),
    {
      data: {
        business_name: opts.businessName ?? "EZ Rentals",
        transfer_to_phone: opts.legacyTransferToPhone ?? null,
        transfer_warm_message: null,
        twilio_phone_number: "+18005551234",
        phone_number: null,
        departments,
      },
    },
  );
  // handleHoursNow reads business_hours + business_configs.
  const hoursRows =
    opts.hoursRows ??
    (opts.hoursOpen === false
      ? Array.from({ length: 7 }, (_, dow) => ({
          day_of_week: dow,
          opens_at: null,
          closes_at: null,
          timezone: "America/New_York",
          is_closed: true,
        }))
      : Array.from({ length: 7 }, (_, dow) => ({
          day_of_week: dow,
          opens_at: "00:00:00",
          closes_at: "23:59:00",
          timezone: "America/New_York",
          is_closed: false,
        })));
  fake.on(
    (c) => c.op === "select" && c.table === "business_hours",
    { data: hoursRows },
  );
  // Fallback business_configs read from handleHoursNow's parsed_fallback path.
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns === "business_hours",
    { data: { business_hours: "Monday-Friday 9AM-5PM" } },
  );
  // calls UPDATE — best-effort row match.
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { data: { id: CALL_ID } },
  );
}

function stubStaffTopics(fake: FakeSupabaseClient, rows: Array<{ user_id: string; topic_slug: string }>) {
  fake.on(
    (c) => c.op === "select" && c.table === "staff_topics",
    { data: rows },
  );
}

function stubUserBusinessesOnDuty(
  fake: FakeSupabaseClient,
  rows: Array<{ user_id: string; callback_ring_number: string | null; on_duty_since?: string }>,
) {
  // Two calls hit user_businesses:
  //   (a) loadOnDutyForTopic: .in("user_id", topicUserIds)
  //   (b) loadOnDutyAny:      .eq("is_on_duty", true) with order
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses" && c.inFilters.some((f) => f.column === "user_id"),
    { data: rows },
  );
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      !c.inFilters.some((f) => f.column === "user_id"),
    { data: rows },
  );
}

const baseBody = {
  business_id: BIZ,
  conversation_id: CONV,
  topic_slug: TOPIC_ROADSIDE,
  reason: "Customer's car broke down",
};

// ── Tests ────────────────────────────────────────────────────────────

async function T1_single_match_topic() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    onDutyAny: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    businessOpen: true,
    legacyTransferToPhone: LEGACY_PHONE,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const failures: string[] = [];
  if (d.path !== "topic_match") failures.push(`path=${d.path}`);
  if (d.staffPhones.length !== 1) failures.push(`phones=${d.staffPhones.length}`);
  if (d.staffPhones[0] !== PHONE_A) failures.push(`phone[0]=${d.staffPhones[0]}`);
  if (d.staffUserIds[0] !== USER_A) failures.push(`user_id[0]=${d.staffUserIds[0]}`);
  if (d.handoffReason !== "topic_match_answered") failures.push(`reason=${d.handoffReason}`);
  if (d.transferStatus !== "routing_topic_match") failures.push(`status=${d.transferStatus}`);
  record("T1 single match topic", failures.length === 0, failures.join("; ") || "topic_match with 1 phone + user + correct labels");
}

async function T2_multiple_matches_simultaneous() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [
      { userId: USER_A, callbackRingNumber: PHONE_A },
      { userId: USER_B, callbackRingNumber: PHONE_B },
      { userId: USER_C, callbackRingNumber: PHONE_C },
    ],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const twiml = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: "https://x/whisper?text=Hi",
    recordingStatusUrl: "https://x/rec",
    dialStatusUrl: "https://x/dial",
  });
  const failures: string[] = [];
  const nums = (twiml.match(/<Number/g) || []).length;
  if (nums !== 3) failures.push(`<Number> count=${nums}`);
  for (const p of [PHONE_A, PHONE_B, PHONE_C]) {
    if (!twiml.includes(p)) failures.push(`missing phone ${p}`);
  }
  record("T2 multiple matches simultaneous", failures.length === 0, failures.join("; ") || "3 <Number> entries, all phones present");
}

async function T3_no_topic_match_any_on_duty() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [],
    onDutyAny: [
      { userId: USER_B, callbackRingNumber: PHONE_B },
    ],
    businessOpen: true,
    legacyTransferToPhone: LEGACY_PHONE,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const failures: string[] = [];
  if (d.path !== "any_on_duty") failures.push(`path=${d.path}`);
  if (d.handoffReason !== "fallback_any_on_duty") failures.push(`reason=${d.handoffReason}`);
  if (d.staffPhones[0] !== PHONE_B) failures.push(`phone[0]=${d.staffPhones[0]}`);
  record("T3 no topic match → any_on_duty", failures.length === 0, failures.join("; ") || "any_on_duty w/ fallback_any_on_duty");
}

async function T4_no_on_duty_legacy_transfer() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: LEGACY_PHONE,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const failures: string[] = [];
  if (d.path !== "legacy_transfer") failures.push(`path=${d.path}`);
  if (d.legacyPhone !== LEGACY_PHONE) failures.push(`legacyPhone=${d.legacyPhone}`);
  if (d.handoffReason !== "no_staff_during_hours") failures.push(`reason=${d.handoffReason}`);
  if (d.transferStatus !== "legacy_transfer_to_phone") failures.push(`status=${d.transferStatus}`);
  record("T4 no on-duty + hours open → legacy_transfer", failures.length === 0, failures.join("; ") || "legacy_transfer w/ no_staff_during_hours");
}

async function T5_no_on_duty_after_hours() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [],
    onDutyAny: [],
    businessOpen: false,
    legacyTransferToPhone: LEGACY_PHONE,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const failures: string[] = [];
  if (d.path !== "after_hours_callback") failures.push(`path=${d.path}`);
  if (d.handoffReason !== "after_hours_callback") failures.push(`reason=${d.handoffReason}`);
  if (d.staffPhones.length !== 0) failures.push(`unexpected phones: ${d.staffPhones.length}`);
  record("T5 no on-duty + after hours → after_hours_callback", failures.length === 0, failures.join("; ") || "after_hours_callback w/ no phones");
}

async function T6_no_on_duty_no_legacy_open_hours() {
  const inputs: RoutingInputs = {
    onDutyForTopic: [],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  };
  const d = decideRouting(inputs);
  const failures: string[] = [];
  if (d.path !== "graceful_hangup") failures.push(`path=${d.path}`);
  if (d.handoffReason !== "graceful_hangup") failures.push(`reason=${d.handoffReason}`);
  record("T6 no on-duty + no legacy phone + hours open → graceful_hangup", failures.length === 0, failures.join("; ") || "graceful_hangup path");
}

async function T7_twiml_dial_attributes() {
  const d = decideRouting({
    onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const twiml = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
  });
  const failures: string[] = [];
  if (!/answerOnBridge="true"/.test(twiml)) failures.push("missing answerOnBridge");
  if (!/callerId="\+18005551234"/.test(twiml)) failures.push("missing callerId");
  if (!/timeout="30"/.test(twiml)) failures.push("missing/incorrect timeout (expected 30)");
  // Custom timeout override.
  const twiml2 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    timeoutSecs: 45,
  });
  if (!/timeout="45"/.test(twiml2)) failures.push("timeout override not applied");
  record("T7 TwiML core Dial attrs", failures.length === 0, failures.join("; ") || "answerOnBridge + callerId + timeout (30 default, override honored)");
}

async function T8_cross_tenant_isolation() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  // staff_topics query returns NO rows for our tenant — topic belongs to other biz.
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    // Since no topic staff, should fall to any_on_duty.
    if (result.result.decision.path !== "any_on_duty") failures.push(`path=${result.result.decision.path}`);
  }
  // Verify staff_topics query was tenant-scoped.
  const stCall = fake.calls.find((c) => c.op === "select" && c.table === "staff_topics");
  if (!stCall?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("staff_topics query missing business_id filter");
  }
  record("T8 cross-tenant isolation", failures.length === 0, failures.join("; ") || "tenant-scoped staff_topics + any_on_duty fallback");
}

async function T9_on_duty_topic_null_ring_number() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [
    { user_id: USER_A, topic_slug: TOPIC_ROADSIDE },
    { user_id: USER_B, topic_slug: TOPIC_ROADSIDE },
  ]);
  // A has NULL callback; B has a phone.
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: null },
    { user_id: USER_B, callback_ring_number: PHONE_B },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const d = result.result.decision;
    if (d.staffUserIds.includes(USER_A)) failures.push("USER_A (NULL callback) leaked into staff list");
    if (!d.staffUserIds.includes(USER_B)) failures.push("USER_B missing from staff list");
    if (d.staffPhones.length !== 1) failures.push(`phones=${d.staffPhones.length} (expected 1)`);
  }
  record("T9 NULL callback_ring_number skipped", failures.length === 0, failures.join("; ") || "user w/ NULL callback filtered out");
}

async function T10_unknown_topic_slug() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake); // departments has roadside + payments
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), {
    ...baseBody,
    topic_slug: "bogus_topic_never_configured",
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const d = result.result.decision;
    if (d.path !== "any_on_duty") failures.push(`path=${d.path}`);
    if (d.handoffReason !== "topic_no_longer_configured") failures.push(`reason=${d.handoffReason}`);
  }
  record("T10 unknown topic_slug → any_on_duty w/ race reason", failures.length === 0, failures.join("; ") || "handoff_reason=topic_no_longer_configured");
}

async function T11_rung_user_ids_logged() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [
    { user_id: USER_A, topic_slug: TOPIC_ROADSIDE },
    { user_id: USER_B, topic_slug: TOPIC_ROADSIDE },
  ]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
    { user_id: USER_B, callback_ring_number: PHONE_B },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (!update) failures.push("no calls UPDATE issued");
  const rung = update?.payload?.rung_user_ids as string[] | undefined;
  if (!Array.isArray(rung)) failures.push(`rung_user_ids not array: ${typeof rung}`);
  else {
    if (rung.length !== 2) failures.push(`rung length=${rung.length}`);
    if (!rung.includes(USER_A) || !rung.includes(USER_B)) failures.push(`rung missing users: ${rung.join(",")}`);
  }
  record("T11 rung_user_ids logged with dialed users", failures.length === 0, failures.join("; ") || "calls.rung_user_ids = [USER_A, USER_B]");
}

async function T12_topic_slug_and_reason_written() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.topic_slug !== TOPIC_ROADSIDE) failures.push(`topic_slug=${update?.payload?.topic_slug}`);
  if (update?.payload?.handoff_reason !== "topic_match_answered") failures.push(`handoff_reason=${update?.payload?.handoff_reason}`);
  if (update?.payload?.transfer_reason !== baseBody.reason) failures.push(`transfer_reason=${update?.payload?.transfer_reason}`);
  // Tenant-scoped UPDATE.
  if (!update?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) failures.push("UPDATE missing business_id filter");
  if (!update?.eqFilters.some((f) => f.column === "conversation_id" && f.value === CONV)) failures.push("UPDATE missing conversation_id filter");
  record("T12 topic_slug + handoff_reason + transfer_reason written", failures.length === 0, failures.join("; ") || "all 3 fields set + tenant scoped");
}

async function T13_transfer_status_routing_topic_match() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if ((result as any).result?.status !== "routing_topic_match") failures.push(`status=${(result as any).result?.status}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.transfer_status !== "routing_topic_match") failures.push(`transfer_status=${update?.payload?.transfer_status}`);
  record("T13 transfer_status = routing_topic_match", failures.length === 0, failures.join("; ") || "response + DB match");
}

async function T14_handoff_reason_per_path() {
  const failures: string[] = [];
  const expectations: Array<{ inputs: RoutingInputs; expect: string }> = [
    {
      inputs: {
        onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
        onDutyAny: [],
        businessOpen: true,
        legacyTransferToPhone: null,
        topicConfigured: true,
      },
      expect: "topic_match_answered",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [{ userId: USER_B, callbackRingNumber: PHONE_B }],
        businessOpen: true,
        legacyTransferToPhone: null,
        topicConfigured: true,
      },
      expect: "fallback_any_on_duty",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [],
        businessOpen: true,
        legacyTransferToPhone: LEGACY_PHONE,
        topicConfigured: true,
      },
      expect: "no_staff_during_hours",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [],
        businessOpen: false,
        legacyTransferToPhone: null,
        topicConfigured: true,
      },
      expect: "after_hours_callback",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
        businessOpen: true,
        legacyTransferToPhone: null,
        topicConfigured: false,
      },
      expect: "topic_no_longer_configured",
    },
  ];
  for (const [i, { inputs, expect }] of expectations.entries()) {
    const d = decideRouting(inputs);
    if (d.handoffReason !== expect) {
      failures.push(`case[${i}] handoffReason=${d.handoffReason} want=${expect}`);
    }
  }
  record("T14 handoff_reason accurate per path", failures.length === 0, failures.join("; ") || "5 paths each produce correct handoff_reason");
}

async function T15_topic_slug_written_on_no_match() {
  const fake = new FakeSupabaseClient();
  // Departments has payments only; caller asks for roadside.
  stubDefaultBusiness(fake, {
    departments: [{ slug: TOPIC_PAYMENTS, name: "Payments & billing" }],
  });
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody); // asks for roadside
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.topic_slug !== TOPIC_ROADSIDE) failures.push(`topic_slug=${update?.payload?.topic_slug} (should be logged even on no-match)`);
  record("T15 topic_slug written even when no match", failures.length === 0, failures.join("; ") || "requested topic logged for reporting");
}

async function T16_body_validation() {
  const failures: string[] = [];
  const cases: Array<{ body: any; wantMatch: RegExp; label: string }> = [
    { body: null, wantMatch: /required/, label: "null body" },
    { body: {}, wantMatch: /business_id/, label: "missing business_id" },
    { body: { business_id: BIZ }, wantMatch: /conversation_id/, label: "missing conversation_id" },
    { body: { business_id: BIZ, conversation_id: CONV }, wantMatch: /topic_slug/, label: "missing topic_slug" },
    { body: { business_id: BIZ, conversation_id: CONV, topic_slug: TOPIC_ROADSIDE }, wantMatch: /reason/, label: "missing reason" },
    { body: { business_id: 123, conversation_id: CONV, topic_slug: TOPIC_ROADSIDE, reason: "r" }, wantMatch: /business_id/, label: "non-string business_id" },
  ];
  for (const c of cases) {
    const r = parseRouteBody(c.body);
    if (!("error" in r) || !c.wantMatch.test(r.error)) {
      failures.push(`[${c.label}] got ${JSON.stringify(r)}`);
    }
  }
  // Positive case.
  const ok = parseRouteBody(baseBody);
  if ("error" in ok) failures.push(`valid body rejected: ${ok.error}`);
  record("T16 parseRouteBody validation", failures.length === 0, failures.join("; ") || "6 negatives caught + 1 positive accepted");
}

async function T17_twiml_timeout_default() {
  const d = decideRouting({
    onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const twiml = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
  });
  const m = twiml.match(/timeout="(\d+)"/);
  const timeout = m ? parseInt(m[1], 10) : 0;
  const failures: string[] = [];
  if (timeout !== 30) failures.push(`timeout=${timeout} (expected 30 default; tool timeout of 45s leaves 15s HTTP margin)`);
  record("T17 TwiML default timeout 30s", failures.length === 0, failures.join("; ") || "timeout=30 default per Phase A");
}

async function T18_recording_attrs_present() {
  const d = decideRouting({
    onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const twiml = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: "https://x/api/twilio/recording-status",
    dialStatusUrl: null,
  });
  const failures: string[] = [];
  if (!/record="record-from-ringing-dual"/.test(twiml)) failures.push("missing record attr");
  if (!/recordingStatusCallback="[^"]+recording-status"/.test(twiml)) failures.push("missing recordingStatusCallback");
  if (!/recordingStatusCallbackEvent="completed"/.test(twiml)) failures.push("missing recordingStatusCallbackEvent");
  // Absent when recordingStatusUrl is null.
  const twimlNoRec = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
  });
  if (/record=|recordingStatusCallback=/.test(twimlNoRec)) failures.push("recording attrs leaked when URL null");
  record("T18 recording attrs conditional on URL", failures.length === 0, failures.join("; ") || "record + rSC + rSCE present with URL, absent without");
}

async function T19_after_hours_null_twiml() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake, { hoursOpen: false, legacyTransferToPhone: null });
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, []);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const r = result.result;
    if (r.twiml !== null) failures.push(`twiml should be null on after_hours path, got: ${r.twiml?.slice(0, 80)}`);
    if (r.status !== "after_hours_callback") failures.push(`status=${r.status}`);
    if (!/callback|message|reopen/i.test(r.message_for_llm)) failures.push(`message_for_llm doesn't mention callback/message/reopen: "${r.message_for_llm}"`);
    if (r.staff_count !== 0) failures.push(`staff_count=${r.staff_count}`);
  }
  record("T19 after_hours: twiml=null + callback prompt", failures.length === 0, failures.join("; ") || "twiml null, status after_hours_callback, LLM asks for callback");
}

async function T20_handler_is_pure() {
  // Two independent invocations with different bodies must not
  // interfere. Uses the SAME FakeSupabaseClient (so response stubs
  // are shared) but stubs are keyed on request shape.
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const [r1, r2] = await Promise.all([
    handleRouteToTopic(asClient(fake), baseBody),
    handleRouteToTopic(asClient(fake), { ...baseBody, conversation_id: "conv_test_040_second" }),
  ]);
  const failures: string[] = [];
  if (!r1.ok || !r2.ok) failures.push("one call failed");
  else {
    // Both should reach the same decision.
    if (r1.result.decision.path !== r2.result.decision.path) failures.push("paths diverged");
    if (r1.result.status !== r2.result.status) failures.push("statuses diverged");
  }
  record("T20 handler is pure across concurrent calls", failures.length === 0, failures.join("; ") || "two concurrent invocations produced identical decisions");
}

async function T21_topic_cleared_race() {
  const fake = new FakeSupabaseClient();
  // Departments has payments only; caller asked for roadside (which
  // was in departments moments before but got cleared).
  stubDefaultBusiness(fake, {
    departments: [{ slug: TOPIC_PAYMENTS, name: "Payments & billing" }],
  });
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const d = result.result.decision;
    if (d.path !== "any_on_duty") failures.push(`path=${d.path}`);
    if (d.handoffReason !== "topic_no_longer_configured") failures.push(`reason=${d.handoffReason}`);
    if (result.result.status !== "routing_any_on_duty") failures.push(`status=${result.result.status}`);
  }
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handoff_reason !== "topic_no_longer_configured") failures.push(`persisted reason=${update?.payload?.handoff_reason}`);
  record("T21 topic cleared mid-call → any_on_duty w/ race reason", failures.length === 0, failures.join("; ") || "topic_no_longer_configured persists + any_on_duty path");
}

// ── Bonus: whisper composition and TwiML ────────────────────────────

async function whisper_composition() {
  const failures: string[] = [];
  const t1 = composeWhisperText({ businessName: "EZ Rentals", topicName: "Roadside & breakdown" });
  if (t1 !== "Incoming call for EZ Rentals about Roadside & breakdown. Connecting now.") {
    failures.push(`default template rendered: "${t1}"`);
  }
  const t2 = composeWhisperText({
    businessName: "EZ",
    topicName: "Roadside",
    overrideTemplate: "Heads up {business_name} — {topic_name}",
  });
  if (t2 !== "Heads up EZ — Roadside") failures.push(`override rendered: "${t2}"`);
  const t3 = buildWhisperTwiml("Hi & <bye>");
  if (!/Hi &amp; &lt;bye&gt;/.test(t3)) failures.push(`XML escaping broken: ${t3}`);
  record("Whisper composition + escaping", failures.length === 0, failures.join("; ") || "template + override + XML escape all clean");
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  await T1_single_match_topic();
  await T2_multiple_matches_simultaneous();
  await T3_no_topic_match_any_on_duty();
  await T4_no_on_duty_legacy_transfer();
  await T5_no_on_duty_after_hours();
  await T6_no_on_duty_no_legacy_open_hours();
  await T7_twiml_dial_attributes();
  await T8_cross_tenant_isolation();
  await T9_on_duty_topic_null_ring_number();
  await T10_unknown_topic_slug();
  await T11_rung_user_ids_logged();
  await T12_topic_slug_and_reason_written();
  await T13_transfer_status_routing_topic_match();
  await T14_handoff_reason_per_path();
  await T15_topic_slug_written_on_no_match();
  await T16_body_validation();
  await T17_twiml_timeout_default();
  await T18_recording_attrs_present();
  await T19_after_hours_null_twiml();
  await T20_handler_is_pure();
  await T21_topic_cleared_race();
  await whisper_composition();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
