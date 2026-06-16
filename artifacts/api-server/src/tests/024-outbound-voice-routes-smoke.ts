/**
 * Phase 0 Commit 0-D + Phase 1.6 — outbound voice routes smoke. 13 cases.
 *
 *   TwiML route (T1-T3)
 *     T1 — outbound_automated lead_call → <Connect><Stream> with
 *          business + lead context parameters
 *     T2 — nonexistent lead_call_id → <Hangup/>
 *     T3 — inbound_bridge lead_call → <Hangup/> (cross-direction defense)
 *
 *   AMD route (T4-T5)
 *     T4 — AnsweredBy=human → answered_by='human', voicemail_left=FALSE,
 *          UPDATE keyed on answered_by IS NULL (idempotent)
 *     T5 — AnsweredBy=machine_end_beep, voicemail_text NULL →
 *          answered_by='machine_end_beep', voicemail_left=FALSE
 *          (regression for Phase 0 'agent talks until line drops')
 *
 *   Status route (T6-T8)
 *     T6 — completed → lead_calls.status='completed', ended_at +
 *          duration_secs set, only when status != 'completed'
 *          (idempotent)
 *     T7 — completed + campaign + answered_by='human' →
 *          outbound_campaigns.completed_count + succeeded_count both bump
 *          completed + machine_end_beep → completed_count + voicemail_count
 *          no-answer → completed_count + failed_count
 *     T8 — no-answer / busy / failed → leads.outbound_attempt_count + 1,
 *          last_outbound_attempt_at set
 *
 *   Phase 1.6 — voicemail redirect + voicemail TwiML route (T9-T13)
 *     T9  — AMD machine_end_beep + voicemail_text configured →
 *           client.calls(sid).update({url: voicemailUrl}) issued AND
 *           lead_calls.voicemail_left=TRUE
 *     T10 — AMD machine_end_silence + voicemail_text NULL → no
 *           client.calls.update; voicemail_left stays FALSE
 *     T11 — AMD human → no client.calls.update (only machine_* redirects)
 *     T12 — /voicemail TwiML with voicemail_text='Hi, please call back'
 *           → <Response><Say voice="alice">Hi, please call back</Say>
 *           <Hangup/></Response>
 *     T13 — /voicemail TwiML with NULL voicemail_text →
 *           <Response><Hangup/></Response>
 *
 * Strategy: FakeSupabaseClient (extended from 023 with UPDATE chain
 * support) + global.fetch mock for the signed-URL fetch + FakeTwilioClient
 * for the AMD voicemail redirect. Routes dispatched via Express's
 * app.handle pattern (same as 020/021/022).
 *
 * TWILIO_WEBHOOK_VERIFY=0 bypasses signature verification.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/024-outbound-voice-routes-smoke.ts
 */

import express, { type Express } from "express";
import crypto from "node:crypto";

process.env.TWILIO_WEBHOOK_VERIFY = "0";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven-key";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── FakeSupabaseClient (extends 023 pattern with UPDATE chain) ────────

type FakeCall = {
  op: "select" | "update";
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
  notFilters: Array<{ column: string; op: string; value: any }>;
  isFilters: Array<{ column: string; value: any }>;
  updatePayload?: Record<string, any>;
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
  update(payload: Record<string, any>) {
    this.call.op = "update";
    this.call.updatePayload = payload;
    return this;
  }
  eq(col: string, val: any) {
    this.call.eqFilters.push({ column: col, value: val });
    return this;
  }
  is(col: string, val: any) {
    this.call.isFilters.push({ column: col, value: val });
    return this;
  }
  neq(col: string, val: any) {
    this.call.notFilters.push({ column: col, op: "neq", value: val });
    return this;
  }
  not(col: string, op: string, val: any) {
    this.call.notFilters.push({ column: col, op, value: val });
    return this;
  }
  order() { return this; }
  limit() { return this; }
  async maybeSingle() {
    return this.fake.resolveCall(this.call);
  }
  // Allow awaiting the builder directly (supabase pattern for
  // .update().eq().select() returning a result without .single()).
  then(resolve: any, reject: any) {
    return this.fake.resolveCall(this.call).then(resolve, reject);
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
      notFilters: [],
      isFilters: [],
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

// ── FakeTwilioClient (Phase 1.6 — for AMD voicemail redirect) ─────────

interface TwilioUpdateInvocation {
  sid: string;
  url: string;
}

class FakeTwilioClient {
  invocations: TwilioUpdateInvocation[] = [];
  shouldFail = false;
  calls(sid: string) {
    return {
      update: async (opts: { url: string }) => {
        if (this.shouldFail) throw new Error("twilio_call_update_failed");
        this.invocations.push({ sid, url: opts.url });
        return { sid, status: "in-progress" };
      },
    };
  }
}

// ── Build test app ────────────────────────────────────────────────────

let setSupabaseForTesting: (c: any) => void;
let setTwilioClientForTesting: (c: any) => void;
async function buildApp(): Promise<Express> {
  const mod = await import("../routes/twilio-outbound-voice");
  setSupabaseForTesting = mod.__setSupabaseForTesting;
  setTwilioClientForTesting = mod.__setTwilioClientForTesting;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(mod.default);
  return app;
}

// Per-test fake injected via the route's __setSupabaseForTesting export
// (ESM-friendly DI seam). Production code path never touches it.
let currentFake: FakeSupabaseClient | null = null;

async function dispatch(
  app: Express,
  path: string,
  body: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url: path,
      originalUrl: path,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "bypassed-by-env",
      },
      body,
      header(name: string) { return this.headers[name.toLowerCase()]; },
      query: {},
    };
    // Manually parse query from path (express does this in middleware
    // we're bypassing).
    const qIdx = path.indexOf("?");
    if (qIdx >= 0) {
      const search = new URLSearchParams(path.slice(qIdx + 1));
      const q: Record<string, string> = {};
      search.forEach((v, k) => { q[k] = v; });
      req.query = q;
    }
    const res: any = {
      statusCode: 200,
      _body: "",
      _type: "",
      status(code: number) { this.statusCode = code; return this; },
      type(t: string) { this._type = t; return this; },
      send(s: string) { this._body = s; resolve({ status: this.statusCode, body: s }); },
      setHeader() {},
    };
    (app as any).handle(req, res, () => resolve({ status: 404, body: "" }));
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

const LEAD_CALL = "00000000-0000-0000-0000-000000000099";
const LEAD = "00000000-0000-0000-0000-000000000098";
const BIZ = "biz_test_024";
const CAMPAIGN = "00000000-0000-0000-0000-0000000000ca";

async function setupGlobalFetchMock(signedUrl: string | null) {
  const orig = global.fetch;
  global.fetch = (async (url: any) => {
    const u = String(url);
    if (u.startsWith("https://api.elevenlabs.io/v1/convai/conversation/get-signed-url")) {
      if (signedUrl) {
        return new Response(JSON.stringify({ signed_url: signedUrl }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("error", { status: 500 });
    }
    return new Response("not stubbed", { status: 500 });
  }) as any;
  return () => { global.fetch = orig; };
}

async function runT1_T3(app: Express) {
  // T1 — happy path
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls",
      {
        data: {
          id: LEAD_CALL,
          lead_id: LEAD,
          direction: "outbound_automated",
          call_objective: "appointment_reminder",
          campaign_id: null,
        },
      },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads",
      { data: { business_id: BIZ } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "business_configs",
      { data: { agent_id: "agent_test_024" } },
    );
    const restoreFetch = await setupGlobalFetchMock("wss://api.elevenlabs.io/v1/convai/conversation?token=signed");
    const r = await dispatch(app, `/twilio/outbound-voice/twiml?lead_call_id=${LEAD_CALL}`);
    restoreFetch();
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (!r.body.includes("<Connect>")) failures.push("missing <Connect>");
    if (!r.body.includes("<Stream")) failures.push("missing <Stream>");
    if (!r.body.includes("wss://api.elevenlabs.io")) failures.push("missing signed URL");
    if (!r.body.includes(`name="lead_call_id"`) || !r.body.includes(`value="${LEAD_CALL}"`))
      failures.push("missing lead_call_id parameter");
    if (!r.body.includes(`name="business_id"`) || !r.body.includes(`value="${BIZ}"`))
      failures.push("missing business_id parameter");
    if (!r.body.includes(`name="call_objective"`) || !r.body.includes(`value="appointment_reminder"`))
      failures.push("missing call_objective parameter");
    record("T1 outbound_automated → <Connect><Stream> with parameters", failures.length === 0, failures.join("; ") || "Connect/Stream/parameters all present");
  }
  // T2 — missing lead_call_id row
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on((c) => c.op === "select" && c.table === "lead_calls", { data: null });
    const restoreFetch = await setupGlobalFetchMock(null);
    const r = await dispatch(app, `/twilio/outbound-voice/twiml?lead_call_id=${LEAD_CALL}`);
    restoreFetch();
    const ok = r.status === 200 && r.body.includes("<Hangup/>");
    record("T2 nonexistent lead_call → <Hangup/>", ok, `status=${r.status} bodyHasHangup=${r.body.includes("<Hangup/>")}`);
  }
  // T3 — cross-direction defense
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls",
      {
        data: {
          id: LEAD_CALL,
          lead_id: LEAD,
          direction: "inbound_bridge",
          call_objective: null,
          campaign_id: null,
        },
      },
    );
    const restoreFetch = await setupGlobalFetchMock(null);
    const r = await dispatch(app, `/twilio/outbound-voice/twiml?lead_call_id=${LEAD_CALL}`);
    restoreFetch();
    const ok = r.status === 200 && r.body.includes("<Hangup/>");
    record("T3 cross-direction → <Hangup/>", ok, `status=${r.status} hangup=${r.body.includes("<Hangup/>")}`);
  }
}

async function runT4_T5(app: Express) {
  // T4
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls",
      { data: [{ id: LEAD_CALL, campaign_id: null, status: "in_progress" }] },
    );
    const r = await dispatch(app, `/twilio/outbound-voice/amd?lead_call_id=${LEAD_CALL}`, {
      AnsweredBy: "human",
    });
    const updateCall = fake.calls.find((c) => c.op === "update" && c.table === "lead_calls");
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (updateCall?.updatePayload?.answered_by !== "human") failures.push(`answered_by=${updateCall?.updatePayload?.answered_by}`);
    if (updateCall?.updatePayload?.voicemail_left !== false) failures.push(`voicemail_left=${updateCall?.updatePayload?.voicemail_left}`);
    if (!updateCall?.isFilters.some((f) => f.column === "answered_by" && f.value === null))
      failures.push("missing is(answered_by, null) idempotency clause");
    record("T4 AMD human → answered_by=human, idempotent", failures.length === 0, failures.join("; ") || "answered_by set, voicemail_left=false, idempotency clause present");
  }
  // T5
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls",
      { data: [{ id: LEAD_CALL, campaign_id: null, status: "in_progress" }] },
    );
    const r = await dispatch(app, `/twilio/outbound-voice/amd?lead_call_id=${LEAD_CALL}`, {
      AnsweredBy: "machine_end_beep",
    });
    const updateCall = fake.calls.find((c) => c.op === "update" && c.table === "lead_calls");
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (updateCall?.updatePayload?.answered_by !== "machine_end_beep") failures.push(`answered_by=${updateCall?.updatePayload?.answered_by}`);
    if (updateCall?.updatePayload?.voicemail_left !== false) failures.push(`voicemail_left=${updateCall?.updatePayload?.voicemail_left}`);
    record("T5 AMD machine_end_beep → answered_by=machine_end_beep, voicemail_left=false", failures.length === 0, failures.join("; ") || "machine_end_beep recorded; voicemail_left=false (Phase 0 doesn't leave voicemails)");
  }
}

async function runT6_T8(app: Express) {
  // T6 — completed transition
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls",
      {
        data: {
          id: LEAD_CALL,
          lead_id: LEAD,
          direction: "outbound_automated",
          status: "in_progress",
          campaign_id: null,
          answered_by: null,
        },
      },
    );
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls",
      { data: [{ id: LEAD_CALL }] },
    );
    const r = await dispatch(app, `/twilio/outbound-voice/status?lead_call_id=${LEAD_CALL}`, {
      CallStatus: "completed",
      CallDuration: "42",
    });
    const updateCall = fake.calls.find((c) => c.op === "update" && c.table === "lead_calls");
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (updateCall?.updatePayload?.status !== "completed") failures.push(`status update=${updateCall?.updatePayload?.status}`);
    if (updateCall?.updatePayload?.duration_secs !== 42) failures.push(`duration_secs=${updateCall?.updatePayload?.duration_secs}`);
    if (!updateCall?.updatePayload?.ended_at) failures.push("missing ended_at");
    if (!updateCall?.notFilters.some((f) => f.column === "status" && f.op === "neq" && f.value === "completed"))
      failures.push("missing neq(status, completed) idempotency clause");
    record("T6 status completed → idempotent UPDATE with ended_at + duration", failures.length === 0, failures.join("; ") || "status=completed, duration=42, ended_at set, neq idempotency clause present");
  }

  // T7 — campaign counters: completed + human → completed_count + succeeded_count
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls",
      {
        data: {
          id: LEAD_CALL,
          lead_id: LEAD,
          direction: "outbound_automated",
          status: "in_progress",
          campaign_id: CAMPAIGN,
          answered_by: "human",
        },
      },
    );
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls",
      { data: [{ id: LEAD_CALL }] },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "outbound_campaigns" && c.selectColumns === "completed_count",
      { data: { completed_count: 4 } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "outbound_campaigns" && c.selectColumns === "succeeded_count",
      { data: { succeeded_count: 3 } },
    );
    await dispatch(app, `/twilio/outbound-voice/status?lead_call_id=${LEAD_CALL}`, {
      CallStatus: "completed",
      CallDuration: "60",
    });
    const updateCampaigns = fake.calls.filter(
      (c) => c.op === "update" && c.table === "outbound_campaigns",
    );
    const completedBump = updateCampaigns.find((c) => "completed_count" in (c.updatePayload || {}));
    const succeededBump = updateCampaigns.find((c) => "succeeded_count" in (c.updatePayload || {}));
    const failures: string[] = [];
    if (completedBump?.updatePayload?.completed_count !== 5) failures.push(`completed_count update=${completedBump?.updatePayload?.completed_count}`);
    if (succeededBump?.updatePayload?.succeeded_count !== 4) failures.push(`succeeded_count update=${succeededBump?.updatePayload?.succeeded_count}`);
    record("T7 status completed + human → completed_count + succeeded_count bump", failures.length === 0, failures.join("; ") || "completed_count 4→5, succeeded_count 3→4");
  }

  // T8 — no-answer → leads.outbound_attempt_count + failed_count
  {
    const fake = new FakeSupabaseClient();
    currentFake = fake;
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls",
      {
        data: {
          id: LEAD_CALL,
          lead_id: LEAD,
          direction: "outbound_automated",
          status: "ringing",
          campaign_id: CAMPAIGN,
          answered_by: null,
        },
      },
    );
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls",
      { data: [{ id: LEAD_CALL, lead_id: LEAD }] },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "outbound_attempt_count",
      { data: { outbound_attempt_count: 1 } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "outbound_campaigns",
      { data: { completed_count: 2, failed_count: 1 } },
    );
    await dispatch(app, `/twilio/outbound-voice/status?lead_call_id=${LEAD_CALL}`, {
      CallStatus: "no-answer",
    });
    const failures: string[] = [];
    const leadUpdate = fake.calls.find((c) => c.op === "update" && c.table === "leads");
    if (leadUpdate?.updatePayload?.outbound_attempt_count !== 2) failures.push(`outbound_attempt_count=${leadUpdate?.updatePayload?.outbound_attempt_count}`);
    if (!leadUpdate?.updatePayload?.last_outbound_attempt_at) failures.push("missing last_outbound_attempt_at");
    const campUpdate = fake.calls.find((c) => c.op === "update" && c.table === "outbound_campaigns");
    if (campUpdate?.updatePayload?.completed_count !== 3) failures.push(`completed_count=${campUpdate?.updatePayload?.completed_count}`);
    if (campUpdate?.updatePayload?.failed_count !== 2) failures.push(`failed_count=${campUpdate?.updatePayload?.failed_count}`);
    record("T8 no-answer → leads.outbound_attempt_count + campaign failed/completed bump", failures.length === 0, failures.join("; ") || "leads attempt_count 1→2, last_outbound_attempt_at set, campaign failed 1→2, completed 2→3");
  }
}

async function runT9_T11(app: Express) {
  // T9 — AMD machine_end_beep + voicemail_text configured → redirect issued.
  {
    const fake = new FakeSupabaseClient();
    setSupabaseForTesting(fake);
    const twilio = new FakeTwilioClient();
    setTwilioClientForTesting(twilio);
    // AMD UPDATE returns the row with call_sid populated.
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.answered_by === "machine_end_beep",
      { data: [{ id: LEAD_CALL, call_sid: "CAtest_t9", campaign_id: null, status: "in_progress" }] },
    );
    // Redirect helper queries lead_id from lead_calls (selectColumns === "lead_id").
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns === "lead_id",
      { data: { lead_id: LEAD } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "business_id",
      { data: { business_id: BIZ } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns === "outbound_voicemail_text",
      { data: { outbound_voicemail_text: "Hi, please call back" } },
    );
    // Final voicemail_left=true UPDATE.
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.voicemail_left === true,
      { data: null },
    );

    const r = await dispatch(app, `/twilio/outbound-voice/amd?lead_call_id=${LEAD_CALL}`, {
      AnsweredBy: "machine_end_beep",
    });
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (twilio.invocations.length !== 1) failures.push(`twilio update calls=${twilio.invocations.length}`);
    if (twilio.invocations[0]?.sid !== "CAtest_t9") failures.push(`sid=${twilio.invocations[0]?.sid}`);
    if (!twilio.invocations[0]?.url.includes("/api/twilio/outbound-voice/voicemail"))
      failures.push(`url=${twilio.invocations[0]?.url}`);
    if (!twilio.invocations[0]?.url.includes(`lead_call_id=${LEAD_CALL}`))
      failures.push(`url missing lead_call_id`);
    const voicemailLeftUpd = fake.calls.find(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.voicemail_left === true,
    );
    if (!voicemailLeftUpd) failures.push("missing voicemail_left=true UPDATE");
    record("T9 AMD machine + voicemail_text → redirect + voicemail_left=true", failures.length === 0, failures.join("; ") || "twilio.calls.update issued, voicemail_left UPDATE issued");
  }

  // T10 — AMD machine + NULL voicemail_text → no redirect.
  {
    const fake = new FakeSupabaseClient();
    setSupabaseForTesting(fake);
    const twilio = new FakeTwilioClient();
    setTwilioClientForTesting(twilio);
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.answered_by === "machine_end_silence",
      { data: [{ id: LEAD_CALL, call_sid: "CAtest_t10", campaign_id: null, status: "in_progress" }] },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns === "lead_id",
      { data: { lead_id: LEAD } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "business_id",
      { data: { business_id: BIZ } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns === "outbound_voicemail_text",
      { data: { outbound_voicemail_text: null } },
    );

    const r = await dispatch(app, `/twilio/outbound-voice/amd?lead_call_id=${LEAD_CALL}`, {
      AnsweredBy: "machine_end_silence",
    });
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (twilio.invocations.length !== 0) failures.push(`unexpected ${twilio.invocations.length} twilio update calls`);
    const voicemailLeftUpd = fake.calls.find(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.voicemail_left === true,
    );
    if (voicemailLeftUpd) failures.push("unexpected voicemail_left=true UPDATE");
    record("T10 AMD machine + NULL voicemail_text → no redirect", failures.length === 0, failures.join("; ") || "no twilio update, voicemail_left stays false");
  }

  // T11 — AMD human → no redirect (regression — machine_ branch skipped).
  {
    const fake = new FakeSupabaseClient();
    setSupabaseForTesting(fake);
    const twilio = new FakeTwilioClient();
    setTwilioClientForTesting(twilio);
    fake.on(
      (c) => c.op === "update" && c.table === "lead_calls" && c.updatePayload?.answered_by === "human",
      { data: [{ id: LEAD_CALL, call_sid: "CAtest_t11", campaign_id: null, status: "in_progress" }] },
    );

    const r = await dispatch(app, `/twilio/outbound-voice/amd?lead_call_id=${LEAD_CALL}`, {
      AnsweredBy: "human",
    });
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (twilio.invocations.length !== 0) failures.push(`unexpected ${twilio.invocations.length} twilio update calls on human`);
    record("T11 AMD human → no redirect", failures.length === 0, failures.join("; ") || "no twilio update on human");
  }
}

async function runT12_T13(app: Express) {
  // T12 — /voicemail TwiML with text → <Say> + <Hangup/>.
  {
    const fake = new FakeSupabaseClient();
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns === "lead_id",
      { data: { lead_id: LEAD } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "business_id",
      { data: { business_id: BIZ } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns === "outbound_voicemail_text",
      { data: { outbound_voicemail_text: "Hi, please call back" } },
    );

    const r = await dispatch(app, `/twilio/outbound-voice/voicemail?lead_call_id=${LEAD_CALL}`);
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (!r.body.includes(`<Say voice="alice">Hi, please call back</Say>`))
      failures.push("missing <Say voice=alice>...");
    if (!r.body.includes("<Hangup/>")) failures.push("missing <Hangup/>");
    record("T12 voicemail TwiML with text → <Say>+<Hangup/>", failures.length === 0, failures.join("; ") || `body=${r.body.slice(0, 120)}`);
  }

  // T13 — /voicemail TwiML with NULL text → bare <Hangup/>.
  {
    const fake = new FakeSupabaseClient();
    setSupabaseForTesting(fake);
    fake.on(
      (c) => c.op === "select" && c.table === "lead_calls" && c.selectColumns === "lead_id",
      { data: { lead_id: LEAD } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "leads" && c.selectColumns === "business_id",
      { data: { business_id: BIZ } },
    );
    fake.on(
      (c) => c.op === "select" && c.table === "business_configs" && c.selectColumns === "outbound_voicemail_text",
      { data: { outbound_voicemail_text: null } },
    );

    const r = await dispatch(app, `/twilio/outbound-voice/voicemail?lead_call_id=${LEAD_CALL}`);
    const failures: string[] = [];
    if (r.status !== 200) failures.push(`status=${r.status}`);
    if (!r.body.includes("<Hangup/>")) failures.push("missing <Hangup/>");
    if (r.body.includes("<Say")) failures.push("unexpected <Say> for NULL voicemail_text");
    record("T13 voicemail TwiML with NULL text → bare <Hangup/>", failures.length === 0, failures.join("; ") || `body=${r.body.slice(0, 120)}`);
  }
}

async function main() {
  const app = await buildApp();
  await runT1_T3(app);
  await runT4_T5(app);
  await runT6_T8(app);
  await runT9_T11(app);
  await runT12_T13(app);

  // Restore so other harnesses running in-process see the real client.
  setSupabaseForTesting(null);
  setTwilioClientForTesting(null);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
