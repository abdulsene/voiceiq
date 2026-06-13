/**
 * Dedupe + call_sid metadata smoke for the recording-status webhook.
 *
 *   T1 — webhook fires with RecordingStatus='in-progress' → no
 *        lead_activities row inserted; lead_calls.recording_sid stays
 *        null. Regression guard against re-introducing intermediate-state
 *        side effects.
 *   T2 — webhook fires once with RecordingStatus='completed' → exactly
 *        one call_completed activity row inserted, metadata.call_sid is
 *        populated (this was the Slice 2A invisibility bug).
 *   T3 — webhook fires a SECOND time with RecordingStatus='completed'
 *        (Twilio retry) → still exactly one activity row. lead_calls
 *        row unchanged. recording_sid guard short-circuits the handler.
 *
 * Strategy: TWILIO_WEBHOOK_VERIFY=0 bypasses signature verification so
 * we don't have to generate signed bodies. The route is dispatched
 * in-process via an Express test app (same pattern as 020 smoke).
 *
 * Skipped cleanly when SUPABASE_URL / SUPABASE_SERVICE_KEY unset.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/021-twilio-recording-status-dedupe.ts
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import express, { type Express } from "express";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// Bypass the signature check before importing the router so the route
// reads the env at request time (it does). Also block real Deepgram +
// Claude fetches that the fire-and-forget kicks off — we use a mock
// fetch shim.
process.env.TWILIO_WEBHOOK_VERIFY = "0";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "ACtest";
process.env.DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || "test-deepgram";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic";

const origFetch = global.fetch;
global.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  // Stub Deepgram so the fire-and-forget doesn't hit the network.
  if (u.includes("api.deepgram.com")) {
    return new Response(
      JSON.stringify({
        results: {
          channels: [
            { alternatives: [{ transcript: "stubbed", confidence: 0.99, words: [] }] },
            { alternatives: [{ transcript: "stubbed", confidence: 0.99, words: [] }] },
          ],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  // Stub Twilio's recording fetch (sms-service uses it; transcription
  // hits the Recording URL).
  if (u.includes("twilio.com")) {
    return new Response("audio-bytes", { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  // Stub Anthropic for the summarizer.
  if (u.includes("api.anthropic.com")) {
    return new Response(
      JSON.stringify({
        id: "msg_stub",
        type: "message",
        content: [{ type: "text", text: "stubbed summary" }],
        model: "claude-haiku-4-5",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  return origFetch(url, init);
}) as any;

// Dynamic import so the env above is set before the router module loads.
async function loadRouter() {
  const mod = await import("../routes/twilio-callbacks");
  return mod.default;
}

function buildTestApp(twilioCallbacksRouter: any): Express {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(twilioCallbacksRouter);
  return app;
}

async function dispatchForm(
  app: Express,
  url: string,
  formBody: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "POST",
      url,
      originalUrl: url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": "stub-bypassed-by-env",
      },
      body: formBody,
      header(name: string) { return this.headers[name.toLowerCase()]; },
      query: {},
    };
    const res: any = {
      statusCode: 200,
      _body: undefined as any,
      status(code: number) { this.statusCode = code; return this; },
      json(obj: any) { this._body = obj; resolve({ status: this.statusCode }); },
      send(_obj: any) { resolve({ status: this.statusCode }); },
      type() { return this; },
      setHeader() {},
    };
    (app as any).handle(req, res, () => resolve({ status: 404 }));
  });
}

async function activityCount(
  supabase: SupabaseClient,
  leadId: string,
  action: string,
): Promise<number> {
  const { data } = await supabase
    .from("lead_activities")
    .select("id, metadata, created_at")
    .eq("lead_id", leadId)
    .eq("action", action);
  return ((data as unknown as any[]) || []).length;
}

async function getActivity(
  supabase: SupabaseClient,
  leadId: string,
  action: string,
): Promise<{ metadata: Record<string, unknown> } | null> {
  const { data } = await supabase
    .from("lead_activities")
    .select("metadata")
    .eq("lead_id", leadId)
    .eq("action", action)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data as { metadata: Record<string, unknown> } | null;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log("SKIP: SUPABASE_URL / SUPABASE_SERVICE_KEY required for 021.");
    process.exit(0);
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const router = await loadRouter();
  const app = buildTestApp(router);

  const suffix = crypto.randomBytes(4).toString("hex");
  const fixtureBiz = `biz_test_021_${Date.now()}_${suffix}`;
  await supabase.from("business_configs").insert({
    business_id: fixtureBiz,
    business_name: "T021 Biz",
    industry: "general",
    phone_number: "+19785550000",
    email: `t021-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    created_at: new Date().toISOString(),
  });

  const { data: leadIns } = await supabase
    .from("leads")
    .insert({
      business_id: fixtureBiz,
      source: "ai_callback",
      contact_name: "T021 Customer",
      contact_phone: "+12025550021",
      reason: "dedupe smoke",
      urgency: "medium",
    })
    .select("id")
    .maybeSingle();
  if (!leadIns) {
    record("T021 fixture", false, "lead insert failed");
    process.exit(2);
  }
  const leadId = (leadIns as { id: string }).id;
  const callSid = `CA_${crypto.randomBytes(8).toString("hex")}`;
  const recordingSid = `RE_${crypto.randomBytes(8).toString("hex")}`;
  const recordingUrl = `https://api.twilio.com/recordings/${recordingSid}`;

  const { data: callIns } = await supabase
    .from("lead_calls")
    .insert({
      lead_id: leadId,
      call_sid: callSid,
      customer_phone: "+12025550021",
      status: "completed",
    })
    .select("id")
    .maybeSingle();
  if (!callIns) {
    record("T021 lead_calls fixture", false, "insert failed");
    process.exit(2);
  }
  const leadCallId = (callIns as { id: string }).id;

  try {
    // ── T1: in-progress is a no-op ────────────────────────────────────
    await dispatchForm(app, "/twilio/recording-status", {
      CallSid: callSid,
      RecordingSid: recordingSid,
      RecordingUrl: recordingUrl,
      RecordingStatus: "in-progress",
      RecordingDuration: "0",
      RecordingChannels: "2",
    });
    const t1Count = await activityCount(supabase, leadId, "call_completed");
    const { data: leadCallAfterT1 } = await supabase
      .from("lead_calls")
      .select("recording_sid")
      .eq("id", leadCallId)
      .maybeSingle();
    if (t1Count !== 0) {
      record("T1 in-progress no-op", false, `expected 0 activities, got ${t1Count}`);
    } else if ((leadCallAfterT1 as any)?.recording_sid) {
      record("T1 in-progress no-op", false, "recording_sid leaked on in-progress");
    } else {
      record("T1 in-progress is no-op", true, "no activity row, no recording_sid set");
    }

    // ── T2: first 'completed' inserts exactly one row with call_sid ───
    await dispatchForm(app, "/twilio/recording-status", {
      CallSid: callSid,
      RecordingSid: recordingSid,
      RecordingUrl: recordingUrl,
      RecordingStatus: "completed",
      RecordingDuration: "42",
      RecordingChannels: "2",
    });
    // Let the fire-and-forget settle so the lead_calls row reaches a
    // stable state before counting.
    await new Promise((r) => setTimeout(r, 250));
    const t2Count = await activityCount(supabase, leadId, "call_completed");
    const t2Activity = await getActivity(supabase, leadId, "call_completed");
    const t2HasCallSid = (t2Activity?.metadata as any)?.call_sid === callSid;
    if (t2Count !== 1) {
      record("T2 completed inserts one row", false, `expected 1, got ${t2Count}`);
    } else if (!t2HasCallSid) {
      record("T2 metadata.call_sid present", false, `metadata=${JSON.stringify(t2Activity?.metadata)}`);
    } else {
      record("T2 first completed: 1 row + call_sid in metadata", true, "exactly 1 row, metadata.call_sid populated");
    }

    // ── T3: duplicate 'completed' is idempotent ───────────────────────
    await dispatchForm(app, "/twilio/recording-status", {
      CallSid: callSid,
      RecordingSid: recordingSid,
      RecordingUrl: recordingUrl,
      RecordingStatus: "completed",
      RecordingDuration: "42",
      RecordingChannels: "2",
    });
    await new Promise((r) => setTimeout(r, 250));
    const t3Count = await activityCount(supabase, leadId, "call_completed");
    if (t3Count !== 1) {
      record("T3 duplicate is idempotent", false, `expected 1 row, got ${t3Count}`);
    } else {
      record("T3 duplicate completed is idempotent", true, "still exactly 1 activity row");
    }
  } finally {
    await supabase.from("lead_activities").delete().eq("lead_id", leadId);
    await supabase.from("lead_calls").delete().eq("id", leadCallId);
    await supabase.from("leads").delete().eq("id", leadId);
    await supabase.from("business_configs").delete().eq("business_id", fixtureBiz);
  }

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
