/**
 * Phase 5.5 — regression tests for /calls/:id route ordering.
 *
 * Live incident: /api/calls/stats and /api/calls/recent returned 404
 * for every user because /calls/:id in this router shadowed them.
 * The UUID-check failed for "stats" / "recent" and the handler
 * returned 404 instead of falling through to the catch-all apiRouter
 * declared later in routes/index.ts.
 *
 * These tests pin the fall-through so the same bug can't creep back
 * if a future edit reverts /calls/:id's non-UUID behavior to 404.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../middlewares/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.userId = req.headers["x-test-user-id"] || "user_test";
    req.businessId = req.headers["x-test-business-id"] || "biz_test";
    next();
  },
}));

import express from "express";
import http from "http";
import type { AddressInfo } from "net";

import callsRouter from "./calls";

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

let server: TestServer;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", callsRouter);
  // Sentinel handler that runs AFTER callsRouter — represents the
  // catch-all apiRouter position in routes/index.ts. When /calls/:id
  // falls through for a non-UUID param, this handler receives the
  // request and returns 200 with a marker payload.
  app.get("/api/calls/stats", (_req, res) => {
    res.json({ served_by: "sentinel_apiRouter_stats" });
  });
  app.get("/api/calls/recent", (_req, res) => {
    res.json({ served_by: "sentinel_apiRouter_recent" });
  });
  server = await startTestServer(app);
});

afterEach(async () => {
  await server.close();
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "x-test-user-id": "u1", "x-test-business-id": "biz_test" },
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

describe("Phase 5.5 — /calls/:id route ordering regression", () => {
  test("/api/calls/stats falls through to the next router (not 404 by /calls/:id)", async () => {
    const { status, body } = await get("/api/calls/stats");
    expect(status).toBe(200);
    expect(body).toEqual({ served_by: "sentinel_apiRouter_stats" });
  });

  test("/api/calls/recent falls through to the next router", async () => {
    const { status, body } = await get("/api/calls/recent?limit=500");
    expect(status).toBe(200);
    expect(body).toEqual({ served_by: "sentinel_apiRouter_recent" });
  });

  test("/api/calls/<junk-string> falls through (no route matches) — 404 from Express default", async () => {
    // Non-UUID + no sibling route registered → Express returns 404
    // from its default handler, NOT from /calls/:id's UUID check.
    // The critical guarantee is that /calls/:id doesn't SWALLOW it.
    const { status } = await get("/api/calls/notarealthing");
    expect(status).toBe(404);
  });

  test("/api/calls/resolve is still claimed by /calls/resolve (declared before /calls/:id)", async () => {
    // No sid query → 400 from /calls/resolve, not fall-through.
    const { status } = await get("/api/calls/resolve");
    expect(status).toBe(400);
  });

  test("/api/calls/<uuid> still gets handled by /calls/:id (does NOT fall through)", async () => {
    // A well-formed UUID that doesn't exist in the DB. Without
    // Supabase creds the handler returns 500 (Database not
    // configured); the important thing is that fall-through is NOT
    // engaged (we don't see 404).
    const { status } = await get(
      "/api/calls/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(status).not.toBe(404);
  });
});
