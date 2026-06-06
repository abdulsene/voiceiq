/**
 * Sprint 3 Stage 5 Session 1 / Phase 2 — voices endpoints test suite.
 *
 * Same strategy as Stage 4's prompt.test.ts:
 *   - Mock auth middleware so each test controls req.userId,
 *     req.businessId via custom headers
 *   - Mock the elevenlabs-agent module (updateAgentVoice)
 *   - Use the chainable Supabase mock from src/tests/helpers/
 *     supabase-mock.ts, wired via _setSupabaseClientForTests
 *   - Mock global fetch for the TTS preview endpoint
 *   - Mount router on a fresh Express app + node:http server + global
 *     fetch for request firing (no supertest dep needed)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Hoisted mocks --------------------------------------------------------

vi.mock("../lib/elevenlabs-agent", () => ({
  updateAgentVoice: vi.fn(),
}));

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = req.headers["x-test-user-id"] || null;
    req.userEmail = req.headers["x-test-user-email"] || null;
    req.businessId = req.headers["x-test-business-id"] || null;
    req.isAdmin = req.headers["x-test-is-admin"] === "true";
    req.userPermissions = req.userId
      ? [
          {
            resource: "settings",
            actions: ["read", "write", "admin"],
            businessId: req.businessId,
          },
        ]
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

// Real imports AFTER mocks
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import voicesRouter, {
  VOICE_CATALOG,
  _setSupabaseClientForTests,
} from "./voices";
import { updateAgentVoice } from "../lib/elevenlabs-agent";
import {
  createSupabaseMock,
  type SupabaseMockHandle,
} from "../tests/helpers/supabase-mock";

// ───────────────────────────────────────────────────────────────────────
// Test server helper (same shape as prompt.test.ts)

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

interface CallResult {
  status: number;
  body: any;
  contentType: string | null;
  bytes?: ArrayBuffer;
}

async function callJson(
  baseUrl: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; binary?: boolean } = {},
): Promise<CallResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const contentType = res.headers.get("content-type");
  if (opts.binary) {
    const bytes = await res.arrayBuffer();
    return { status: res.status, body: null, contentType, bytes };
  }
  const text = await res.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, body: parsed, contentType };
}

// ───────────────────────────────────────────────────────────────────────
// Shared fixtures

const BIZ = "biz_voice_test_001";
const USER = "user_voice_test_001";
const AGENT = "agent_voice_test_001";
const NEW_VOICE_ID = VOICE_CATALOG[0].voice_id; // Sarah
const ALT_VOICE_ID = VOICE_CATALOG[1].voice_id; // Aria

let sbMock: SupabaseMockHandle;
let server: TestServer;
const mockedUpdateAgentVoice = vi.mocked(updateAgentVoice);
let realFetch: typeof fetch;

beforeEach(async () => {
  // Stash real fetch so test-server traffic still works after we
  // stub global fetch for the TTS upstream below.
  realFetch = globalThis.fetch;

  sbMock = createSupabaseMock();
  _setSupabaseClientForTests(sbMock.client as never);

  const app = express();
  app.use(express.json());
  app.use("/api", voicesRouter);
  server = await startTestServer(app);

  mockedUpdateAgentVoice.mockReset();
  mockedUpdateAgentVoice.mockResolvedValue({
    ok: true,
    agentId: AGENT,
    voiceId: NEW_VOICE_ID,
    verifiedAt: new Date("2026-06-06T00:00:00Z"),
  });

  vi.stubEnv("ELEVENLABS_API_KEY", "stub_elevenlabs_key");
});

afterEach(async () => {
  _setSupabaseClientForTests(undefined);
  await server.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  // Restore real fetch in case a test stubbed it.
  globalThis.fetch = realFetch;
});

const AUTH_HEADERS = {
  "x-test-user-id": USER,
  "x-test-business-id": BIZ,
};

// ───────────────────────────────────────────────────────────────────────
// GET /api/voices/catalog

describe("GET /api/voices/catalog", () => {
  test("returns 401 without auth", async () => {
    const res = await callJson(server.baseUrl, "GET", "/api/voices/catalog");
    expect(res.status).toBe(401);
  });

  test("returns 12 voices with required fields", async () => {
    const res = await callJson(server.baseUrl, "GET", "/api/voices/catalog", {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.voices)).toBe(true);
    expect(res.body.voices.length).toBe(12);
    for (const v of res.body.voices) {
      expect(typeof v.voice_id).toBe("string");
      expect(v.voice_id.length).toBeGreaterThan(0);
      expect(typeof v.name).toBe("string");
      expect(["male", "female"]).toContain(v.gender);
      expect(["American", "British", "Australian", "Swedish"]).toContain(v.accent);
      expect(typeof v.descriptor).toBe("string");
      expect(typeof v.personality_tag).toBe("string");
    }
  });

  test("catalog order matches the curated rendering order", async () => {
    const res = await callJson(server.baseUrl, "GET", "/api/voices/catalog", {
      headers: AUTH_HEADERS,
    });
    expect(res.body.voices[0].name).toBe("Sarah");
    expect(res.body.voices[1].name).toBe("Aria");
    expect(res.body.voices[res.body.voices.length - 1].name).toBe("Callum");
  });
});

// ───────────────────────────────────────────────────────────────────────
// GET /api/business/voice

describe("GET /api/business/voice", () => {
  test("returns voice state + catalog_match when voice_id is in catalog", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: {
        business_id: BIZ,
        voice_id: NEW_VOICE_ID,
        voice_last_synced_at: "2026-06-05T10:00:00Z",
        voice_sync_error: null,
        agent_id: AGENT,
      },
      error: null,
    });

    const res = await callJson(server.baseUrl, "GET", "/api/business/voice", {
      headers: AUTH_HEADERS,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      business_id: BIZ,
      voice_id: NEW_VOICE_ID,
      voice_last_synced_at: "2026-06-05T10:00:00Z",
      voice_sync_error: null,
      agent_id: AGENT,
    });
    expect(res.body.catalog_match).toBeTruthy();
    expect(res.body.catalog_match.name).toBe("Sarah");
  });

  test("returns catalog_match: null when voice_id is set but unknown to catalog", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: {
        business_id: BIZ,
        voice_id: "alloy", // pre-backfill OpenAI value
        voice_last_synced_at: null,
        voice_sync_error: null,
        agent_id: AGENT,
      },
      error: null,
    });

    const res = await callJson(server.baseUrl, "GET", "/api/business/voice", {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(200);
    expect(res.body.voice_id).toBe("alloy");
    expect(res.body.catalog_match).toBeNull();
  });

  test("returns 404 when business not found", async () => {
    sbMock.setResponses("business_configs", "select", { data: null, error: null });
    const res = await callJson(server.baseUrl, "GET", "/api/business/voice", {
      headers: AUTH_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/voices/preview

describe("POST /api/voices/preview", () => {
  function stubElevenLabsFetchOK(audio = "RIFFmockaudio"): ReturnType<typeof vi.fn> {
    const audioBuffer = new TextEncoder().encode(audio).buffer;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      // Route the test server's own traffic to the real fetch.
      if (url.startsWith(server.baseUrl)) {
        return realFetch(url, init);
      }
      // ElevenLabs TTS upstream — return a fake audio buffer.
      return Promise.resolve(
        new Response(audioBuffer, {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  test("happy path returns audio/mpeg bytes with preview text interpolated", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { business_name: "EZ Rentals", ai_name: "Alex" },
      error: null,
    });
    const fetchMock = stubElevenLabsFetchOK();

    const res = await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
      binary: true,
    });

    expect(res.status).toBe(200);
    expect(res.contentType).toBe("audio/mpeg");
    expect(res.bytes && res.bytes.byteLength > 0).toBe(true);

    // The mock should have received the personalized preview text.
    const ttsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("text-to-speech"),
    );
    expect(ttsCall).toBeDefined();
    const sentBody = JSON.parse(String(ttsCall![1].body));
    expect(sentBody.text).toBe(
      "Hello, this is Alex from EZ Rentals. How can I help you today?",
    );
    expect(sentBody.model_id).toBe("eleven_flash_v2");
  });

  test("uses ai_name when set (not the 'Alex' default)", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { business_name: "EZ Rentals", ai_name: "Riley" },
      error: null,
    });
    const fetchMock = stubElevenLabsFetchOK();

    await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
      binary: true,
    });
    const ttsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("text-to-speech"),
    );
    const sentBody = JSON.parse(String(ttsCall![1].body));
    expect(sentBody.text).toBe(
      "Hello, this is Riley from EZ Rentals. How can I help you today?",
    );
  });

  test("rejects unknown voice_id with 400", async () => {
    const res = await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: { voice_id: "not_in_catalog_xxxxxxxxx" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/one of the catalog voices/);
  });

  test("rejects missing voice_id with 400", async () => {
    const res = await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 when business not found", async () => {
    sbMock.setResponses("business_configs", "select", { data: null, error: null });
    stubElevenLabsFetchOK();

    const res = await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
    });
    expect(res.status).toBe(404);
  });

  test("returns 502 when ElevenLabs returns a non-2xx", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { business_name: "EZ Rentals", ai_name: null },
      error: null,
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith(server.baseUrl)) return realFetch(url, init);
      return Promise.resolve(new Response("server error", { status: 500 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await callJson(server.baseUrl, "POST", "/api/voices/preview", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
    });
    expect(res.status).toBe(502);
  });
});

// ───────────────────────────────────────────────────────────────────────
// PATCH /api/business/voice

describe("PATCH /api/business/voice", () => {
  test("happy path: DB update + sync + audit + sync-state, returns ok:true", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: AGENT, voice_id: "alloy" },
      error: null,
    });
    sbMock.setResponses(
      "business_configs",
      "update",
      { error: null },
      { error: null },
    );
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_v1" },
      error: null,
    });

    const res = await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      synced: true,
      new_voice_id: NEW_VOICE_ID,
      voice_name: "Sarah",
      auditLogId: "audit_v1",
    });
    expect(mockedUpdateAgentVoice).toHaveBeenCalledWith(AGENT, NEW_VOICE_ID);

    // Audit row payload
    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect(auditCall!.values).toMatchObject({
      business_id: BIZ,
      changed_by_user_id: USER,
      source: "voice_change",
      old_prompt: "alloy",
      new_prompt: NEW_VOICE_ID,
      sync_to_elevenlabs_ok: true,
    });

    // First update: voice_id only. Second update: sync-state.
    const updates = sbMock.calls.filter(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    expect(updates).toHaveLength(2);
    expect((updates[0].values as Record<string, unknown>).voice_id).toBe(NEW_VOICE_ID);
    expect((updates[1].values as Record<string, unknown>).voice_last_synced_at).toBeTruthy();
    expect((updates[1].values as Record<string, unknown>).voice_sync_error).toBeNull();
  });

  test("old voice_id NULL is recorded as literal 'NULL' string in audit", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: AGENT, voice_id: null },
      error: null,
    });
    sbMock.setResponses(
      "business_configs",
      "update",
      { error: null },
      { error: null },
    );
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_v2" },
      error: null,
    });

    await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
    });

    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect((auditCall!.values as Record<string, unknown>).old_prompt).toBe("NULL");
  });

  test("rejects unknown voice_id with 400", async () => {
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: "not_in_catalog_yyyyyyyy" },
    });
    expect(res.status).toBe(400);
  });

  test("returns 409 when business has no agent_id", async () => {
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: null, voice_id: "alloy" },
      error: null,
    });
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: ALT_VOICE_ID },
    });
    expect(res.status).toBe(409);
  });

  test("returns 404 when business not found", async () => {
    sbMock.setResponses("business_configs", "select", { data: null, error: null });
    const res = await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: ALT_VOICE_ID },
    });
    expect(res.status).toBe(404);
  });

  test("sync failure returns 200 with ok:false, savedToDb:true", async () => {
    mockedUpdateAgentVoice.mockResolvedValueOnce({
      ok: false,
      agentId: AGENT,
      voiceId: NEW_VOICE_ID,
      error: "Verify mismatch: sent X, ElevenLabs returned Y",
      httpStatus: null,
      stage: "verify",
    });
    sbMock.setResponses("business_configs", "select", {
      data: { agent_id: AGENT, voice_id: "alloy" },
      error: null,
    });
    sbMock.setResponses(
      "business_configs",
      "update",
      { error: null },
      { error: null },
    );
    sbMock.setResponses("prompt_audit_log", "insert", {
      data: { id: "audit_v3" },
      error: null,
    });

    const res = await callJson(server.baseUrl, "PATCH", "/api/business/voice", {
      headers: AUTH_HEADERS,
      body: { voice_id: NEW_VOICE_ID },
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      savedToDb: true,
      syncError: expect.stringMatching(/Verify mismatch/),
      new_voice_id: NEW_VOICE_ID,
      voice_name: "Sarah",
      auditLogId: "audit_v3",
    });

    // Audit row records the failure
    const auditCall = sbMock.calls.find((c) => c.table === "prompt_audit_log");
    expect((auditCall!.values as Record<string, unknown>).sync_to_elevenlabs_ok).toBe(false);

    // Sync-state UPDATE writes voice_sync_error and NOT voice_last_synced_at
    const updates = sbMock.calls.filter(
      (c) => c.table === "business_configs" && c.op === "update",
    );
    const lastUpdate = updates[updates.length - 1];
    expect((lastUpdate.values as Record<string, unknown>).voice_sync_error).toMatch(
      /Verify mismatch/,
    );
    expect((lastUpdate.values as Record<string, unknown>).voice_last_synced_at).toBeUndefined();
  });
});
