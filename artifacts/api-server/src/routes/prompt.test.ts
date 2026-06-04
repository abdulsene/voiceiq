/**
 * Sprint 3 Stage 4 — prompt endpoints test suite.
 *
 * Strategy:
 *   - Mock auth middleware so each test controls req.userId, req.businessId,
 *     req.isAdmin via custom headers.
 *   - Mock the elevenlabs-agent module (updateAgentPrompt) — Stage 2's
 *     tests already cover its internals.
 *   - Mock the api module's fetchIndustryTemplate / fetchObjectionHandlers
 *     for the regenerate flow.
 *   - Use the chainable Supabase mock from Sprint 2 (src/tests/helpers/
 *     supabase-mock.ts), wired via _setSupabaseClientForTests.
 *   - Mount the router on a fresh Express app + supertest for full
 *     request/response coverage.
 *
 * Also tests:
 *   - validateHelpersBody (pure unit)
 *   - performSaveAndSync (DB-mocked, branches: sync-ok, sync-fail)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ───────────────────────────────────────────────────────────────────────
// Mocks — hoisted by vitest before imports are resolved.

vi.mock("../lib/elevenlabs-agent", () => ({
  updateAgentPrompt: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchIndustryTemplate: vi.fn().mockResolvedValue(null),
  fetchObjectionHandlers: vi.fn().mockResolvedValue(null),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = req.headers["x-test-user-id"] || null;
    req.userEmail = req.headers["x-test-user-email"] || null;
    req.businessId = req.headers["x-test-business-id"] || null;
    req.isAdmin = req.headers["x-test-is-admin"] === "true";
    req.userPermissions = req.userId
      ? [{ resource: "settings", actions: ["read", "write", "admin"], businessId: req.businessId }]
      : [];
    next();
  },
  requirePermission:
    (_resource: string, _action: string) => (req: any, res: any, next: any) => {
      if (!req.userId) {
        res.status(401).json({ error: "auth_required_for_test" });
        return;
      }
      next();
    },
}));

// Real imports AFTER the mocks above.
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import promptRouter, {
  _setSupabaseClientForTests,
  performSaveAndSync,
  validateHelpersBody,
} from "./prompt";
import { updateAgentPrompt } from "../lib/elevenlabs-agent";
import {
  createSupabaseMock,
  type SupabaseMockHandle,
} from "../tests/helpers/supabase-mock";

// ───────────────────────────────────────────────────────────────────────
// Tiny supertest replacement — boots the Express app on an ephemeral
// port + fires real fetch requests. No extra dep needed.

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(handler: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ baseUrl, close });
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
    headers: {
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  // Read body as text first to allow empty responses safely.
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed };
}

// ───────────────────────────────────────────────────────────────────────
// Shared fixtures

const BIZ = "biz_test_001";
const USER = "user_test_001";
const AGENT = "agent_test_001";

let sbMock: SupabaseMockHandle;
let server: TestServer;

const mockedUpdateAgentPrompt = vi.mocked(updateAgentPrompt);

beforeEach(async () => {
  sbMock = createSupabaseMock();
  _setSupabaseClientForTests(sbMock.client as never);

  const app = express();
  app.use(express.json());
  app.use("/api", promptRouter);
  server = await startTestServer(app);

  mockedUpdateAgentPrompt.mockReset();
  // Default to a happy ElevenLabs sync. Dynamic charsWritten so tests
  // can assert on the actual prompt length they pass in. Individual
  // tests can override via mockResolvedValueOnce for failure paths.
  mockedUpdateAgentPrompt.mockImplementation(async (agentId, language, prompt) => ({
    ok: true,
    agentId,
    language: language as "en",
    charsWritten: prompt.length,
    verifiedAt: new Date("2026-06-04T19:00:00Z"),
  }));
});

afterEach(async () => {
  _setSupabaseClientForTests(undefined);
  await server.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ───────────────────────────────────────────────────────────────────────
// Pure unit tests: validateHelpersBody

describe("validateHelpersBody", () => {
  test("rejects non-object body", () => {
    expect(validateHelpersBody(null).ok).toBe(false);
    expect(validateHelpersBody([] as unknown).ok).toBe(false);
    expect(validateHelpersBody("not an object").ok).toBe(false);
  });

  test("rejects empty object", () => {
    const r = validateHelpersBody({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one helper field/);
  });

  test("rejects unknown fields with allowlist guidance", () => {
    const r = validateHelpersBody({ business_name: "Acme", custom_faqs: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/business_name/);
    expect(r.error).toMatch(/Allowed: custom_faqs/);
  });

  test("accepts a valid subset", () => {
    const r = validateHelpersBody({
      tone_preference: "warm and casual",
      never_say_list: ["promise specific outcomes"],
    });
    expect(r.ok).toBe(true);
    expect(r.payload).toEqual({
      tone_preference: "warm and casual",
      never_say_list: ["promise specific outcomes"],
    });
  });

  test("rejects malformed custom_faqs entry", () => {
    const r = validateHelpersBody({
      custom_faqs: [{ question: "ok", answer: "" }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/custom_faqs\[0\]/);
  });

  test("rejects oversized tone_preference", () => {
    const r = validateHelpersBody({ tone_preference: "x".repeat(501) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/500/);
  });

  test("rejects too-many never_say_list entries", () => {
    const r = validateHelpersBody({
      never_say_list: Array.from({ length: 101 }, (_, i) => `entry ${i}`),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/100 entries/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// performSaveAndSync direct tests

describe("performSaveAndSync", () => {
  test("happy path: updates DB, calls sync, writes audit, returns ok:true", async () => {
    sbMock.setResponses("business_configs", "update", { error: null }, { error: null });
    sbMock.setResponses(
      "prompt_audit_log",
      "insert",
      { data: { id: "audit_001" }, error: null },
    );

    const result = await performSaveAndSync({
      supabase: sbMock.client as never,
      businessId: BIZ,
      userId: USER,
      agentId: AGENT,
      oldPrompt: "OLD",
      newPrompt: "NEW",
      source: "owner_raw",
      ipAddress: "127.0.0.1",
      userAgent: "TestUA/1.0",
      clearHelpersDirty: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.charsWritten).toBe(3);
      expect(result.auditLogId).toBe("audit_001");
    }

    // Verify the audit row payload included the right fields.
    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect(auditCall).toBeDefined();
    expect(auditCall!.values).toMatchObject({
      business_id: BIZ,
      changed_by_user_id: USER,
      source: "owner_raw",
      old_prompt: "OLD",
      new_prompt: "NEW",
      sync_to_elevenlabs_ok: true,
      elevenlabs_error: null,
      language: "en",
    });

    // Verify the first business_configs update included
    // prompt_helpers_dirty_at: null (because clearHelpersDirty was true).
    const firstUpdate = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    expect((firstUpdate!.values as Record<string, unknown>).prompt_helpers_dirty_at).toBeNull();
    expect((firstUpdate!.values as Record<string, unknown>).prompt_updated_by).toBe(USER);
  });

  test("sync failure: returns ok:false savedToDb:true with the error", async () => {
    mockedUpdateAgentPrompt.mockResolvedValueOnce({
      ok: false,
      agentId: AGENT,
      language: "en",
      error: "Verify mismatch: sent 100 chars, ElevenLabs returned 99 chars",
      httpStatus: null,
      stage: "verify",
    });
    sbMock.setResponses("business_configs", "update", { error: null }, { error: null });
    sbMock.setResponses(
      "prompt_audit_log",
      "insert",
      { data: { id: "audit_002" }, error: null },
    );

    const result = await performSaveAndSync({
      supabase: sbMock.client as never,
      businessId: BIZ,
      userId: USER,
      agentId: AGENT,
      oldPrompt: "OLD",
      newPrompt: "NEW",
      source: "owner_raw",
      ipAddress: null,
      userAgent: null,
      clearHelpersDirty: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.savedToDb).toBe(true);
      expect(result.syncError).toMatch(/Verify mismatch/);
      expect(result.auditLogId).toBe("audit_002");
    }

    // Audit row records the failure correctly.
    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect(auditCall!.values).toMatchObject({
      sync_to_elevenlabs_ok: false,
      elevenlabs_error: expect.stringMatching(/Verify mismatch/),
    });

    // Final sync-state update writes prompt_sync_error, NOT
    // prompt_last_synced_at.
    const stateUpdates = sbMock.calls.filter(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    const lastUpdate = stateUpdates[stateUpdates.length - 1];
    expect(lastUpdate.values).toMatchObject({
      prompt_sync_error: expect.stringMatching(/Verify mismatch/),
    });
    expect((lastUpdate.values as Record<string, unknown>).prompt_last_synced_at).toBeUndefined();
  });

  test("DB persistence failure throws", async () => {
    sbMock.setResponses("business_configs", "update", {
      error: { message: "permission denied for table business_configs" },
    });

    await expect(
      performSaveAndSync({
        supabase: sbMock.client as never,
        businessId: BIZ,
        userId: USER,
        agentId: AGENT,
        oldPrompt: null,
        newPrompt: "NEW",
        source: "owner_raw",
        ipAddress: null,
        userAgent: null,
        clearHelpersDirty: true,
      }),
    ).rejects.toThrow(/business_configs update failed/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Endpoint tests (supertest)

const AUTH_HEADERS = {
  "x-test-user-id": USER,
  "x-test-business-id": BIZ,
};

const ADMIN_AUTH_HEADERS = {
  ...AUTH_HEADERS,
  "x-test-is-admin": "true",
};

describe("GET /api/business/prompt", () => {
  test("returns 401 without auth", async () => {
    const res = await callJson(server.baseUrl, "GET", "/api/business/prompt");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("auth_required_for_test");
  });

  test("returns the business_configs prompt-related fields", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: {
        business_id: BIZ,
        business_name: "EZ Rentals",
        agent_id: AGENT,
        system_prompt: "You are Alex...",
        prompt_updated_at: "2026-06-01T00:00:00Z",
        prompt_helpers_dirty_at: null,
      },
      error: null,
    });

    const res = await callJson(server.baseUrl, "GET", "/api/business/prompt", {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      business_id: BIZ,
      agent_id: AGENT,
      system_prompt: "You are Alex...",
    });
  });

  test("returns 404 when business row missing", async () => {
    sbMock.setResponses("business_configs", "select", { data: null, error: null });
    const res = await callJson(server.baseUrl, "GET", "/api/business/prompt", {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/business/prompt (raw save + sync)", () => {
  test("happy path: saves, syncs, returns ok:true", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: AGENT, system_prompt: "OLD" },
      error: null,
    });
    sbMock.setResponses("business_configs", "update", { error: null }, { error: null });
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_e1" },
      error: null,
    });

    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt", {
      headers: AUTH_HEADERS,
      body: { system_prompt: "NEW PROMPT TEXT" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      charsWritten: "NEW PROMPT TEXT".length,
      auditLogId: "audit_e1",
    });
    expect(mockedUpdateAgentPrompt).toHaveBeenCalledWith(AGENT, "en", "NEW PROMPT TEXT");
  });

  test("rejects empty system_prompt with 400", async () => {
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt", {
      headers: AUTH_HEADERS,
      body: { system_prompt: "" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 50000/);
  });

  test("rejects oversized system_prompt with 400", async () => {
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt", {
      headers: AUTH_HEADERS,
      body: { system_prompt: "x".repeat(50_001) },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/between 1 and 50000/);
  });

  test("returns 409 when business has no agent_id", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: null, system_prompt: null },
      error: null,
    });
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt", {
      headers: AUTH_HEADERS,
      body: { system_prompt: "anything" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no ElevenLabs agent/);
  });

  test("sync failure returns 200 with ok:false, savedToDb:true", async () => {
    mockedUpdateAgentPrompt.mockResolvedValueOnce({
      ok: false,
      agentId: AGENT,
      language: "en",
      error: "ELEVENLABS_API_KEY is invalid or revoked (401)",
      httpStatus: 401,
      stage: "patch",
    });
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: AGENT, system_prompt: "OLD" },
      error: null,
    });
    sbMock.setResponses("business_configs", "update", { error: null }, { error: null });
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_e2" },
      error: null,
    });

    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt", {
      headers: AUTH_HEADERS,
      body: { system_prompt: "NEW" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      savedToDb: true,
      syncError: expect.stringMatching(/401/),
      auditLogId: "audit_e2",
    });
  });
});

describe("PATCH /api/business/prompt/helpers", () => {
  test("happy path updates only allowed fields + dirty timestamp, no sync", async () => {
    sbMock.setResponses("business_configs", "update", { error: null });

    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt/helpers", {
      headers: AUTH_HEADERS,
      body: {
        tone_preference: "warm",
        never_say_list: ["never promise outcomes"],
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      updated: expect.arrayContaining(["tone_preference", "never_say_list"]),
    });
    expect(res.body.dirty_at).toMatch(/T.*Z$/);
    expect(mockedUpdateAgentPrompt).not.toHaveBeenCalled();

    const updateCall = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    expect((updateCall!.values as Record<string, unknown>).prompt_helpers_dirty_at).toBeTruthy();
  });

  test("rejects unknown field with 400", async () => {
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/prompt/helpers", {
      headers: AUTH_HEADERS,
      body: { business_name: "Should be rejected" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown helper field/);
  });
});

describe("PATCH /api/admin/business/:businessId/prompt", () => {
  test("returns 403 without admin role", async () => {
    const res = await callJson(
      server.baseUrl,
      "PATCH",
      "/api/admin/business/biz_other_001/prompt",
      { headers: AUTH_HEADERS, body: { system_prompt: "anything" } },
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admin access required/);
  });

  test("admin can save cross-tenant; source records as admin_raw", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: "agent_other_001", system_prompt: "OLD" },
      error: null,
    });
    sbMock.setResponses("business_configs", "update", { error: null }, { error: null });
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_admin" },
      error: null,
    });

    const res = await callJson(
      server.baseUrl,
      "PATCH",
      "/api/admin/business/biz_other_001/prompt",
      { headers: ADMIN_AUTH_HEADERS, body: { system_prompt: "NEW from admin" } },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect(auditCall!.values).toMatchObject({
      business_id: "biz_other_001",
      changed_by_user_id: USER,
      source: "admin_raw",
    });
    // clearHelpersDirty is false for admin_raw — the dirty flag must
    // NOT appear in the first update payload.
    const firstUpdate = sbMock.calls.find(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    expect((firstUpdate!.values as Record<string, unknown>).prompt_helpers_dirty_at).toBeUndefined();
  });
});

describe("GET /api/admin/business/:businessId/prompt/audit", () => {
  test("returns 403 without admin role", async () => {
    const res = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/business/biz_other_001/prompt/audit",
      { headers: AUTH_HEADERS },
    );
    expect(res.status).toBe(403);
  });

  test("returns paginated audit rows for the right business", async () => {
    sbMock.setResponses("prompt_audit_log", "select", {
      data: [
        {
          id: "a1",
          business_id: "biz_other_001",
          source: "owner_raw",
          new_prompt: "v1",
          changed_at: "2026-06-04T18:00:00Z",
        },
        {
          id: "a2",
          business_id: "biz_other_001",
          source: "admin_raw",
          new_prompt: "v2",
          changed_at: "2026-06-04T17:00:00Z",
        },
      ],
      error: null,
    });

    const res = await callJson(
      server.baseUrl,
      "GET",
      "/api/admin/business/biz_other_001/prompt/audit?limit=10",
      { headers: ADMIN_AUTH_HEADERS },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      businessId: "biz_other_001",
      limit: 10,
      offset: 0,
      rows: expect.arrayContaining([
        expect.objectContaining({ id: "a1", source: "owner_raw" }),
        expect.objectContaining({ id: "a2", source: "admin_raw" }),
      ]),
    });
  });
});
