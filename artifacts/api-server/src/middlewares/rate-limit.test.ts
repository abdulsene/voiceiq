/**
 * Phase 5.6 commit 2 — regression tests for the two-limiter dispatch.
 *
 * The bug this fixes: pre-5.6 the ONLY /api limiter was IP-keyed at
 * 100 / 15 min. A 4-person tenant behind one office NAT shared one
 * bucket, /api/auth/me started returning 429 within seconds, and the
 * client treated the 429 as a logout. Tests below pin the invariant
 * that (a) two users on the same IP get separate budgets, and
 * (b) anonymous traffic on the same IP gets its own third budget.
 *
 * These tests use a fake `resolveUserIdSoft` that reads req.userId
 * from a test header rather than calling Supabase. That keeps the
 * test hermetic and covers the limiter's contract directly: does the
 * dispatcher pick the right bucket given a userId? The cache /
 * single-flight behavior in the real resolver is orthogonal and
 * covered by its own module.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

import { createRateLimiters } from "./rate-limit";

// ───────────────────────────────────────────────────────────────────────
// Tiny in-process HTTP server harness (mirrors the pattern used in
// prompt.test.ts / calls.test.ts).

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

async function get(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers });
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

// ───────────────────────────────────────────────────────────────────────
// App factory — mimics production wiring with a fake soft resolver so
// the limiter's own behavior is what's under test.

function buildApp(userMax: number, ipMax: number): express.Express {
  const app = express();
  // Same trust-proxy config as production so X-Forwarded-For becomes
  // req.ip. Lets us simulate different clients behind one NAT.
  app.set("trust proxy", 1);

  // Fake resolveUserIdSoft — production version calls Supabase; this
  // one just reads a test header. Never rejects.
  app.use("/api", (req, _res, next) => {
    const uid = req.headers["x-test-user-id"];
    if (typeof uid === "string" && uid.length > 0) req.userId = uid;
    next();
  });

  const { dispatch } = createRateLimiters({
    userMax,
    ipMax,
    // Keep windowMs at the prod default (15 min) — tests don't wait
    // for the window to roll, they hit the limit within a burst.
  });
  app.use("/api", dispatch);

  app.get("/api/echo", (req, res) => {
    res.json({ userId: req.userId ?? null, ip: req.ip });
  });

  return app;
}

// ───────────────────────────────────────────────────────────────────────

let server: TestServer;

afterEach(async () => {
  if (server) await server.close();
});

// Suppress the console.warn + Sentry captureMessage output from the
// limiter handler so test logs stay readable. Restore between tests.
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const IP_OFFICE = "203.0.113.4"; // TEST-NET-3 range — never routable.
const TOKEN_A = "u1";
const TOKEN_B = "u2";

describe("Two-limiter dispatch (Phase 5.6 commit 2)", () => {
  test("two users behind the same IP each get their own bucket", async () => {
    // The regression that caused the customer report: with the old
    // single 100/15min IP-keyed limiter, 5 requests from user A + 5
    // from user B on the same IP would collectively count against 100.
    // With the fix, each user has their own 900 budget and shares
    // NONE of user B's counter.
    server = await startTestServer(buildApp(5, 5));

    // User A exhausts THEIR OWN budget with 5 requests.
    for (let i = 0; i < 5; i++) {
      const { status } = await get(server.baseUrl, "/api/echo", {
        "x-test-user-id": TOKEN_A,
        "x-forwarded-for": IP_OFFICE,
      });
      expect(status).toBe(200);
    }
    // 6th request from A trips their user bucket.
    const overflowA = await get(server.baseUrl, "/api/echo", {
      "x-test-user-id": TOKEN_A,
      "x-forwarded-for": IP_OFFICE,
    });
    expect(overflowA.status).toBe(429);

    // User B on the SAME IP should still have their full budget.
    // This is the pre-5.6 regression: with a shared IP bucket B
    // would already be 429ed too.
    for (let i = 0; i < 5; i++) {
      const { status } = await get(server.baseUrl, "/api/echo", {
        "x-test-user-id": TOKEN_B,
        "x-forwarded-for": IP_OFFICE,
      });
      expect(status).toBe(200);
    }
  });

  test("a single user exhausting 900 (here: userMax=3) gets 429", async () => {
    server = await startTestServer(buildApp(3, 100));

    for (let i = 0; i < 3; i++) {
      const { status } = await get(server.baseUrl, "/api/echo", {
        "x-test-user-id": TOKEN_A,
      });
      expect(status).toBe(200);
    }
    const overflow = await get(server.baseUrl, "/api/echo", {
      "x-test-user-id": TOKEN_A,
    });
    expect(overflow.status).toBe(429);
    expect(overflow.body).toEqual({
      error: "Too many requests, please try again later",
    });
  });

  test("anonymous request on the same IP has its own budget", async () => {
    // The dispatcher routes on req.userId presence. An anon caller
    // (no x-test-user-id header) falls to ipLimiter and gets 100/15min
    // regardless of what authenticated users on the same IP have
    // consumed. Verifies the two-bucket invariant: 3 users worth of
    // authenticated traffic plus one anon caller = 4 independent
    // buckets on the same IP.
    server = await startTestServer(buildApp(3, 3));

    // User A exhausts their user bucket.
    for (let i = 0; i < 3; i++) {
      const { status } = await get(server.baseUrl, "/api/echo", {
        "x-test-user-id": TOKEN_A,
        "x-forwarded-for": IP_OFFICE,
      });
      expect(status).toBe(200);
    }
    const userOverflow = await get(server.baseUrl, "/api/echo", {
      "x-test-user-id": TOKEN_A,
      "x-forwarded-for": IP_OFFICE,
    });
    expect(userOverflow.status).toBe(429);

    // Anonymous requests from the SAME IP get the ipLimiter's own 3
    // requests — unaffected by user A's exhaustion.
    for (let i = 0; i < 3; i++) {
      const { status } = await get(server.baseUrl, "/api/echo", {
        "x-forwarded-for": IP_OFFICE,
      });
      expect(status).toBe(200);
    }
    const anonOverflow = await get(server.baseUrl, "/api/echo", {
      "x-forwarded-for": IP_OFFICE,
    });
    expect(anonOverflow.status).toBe(429);
  });

  test("429 handler emits a structured log line with the tripped key", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    server = await startTestServer(buildApp(1, 100));

    // Burn user A's bucket then trip.
    await get(server.baseUrl, "/api/echo", { "x-test-user-id": TOKEN_A });
    await get(server.baseUrl, "/api/echo", { "x-test-user-id": TOKEN_A });

    // console.warn call format is: ("[rate-limit] tripped", "<json>")
    const rateLimitCalls = warnSpy.mock.calls.filter(
      (call) => call[0] === "[rate-limit] tripped",
    );
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);

    const payload = JSON.parse(rateLimitCalls[0][1] as string);
    expect(payload).toMatchObject({
      key: `user:${TOKEN_A}`,
      path: "/api/echo",
      method: "GET",
      userId: TOKEN_A,
    });
  });

  test("429 on anonymous traffic reports the IP-keyed bucket", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    server = await startTestServer(buildApp(100, 1));

    await get(server.baseUrl, "/api/echo", { "x-forwarded-for": IP_OFFICE });
    await get(server.baseUrl, "/api/echo", { "x-forwarded-for": IP_OFFICE });

    const rateLimitCalls = warnSpy.mock.calls.filter(
      (call) => call[0] === "[rate-limit] tripped",
    );
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(1);

    const payload = JSON.parse(rateLimitCalls[0][1] as string);
    expect(payload).toMatchObject({
      key: `ip:${IP_OFFICE}`,
      path: "/api/echo",
      method: "GET",
      userId: null,
    });
  });
});
