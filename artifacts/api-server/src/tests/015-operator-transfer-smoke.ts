/**
 * Operator-transfer feature smoke harness.
 *
 *   T1 — createAgentForBusiness WITH transferConfig registers the
 *        transfer_to_number system tool in the POST /v1/convai/agents/create
 *        body. Asserted by spying on global fetch (no real ElevenLabs
 *        call). Verifies the canonical JSON shape:
 *          conversation_config.agent.prompt.tools[0] = {
 *            type: "system", name: "transfer_to_number",
 *            params: { system_tool_type, transfers: [...], enable_client_message }
 *          }
 *   T2 — createAgentForBusiness WITHOUT transferConfig omits tools from
 *        the body (regression guard on existing onboarding flow).
 *   T3 — updateAgentTools with transfer_enabled=true issues
 *        GET then PATCH. PATCH body's
 *        conversation_config.agent.prompt.tools includes our transfer
 *        tool with the canonical shape.
 *   T4 — updateAgentTools with transfer_enabled=false strips
 *        the transfer_to_number tool from the PATCH body (filters
 *        existing tools, sends the rest).
 *   T5 — PUT /api/business/transfer with malformed (non-E.164) phone
 *        when transfer_enabled=true → 400.
 *   T6 — PUT /api/business/transfer with transfer_to_phone matching the
 *        business_configs.twilio_phone_number → 400 (loop guard).
 *
 * T1-T4 use direct in-process imports + fetch monkey-patch (no live
 * server needed). T5-T6 hit the running api-server at TEST_API_BASE.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/015-operator-transfer-smoke.ts
 *
 * Requires (env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  — for T5/T6 fixture business setup
 *   TEST_API_BASE                       — api-server URL, default http://localhost:8080
 *   TEST_AUTH_BEARER                    — JWT for a user belonging to the fixture business
 *                                          (required for T5/T6 since /business/transfer is
 *                                          gated by requireAuth)
 *   ELEVENLABS_API_KEY                  — set to ANY non-empty value; tests intercept the
 *                                          fetch before the key is used
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

import { createAgentForBusiness, updateAgentTools, type TransferConfig } from "../agents";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const AUTH_BEARER = process.env.TEST_AUTH_BEARER || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// Intercept global.fetch so T1-T4 don't make real ElevenLabs calls.
type Capture = { url: string; method: string; body: any };
const captured: Capture[] = [];
const origFetch = global.fetch;
function mockFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; json: any }) {
  global.fetch = (async (url: any, init?: any) => {
    const m = init?.method || "GET";
    let parsedBody: any = null;
    if (init?.body) {
      try { parsedBody = JSON.parse(init.body); } catch { parsedBody = init.body; }
    }
    captured.push({ url: String(url), method: m, body: parsedBody });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;
}
function restoreFetch() { global.fetch = origFetch; captured.length = 0; }

function findTransferTool(tools: any): any | null {
  if (!Array.isArray(tools)) return null;
  return tools.find((t: any) => t?.name === "transfer_to_number" || t?.params?.system_tool_type === "transfer_to_number") || null;
}

async function runUnitTests() {
  process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-key";

  // ----- T1: create WITH transferConfig -----
  mockFetch(() => ({ status: 200, json: { agent_id: "agent_t1_mock" } }));
  try {
    const cfg: TransferConfig = {
      phoneNumber: "+14105551234",
      condition: "When the caller asks for the owner.",
      waitMessageTemplate: "Connecting you now.",
      warmMessageTemplate: "Caller needs the owner directly.",
    };
    const result = await createAgentForBusiness({
      businessId: "biz_t1",
      businessName: "Test Biz T1",
      systemPrompt: "You are helpful.",
      transferConfig: cfg,
    });
    const sent = captured.find((c) => c.url.includes("/convai/agents/create"));
    const tools = sent?.body?.conversation_config?.agent?.prompt?.tools;
    const tool = findTransferTool(tools);
    if (!result.success) {
      record("T1 create WITH transferConfig", false, `createAgent returned !success: ${JSON.stringify(result)}`);
    } else if (!tool) {
      record("T1 create WITH transferConfig", false, `transfer tool not in body: ${JSON.stringify(sent?.body).slice(0, 300)}`);
    } else if (tool.type !== "system" || tool.params?.system_tool_type !== "transfer_to_number") {
      record("T1 create WITH transferConfig", false, `wrong shape: ${JSON.stringify(tool).slice(0, 300)}`);
    } else if (tool.params.transfers?.[0]?.transfer_destination?.phone_number !== "+14105551234") {
      record("T1 create WITH transferConfig", false, `phone not propagated: ${JSON.stringify(tool.params.transfers).slice(0, 200)}`);
    } else if (tool.params.transfers[0].transfer_type !== "conference") {
      record("T1 create WITH transferConfig", false, `transfer_type !== conference: ${tool.params.transfers[0].transfer_type}`);
    } else {
      record("T1 create WITH transferConfig", true, "transfer_to_number tool in prompt.tools, correct shape");
    }
  } finally {
    restoreFetch();
  }

  // ----- T2: create WITHOUT transferConfig -----
  mockFetch(() => ({ status: 200, json: { agent_id: "agent_t2_mock" } }));
  try {
    await createAgentForBusiness({
      businessId: "biz_t2",
      businessName: "Test Biz T2",
      systemPrompt: "You are helpful.",
    });
    const sent = captured.find((c) => c.url.includes("/convai/agents/create"));
    const tools = sent?.body?.conversation_config?.agent?.prompt?.tools;
    if (tools !== undefined) {
      record("T2 create WITHOUT transferConfig (no tools)", false, `tools present unexpectedly: ${JSON.stringify(tools).slice(0, 200)}`);
    } else {
      record("T2 create WITHOUT transferConfig (no tools)", true, "prompt.tools absent");
    }
  } finally {
    restoreFetch();
  }

  // T3 + T4 need a Supabase client because updateAgentTools reads
  // business_configs. Skip gracefully if SUPABASE env not present.
  if (!SUPABASE_URL || !SERVICE_KEY) {
    record("T3 updateAgentTools enabled (skipped)", true, "no SUPABASE_URL/SERVICE_KEY");
    record("T4 updateAgentTools disabled (skipped)", true, "no SUPABASE_URL/SERVICE_KEY");
    return;
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const suffix = crypto.randomBytes(4).toString("hex");
  const fixtureBiz = `biz_test_t34_${Date.now()}_${suffix}`;
  const fixtureAgent = `agent_test_t34_${Date.now()}_${suffix}`;
  const { error: insErr } = await supa.from("business_configs").insert({
    business_id: fixtureBiz,
    business_name: "T34 Fixture",
    industry: "general",
    phone_number: "+15555550000",
    email: `t34-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    agent_id: fixtureAgent,
    transfer_enabled: true,
    transfer_to_phone: "+14105557777",
    transfer_conditions: "When caller asks for the owner.",
    transfer_wait_message: "Hold for one moment.",
    transfer_warm_message: "Incoming Neverr call for {business_name}.",
    created_at: new Date().toISOString(),
  });
  if (insErr) {
    record("T3/T4 fixture setup", false, `insert failed: ${insErr.message}`);
    return;
  }

  try {
    // ----- T3: updateAgentTools with enabled=true -----
    const fixturePromptText = "You are a helpful receptionist for T34 Fixture.";
    mockFetch((url, init) => {
      if (init?.method === "PATCH") return { status: 200, json: {} };
      // GET — return an agent with NO existing tools but a real prompt
      return { status: 200, json: { agent_id: fixtureAgent, conversation_config: { agent: { prompt: { prompt: fixturePromptText, tools: [] } } } } };
    });
    try {
      const r = await updateAgentTools(supa, fixtureBiz);
      const patch = captured.find((c) => c.method === "PATCH" && c.url.includes(fixtureAgent));
      const promptPatched = patch?.body?.conversation_config?.agent?.prompt;
      const tools = promptPatched?.tools;
      const tool = findTransferTool(tools);
      if (!r.success) {
        record("T3 updateAgentTools enabled", false, `returned !success: ${JSON.stringify(r)}`);
      } else if (!tool) {
        record("T3 updateAgentTools enabled", false, `tool missing from PATCH: ${JSON.stringify(patch?.body).slice(0, 300)}`);
      } else if (tool.params?.transfers?.[0]?.transfer_destination?.phone_number !== "+14105557777") {
        record("T3 updateAgentTools enabled", false, `phone wrong: ${JSON.stringify(tool.params.transfers).slice(0, 200)}`);
      } else if (!tool.description.includes("Incoming Neverr call for T34 Fixture")) {
        record("T3 updateAgentTools enabled (interpolation)", false, `{business_name} not interpolated: ${tool.description.slice(0, 300)}`);
      } else if (promptPatched?.prompt !== fixturePromptText) {
        // Belt-and-suspenders: ensure the existing system prompt is echoed
        // back in the PATCH so a non-merging PATCH semantic on
        // conversation_config.agent.prompt doesn't wipe the prompt.
        record("T3 prompt echo (anti-wipe)", false, `prompt not echoed back: got ${JSON.stringify(promptPatched?.prompt)}`);
      } else {
        record("T3 enabled + interpolation + prompt echo", true, "PATCH contains correct tool, interpolated warm message, AND echoes prompt text");
      }
    } finally {
      restoreFetch();
    }

    // ----- T4: flip to disabled, strip the tool -----
    await supa.from("business_configs").update({ transfer_enabled: false }).eq("business_id", fixtureBiz);
    mockFetch((url, init) => {
      if (init?.method === "PATCH") return { status: 200, json: {} };
      // GET — return the agent WITH our transfer tool already present
      return {
        status: 200,
        json: {
          agent_id: fixtureAgent,
          conversation_config: {
            agent: {
              prompt: {
                prompt: "you are helpful",
                tools: [
                  { type: "system", name: "transfer_to_number", params: { system_tool_type: "transfer_to_number", transfers: [{ transfer_destination: { type: "phone", phone_number: "+14105557777" }, condition: "x", transfer_type: "conference" }] } },
                  { type: "function", name: "some_other_tool" },
                ],
              },
            },
          },
        },
      };
    });
    try {
      const r = await updateAgentTools(supa, fixtureBiz);
      const patch = captured.find((c) => c.method === "PATCH" && c.url.includes(fixtureAgent));
      const tools = patch?.body?.conversation_config?.agent?.prompt?.tools;
      const transferTool = findTransferTool(tools);
      const hasOther = Array.isArray(tools) && tools.some((t: any) => t?.name === "some_other_tool");
      if (!r.success) {
        record("T4 updateAgentTools disabled", false, `returned !success: ${JSON.stringify(r)}`);
      } else if (transferTool) {
        record("T4 updateAgentTools disabled", false, `transfer tool still present in PATCH: ${JSON.stringify(transferTool).slice(0, 200)}`);
      } else if (!hasOther) {
        record("T4 preserves OTHER tools", false, `non-transfer tool got stripped: ${JSON.stringify(tools)}`);
      } else {
        record("T4 updateAgentTools disabled + preserves others", true, "transfer tool stripped, other tools preserved");
      }
    } finally {
      restoreFetch();
    }
  } finally {
    await supa.from("business_configs").delete().eq("business_id", fixtureBiz);
  }
}

async function runRouteTests() {
  if (!AUTH_BEARER || !SUPABASE_URL || !SERVICE_KEY) {
    record("T5 malformed phone (skipped)", true, "no TEST_AUTH_BEARER / SUPABASE env");
    record("T6 loop guard (skipped)", true, "no TEST_AUTH_BEARER / SUPABASE env");
    return;
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  // The auth JWT determines which business the route operates on. Find
  // that business and stamp it with a known twilio_phone_number so T6
  // can collide.
  const meRes = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${AUTH_BEARER}` } });
  if (!meRes.ok) {
    record("T5/T6 prep", false, `/auth/me failed: ${meRes.status}`);
    return;
  }
  const me = (await meRes.json()) as { current_business_id?: string };
  const businessId = me?.current_business_id;
  if (!businessId) {
    record("T5/T6 prep", false, "no current_business_id from /auth/me");
    return;
  }
  // Stamp a known twilio_phone_number on this business so the loop guard
  // has something to collide with. Restored at the end.
  const { data: pre } = await supa.from("business_configs").select("twilio_phone_number").eq("business_id", businessId).maybeSingle();
  const originalTwilio = (pre as { twilio_phone_number?: string | null } | null)?.twilio_phone_number ?? null;
  await supa.from("business_configs").update({ twilio_phone_number: "+14433314649" }).eq("business_id", businessId);

  try {
    // ----- T5: malformed phone -----
    const r5 = await fetch(`${API}/api/business/transfer`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_BEARER}` },
      body: JSON.stringify({
        transfer_enabled: true,
        transfer_to_phone: "not-a-phone",
        transfer_conditions: "any",
      }),
    });
    if (r5.status === 400) {
      record("T5 malformed phone → 400", true, "http=400");
    } else {
      record("T5 malformed phone → 400", false, `http=${r5.status} body=${(await r5.text()).slice(0, 200)}`);
    }

    // ----- T6: loop guard -----
    const r6 = await fetch(`${API}/api/business/transfer`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_BEARER}` },
      body: JSON.stringify({
        transfer_enabled: true,
        transfer_to_phone: "+14433314649", // matches twilio_phone_number we stamped
        transfer_conditions: "any",
      }),
    });
    const r6body = (await r6.json().catch(() => ({}))) as { error?: string };
    if (r6.status === 400 && /loop/i.test(r6body?.error || "")) {
      record("T6 loop guard → 400 with loop error", true, `error=${(r6body.error || "").slice(0, 100)}`);
    } else {
      record("T6 loop guard → 400 with loop error", false, `http=${r6.status} body=${JSON.stringify(r6body).slice(0, 200)}`);
    }
  } finally {
    await supa.from("business_configs").update({ twilio_phone_number: originalTwilio }).eq("business_id", businessId);
  }
}

async function main() {
  await runUnitTests();
  await runRouteTests();

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
