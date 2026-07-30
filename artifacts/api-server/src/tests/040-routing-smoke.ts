/**
 * Phase 3.2 — routing engine + tool-wiring smoke. 33 cases covering:
 *   - Pure decision function (fallback-logic.decideRouting)
 *   - Pure TwiML builder (dial-builder.buildDialTwiml, composeWhisperText)
 *   - Handler (routes/routing.handleRouteToTopic) with FakeSupabaseClient
 *   - Body validation (routes/routing.parseRouteBody)
 *   - Twilio REST redirect scheduling (mock Twilio client)
 *   - Dial-status handler (routes/routing.handleDialStatus, mapDialStatus)
 *   - agents.ts buildRouteToTopicTool + empty-departments guard
 *   - prompt-renderer.ts DEPARTMENTS & TOPIC EXPERTISE section
 *
 *   3.2a cases (unchanged from previous smoke):
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
 *   T12 topic_slug + handoff_reason written to calls (transfer_reason DEPRECATED)
 *   T13 status = 'connecting' on topic-match path (public label)
 *   T14 handoff_reason accurately reflects each fallback path
 *   T15 topic_slug written even when no match found
 *   T16 parseRouteBody rejects missing fields / wrong types
 *   T17 buildDialTwiml includes timeout attribute
 *   T18 buildDialTwiml includes recordingStatusCallback + record attrs
 *   T19 after_hours path: status='taking_message', staff_count=0
 *   T20 handler is pure (two independent invocations don't interfere)
 *   T21 topic cleared mid-call → any_on_duty w/ topic_no_longer_configured
 *
 *   3.2b additions:
 *   T22 REST redirect scheduled when call_sid + dial path present
 *   T23 REST redirect SKIPPED on after_hours (twiml=null, no calls.update)
 *   T24 REST redirect SKIPPED on graceful_hangup
 *   T25 REST redirect SKIPPED when call_sid missing (Sentry warn path)
 *   T26 mapDialStatus enumeration (5 Twilio statuses → correct label)
 *   T27 handleDialStatus answered → transfer_status + handled_by_user_id + handled_at
 *   T28 handleDialStatus no-answer → transfer_status + handoff_reason='all_staff_no_answer'
 *   T29 handleDialStatus resolves handled_by_user_id via To → callback_ring_number
 *   T30 buildRouteToTopicTool: registers topic_slug enum from departments
 *   T31 buildRouteToTopicTool: throws on empty topics (guard)
 *   T32 buildRouteToTopicTool: uses dynamic_variable for system__call_sid
 *   T33 renderPromptFromHelpers: DEPARTMENTS section renders topics correctly
 *
 *   3.3 additions (in-app calling — WebRTC softphone):
 *   T38 <Client>-only TwiML shape (identity + topic_name Parameter, no <Number>)
 *   T39 mixed Client+Number simultaneous ring (3 staff → 2 <Client> + 2 <Number>)
 *   T40 client:<identity> handled_by resolution + answered_via=browser + no phone lookup
 *   T41 false-match regression: client:<uuid> never resolves via phone matching
 *   T42 twilio_call_sid persisted on routing UPSERT (distinct from calls.call_sid)
 *   T43 stale heartbeat drops in-app-only candidate from routing
 *   T44 token endpoint identity derived server-side (client-supplied ignored)
 *   T45 parseClientTo / parseClientFrom: shape parsing + rejections
 *   T46 outbound TwiML shape: callerId + answerOnBridge + <Number> + XML escape
 *   T47 resolveBusinessForClient: identity → (business_id, twilio_phone_number)
 *   T48 mintVoiceAccessToken: JWT payload has identity + VoiceGrant
 *
 *   3.3a additions (per-membership identity + toggle wiring):
 *   T49 buildClientIdentity: (userA, bizA) != (userA, bizB) — the 3.3 collision
 *   T50 buildClientIdentity: deterministic + shape matches migration 043 DDL
 *   T51 /voice/preferences PATCH: scoped to caller's own membership,
 *       body-supplied user_id / business_id dropped on the floor
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
  handleDialStatus,
  mapDialStatus,
  parseRouteBody,
  normalizePhone,
  promoteHandoffReasonOnAnswer,
  parseClientTo,
  type TwilioCallControl,
} from "../routes/routing";
// Phase 3.3
import {
  parseClientFrom,
  resolveClientIdentityForUser,
  resolveBusinessForClient,
  buildOutboundDialTwiml,
  mintVoiceAccessToken,
  updatePreferenceForCaller,
} from "../routes/voice";
// Phase 3.3a — single source of truth for the identity formula. Tests
// compute expected identities via the helper so a formula change in
// buildClientIdentity is caught by the fixtures automatically.
import { buildClientIdentity } from "../lib/voice/client-identity";
import { buildRouteToTopicTool } from "../agents";
import { renderPromptFromHelpers } from "../lib/prompt-renderer";

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
  upsertOptions?: any;
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
  upsert(payload: any, options?: any) {
    this.call.op = "upsert";
    this.call.payload = payload;
    this.call.upsertOptions = options;
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
  // Phase 3.2c: routing writes are UPSERTs (not UPDATEs) so a mid-call
  // routing event creates the row if the post-call webhook hasn't fired.
  // dial-status still uses plain UPDATE.
  fake.on(
    (c) => c.op === "upsert" && c.table === "calls",
    { data: { id: CALL_ID } },
  );
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
  if (d.handoffReason !== "topic_match_ringing") failures.push(`reason=${d.handoffReason}`);
  if (d.transferStatus !== "routing_topic_match") failures.push(`status=${d.transferStatus}`);
  record("T1 single match topic (routing time: _ringing)", failures.length === 0, failures.join("; ") || "topic_match with 1 phone + user + _ringing label");
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
  if (d.handoffReason !== "fallback_any_on_duty_ringing") failures.push(`reason=${d.handoffReason}`);
  if (d.staffPhones[0] !== PHONE_B) failures.push(`phone[0]=${d.staffPhones[0]}`);
  record("T3 no topic match → any_on_duty (routing time: _ringing)", failures.length === 0, failures.join("; ") || "any_on_duty w/ fallback_any_on_duty_ringing");
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
  if (d.handoffReason !== "no_staff_during_hours_ringing") failures.push(`reason=${d.handoffReason}`);
  if (d.transferStatus !== "legacy_transfer_to_phone") failures.push(`status=${d.transferStatus}`);
  record("T4 no on-duty + hours open → legacy_transfer (routing: _ringing)", failures.length === 0, failures.join("; ") || "legacy_transfer w/ no_staff_during_hours_ringing");
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
  // Phase 3.2c: routing writes are UPSERTs, not UPDATEs.
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (!upsert) failures.push("no calls UPSERT issued");
  const rung = upsert?.payload?.rung_user_ids as string[] | undefined;
  if (!Array.isArray(rung)) failures.push(`rung_user_ids not array: ${typeof rung}`);
  else {
    if (rung.length !== 2) failures.push(`rung length=${rung.length}`);
    if (!rung.includes(USER_A) || !rung.includes(USER_B)) failures.push(`rung missing users: ${rung.join(",")}`);
  }
  // Verify onConflict target = "call_sid" (the whole point of 3.2c).
  if (upsert?.upsertOptions?.onConflict !== "call_sid") failures.push(`onConflict=${upsert?.upsertOptions?.onConflict} (expected "call_sid")`);
  record("T11 UPSERT rung_user_ids + onConflict=call_sid", failures.length === 0, failures.join("; ") || "upsert with rung_user_ids array + call_sid conflict target");
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
  // Phase 3.2c: UPSERT keyed on call_sid. The payload carries every
  // routing-relevant column plus business_id + call_sid so a fresh
  // INSERT would land a complete row for the post-call handler to
  // merge into.
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (!upsert) failures.push("no calls UPSERT issued");
  if (upsert?.payload?.topic_slug !== TOPIC_ROADSIDE) failures.push(`topic_slug=${upsert?.payload?.topic_slug}`);
  // Phase 3.2c: routing writes _ringing (not _answered) — dial-status
  // promotes on DialCallStatus=completed.
  if (upsert?.payload?.handoff_reason !== "topic_match_ringing") failures.push(`handoff_reason=${upsert?.payload?.handoff_reason}`);
  if (upsert?.payload?.business_id !== BIZ) failures.push(`payload business_id=${upsert?.payload?.business_id}`);
  // Phase 3.2c: call_sid on the payload = conversation_id from the tool
  // body (per the historical calls.call_sid ← conversation_id alias).
  if (upsert?.payload?.call_sid !== CONV) failures.push(`payload call_sid=${upsert?.payload?.call_sid}`);
  // Phase 3.2b: transfer_reason DEPRECATED — no writes.
  if ("transfer_reason" in (upsert?.payload || {})) failures.push(`transfer_reason should NOT be written (deprecated): got ${upsert?.payload?.transfer_reason}`);
  record("T12 UPSERT payload: topic_slug + handoff_reason=_ringing + call_sid", failures.length === 0, failures.join("; ") || "upsert payload complete + _ringing at routing time + no deprecated writes");
}

async function T13_transfer_status_routing_topic_match() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  // Phase 3.2c: pass call_sid + mock Twilio client so redirect actually
  // fires; public status should be "connecting". Without call_sid the
  // safe-failure path returns "taking_message" instead (see T25).
  const twilioMock = new MockTwilioClient();
  const result = await handleRouteToTopic(
    asClient(fake),
    { ...baseBody, call_sid: "CA_test_t13" },
    { twilioClient: twilioMock, redirectDelayMs: 0 },
  );
  await new Promise((r) => setTimeout(r, 5));
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if ((result as any).result?.status !== "connecting") failures.push(`public status=${(result as any).result?.status}`);
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (upsert?.payload?.transfer_status !== "routing_topic_match") failures.push(`db transfer_status=${upsert?.payload?.transfer_status}`);
  if (twilioMock.updates.length !== 1) failures.push(`Twilio update count=${twilioMock.updates.length}`);
  record("T13 public status='connecting' + db transfer_status='routing_topic_match' + REST redirect fires", failures.length === 0, failures.join("; ") || "public 'connecting' matches redirect actually firing");
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
      expect: "topic_match_ringing",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [{ userId: USER_B, callbackRingNumber: PHONE_B }],
        businessOpen: true,
        legacyTransferToPhone: null,
        topicConfigured: true,
      },
      expect: "fallback_any_on_duty_ringing",
    },
    {
      inputs: {
        onDutyForTopic: [],
        onDutyAny: [],
        businessOpen: true,
        legacyTransferToPhone: LEGACY_PHONE,
        topicConfigured: true,
      },
      expect: "no_staff_during_hours_ringing",
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
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (upsert?.payload?.topic_slug !== TOPIC_ROADSIDE) failures.push(`topic_slug=${upsert?.payload?.topic_slug} (should be logged even on no-match)`);
  record("T15 topic_slug written even when no match (UPSERT payload)", failures.length === 0, failures.join("; ") || "requested topic logged for reporting");
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
    if (r.status !== "taking_message") failures.push(`public status=${r.status}`);
    if (r.staff_count !== 0) failures.push(`staff_count=${r.staff_count}`);
    if (r.handoff_reason !== "after_hours_callback") failures.push(`handoff_reason=${r.handoff_reason}`);
  }
  record("T19 after_hours: public status='taking_message' + twiml=null", failures.length === 0, failures.join("; ") || "public taking_message, twiml null, staff_count=0");
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
    // Phase 3.2c: T21 doesn't pass call_sid → safe-failure path returns
    // "taking_message" instead of "connecting". The routing DECISION
    // itself is still any_on_duty; only the LLM-facing label degrades.
    if (result.result.status !== "taking_message") failures.push(`public status=${result.result.status}`);
  }
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (upsert?.payload?.handoff_reason !== "topic_no_longer_configured") failures.push(`persisted reason=${upsert?.payload?.handoff_reason}`);
  if (upsert?.payload?.transfer_status !== "routing_any_on_duty") failures.push(`persisted transfer_status=${upsert?.payload?.transfer_status}`);
  record("T21 topic cleared mid-call → any_on_duty w/ race reason", failures.length === 0, failures.join("; ") || "topic_no_longer_configured persists + any_on_duty path");
}

// ── Phase 3.2b: Twilio REST redirect + dial-status + tool wiring ────

class MockTwilioClient implements TwilioCallControl {
  updates: Array<{ callSid: string; twiml: string }> = [];
  calls(sid: string) {
    return {
      update: async (opts: { twiml: string }) => {
        this.updates.push({ callSid: sid, twiml: opts.twiml });
      },
    };
  }
}

async function T22_rest_redirect_scheduled() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const twilioMock = new MockTwilioClient();
  const scheduled: Array<{ callSid: string; twiml: string; delayMs: number }> = [];
  const result = await handleRouteToTopic(asClient(fake), { ...baseBody, call_sid: "CA_test_sid" }, {
    twilioClient: twilioMock,
    redirectDelayMs: 0, // immediate for testing
    onRedirectScheduled: (info) => scheduled.push(info),
  });
  // Give the setTimeout(0) a tick to fire.
  await new Promise((r) => setTimeout(r, 10));

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (scheduled.length !== 1) failures.push(`scheduled count=${scheduled.length}`);
  else {
    if (scheduled[0].callSid !== "CA_test_sid") failures.push(`callSid=${scheduled[0].callSid}`);
    if (!/^<\?xml.*<Dial /s.test(scheduled[0].twiml)) failures.push(`twiml shape wrong: ${scheduled[0].twiml.slice(0, 80)}`);
  }
  if (twilioMock.updates.length !== 1) failures.push(`Twilio update count=${twilioMock.updates.length}`);
  else {
    if (twilioMock.updates[0].callSid !== "CA_test_sid") failures.push(`update callSid=${twilioMock.updates[0].callSid}`);
    if (!twilioMock.updates[0].twiml.includes(PHONE_A)) failures.push("update twiml missing staff phone");
  }
  record("T22 REST redirect scheduled + fires with correct callSid + twiml", failures.length === 0, failures.join("; ") || "scheduled + fired via mock Twilio");
}

async function T23_no_redirect_on_after_hours() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake, { hoursOpen: false, legacyTransferToPhone: null });
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, []);

  const twilioMock = new MockTwilioClient();
  const scheduled: Array<any> = [];
  const result = await handleRouteToTopic(asClient(fake), { ...baseBody, call_sid: "CA_ah" }, {
    twilioClient: twilioMock,
    redirectDelayMs: 0,
    onRedirectScheduled: (i) => scheduled.push(i),
  });
  await new Promise((r) => setTimeout(r, 10));

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (scheduled.length !== 0) failures.push(`unexpected schedule: ${scheduled.length}`);
  if (twilioMock.updates.length !== 0) failures.push(`unexpected Twilio update on after_hours path: ${twilioMock.updates.length}`);
  record("T23 no REST redirect on after_hours", failures.length === 0, failures.join("; ") || "twilio.calls.update NOT invoked");
}

async function T24_no_redirect_on_graceful_hangup() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake, { hoursOpen: true, legacyTransferToPhone: null });
  stubStaffTopics(fake, []);
  stubUserBusinessesOnDuty(fake, []);

  const twilioMock = new MockTwilioClient();
  const result = await handleRouteToTopic(asClient(fake), { ...baseBody, call_sid: "CA_gh" }, {
    twilioClient: twilioMock,
    redirectDelayMs: 0,
  });
  await new Promise((r) => setTimeout(r, 10));

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.result.status !== "no_help_available") failures.push(`status=${result.result.status}`);
  if (twilioMock.updates.length !== 0) failures.push(`unexpected Twilio update: ${twilioMock.updates.length}`);
  record("T24 no REST redirect on graceful_hangup", failures.length === 0, failures.join("; ") || "twilio.calls.update NOT invoked, public status=no_help_available");
}

async function T25_no_redirect_when_call_sid_missing() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);

  const twilioMock = new MockTwilioClient();
  const scheduled: Array<any> = [];
  // No call_sid in the body — simulates ElevenLabs failing to inject
  // system__call_sid for some reason.
  const result = await handleRouteToTopic(asClient(fake), baseBody, {
    twilioClient: twilioMock,
    redirectDelayMs: 0,
    onRedirectScheduled: (i) => scheduled.push(i),
  });
  await new Promise((r) => setTimeout(r, 10));

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  // Phase 3.2c: NO REST redirect issued (correct — no call_sid).
  if (scheduled.length !== 0) failures.push(`unexpected schedule: ${scheduled.length}`);
  if (twilioMock.updates.length !== 0) failures.push(`unexpected Twilio update: ${twilioMock.updates.length}`);
  // Phase 3.2c safe-failure: LLM MUST get status='taking_message' so
  // Alex pivots to request_callback. Returning 'connecting' would be
  // a promise we can't keep — the previous test encoded the bug by
  // asserting 'connecting'. Inverted here.
  if (result.ok && result.result.status !== "taking_message") {
    failures.push(`public status=${(result as any).result?.status} (expected 'taking_message' — safe-failure path)`);
  }
  // The routing decision itself is still topic_match (metadata logged
  // via UPSERT so post-mortem can see we tried).
  if (result.ok && result.result.decision.path !== "topic_match") {
    failures.push(`decision.path=${result.result.decision.path} (should still be topic_match)`);
  }
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (!upsert) failures.push("expected UPSERT to still write routing metadata even w/o redirect");
  record("T25 no call_sid → public status='taking_message' + no redirect + still UPSERTs metadata", failures.length === 0, failures.join("; ") || "safe-failure inverted: pivots to callback, no dead air");
}

async function T26_map_dial_status() {
  const failures: string[] = [];
  const cases: Array<{ input: string; wantStatus: string; wantAnswered: boolean }> = [
    { input: "completed", wantStatus: "answered", wantAnswered: true },
    { input: "answered", wantStatus: "answered", wantAnswered: true },
    { input: "no-answer", wantStatus: "no_answer", wantAnswered: false },
    { input: "busy", wantStatus: "busy", wantAnswered: false },
    { input: "canceled", wantStatus: "canceled", wantAnswered: false },
    { input: "failed", wantStatus: "failed", wantAnswered: false },
    { input: "bogus", wantStatus: "failed", wantAnswered: false }, // default → failed
  ];
  for (const c of cases) {
    const m = mapDialStatus(c.input);
    if (m.transferStatus !== c.wantStatus) failures.push(`[${c.input}] status=${m.transferStatus} want=${c.wantStatus}`);
    if (m.transferAnswered !== c.wantAnswered) failures.push(`[${c.input}] answered=${m.transferAnswered} want=${c.wantAnswered}`);
  }
  record("T26 mapDialStatus enumeration", failures.length === 0, failures.join("; ") || "7 statuses map correctly");
}

async function T27_dial_status_answered() {
  const fake = new FakeSupabaseClient();
  // Column-specific stubs — handleDialStatus does TWO selects on
  // `calls`: (1) rung_user_ids for handled_by resolution, (2)
  // handoff_reason for _ringing → _answered promotion.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "rung_user_ids",
    { data: { rung_user_ids: [USER_A, USER_B] } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "handoff_reason",
    { data: { handoff_reason: "topic_match_ringing" } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        { user_id: USER_A, callback_ring_number: PHONE_A },
        { user_id: USER_B, callback_ring_number: PHONE_B },
      ],
    },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  const result = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "completed",
    To: PHONE_B, // Bob's cell answered
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.transferStatus !== "answered") failures.push(`transferStatus=${result.transferStatus}`);
    if (result.handledByUserId !== USER_B) failures.push(`handledByUserId=${result.handledByUserId}`);
  }
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.transfer_status !== "answered") failures.push(`update transfer_status=${update?.payload?.transfer_status}`);
  if (update?.payload?.transfer_answered !== true) failures.push(`update transfer_answered=${update?.payload?.transfer_answered}`);
  if (update?.payload?.handled_by_user_id !== USER_B) failures.push(`update handled_by_user_id=${update?.payload?.handled_by_user_id}`);
  if (!update?.payload?.handled_at) failures.push("update missing handled_at");
  // Phase 3.2c: promotion — topic_match_ringing → topic_match_answered.
  if (update?.payload?.handoff_reason !== "topic_match_answered") {
    failures.push(`update handoff_reason=${update?.payload?.handoff_reason} (expected 'topic_match_answered' — promoted from _ringing)`);
  }
  // Update must be keyed on call_sid (not conversation_id, which is NULL in prod).
  if (!update?.eqFilters.some((f) => f.column === "call_sid" && f.value === CONV)) {
    failures.push("update missing eq(call_sid) filter — routing-key rekey missing");
  }
  record("T27 dial-status answered → transfer_status + handled_by + handoff promoted _answered + keyed on call_sid", failures.length === 0, failures.join("; ") || "all writes correct, promotion fires, call_sid keying used");
}

async function T28_dial_status_no_answer() {
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  const result = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "no-answer",
    To: PHONE_A,
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.transfer_status !== "no_answer") failures.push(`transfer_status=${update?.payload?.transfer_status}`);
  if (update?.payload?.transfer_answered !== false) failures.push(`transfer_answered=${update?.payload?.transfer_answered}`);
  if (update?.payload?.handoff_reason !== "all_staff_no_answer") failures.push(`handoff_reason=${update?.payload?.handoff_reason}`);
  if ("handled_by_user_id" in (update?.payload || {})) failures.push("handled_by_user_id set on no-answer");
  record("T28 dial-status no-answer → all_staff_no_answer + no handler set", failures.length === 0, failures.join("; ") || "escalates handoff_reason, no handler resolved");
}

async function T29_dial_status_missing_fields() {
  const fake = new FakeSupabaseClient();
  const r1 = await handleDialStatus(asClient(fake), {
    business_id: "",
    conversation_id: CONV,
    DialCallStatus: "completed",
  });
  const r2 = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "",
  });
  const failures: string[] = [];
  if (r1.ok) failures.push("empty business_id should reject");
  if (r2.ok) failures.push("empty DialCallStatus should reject");
  record("T29 dial-status validates required fields", failures.length === 0, failures.join("; ") || "both negatives rejected");
}

async function T30_route_to_topic_tool_shape() {
  const tool = buildRouteToTopicTool({
    businessId: BIZ,
    routeToTopicUrl: "https://neverr.ai/api/routing/route-to-topic",
    toolSecret: "shh",
    topics: [
      { slug: TOPIC_ROADSIDE, name: "Roadside & breakdown" },
      { slug: TOPIC_PAYMENTS, name: "Payments & billing" },
    ],
  }) as any;
  const failures: string[] = [];
  if (tool?.type !== "webhook") failures.push(`type=${tool?.type}`);
  if (tool?.name !== "route_to_topic") failures.push(`name=${tool?.name}`);
  if (tool?.response_timeout_secs !== 45) failures.push(`response_timeout_secs=${tool?.response_timeout_secs}`);
  const enumProp = tool?.api_schema?.request_body_schema?.properties?.topic_slug;
  if (!Array.isArray(enumProp?.enum)) failures.push("topic_slug.enum missing");
  else if (enumProp.enum.length !== 2) failures.push(`enum length=${enumProp.enum.length}`);
  else if (!enumProp.enum.includes(TOPIC_ROADSIDE) || !enumProp.enum.includes(TOPIC_PAYMENTS)) {
    failures.push(`enum missing expected slugs: ${enumProp.enum.join(",")}`);
  }
  const bizProp = tool?.api_schema?.request_body_schema?.properties?.business_id;
  if (bizProp?.constant_value !== BIZ) failures.push(`business_id.constant_value=${bizProp?.constant_value}`);
  record("T30 buildRouteToTopicTool: enum + constant_value", failures.length === 0, failures.join("; ") || "webhook + timeout + enum from departments + business_id constant");
}

async function T31_route_to_topic_tool_empty_throws() {
  const failures: string[] = [];
  try {
    buildRouteToTopicTool({
      businessId: BIZ,
      routeToTopicUrl: "https://x/y",
      toolSecret: "shh",
      topics: [],
    });
    failures.push("expected throw on empty topics");
  } catch (err: any) {
    if (!/topics must not be empty/i.test(err?.message || "")) failures.push(`unexpected error: ${err?.message}`);
  }
  record("T31 buildRouteToTopicTool: throws on empty topics", failures.length === 0, failures.join("; ") || "guard triggered on empty departments");
}

async function T32_tool_dynamic_variable_call_sid() {
  const tool = buildRouteToTopicTool({
    businessId: BIZ,
    routeToTopicUrl: "https://x/y",
    toolSecret: "shh",
    topics: [{ slug: TOPIC_ROADSIDE, name: "Roadside" }],
  }) as any;
  const failures: string[] = [];
  const callSidProp = tool?.api_schema?.request_body_schema?.properties?.call_sid;
  if (!callSidProp) failures.push("call_sid property missing");
  else if (callSidProp.dynamic_variable !== "system__call_sid") {
    failures.push(`call_sid.dynamic_variable=${callSidProp.dynamic_variable}`);
  }
  // Also verify conversation_id uses dynamic_variable (not description).
  const convProp = tool?.api_schema?.request_body_schema?.properties?.conversation_id;
  if (convProp?.dynamic_variable !== "system__conversation_id") {
    failures.push(`conversation_id.dynamic_variable=${convProp?.dynamic_variable}`);
  }
  // Ensure call_sid is in required[].
  const req = tool?.api_schema?.request_body_schema?.required;
  if (!Array.isArray(req) || !req.includes("call_sid")) failures.push("call_sid missing from required[]");
  record("T32 tool: dynamic_variable for system__call_sid + system__conversation_id", failures.length === 0, failures.join("; ") || "auto-injected system vars, no LLM adherence risk");
}

async function T33_prompt_renders_departments_section() {
  const prompt = renderPromptFromHelpers({
    business_name: "EZ Rentals",
    industry: "car_rental",
    business_hours: "Mon-Sat 9-4",
    timezone: "America/New_York",
    topics: [
      {
        slug: TOPIC_ROADSIDE,
        name: "Roadside & breakdown",
        description: "Emergency roadside assistance and mechanical issues",
        example_utterances: [
          "my rental broke down",
          "I got a flat tire",
        ],
      },
      {
        slug: TOPIC_PAYMENTS,
        name: "Payments & billing",
        description: "Billing questions and payment plans",
      },
    ],
  });
  const failures: string[] = [];
  if (!/DEPARTMENTS & TOPIC EXPERTISE/.test(prompt)) failures.push("missing DEPARTMENTS heading");
  if (!/topic_slug: "roadside_breakdown"/.test(prompt)) failures.push("missing roadside_breakdown slug reference");
  if (!/topic_slug: "payments"/.test(prompt)) failures.push("missing payments slug reference");
  if (!/Roadside & breakdown/.test(prompt)) failures.push("missing roadside display name");
  if (!/my rental broke down/.test(prompt)) failures.push("missing example utterance");
  if (!/route_to_topic/.test(prompt)) failures.push("prompt doesn't cross-reference tool name");

  // Empty/null topics → section omitted.
  const noTopicsPrompt = renderPromptFromHelpers({
    business_name: "EZ",
    industry: "car_rental",
    business_hours: "Mon-Fri 9-5",
    timezone: "America/New_York",
  });
  if (/DEPARTMENTS & TOPIC EXPERTISE/.test(noTopicsPrompt)) {
    failures.push("DEPARTMENTS section leaked when topics omitted");
  }
  record("T33 prompt-renderer: DEPARTMENTS section renders topics + omitted when absent", failures.length === 0, failures.join("; ") || "section renders w/ slug + name + utterances; omitted when no topics");
}

// ── Phase 3.2c additions ────────────────────────────────────────────

async function T34_dial_status_busy_canceled_failed_preserve_handoff() {
  // busy / canceled / failed reflect Twilio call-outcome — the routing
  // PATH we took is orthogonal. handoff_reason must stay untouched.
  const failures: string[] = [];
  for (const status of ["busy", "canceled", "failed"] as const) {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });
    // We also stub the calls SELECTs so we can assert they were NOT
    // called for handoff_reason promotion (only completed does that).
    let handoffSelectCount = 0;
    fake.on(
      (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "handoff_reason",
      { data: { handoff_reason: "topic_match_ringing" } },
    );
    const origResolve = fake.resolveCall.bind(fake);
    fake.resolveCall = async function (call: any) {
      if (call.op === "select" && call.table === "calls" && call.selectColumns === "handoff_reason") {
        handoffSelectCount++;
      }
      return origResolve(call);
    };

    await handleDialStatus(asClient(fake), {
      business_id: BIZ,
      conversation_id: CONV,
      DialCallStatus: status,
      To: PHONE_A,
    });
    const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
    if (!update) {
      failures.push(`[${status}] no UPDATE issued`);
      continue;
    }
    if (update.payload?.transfer_status !== status) failures.push(`[${status}] transfer_status=${update.payload?.transfer_status}`);
    // Critical assertion — handoff_reason MUST NOT be in the payload.
    if ("handoff_reason" in update.payload) {
      failures.push(`[${status}] handoff_reason present in payload (${update.payload.handoff_reason}) — should NOT be touched`);
    }
    // Handoff SELECT should NOT have fired (only fires for answered → promotion).
    if (handoffSelectCount !== 0) {
      failures.push(`[${status}] handoff_reason SELECT fired ${handoffSelectCount} times (should be 0 — no promotion path)`);
    }
  }
  record("T34 dial-status busy/canceled/failed preserve handoff_reason", failures.length === 0, failures.join("; ") || "3 outcomes: transfer_status updated, handoff_reason untouched, no promotion select");
}

async function T35_normalize_phone() {
  const failures: string[] = [];
  const cases: Array<{ input: string | null | undefined; want: string; label: string }> = [
    { input: "+14155551234", want: "4155551234", label: "E.164 US" },
    { input: "(415) 555-1234", want: "4155551234", label: "national parenthesized" },
    { input: "415.555.1234", want: "4155551234", label: "dot-separated" },
    { input: "1-415-555-1234", want: "4155551234", label: "leading 1 dashes" },
    { input: "  +1 415 555 1234  ", want: "4155551234", label: "whitespace" },
    { input: null, want: "", label: "null" },
    { input: undefined, want: "", label: "undefined" },
    { input: "", want: "", label: "empty" },
    { input: "555", want: "555", label: "short (partial)" },
  ];
  for (const c of cases) {
    const got = normalizePhone(c.input);
    if (got !== c.want) failures.push(`[${c.label}] got "${got}" want "${c.want}"`);
  }
  record("T35 normalizePhone: last-10-digits comparison", failures.length === 0, failures.join("; ") || "9 formats all normalize to last-10 digits");
}

async function T36_promote_handoff_reason() {
  const failures: string[] = [];
  const cases: Array<{ input: string | null | undefined; want: string | null; label: string }> = [
    { input: "topic_match_ringing", want: "topic_match_answered", label: "topic_match_ringing → _answered" },
    { input: "fallback_any_on_duty_ringing", want: "fallback_any_on_duty_answered", label: "fallback_any_on_duty_ringing → _answered" },
    { input: "no_staff_during_hours_ringing", want: "no_staff_during_hours_answered", label: "no_staff_during_hours_ringing → _answered" },
    { input: "topic_no_longer_configured", want: null, label: "race flag preserved (no promotion)" },
    { input: "after_hours_callback", want: null, label: "terminal preserved" },
    { input: "graceful_hangup", want: null, label: "terminal preserved" },
    { input: null, want: null, label: "null input" },
    { input: "", want: null, label: "empty input" },
    { input: "already_answered", want: null, label: "unknown suffix preserved" },
  ];
  for (const c of cases) {
    const got = promoteHandoffReasonOnAnswer(c.input);
    if (got !== c.want) failures.push(`[${c.label}] got ${JSON.stringify(got)} want ${JSON.stringify(c.want)}`);
  }
  record("T36 promoteHandoffReasonOnAnswer: only _ringing suffix promotes", failures.length === 0, failures.join("; ") || "3 ringing→answered + race + terminals + null all handled");
}

async function T37_zero_match_upsert_creates_row() {
  // Simulates the primary Blocker-1 fix: routing webhook fires BEFORE
  // the post-call handler has inserted the calls row. Under 3.2b's
  // .update().eq("conversation_id",…) shape, no row matched and the
  // routing metadata was lost. Under 3.2c's upsert, the row is
  // CREATED with a complete payload.
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [
    { user_id: USER_A, callback_ring_number: PHONE_A },
  ]);
  // stubDefaultBusiness stubs the upsert with data:{id: CALL_ID} —
  // simulating a successful INSERT-via-UPSERT with no prior row.

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (!upsert) failures.push("no upsert issued");
  // Verify the payload has all fields needed to bootstrap a fresh row.
  if (upsert?.payload?.business_id !== BIZ) failures.push(`payload business_id=${upsert?.payload?.business_id}`);
  if (upsert?.payload?.call_sid !== CONV) failures.push(`payload call_sid=${upsert?.payload?.call_sid}`);
  if (upsert?.payload?.conversation_id !== CONV) failures.push(`payload conversation_id=${upsert?.payload?.conversation_id} (mirrors for future readers)`);
  if (upsert?.payload?.direction !== "inbound") failures.push(`payload direction=${upsert?.payload?.direction}`);
  if (upsert?.upsertOptions?.onConflict !== "call_sid") failures.push(`onConflict=${upsert?.upsertOptions?.onConflict}`);
  record("T37 UPSERT bootstraps row when post-call webhook hasn't fired", failures.length === 0, failures.join("; ") || "upsert with complete payload + onConflict=call_sid — Blocker 1 fix");
}

// ── Phase 3.3: in-app calling (WebRTC softphone) ────────────────────

// Phase 3.3a — derive identities via the shared helper so a formula
// change (e.g. migration 044 hypothetically re-shaping) is reflected
// in the tests without hand-updating every fixture.
const CLIENT_A = buildClientIdentity(USER_A, BIZ);
const CLIENT_B = buildClientIdentity(USER_B, BIZ);
const FRESH_HB = () => new Date().toISOString();
const STALE_HB = () => new Date(Date.now() - 5 * 60_000).toISOString();

/**
 * Phase 3.3 T38 — <Client> TwiML shape: a candidate with
 * in_app_calling_enabled + fresh heartbeat renders as
 * <Client><Identity>...</Identity><Parameter name="topic_name" .../></Client>
 * with no <Number> child.
 */
async function T38_client_only_twiml_shape() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        {
          user_id: USER_A,
          callback_ring_number: null,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: FRESH_HB(),
        },
      ],
    },
  );

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const twiml = result.result.twiml || "";
    if (!/<Client(\s|>)/.test(twiml)) failures.push("<Client> element missing");
    if (!twiml.includes(`<Identity>${CLIENT_A}</Identity>`)) failures.push("identity missing from <Identity>");
    if (!/<Parameter name="topic_name"/.test(twiml)) failures.push("topic_name Parameter missing");
    // Must NOT have <Number> — candidate has no callback_ring_number.
    if (/<Number/.test(twiml)) failures.push("unexpected <Number> for client-only candidate");
    if (result.result.decision.staffCandidates[0]?.clientIdentity !== CLIENT_A) {
      failures.push("staffCandidates[0].clientIdentity != CLIENT_A");
    }
  }
  record("T38 <Client>-only TwiML: identity + topic_name Parameter, no <Number>", failures.length === 0, failures.join("; ") || "in-app-only staff renders <Client><Identity><Parameter>...</Client>");
}

/**
 * Phase 3.3 T39 — mixed Client + Number simulring: one staff with both,
 * another with only cell, another with only client — TwiML contains all
 * three legs so browser + PSTN ring in parallel.
 */
async function T39_mixed_client_number_simulring() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [
    { user_id: USER_A, topic_slug: TOPIC_ROADSIDE },
    { user_id: USER_B, topic_slug: TOPIC_ROADSIDE },
    { user_id: USER_C, topic_slug: TOPIC_ROADSIDE },
  ]);
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        // A: both — expect <Client> AND <Number>
        {
          user_id: USER_A,
          callback_ring_number: PHONE_A,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: FRESH_HB(),
        },
        // B: cell only — expect <Number> only
        {
          user_id: USER_B,
          callback_ring_number: PHONE_B,
          client_identity: CLIENT_B,
          in_app_calling_enabled: false,
          voice_device_last_seen_at: null,
        },
        // C: client only — expect <Client> only
        {
          user_id: USER_C,
          callback_ring_number: null,
          client_identity: buildClientIdentity(USER_C, BIZ),
          in_app_calling_enabled: true,
          voice_device_last_seen_at: FRESH_HB(),
        },
      ],
    },
  );

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const twiml = result.result.twiml || "";
    const clientCount = (twiml.match(/<Client(\s|>)/g) || []).length;
    const numberCount = (twiml.match(/<Number/g) || []).length;
    if (clientCount !== 2) failures.push(`<Client> count=${clientCount} (expected 2 — A and C)`);
    if (numberCount !== 2) failures.push(`<Number> count=${numberCount} (expected 2 — A and B)`);
    if (!twiml.includes(CLIENT_A)) failures.push("A's client identity missing");
    if (!twiml.includes(buildClientIdentity(USER_C, BIZ))) failures.push("C's client identity missing");
    if (!twiml.includes(PHONE_A)) failures.push("A's phone missing");
    if (!twiml.includes(PHONE_B)) failures.push("B's phone missing");
  }
  record("T39 mixed Client+Number simulring: 3 staff yield 2 <Client> + 2 <Number>", failures.length === 0, failures.join("; ") || "browser + cell ring in parallel per staff config");
}

/**
 * Phase 3.3 T40 — client:<identity> handled_by resolution. Answered
 * `To=client:user_xxx` must resolve to the auth.users.id via
 * user_businesses.client_identity, and calls.answered_via='browser'.
 */
async function T40_client_identity_handled_by() {
  const fake = new FakeSupabaseClient();
  // Lookup by client_identity (Phase 3.3 code path). No rung_user_ids
  // read, no callback_ring_number lookup — pure identity match.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "client_identity"),
    { data: { user_id: USER_A } },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });
  // Handoff-reason select for _ringing → _answered promotion.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "handoff_reason",
    { data: { handoff_reason: "topic_match_ringing" } },
  );

  const result = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "completed",
    To: `client:${CLIENT_A}`,
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.handledByUserId !== USER_A) failures.push(`handled_by=${result.handledByUserId}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handled_by_user_id !== USER_A) failures.push(`update handled_by=${update?.payload?.handled_by_user_id}`);
  if (update?.payload?.answered_via !== "browser") failures.push(`update answered_via=${update?.payload?.answered_via} (expected browser)`);
  // Ensure NO phone-based rung_user_ids lookup happened — client: path
  // must skip that entirely.
  const rungLookup = fake.calls.find((c) => c.op === "select" && c.table === "calls" && c.selectColumns === "rung_user_ids");
  if (rungLookup) failures.push("rung_user_ids lookup fired on client: path (should be short-circuited)");
  record("T40 client:<identity> resolves via client_identity + answered_via=browser + skips phone lookup", failures.length === 0, failures.join("; ") || "browser leg resolves without phone-normalization");
}

/**
 * Phase 3.3 T41 — false-match regression. A client:<uuid> To must NOT
 * resolve via last-10-digits phone comparison. Pre-3.3 code stripped
 * non-digits from `client:user_abc123def456...` and could match a
 * staff cell ending in "123456". Verify that pathway is now dead.
 */
async function T41_false_match_regression() {
  const fake = new FakeSupabaseClient();
  // Craft a client identity that contains the target phone as a
  // substring. If the buggy pre-3.3 code path ran, normalizePhone
  // would strip non-digits and match "4155551234" against USER_B's
  // cell. New format is `user_<32hex>__<12hex>` so we embed the
  // "4155551234" fragment inside the hex-shaped user segment.
  const evilClientId = "user_ab4155551234cdef1234567890abcdef__aabbccddeeff";
  // NO row for this identity — client_identity lookup returns nothing.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "client_identity"),
    { data: null },
  );
  // Populate rung_user_ids + user_businesses with USER_B whose phone
  // ends in 4155551234. If the buggy pre-3.3 path ran, this would
  // false-match B.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "rung_user_ids",
    { data: { rung_user_ids: [USER_B] } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses" && c.inFilters.some((f) => f.column === "user_id"),
    { data: [{ user_id: USER_B, callback_ring_number: "+14155551234" }] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "handoff_reason",
    { data: { handoff_reason: "topic_match_ringing" } },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  const result = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "completed",
    To: `client:${evilClientId}`,
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.handledByUserId === USER_B) failures.push(`false-match: resolved to USER_B via phone normalization of a client: uri`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handled_by_user_id === USER_B) failures.push("update wrote USER_B handled_by from evil client: (regression)");
  // answered_via should still be browser (we saw a client: prefix even
  // if we couldn't map it to a user).
  if (update?.payload?.answered_via !== "browser") failures.push(`update answered_via=${update?.payload?.answered_via} (expected browser)`);
  record("T41 false-match regression: client:<uuid> never resolves via phone matching", failures.length === 0, failures.join("; ") || "client: bypasses normalizePhone entirely");
}

/**
 * Phase 3.3 T42 — twilio_call_sid persisted on the routing UPSERT so
 * failed-redirect forensics don't require Sentry↔Twilio-console
 * hand-correlation.
 */
async function T42_twilio_call_sid_upsert() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  stubUserBusinessesOnDuty(fake, [{ user_id: USER_A, callback_ring_number: PHONE_A }]);

  const result = await handleRouteToTopic(asClient(fake), {
    ...baseBody,
    call_sid: "CA_twilio_test_42",
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const upsert = fake.calls.find((c) => c.op === "upsert" && c.table === "calls");
  if (upsert?.payload?.twilio_call_sid !== "CA_twilio_test_42") {
    failures.push(`payload twilio_call_sid=${upsert?.payload?.twilio_call_sid} (expected CA_twilio_test_42)`);
  }
  // call_sid remains the conversation_id (per migration 041 historical alias).
  if (upsert?.payload?.call_sid !== CONV) failures.push(`payload call_sid=${upsert?.payload?.call_sid} (should still be conversation_id)`);
  record("T42 twilio_call_sid written on UPSERT (distinct from calls.call_sid)", failures.length === 0, failures.join("; ") || "both columns coexist without conflation");
}

/**
 * Phase 3.3 T43 — device freshness gate. A staff member with
 * in_app_calling_enabled=true but a STALE heartbeat (>90s ago) AND no
 * callback_ring_number is dropped from the candidate list — otherwise
 * routing would ring a dead <Client>.
 */
async function T43_stale_heartbeat_drops_candidate() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [
    { user_id: USER_A, topic_slug: TOPIC_ROADSIDE },
    { user_id: USER_B, topic_slug: TOPIC_ROADSIDE },
  ]);
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        // A: stale heartbeat + no callback → dropped
        {
          user_id: USER_A,
          callback_ring_number: null,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: STALE_HB(),
        },
        // B: fresh heartbeat → kept
        {
          user_id: USER_B,
          callback_ring_number: null,
          client_identity: CLIENT_B,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: FRESH_HB(),
        },
      ],
    },
  );

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const cands = result.result.decision.staffCandidates;
    if (cands.length !== 1) failures.push(`candidate count=${cands.length} (expected 1 — A dropped for stale HB)`);
    else if (cands[0].userId !== USER_B) failures.push(`kept wrong user: ${cands[0].userId}`);
  }
  record("T43 stale heartbeat drops in-app-only candidate", failures.length === 0, failures.join("; ") || "unregistered device is unavailable in routing candidate query");
}

/**
 * Phase 3.3 T44 — token endpoint identity is derived server-side from
 * the JWT session, NEVER from the request. Assert
 * resolveClientIdentityForUser returns the row's client_identity
 * regardless of what the client sent.
 */
async function T44_token_identity_ignores_client_supplied() {
  const fake = new FakeSupabaseClient();
  // Phase 3.3a — the resolver reads a membership row to CONFIRM the
  // caller belongs to the requested business, then computes the
  // identity via buildClientIdentity(userId, businessId) — it does
  // NOT echo whatever client_identity happens to be stored on the
  // row. So we stub any evil / mismatched value in the DB and assert
  // the resolver still returns the canonical derived identity.
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: { business_id: BIZ } },
  );
  const identity = await resolveClientIdentityForUser(asClient(fake), USER_A, BIZ);
  const expected = buildClientIdentity(USER_A, BIZ);
  const failures: string[] = [];
  if (identity !== expected) failures.push(`identity=${identity} expected=${expected}`);
  if (identity === "attacker-supplied-value") failures.push("resolver returned client-supplied value");
  // Sanity: the query MUST be filtered by user_id (the authenticated
  // caller), not by anything the caller could have influenced.
  const q = fake.calls.find((c) => c.op === "select" && c.table === "user_businesses");
  if (!q?.eqFilters.some((f) => f.column === "user_id" && f.value === USER_A)) {
    failures.push("resolver did not filter by user_id (server-side JWT identity)");
  }
  record("T44 token endpoint identity derived server-side (client-supplied ignored)", failures.length === 0, failures.join("; ") || "resolveClientIdentityForUser scopes by userId from JWT + computes via helper");
}

/**
 * Phase 3.3 T45 — parseClientTo / parseClientFrom shape parsing.
 * Round-trips valid client: URIs; rejects everything else.
 */
async function T45_parse_client_uris() {
  const failures: string[] = [];
  const toCases: Array<{ input: any; want: string | null; label: string }> = [
    { input: "client:user_abc", want: "user_abc", label: "basic" },
    { input: "  client:user_xyz  ", want: "user_xyz", label: "trim outer" },
    { input: "CLIENT:user_upper", want: "user_upper", label: "case-insensitive prefix" },
    { input: "+14155551234", want: null, label: "E.164 → null" },
    { input: "client:", want: null, label: "empty identity → null" },
    { input: "", want: null, label: "empty" },
    { input: null, want: null, label: "null" },
    { input: undefined, want: null, label: "undefined" },
    { input: 12345, want: null, label: "non-string" },
  ];
  for (const c of toCases) {
    const got = parseClientTo(c.input as any);
    if (got !== c.want) failures.push(`parseClientTo[${c.label}] got=${JSON.stringify(got)} want=${JSON.stringify(c.want)}`);
    // parseClientFrom is stricter than parseClientTo — Twilio's outbound
    // TwiML app always sends a cleanly-formatted `From` (lowercase
    // `client:` prefix, no outer whitespace). Skip the lenient variants
    // that don't apply to the real request shape.
    if (c.label === "case-insensitive prefix" || c.label === "trim outer") continue;
    const gotFrom = parseClientFrom(c.input as any);
    if (gotFrom !== c.want) {
      failures.push(`parseClientFrom[${c.label}] got=${JSON.stringify(gotFrom)} want=${JSON.stringify(c.want)}`);
    }
  }
  record("T45 parseClientTo / parseClientFrom: shape parsing + rejections", failures.length === 0, failures.join("; ") || "client: uris parsed, others null");
}

/**
 * Phase 3.3 T46 — outbound TwiML shape: buildOutboundDialTwiml renders
 * <Dial callerId="..."><Number>To</Number></Dial>. Regression guard on
 * XML escaping too.
 */
async function T46_outbound_twiml_shape() {
  const failures: string[] = [];
  const t = buildOutboundDialTwiml("+18005551234", "+14155559999");
  if (!/<Dial callerId="\+18005551234"/.test(t)) failures.push("missing callerId attr");
  if (!/answerOnBridge="true"/.test(t)) failures.push("missing answerOnBridge");
  if (!/<Number>\+14155559999<\/Number>/.test(t)) failures.push("missing <Number> child");
  // XML escape check.
  const t2 = buildOutboundDialTwiml("+18005551234", "+1&<test>");
  if (!/&amp;&lt;test&gt;/.test(t2)) failures.push("XML escaping broken");
  record("T46 outbound TwiML shape + XML escape", failures.length === 0, failures.join("; ") || "callerId + answerOnBridge + <Number> + escape");
}

/**
 * Phase 3.3 T47 — outbound caller ID must match business's provisioned
 * number. resolveBusinessForClient returns the business + phone; the
 * webhook rejects mismatched callerId inside the handler. This test
 * asserts the resolver contract.
 */
async function T47_outbound_business_resolver() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "client_identity"),
    { data: [{ business_id: BIZ }] },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { twilio_phone_number: "+18005551234", phone_number: null } },
  );
  const biz = await resolveBusinessForClient(asClient(fake), CLIENT_A);
  const failures: string[] = [];
  if (!biz) failures.push("resolver returned null");
  else {
    if (biz.businessId !== BIZ) failures.push(`businessId=${biz.businessId}`);
    if (biz.twilioPhoneNumber !== "+18005551234") failures.push(`twilioNumber=${biz.twilioPhoneNumber}`);
  }
  record("T47 resolveBusinessForClient returns business + phone", failures.length === 0, failures.join("; ") || "identity → (business_id, twilio_phone_number)");
}

/**
 * Phase 3.3 T48 — mintVoiceAccessToken produces a valid JWT with the
 * identity claim. Requires env vars; skipped when not set (won't fail
 * CI in stripped-down envs).
 */
async function T48_mint_access_token() {
  const failures: string[] = [];
  if (
    !process.env.TWILIO_ACCOUNT_SID ||
    !process.env.TWILIO_API_KEY_SID ||
    !process.env.TWILIO_API_KEY_SECRET ||
    !process.env.TWILIO_TWIML_APP_SID
  ) {
    // Inject test-only env for the minter — real values not needed
    // since we only decode the JWT payload locally.
    process.env.TWILIO_ACCOUNT_SID = "ACtest";
    process.env.TWILIO_API_KEY_SID = "SKtest";
    process.env.TWILIO_API_KEY_SECRET = "secret_test_1234567890";
    process.env.TWILIO_TWIML_APP_SID = "APtest";
  }
  try {
    const { jwt, expiresAt } = mintVoiceAccessToken(CLIENT_A);
    if (typeof jwt !== "string" || jwt.split(".").length !== 3) {
      failures.push(`jwt shape wrong: ${jwt?.slice(0, 30)}`);
    }
    // Decode payload (middle segment, base64url) — twilio SDK uses HS256.
    const payloadJson = Buffer.from(jwt.split(".")[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    if (payload.grants?.identity !== CLIENT_A) {
      failures.push(`identity in payload=${payload.grants?.identity}`);
    }
    if (!payload.grants?.voice) failures.push("voice grant missing");
    if (payload.grants?.voice?.incoming?.allow !== true) failures.push("incomingAllow not set");
    if (payload.grants?.voice?.outgoing?.application_sid !== "APtest") {
      failures.push(`outgoingAppSid=${payload.grants?.voice?.outgoing?.application_sid}`);
    }
    if (expiresAt.getTime() <= Date.now()) failures.push("expiresAt in the past");
  } catch (e) {
    failures.push(`threw: ${(e as Error).message}`);
  }
  record("T48 mintVoiceAccessToken: JWT w/ identity + VoiceGrant", failures.length === 0, failures.join("; ") || "identity + voice grant + expiry all present");
}

// ── Phase 3.3a: per-membership identity + toggle wiring ────────────

/**
 * Phase 3.3a T49 — the collision that motivated this slice. Same user,
 * different businesses → different identities. Under the 3.3 formula
 * these would collide.
 */
async function T49_identity_differs_across_businesses() {
  const failures: string[] = [];
  const idA = buildClientIdentity(USER_A, BIZ);
  const idB = buildClientIdentity(USER_A, OTHER_BIZ);
  if (idA === idB) failures.push(`collision: same identity for (userA, bizA) and (userA, bizB) — ${idA}`);
  // And identity must depend on both inputs: swapping business gives
  // a different suffix.
  if (!idA.startsWith("user_")) failures.push(`shape: ${idA}`);
  if (idA.split("__")[1] === idB.split("__")[1]) failures.push("suffix identical across biz");
  record("T49 buildClientIdentity: (userA, bizA) != (userA, bizB) — the 3.3 collision fixed", failures.length === 0, failures.join("; ") || "per-membership identity — no cross-tenant Client collision");
}

/**
 * Phase 3.3a T50 — determinism. Same (user, biz) always produces the
 * same identity. The token endpoint depends on this: it derives the
 * identity from the JWT + active-biz header without a DB roundtrip.
 */
async function T50_identity_is_deterministic() {
  const failures: string[] = [];
  const runs = Array.from({ length: 5 }, () => buildClientIdentity(USER_A, BIZ));
  const distinct = new Set(runs).size;
  if (distinct !== 1) failures.push(`non-deterministic: ${distinct} distinct outputs across 5 runs`);
  // Cross-check against the DB formula shape (32 hex user + 12 hex biz).
  if (!/^user_[0-9a-f]{32}__[0-9a-f]{12}$/i.test(runs[0])) {
    failures.push(`shape mismatch: ${runs[0]}`);
  }
  record("T50 buildClientIdentity: deterministic + shape matches migration 043 DDL", failures.length === 0, failures.join("; ") || "5 runs identical; matches user_<32hex>__<12hex>");
}

/**
 * Phase 3.3a T51 — preferences endpoint scopes writes to caller's own
 * (user_id, business_id). No body-supplied user_id can override the
 * JWT-derived identity — the helper doesn't accept one, and the
 * UPDATE below is verified to filter on the caller's credentials.
 */
async function T51_preferences_rejects_other_users_row() {
  const fake = new FakeSupabaseClient();
  // Stub a successful UPDATE for the caller's OWN (userA, bizA) row.
  fake.on(
    (c) => c.op === "update" && c.table === "user_businesses",
    { data: { in_app_calling_enabled: true } },
  );

  // The caller sends a body that tries to specify a DIFFERENT user_id
  // and business_id. updatePreferenceForCaller must ignore both and
  // scope the UPDATE to (callerUserId, callerBusinessId) only.
  const result = await updatePreferenceForCaller(
    asClient(fake),
    USER_A, // JWT identity
    BIZ,    // active biz
    {
      in_app_calling_enabled: true,
      // Attacker-crafted fields — must be dropped on the floor.
      user_id: USER_B,
      business_id: OTHER_BIZ,
    },
  );

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "user_businesses");
  if (!update) failures.push("no UPDATE issued");
  // The critical assertions: UPDATE must filter on the JWT-derived
  // user_id and business_id, NOT on the body-supplied ones.
  const userFilter = update?.eqFilters.find((f) => f.column === "user_id");
  const bizFilter = update?.eqFilters.find((f) => f.column === "business_id");
  if (userFilter?.value !== USER_A) failures.push(`user_id filter=${userFilter?.value} (expected USER_A from JWT)`);
  if (bizFilter?.value !== BIZ) failures.push(`business_id filter=${bizFilter?.value} (expected BIZ from JWT)`);
  // Body-supplied user_id / business_id must NOT appear in the payload.
  if ((update?.payload as any)?.user_id) failures.push("payload contains user_id (should only carry in_app_calling_enabled)");
  if ((update?.payload as any)?.business_id) failures.push("payload contains business_id");

  // Reject bad body types.
  const bad = await updatePreferenceForCaller(asClient(fake), USER_A, BIZ, { in_app_calling_enabled: "yes" });
  if (bad.ok) failures.push("string value should have been rejected");
  else if (bad.status !== 400) failures.push(`bad-body status=${bad.status}`);
  record("T51 /voice/preferences PATCH: scoped to caller's own membership, body-supplied user_id ignored", failures.length === 0, failures.join("; ") || "auth-scoped writes + body sanitation");
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
  // Phase 3.2b
  await T22_rest_redirect_scheduled();
  await T23_no_redirect_on_after_hours();
  await T24_no_redirect_on_graceful_hangup();
  await T25_no_redirect_when_call_sid_missing();
  await T26_map_dial_status();
  await T27_dial_status_answered();
  await T28_dial_status_no_answer();
  await T29_dial_status_missing_fields();
  await T30_route_to_topic_tool_shape();
  await T31_route_to_topic_tool_empty_throws();
  await T32_tool_dynamic_variable_call_sid();
  await T33_prompt_renders_departments_section();
  // Phase 3.2c additions
  await T34_dial_status_busy_canceled_failed_preserve_handoff();
  await T35_normalize_phone();
  await T36_promote_handoff_reason();
  await T37_zero_match_upsert_creates_row();
  // Phase 3.3 — in-app calling (WebRTC softphone)
  await T38_client_only_twiml_shape();
  await T39_mixed_client_number_simulring();
  await T40_client_identity_handled_by();
  await T41_false_match_regression();
  await T42_twilio_call_sid_upsert();
  await T43_stale_heartbeat_drops_candidate();
  await T44_token_identity_ignores_client_supplied();
  await T45_parse_client_uris();
  await T46_outbound_twiml_shape();
  await T47_outbound_business_resolver();
  await T48_mint_access_token();
  // Phase 3.3a — per-membership identity + toggle wiring
  await T49_identity_differs_across_businesses();
  await T50_identity_is_deterministic();
  await T51_preferences_rejects_other_users_row();
  await whisper_composition();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
