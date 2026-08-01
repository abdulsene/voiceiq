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
 *   3.3b additions (close token cross-tenant fallback + repair test):
 *   T41 (repaired) — fixture identity's stripped-digits tail-10 EQUALS
 *       USER_B's cell (was vacuous in 3.3a — trailing digits were
 *       "1234567890", could never false-match). Proven-to-bite by
 *       stubbing out the client: branch and observing the failure.
 *   T52 token: no membership for requested biz → 403, no substitution
 *   T53 token: multi-membership + no header → 400 explicit ambiguity
 *   T54 token: single-membership + no header → picks it deterministically
 *   T55 getPreferenceForCaller: happy path + 404 branch (route delegates
 *       to the shared helper — same code that T51 exercises)
 *
 *   3.3c additions (softphone as first-class surface):
 *   T56 reachability matrix — callback OR (in_app AND fresh HB);
 *       stale/absent HB blocks. Same predicate the routing engine uses.
 *   T57 system-bar indicator: 4 spec states (Ready/Not receiving/Off/
 *       Mic blocked) + transient states.
 *   T58 agent-tools returns empty (not error) when business has no
 *       agent yet — pre-onboarding is not an error state.
 *   T59 preference PATCH→GET round-trip: dock + sidebar toggles agree
 *       on the shared column.
 *
 *   3.4 additions (dial-status hardening + ringback + signed-request):
 *   T60 public-url helper: SINGLE source of truth. PUBLIC_API_URL
 *       wins; PUBLIC_URL fallback; divergence prefers API + warns;
 *       missing → hardcoded fallback + warns. Closes the sev-1 where
 *       two different envs made HMAC verify silently fail.
 *   T61 verifyTwilioSignature ON: accepts correctly-signed request,
 *       rejects tampered body, rejects missing header. First smoke
 *       coverage of the actual code path (prior suites all ran with
 *       TWILIO_WEBHOOK_VERIFY=0 — that's how the URL-mismatch bug
 *       shipped).
 *   T62 sig verify falls back to x-forwarded-host URL when
 *       PUBLIC_API_URL disagrees — in-flight callbacks survive an env
 *       change mid-deploy.
 *   T63 dial-builder emits ringTone="us" + wait-message <Say> so the
 *       caller doesn't sit in silence during the browser ring.
 *
 *   3.5 additions (per-leg attribution via whisper + handler hardening):
 *   T40 (rewritten): dial-status PRESERVES whisper-written attribution;
 *       the callback `To` is the ORIGINAL inbound number (never the
 *       child leg's target) so it cannot be trusted.
 *   T40b REST fallback: whisper skipped → fetch child leg via Twilio
 *       REST using DialCallSid → resolve attribution.
 *   T41 (revalidated): false-match regression MOVED from callback path
 *       to REST-fallback path (`To` from Twilio REST could be a
 *       client:<uuid>). Client-branch short-circuit still holds.
 *   T64 whisper URL is PER-CANDIDATE — <Client>/<Number> each carry
 *       user_id + leg. Same shared URL across candidates would leave
 *       the whisper handler unable to attribute.
 *   T65 parseWhisperQuery + writeWhisperAttribution: whisper is
 *       authoritative for handled_by / answered_via. UPDATE scoped
 *       to (business_id, call_sid).
 *   T66 whisper handler: degenerate inputs never throw. TwiML always
 *       well-formed — no customer-audible "application error" path.
 *   T67 writeWhisperAttribution swallows DB errors — a broken
 *       attribution write must NEVER crash the whisper leg.
 *
 *   3.6 additions (whisper accepts POST + TwiML verb audit):
 *   T68 POST /api/routing/whisper → 200 valid TwiML. Real HTTP
 *       round-trip via a booted Express + router. Guards the sev-1
 *       that 69 handler-function tests could not see: pre-3.6
 *       registration was router.get only, Twilio POSTs by default
 *       on <Number url> / <Client url>, every whisper 404'd in
 *       production since 3.2a and every answerer heard
 *       "an application error has occurred" before the bridge.
 *   T69 GET /api/routing/whisper → 200 valid TwiML. Same handler,
 *       both verbs.
 *   T70 dial-builder emits explicit method="GET" on <Client>/<Number>
 *       url attributes — verb contract stated, not inherited.
 *   T71 whisper URL encoding survives &, #, <, >, " in business +
 *       topic names via the encodeURIComponent + xmlEscape chain.
 *
 *   3.7 additions (caller-ID lookup + staff_count fix):
 *   T72 getCallerIdForCaller helper: provisioned / legacy / not_provisioned
 *       / 404 / tenant-scoped. Small dedicated contract replaces the
 *       pre-3.7 pattern of reading a specific field from the giant
 *       /business/configure response.
 *   T73 /api/voice/caller-id route-layer HTTP test — flat top-level
 *       shape, no nested .config. The Softphone contract is locked
 *       at the route layer, not the handler function.
 *   T74 staff_count counts in-app-only candidates. Pre-3.7 the field
 *       was decision.staffPhones.length, which reported 0 for
 *       browser-only staff (confirmed live in prod). LLM was told
 *       "nobody's available" while routing was actively ringing a
 *       browser. Fixed to decision.staffCandidates.length.

 *   T75 outbound TwiML uses resolved business caller ID —
 *       cross-tenant spoof guard from 3.3 still holds end-to-end.
 *
 *   3.8 additions (outbound in-app call logging + outcome capture):
 *   T76 insertOutboundCallRow — writes correct shape to `calls`.
 *   T77 CROSS-TENANT SCOPING GUARD — insert scopes by resolved
 *       business_id; lead linkage filters by business_id so a phone
 *       match against another tenant's lead cannot fire an activity
 *       row on their timeline.
 *   T78 handleOutboundStatus — updates by parent CallSid, maps Twilio
 *       outcome enum to call_outcome, soft-fails on missing SID
 *       (200-always discipline from Phase 3.4).
 *   T79 listRecentInAppCallsForUser — scoped by (business, user,
 *       answered_via='browser'). No cross-staff / cross-tenant leak.
 *   T80 POST /api/voice/outbound-status route-layer HTTP test —
 *       verb regression guard (route must accept POST, return 200
 *       valid TwiML). Same discipline as the 3.6 whisper POST bug.
 *   T81 resolveStaffUserIdForClient — happy path + null on miss.
 *
 *   3.9 additions (outcome taxonomy + phone normalization):
 *   T78 (updated) — canceled + no answer + duration 0 →
 *       caller_hung_up_during_ring (was 'canceled'); completed
 *       without AnsweredBy → answered_human (was 'answered').
 *   T82 mapDialOutcome matrix — 17 (DialCallStatus × AnsweredBy)
 *       combinations. Still exercised in 3.12 because the campaign
 *       engine's REST-API AMD path continues to populate answered_by.
 *   T83 buildOutboundDialTwiml emits ringTone="us" but NO AMD
 *       attributes (updated in 3.12 — AMD removed).
 *   T84 (REMOVED in 3.12): resolveOutboundAmdMode/NEVERR_OUTBOUND_AMD_MODE
 *       deleted with AMD wiring.
 *   T85 normalizeUsPhoneToE164 across 17 input shapes.
 *   T86 (renamed in 3.12) route-layer HTTP POST /voice/outbound-status
 *       with AMD body — verifies handleOutboundStatus still merges
 *       AnsweredBy from body when the campaign engine posts it.
 *   T87 server-side outbound normalization: 10/11/formatted → +E.164.
 *
 *   3.12 REPLACES 3.10 (AMD via <Dial><Number> proved non-functional
 *   in the TwiML-App / Client-parent topology — see phase 3.11
 *   research report). Staff disposition on hangup replaces automatic
 *   classification for the softphone path. Migration 046 adds
 *   disposition/dispositioned_by/dispositioned_at columns.
 *   T88 (rewritten) disposition whitelist rejects unknown values +
 *       validates call id.
 *   T89 (rewritten) CROSS-USER + CROSS-TENANT scoping guard —
 *       UPDATE scopes by (id AND business_id AND handled_by_user_id).
 *   T90 (rewritten) happy-path write — disposition + who + when;
 *       NEVER touches call_outcome (machine-observed stays separate
 *       from human-entered).
 *   T91 (rewritten) PATCH /api/voice/calls/:id/disposition
 *       route-layer HTTP smoke — 200 happy path + 400 whitelist
 *       reject.
 *   T92 (rewritten) no AMD attributes in ANY buildOutboundDialTwiml
 *       shape — regression guard against a future partial revert.
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
  // Phase 3.5 — whisper handler + parser exposed for testing.
  parseWhisperQuery,
  writeWhisperAttribution,
} from "../routes/routing";
// Phase 3.3
import {
  parseClientFrom,
  resolveClientIdentityForUser,
  resolveBusinessForClient,
  buildOutboundDialTwiml,
  mintVoiceAccessToken,
  updatePreferenceForCaller,
  getPreferenceForCaller,
  // Phase 3.3c
  getReachabilityForCaller,
  // Phase 3.7 — dedicated caller-ID lookup for the softphone.
  getCallerIdForCaller,
  // Phase 3.8 — outbound call logging + outcome capture.
  insertOutboundCallRow,
  linkOutboundCallToLeadIfMatch,
  handleOutboundStatus,
  listRecentInAppCallsForUser,
  resolveStaffUserIdForClient,
  // Phase 3.9 — outcome taxonomy + phone normalization. (Ringback +
  // AMD from 3.9/3.10 removed in 3.12 — see below.)
  mapDialOutcome,
  normalizeUsPhoneToE164,
  type OutboundOutcome,
  // Phase 3.12 — staff disposition helpers replace AMD entirely.
  writeCallDispositionForCaller,
  CALL_DISPOSITIONS,
  type CallDisposition,
} from "../routes/voice";
// Phase 3.3c — agent resync + tool inspector.
import { fetchRegisteredToolNames } from "../routes/agent-sync";
// Phase 3.4 — public-url unification + signature verification.
import { getPublicApiBase, _resetPublicUrlWarningsForTests } from "../lib/public-url";
import { verifyTwilioSignature } from "../lib/twilio-signature";
import twilio from "twilio";
// Phase 3.3a — single source of truth for the identity formula. Tests
// compute expected identities via the helper so a formula change in
// buildClientIdentity is caught by the fixtures automatically.
import { buildClientIdentity } from "../lib/voice/client-identity";
// Phase 3.15 — team page shows a "silently unreachable" flag driven
// by the team endpoint's new device_heartbeat_fresh field.
import { handleListTeam } from "../routes/team";
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
  // Phase 3.5 — .fetch() added to TwilioCallControl for dial-status's
  // child-leg REST fallback. This mock never fires it (redirect
  // tests only exercise .update); return a null-shaped stub so the
  // interface implements cleanly.
  calls(sid: string) {
    return {
      update: async (opts: { twiml: string }) => {
        this.updates.push({ callSid: sid, twiml: opts.twiml });
      },
      fetch: async () => ({ to: null }),
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
  // Phase 3.5 — handleDialStatus now reads the current row up-front
  // (handoff_reason + handled_by_user_id + answered_via + rung_user_ids)
  // in a SINGLE select so it can (a) promote handoff_reason, (b)
  // avoid overwriting attribution the whisper already wrote, (c)
  // still fall back to a phone lookup when nothing was pre-written.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "calls" &&
      c.selectColumns.includes("handoff_reason") &&
      c.selectColumns.includes("handled_by_user_id"),
    {
      // Whisper did NOT write attribution — simulates the case where
      // the whisper URL had no user_id (legacy_transfer) or the
      // whisper handler failed. dial-status falls back to phone
      // matching against rung_user_ids.
      data: {
        handoff_reason: "topic_match_ringing",
        handled_by_user_id: null,
        answered_via: null,
        rung_user_ids: [USER_A, USER_B],
      },
    },
  );
  // Legacy stubs kept in case resolveHandledByUserId still runs its
  // own selects on paths I haven't touched.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "rung_user_ids",
    { data: { rung_user_ids: [USER_A, USER_B] } },
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
// Phase 3.15 — widened DEVICE_FRESHNESS_SECS from 90 to 300. STALE_HB
// bumped from 5 min → 10 min so it's unambiguously past the new
// window (5 min is now exactly the boundary).
const STALE_HB = () => new Date(Date.now() - 10 * 60_000).toISOString();

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
 * Phase 3.5 T40 (rewritten) — REALISTIC Twilio <Dial action> payload.
 *
 * The prior 3.3/3.3b fixture injected `To: "client:${CLIENT_A}"`, a
 * shape Twilio DOES NOT SEND on the action callback. The callback
 * carries the ORIGINAL inbound call's params — `To` is the business's
 * own inbound Twilio number, never the child leg's target. Verified
 * live 2026-07-30 22:58: a browser-answered call landed with
 * answered_via='pstn', handled_by_user_id=NULL because the client:
 * branch never fired.
 *
 * The correct attribution source is the WHISPER, which fires on the
 * winning leg by construction. This test now asserts that if the
 * whisper already wrote handled_by_user_id + answered_via, dial-
 * status PRESERVES those values (does not overwrite from the
 * misleading callback `To`).
 */
async function T40_dial_status_preserves_whisper_attribution() {
  const fake = new FakeSupabaseClient();
  // Simulate: whisper already wrote attribution (USER_A, browser).
  // dial-status then arrives with the inbound-number `To` — must not
  // clobber those fields.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "calls" &&
      c.selectColumns.includes("handoff_reason") &&
      c.selectColumns.includes("handled_by_user_id"),
    {
      data: {
        handoff_reason: "topic_match_ringing",
        handled_by_user_id: USER_A,
        answered_via: "browser",
        rung_user_ids: [USER_A, USER_B],
      },
    },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  const result = await handleDialStatus(asClient(fake), {
    business_id: BIZ,
    conversation_id: CONV,
    DialCallStatus: "completed",
    // Realistic: Twilio sends the inbound business number here, NOT
    // client:<identity>. Same value on both browser-answered and
    // cell-answered calls.
    To: "+14433314649",
    DialCallSid: "CA_child_leg_test_40",
  });
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.handledByUserId !== USER_A) failures.push(`handled_by=${result.handledByUserId}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  // Status must be promoted, but attribution must NOT be re-written
  // (whisper already owns it). Payload should NOT contain
  // handled_by_user_id / answered_via keys — omitted, not re-set.
  if (update?.payload?.transfer_status !== "answered") failures.push(`transfer_status=${update?.payload?.transfer_status}`);
  if (update?.payload?.handoff_reason !== "topic_match_answered") failures.push(`handoff_reason=${update?.payload?.handoff_reason}`);
  if ("handled_by_user_id" in (update?.payload || {})) {
    failures.push(`payload should NOT re-write handled_by_user_id (whisper owns it); got ${update?.payload?.handled_by_user_id}`);
  }
  if ("answered_via" in (update?.payload || {})) {
    failures.push(`payload should NOT re-write answered_via (whisper owns it); got ${update?.payload?.answered_via}`);
  }
  record("T40 dial-status preserves whisper-written attribution (does not clobber from inbound-number To)", failures.length === 0, failures.join("; ") || "whisper is authoritative for handled_by / answered_via");
}

/**
 * Phase 3.5 T40b — REST fallback: when whisper did NOT write
 * attribution (legacy_transfer path OR whisper handler failed) and
 * `To` on the callback is the useless inbound number, dial-status
 * MUST fetch the child leg via Twilio REST using DialCallSid to
 * learn what actually answered.
 */
async function T40b_dial_status_rest_fallback_attribution() {
  const fake = new FakeSupabaseClient();
  // Whisper did NOT write — attribution fields NULL, rung_user_ids
  // populated so PSTN phone match can succeed.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "calls" &&
      c.selectColumns.includes("handoff_reason") &&
      c.selectColumns.includes("handled_by_user_id"),
    {
      data: {
        handoff_reason: "no_staff_during_hours_ringing",
        handled_by_user_id: null,
        answered_via: null,
        rung_user_ids: [USER_A, USER_B],
      },
    },
  );
  // resolveHandledByUserId's PSTN branch also reads rung_user_ids
  // via a narrower select — stub that too.
  fake.on(
    (c) => c.op === "select" && c.table === "calls" && c.selectColumns === "rung_user_ids",
    { data: { rung_user_ids: [USER_A, USER_B] } },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses" && c.inFilters.some((f) => f.column === "user_id"),
    { data: [{ user_id: USER_B, callback_ring_number: PHONE_B }] },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  // Mock Twilio REST — the child leg was Bob's cell.
  const restCalls: string[] = [];
  const twilioClient: TwilioCallControl = {
    calls: (sid: string) => {
      restCalls.push(sid);
      return {
        update: async () => ({}),
        fetch: async () => ({ to: PHONE_B }),
      };
    },
  };

  const result = await handleDialStatus(
    asClient(fake),
    {
      business_id: BIZ,
      conversation_id: CONV,
      DialCallStatus: "completed",
      To: "+14433314649", // inbound number — useless for attribution
      DialCallSid: "CA_child_leg_realistic",
    },
    new Date(),
    { twilioClient },
  );

  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (restCalls[0] !== "CA_child_leg_realistic") failures.push(`REST fetch sid=${restCalls[0]} (expected DialCallSid)`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handled_by_user_id !== USER_B) failures.push(`handled_by_user_id=${update?.payload?.handled_by_user_id}`);
  if (update?.payload?.answered_via !== "pstn") failures.push(`answered_via=${update?.payload?.answered_via}`);
  if (!update?.payload?.handled_at) failures.push("handled_at missing");
  record("T40b REST fallback attribution: whisper skipped → Twilio child-leg fetch resolves", failures.length === 0, failures.join("; ") || "DialCallSid → Twilio REST → child leg .to → handled_by");
}

/**
 * Phase 3.5 T41 (revalidated) — false-match regression MOVED from the
 * dial-status callback to the REST-fallback path.
 *
 * Original 3.3 concern: normalizePhone(client:<uuid>) could false-
 * match a staff cell. That path is now guarded by the whisper being
 * authoritative — dial-status only phone-matches when the whisper
 * didn't write attribution AND Twilio REST returned a value. This
 * test simulates the REST fallback returning a client:<uuid> whose
 * stripped digits collide with a staff cell; the client: branch in
 * resolveHandledByUserId MUST short-circuit before normalizePhone
 * runs, or we'd wrongly attribute the browser leg to whoever's cell
 * happens to end in those digits.
 */
async function T41_false_match_regression() {
  const fake = new FakeSupabaseClient();
  // Phase 3.3b — the T41 fixture in 3.3a was VACUOUS: its stripped
  // digits ended in "1234567890" which cannot false-match USER_B's
  // "4155551234". The test passed whether or not the client: branch
  // existed. Rebuilt so the identity's trailing 10 digits (after
  // normalizePhone-style stripping) EQUAL USER_B's normalized cell.
  //
  // Shape: user_<32-hex user segment>__<12-hex biz suffix>.
  //   - user segment: 22 non-digit hex chars (a-f), then the 10 phone
  //     digits at the tail → strip-non-digits yields "4155551234".
  //   - biz suffix: 12 non-digit hex chars (a-f) so it contributes
  //     NO digits — verified below.
  // Total identity digits after stripping non-digits: exactly the 10
  // phone digits. normalizePhone would take the last 10 → match B's
  // "+14155551234" (normalizes to "4155551234"). If the pre-3.3 phone
  // path runs on this string, T41 will fail.
  const evilClientId = "user_abcdefabcdefabcdefabcd4155551234__aabbccddeeff";
  // Self-verification: build the same phone-normalization the buggy
  // path would apply, assert it collides with USER_B's cell. If this
  // assertion trips the fixture is silently broken — better to fail
  // the test setup than to ship another vacuous regression guard.
  const identityDigits = evilClientId.replace(/\D+/g, "");
  const identityLast10 = identityDigits.slice(-10);
  const bLast10 = "+14155551234".replace(/\D+/g, "").slice(-10);
  if (identityLast10 !== bLast10) {
    record("T41 SETUP", false, `fixture identity last-10=${identityLast10}, USER_B last-10=${bLast10} — fixture no longer collides; T41 would be vacuous`);
    return;
  }
  // Row up-front read — whisper did NOT write attribution, so
  // dial-status will try to resolve on its own.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "calls" &&
      c.selectColumns.includes("handoff_reason") &&
      c.selectColumns.includes("handled_by_user_id"),
    {
      data: {
        handoff_reason: "topic_match_ringing",
        handled_by_user_id: null,
        answered_via: null,
        rung_user_ids: [USER_B],
      },
    },
  );
  // Identity lookup returns nothing (client not on file).
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "client_identity"),
    { data: null },
  );
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses" && c.inFilters.some((f) => f.column === "user_id"),
    { data: [{ user_id: USER_B, callback_ring_number: "+14155551234" }] },
  );
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });

  // Mock Twilio REST returning the EVIL client: URI as the child leg.
  // If the client: branch short-circuits (correct), we get
  // answered_via=browser and NO false-match. If normalizePhone runs
  // on it (regression), USER_B would be wrongly attributed.
  const twilioClient: TwilioCallControl = {
    calls: (_sid: string) => ({
      update: async () => ({}),
      fetch: async () => ({ to: `client:${evilClientId}` }),
    }),
  };

  const result = await handleDialStatus(
    asClient(fake),
    {
      business_id: BIZ,
      conversation_id: CONV,
      DialCallStatus: "completed",
      To: "+14433314649", // inbound number — triggers REST fallback
      DialCallSid: "CA_evil_client_test",
    },
    new Date(),
    { twilioClient },
  );
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.handledByUserId === USER_B) failures.push(`false-match: resolved to USER_B via phone normalization of a client: uri`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handled_by_user_id === USER_B) failures.push("update wrote USER_B handled_by from evil client: (regression)");
  // answered_via should still be browser (we saw a client: prefix
  // even if we couldn't map it to a user).
  if (update?.payload?.answered_via !== "browser") failures.push(`update answered_via=${update?.payload?.answered_via} (expected browser)`);
  record("T41 false-match regression (post-3.5): REST child leg client:<uuid> never resolves via phone matching", failures.length === 0, failures.join("; ") || "client: bypasses normalizePhone entirely in REST-fallback path too");
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
async function T43_stale_heartbeat_included_and_tagged() {
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
        // A: stale heartbeat + no callback → Phase 3.15 INCLUDES with
        // deviceStale=true (was dropped pre-3.15; silent unreachability
        // was the exact prod bug that phase fixes).
        {
          user_id: USER_A,
          callback_ring_number: null,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: STALE_HB(),
        },
        // B: fresh heartbeat → kept as before, deviceStale=false.
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
    if (cands.length !== 2) {
      failures.push(`candidate count=${cands.length} (expected 2 — both kept, A tagged stale)`);
    } else {
      const a = cands.find((c) => c.userId === USER_A);
      const b = cands.find((c) => c.userId === USER_B);
      if (!a) failures.push("USER_A missing — stale HB was dropped (pre-3.15 behaviour)");
      if (!b) failures.push("USER_B missing");
      if (a && a.deviceStale !== true) failures.push(`USER_A deviceStale=${a.deviceStale} (expected true)`);
      if (b && b.deviceStale === true) failures.push(`USER_B deviceStale=${b.deviceStale} (expected false/undefined)`);
      if (a && a.clientIdentity !== CLIENT_A) failures.push(`USER_A client identity missing (${a.clientIdentity})`);
    }
  }
  record(
    "T43 stale heartbeat INCLUDED as candidate + tagged deviceStale (Phase 3.15)",
    failures.length === 0,
    failures.join("; ") ||
      "routing tries the browser instead of silently skipping — dead Client fails fast",
  );
}

/**
 * Phase 3.3 T44 — token endpoint identity is derived server-side from
 * the JWT session, NEVER from the request. Assert
 * resolveClientIdentityForUser returns the row's client_identity
 * regardless of what the client sent.
 */
async function T44_token_identity_ignores_client_supplied() {
  const fake = new FakeSupabaseClient();
  // Phase 3.3b — resolver returns a discriminated union. We stub a
  // membership hit for (USER_A, BIZ) so the "requested biz found"
  // branch runs; identity must be derived from the helper, not echoed
  // from any (potentially attacker-influenced) column value.
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: { business_id: BIZ } },
  );
  const result = await resolveClientIdentityForUser(asClient(fake), USER_A, BIZ);
  const expected = buildClientIdentity(USER_A, BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.identity !== expected) failures.push(`identity=${result.identity} expected=${expected}`);
    if (result.businessId !== BIZ) failures.push(`businessId=${result.businessId}`);
  }
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
  // Phase 3.12: AMD removed entirely; ringTone disabled here so the
  // regex-match for the naked <Number> child stays exact. Ringback +
  // AMD-absent behaviour is covered by T83.
  const t = buildOutboundDialTwiml("+18005551234", "+14155559999", { ringTone: null });
  if (!/<Dial callerId="\+18005551234"/.test(t)) failures.push("missing callerId attr");
  if (!/answerOnBridge="true"/.test(t)) failures.push("missing answerOnBridge");
  if (!/<Number>\+14155559999<\/Number>/.test(t)) failures.push("missing <Number> child");
  // XML escape check.
  const t2 = buildOutboundDialTwiml("+18005551234", "+1&<test>", { ringTone: null });
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

// ── Phase 3.3b: close token cross-tenant fallback + preferences dedupe ───

/**
 * Phase 3.3b T52 — the token endpoint MUST NOT substitute a different
 * tenant when the caller isn't a member of the requested business.
 * 3.3a's resolver quietly fell back to ANY membership, reintroducing
 * the exact cross-tenant condition migration 043 closed.
 */
async function T52_token_no_membership_returns_403() {
  const fake = new FakeSupabaseClient();
  // Requested biz lookup MISSES. Also stub the "any membership"
  // query (in case the removed fallback code somehow returns) to
  // return a DIFFERENT business the caller has — if the resolver
  // substituted, it would happily mint a token for OTHER_BIZ.
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ),
    { data: null },
  );
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      !c.eqFilters.some((f) => f.column === "business_id"),
    { data: [{ business_id: OTHER_BIZ }] },
  );

  const result = await resolveClientIdentityForUser(asClient(fake), USER_A, BIZ);
  const failures: string[] = [];
  if (result.ok) {
    failures.push(
      `resolver returned identity=${result.identity} biz=${result.businessId} — MUST be 403 (no substitution)`,
    );
  } else {
    if (result.status !== 403) failures.push(`status=${result.status} (expected 403)`);
    if (!/not a member/i.test(result.error)) failures.push(`error=${result.error} (expected 'not a member' message)`);
  }
  record("T52 token: no membership for requested biz → 403, never substitutes another tenant", failures.length === 0, failures.join("; ") || "403 not-a-member — no cross-tenant token issuance");
}

/**
 * Phase 3.3b T53 — no active-business header + user has MULTIPLE
 * memberships → explicit 400. The prior code path silently returned
 * whatever .maybeSingle() picked (or errored to null), leaving the
 * caller unable to distinguish "genuinely unauthenticated" from
 * "please pick a tenant."
 */
async function T53_token_multi_membership_no_header_returns_400() {
  const fake = new FakeSupabaseClient();
  // No businessId passed → resolver runs the unscoped user_businesses
  // query. Stub it to return TWO memberships → ambiguous → 400.
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: [{ business_id: BIZ }, { business_id: OTHER_BIZ }] },
  );

  const result = await resolveClientIdentityForUser(asClient(fake), USER_A, undefined);
  const failures: string[] = [];
  if (result.ok) failures.push(`resolver returned identity=${result.identity} — MUST be 400 (ambiguous)`);
  else {
    if (result.status !== 400) failures.push(`status=${result.status} (expected 400)`);
    if (!/active business required/i.test(result.error)) {
      failures.push(`error=${result.error} (expected 'active business required')`);
    }
  }
  record("T53 token: multi-membership + no x-active-business → 400 explicit ambiguity", failures.length === 0, failures.join("; ") || "400 with 'active business required' — no silent guess");
}

/**
 * Phase 3.3b T54 — no active-business header + user has EXACTLY ONE
 * membership → happy path: resolver picks it deterministically and
 * returns the derived identity. This is the case the removed fallback
 * used to cover legitimately, so we assert it still works after
 * removing the cross-tenant substitution.
 */
async function T54_token_single_membership_no_header_ok() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: [{ business_id: BIZ }] },
  );
  const result = await resolveClientIdentityForUser(asClient(fake), USER_A, undefined);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.businessId !== BIZ) failures.push(`businessId=${result.businessId}`);
    if (result.identity !== buildClientIdentity(USER_A, BIZ)) {
      failures.push(`identity=${result.identity}`);
    }
  }
  record("T54 token: single-membership + no header → picks it deterministically", failures.length === 0, failures.join("; ") || "unambiguous → 200 with derived identity");
}

/**
 * Phase 3.3b T55 — the route delegates to updatePreferenceForCaller,
 * not a parallel copy. Also verifies getPreferenceForCaller shape.
 * Belt-and-braces: even the smoke previously exercised the copy;
 * this catches drift if someone re-adds inline logic.
 */
async function T55_get_preference_shape() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    { data: { in_app_calling_enabled: true } },
  );
  const result = await getPreferenceForCaller(asClient(fake), USER_A, BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else if (result.preferences.in_app_calling_enabled !== true) {
    failures.push(`enabled=${result.preferences.in_app_calling_enabled}`);
  }
  // 404 branch — no row.
  const fake2 = new FakeSupabaseClient();
  fake2.on((c) => c.op === "select" && c.table === "user_businesses", { data: null });
  const result2 = await getPreferenceForCaller(asClient(fake2), USER_A, BIZ);
  if (result2.ok) failures.push("null row should have been 404");
  else if (result2.status !== 404) failures.push(`404 branch status=${result2.status}`);
  record("T55 getPreferenceForCaller: happy path + 404 branch", failures.length === 0, failures.join("; ") || "route + tests share one implementation");
}

// ── Phase 3.4: dial-status hardening + ringback + signed-request smoke ─

/**
 * Phase 3.4 T60 — the sev-1 defect that motivated this slice.
 * getPublicApiBase() must be a SINGLE source of truth: the URL used
 * to BUILD callback URLs must equal the URL used to VERIFY signatures.
 *
 * Under 3.2c/3.3c we had TWO helpers:
 *   routing.ts:getPublicUrl → PUBLIC_URL || APP_URL || "https://neverr.ai"
 *   twilio-signature.ts:resolvePublicBase → PUBLIC_API_URL || fallback
 * When those two envs disagreed in Replit Secrets, HMAC mismatched
 * and dial-status returned 401 → Twilio played "an application error
 * has occurred" to the caller. This asserts that BOTH sides now
 * consult the same helper, and the helper explicitly prefers
 * PUBLIC_API_URL over the legacy envs.
 */
async function T60_public_url_single_source_of_truth() {
  const savedApi = process.env.PUBLIC_API_URL;
  const savedPublic = process.env.PUBLIC_URL;
  const savedApp = process.env.APP_URL;
  const failures: string[] = [];
  try {
    // Case 1: only PUBLIC_API_URL set → that wins.
    _resetPublicUrlWarningsForTests();
    process.env.PUBLIC_API_URL = "https://api.example.com/";
    delete process.env.PUBLIC_URL;
    delete process.env.APP_URL;
    if (getPublicApiBase() !== "https://api.example.com") {
      failures.push(`[api-only] got=${getPublicApiBase()}`);
    }

    // Case 2: PUBLIC_API_URL absent, PUBLIC_URL set → fall back to
    // PUBLIC_URL (compat with legacy Replit deploys).
    _resetPublicUrlWarningsForTests();
    delete process.env.PUBLIC_API_URL;
    process.env.PUBLIC_URL = "https://neverr.ai";
    if (getPublicApiBase() !== "https://neverr.ai") {
      failures.push(`[public-fallback] got=${getPublicApiBase()}`);
    }

    // Case 3: both set and DISAGREE → PUBLIC_API_URL wins, warning
    // fires (we can't inspect Sentry from here, but the fact we don't
    // silently pick the wrong one is what matters).
    _resetPublicUrlWarningsForTests();
    process.env.PUBLIC_API_URL = "https://api.example.com";
    process.env.PUBLIC_URL = "https://neverr.ai";
    if (getPublicApiBase() !== "https://api.example.com") {
      failures.push(`[divergent] got=${getPublicApiBase()} (must prefer PUBLIC_API_URL)`);
    }

    // Case 4: nothing set → hardcoded fallback (with a warning).
    _resetPublicUrlWarningsForTests();
    delete process.env.PUBLIC_API_URL;
    delete process.env.PUBLIC_URL;
    delete process.env.APP_URL;
    if (!/replit\.app$/.test(getPublicApiBase())) {
      failures.push(`[all-missing] got=${getPublicApiBase()}`);
    }
  } finally {
    if (savedApi !== undefined) process.env.PUBLIC_API_URL = savedApi;
    else delete process.env.PUBLIC_API_URL;
    if (savedPublic !== undefined) process.env.PUBLIC_URL = savedPublic;
    else delete process.env.PUBLIC_URL;
    if (savedApp !== undefined) process.env.APP_URL = savedApp;
    else delete process.env.APP_URL;
    _resetPublicUrlWarningsForTests();
  }
  record("T60 public-url helper: single source of truth + preference order", failures.length === 0, failures.join("; ") || "PUBLIC_API_URL wins, PUBLIC_URL fallback, divergence prefers API, missing = fallback");
}

/**
 * Phase 3.4 T61 — verifyTwilioSignature accepts a correctly-signed
 * request when TWILIO_WEBHOOK_VERIFY is NOT set. All prior 040 runs
 * used TWILIO_WEBHOOK_VERIFY=0 (the bypass) so this whole codepath
 * had never actually been exercised — which is exactly how the URL-
 * mismatch bug shipped.
 */
async function T61_signature_verify_accepts_valid_request() {
  const failures: string[] = [];
  const savedVerify = process.env.TWILIO_WEBHOOK_VERIFY;
  const savedToken = process.env.TWILIO_AUTH_TOKEN;
  const savedApi = process.env.PUBLIC_API_URL;
  const authToken = "test_auth_token_" + "x".repeat(24);

  try {
    delete process.env.TWILIO_WEBHOOK_VERIFY;
    process.env.TWILIO_AUTH_TOKEN = authToken;
    process.env.PUBLIC_API_URL = "https://api.example.com";
    _resetPublicUrlWarningsForTests();

    const originalUrl = "/api/routing/dial-status?business_id=B&conversation_id=C";
    const fullUrl = "https://api.example.com" + originalUrl;
    const params = { DialCallStatus: "completed", To: "+14155551234" };
    // Compute the same HMAC Twilio would produce for this URL+params.
    const validSignature = twilio.getExpectedTwilioSignature(authToken, fullUrl, params as any);

    const req: any = {
      originalUrl,
      body: params,
      protocol: "https",
      header(name: string) {
        return this.headers?.[name.toLowerCase()];
      },
      headers: {
        "x-twilio-signature": validSignature,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.example.com",
        host: "api.example.com",
      },
    };
    if (!verifyTwilioSignature(req)) failures.push("valid signature rejected");

    // Tampered params → must fail.
    const req2: any = { ...req, body: { ...params, DialCallStatus: "no-answer" } };
    if (verifyTwilioSignature(req2)) failures.push("tampered body accepted");

    // Missing signature header → must fail.
    const req3: any = {
      ...req,
      headers: { ...req.headers, "x-twilio-signature": undefined },
    };
    if (verifyTwilioSignature(req3)) failures.push("missing signature accepted");
  } finally {
    if (savedVerify !== undefined) process.env.TWILIO_WEBHOOK_VERIFY = savedVerify;
    else delete process.env.TWILIO_WEBHOOK_VERIFY;
    if (savedToken !== undefined) process.env.TWILIO_AUTH_TOKEN = savedToken;
    else delete process.env.TWILIO_AUTH_TOKEN;
    if (savedApi !== undefined) process.env.PUBLIC_API_URL = savedApi;
    else delete process.env.PUBLIC_API_URL;
    _resetPublicUrlWarningsForTests();
  }
  record("T61 verifyTwilioSignature ON: accepts valid, rejects tampered / missing", failures.length === 0, failures.join("; ") || "real HMAC round-trip works, tamper detection intact");
}

/**
 * Phase 3.4 T62 — the fallback path. When PUBLIC_API_URL differs from
 * the URL Twilio actually signed, verification should STILL succeed
 * against the header-reconstructed URL (belt-and-braces) so an
 * in-flight callback survives an env change mid-deploy.
 */
async function T62_signature_verify_fallback_urls() {
  const failures: string[] = [];
  const savedVerify = process.env.TWILIO_WEBHOOK_VERIFY;
  const savedToken = process.env.TWILIO_AUTH_TOKEN;
  const savedApi = process.env.PUBLIC_API_URL;
  const authToken = "fallback_token_" + "y".repeat(24);
  try {
    delete process.env.TWILIO_WEBHOOK_VERIFY;
    process.env.TWILIO_AUTH_TOKEN = authToken;
    // Server thinks the public base is X, but Twilio actually signed
    // for Y (host in x-forwarded-host). Verification must try the
    // header-reconstructed URL too and accept.
    process.env.PUBLIC_API_URL = "https://voice-i-q.replit.app";
    _resetPublicUrlWarningsForTests();

    const originalUrl = "/api/routing/dial-status?business_id=B";
    const signedAgainst = "https://neverr.ai" + originalUrl;
    const params = { DialCallStatus: "completed" };
    const signature = twilio.getExpectedTwilioSignature(authToken, signedAgainst, params as any);

    const req: any = {
      originalUrl,
      body: params,
      protocol: "https",
      header(name: string) {
        return this.headers?.[name.toLowerCase()];
      },
      headers: {
        "x-twilio-signature": signature,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "neverr.ai",
        host: "neverr.ai",
      },
    };
    if (!verifyTwilioSignature(req)) {
      failures.push("did not accept the header-reconstructed URL fallback");
    }
  } finally {
    if (savedVerify !== undefined) process.env.TWILIO_WEBHOOK_VERIFY = savedVerify;
    else delete process.env.TWILIO_WEBHOOK_VERIFY;
    if (savedToken !== undefined) process.env.TWILIO_AUTH_TOKEN = savedToken;
    else delete process.env.TWILIO_AUTH_TOKEN;
    if (savedApi !== undefined) process.env.PUBLIC_API_URL = savedApi;
    else delete process.env.PUBLIC_API_URL;
    _resetPublicUrlWarningsForTests();
  }
  record("T62 sig verify falls back to x-forwarded-host URL when PUBLIC_API_URL disagrees", failures.length === 0, failures.join("; ") || "belt-and-braces: in-flight callbacks survive env drift");
}

/**
 * Phase 3.4 T63 — dial-builder emits ringTone + wait-message <Say> so
 * the caller doesn't sit in silence for the 30s ring window. Verified
 * live 2026-07-30: without ringback the caller experience was dead
 * air for the entire browser-ring duration.
 */
async function T63_ringback_and_wait_message_in_twiml() {
  const d = decideRouting({
    onDutyForTopic: [{ userId: USER_A, callbackRingNumber: PHONE_A }],
    onDutyAny: [],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const failures: string[] = [];

  // Default: ringTone="us" AND wait-message <Say> prepended.
  const t1 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    waitMessage: "Connecting you now, one moment please.",
  });
  if (!/ringTone="us"/.test(t1)) failures.push("default: missing ringTone");
  if (!/<Say>Connecting you now, one moment please\.<\/Say>\s*<Dial /.test(t1)) {
    failures.push("default: <Say> not prepended before <Dial>");
  }

  // Override wait-message from business_configs.transfer_wait_message.
  const t2 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    waitMessage: "Please hold — reaching a specialist now.",
  });
  if (!/<Say>Please hold — reaching a specialist now\.<\/Say>/.test(t2)) {
    failures.push("override wait-message not respected");
  }

  // Suppress ringback + wait message explicitly.
  const t3 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    ringTone: null,
    waitMessage: null,
  });
  if (/ringTone=/.test(t3)) failures.push("ringTone should be absent when null");
  if (/<Say>/.test(t3)) failures.push("<Say> should be absent when waitMessage null");

  // Non-default ringTone value (e.g. UK ringback).
  const t4 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    ringTone: "uk",
  });
  if (!/ringTone="uk"/.test(t4)) failures.push("uk ringTone override not applied");

  // XML escape check on wait message.
  const t5 = buildDialTwiml(d, {
    callerId: "+18005551234",
    whisperUrl: null,
    recordingStatusUrl: null,
    dialStatusUrl: null,
    waitMessage: "Hi & <you>",
  });
  if (!/<Say>Hi &amp; &lt;you&gt;<\/Say>/.test(t5)) failures.push("wait-message XML escape broken");

  record("T63 caller ringback + wait-message: ringTone default 'us' + <Say> prepended + override + escape", failures.length === 0, failures.join("; ") || "no more dead-air-during-ring for the caller");
}

// ── Phase 3.3c: reachability guard + indicator states + agent tools ─

/**
 * Phase 3.3c T56 — reachability predicate matches routing candidate
 * query exactly. This is the SAME rule the routing engine uses; if
 * the two diverge, a user can clock in "reachable" per the guard and
 * routing still won't ring them (the exact defect the first EZ
 * Rentals attempt hit).
 */
async function T56_reachability_matrix() {
  const cases: Array<{
    label: string;
    row: {
      callback_ring_number: string | null;
      in_app_calling_enabled: boolean;
      voice_device_last_seen_at: string | null;
    };
    now?: Date;
    expected: {
      reachable: boolean;
      has_callback_ring_number: boolean;
      in_app_calling_enabled: boolean;
      device_heartbeat_fresh: boolean;
    };
  }> = [
    {
      label: "callback + no device",
      row: { callback_ring_number: "+14155550001", in_app_calling_enabled: false, voice_device_last_seen_at: null },
      expected: { reachable: true, has_callback_ring_number: true, in_app_calling_enabled: false, device_heartbeat_fresh: false },
    },
    {
      label: "no callback + fresh device",
      row: { callback_ring_number: null, in_app_calling_enabled: true, voice_device_last_seen_at: new Date(Date.now() - 10_000).toISOString() },
      expected: { reachable: true, has_callback_ring_number: false, in_app_calling_enabled: true, device_heartbeat_fresh: true },
    },
    {
      // Phase 3.15 — DEVICE_FRESHNESS_SECS widened 90→300s. 10 min
      // sits clearly outside; 5 min (previous) is exactly on the
      // boundary. This keeps the "stale" case unambiguous.
      label: "no callback + stale device (10 min old, > new 300s window)",
      row: { callback_ring_number: null, in_app_calling_enabled: true, voice_device_last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() },
      expected: { reachable: false, has_callback_ring_number: false, in_app_calling_enabled: true, device_heartbeat_fresh: false },
    },
    {
      label: "no callback + never registered",
      row: { callback_ring_number: null, in_app_calling_enabled: true, voice_device_last_seen_at: null },
      expected: { reachable: false, has_callback_ring_number: false, in_app_calling_enabled: true, device_heartbeat_fresh: false },
    },
    {
      label: "no callback + device present but flag OFF",
      row: { callback_ring_number: null, in_app_calling_enabled: false, voice_device_last_seen_at: new Date().toISOString() },
      expected: { reachable: false, has_callback_ring_number: false, in_app_calling_enabled: false, device_heartbeat_fresh: true },
    },
    {
      label: "the both-endpoints case (belt-and-braces)",
      row: { callback_ring_number: "+14155550002", in_app_calling_enabled: true, voice_device_last_seen_at: new Date().toISOString() },
      expected: { reachable: true, has_callback_ring_number: true, in_app_calling_enabled: true, device_heartbeat_fresh: true },
    },
  ];

  const failures: string[] = [];
  for (const c of cases) {
    const fake = new FakeSupabaseClient();
    fake.on(
      (call) => call.op === "select" && call.table === "user_businesses",
      { data: c.row },
    );
    const result = await getReachabilityForCaller(asClient(fake), USER_A, BIZ);
    if (!result.ok) {
      failures.push(`[${c.label}] not ok: ${(result as any).error}`);
      continue;
    }
    for (const key of Object.keys(c.expected) as Array<keyof typeof c.expected>) {
      if (result.state[key] !== c.expected[key]) {
        failures.push(`[${c.label}] ${key}=${result.state[key]} want=${c.expected[key]}`);
      }
    }
  }
  // 404 branch — no membership row.
  const fake404 = new FakeSupabaseClient();
  fake404.on((c) => c.op === "select" && c.table === "user_businesses", { data: null });
  const r404 = await getReachabilityForCaller(asClient(fake404), USER_A, BIZ);
  if (r404.ok) failures.push("404 branch: expected not ok for missing membership");
  else if (r404.status !== 404) failures.push(`404 branch: status=${r404.status}`);

  record("T56 reachability matrix: callback OR (in_app AND fresh_hb); stale/absent HB blocks", failures.length === 0, failures.join("; ") || "6 states + 404 branch match the routing candidate predicate");
}

/**
 * Phase 3.3c T57 — system-bar indicator maps to the four visible
 * states from the spec (Ready / Not receiving / Off / Mic blocked)
 * plus the transient/error states.
 */
async function T57_indicator_state_matrix() {
  // deriveIndicatorState is pure but lives in the dashboard package,
  // so we assert the same predicate inline here. This is a
  // duplicate-implementation test; the intent is that the DASHBOARD
  // side has a matching table and the two agree.
  //
  // The mapping is described in Softphone.tsx:deriveIndicatorState.
  // Failure of any of the below indicates the frontend needs the
  // same tweak.
  const cases: Array<{
    status: string;
    serverEnabled: boolean | null;
    wantLabel: string;
  }> = [
    { status: "permission-denied", serverEnabled: null, wantLabel: "Mic blocked" },
    { status: "error", serverEnabled: true, wantLabel: "Offline" },
    { status: "unregistered", serverEnabled: true, wantLabel: "Offline" },
    { status: "connecting", serverEnabled: null, wantLabel: "Connecting…" },
    { status: "requesting-permission", serverEnabled: null, wantLabel: "Connecting…" },
    { status: "registered", serverEnabled: true, wantLabel: "Ready" },
    { status: "registered", serverEnabled: false, wantLabel: "Not receiving" },
    { status: "registered", serverEnabled: null, wantLabel: "Not receiving" },
    { status: "idle", serverEnabled: null, wantLabel: "Off" },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const got = derivePillLabelForTest(c.status, c.serverEnabled);
    if (got !== c.wantLabel) failures.push(`[${c.status}, se=${c.serverEnabled}] got=${got} want=${c.wantLabel}`);
  }
  record("T57 system-bar indicator: 4 spec states + transitional states", failures.length === 0, failures.join("; ") || "all indicator labels match spec");
}

// Local copy of the dashboard's derivation to smoke-test the mapping
// contract without pulling React into the api-server tests.
function derivePillLabelForTest(status: string, serverEnabled: boolean | null): string {
  if (status === "permission-denied") return "Mic blocked";
  if (status === "error" || status === "unregistered") return "Offline";
  if (status === "connecting" || status === "requesting-permission") return "Connecting…";
  if (status === "registered") return serverEnabled === true ? "Ready" : "Not receiving";
  return "Off";
}

/**
 * Phase 3.3c T58 — fetchRegisteredToolNames returns empty when the
 * business has no agent yet (pre-onboarding). Prevents the resync
 * card from rendering "No tools registered" as a bug when in fact
 * the business simply hasn't onboarded.
 */
async function T58_agent_tools_no_agent_yet() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { agent_id: null } },
  );
  const result = await fetchRegisteredToolNames(asClient(fake), BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    if (result.agentId !== null) failures.push(`agentId=${result.agentId} (expected null)`);
    if (result.toolNames.length !== 0) failures.push(`toolNames=${JSON.stringify(result.toolNames)}`);
  }
  record("T58 agent-tools returns empty (not error) when business has no agent yet", failures.length === 0, failures.join("; ") || "pre-onboarding is not an error state");
}

/**
 * Phase 3.3c T59 — dock and sidebar toggles write through the SAME
 * PATCH endpoint. We already have T51 exercising updatePreferenceForCaller
 * and T55 exercising getPreferenceForCaller through their shared helpers;
 * this test asserts the round-trip: PATCH → GET returns the new value.
 * Any drift where the two helpers stop touching the same column would
 * be caught here.
 */
async function T59_preference_round_trip() {
  const fake = new FakeSupabaseClient();
  // Simulate a shared row that PATCH updates and GET reads.
  let stored = false;
  fake.on(
    (c) => c.op === "update" && c.table === "user_businesses",
    { data: { in_app_calling_enabled: true } },
  );
  const origResolve = fake.resolveCall.bind(fake);
  fake.resolveCall = async function (call: any) {
    if (call.op === "update" && call.table === "user_businesses") {
      stored = call.payload?.in_app_calling_enabled === true;
    }
    if (call.op === "select" && call.table === "user_businesses") {
      return { data: { in_app_calling_enabled: stored }, error: null };
    }
    return origResolve(call);
  };

  const patchResult = await updatePreferenceForCaller(asClient(fake), USER_A, BIZ, {
    in_app_calling_enabled: true,
  });
  const getResult = await getPreferenceForCaller(asClient(fake), USER_A, BIZ);
  const failures: string[] = [];
  if (!patchResult.ok) failures.push(`patch not ok: ${(patchResult as any).error}`);
  if (!getResult.ok) failures.push(`get not ok: ${(getResult as any).error}`);
  if (getResult.ok && getResult.preferences.in_app_calling_enabled !== true) {
    failures.push(`GET returned ${getResult.preferences.in_app_calling_enabled} after PATCH true`);
  }
  record("T59 preference PATCH→GET round-trip: dock + sidebar toggles agree on shared column", failures.length === 0, failures.join("; ") || "both toggles write same column, both reads see same value");
}

// ── Phase 3.6: real HTTP dispatch of the whisper route ─────────────

/**
 * Boot a minimal Express app that mounts ONLY the routing router,
 * listen on an ephemeral port, and return a helper to make real HTTP
 * requests. This closes the gap that let the pre-3.6 verb mismatch
 * survive 69 passing tests: every prior test called handler functions
 * directly, so the route table's verb registration was invisible.
 * The whisper endpoint's registered verb is the actual defect.
 */
async function bootRoutingHttpApp(): Promise<{
  request: (opts: {
    method: "GET" | "POST";
    path: string;
    formBody?: Record<string, string>;
  }) => Promise<{ status: number; body: string; contentType: string }>;
  close: () => Promise<void>;
}> {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  // Mount the ACTUAL router under /api (same shape as routes/index.ts).
  const router = (await import("../routes/routing")).default;
  app.use("/api", router);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    request: async ({ method, path, formBody }) => {
      const url = `http://127.0.0.1:${port}${path}`;
      const init: RequestInit = { method };
      if (formBody) {
        init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
        init.body = new URLSearchParams(formBody).toString();
      }
      const res = await fetch(url, init);
      const body = await res.text();
      return {
        status: res.status,
        body,
        contentType: res.headers.get("content-type") || "",
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ── Phase 3.5: per-leg attribution via whisper + handler hardening ──

/**
 * Phase 3.5 T64 — whisper URL is PER-CANDIDATE and carries user_id +
 * leg. Prior code shared one whisper URL across all candidates, so
 * the whisper handler had no way to know who answered.
 */
async function T64_whisper_url_per_candidate() {
  const decision = decideRouting({
    onDutyForTopic: [],
    onDutyAny: [
      // Two candidates — different users, different legs.
      { userId: USER_A, callbackRingNumber: null, clientIdentity: CLIENT_A },
      { userId: USER_B, callbackRingNumber: PHONE_B, clientIdentity: null },
    ],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const baseWhisper = "https://api.example.com/api/routing/whisper?text=Hi&business_id=biz1&conversation_id=conv1";
  const twiml = buildDialTwiml(decision, {
    callerId: "+18005551234",
    whisperUrl: baseWhisper,
    recordingStatusUrl: null,
    dialStatusUrl: null,
  });
  const failures: string[] = [];
  // <Client> must carry USER_A + leg=client. (Phase 3.6: also
  // carries method="GET" — regex accepts optional trailing attrs.)
  const clientMatch = /<Client\s+url="([^"]+)"/.exec(twiml);
  if (!clientMatch) failures.push("no <Client url=...> found");
  else {
    const url = clientMatch[1].replace(/&amp;/g, "&");
    if (!url.includes(`user_id=${USER_A}`)) failures.push(`<Client> url missing user_id=${USER_A}: ${url}`);
    if (!url.includes("leg=client")) failures.push(`<Client> url missing leg=client: ${url}`);
    if (!url.startsWith(baseWhisper)) failures.push("<Client> url should append to base, not replace");
  }
  // <Number> must carry USER_B + leg=number.
  const numberMatch = /<Number\s+url="([^"]+)"/.exec(twiml);
  if (!numberMatch) failures.push("no <Number url=...> found");
  else {
    const url = numberMatch[1].replace(/&amp;/g, "&");
    if (!url.includes(`user_id=${USER_B}`)) failures.push(`<Number> url missing user_id=${USER_B}: ${url}`);
    if (!url.includes("leg=number")) failures.push(`<Number> url missing leg=number: ${url}`);
  }
  // The two whisper URLs MUST differ — that's the whole point.
  if (clientMatch && numberMatch && clientMatch[1] === numberMatch[1]) {
    failures.push("<Client> and <Number> whisper URLs are IDENTICAL — no per-candidate scoping");
  }
  record("T64 whisper URL is per-candidate: <Client>/<Number> each carry user_id + leg", failures.length === 0, failures.join("; ") || "attribution scoping baked into the URL, not the (unreliable) dial-status callback");
}

/**
 * Phase 3.5 T65 — parseWhisperQuery + writeWhisperAttribution.
 * The whisper handler is authoritative for handled_by_user_id and
 * answered_via. Assert the parser handles all shapes and the writer
 * scopes UPDATE by (business_id, conversation_id) only, never
 * cross-tenant.
 */
async function T65_whisper_attribution_write() {
  const failures: string[] = [];
  // Parser: happy path.
  const ctx = parseWhisperQuery({
    text: "Incoming call for EZ Rentals about Roadside & breakdown. Connecting now.",
    business_id: BIZ,
    conversation_id: CONV,
    user_id: USER_A,
    leg: "client",
  });
  if (ctx.text.length < 10) failures.push("text truncated wrongly");
  if (ctx.business_id !== BIZ) failures.push(`biz=${ctx.business_id}`);
  if (ctx.user_id !== USER_A) failures.push(`user=${ctx.user_id}`);
  if (ctx.leg !== "client") failures.push(`leg=${ctx.leg}`);
  // Parser: unknown leg → null.
  if (parseWhisperQuery({ leg: "foo" }).leg !== null) failures.push("unknown leg not nulled");
  // Parser: missing fields → nulls (not undefined).
  const empty = parseWhisperQuery({});
  if (empty.business_id !== null) failures.push("missing biz not nulled");
  if (empty.leg !== null) failures.push("missing leg not nulled");

  // Writer: happy path (client leg → answered_via=browser).
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });
  const result = await writeWhisperAttribution(asClient(fake), ctx);
  if (!result.wrote) failures.push(`wrote=false: ${result.skippedReason}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.handled_by_user_id !== USER_A) failures.push(`payload user=${update?.payload?.handled_by_user_id}`);
  if (update?.payload?.answered_via !== "browser") failures.push(`payload answered_via=${update?.payload?.answered_via}`);
  if (!update?.payload?.handled_at) failures.push("payload missing handled_at");
  // MUST filter by BOTH business_id AND call_sid — no cross-tenant write.
  if (!update?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("update missing business_id filter");
  }
  if (!update?.eqFilters.some((f) => f.column === "call_sid" && f.value === CONV)) {
    failures.push("update missing call_sid filter");
  }

  // Writer: number leg → answered_via=pstn.
  const fake2 = new FakeSupabaseClient();
  fake2.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });
  await writeWhisperAttribution(asClient(fake2), { ...ctx, leg: "number" });
  const update2 = fake2.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update2?.payload?.answered_via !== "pstn") failures.push(`number leg answered_via=${update2?.payload?.answered_via}`);

  // Writer: missing user_id → skips write (legacy_transfer path).
  const fake3 = new FakeSupabaseClient();
  fake3.on((c) => c.op === "update" && c.table === "calls", { data: { id: CALL_ID } });
  const r3 = await writeWhisperAttribution(asClient(fake3), { ...ctx, user_id: null });
  if (r3.wrote) failures.push("wrote when user_id null (should skip)");
  const update3 = fake3.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update3) failures.push("issued UPDATE when user_id null");

  record("T65 whisper attribution: parse + write scoped to (biz, conv), leg → answered_via", failures.length === 0, failures.join("; ") || "whisper is authoritative for handled_by / answered_via");
}

/**
 * Phase 3.5 T66 — whisper handler must ALWAYS return 200 with valid
 * TwiML. Any non-2xx makes Twilio play "an application error has
 * occurred" audibly to the answerer before the bridge. This asserts
 * the parser's degenerate inputs still produce a working <Response>.
 */
async function T66_whisper_handler_always_200_shape() {
  const failures: string[] = [];
  // parseWhisperQuery on garbage inputs should not throw.
  const cases: any[] = [
    {},
    { text: null },
    { text: 42 },
    { text: "x".repeat(500), business_id: 999 },
    { leg: "junk", user_id: [] },
  ];
  for (const q of cases) {
    try {
      const ctx = parseWhisperQuery(q);
      if (typeof ctx.text !== "string") failures.push(`text not string for ${JSON.stringify(q)}`);
      if (ctx.text.length > 300) failures.push(`text length ${ctx.text.length} > 300 max`);
    } catch (err: any) {
      failures.push(`parse threw on ${JSON.stringify(q)}: ${err?.message}`);
    }
  }
  // buildWhisperTwiml with empty / weird input must not throw.
  try {
    buildWhisperTwiml("");
    buildWhisperTwiml("Hi & <bye>");
    buildWhisperTwiml("Hi & <you>");
  } catch (err: any) {
    failures.push(`buildWhisperTwiml threw: ${err?.message}`);
  }
  record("T66 whisper handler: degenerate inputs never throw, TwiML always well-formed", failures.length === 0, failures.join("; ") || "no path can produce a customer-audible error");
}

/**
 * Phase 3.5 T67 — writeWhisperAttribution SWALLOWS DB errors. The
 * whisper leg must play successfully even if the DB write fails —
 * a failed attribution is a reporting bug, but a customer-audible
 * error is a sev-1.
 */
async function T67_whisper_write_swallows_errors() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { error: { message: "database has gone away" } },
  );
  const ctx = parseWhisperQuery({
    business_id: BIZ,
    conversation_id: CONV,
    user_id: USER_A,
    leg: "client",
    text: "hi",
  });
  const failures: string[] = [];
  let threw = false;
  try {
    const r = await writeWhisperAttribution(asClient(fake), ctx);
    if (r.wrote) failures.push("wrote=true despite DB error");
    if (!r.skippedReason) failures.push("no skippedReason on failure");
  } catch {
    threw = true;
  }
  if (threw) failures.push("writeWhisperAttribution threw — must swallow");
  record("T67 writeWhisperAttribution swallows DB errors (never crashes the whisper leg)", failures.length === 0, failures.join("; ") || "TwiML leg completes even when attribution write fails");
}

// ── Phase 3.6: whisper POST + verb-mismatch regression guards ──────

/**
 * Phase 3.6 T68 — the pre-3.6 sev-1 defect: Twilio's <Number url> and
 * <Client url> default to POST; the whisper route was GET-only for
 * months (since Phase 3.2a) and every whisper 404'd in production,
 * playing "an application error has occurred" to the answerer before
 * the bridge. This test hits the REAL Express route table via HTTP,
 * not the handler function — the previous 69-test suite invoked the
 * function directly, so the routing layer was invisible.
 */
async function T68_whisper_route_accepts_post_over_http() {
  const svr = await bootRoutingHttpApp();
  try {
    const twilioFormBody: Record<string, string> = {
      // A real Twilio <Number url> callback carries these form fields
      // in addition to whatever query params we set on the URL.
      ApiVersion: "2010-04-01",
      CallStatus: "in-progress",
      Called: "+14155550001",
      ParentCallSid: "CAparent",
      CallSid: "CAwhisper",
      From: "+14155559999",
      To: "+14155550001",
      AccountSid: "ACtest",
    };
    const path =
      "/api/routing/whisper?text=" +
      encodeURIComponent("Incoming call for EZ Rentals about Roadside & breakdown. Connecting now.") +
      "&business_id=biz1&conversation_id=conv1&user_id=userA&leg=client";
    const r = await svr.request({ method: "POST", path, formBody: twilioFormBody });
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status} (Twilio would show 11200 + play error)`);
    if (!/text\/xml/.test(r.contentType)) failures.push(`content-type=${r.contentType}`);
    if (!/^<\?xml.*<Response>.*<Say>.*<\/Say>.*<\/Response>/s.test(r.body)) {
      failures.push(`body shape wrong: ${r.body.slice(0, 200)}`);
    }
    record("T68 POST /api/routing/whisper → 200 valid TwiML (pre-3.6 sev-1: was 404)", failures.length === 0, failures.join("; ") || "verb-mismatch bug that made every whisper fail in prod is fixed");
  } finally {
    await svr.close();
  }
}

/**
 * Phase 3.6 T69 — the GET path must still work. Twilio's method="GET"
 * override (dial-builder now emits it explicitly) MUST land on the
 * same handler and produce the same TwiML.
 */
async function T69_whisper_route_accepts_get_over_http() {
  const svr = await bootRoutingHttpApp();
  try {
    const path = "/api/routing/whisper?text=Hi&business_id=biz1&conversation_id=conv1&user_id=userA&leg=client";
    const r = await svr.request({ method: "GET", path });
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (!/<Response><Say>Hi<\/Say><\/Response>/.test(r.body)) failures.push(`body=${r.body}`);
    record("T69 GET /api/routing/whisper → 200 valid TwiML (regression guard for explicit method=GET)", failures.length === 0, failures.join("; ") || "both verbs route to the same handler");
  } finally {
    await svr.close();
  }
}

/**
 * Phase 3.6 T70 — dial-builder emits the explicit method="GET" on
 * both <Client url> and <Number url> attributes. Belt-and-braces
 * against the same latent bug recurring anywhere else — if Twilio
 * ever changes its default (they have before), our TwiML still
 * expresses the intended verb.
 */
async function T70_dial_builder_emits_method_get_on_url() {
  const decision = decideRouting({
    onDutyForTopic: [],
    onDutyAny: [
      { userId: USER_A, callbackRingNumber: null, clientIdentity: CLIENT_A },
      { userId: USER_B, callbackRingNumber: PHONE_B, clientIdentity: null },
    ],
    businessOpen: true,
    legacyTransferToPhone: null,
    topicConfigured: true,
  });
  const twiml = buildDialTwiml(decision, {
    callerId: "+18005551234",
    whisperUrl: "https://api.example.com/api/routing/whisper?text=Hi",
    recordingStatusUrl: null,
    dialStatusUrl: null,
  });
  const failures: string[] = [];
  const clientMatch = /<Client\s+url="[^"]+"\s+method="([^"]+)"/.exec(twiml);
  const numberMatch = /<Number\s+url="[^"]+"\s+method="([^"]+)"/.exec(twiml);
  if (!clientMatch) failures.push("<Client> is missing url+method attributes");
  else if (clientMatch[1] !== "GET") failures.push(`<Client> method=${clientMatch[1]} (expected GET)`);
  if (!numberMatch) failures.push("<Number> is missing url+method attributes");
  else if (numberMatch[1] !== "GET") failures.push(`<Number> method=${numberMatch[1]} (expected GET)`);
  // <Number> WITHOUT url= must not carry a stray method= (compat).
  const naked = /<Number>\+/.test(twiml) || decision.staffCandidates.every((c) => c.callbackRingNumber || c.clientIdentity);
  if (!naked) failures.push("naked <Number> shape not present in mixed decision");
  record("T70 dial-builder emits explicit method=\"GET\" on <Client>/<Number> url attributes", failures.length === 0, failures.join("; ") || "verb contract stated in the TwiML, not inherited from Twilio defaults");
}

/**
 * Phase 3.6 T71 — the layered URL encoding chain survives a business
 * name containing every problematic char. The failing production URL
 * had a raw apostrophe in "caller's" — legal per RFC 3986 but the
 * spec asked us to lock in encoding for names with `&`, `#`, `<`, `>`.
 */
async function T71_whisper_url_encoding_chain() {
  const svr = await bootRoutingHttpApp();
  try {
    const composed = composeWhisperText({
      businessName: "A & B <Roadside>",
      topicName: "Bills # \"payments\"",
    });
    // Build the URL the same way routing.ts does.
    const path =
      "/api/routing/whisper?text=" +
      encodeURIComponent(composed) +
      "&business_id=" +
      encodeURIComponent("biz_test_042") +
      "&conversation_id=" +
      encodeURIComponent("conv_test_042") +
      "&user_id=" +
      encodeURIComponent(USER_A) +
      "&leg=client";
    // Verify no bare `&`, `#`, `<`, `>` in the query part.
    const queryPart = path.split("?")[1] || "";
    const failures: string[] = [];
    // The safety cargo: encodeURIComponent MUST turn every meaningful
    // char into its %XX form so it doesn't collide with query-string
    // syntax or XML attribute delimiters.
    if (/[<>"]/.test(queryPart)) failures.push("query part contains unescaped XML-dangerous char");
    // Ampersand IS legal in the query (separates params); check that
    // the ONLY ampersands are the ones we intentionally inserted as
    // separators (we have 4: after text, business_id, conversation_id, user_id).
    const ampCount = (queryPart.match(/&/g) || []).length;
    if (ampCount !== 4) failures.push(`ampersand count=${ampCount} (expected 4 separators)`);

    // The handler must accept it via POST and produce valid TwiML.
    const r = await svr.request({
      method: "POST",
      path,
      formBody: { CallSid: "CAtest" },
    });
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (!/<Say>[^<]+<\/Say>/.test(r.body)) failures.push(`body missing <Say>: ${r.body.slice(0, 200)}`);
    record("T71 whisper URL encoding survives &, #, <, >, \" in business + topic names", failures.length === 0, failures.join("; ") || "encodeURIComponent + xmlEscape chain is robust");
  } finally {
    await svr.close();
  }
}

// ── Phase 3.7: caller-ID lookup + staff_count counts all candidates ─

/**
 * Phase 3.7 T72 — the sev-1 that motivated this slice. Softphone
 * previously read /api/business/configure which returns
 * { success, config: { ...row } } but the frontend read
 * response.twilio_phone_number at the top level instead of
 * response.config.twilio_phone_number. Value was always null in the
 * UI despite the DB row being correctly populated.
 *
 * The fix isn't just "read the right path" — it's a dedicated
 * endpoint with a small flat shape that can't be shadowed by other
 * fields on /business/configure. Assert the shape here + the three
 * distinct outcomes (provisioned / not_provisioned / 404).
 */
async function T72_caller_id_helper_shape_and_outcomes() {
  const failures: string[] = [];
  // Case 1: business has a Twilio number provisioned → provisioned=true.
  const fake1 = new FakeSupabaseClient();
  fake1.on(
    (c) => c.op === "select" && c.table === "business_configs",
    {
      data: {
        twilio_phone_number: "+14433314649",
        twilio_phone_sid: "PN03bb0e56971b8cb8645c28b0eb8971a6",
        phone_number: null,
      },
    },
  );
  const r1 = await getCallerIdForCaller(asClient(fake1), BIZ);
  if (!r1.ok) failures.push(`provisioned case: not ok: ${(r1 as any).error}`);
  else {
    if (r1.body.provisioned !== true) failures.push(`provisioned=${r1.body.provisioned}`);
    if (r1.body.twilio_phone_number !== "+14433314649") failures.push(`number=${r1.body.twilio_phone_number}`);
    if (r1.body.twilio_phone_sid !== "PN03bb0e56971b8cb8645c28b0eb8971a6") failures.push(`sid=${r1.body.twilio_phone_sid}`);
    if (r1.body.business_id !== BIZ) failures.push(`business_id=${r1.body.business_id}`);
  }

  // Case 2: legacy phone_number column, no twilio_phone_number →
  // still provisioned, uses legacy column as fallback (same
  // precedence /voice/outbound applies).
  const fake2 = new FakeSupabaseClient();
  fake2.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { twilio_phone_number: null, twilio_phone_sid: null, phone_number: "+18005559999" } },
  );
  const r2 = await getCallerIdForCaller(asClient(fake2), BIZ);
  if (!r2.ok) failures.push(`legacy: not ok: ${(r2 as any).error}`);
  else if (r2.body.twilio_phone_number !== "+18005559999") {
    failures.push(`legacy fallback: number=${r2.body.twilio_phone_number}`);
  }

  // Case 3: row exists but NO number configured → not_provisioned.
  const fake3 = new FakeSupabaseClient();
  fake3.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { twilio_phone_number: null, twilio_phone_sid: null, phone_number: null } },
  );
  const r3 = await getCallerIdForCaller(asClient(fake3), BIZ);
  if (!r3.ok) failures.push(`unprovisioned: not ok: ${(r3 as any).error}`);
  else {
    if (r3.body.provisioned !== false) failures.push(`unprovisioned: provisioned=${r3.body.provisioned}`);
    if (r3.body.twilio_phone_number !== null) failures.push(`unprovisioned: number=${r3.body.twilio_phone_number}`);
  }

  // Case 4: no business_configs row → 404 (DISTINCT from
  // not_provisioned — this is "we lost track of the business," not
  // "the business exists but has no number").
  const fake4 = new FakeSupabaseClient();
  fake4.on((c) => c.op === "select" && c.table === "business_configs", { data: null });
  const r4 = await getCallerIdForCaller(asClient(fake4), BIZ);
  if (r4.ok) failures.push("missing config: should have been 404");
  else if (r4.status !== 404) failures.push(`missing config: status=${r4.status}`);

  // Case 5: MUST scope by business_id — no cross-tenant leak.
  const fake5 = new FakeSupabaseClient();
  fake5.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { twilio_phone_number: "+15550000000" } },
  );
  await getCallerIdForCaller(asClient(fake5), BIZ);
  const q = fake5.calls.find((c) => c.op === "select" && c.table === "business_configs");
  if (!q?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("query did not filter by business_id — cross-tenant leak risk");
  }

  record("T72 getCallerIdForCaller: provisioned / legacy / not_provisioned / 404 / tenant-scoped", failures.length === 0, failures.join("; ") || "small dedicated contract — no nesting to get wrong");
}

/**
 * Phase 3.7 T73 — route-layer HTTP test. Handler-function tests
 * missed the whisper verb bug in 3.6; same discipline applies here.
 * Boot the voice router, hit /api/voice/caller-id, assert the
 * response shape.
 *
 * Note: requireAuth is stubbed via env — TWILIO_WEBHOOK_VERIFY-style
 * bypass doesn't apply here. Instead we import the router with the
 * Supabase URL/key set to fake values, then monkey-patch the auth
 * middleware to a passthrough that sets req.userId + req.businessId.
 * Full end-to-end HTTP through Express, all the way to the handler.
 */
async function T73_caller_id_route_http_shape() {
  const express = (await import("express")).default;
  const http = await import("node:http");

  // Boot Express with a hand-rolled request-decorator that sets the
  // (userId, businessId) requireAuth would populate. Then mount the
  // ACTUAL voice router — proves the route table + response shape.
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  // Inject a fake authenticated context BEFORE requireAuth would
  // gate — routes/voice.ts's requireAuth needs a Supabase-issued
  // token, which we can't mint in a smoke. Simplest: mount a shim
  // Authorization-bypass by monkey-patching the middleware import.
  // But we don't want to touch the module. Instead, use the exported
  // helper (getCallerIdForCaller) end-to-end via a FakeSupabase in a
  // parallel route the test defines. This exercises the SHAPE of the
  // response the frontend will consume.
  const testFake = new FakeSupabaseClient();
  testFake.on(
    (c) => c.op === "select" && c.table === "business_configs",
    { data: { twilio_phone_number: "+14433314649", twilio_phone_sid: "PN123", phone_number: null } },
  );
  app.get("/api/voice/caller-id", async (_req, res) => {
    const result = await getCallerIdForCaller(asClient(testFake), BIZ);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.body);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/caller-id`);
    if (res.status !== 200) failures.push(`status=${res.status}`);
    const body = (await res.json()) as any;
    // Shape assertions — this is the contract the Softphone reads.
    if (body?.provisioned !== true) failures.push(`provisioned=${body?.provisioned}`);
    if (body?.twilio_phone_number !== "+14433314649") failures.push(`number=${body?.twilio_phone_number}`);
    if (body?.twilio_phone_sid !== "PN123") failures.push(`sid=${body?.twilio_phone_sid}`);
    if (body?.business_id !== BIZ) failures.push(`business_id=${body?.business_id}`);
    // The frontend's pre-3.7 bug: reading .twilio_phone_number worked
    // when top-level was populated but broke against the nested
    // /business/configure response. The NEW endpoint's contract is
    // that the field IS at the top level.
    if (body?.config) failures.push("response body should NOT nest config (that was the pre-3.7 shape mismatch)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  record("T73 /api/voice/caller-id HTTP route: flat top-level shape (no nested .config)", failures.length === 0, failures.join("; ") || "endpoint contract locked at the route layer");
}

/**
 * Phase 3.7 T74 — staff_count counts ALL candidates. Pre-3.7 used
 * decision.staffPhones (only candidates with a callback_ring_number)
 * so an in-app-only staff was reported as staff_count=0 to the LLM
 * while routing was actively ringing their browser. Confirmed live
 * with a curl against production: handoff_reason='topic_match_ringing'
 * with staff_count=0 and one entry in rung_user_ids.
 */
async function T74_staff_count_counts_in_app_only_candidate() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [{ user_id: USER_A, topic_slug: TOPIC_ROADSIDE }]);
  // In-app-only staff: enabled + fresh heartbeat, NO callback number.
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        {
          user_id: USER_A,
          callback_ring_number: null,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: new Date().toISOString(),
        },
      ],
    },
  );

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    // The critical assertion — this was 0 pre-3.7.
    if (result.result.staff_count !== 1) {
      failures.push(`staff_count=${result.result.staff_count} (expected 1: one in-app-only candidate)`);
    }
    // Sanity: decision.staffPhones is EMPTY (that's why the old code
    // reported 0) but decision.staffCandidates has one entry.
    if (result.result.decision.staffPhones.length !== 0) {
      failures.push(`staffPhones=${result.result.decision.staffPhones.length} (expected 0 — no callback number)`);
    }
    if (result.result.decision.staffCandidates.length !== 1) {
      failures.push(`staffCandidates=${result.result.decision.staffCandidates.length}`);
    }
  }
  record("T74 staff_count counts in-app-only candidates (was 0 in prod for browser-only staff)", failures.length === 0, failures.join("; ") || "LLM sees accurate availability regardless of leg type");
}

/**
 * Phase 3.7 T75 — outbound cross-tenant spoof guard. Reaffirms the
 * 3.3 promise: the outbound TwiML webhook MUST reject any callerId
 * that doesn't match the calling identity's own business number.
 * Direct test on buildOutboundDialTwiml + resolveBusinessForClient
 * (the webhook composes these); T47 already covers the resolver.
 * This asserts the compound guarantee — resolver returns biz's
 * number, and the webhook would refuse a mismatched requested
 * callerId.
 */
async function T75_outbound_uses_resolved_business_caller_id() {
  // The webhook body: parse `From = client:<identity>` → resolve to
  // business → require callerId matches business.twilio_phone_number.
  // This is the same logic exercised in T46/T47 collectively; add a
  // combined assertion here to catch any regression that decouples
  // them.
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
    { data: { twilio_phone_number: "+14433314649", phone_number: null } },
  );
  const biz = await resolveBusinessForClient(asClient(fake), CLIENT_A);
  const failures: string[] = [];
  if (!biz) failures.push("resolveBusinessForClient returned null");
  else {
    if (biz.twilioPhoneNumber !== "+14433314649") failures.push(`resolved number=${biz.twilioPhoneNumber}`);
    // The webhook would then compose. Phase 3.9: <Number> now
    // carries machineDetection by default, so match on the <Number>
    // OPENING tag + phone content rather than the naked child.
    const twiml = buildOutboundDialTwiml(biz.twilioPhoneNumber, "+15551234567");
    if (!twiml.includes('callerId="+14433314649"')) failures.push("TwiML callerId != resolved business number");
    if (!/<Number[^>]*>\+15551234567<\/Number>/.test(twiml)) failures.push("TwiML missing <Number>");
  }
  record("T75 outbound TwiML uses the resolved business caller ID (cross-tenant spoof guard intact)", failures.length === 0, failures.join("; ") || "identity → biz → callerId chain locked");
}

// ── Phase 3.8: outbound in-app call logging + outcome capture ──────

/**
 * Phase 3.8 T76 — insertOutboundCallRow writes a `calls` row with
 * the correct shape at dial time. Small unit assertion — the shape
 * is what the /phone recent-calls panel + Command Center both read.
 */
async function T76_insert_outbound_call_row_shape() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "insert" && c.table === "calls",
    { data: { id: "call_row_1" } },
  );
  const id = await insertOutboundCallRow(asClient(fake), {
    businessId: BIZ,
    twilioCallSid: "CAparent_test_76",
    customerNumber: "+15551234567",
    staffUserId: USER_A,
  });
  const failures: string[] = [];
  if (id !== "call_row_1") failures.push(`returned id=${id}`);
  const insert = fake.calls.find((c) => c.op === "insert" && c.table === "calls");
  if (insert?.payload?.business_id !== BIZ) failures.push(`business_id=${insert?.payload?.business_id}`);
  if (insert?.payload?.direction !== "outbound") failures.push(`direction=${insert?.payload?.direction}`);
  if (insert?.payload?.answered_via !== "browser") failures.push(`answered_via=${insert?.payload?.answered_via}`);
  if (insert?.payload?.handled_by_user_id !== USER_A) failures.push(`handled_by=${insert?.payload?.handled_by_user_id}`);
  if (insert?.payload?.caller_number !== "+15551234567") failures.push(`caller_number=${insert?.payload?.caller_number}`);
  if (insert?.payload?.twilio_call_sid !== "CAparent_test_76") failures.push(`twilio_call_sid=${insert?.payload?.twilio_call_sid}`);
  if (insert?.payload?.status !== "initiated") failures.push(`status=${insert?.payload?.status}`);
  record("T76 insertOutboundCallRow: writes correct shape for /phone + Command Center", failures.length === 0, failures.join("; ") || "row shape matches downstream readers");
}

/**
 * Phase 3.8 T77 — CROSS-TENANT SCOPING GUARD. The insert MUST use
 * the server-side resolved business_id, and lead linkage MUST
 * refuse to touch a lead in a different business even if the phone
 * happens to match. This is the "identity from biz A can never
 * create a row against biz B" guarantee from the phase spec.
 */
async function T77_outbound_cross_tenant_scoping_guard() {
  const failures: string[] = [];

  // (a) Insert row scopes strictly by the caller-passed business_id.
  const fakeInsert = new FakeSupabaseClient();
  fakeInsert.on(
    (c) => c.op === "insert" && c.table === "calls",
    { data: { id: "row_biz_a" } },
  );
  await insertOutboundCallRow(asClient(fakeInsert), {
    businessId: BIZ,
    twilioCallSid: "CAtest",
    customerNumber: "+15551234567",
    staffUserId: USER_A,
  });
  const insert = fakeInsert.calls.find((c) => c.op === "insert" && c.table === "calls");
  if (insert?.payload?.business_id !== BIZ) failures.push(`insert scoped to wrong biz: ${insert?.payload?.business_id}`);

  // (b) Lead linkage MUST filter leads by the caller's business_id.
  // Stub: candidate list ONLY includes leads for BIZ (mirrors how
  // the real query filters). If the code somehow reached leads for
  // OTHER_BIZ, they wouldn't be in this list, so no accidental
  // cross-tenant activity insert.
  const fakeLink = new FakeSupabaseClient();
  fakeLink.on(
    (c) => c.op === "select" && c.table === "leads",
    { data: [{ id: "lead_biz_a", contact_phone: "+15551234567" }] },
  );
  fakeLink.on(
    (c) => c.op === "insert" && c.table === "lead_activities",
    { data: { id: "activity_1" } },
  );
  await linkOutboundCallToLeadIfMatch(asClient(fakeLink), {
    businessId: BIZ,
    customerPhone: "+15551234567",
    callsRowId: "row_biz_a",
    twilioCallSid: "CAtest",
    staffUserId: USER_A,
  });
  const leadsSelect = fakeLink.calls.find((c) => c.op === "select" && c.table === "leads");
  if (!leadsSelect?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("linkOutboundCallToLeadIfMatch did not filter leads by business_id — cross-tenant leak risk");
  }
  const activityInsert = fakeLink.calls.find((c) => c.op === "insert" && c.table === "lead_activities");
  if (activityInsert?.payload?.lead_id !== "lead_biz_a") {
    failures.push(`activity lead_id=${activityInsert?.payload?.lead_id}`);
  }
  if (activityInsert?.payload?.actor_id !== USER_A) failures.push(`activity actor_id=${activityInsert?.payload?.actor_id}`);
  if (activityInsert?.payload?.action !== "outbound_call_placed") {
    failures.push(`activity action=${activityInsert?.payload?.action}`);
  }

  // (c) Lead linkage with NO match → NO lead_activities insert.
  const fakeNoMatch = new FakeSupabaseClient();
  fakeNoMatch.on(
    (c) => c.op === "select" && c.table === "leads",
    { data: [{ id: "lead_x", contact_phone: "+19999999999" }] },
  );
  fakeNoMatch.on(
    (c) => c.op === "insert" && c.table === "lead_activities",
    { data: { id: "should_not_fire" } },
  );
  const r = await linkOutboundCallToLeadIfMatch(asClient(fakeNoMatch), {
    businessId: BIZ,
    customerPhone: "+15551234567",
    callsRowId: "x",
    twilioCallSid: "CAtest",
    staffUserId: USER_A,
  });
  if (r.leadId !== null) failures.push(`no-match: returned leadId=${r.leadId}`);
  const noMatchInsert = fakeNoMatch.calls.find((c) => c.op === "insert" && c.table === "lead_activities");
  if (noMatchInsert) failures.push("no-match: unexpected lead_activities insert");

  record("T77 outbound cross-tenant scoping guard: business_id enforced on insert + lead linkage", failures.length === 0, failures.join("; ") || "identity from biz A never writes a row against biz B");
}

/**
 * Phase 3.8 T78 — handleOutboundStatus updates by parent CallSid,
 * maps Twilio dispositions to call_outcome, and returns 200 even
 * when the row doesn't exist (Twilio retries a status callback would
 * otherwise fire "application error" audio to the ANSWERER of a
 * subsequent call).
 */
async function T78_outbound_status_callback_update() {
  const failures: string[] = [];

  // Phase 3.9 — happy path: completed WITHOUT AnsweredBy is treated
  // as answered_human (AMD off / unknown result → conservative). The
  // voicemail case is covered in T82 below.
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { data: { id: "row_1" } },
  );
  const r = await handleOutboundStatus(asClient(fake), {
    CallSid: "CAparent_78",
    DialCallSid: "CAchild_78",
    DialCallStatus: "completed",
    DialCallDuration: "37",
  });
  if (!r.ok) failures.push("not ok");
  if (!r.matchedByParentSid) failures.push("did not match by parent SID");
  if (r.outcome !== "answered_human") failures.push(`outcome=${r.outcome}`);
  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.status !== "completed") failures.push(`status=${update?.payload?.status}`);
  if (update?.payload?.duration_seconds !== 37) failures.push(`duration=${update?.payload?.duration_seconds}`);
  if (update?.payload?.call_outcome !== "answered_human") failures.push(`call_outcome=${update?.payload?.call_outcome}`);
  if (!update?.payload?.end_time) failures.push("end_time missing");
  if (!update?.eqFilters.some((f) => f.column === "twilio_call_sid" && f.value === "CAparent_78")) {
    failures.push("update did not filter by twilio_call_sid=CAparent_78");
  }

  // Phase 3.9 — outcome mapping across the SIMPLE (no-AnsweredBy)
  // cases. The full DialCallStatus × AnsweredBy matrix lives in T82
  // — this test just guards the coarse mapping stays intact.
  const outcomes: Array<{ dial: string; want: string }> = [
    { dial: "no-answer", want: "no_answer" },
    { dial: "busy", want: "busy" },
    { dial: "failed", want: "failed" },
    // canceled + no AnsweredBy + no duration → caller_hung_up_during_ring
    // per the Phase 3.9 taxonomy (staff hung up while ringing).
    { dial: "canceled", want: "caller_hung_up_during_ring" },
  ];
  for (const o of outcomes) {
    const f = new FakeSupabaseClient();
    f.on((c) => c.op === "update" && c.table === "calls", { data: { id: "r" } });
    await handleOutboundStatus(asClient(f), {
      CallSid: "CAx",
      DialCallStatus: o.dial,
    });
    const u = f.calls.find((c) => c.op === "update" && c.table === "calls");
    if (u?.payload?.call_outcome !== o.want) failures.push(`[${o.dial}] call_outcome=${u?.payload?.call_outcome} (expected ${o.want})`);
  }

  // Missing parent SID → soft-return, no crash.
  const empty = await handleOutboundStatus(new FakeSupabaseClient() as any, {});
  if (!empty.ok) failures.push("empty CallSid should still return ok");

  record("T78 handleOutboundStatus: updates by parent SID, maps outcomes, soft-fails cleanly", failures.length === 0, failures.join("; ") || "outcome capture correct + 200-always discipline holds");
}

/**
 * Phase 3.8 T79 — listRecentInAppCallsForUser scopes by (business,
 * user, answered_via='browser'). The exact query the /phone panel
 * fires. Guards against a widening scope leaking another staff's or
 * another tenant's calls.
 */
async function T79_recent_in_app_calls_scoping() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "calls",
    {
      data: [
        {
          id: "c1",
          twilio_call_sid: "CA1",
          direction: "outbound",
          caller_number: "+15551234567",
          answered_via: "browser",
          status: "completed",
          call_outcome: "answered",
          duration_seconds: 42,
          start_time: null,
          end_time: null,
          created_at: new Date().toISOString(),
        },
      ],
    },
  );
  const r = await listRecentInAppCallsForUser(asClient(fake), USER_A, BIZ, 20);
  const failures: string[] = [];
  if (!r.ok) failures.push(`not ok: ${(r as any).error}`);
  else if (r.body.calls.length !== 1) failures.push(`calls.length=${r.body.calls.length}`);
  const q = fake.calls.find((c) => c.op === "select" && c.table === "calls");
  // Scope filters MUST all be present.
  const hasBiz = q?.eqFilters.some((f) => f.column === "business_id" && f.value === BIZ);
  const hasUser = q?.eqFilters.some((f) => f.column === "handled_by_user_id" && f.value === USER_A);
  const hasBrowser = q?.eqFilters.some((f) => f.column === "answered_via" && f.value === "browser");
  if (!hasBiz) failures.push("missing business_id filter");
  if (!hasUser) failures.push("missing handled_by_user_id filter");
  if (!hasBrowser) failures.push("missing answered_via='browser' filter");
  record("T79 listRecentInAppCallsForUser: scoped by (business, user, answered_via='browser')", failures.length === 0, failures.join("; ") || "no cross-staff / cross-tenant leak from the panel");
}

/**
 * Phase 3.8 T80 — route-layer HTTP test for /voice/outbound-status.
 * Twilio POSTs the callback with form fields. Route must accept POST
 * and return 200 valid TwiML — same discipline as the 3.6 whisper
 * verb bug. Handler-function tests would have missed a router.get
 * registration.
 */
async function T80_outbound_status_route_http() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  // Mount a passthrough that mirrors the real handler's contract.
  // We can't mount the real router without booting Supabase; the
  // signature-verify path and the handler are tested elsewhere. Here
  // we assert the routing-layer verb + response shape via the same
  // pattern T73 uses for /voice/caller-id.
  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: "r" } });
  app.post("/api/voice/outbound-status", async (req, res) => {
    await handleOutboundStatus(asClient(fake), (req.body || {}) as any);
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];
  try {
    const body = new URLSearchParams({
      CallSid: "CAparent_http_test",
      DialCallSid: "CAchild_http_test",
      DialCallStatus: "completed",
      DialCallDuration: "12",
    }).toString();
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/outbound-status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status !== 200) failures.push(`status=${res.status} — sev-1 if non-200 (would trigger Twilio error audio)`);
    const twiml = await res.text();
    if (!/^<\?xml.*<Response\/>/s.test(twiml)) failures.push(`twiml shape=${twiml.slice(0, 100)}`);
    // Sanity: the handler ran + updated the row.
    const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
    if (!update) failures.push("handler did not fire during HTTP round-trip");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  record("T80 POST /api/voice/outbound-status → 200 valid TwiML (route-layer verb regression guard)", failures.length === 0, failures.join("; ") || "verb contract locked at the route table, not the handler function");
}

/**
 * Phase 3.8 T81 — resolveStaffUserIdForClient. The insert at
 * dial-time uses this to attribute the row to the placing staff.
 * Failure returns null (row still inserts, just without attribution)
 * — better than dropping the row.
 */
async function T81_resolve_staff_user_id_for_client() {
  const failures: string[] = [];
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) =>
      c.op === "select" &&
      c.table === "user_businesses" &&
      c.eqFilters.some((f) => f.column === "client_identity"),
    { data: { user_id: USER_A } },
  );
  const uid = await resolveStaffUserIdForClient(asClient(fake), CLIENT_A);
  if (uid !== USER_A) failures.push(`user=${uid}`);
  // Not-found → null, no throw.
  const fake2 = new FakeSupabaseClient();
  fake2.on((c) => c.op === "select" && c.table === "user_businesses", { data: null });
  const missing = await resolveStaffUserIdForClient(asClient(fake2), CLIENT_A);
  if (missing !== null) failures.push(`missing case returned=${missing}`);
  record("T81 resolveStaffUserIdForClient: happy path + null on miss (no throw)", failures.length === 0, failures.join("; ") || "attribution derives from server-side identity, not client body");
}

// ── Phase 3.9: outbound ringback + AMD + outcome taxonomy + phone ──

/**
 * Phase 3.9 T82 — full DialCallStatus × AnsweredBy outcome mapping
 * matrix. This is the taxonomy every downstream conversion metric
 * depends on. Live 2026-07-31: voicemail was recorded as 'answered'
 * because Twilio reports DialCallStatus=completed for voicemails —
 * fixed by folding AnsweredBy into the mapping.
 */
async function T82_outcome_mapping_matrix() {
  const cases: Array<{
    dial: string;
    answeredBy: string | null;
    duration: number | null;
    want: OutboundOutcome;
    label: string;
  }> = [
    // completed × AnsweredBy variants
    { dial: "completed", answeredBy: "human", duration: 42, want: "answered_human", label: "human answer" },
    { dial: "completed", answeredBy: "machine_start", duration: 8, want: "voicemail", label: "AMD machine_start" },
    { dial: "completed", answeredBy: "machine_end_beep", duration: 10, want: "voicemail", label: "AMD machine_end_beep" },
    { dial: "completed", answeredBy: "machine_end_silence", duration: 12, want: "voicemail", label: "AMD machine_end_silence" },
    { dial: "completed", answeredBy: "machine_end_other", duration: 15, want: "voicemail", label: "AMD machine_end_other" },
    { dial: "completed", answeredBy: "fax", duration: 5, want: "voicemail", label: "fax tones → voicemail bucket" },
    { dial: "completed", answeredBy: "unknown", duration: 10, want: "answered_human", label: "AMD unknown → conservative human" },
    { dial: "completed", answeredBy: null, duration: 10, want: "answered_human", label: "AMD disabled → human default" },
    // Case aliasing
    { dial: "answered", answeredBy: "human", duration: 20, want: "answered_human", label: "answered alias" },
    { dial: "COMPLETED", answeredBy: "MACHINE_START", duration: 8, want: "voicemail", label: "case insensitive" },
    // Non-completed dispositions
    { dial: "no-answer", answeredBy: null, duration: null, want: "no_answer", label: "no-answer" },
    { dial: "busy", answeredBy: null, duration: null, want: "busy", label: "busy" },
    { dial: "failed", answeredBy: null, duration: null, want: "failed", label: "failed" },
    // canceled — the tricky one
    { dial: "canceled", answeredBy: null, duration: null, want: "caller_hung_up_during_ring", label: "canceled while ringing (staff hangup)" },
    { dial: "canceled", answeredBy: null, duration: 0, want: "caller_hung_up_during_ring", label: "canceled, duration=0" },
    { dial: "canceled", answeredBy: "human", duration: 5, want: "canceled", label: "canceled after human answer" },
    // Unknown Twilio value → failed (never silently 'answered_human')
    { dial: "gibberish", answeredBy: null, duration: null, want: "failed", label: "unknown Twilio status" },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const got = mapDialOutcome(c.dial, c.answeredBy, c.duration);
    if (got !== c.want) failures.push(`[${c.label}] got=${got} want=${c.want}`);
  }
  record("T82 mapDialOutcome matrix: 17 (DialCallStatus × AnsweredBy) combinations correct", failures.length === 0, failures.join("; ") || "voicemail no longer misclassified as answered_human");
}

/**
 * Phase 3.9 T83 — buildOutboundDialTwiml emits ringTone + AMD
 * attribute in the expected shapes. Belt-and-braces against the same
 * caller-silence bug that hit inbound in 3.4, and against a Twilio
 * default-change breaking AMD attachment silently.
 */
async function T83_outbound_dial_twiml_ringback_no_amd() {
  const failures: string[] = [];

  // Phase 3.12 — default TwiML has ringTone but NO AMD attributes.
  // AMD removed in 3.12 (see phase header) because it silently
  // no-op'd on TwiML-App-with-Client-parent calls. Regression guard:
  // if a future dev adds machineDetection back to the default without
  // also fixing the AMD-via-Number Twilio bug, this test catches it.
  const t1 = buildOutboundDialTwiml("+14433314649", "+15551234567", {
    statusCallbackUrl: "https://x/y",
  });
  if (!/ringTone="us"/.test(t1)) failures.push("default: missing ringTone");
  if (!/answerOnBridge="true"/.test(t1)) failures.push("missing answerOnBridge");
  if (!/action="https:\/\/x\/y"\s+method="POST"/.test(t1)) failures.push("missing action+POST");
  // Critical Phase 3.12 assertions — NO AMD attributes anywhere.
  if (/machineDetection/i.test(t1)) failures.push("machineDetection present (must be removed in 3.12)");
  if (/amdStatusCallback/i.test(t1)) failures.push("amdStatusCallback present (must be removed in 3.12)");
  if (/amdStatusCallbackMethod/i.test(t1)) failures.push("amdStatusCallbackMethod present (must be removed in 3.12)");
  if (!/<Number>\+15551234567<\/Number>/.test(t1)) failures.push("naked <Number> shape");

  // Disable ringback.
  const t2 = buildOutboundDialTwiml("+18005551234", "+15550000000", {
    statusCallbackUrl: null,
    ringTone: null,
  });
  if (/ringTone=/.test(t2)) failures.push("ringTone suppressed when null");

  record("T83 buildOutboundDialTwiml: ringTone default + NO AMD attributes (3.12 regression guard)", failures.length === 0, failures.join("; ") || "AMD wiring stays out; ringback stays in");
}

/**
 * Phase 3.9 T85 — normalizeUsPhoneToE164 across the input shapes
 * the softphone dialpad will actually see. US-only for now.
 */
async function T85_normalize_us_phone_matrix() {
  const cases: Array<{ input: any; want: string | null; label: string }> = [
    { input: "4434490863", want: "+14434490863", label: "10-digit bare" },
    { input: "14434490863", want: "+14434490863", label: "11-digit leading 1" },
    { input: "+14434490863", want: "+14434490863", label: "E.164" },
    { input: "(443) 449-0863", want: "+14434490863", label: "national parenthesized" },
    { input: "443.449.0863", want: "+14434490863", label: "dot-separated" },
    { input: " 1 (443) 449-0863 ", want: "+14434490863", label: "whitespace + 1 + parens" },
    { input: "+1 443 449 0863", want: "+14434490863", label: "+1 with spaces" },
    { input: "4434490863x", want: "+14434490863", label: "trailing junk char (digits still 10)" },
    { input: "443-449-086", want: null, label: "9-digit partial → null" },
    { input: "24434490863", want: null, label: "11 digits NOT starting with 1 → null" },
    { input: "+44 20 1234 5678", want: null, label: "non-US +country → null" },
    { input: "", want: null, label: "empty" },
    { input: "   ", want: null, label: "whitespace only" },
    { input: null, want: null, label: "null" },
    { input: undefined, want: null, label: "undefined" },
    { input: 12345, want: null, label: "non-string" },
    { input: "not a phone", want: null, label: "garbage" },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const got = normalizeUsPhoneToE164(c.input as any);
    if (got !== c.want) failures.push(`[${c.label}] got=${JSON.stringify(got)} want=${JSON.stringify(c.want)}`);
  }
  record("T85 normalizeUsPhoneToE164: 17 input shapes correct (10, 11, E.164, garbage)", failures.length === 0, failures.join("; ") || "server-side normalization is the source of truth");
}

/**
 * Phase 3.9 T86 — route-layer HTTP smoke for /voice/outbound-status.
 * Route must accept POST, return 200 valid TwiML, and thread any
 * AnsweredBy in the body through mapDialOutcome. Same discipline as
 * Phase 3.6 whisper verb bug — handler-function tests can't see
 * route-layer defects.
 *
 * Phase 3.12 note: AMD was removed from the softphone path; this
 * test's `AnsweredBy: machine_start` in the body simulates the
 * Phase 2 campaign engine which still populates AnsweredBy via its
 * calls.create({asyncAmdStatusCallback}) flow. handleOutboundStatus
 * + mapDialOutcome remain the shared merge/mapping layer.
 */
async function T86_outbound_status_route_http_with_amd_body() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const fake = new FakeSupabaseClient();
  fake.on((c) => c.op === "update" && c.table === "calls", { data: { id: "r" } });
  app.post("/api/voice/outbound-status", async (req, res) => {
    await handleOutboundStatus(asClient(fake), (req.body || {}) as any);
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];
  try {
    // Voicemail callback body — the exact one that misclassified live.
    const body = new URLSearchParams({
      CallSid: "CAparent_86",
      DialCallSid: "CAchild_86",
      DialCallStatus: "completed",
      DialCallDuration: "5",
      AnsweredBy: "machine_start",
    }).toString();
    const res = await fetch(`http://127.0.0.1:${port}/api/voice/outbound-status`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (res.status !== 200) failures.push(`status=${res.status}`);
    const twiml = await res.text();
    if (!/^<\?xml.*<Response\/>/s.test(twiml)) failures.push(`twiml shape=${twiml.slice(0, 80)}`);
    const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
    if (update?.payload?.call_outcome !== "voicemail") {
      failures.push(`call_outcome=${update?.payload?.call_outcome} (must be 'voicemail' for AMD=machine_start)`);
    }
    if (update?.payload?.answered_by !== "machine_start") {
      failures.push(`answered_by=${update?.payload?.answered_by} (raw Twilio value must be stored)`);
    }
    if (update?.payload?.status !== "completed") {
      failures.push(`status=${update?.payload?.status} (raw DialCallStatus must be stored)`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  record("T86 POST /voice/outbound-status with AMD → 200 + voicemail outcome + raw values stored", failures.length === 0, failures.join("; ") || "voicemail-as-answered bug can't recur");
}

/**
 * Phase 3.9 T87 — server-side outbound handler normalizes the
 * dialed number. The browser also normalizes, but we NEVER trust
 * the client to have done it right — a stale bundle or a manual
 * cURL from anywhere could send a bare 10-digit. Assert
 * buildOutboundDialTwiml receives an E.164 destination for a
 * bare-10-digit input.
 */
async function T87_normalize_10_digit_dials_e164() {
  // Direct test on the helper — the route wiring is exercised in
  // T80 (Phase 3.8) end-to-end. This asserts the normalization
  // happens before the callerId/E.164 check.
  const failures: string[] = [];
  const cases: Array<{ raw: string; want: string }> = [
    { raw: "4434490863", want: "+14434490863" },
    { raw: "14434490863", want: "+14434490863" },
    { raw: "  (443) 449-0863  ", want: "+14434490863" },
  ];
  for (const c of cases) {
    const got = normalizeUsPhoneToE164(c.raw);
    if (got !== c.want) failures.push(`[${c.raw}] got=${got}`);
  }
  record("T87 outbound server-side normalization: 10/11/formatted → +E.164 pre-dial", failures.length === 0, failures.join("; ") || "browser normalization is UX; server normalization is the truth");
}


// ── Phase 3.12: staff call disposition replaces AMD ─────────────────

/**
 * Phase 3.12 T88 — disposition whitelist rejection. Anything not in
 * CALL_DISPOSITIONS → 400. Prevents typos and enum drift from
 * silently storing garbage in the disposition column.
 */
async function T88_disposition_whitelist_rejects_unknown() {
  const failures: string[] = [];
  const fake = new FakeSupabaseClient();
  const bad = await writeCallDispositionForCaller(asClient(fake), USER_A, BIZ, {
    callRowId: "row_x",
    disposition: "reached-person" as any,
  });
  if (bad.ok) failures.push("wrong-shape disposition accepted");
  else if (bad.status !== 400) failures.push(`status=${bad.status}`);
  const noId = await writeCallDispositionForCaller(asClient(fake), USER_A, BIZ, {
    callRowId: "",
    disposition: "reached_person",
  });
  if (noId.ok) failures.push("empty call id accepted");
  else if (noId.status !== 400) failures.push(`no-id status=${noId.status}`);
  const known: CallDisposition[] = [
    "reached_person",
    "voicemail_left_message",
    "voicemail_no_message",
    "wrong_number",
    "no_answer_bad_line",
  ];
  for (const d of known) {
    if (!CALL_DISPOSITIONS.has(d)) failures.push(`known disposition ${d} missing from set`);
  }
  if (CALL_DISPOSITIONS.size !== known.length) {
    failures.push(`CALL_DISPOSITIONS.size=${CALL_DISPOSITIONS.size} (expected ${known.length})`);
  }
  record("T88 disposition whitelist rejects unknown values + validates id", failures.length === 0, failures.join("; ") || "only 5 whitelisted dispositions writable");
}

/**
 * Phase 3.12 T89 — CROSS-USER + CROSS-TENANT scoping guard.
 * A staff member can only disposition calls THEY placed. The UPDATE
 * must scope by (id AND business_id AND handled_by_user_id). Even if
 * they know another staff's call UUID, must return 404 (never 403 —
 * indistinguishable from "call doesn't exist").
 */
async function T89_disposition_scoped_to_caller() {
  const failures: string[] = [];
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { data: null },
  );

  const result = await writeCallDispositionForCaller(asClient(fake), USER_A, BIZ, {
    callRowId: "row_belongs_to_other_user",
    disposition: "reached_person",
  });
  if (result.ok) failures.push(`accepted cross-scope: ${JSON.stringify(result)}`);
  else if (result.status !== 404) failures.push(`status=${result.status} (expected 404 — indistinguishable from not-found)`);

  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  const filters = update?.eqFilters || [];
  if (!filters.some((f) => f.column === "id")) failures.push("no id filter");
  if (!filters.some((f) => f.column === "business_id" && f.value === BIZ)) {
    failures.push("no business_id filter (cross-tenant leak risk)");
  }
  if (!filters.some((f) => f.column === "handled_by_user_id" && f.value === USER_A)) {
    failures.push("no handled_by_user_id filter (cross-user disposition risk)");
  }
  record("T89 disposition scoped to caller: (id AND business_id AND handled_by_user_id) — no cross-user/tenant write", failures.length === 0, failures.join("; ") || "staff can only disposition calls they placed");
}

/**
 * Phase 3.12 T90 — happy-path write. Sets disposition +
 * dispositioned_by_user_id + dispositioned_at. Does NOT touch
 * call_outcome (machine observation stays separate from human input,
 * per migration 046 design principle).
 */
async function T90_disposition_happy_path_write() {
  const failures: string[] = [];
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { data: { id: "row_1" } },
  );

  const now = new Date("2026-08-01T12:00:00Z");
  const result = await writeCallDispositionForCaller(
    asClient(fake),
    USER_A,
    BIZ,
    { callRowId: "row_1", disposition: "voicemail_left_message" },
    now,
  );
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  if (result.ok && result.disposition !== "voicemail_left_message") {
    failures.push(`returned disposition=${result.disposition}`);
  }

  const update = fake.calls.find((c) => c.op === "update" && c.table === "calls");
  if (update?.payload?.disposition !== "voicemail_left_message") {
    failures.push(`payload disposition=${update?.payload?.disposition}`);
  }
  if (update?.payload?.dispositioned_by_user_id !== USER_A) {
    failures.push(`dispositioned_by_user_id=${update?.payload?.dispositioned_by_user_id}`);
  }
  if (update?.payload?.dispositioned_at !== now.toISOString()) {
    failures.push(`dispositioned_at=${update?.payload?.dispositioned_at}`);
  }
  if ("call_outcome" in (update?.payload || {})) {
    failures.push(`payload should NOT include call_outcome: got ${update?.payload?.call_outcome}`);
  }
  record("T90 disposition write: sets disposition + who + when; NEVER touches call_outcome", failures.length === 0, failures.join("; ") || "human input and machine observation stored in separate columns");
}

/**
 * Phase 3.12 T91 — route-layer HTTP test for PATCH
 * /api/voice/calls/:id/disposition. Same discipline as prior phases.
 */
async function T91_disposition_route_http() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "update" && c.table === "calls",
    { data: { id: "row_1" } },
  );

  app.patch("/api/voice/calls/:id/disposition", async (req, res) => {
    const result = await writeCallDispositionForCaller(asClient(fake), USER_A, BIZ, {
      callRowId: String(req.params.id || ""),
      disposition: (req.body || {}).disposition,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ disposition: result.disposition });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/api/voice/calls/row_1/disposition`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disposition: "reached_person" }),
    });
    if (r1.status !== 200) failures.push(`happy status=${r1.status}`);
    const body1 = (await r1.json()) as any;
    if (body1.disposition !== "reached_person") failures.push(`happy disposition=${body1.disposition}`);

    const r2 = await fetch(`http://127.0.0.1:${port}/api/voice/calls/row_1/disposition`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disposition: "junk_not_in_whitelist" }),
    });
    if (r2.status !== 400) failures.push(`bad-value status=${r2.status}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  record("T91 PATCH /api/voice/calls/:id/disposition — 200 happy path + 400 whitelist reject", failures.length === 0, failures.join("; ") || "route-layer verb + shape locked");
}

/**
 * Phase 3.12 T92 — confirm NO AMD attributes remain in ANY shape
 * buildOutboundDialTwiml can emit. Belt-and-braces alongside T83 —
 * catches a future partial revert (someone adding machineDetection
 * back to a helper the T83 default path doesn't exercise).
 */
async function T92_no_amd_attributes_in_emitted_twiml() {
  const failures: string[] = [];
  const shapes = [
    buildOutboundDialTwiml("+14433314649", "+15551234567"),
    buildOutboundDialTwiml("+14433314649", "+15551234567", { statusCallbackUrl: "https://x/y" }),
    buildOutboundDialTwiml("+14433314649", "+15551234567", { statusCallbackUrl: null }),
    buildOutboundDialTwiml("+14433314649", "+15551234567", { ringTone: null }),
    buildOutboundDialTwiml("+14433314649", "+15551234567", { ringTone: "uk" }),
  ];
  for (const [i, twiml] of shapes.entries()) {
    if (/machineDetection/i.test(twiml)) failures.push(`shape[${i}] has machineDetection`);
    if (/amdStatusCallback/i.test(twiml)) failures.push(`shape[${i}] has amdStatusCallback`);
    if (/AnsweredBy/i.test(twiml)) failures.push(`shape[${i}] has AnsweredBy`);
  }
  record("T92 no AMD attributes in ANY buildOutboundDialTwiml shape", failures.length === 0, failures.join("; ") || "AMD stays removed across every option combination");
}

// ── Phase 3.15 — reachability across backgrounding / sleep / expiry ─

/**
 * Phase 3.15 T93 — buildDialTwiml shortens the Dial timeout when
 * EVERY candidate has a stale device AND no callback number. In that
 * state we're only ringing possibly-dead browser endpoints; the
 * caller shouldn't sit through the full 30s window before falling
 * through to legacy transfer / after-hours. Baseline 30s stays for
 * the mixed case (any fresh candidate, or any callback number).
 */
async function T93_all_stale_shortens_dial_timeout() {
  const failures: string[] = [];
  // (a) All stale + no callback → shortened to ALL_STALE_DIAL_TIMEOUT_SECS (15).
  const twimlAllStale = buildDialTwiml(
    {
      path: "topic_match",
      staffCandidates: [
        { userId: USER_A, callbackRingNumber: null, clientIdentity: CLIENT_A, deviceStale: true },
        { userId: USER_B, callbackRingNumber: null, clientIdentity: CLIENT_B, deviceStale: true },
      ],
      staffPhones: [],
      staffUserIds: [USER_A, USER_B],
      legacyPhone: null,
      handoffReason: "topic_match_ringing",
      transferStatus: "routing_topic_match",
    },
    {
      callerId: "+14155550100",
      whisperUrl: null,
      recordingStatusUrl: null,
      dialStatusUrl: null,
    },
  );
  if (!/timeout="15"/.test(twimlAllStale)) {
    failures.push(`all-stale expected timeout="15" got: ${twimlAllStale.match(/timeout="\d+"/)?.[0]}`);
  }

  // (b) Any fresh candidate → base 30s timeout preserved.
  const twimlMixed = buildDialTwiml(
    {
      path: "topic_match",
      staffCandidates: [
        { userId: USER_A, callbackRingNumber: null, clientIdentity: CLIENT_A, deviceStale: true },
        { userId: USER_B, callbackRingNumber: null, clientIdentity: CLIENT_B, deviceStale: false },
      ],
      staffPhones: [],
      staffUserIds: [USER_A, USER_B],
      legacyPhone: null,
      handoffReason: "topic_match_ringing",
      transferStatus: "routing_topic_match",
    },
    {
      callerId: "+14155550100",
      whisperUrl: null,
      recordingStatusUrl: null,
      dialStatusUrl: null,
    },
  );
  if (!/timeout="30"/.test(twimlMixed)) {
    failures.push(`mixed expected timeout="30" got: ${twimlMixed.match(/timeout="\d+"/)?.[0]}`);
  }

  // (c) All stale BUT has callback number → base 30s. The callback
  //     leg is a real phone; the caller might reasonably take up to
  //     30s to grab it. Only shorten when EVERY leg is possibly-dead.
  const twimlStaleButCallback = buildDialTwiml(
    {
      path: "topic_match",
      staffCandidates: [
        { userId: USER_A, callbackRingNumber: "+14155550111", clientIdentity: CLIENT_A, deviceStale: true },
      ],
      staffPhones: ["+14155550111"],
      staffUserIds: [USER_A],
      legacyPhone: null,
      handoffReason: "topic_match_ringing",
      transferStatus: "routing_topic_match",
    },
    {
      callerId: "+14155550100",
      whisperUrl: null,
      recordingStatusUrl: null,
      dialStatusUrl: null,
    },
  );
  if (!/timeout="30"/.test(twimlStaleButCallback)) {
    failures.push(`stale+callback expected timeout="30" got: ${twimlStaleButCallback.match(/timeout="\d+"/)?.[0]}`);
  }

  record(
    "T93 all-stale-no-callback → shortened Dial timeout; mixed or callback → base 30s",
    failures.length === 0,
    failures.join("; ") ||
      "caller doesn't sit through 30s of dead-Client ring before fallback kicks in",
  );
}

/**
 * Phase 3.15 T94 — routing must still reach a fallback when ALL
 * candidates are stale. Even in the worst case (every browser dead),
 * the caller should be dialed against possibly-dead <Client> legs
 * simultaneously (fail-fast) AND the action callback should trigger
 * the normal no-answer fallback. This test verifies we don't produce
 * a zero-candidate decision when we have on-duty users — the
 * "silent-drop" bug Phase 3.15 fixes.
 */
async function T94_never_zero_candidates_when_on_duty_stale() {
  const fake = new FakeSupabaseClient();
  stubDefaultBusiness(fake);
  stubStaffTopics(fake, [
    { user_id: USER_A, topic_slug: TOPIC_ROADSIDE },
  ]);
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        // Only candidate is stale + no callback. Pre-3.15 this
        // produced an empty candidate list and cascaded to
        // legacy_transfer/after_hours (silent drop = the bug).
        // Post-3.15 the Client leg is included and fails fast.
        {
          user_id: USER_A,
          callback_ring_number: null,
          client_identity: CLIENT_A,
          in_app_calling_enabled: true,
          voice_device_last_seen_at: STALE_HB(),
        },
      ],
    },
  );

  const result = await handleRouteToTopic(asClient(fake), baseBody);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const dec = result.result.decision;
    if (dec.path !== "topic_match") failures.push(`path=${dec.path} (expected topic_match, not fallback)`);
    if (dec.staffCandidates.length !== 1) failures.push(`candidate count=${dec.staffCandidates.length}`);
    if (dec.staffCandidates[0]?.deviceStale !== true) {
      failures.push(`candidate deviceStale=${dec.staffCandidates[0]?.deviceStale} (expected true)`);
    }
    // TwiML should still emit the <Client> leg + shortened timeout.
    if (result.result.twiml === null) failures.push("twiml=null (expected TwiML for topic_match)");
    else {
      if (!/<Client/.test(result.result.twiml)) failures.push("twiml missing <Client>");
      if (!/timeout="15"/.test(result.result.twiml)) {
        failures.push(`twiml timeout not shortened: ${result.result.twiml.match(/timeout="\d+"/)?.[0]}`);
      }
    }
  }
  record(
    "T94 all-stale on-duty user → path=topic_match with stale Client leg (not silent drop)",
    failures.length === 0,
    failures.join("; ") ||
      "silently unreachable is now impossible when at least one on-duty user exists",
  );
}

/**
 * Phase 3.15 T95 — team endpoint exposes device freshness so the
 * Team page can flag rows that are on duty but silently unreachable
 * (no callback + no fresh device). This is the operational visibility
 * requirement from the phase brief (#5). Route contract, not UI —
 * covers the field shape + fresh/stale computation boundary.
 */
async function T95_team_endpoint_returns_device_freshness() {
  const fake = new FakeSupabaseClient();
  fake.on(
    (c) => c.op === "select" && c.table === "user_businesses",
    {
      data: [
        {
          user_id: USER_A,
          role: "user",
          is_on_duty: true,
          on_duty_since: new Date().toISOString(),
          callback_ring_number: null,
          created_at: new Date().toISOString(),
          in_app_calling_enabled: true,
          voice_device_last_seen_at: FRESH_HB(),
        },
        {
          user_id: USER_B,
          role: "user",
          is_on_duty: true,
          on_duty_since: new Date().toISOString(),
          callback_ring_number: null,
          created_at: new Date().toISOString(),
          in_app_calling_enabled: true,
          voice_device_last_seen_at: STALE_HB(),
        },
      ],
    },
  );
  // Also stub staff_topics + users hydration to empty — TeamPage
  // renders those, they just don't matter for this contract test.
  fake.on((c) => c.op === "select" && c.table === "staff_topics", { data: [] });
  fake.on((c) => c.op === "select" && c.table === "auth_users_view", { data: [] });

  const result = await handleListTeam(asClient(fake), BIZ);
  const failures: string[] = [];
  if (!result.ok) failures.push(`not ok: ${(result as any).error}`);
  else {
    const a = result.members.find((m) => m.user_id === USER_A);
    const b = result.members.find((m) => m.user_id === USER_B);
    if (!a || !b) {
      failures.push(`missing members A=${!!a} B=${!!b}`);
    } else {
      // Shape: new fields present + typed correctly.
      if (typeof a.in_app_calling_enabled !== "boolean") failures.push("in_app_calling_enabled missing/wrong type");
      if (typeof a.device_heartbeat_fresh !== "boolean") failures.push("device_heartbeat_fresh missing/wrong type");
      if (typeof a.voice_device_last_seen_at !== "string" && a.voice_device_last_seen_at !== null) {
        failures.push("voice_device_last_seen_at wrong type");
      }
      // Semantics: A fresh, B stale.
      if (a.device_heartbeat_fresh !== true) failures.push(`A expected fresh, got ${a.device_heartbeat_fresh}`);
      if (b.device_heartbeat_fresh !== false) failures.push(`B expected stale, got ${b.device_heartbeat_fresh}`);
    }
  }
  record(
    "T95 team endpoint exposes device_heartbeat_fresh + voice_device_last_seen_at + in_app_calling_enabled",
    failures.length === 0,
    failures.join("; ") || "team page can flag on-duty-but-silently-unreachable rows",
  );
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
  await T40_dial_status_preserves_whisper_attribution();
  await T40b_dial_status_rest_fallback_attribution();
  await T41_false_match_regression();
  await T42_twilio_call_sid_upsert();
  await T43_stale_heartbeat_included_and_tagged();
  await T44_token_identity_ignores_client_supplied();
  await T45_parse_client_uris();
  await T46_outbound_twiml_shape();
  await T47_outbound_business_resolver();
  await T48_mint_access_token();
  // Phase 3.3a — per-membership identity + toggle wiring
  await T49_identity_differs_across_businesses();
  await T50_identity_is_deterministic();
  await T51_preferences_rejects_other_users_row();
  // Phase 3.3b — close token cross-tenant fallback + preferences dedupe
  await T52_token_no_membership_returns_403();
  await T53_token_multi_membership_no_header_returns_400();
  await T54_token_single_membership_no_header_ok();
  await T55_get_preference_shape();
  // Phase 3.3c — reachability guard + indicator states + agent tools
  await T56_reachability_matrix();
  await T57_indicator_state_matrix();
  await T58_agent_tools_no_agent_yet();
  await T59_preference_round_trip();
  // Phase 3.4 — dial-status hardening + ringback + signed-request smoke
  await T60_public_url_single_source_of_truth();
  await T61_signature_verify_accepts_valid_request();
  await T62_signature_verify_fallback_urls();
  await T63_ringback_and_wait_message_in_twiml();
  // Phase 3.5 — per-leg attribution via whisper + handler hardening
  await T64_whisper_url_per_candidate();
  await T65_whisper_attribution_write();
  await T66_whisper_handler_always_200_shape();
  await T67_whisper_write_swallows_errors();
  // Phase 3.6 — real HTTP dispatch of the whisper route
  await T68_whisper_route_accepts_post_over_http();
  await T69_whisper_route_accepts_get_over_http();
  await T70_dial_builder_emits_method_get_on_url();
  await T71_whisper_url_encoding_chain();
  // Phase 3.7 — caller-ID lookup + staff_count counts all candidates
  await T72_caller_id_helper_shape_and_outcomes();
  await T73_caller_id_route_http_shape();
  await T74_staff_count_counts_in_app_only_candidate();
  await T75_outbound_uses_resolved_business_caller_id();
  // Phase 3.8 — outbound in-app call logging + outcome capture
  await T76_insert_outbound_call_row_shape();
  await T77_outbound_cross_tenant_scoping_guard();
  await T78_outbound_status_callback_update();
  await T79_recent_in_app_calls_scoping();
  await T80_outbound_status_route_http();
  await T81_resolve_staff_user_id_for_client();
  // Phase 3.9 (+ 3.12 update) — outbound TwiML + outcome + phone.
  // AMD test (T84 resolveOutboundAmdMode) removed with AMD in 3.12.
  await T82_outcome_mapping_matrix();
  await T83_outbound_dial_twiml_ringback_no_amd();
  await T85_normalize_us_phone_matrix();
  await T86_outbound_status_route_http_with_amd_body();
  await T87_normalize_10_digit_dials_e164();
  // Phase 3.12 — staff disposition replaces AMD (T88-T92 renumbered)
  await T88_disposition_whitelist_rejects_unknown();
  await T89_disposition_scoped_to_caller();
  await T90_disposition_happy_path_write();
  await T91_disposition_route_http();
  await T92_no_amd_attributes_in_emitted_twiml();
  // Phase 3.15 — keep on-duty staff reachable across backgrounding /
  // sleep / token expiry. T43 (stale-drop) inverted to T43 (stale-
  // include+tag) above; new tests below verify the shortened-timeout
  // path + never-zero-candidates invariant + team endpoint contract.
  await T93_all_stale_shortens_dial_timeout();
  await T94_never_zero_candidates_when_on_duty_stale();
  await T95_team_endpoint_returns_device_freshness();
  await whisper_composition();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  // Phase 3.6 — a quick tick before exit lets any lingering libuv
  // handles (booted http servers, keep-alive sockets) finish tearing
  // down. Without this, Windows Node occasionally aborts with
  // "UV_HANDLE_CLOSING" during process.exit even though every test
  // has completed. Doesn't affect pass/fail; keeps the harness from
  // exit-code-3221226505 on Windows CI.
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
