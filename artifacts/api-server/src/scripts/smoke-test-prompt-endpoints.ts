/**
 * Sprint 3 Stage 4 — production smoke test for the 6 prompt endpoints.
 *
 * Exercises GET / PATCH / POST against the live deployment at
 * BASE_URL (default https://neverr.ai), verifies expected DB state via
 * service-role Supabase access, and verifies ElevenLabs-side sync via
 * the lib/elevenlabs-agent.ts fetchAgentPrompt helper.
 *
 * Idempotent: each run snapshots the pre-test state of both
 * affected businesses (demo-business + EZ Rentals biz_1779288494109_z4z979)
 * and restores them at the end. Exception: helper fields that were
 * NULL pre-test are NOT restored to NULL (the API's helper-validator
 * rejects empty strings) — instead the script logs a suggested cleanup
 * SQL statement under MANUAL CLEANUP.
 *
 * Auth strategies (resolved at startup):
 *   - Option 4 (preferred): sign a 60s JWT against SUPABASE_JWT_SECRET
 *     with sub=Abdul's user UUID. No email side effect.
 *   - Option 2 (fallback): admin.generateLink + verifyOtp.
 *     Side effect: emails Abdul a magic link every run.
 *
 * Override: set SMOKE_TEST_AUTH_MODE=option2 to force the fallback
 * even when SUPABASE_JWT_SECRET is present (for verifying the
 * fallback path itself works).
 *
 * Run via:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/smoke-test-prompt-endpoints.ts
 *
 * Required env (all present on Replit production):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - ELEVENLABS_API_KEY
 *   - SUPABASE_JWT_SECRET   (optional — gates Option 4)
 *   - BASE_URL              (optional — defaults to https://neverr.ai)
 *
 * Exit codes:
 *   0 — all PASS
 *   1 — at least one functional FAIL
 *   2 — rollback failure (manual recovery needed; snapshot printed)
 *   3 — infrastructure / auth failure
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import jwt from "jsonwebtoken";
import { fetchAgentPrompt } from "../lib/elevenlabs-agent";

// ───────────────────────────────────────────────────────────────────────
// Constants

const ABDUL_UUID = "b4c3dece-8715-4fa8-89a7-00b555f2b7c4";
const ABDUL_EMAIL = "abdul.sene@gtacfinance.com";
const DEMO_BUSINESS_ID = "demo-business";
const DEMO_AGENT_ID = "agent_6801kky8ktepegyszgc4kgtxsvpx";
const EZ_RENTALS_BUSINESS_ID = "biz_1779288494109_z4z979";

const DEFAULT_BASE_URL = "https://neverr.ai";
const JWT_EXP_SECONDS = 60;

const STARTED_AT = new Date();
const MARKER = `[SMOKE TEST ${STARTED_AT.toISOString()}]`;

// Banner-style logging helpers ----------------------------------------

function banner(text: string): void {
  const line = "━".repeat(72);
  console.log("");
  console.log(line);
  console.log(`  ${text}`);
  console.log(line);
}

function section(text: string): void {
  console.log("");
  console.log(`── ${text} ──`);
}

function logCheck(name: string, ok: boolean, detail?: string): boolean {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
  return ok;
}

// ───────────────────────────────────────────────────────────────────────
// Step result tracking

type StepStatus = "PASS" | "FAIL" | "SKIPPED";

interface StepResult {
  name: string;
  status: StepStatus;
  durationMs: number;
  details?: string;
}

const stepResults: StepResult[] = [];
const manualCleanupSql: string[] = [];

async function runStep(
  name: string,
  fn: () => Promise<{ status: StepStatus; details?: string }>,
): Promise<StepResult> {
  banner(name);
  const start = Date.now();
  let result: { status: StepStatus; details?: string };
  try {
    result = await fn();
  } catch (err: any) {
    result = {
      status: "FAIL",
      details: `EXCEPTION: ${err?.message ?? String(err)}`,
    };
    console.error("  EXCEPTION:", err);
  }
  const durationMs = Date.now() - start;
  const stepResult: StepResult = { name, ...result, durationMs };
  stepResults.push(stepResult);
  const symbol =
    result.status === "PASS" ? "✅" : result.status === "SKIPPED" ? "⏭ " : "❌";
  console.log(
    `${symbol} ${name} — ${result.status} (${durationMs}ms)${
      result.details ? " — " + result.details : ""
    }`,
  );
  return stepResult;
}

// ───────────────────────────────────────────────────────────────────────
// Env validation

interface ResolvedEnv {
  supabaseUrl: string;
  supabaseServiceKey: string;
  elevenLabsApiKey: string;
  baseUrl: string;
  supabaseJwtSecret: string | null;
  forceOption2: boolean;
}

function resolveEnv(): ResolvedEnv {
  const missing: string[] = [];
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseServiceKey) missing.push("SUPABASE_SERVICE_KEY");
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  if (!elevenLabsApiKey) missing.push("ELEVENLABS_API_KEY");

  if (missing.length > 0) {
    console.error(
      `\n[smoke] FATAL: missing required env vars: ${missing.join(", ")}\n`,
    );
    process.exit(3);
  }

  return {
    supabaseUrl: supabaseUrl!,
    supabaseServiceKey: supabaseServiceKey!,
    elevenLabsApiKey: elevenLabsApiKey!,
    baseUrl: (process.env.BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    supabaseJwtSecret: process.env.SUPABASE_JWT_SECRET || null,
    forceOption2: process.env.SMOKE_TEST_AUTH_MODE === "option2",
  };
}

// ───────────────────────────────────────────────────────────────────────
// Auth strategies

interface AuthResolution {
  mode: "option4_jwt" | "option2_generatelink";
  bearer: string;
}

async function authenticate(
  env: ResolvedEnv,
  sbAdmin: SupabaseClient,
): Promise<AuthResolution> {
  const wantOption4 = !env.forceOption2 && env.supabaseJwtSecret;

  if (env.forceOption2) {
    console.log(
      "[auth] SMOKE_TEST_AUTH_MODE=option2 is set — forcing fallback strategy.",
    );
  } else if (!env.supabaseJwtSecret) {
    console.warn("");
    console.warn("⚠  SUPABASE_JWT_SECRET not set — falling back to Option 2.");
    console.warn("⚠  This will email a magic-link to", ABDUL_EMAIL, "on EVERY run.");
    console.warn(
      "⚠  To suppress emails: add SUPABASE_JWT_SECRET to Replit Secrets.",
    );
    console.warn(
      "⚠  Find the value in Supabase dashboard → Project Settings →",
    );
    console.warn("⚠  API → JWT Settings → JWT Secret.");
    console.warn("");
  }

  if (wantOption4) {
    section("AUTH — Option 4 (signed JWT)");
    const nowSec = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      {
        sub: ABDUL_UUID,
        email: ABDUL_EMAIL,
        aud: "authenticated",
        role: "authenticated",
        iat: nowSec,
        exp: nowSec + JWT_EXP_SECONDS,
      },
      env.supabaseJwtSecret!,
      { algorithm: "HS256" },
    );
    console.log(`  signed JWT, exp in ${JWT_EXP_SECONDS}s, sub=${ABDUL_UUID}`);
    return { mode: "option4_jwt", bearer: token };
  }

  section("AUTH — Option 2 (generateLink + verifyOtp)");
  const { data: linkData, error: linkErr } = await sbAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: ABDUL_EMAIL,
  });
  if (linkErr || !linkData?.properties) {
    throw new Error(
      `generateLink failed: ${linkErr?.message ?? "no properties in response"}`,
    );
  }
  const props = linkData.properties as {
    hashed_token?: string;
    email_otp?: string;
  };
  const tokenHash = props.hashed_token;
  if (!tokenHash) {
    throw new Error(
      "generateLink response missing hashed_token; cannot proceed with Option 2",
    );
  }
  const { data: verifyData, error: verifyErr } = await sbAdmin.auth.verifyOtp({
    token_hash: tokenHash,
    type: "magiclink",
  });
  if (verifyErr || !verifyData.session?.access_token) {
    throw new Error(
      `verifyOtp failed: ${verifyErr?.message ?? "no session in response"}`,
    );
  }
  console.log(
    `  Option 2 produced a session; access_token len=${verifyData.session.access_token.length}`,
  );
  console.log(`  (magic-link email sent to ${ABDUL_EMAIL})`);
  return { mode: "option2_generatelink", bearer: verifyData.session.access_token };
}

// ───────────────────────────────────────────────────────────────────────
// HTTP helper

interface ApiResponse<T = any> {
  status: number;
  body: T;
  ok: boolean;
}

interface HttpCallOpts {
  bearer: string;
  activeBusinessId: string;
  method: string;
  path: string;
  body?: unknown;
}

async function apiCall<T = any>(
  baseUrl: string,
  opts: HttpCallOpts,
): Promise<ApiResponse<T>> {
  const url = `${baseUrl}${opts.path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.bearer}`,
    "x-active-business": opts.activeBusinessId,
    "content-type": "application/json",
  };
  console.log(`  → ${opts.method} ${opts.path}`);
  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  console.log(
    `  ← ${res.status} (${text.length} bytes)${
      typeof parsed === "object" && parsed?.ok !== undefined ? ` ok=${parsed.ok}` : ""
    }`,
  );
  return { status: res.status, body: parsed as T, ok: res.ok };
}

// ───────────────────────────────────────────────────────────────────────
// Snapshot + rollback

interface BusinessSnapshot {
  business_id: string;
  system_prompt: string | null;
  agent_id: string | null;
  prompt_updated_at: string | null;
  prompt_helpers_dirty_at: string | null;
  tone_preference: string | null;
  custom_faqs: unknown;
  never_say_list: unknown;
  objection_handling: unknown;
  tone: string | null;
  after_hours_message: string | null;
}

const HELPER_FIELDS: Array<keyof BusinessSnapshot> = [
  "tone_preference",
  "custom_faqs",
  "never_say_list",
  "objection_handling",
  "tone",
  "after_hours_message",
];

async function snapshotBusiness(
  sb: SupabaseClient,
  businessId: string,
): Promise<BusinessSnapshot> {
  const { data, error } = await sb
    .from("business_configs")
    .select(
      "business_id, system_prompt, agent_id, prompt_updated_at, prompt_helpers_dirty_at, tone_preference, custom_faqs, never_say_list, objection_handling, tone, after_hours_message",
    )
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    throw new Error(`snapshotBusiness(${businessId}) failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(`snapshotBusiness(${businessId}): row not found`);
  }
  return data as BusinessSnapshot;
}

// ───────────────────────────────────────────────────────────────────────
// Test fixtures

const SMOKE_PROMPT = `You are Alex, the professional AI receptionist for SMOKE TEST. ${MARKER}`;
const ADMIN_SMOKE_PROMPT = `You are Alex, the professional AI receptionist for SMOKE TEST (ADMIN OVERRIDE). ${MARKER}`;
const SMOKE_TONE_PREFERENCE = `warm, professional ${MARKER}`;

// ───────────────────────────────────────────────────────────────────────
// Main

async function main(): Promise<void> {
  banner("STEP 0 — Environment + target");
  const env = resolveEnv();
  console.log(`  BASE_URL          = ${env.baseUrl}`);
  console.log(`  SUPABASE_URL      = ${env.supabaseUrl}`);
  console.log(
    `  SUPABASE_JWT_SECRET present: ${env.supabaseJwtSecret ? "yes" : "no"}`,
  );
  console.log(`  SMOKE_TEST_AUTH_MODE=${process.env.SMOKE_TEST_AUTH_MODE ?? "(unset)"}`);
  console.log(`  Marker            = ${MARKER}`);
  console.log(`  Test user         = ${ABDUL_EMAIL} (${ABDUL_UUID})`);
  console.log(`  Owner business    = ${DEMO_BUSINESS_ID} (agent ${DEMO_AGENT_ID})`);
  console.log(`  Admin target      = ${EZ_RENTALS_BUSINESS_ID}`);

  const sbAdmin = createClient(env.supabaseUrl, env.supabaseServiceKey, {
    auth: { persistSession: false },
  });

  // STEP 1 ─────────────────────────────────────────────────────────────
  let bearer: string;
  let authMode: AuthResolution["mode"];
  await runStep("STEP 1 — Authenticate", async () => {
    const auth = await authenticate(env, sbAdmin);
    bearer = auth.bearer;
    authMode = auth.mode;
    // Quick sanity: a probe call should not 401.
    const probe = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "GET",
      path: "/api/business/prompt",
    });
    if (probe.status === 401) {
      throw new Error("auth probe returned 401 — bearer not accepted");
    }
    return {
      status: "PASS",
      details: `mode=${auth.mode}, probe HTTP ${probe.status}`,
    };
  });

  if (!stepResults[stepResults.length - 1] || stepResults[stepResults.length - 1].status !== "PASS") {
    console.error("\n[smoke] Authentication failed; cannot proceed.\n");
    finalReport(3);
    process.exit(3);
  }

  // STEP 2 ─────────────────────────────────────────────────────────────
  let demoSnapshot!: BusinessSnapshot;
  let ezSnapshot!: BusinessSnapshot;
  await runStep("STEP 2 — Snapshot demo-business + EZ Rentals", async () => {
    demoSnapshot = await snapshotBusiness(sbAdmin, DEMO_BUSINESS_ID);
    ezSnapshot = await snapshotBusiness(sbAdmin, EZ_RENTALS_BUSINESS_ID);
    console.log(
      `  demo-business system_prompt: ${demoSnapshot.system_prompt?.length ?? "null"} chars`,
    );
    console.log(`  demo-business agent_id: ${demoSnapshot.agent_id}`);
    console.log(
      `  demo-business tone_preference: ${demoSnapshot.tone_preference === null ? "NULL" : JSON.stringify(demoSnapshot.tone_preference).slice(0, 60)}`,
    );
    console.log(
      `  EZ Rentals system_prompt: ${ezSnapshot.system_prompt?.length ?? "null"} chars`,
    );
    console.log(`  EZ Rentals agent_id: ${ezSnapshot.agent_id}`);
    if (!demoSnapshot.agent_id) {
      return {
        status: "FAIL",
        details: "demo-business has no agent_id; cannot proceed with sync tests",
      };
    }
    if (!ezSnapshot.agent_id) {
      return {
        status: "FAIL",
        details:
          "EZ Rentals has no agent_id; Step 7 admin save will return 409",
      };
    }
    return { status: "PASS" };
  });

  // STEP 3 ─────────────────────────────────────────────────────────────
  await runStep("STEP 3 — GET /api/business/prompt", async () => {
    const res = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "GET",
      path: "/api/business/prompt",
    });
    if (res.status !== 200) {
      return { status: "FAIL", details: `HTTP ${res.status}` };
    }
    const passes = [
      logCheck(
        "business_id matches demo-business",
        res.body.business_id === DEMO_BUSINESS_ID,
        `got ${res.body.business_id}`,
      ),
      logCheck(
        "agent_id matches snapshot",
        res.body.agent_id === demoSnapshot.agent_id,
        `got ${res.body.agent_id}`,
      ),
      logCheck("system_prompt non-null", typeof res.body.system_prompt === "string"),
    ];
    return {
      status: passes.every((p) => p) ? "PASS" : "FAIL",
    };
  });

  // STEP 4 ─────────────────────────────────────────────────────────────
  await runStep("STEP 4 — PATCH /api/business/prompt/helpers (tone_preference)", async () => {
    const patchRes = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "PATCH",
      path: "/api/business/prompt/helpers",
      body: { tone_preference: SMOKE_TONE_PREFERENCE },
    });
    if (patchRes.status !== 200) {
      return { status: "FAIL", details: `HTTP ${patchRes.status}` };
    }
    const passes = [
      logCheck("response.ok === true", patchRes.body.ok === true),
      logCheck(
        "response.updated includes tone_preference",
        Array.isArray(patchRes.body.updated) &&
          patchRes.body.updated.includes("tone_preference"),
      ),
      logCheck(
        "response.dirty_at is ISO timestamp",
        typeof patchRes.body.dirty_at === "string" &&
          /T.*Z$/.test(patchRes.body.dirty_at),
      ),
    ];

    // Re-GET to verify DB state.
    const getRes = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "GET",
      path: "/api/business/prompt",
    });
    passes.push(
      logCheck(
        "GET shows tone_preference === marker",
        getRes.body.tone_preference === SMOKE_TONE_PREFERENCE,
        `got ${JSON.stringify(getRes.body.tone_preference).slice(0, 80)}`,
      ),
    );
    passes.push(
      logCheck(
        "GET shows prompt_helpers_dirty_at non-null",
        typeof getRes.body.prompt_helpers_dirty_at === "string",
      ),
    );
    return { status: passes.every((p) => p) ? "PASS" : "FAIL" };
  });

  // STEP 5 ─────────────────────────────────────────────────────────────
  await runStep("STEP 5 — PATCH /api/business/prompt (raw save + ElevenLabs sync)", async () => {
    const patchRes = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "PATCH",
      path: "/api/business/prompt",
      body: { system_prompt: SMOKE_PROMPT },
    });
    if (patchRes.status !== 200) {
      return { status: "FAIL", details: `HTTP ${patchRes.status}` };
    }
    const passes = [
      logCheck("response.ok === true", patchRes.body.ok === true),
      logCheck(
        "charsWritten matches sent length",
        patchRes.body.charsWritten === SMOKE_PROMPT.length,
        `got ${patchRes.body.charsWritten} vs ${SMOKE_PROMPT.length}`,
      ),
      logCheck(
        "auditLogId is non-null",
        typeof patchRes.body.auditLogId === "string" &&
          patchRes.body.auditLogId.length > 0,
      ),
    ];

    // Verify against ElevenLabs.
    section("Step 5 — verify via ElevenLabs fetchAgentPrompt");
    const elFetch = await fetchAgentPrompt(demoSnapshot.agent_id!, "en");
    if (!elFetch.ok) {
      passes.push(
        logCheck("ElevenLabs fetchAgentPrompt ok", false, elFetch.error),
      );
    } else {
      passes.push(
        logCheck(
          "ElevenLabs prompt === sent",
          elFetch.prompt === SMOKE_PROMPT,
          `len ${elFetch.prompt?.length ?? "null"} vs ${SMOKE_PROMPT.length}`,
        ),
      );
    }

    // Verify DB sync-state via direct query.
    section("Step 5 — verify business_configs sync state");
    const { data: row, error: rowErr } = await sbAdmin
      .from("business_configs")
      .select(
        "prompt_updated_at, prompt_updated_by, prompt_last_synced_at, prompt_sync_error",
      )
      .eq("business_id", DEMO_BUSINESS_ID)
      .maybeSingle();
    if (rowErr || !row) {
      passes.push(logCheck("supabase read of demo-business state", false, rowErr?.message));
    } else {
      const r = row as Record<string, unknown>;
      passes.push(logCheck("prompt_updated_at non-null", typeof r.prompt_updated_at === "string"));
      passes.push(
        logCheck(
          "prompt_updated_by === abdul UUID",
          r.prompt_updated_by === ABDUL_UUID,
          `got ${r.prompt_updated_by}`,
        ),
      );
      passes.push(
        logCheck("prompt_last_synced_at non-null", typeof r.prompt_last_synced_at === "string"),
      );
      passes.push(logCheck("prompt_sync_error === null", r.prompt_sync_error === null));
    }

    // Verify audit log row.
    section("Step 5 — verify prompt_audit_log row");
    const { data: auditRow, error: auditErr } = await sbAdmin
      .from("prompt_audit_log")
      .select("id, source, sync_to_elevenlabs_ok, new_prompt, changed_by_user_id")
      .eq("id", patchRes.body.auditLogId)
      .maybeSingle();
    if (auditErr || !auditRow) {
      passes.push(logCheck("audit log row exists", false, auditErr?.message));
    } else {
      const a = auditRow as Record<string, unknown>;
      passes.push(logCheck("audit.source === owner_raw", a.source === "owner_raw"));
      passes.push(
        logCheck("audit.sync_to_elevenlabs_ok === true", a.sync_to_elevenlabs_ok === true),
      );
      passes.push(logCheck("audit.changed_by_user_id === abdul", a.changed_by_user_id === ABDUL_UUID));
      passes.push(logCheck("audit.new_prompt === sent", a.new_prompt === SMOKE_PROMPT));
    }
    return { status: passes.every((p) => p) ? "PASS" : "FAIL" };
  });

  // STEP 6 ─────────────────────────────────────────────────────────────
  await runStep("STEP 6 — POST /api/business/prompt/regenerate", async () => {
    const res = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "POST",
      path: "/api/business/prompt/regenerate",
      body: {},
    });
    if (res.status !== 200) {
      return { status: "FAIL", details: `HTTP ${res.status}` };
    }
    const passes = [
      logCheck("response.ok === true", res.body.ok === true),
      logCheck(
        "auditLogId non-null",
        typeof res.body.auditLogId === "string" && res.body.auditLogId.length > 0,
      ),
    ];

    // Verify the rendered prompt looks correct.
    section("Step 6 — verify rendered prompt shape");
    const getAfter = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "GET",
      path: "/api/business/prompt",
    });
    passes.push(
      logCheck(
        "rendered prompt starts with 'You are Alex'",
        typeof getAfter.body.system_prompt === "string" &&
          (getAfter.body.system_prompt as string).startsWith("You are Alex"),
      ),
    );
    passes.push(
      logCheck(
        "prompt_helpers_dirty_at cleared (null)",
        getAfter.body.prompt_helpers_dirty_at === null,
      ),
    );

    // Verify audit log row.
    const { data: auditRow } = await sbAdmin
      .from("prompt_audit_log")
      .select("id, source")
      .eq("id", res.body.auditLogId)
      .maybeSingle();
    passes.push(
      logCheck(
        "audit.source === owner_helpers_regen",
        (auditRow as { source?: string } | null)?.source === "owner_helpers_regen",
      ),
    );
    return { status: passes.every((p) => p) ? "PASS" : "FAIL" };
  });

  // STEP 7 ─────────────────────────────────────────────────────────────
  await runStep(
    `STEP 7 — PATCH /api/admin/business/${EZ_RENTALS_BUSINESS_ID}/prompt`,
    async () => {
      const patchRes = await apiCall(env.baseUrl, {
        bearer,
        activeBusinessId: DEMO_BUSINESS_ID, // active stays demo; isAdmin propagates
        method: "PATCH",
        path: `/api/admin/business/${EZ_RENTALS_BUSINESS_ID}/prompt`,
        body: { system_prompt: ADMIN_SMOKE_PROMPT },
      });
      if (patchRes.status !== 200) {
        return { status: "FAIL", details: `HTTP ${patchRes.status}` };
      }
      const passes = [
        logCheck("response.ok === true", patchRes.body.ok === true),
        logCheck(
          "auditLogId non-null",
          typeof patchRes.body.auditLogId === "string",
        ),
      ];

      // Verify EZ Rentals row updated, NOT demo-business.
      const { data: ezRow } = await sbAdmin
        .from("business_configs")
        .select("system_prompt, prompt_updated_by")
        .eq("business_id", EZ_RENTALS_BUSINESS_ID)
        .maybeSingle();
      const ez = ezRow as Record<string, unknown> | null;
      passes.push(
        logCheck(
          "EZ Rentals system_prompt === admin marker",
          ez?.system_prompt === ADMIN_SMOKE_PROMPT,
          `len ${(ez?.system_prompt as string | undefined)?.length}`,
        ),
      );
      passes.push(
        logCheck(
          "EZ Rentals prompt_updated_by === admin UUID",
          ez?.prompt_updated_by === ABDUL_UUID,
        ),
      );

      // Audit row source check.
      const { data: auditRow } = await sbAdmin
        .from("prompt_audit_log")
        .select("source, business_id")
        .eq("id", patchRes.body.auditLogId)
        .maybeSingle();
      const a = auditRow as Record<string, unknown> | null;
      passes.push(logCheck("audit.source === admin_raw", a?.source === "admin_raw"));
      passes.push(
        logCheck(
          "audit.business_id === EZ Rentals",
          a?.business_id === EZ_RENTALS_BUSINESS_ID,
        ),
      );
      return { status: passes.every((p) => p) ? "PASS" : "FAIL" };
    },
  );

  // STEP 8 ─────────────────────────────────────────────────────────────
  await runStep(
    `STEP 8 — GET /api/admin/business/${EZ_RENTALS_BUSINESS_ID}/prompt/audit`,
    async () => {
      const res = await apiCall(env.baseUrl, {
        bearer,
        activeBusinessId: DEMO_BUSINESS_ID,
        method: "GET",
        path: `/api/admin/business/${EZ_RENTALS_BUSINESS_ID}/prompt/audit?limit=20`,
      });
      if (res.status !== 200) {
        return { status: "FAIL", details: `HTTP ${res.status}` };
      }
      const rows = Array.isArray(res.body.rows) ? res.body.rows : [];
      const passes = [
        logCheck("businessId matches request", res.body.businessId === EZ_RENTALS_BUSINESS_ID),
        logCheck("limit echoed = 20", res.body.limit === 20),
        logCheck("rows is array, length > 0", rows.length > 0, `count=${rows.length}`),
      ];

      // Verify at least one row from this smoke run (admin_raw with our user).
      const ours = rows.find(
        (r: any) =>
          r.source === "admin_raw" &&
          r.changed_by_user_id === ABDUL_UUID &&
          typeof r.new_prompt === "string" &&
          r.new_prompt.includes(MARKER),
      );
      passes.push(
        logCheck(
          "this smoke run's admin_raw row is in audit",
          !!ours,
          ours ? `id=${ours.id}` : `MARKER ${MARKER} not found in ${rows.length} rows`,
        ),
      );
      return { status: passes.every((p) => p) ? "PASS" : "FAIL" };
    },
  );

  // STEP 9 — ROLLBACK ──────────────────────────────────────────────────
  await runStep("STEP 9 — Rollback", async () => {
    const passes: boolean[] = [];

    // 9a — restore demo-business system_prompt
    if (demoSnapshot.system_prompt !== null) {
      section("9a — restore demo-business system_prompt");
      const r = await apiCall(env.baseUrl, {
        bearer,
        activeBusinessId: DEMO_BUSINESS_ID,
        method: "PATCH",
        path: "/api/business/prompt",
        body: { system_prompt: demoSnapshot.system_prompt },
      });
      passes.push(
        logCheck(
          "demo-business system_prompt restored",
          r.status === 200 && r.body.ok === true,
          `HTTP ${r.status} ok=${r.body?.ok}`,
        ),
      );
    } else {
      console.log("  demo-business snapshot system_prompt was null; skipping 9a");
      manualCleanupSql.push(
        `UPDATE business_configs SET system_prompt = NULL WHERE business_id = '${DEMO_BUSINESS_ID}';`,
      );
    }

    // 9b — restore demo-business tone_preference (helper field)
    if (demoSnapshot.tone_preference !== null) {
      section("9b — restore demo-business tone_preference");
      const r = await apiCall(env.baseUrl, {
        bearer,
        activeBusinessId: DEMO_BUSINESS_ID,
        method: "PATCH",
        path: "/api/business/prompt/helpers",
        body: { tone_preference: demoSnapshot.tone_preference },
      });
      passes.push(
        logCheck(
          "demo-business tone_preference restored",
          r.status === 200 && r.body.ok === true,
          `HTTP ${r.status}`,
        ),
      );
    } else {
      console.warn(
        "  WARN: tone_preference was null pre-test; leaving marker value in place.",
      );
      manualCleanupSql.push(
        `UPDATE business_configs SET tone_preference = NULL WHERE business_id = '${DEMO_BUSINESS_ID}';`,
      );
    }

    // 9c — restore EZ Rentals system_prompt
    if (ezSnapshot.system_prompt !== null) {
      section("9c — restore EZ Rentals system_prompt");
      const r = await apiCall(env.baseUrl, {
        bearer,
        activeBusinessId: DEMO_BUSINESS_ID, // active stays demo; admin path uses URL param
        method: "PATCH",
        path: `/api/admin/business/${EZ_RENTALS_BUSINESS_ID}/prompt`,
        body: { system_prompt: ezSnapshot.system_prompt },
      });
      passes.push(
        logCheck(
          "EZ Rentals system_prompt restored",
          r.status === 200 && r.body.ok === true,
          `HTTP ${r.status} ok=${r.body?.ok}`,
        ),
      );
    } else {
      console.log("  EZ Rentals snapshot system_prompt was null; skipping 9c");
      manualCleanupSql.push(
        `UPDATE business_configs SET system_prompt = NULL WHERE business_id = '${EZ_RENTALS_BUSINESS_ID}';`,
      );
    }

    // 9d — verify via GET
    section("9d — verify rollback via GET");
    const demoGet = await apiCall(env.baseUrl, {
      bearer,
      activeBusinessId: DEMO_BUSINESS_ID,
      method: "GET",
      path: "/api/business/prompt",
    });
    if (demoSnapshot.system_prompt !== null) {
      passes.push(
        logCheck(
          "demo-business prompt matches snapshot",
          demoGet.body.system_prompt === demoSnapshot.system_prompt,
          `len ${demoGet.body.system_prompt?.length} vs ${demoSnapshot.system_prompt?.length}`,
        ),
      );
    }
    const { data: ezRow } = await sbAdmin
      .from("business_configs")
      .select("system_prompt")
      .eq("business_id", EZ_RENTALS_BUSINESS_ID)
      .maybeSingle();
    if (ezSnapshot.system_prompt !== null) {
      passes.push(
        logCheck(
          "EZ Rentals prompt matches snapshot",
          (ezRow as { system_prompt?: string } | null)?.system_prompt ===
            ezSnapshot.system_prompt,
        ),
      );
    }

    return {
      status: passes.every((p) => p) ? "PASS" : "FAIL",
      details:
        manualCleanupSql.length > 0
          ? `${manualCleanupSql.length} field(s) need manual cleanup`
          : undefined,
    };
  });

  // STEP 10 — REPORT ────────────────────────────────────────────────────
  const rollbackFailed = stepResults.some(
    (s) => s.name.startsWith("STEP 9") && s.status === "FAIL",
  );
  const anyFunctionalFail = stepResults.some(
    (s) => !s.name.startsWith("STEP 9") && s.status === "FAIL",
  );

  if (rollbackFailed) {
    console.error("\n[smoke] ROLLBACK FAILED — printing snapshot for manual recovery:\n");
    console.error("MANUAL RECOVERY REQUIRED:");
    console.error(JSON.stringify({ demoSnapshot, ezSnapshot, marker: MARKER }, null, 2));
    finalReport(2);
    process.exit(2);
  }

  const exit = anyFunctionalFail ? 1 : 0;
  finalReport(exit);
  process.exit(exit);
}

function finalReport(exit: number): void {
  banner("FINAL REPORT");
  const colWidth = 60;
  for (const s of stepResults) {
    const padded = s.name.padEnd(colWidth, " ");
    const symbol = s.status === "PASS" ? "✅ PASS" : s.status === "SKIPPED" ? "⏭ SKIP" : "❌ FAIL";
    console.log(`  ${padded} ${symbol}  ${s.durationMs.toString().padStart(6)}ms`);
  }
  const totalMs = stepResults.reduce((acc, s) => acc + s.durationMs, 0);
  console.log("  " + "─".repeat(colWidth + 20));
  console.log(`  TOTAL${" ".repeat(colWidth - 5)} ${totalMs.toString().padStart(13)}ms`);

  if (manualCleanupSql.length > 0) {
    console.log("");
    console.log("📋 MANUAL CLEANUP (helper fields that were null pre-test):");
    for (const sql of manualCleanupSql) {
      console.log(`  ${sql}`);
    }
  }

  console.log("");
  const verdict =
    exit === 0 ? "✅ ALL TESTS PASSED" :
    exit === 1 ? "❌ ONE OR MORE TESTS FAILED" :
    exit === 2 ? "🔥 ROLLBACK FAILED — manual recovery needed" :
    "💥 INFRASTRUCTURE FAILURE";
  console.log(`  ${verdict}  (exit ${exit})`);
  console.log("");
}

main().catch((err) => {
  console.error("\n[smoke] UNCAUGHT ERROR:", err?.message ?? err);
  console.error(err);
  finalReport(3);
  process.exit(3);
});
