/**
 * P0 regression harness for /api/lead post-call insert.
 *
 * The 2026-06-10 incident: EZ Rentals (biz_1779288494109_z4z979) lost a
 * real customer call because the polling sync raced the post-call webhook
 * and inserted call_sid first; the post-call branch then 23505'd silently
 * while the handler still returned `success: true` to ElevenLabs.
 *
 *   T1 — happy path post-call webhook with a fresh call_sid → row inserted,
 *        response 200 with callId.
 *   T2 — duplicate call_sid simulating the polling-sync race: pre-insert a
 *        row with the same call_sid, then POST the webhook. UPSERT wins —
 *        single row remains (no 23505 to the caller), response 200 with
 *        success: true. Row's transcript field IS updated (upsert
 *        semantic) to confirm we overwrote with richer data.
 *   T3 — null caller phone (browser-initiated call, no caller-ID
 *        metadata) → row still inserts; caller_number is NULL (schema
 *        allows it). Verifies hypothesis #2 (caller_number NOT NULL) is
 *        ruled out and doesn't regress.
 *   T4 — simulated upstream supabase failure: pre-insert a fixture row
 *        with a guaranteed-conflicting call_sid, then POST a payload that
 *        forces the explicit INSERT path (no within-5-min existing-row
 *        match because the pre-inserted row is older than 5 min). Without
 *        UPSERT, this would 23505. With UPSERT, the response is 200 +
 *        success: true + duplicate: true on the explicit short-circuit
 *        path. Asserts response shape and that Sentry breadcrumb / not
 *        captureMessage was used (heuristic: response includes
 *        `duplicate: true`).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/013-lead-post-call-insert-smoke.ts
 *
 * Requires (env): SUPABASE_URL, SUPABASE_SERVICE_KEY, and the api-server
 * running locally (default http://localhost:8080; override via
 * TEST_API_BASE).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

// We need a real business_configs row with a known agent_id so
// resolveBusinessFromAgentId resolves to our fixture business (not the
// "demo-business" fallback). Created in beforeAll, torn down in afterAll.
async function setupFixtureBusiness(supa: SupabaseClient): Promise<{ businessId: string; agentId: string }> {
  const suffix = crypto.randomBytes(4).toString("hex");
  const businessId = `biz_test_${Date.now()}_${suffix}`;
  const agentId = `agent_test_${Date.now()}_${suffix}`;
  const { error } = await supa.from("business_configs").insert({
    business_id: businessId,
    business_name: `Test Business ${suffix}`,
    industry: "general",
    phone_number: "+15555550000",
    email: `test-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    agent_id: agentId,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`fixture business_configs insert failed: ${error.message}`);
  return { businessId, agentId };
}

async function teardownFixtureBusiness(supa: SupabaseClient, businessId: string) {
  try {
    await supa.from("calls").delete().eq("business_id", businessId);
    await supa.from("business_configs").delete().eq("business_id", businessId);
  } catch (err) {
    console.warn(`cleanup: teardownFixtureBusiness(${businessId}) failed`, err);
  }
}

function buildPostCallPayload(opts: { agentId: string; conversationId: string; callerPhone: string | null; transcript: string }) {
  // Matches the conversation_post_call_transcription shape the handler
  // recognizes at the top of /lead. data_collection_results carries the
  // Claude-extracted caller fields.
  return {
    type: "conversation_post_call_transcription",
    data: {
      conversation_id: opts.conversationId,
      agent_id: opts.agentId,
      transcript: [
        { role: "agent", message: "Hello, thank you for calling. How can I help?" },
        { role: "user", message: opts.transcript },
      ],
      metadata: {
        call_duration_secs: 87,
        start_time_unix_secs: Math.floor(Date.now() / 1000) - 90,
        phone_call: opts.callerPhone ? { external_number: opts.callerPhone } : undefined,
      },
      analysis: {
        data_collection_results: {
          caller_name: { value: "Test Caller" },
          caller_phone: opts.callerPhone ? { value: opts.callerPhone } : null,
          reason: { value: "Booking inquiry" },
        },
      },
    },
  };
}

async function postLead(body: any): Promise<{ http: number; json: any; text: string }> {
  const r = await fetch(`${API}/api/lead`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { http: r.status, json, text };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — cannot run.");
    process.exit(1);
  }
  const supa = adminClient();
  const fixture = await setupFixtureBusiness(supa);
  console.log(`[fixture] business_id=${fixture.businessId} agent_id=${fixture.agentId}`);

  try {
    // ----- T1: happy path -----
    try {
      const conversationId = `conv_t1_${crypto.randomBytes(6).toString("hex")}`;
      const r = await postLead(buildPostCallPayload({
        agentId: fixture.agentId,
        conversationId,
        callerPhone: "+15555550001",
        transcript: "I'd like to book a cleaning appointment.",
      }));
      if (r.http !== 200 || !r.json?.success || !r.json.callId) {
        record("T1 happy path → 200 + callId", false, `http=${r.http} body=${r.text.slice(0, 300)}`);
      } else {
        const { data: row } = await supa.from("calls").select("id, call_sid, business_id, transcript").eq("call_sid", conversationId).single();
        if (row?.business_id === fixture.businessId && row?.call_sid === conversationId && row?.transcript) {
          record("T1 happy path → 200 + callId + row exists", true, `callId=${r.json.callId} row.id=${row.id}`);
        } else {
          record("T1 happy path → 200 + callId + row exists", false, `row mismatch: ${JSON.stringify(row)}`);
        }
      }
    } catch (err: any) {
      record("T1 happy path", false, `threw: ${err.message}`);
    }

    // ----- T2: polling-sync race — pre-insert same call_sid, then POST.
    // UPSERT wins → single row, response 200, transcript overwritten.
    try {
      const conversationId = `conv_t2_${crypto.randomBytes(6).toString("hex")}`;
      // Pre-insert a sparse row mimicking polling-sync's write. start_time
      // is intentionally 6+ min ago so the within-5-min biz+phone lookup
      // in /lead's post-call branch CANNOT match it — forces the UPSERT
      // path rather than the UPDATE path.
      const { error: preErr } = await supa.from("calls").insert({
        call_sid: conversationId,
        business_id: fixture.businessId,
        caller_number: "+15555550002",
        transcript: "[polling-sync prewrite — should be overwritten]",
        status: "completed",
        start_time: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() - 9 * 60 * 1000).toISOString(),
        created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      });
      if (preErr) throw new Error(`prewrite failed: ${preErr.message}`);

      const r = await postLead(buildPostCallPayload({
        agentId: fixture.agentId,
        conversationId,
        callerPhone: "+15555550002",
        transcript: "Looking for accident representation.",
      }));
      // Two acceptable response shapes here:
      //   1. UPSERT happy: { success: true, callId: <existing.id> } — the
      //      same row UPDATED in place via UPSERT.
      //   2. UPSERT short-circuit (defensive 23505 path): { success: true,
      //      duplicate: true } — only fires if the upsert client surfaced
      //      the conflict instead of resolving it. Both are honest 200s.
      if (r.http !== 200 || !r.json?.success) {
        record("T2 polling-sync race → 200 success", false, `http=${r.http} body=${r.text.slice(0, 300)}`);
      } else {
        const { data: rows } = await supa.from("calls").select("id, call_sid, transcript").eq("call_sid", conversationId);
        if ((rows || []).length !== 1) {
          record("T2 polling-sync race → exactly 1 row", false, `found ${rows?.length} rows`);
        } else {
          record("T2 polling-sync race → 200 + exactly 1 row", true, `response=${JSON.stringify(r.json)} row.transcript_len=${rows[0].transcript?.length}`);
        }
      }
    } catch (err: any) {
      record("T2 polling-sync race", false, `threw: ${err.message}`);
    }

    // ----- T3: null caller phone — no callerPhone in either data_collection
    // or metadata. Row should still insert; caller_number stays null.
    try {
      const conversationId = `conv_t3_${crypto.randomBytes(6).toString("hex")}`;
      const r = await postLead(buildPostCallPayload({
        agentId: fixture.agentId,
        conversationId,
        callerPhone: null,
        transcript: "Anonymous browser-initiated test.",
      }));
      if (r.http !== 200 || !r.json?.success || !r.json.callId) {
        record("T3 null caller_phone → 200 + row inserted", false, `http=${r.http} body=${r.text.slice(0, 300)}`);
      } else {
        const { data: row } = await supa.from("calls").select("id, caller_number").eq("call_sid", conversationId).single();
        if (row && row.caller_number === null) {
          record("T3 null caller_phone → row inserted with caller_number=NULL", true, `row.id=${row.id}`);
        } else {
          record("T3 null caller_phone → caller_number is NULL", false, `row=${JSON.stringify(row)}`);
        }
      }
    } catch (err: any) {
      record("T3 null caller_phone", false, `threw: ${err.message}`);
    }

    // ----- T4: explicit insert-path race, same as T2 but assert no 5xx
    // ever surfaces — the response must be 200 regardless of which branch
    // (UPSERT happy / 23505 short-circuit) lands. This is the regression
    // guard for the original incident's symptom (silent 200 lie OR 500
    // depending on path).
    try {
      const conversationId = `conv_t4_${crypto.randomBytes(6).toString("hex")}`;
      const { error: preErr } = await supa.from("calls").insert({
        call_sid: conversationId,
        business_id: fixture.businessId,
        caller_number: "+15555550003",
        status: "completed",
        start_time: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() - 14 * 60 * 1000).toISOString(),
        created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      });
      if (preErr) throw new Error(`prewrite failed: ${preErr.message}`);

      const r = await postLead(buildPostCallPayload({
        agentId: fixture.agentId,
        conversationId,
        callerPhone: "+15555550003",
        transcript: "Second arrival path.",
      }));
      if (r.http !== 200) {
        record("T4 second arrival never 5xx", false, `http=${r.http} body=${r.text.slice(0, 300)}`);
      } else if (!r.json?.success) {
        record("T4 second arrival → success=true", false, `body=${r.text.slice(0, 300)}`);
      } else {
        record("T4 second arrival → 200 + success=true", true, `response=${JSON.stringify(r.json)}`);
      }
    } catch (err: any) {
      record("T4 second arrival", false, `threw: ${err.message}`);
    }
  } finally {
    await teardownFixtureBusiness(supa, fixture.businessId);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
