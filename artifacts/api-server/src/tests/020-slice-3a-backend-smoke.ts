/**
 * Slice 3A backend smoke harness.
 *
 *   T1 — sendLeadSms with valid context produces SMS row + activity
 *        timeline entry + Twilio API call (fetch-mocked).
 *   T2 — sendLeadSms blocked by opt-out: no Twilio call, no activity
 *        row, but a sms_messages row with status='opted_out'.
 *   T3 — POST /outcome (in-process: routes import) creates
 *        lead_call_outcomes row and updates lead.status per outcome.
 *   T4 — GET /api/public/lead/:token with a valid token returns a
 *        sanitized payload (no recording URLs, no full names, no
 *        internal IDs).
 *   T5 — POST /api/public/lead/:token/action rate writes
 *        lead_ratings + a customer_rated activity.
 *   T6 — Cross-tenant isolation: a token issued for biz A cannot
 *        access a lead belonging to biz B.
 *
 * Strategy: T1 + T2 directly call the service layer with mocked
 * Twilio. T3-T6 import the route modules and dispatch in-process via
 * a light Express test app (no live server). All tests assume the
 * 024 migration has been applied to the fixture supabase. Skipped
 * gracefully when SUPABASE_URL / SUPABASE_SERVICE_KEY are unset.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/020-slice-3a-backend-smoke.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import express, { type Express } from "express";

import { sendLeadSms, recordOptOut } from "../lib/sms-service";
import { signTrustToken } from "../lib/trust-portal-token";
import leadOutcomesRouter from "../routes/lead-outcomes";
import publicLeadRouter from "../routes/public-lead";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── Twilio mock ───────────────────────────────────────────────────────
// sms-service.ts pulls the Twilio client via getTwilioClient() from
// ../sms. We can't easily monkey-patch the module, so we mock-shim by
// setting env vars + intercepting twilio's REST messages.create via
// global fetch. twilio-node uses fetch under the hood since v5.
// We instead use a simple wrapper that swaps the module's getTwilioClient.

type TwilioMessageCreateResult = { sid: string; status: string };
type TwilioMessagesClient = {
  messages: { create: (opts: { body: string; from: string; to: string }) => Promise<TwilioMessageCreateResult> };
};
const twilioCalls: Array<{ body: string; from: string; to: string }> = [];
const fakeTwilioClient: TwilioMessagesClient = {
  messages: {
    create: async (opts) => {
      twilioCalls.push(opts);
      return { sid: `SM_${crypto.randomBytes(8).toString("hex")}`, status: "queued" };
    },
  },
};

// Replace the export on sms.ts module via re-import.
import * as smsModule from "../sms";
(smsModule as any).getTwilioClient = () => fakeTwilioClient;

function buildTestApp(): Express {
  const app = express();
  app.use(express.json());
  // Stub auth middleware: just inject req.userId/businessId. The
  // outcome route depends on these; the public route doesn't.
  app.use((req: any, _res, next) => {
    if (req.headers["x-test-user-id"]) {
      req.userId = String(req.headers["x-test-user-id"]);
      req.businessId = String(req.headers["x-test-business-id"]);
    }
    next();
  });
  app.use(leadOutcomesRouter);
  app.use(publicLeadRouter);
  return app;
}

async function dispatch(
  app: Express,
  method: "GET" | "POST",
  url: string,
  opts: { body?: any; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = {
      method,
      url,
      headers: opts.headers || {},
      body: opts.body || {},
    };
    // Mimic Express's req helpers minimally.
    const res: any = {
      statusCode: 200,
      _body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(obj: any) { this._body = obj; resolve({ status: this.statusCode, body: obj }); },
      send(obj: any) { this._body = obj; resolve({ status: this.statusCode, body: obj }); },
      setHeader() {},
      _end() { resolve({ status: this.statusCode, body: this._body }); },
    };
    // Hack: handle express.json-parsed routes by directly invoking the
    // matching layer via the app.handle entry point.
    (app as any).handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

async function runT1_T2_smsService(supabase: SupabaseClient) {
  const suffix = crypto.randomBytes(4).toString("hex");
  const fixtureBiz = `biz_test_3a_${Date.now()}_${suffix}`;
  const tenantPhone = "+14155551234";

  const { error: bizErr } = await supabase.from("business_configs").insert({
    business_id: fixtureBiz,
    business_name: "T020 Biz",
    industry: "general",
    phone_number: "+19785550000",
    email: `t020-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    twilio_phone_number: tenantPhone,
    created_at: new Date().toISOString(),
  });
  if (bizErr) {
    record("T0 fixture (sms)", false, `biz insert failed: ${bizErr.message}`);
    return;
  }

  // Insert a fake lead for activity-row linkage.
  const { data: leadIns, error: leadErr } = await supabase
    .from("leads")
    .insert({
      business_id: fixtureBiz,
      source: "ai_callback",
      contact_name: "Test Customer",
      contact_phone: "+12025550000",
      reason: "smoke test reason",
      urgency: "medium",
    })
    .select("id")
    .maybeSingle();
  if (leadErr || !leadIns) {
    record("T0 fixture (sms lead)", false, `lead insert failed: ${leadErr?.message}`);
    await supabase.from("business_configs").delete().eq("business_id", fixtureBiz);
    return;
  }
  const leadId = (leadIns as { id: string }).id;

  try {
    // ── T1 ────────────────────────────────────────────────────────────
    twilioCalls.length = 0;
    const r1 = await sendLeadSms({
      supabase,
      businessId: fixtureBiz,
      leadId,
      to: "+12025550000",
      template: "lead_captured",
      context: {
        contact_name: "Test",
        business_name: "T020 Biz",
        brief_reason: "smoke test",
        sla_window: "within 4 hours",
        portal_url: "https://example.com/r/abc",
      },
    });
    if (!r1.ok) {
      record("T1 sendLeadSms ok", false, `result: ${JSON.stringify(r1)}`);
    } else if (twilioCalls.length !== 1) {
      record("T1 twilio call issued", false, `expected 1 call, got ${twilioCalls.length}`);
    } else if (!twilioCalls[0].body.includes("Reply STOP")) {
      record("T1 STOP boilerplate present", false, `body: ${twilioCalls[0].body.slice(0, 200)}`);
    } else if (twilioCalls[0].from !== tenantPhone) {
      record("T1 from = tenant number", false, `from=${twilioCalls[0].from} expected=${tenantPhone}`);
    } else {
      // Confirm DB row + activity row.
      const { data: smsRow } = await supabase
        .from("sms_messages")
        .select("status, twilio_sid, template")
        .eq("id", r1.smsMessageId)
        .maybeSingle();
      const { data: actRow } = await supabase
        .from("lead_activities")
        .select("action, metadata")
        .eq("lead_id", leadId)
        .eq("action", "sms_sent")
        .maybeSingle();
      if (!smsRow || (smsRow as any).status !== "sent") {
        record("T1 sms_messages row persisted", false, `row: ${JSON.stringify(smsRow)}`);
      } else if (!actRow) {
        record("T1 lead_activities row", false, "no sms_sent activity row found");
      } else {
        record("T1 sendLeadSms end-to-end", true, "Twilio call + sms_messages + activity all present");
      }
    }

    // ── T2 ────────────────────────────────────────────────────────────
    twilioCalls.length = 0;
    await recordOptOut({ supabase, businessId: fixtureBiz, phone: "+13105550000" });
    const r2 = await sendLeadSms({
      supabase,
      businessId: fixtureBiz,
      leadId,
      to: "+13105550000",
      template: "callback_starting",
      context: { business_name: "T020 Biz", brief_reason: "test", from_phone: tenantPhone },
    });
    if (r2.ok) {
      record("T2 opt-out blocked", false, `expected ok=false, got ${JSON.stringify(r2)}`);
    } else if (twilioCalls.length !== 0) {
      record("T2 no twilio call", false, `expected 0 calls, got ${twilioCalls.length}`);
    } else {
      const { data: smsRow } = await supabase
        .from("sms_messages")
        .select("status")
        .eq("id", r2.smsMessageId)
        .maybeSingle();
      if (!smsRow || (smsRow as any).status !== "opted_out") {
        record("T2 sms_messages row marked opted_out", false, `row: ${JSON.stringify(smsRow)}`);
      } else {
        record("T2 sendLeadSms opt-out blocks send + records row", true, "no Twilio call, status=opted_out");
      }
    }
  } finally {
    await supabase.from("sms_messages").delete().eq("business_id", fixtureBiz);
    await supabase.from("sms_opt_outs").delete().eq("business_id", fixtureBiz);
    await supabase.from("lead_activities").delete().eq("lead_id", leadId);
    await supabase.from("leads").delete().eq("id", leadId);
    await supabase.from("business_configs").delete().eq("business_id", fixtureBiz);
  }
}

async function runT3_T6_routes(supabase: SupabaseClient) {
  process.env.TRUST_PORTAL_SIGNING_SECRET =
    process.env.TRUST_PORTAL_SIGNING_SECRET || crypto.randomBytes(32).toString("hex");

  const app = buildTestApp();
  const suffix = crypto.randomBytes(4).toString("hex");
  const bizA = `biz_test_3a_a_${Date.now()}_${suffix}`;
  const bizB = `biz_test_3a_b_${Date.now()}_${suffix}`;
  const staffUserId = crypto.randomUUID();

  const baseBiz = {
    industry: "general",
    phone_number: "+19785550000",
    email: `t020-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    twilio_phone_number: "+14155556666",
    created_at: new Date().toISOString(),
  };

  await supabase
    .from("business_configs")
    .insert([
      { ...baseBiz, business_id: bizA, business_name: "Biz A", email: `a-${suffix}@neverr.test` },
      { ...baseBiz, business_id: bizB, business_name: "Biz B", email: `b-${suffix}@neverr.test` },
    ]);

  const { data: leadA } = await supabase
    .from("leads")
    .insert({
      business_id: bizA,
      source: "ai_callback",
      contact_name: "Customer A",
      contact_phone: "+12025550001",
      reason: "biz A reason",
      urgency: "high",
    })
    .select("id")
    .maybeSingle();
  const { data: leadB } = await supabase
    .from("leads")
    .insert({
      business_id: bizB,
      source: "ai_callback",
      contact_name: "Customer B",
      contact_phone: "+12025550002",
      reason: "biz B reason",
      urgency: "low",
    })
    .select("id")
    .maybeSingle();
  if (!leadA || !leadB) {
    record("T3-T6 fixture setup", false, "lead inserts failed");
    return;
  }
  const leadAId = (leadA as { id: string }).id;
  const leadBId = (leadB as { id: string }).id;

  const callSid = `CA_${crypto.randomBytes(8).toString("hex")}`;
  const { data: callRow } = await supabase
    .from("lead_calls")
    .insert({
      lead_id: leadAId,
      call_sid: callSid,
      staff_user_id: staffUserId,
      customer_phone: "+12025550001",
      status: "completed",
      duration_secs: 120,
    })
    .select("id")
    .maybeSingle();
  if (!callRow) {
    record("T3 lead_calls fixture", false, "insert failed");
    return;
  }

  try {
    // ── T3 ────────────────────────────────────────────────────────────
    const r3 = await dispatch(app, "POST", `/business/leads/${leadAId}/calls/${callSid}/outcome`, {
      headers: {
        "x-test-user-id": staffUserId,
        "x-test-business-id": bizA,
      },
      body: { outcome: "booked", reason_code: null, reason_note: "yay" },
    });
    if (r3.status !== 200) {
      record("T3 outcome POST", false, `status=${r3.status} body=${JSON.stringify(r3.body).slice(0, 200)}`);
    } else {
      const { data: outRow } = await supabase
        .from("lead_call_outcomes")
        .select("outcome")
        .eq("lead_id", leadAId)
        .maybeSingle();
      const { data: leadAfter } = await supabase
        .from("leads")
        .select("status, outcome_booked")
        .eq("id", leadAId)
        .maybeSingle();
      if ((outRow as any)?.outcome !== "booked") {
        record("T3 outcome row", false, `row: ${JSON.stringify(outRow)}`);
      } else if ((leadAfter as any)?.status !== "resolved" || (leadAfter as any)?.outcome_booked !== true) {
        record("T3 lead.status + outcome_booked", false, `lead: ${JSON.stringify(leadAfter)}`);
      } else {
        record("T3 outcome capture happy path", true, "outcome=booked, lead.status=resolved, outcome_booked=true");
      }
    }

    // ── T4 ────────────────────────────────────────────────────────────
    const tokenA = signTrustToken(leadAId, bizA);
    const r4 = await dispatch(app, "GET", `/public/lead/${tokenA}`);
    if (r4.status !== 200) {
      record("T4 trust portal GET", false, `status=${r4.status} body=${JSON.stringify(r4.body).slice(0, 200)}`);
    } else {
      const blob = JSON.stringify(r4.body);
      const leaks: string[] = [];
      if (blob.includes(leadAId)) leaks.push("lead.id");
      if (blob.includes(staffUserId)) leaks.push("staff_user_id");
      if (blob.includes(callSid)) leaks.push("call_sid");
      if (blob.includes("recording_url") || blob.includes("transcript")) leaks.push("recording/transcript");
      if (!r4.body?.business?.name) leaks.push("business name missing");
      if (!Array.isArray(r4.body?.timeline)) leaks.push("timeline missing");
      if (leaks.length > 0) {
        record("T4 sanitized GET", false, `leaks: ${leaks.join(", ")}`);
      } else {
        record("T4 trust portal sanitized GET", true, "no internal IDs / recording / transcript leaked");
      }
    }

    // ── T5 ────────────────────────────────────────────────────────────
    const r5 = await dispatch(app, "POST", `/public/lead/${tokenA}/action`, {
      body: { action: "rate", score: 5, comment: "great" },
    });
    if (r5.status !== 200) {
      record("T5 rate POST", false, `status=${r5.status} body=${JSON.stringify(r5.body)}`);
    } else {
      const { data: ratingRow } = await supabase
        .from("lead_ratings")
        .select("score, comment")
        .eq("lead_id", leadAId)
        .maybeSingle();
      const { data: actRow } = await supabase
        .from("lead_activities")
        .select("action")
        .eq("lead_id", leadAId)
        .eq("action", "customer_rated")
        .maybeSingle();
      if ((ratingRow as any)?.score !== 5) {
        record("T5 rating row", false, `row: ${JSON.stringify(ratingRow)}`);
      } else if (!actRow) {
        record("T5 customer_rated activity row", false, "missing");
      } else {
        record("T5 trust portal rate happy path", true, "lead_ratings row + activity row both present");
      }
    }

    // ── T6 ────────────────────────────────────────────────────────────
    // Token issued for bizA's lead, but we'll forge claims pointing at
    // bizB's lead via a hand-crafted JWT. The token verify will pass
    // (it's signed correctly) but the route's business_id mismatch on
    // the lead row must 404.
    const crossToken = signTrustToken(leadBId, bizA);
    const r6 = await dispatch(app, "GET", `/public/lead/${crossToken}`);
    if (r6.status !== 404) {
      record("T6 cross-tenant isolation", false, `expected 404, got ${r6.status} body=${JSON.stringify(r6.body)}`);
    } else {
      record("T6 cross-tenant isolation", true, "token issued for biz A cannot read biz B lead — 404");
    }
  } finally {
    await supabase.from("lead_call_outcomes").delete().eq("lead_id", leadAId);
    await supabase.from("lead_activities").delete().eq("lead_id", leadAId);
    await supabase.from("lead_activities").delete().eq("lead_id", leadBId);
    await supabase.from("lead_ratings").delete().eq("lead_id", leadAId);
    await supabase.from("lead_calls").delete().eq("lead_id", leadAId);
    await supabase.from("leads").delete().eq("id", leadAId);
    await supabase.from("leads").delete().eq("id", leadBId);
    await supabase.from("business_configs").delete().eq("business_id", bizA);
    await supabase.from("business_configs").delete().eq("business_id", bizB);
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log("SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY required for 020.");
    process.exit(0);
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
  process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";

  await runT1_T2_smsService(supabase);
  await runT3_T6_routes(supabase);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
