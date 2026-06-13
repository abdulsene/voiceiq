/**
 * Leads-capture tools wiring smoke harness.
 *
 *   T1 — Signup-flow simulation: createAgentForBusiness followed by
 *        updateAgentTools (the same chain the onboard / auth signup
 *        routes now run). Assert the resulting PATCH body contains
 *        the request_callback webhook tool with the canonical shape.
 *   T2 — Missing ELEVENLABS_TOOL_SECRET: updateAgentTools should
 *        return { success:false, error:'tool_secret_missing' } AND
 *        should NOT issue a PATCH. This is the Slice 1 silent-skip
 *        bug; the regression guard locks in the hard-error behavior.
 *
 * Both tests intercept global.fetch — no live ElevenLabs calls.
 * T1 requires SUPABASE_URL/SERVICE_KEY because updateAgentTools reads
 * business_configs; skipped gracefully when absent.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/019-leads-capture-tools-smoke.ts
 *
 * Requires (env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  — for T1 fixture business setup
 *   ELEVENLABS_API_KEY                  — any non-empty value; tests intercept fetch
 *
 * Env knobs:
 *   ELEVENLABS_TOOL_SECRET is SET inside T1 and UNSET inside T2;
 *   the original env value is restored on exit.
 */
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

import { createAgentForBusiness, updateAgentTools } from "../agents";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

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

function findCallbackTool(tools: any): any | null {
  if (!Array.isArray(tools)) return null;
  return tools.find((t: any) => t?.name === "request_callback") || null;
}

async function runTests() {
  const origToolSecret = process.env.ELEVENLABS_TOOL_SECRET;
  const origApiKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = origApiKey || "test-key";

  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      record("T1 signup-flow callback registration (skipped)", true, "no SUPABASE_URL/SERVICE_KEY");
      record("T2 missing secret hard error (skipped)", true, "no SUPABASE_URL/SERVICE_KEY");
      return;
    }

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const suffix = crypto.randomBytes(4).toString("hex");
    const fixtureBiz = `biz_test_019_${Date.now()}_${suffix}`;
    const fixtureAgent = `agent_test_019_${Date.now()}_${suffix}`;

    const { error: insErr } = await supa.from("business_configs").insert({
      business_id: fixtureBiz,
      business_name: "T019 Fixture",
      industry: "general",
      phone_number: "+15555550000",
      email: `t019-${suffix}@neverr.test`,
      timezone: "America/New_York",
      business_hours: "Monday-Friday 9AM-5PM",
      status: "active",
      subscription_status: "trialing",
      agent_id: fixtureAgent,
      transfer_enabled: false,
      created_at: new Date().toISOString(),
    });
    if (insErr) {
      record("T1/T2 fixture setup", false, `insert failed: ${insErr.message}`);
      return;
    }

    try {
      // ----- T1: signup chain registers request_callback -----
      process.env.ELEVENLABS_TOOL_SECRET = "test-tool-secret";
      const fixturePromptText = "You are a helpful receptionist for T019 Fixture.";
      mockFetch((_url, init) => {
        if (init?.method === "POST") {
          // createAgentForBusiness POST /v1/convai/agents/create
          return { status: 200, json: { agent_id: fixtureAgent } };
        }
        if (init?.method === "PATCH") return { status: 200, json: {} };
        // GET inside updateAgentTools
        return {
          status: 200,
          json: {
            agent_id: fixtureAgent,
            conversation_config: { agent: { prompt: { prompt: fixturePromptText, tools: [] } } },
          },
        };
      });
      try {
        const createResult = await createAgentForBusiness({
          businessId: fixtureBiz,
          businessName: "T019 Fixture",
          systemPrompt: fixturePromptText,
        });
        const toolsResult = await updateAgentTools(supa, fixtureBiz);

        const patch = captured.find((c) => c.method === "PATCH" && c.url.includes(fixtureAgent));
        const tools = patch?.body?.conversation_config?.agent?.prompt?.tools;
        const callbackTool = findCallbackTool(tools);

        if (!createResult.success) {
          record("T1 signup chain", false, `createAgent !success: ${JSON.stringify(createResult)}`);
        } else if (!toolsResult.success) {
          record("T1 signup chain", false, `updateAgentTools !success: ${JSON.stringify(toolsResult)}`);
        } else if (!callbackTool) {
          record("T1 signup chain", false, `request_callback missing from PATCH: ${JSON.stringify(tools).slice(0, 300)}`);
        } else if (callbackTool.type !== "webhook") {
          record("T1 signup chain", false, `wrong tool type: ${callbackTool.type}`);
        } else if (callbackTool.api_schema?.request_body_schema?.properties?.business_id?.constant_value !== fixtureBiz) {
          record("T1 signup chain", false, `business_id not baked in tool config: ${JSON.stringify(callbackTool.api_schema?.request_body_schema?.properties?.business_id)}`);
        } else if (!callbackTool.api_schema?.request_headers?.Authorization?.includes("test-tool-secret")) {
          record("T1 signup chain", false, `tool secret not propagated in Authorization header`);
        } else {
          record("T1 signup chain (create + tools sync)", true, "request_callback registered with baked business_id + bearer secret");
        }
      } finally {
        restoreFetch();
      }

      // ----- T2: missing secret = hard error, no PATCH -----
      delete process.env.ELEVENLABS_TOOL_SECRET;
      mockFetch((_url, init) => {
        if (init?.method === "PATCH") return { status: 200, json: {} };
        return {
          status: 200,
          json: {
            agent_id: fixtureAgent,
            conversation_config: { agent: { prompt: { prompt: "you are helpful", tools: [] } } },
          },
        };
      });
      try {
        const r = await updateAgentTools(supa, fixtureBiz);
        const patch = captured.find((c) => c.method === "PATCH" && c.url.includes(fixtureAgent));
        if (r.success) {
          record("T2 missing secret hard error", false, "expected !success but got success=true");
        } else if (r.error !== "tool_secret_missing") {
          record("T2 missing secret hard error", false, `wrong error code: ${r.error}`);
        } else if (patch) {
          record("T2 missing secret hard error", false, "PATCH was issued anyway — should have aborted before PATCH");
        } else {
          record("T2 missing secret hard error (no silent skip)", true, "tool_secret_missing returned + no PATCH issued");
        }
      } finally {
        restoreFetch();
      }
    } finally {
      await supa.from("business_configs").delete().eq("business_id", fixtureBiz);
    }
  } finally {
    if (origToolSecret === undefined) delete process.env.ELEVENLABS_TOOL_SECRET;
    else process.env.ELEVENLABS_TOOL_SECRET = origToolSecret;
    if (origApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = origApiKey;
  }
}

runTests()
  .then(() => {
    const fails = results.filter((r) => !r.pass);
    console.log(`\n${results.length - fails.length}/${results.length} passed`);
    process.exit(fails.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("Smoke harness crashed:", err);
    process.exit(2);
  });
