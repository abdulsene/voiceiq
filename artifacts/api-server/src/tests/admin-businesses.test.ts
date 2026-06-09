/**
 * Stage 6 Phase 1 — admin-businesses endpoints test suite.
 *
 * Coverage budget: 11 vitest cases (per Phase 1 spec):
 *   - 6 for GET /api/admin/businesses (list)
 *   - 2 for GET /api/admin/business/:id (single)
 *   - 3 for PATCH /api/admin/business/:id/voice
 *
 * Strategy mirrors voices.test.ts + prompt.test.ts:
 *   - Mock requireAuth (header-driven userId/email) and
 *     requireStaffPermission (header-driven granted permissions)
 *   - Mock lib/elevenlabs-agent.updateAgentVoice for the PATCH endpoint
 *   - Stub Supabase via the chainable mock from
 *     src/tests/helpers/supabase-mock, wired via
 *     _setSupabaseClientForTests
 *   - Stub the owner-email lookup via _setUserEmailLookupForTests so
 *     tests never touch the real auth admin API
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted mocks ────────────────────────────────────────────────────────

vi.mock("../lib/elevenlabs-agent", () => ({
  updateAgentVoice: vi.fn(),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = req.headers["x-test-user-id"] || null;
    req.userEmail = req.headers["x-test-user-email"] || null;
    req.businessId = req.headers["x-test-business-id"] || null;
    next();
  },
  // Transitive load: admin-businesses imports voices for VOICE_CATALOG,
  // and voices.ts uses requirePermission at module init to register
  // routes. The mock must export it even though our admin endpoints
  // gate via requireStaffPermission, not requirePermission.
  requirePermission:
    (_resource: string, _action: string) =>
    (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middlewares/staff-rbac", () => ({
  requireStaffPermission:
    (resource: string, action: string) =>
    (req: any, res: any, next: any) => {
      if (!req.userId) {
        res.status(401).json({ error: "auth_required_for_test" });
        return;
      }
      const perms = String(req.headers["x-test-staff-perms"] || "");
      const granted = perms.split(",").map((s) => s.trim()).filter(Boolean);
      if (!granted.includes(`${resource}:${action}`)) {
        res.status(403).json({
          error: `Insufficient permissions for ${action} on ${resource}`,
        });
        return;
      }
      next();
    },
}));

// Real imports AFTER mocks ─────────────────────────────────────────────
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import adminBusinessesRouter, {
  _setSupabaseClientForTests,
  _setUserEmailLookupForTests,
} from "../routes/admin-businesses";
import { updateAgentVoice } from "../lib/elevenlabs-agent";
import {
  createSupabaseMock,
  type SupabaseMockHandle,
} from "../tests/helpers/supabase-mock";

// ───────────────────────────────────────────────────────────────────────
// Test server harness

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(handler: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

async function callJson(
  baseUrl: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const STAFF_USER = "user_staff_001";
const TARGET_BIZ = "biz_target_001";

const AUTH_NO_PERM = {
  "x-test-user-id": STAFF_USER,
} as Record<string, string>;
const AUTH_READER = {
  "x-test-user-id": STAFF_USER,
  "x-test-staff-perms": "customers:read",
} as Record<string, string>;
const AUTH_WRITER = {
  "x-test-user-id": STAFF_USER,
  "x-test-staff-perms": "customers:read,customers:write",
} as Record<string, string>;

const mockedUpdateAgentVoice = vi.mocked(updateAgentVoice);

let sbMock: SupabaseMockHandle;
let server: TestServer;

beforeEach(async () => {
  sbMock = createSupabaseMock();
  _setSupabaseClientForTests(sbMock.client as never);
  // Default: tests that don't care about owner_email get empty map.
  _setUserEmailLookupForTests(async () => ({}));

  const app = express();
  app.use(express.json());
  app.use("/api", adminBusinessesRouter);
  server = await startTestServer(app);

  mockedUpdateAgentVoice.mockReset();
});

afterEach(async () => {
  _setSupabaseClientForTests(undefined);
  _setUserEmailLookupForTests(null);
  await server.close();
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────
// Fixture rows

function mkBiz(overrides: Record<string, any> = {}) {
  return {
    business_id: TARGET_BIZ,
    business_name: "Acme Co",
    plan_id: "starter",
    subscription_status: "active",
    agent_id: "agent_target_abc",
    voice_id: "EXAVITQu4vr4xnSDxMaL",
    voice_last_synced_at: "2026-06-09T10:00:00Z",
    voice_sync_error: null,
    prompt_updated_at: "2026-06-09T09:00:00Z",
    prompt_sync_error: null,
    created_at: "2026-04-01T00:00:00Z",
    system_prompt: "You are Aria for Acme Co. ...",
    tone_preference: "Warm",
    custom_faqs: [{ question: "Hours?", answer: "9-5" }],
    never_say_list: ["competitor names"],
    objection_handling: [{ objection: "too pricey", response: "value" }],
    after_hours_message: "Closed.",
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────────────────
// 6 tests — GET /api/admin/businesses

describe("GET /api/admin/businesses", () => {
  test("401/403/200 ladder + happy-path response shape", async () => {
    // 401 — no auth header
    const r401 = await callJson(server.baseUrl, "GET", "/api/admin/businesses");
    expect(r401.status).toBe(401);

    // 403 — authenticated but no customers:read
    const r403 = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses",
      { headers: AUTH_NO_PERM },
    );
    expect(r403.status).toBe(403);

    // 200 — happy path with permission
    sbMock.setResponses("business_configs", "select", {
      data: [mkBiz(), mkBiz({ business_id: "biz_other", business_name: "Beta" })],
      error: null,
      count: 2,
    });
    sbMock.setResponses("user_businesses", "select", {
      data: [],
      error: null,
    });

    const r200 = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses",
      { headers: AUTH_READER },
    );
    expect(r200.status).toBe(200);
    expect(r200.body).toMatchObject({
      total: 2,
      limit: 25,
      offset: 0,
    });
    expect(r200.body.rows).toHaveLength(2);
    expect(r200.body.rows[0]).toMatchObject({
      business_id: TARGET_BIZ,
      owner_email: null, // default lookup returns empty map
    });
  });

  test("search filter hits .or against name + business_id (case-insensitive)", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: [mkBiz()],
      error: null,
      count: 1,
    });
    sbMock.setResponses("user_businesses", "select", { data: [], error: null });

    await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses?search=acme",
      { headers: AUTH_READER },
    );

    const selectCall = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "select",
    );
    expect(selectCall).toBeDefined();
    const orFilter = selectCall!.filters.find((f) => f.kind === "or");
    expect(orFilter).toBeDefined();
    // Both name + id columns get the ILIKE pattern.
    expect(String(orFilter!.args[0])).toMatch(/business_name\.ilike\.%acme%/);
    expect(String(orFilter!.args[0])).toMatch(/business_id\.ilike\.%acme%/);
  });

  test("has_sync_errors=true filters via .or across voice + prompt error cols", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: [],
      error: null,
      count: 0,
    });
    sbMock.setResponses("user_businesses", "select", { data: [], error: null });

    await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses?has_sync_errors=true",
      { headers: AUTH_READER },
    );

    const selectCall = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "select",
    );
    const orFilters = selectCall!.filters.filter((f) => f.kind === "or");
    expect(
      orFilters.some(
        (f) =>
          String(f.args[0]).includes("voice_sync_error.not.is.null") &&
          String(f.args[0]).includes("prompt_sync_error.not.is.null"),
      ),
    ).toBe(true);
  });

  test("include_test=false (default) applies test-business exclusion chain", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: [],
      error: null,
      count: 0,
    });
    sbMock.setResponses("user_businesses", "select", { data: [], error: null });

    await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses",
      { headers: AUTH_READER },
    );

    const selectCall = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "select",
    );
    const notFilters = selectCall!.filters.filter((f) => f.kind === "not");
    const neqFilters = selectCall!.filters.filter((f) => f.kind === "neq");

    // All four name/id "like" exclusions present
    expect(
      notFilters.some(
        (f) =>
          f.args[0] === "business_id" &&
          f.args[1] === "like" &&
          f.args[2] === "demo_%",
      ),
    ).toBe(true);
    expect(
      notFilters.some(
        (f) =>
          f.args[0] === "business_name" &&
          f.args[1] === "like" &&
          f.args[2] === "[DEMO]%",
      ),
    ).toBe(true);
    expect(
      notFilters.some(
        (f) =>
          f.args[0] === "business_name" &&
          f.args[1] === "like" &&
          f.args[2] === "[SALES DEMO]%",
      ),
    ).toBe(true);
    expect(
      notFilters.some(
        (f) =>
          f.args[0] === "business_name" &&
          f.args[1] === "like" &&
          f.args[2] === "Test %",
      ),
    ).toBe(true);
    // And the literal "demo-business" .neq guard
    expect(
      neqFilters.some(
        (f) => f.args[0] === "business_id" && f.args[1] === "demo-business",
      ),
    ).toBe(true);
  });

  test("include_test=true skips exclusion chain entirely", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: [],
      error: null,
      count: 0,
    });
    sbMock.setResponses("user_businesses", "select", { data: [], error: null });

    await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses?include_test=true",
      { headers: AUTH_READER },
    );

    const selectCall = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "select",
    );
    expect(selectCall!.filters.filter((f) => f.kind === "not")).toHaveLength(0);
    expect(selectCall!.filters.filter((f) => f.kind === "neq")).toHaveLength(0);
  });

  test("owner_email is joined from user_businesses → lookupUserEmails", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: [mkBiz()],
      error: null,
      count: 1,
    });
    sbMock.setResponses("user_businesses", "select", {
      data: [
        {
          business_id: TARGET_BIZ,
          user_id: "user_owner_xyz",
          role: "owner",
          created_at: "2026-04-01T00:00:00Z",
        },
      ],
      error: null,
    });
    _setUserEmailLookupForTests(async (userIds) => {
      expect(userIds).toContain("user_owner_xyz");
      return { user_owner_xyz: "owner@acme.example" };
    });

    const res = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/businesses",
      { headers: AUTH_READER },
    );
    expect(res.status).toBe(200);
    expect(res.body.rows[0].owner_email).toBe("owner@acme.example");
  });
});

// ───────────────────────────────────────────────────────────────────────
// 2 tests — GET /api/admin/business/:businessId

describe("GET /api/admin/business/:businessId", () => {
  test("happy path returns nested business + prompt + voice shape", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: mkBiz(),
      error: null,
    });
    sbMock.setResponses("user_businesses", "select", { data: [], error: null });

    const res = await callJson(
      server.baseUrl,
      "GET",
      `/api/admin/business/${TARGET_BIZ}`,
      { headers: AUTH_READER },
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      business: { business_id: TARGET_BIZ, business_name: "Acme Co" },
      prompt: {
        system_prompt: "You are Aria for Acme Co. ...",
        helpers: {
          tone_preference: "Warm",
          custom_faqs: [{ question: "Hours?", answer: "9-5" }],
          never_say_list: ["competitor names"],
          objection_handling: [{ objection: "too pricey", response: "value" }],
          after_hours_message: "Closed.",
        },
      },
      voice: {
        voice_id: "EXAVITQu4vr4xnSDxMaL",
        voice_sync_error: null,
      },
    });
  });

  test("404 when business not found", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: null,
      error: null,
    });

    const res = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/business/biz_does_not_exist",
      { headers: AUTH_READER },
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ───────────────────────────────────────────────────────────────────────
// 3 tests — PATCH /api/admin/business/:businessId/voice

describe("PATCH /api/admin/business/:businessId/voice", () => {
  test("happy path: updates voice, writes admin_voice_change audit row with staff caller as changed_by_user_id, returns refreshed detail", async () => {
    // Read of current cfg before update.
    sbMock.setResponses(
      "business_configs",
      "select",
      // 1st .from("business_configs").select(...).eq(...).maybeSingle() — cfg pre-read
      {
        data: {
          agent_id: "agent_target_abc",
          voice_id: "EXAVITQu4vr4xnSDxMaL",
        },
        error: null,
      },
      // 2nd .from("business_configs").select(DETAIL_COLS).eq(...).maybeSingle() — post-update detail load
      {
        data: mkBiz({ voice_id: "9BWtsMINqrJLrRacOk9x" }),
        error: null,
      },
    );
    // The two write paths (initial UPDATE + sync-state UPDATE) — default response is fine.
    // user_businesses lookup inside loadBusinessDetail.
    sbMock.setResponses("user_businesses", "select", {
      data: [],
      error: null,
    });

    mockedUpdateAgentVoice.mockResolvedValue({
      ok: true,
      agentId: "agent_target_abc",
      voiceId: "9BWtsMINqrJLrRacOk9x",
      verifiedAt: new Date("2026-06-09T11:00:00Z"),
    });

    const res = await callJson(
      server.baseUrl,
      "PATCH",
      `/api/admin/business/${TARGET_BIZ}/voice`,
      {
        headers: AUTH_WRITER,
        body: { voice_id: "9BWtsMINqrJLrRacOk9x" },
      },
    );

    expect(res.status).toBe(200);
    expect(res.body.voice.voice_id).toBe("9BWtsMINqrJLrRacOk9x");

    // Audit row was written with the right shape.
    const auditCall = sbMock.calls.find(
      (c) => c.table === "prompt_audit_log" && c.op === "insert",
    );
    expect(auditCall).toBeDefined();
    expect(auditCall!.values).toMatchObject({
      business_id: TARGET_BIZ,
      changed_by_user_id: STAFF_USER, // CRITICAL: staff caller, NOT business owner
      source: "admin_voice_change",
      old_prompt: "EXAVITQu4vr4xnSDxMaL",
      new_prompt: "9BWtsMINqrJLrRacOk9x",
      sync_to_elevenlabs_ok: true,
      elevenlabs_error: null,
    });
  });

  test("rejects 400 when voice_id isn't in catalog", async () => {
    const res = await callJson(
      server.baseUrl,
      "PATCH",
      `/api/admin/business/${TARGET_BIZ}/voice`,
      {
        headers: AUTH_WRITER,
        body: { voice_id: "not-a-real-voice-id" },
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voice_id is required/);
    // No DB write should have happened.
    expect(
      sbMock.calls.some((c) => c.op === "insert" || c.op === "update"),
    ).toBe(false);
  });

  test("ElevenLabs sync failure: returns 200 with voice_sync_error in refreshed detail; audit row records sync_to_elevenlabs_ok=false", async () => {
    sbMock.setResponses(
      "business_configs",
      "select",
      {
        data: {
          agent_id: "agent_target_abc",
          voice_id: "EXAVITQu4vr4xnSDxMaL",
        },
        error: null,
      },
      // Post-update detail load: include the sync error so the response carries it.
      {
        data: mkBiz({
          voice_id: "9BWtsMINqrJLrRacOk9x",
          voice_sync_error: "ElevenLabs verify mismatch",
        }),
        error: null,
      },
    );
    sbMock.setResponses("user_businesses", "select", {
      data: [],
      error: null,
    });

    mockedUpdateAgentVoice.mockResolvedValue({
      ok: false,
      agentId: "agent_target_abc",
      voiceId: "9BWtsMINqrJLrRacOk9x",
      error: "ElevenLabs verify mismatch",
      httpStatus: null,
      stage: "verify",
    });

    const res = await callJson(
      server.baseUrl,
      "PATCH",
      `/api/admin/business/${TARGET_BIZ}/voice`,
      {
        headers: AUTH_WRITER,
        body: { voice_id: "9BWtsMINqrJLrRacOk9x" },
      },
    );

    // Write-then-sync: DB persisted even on sync failure, so 200 is correct.
    expect(res.status).toBe(200);
    expect(res.body.voice.voice_sync_error).toBe("ElevenLabs verify mismatch");

    // Audit row captures the sync failure.
    const auditCall = sbMock.calls.find(
      (c) => c.table === "prompt_audit_log" && c.op === "insert",
    );
    expect(auditCall!.values).toMatchObject({
      source: "admin_voice_change",
      sync_to_elevenlabs_ok: false,
      elevenlabs_error: "ElevenLabs verify mismatch",
    });
  });
});
