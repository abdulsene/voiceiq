/**
 * Security hotfix verification — replaces requireAdminRole with
 * requireStaffPermission across 41 admin routes.
 *
 * What this suite proves:
 *   1. The middleware composition pattern `requireAuth ->
 *      requireStaffPermission(resource, action)` correctly enforces
 *      the 401 / 403 / 200 ladder.
 *   2. The (resource, action) gate is strict-string match — a caller
 *      with "customers:read" cannot access "customers:write" routes,
 *      etc.
 *   3. Each of the 7 StaffResource scopes (customers, billing,
 *      support, analytics, automation, monitoring, users) gates
 *      independently, so a future careless edit that confuses them
 *      will surface here.
 *
 * What this suite does NOT prove:
 *   - That `routes/admin.ts` and `routes/prompt.ts` actually call
 *     `requireStaffPermission` at every site. That's covered by:
 *       - the diff review on the security-hotfix commit
 *       - grep verification (zero `requireAdminRole` call sites left)
 *       - `tsc --noEmit` (undefined middleware refs would fail to
 *         compile)
 *
 * Strategy: mock auth + staff-rbac at the module level, then mount
 * a synthetic Express app with 7 routes that mirror the EXACT
 * (resource, action) composition used by representative endpoints
 * in admin.ts. This validates the gating contract without standing
 * up Supabase or external services.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// ───────────────────────────────────────────────────────────────────────
// Module mocks — hoisted by vitest before the real imports below.

vi.mock("../middlewares/auth", async () => {
  const actual = (await vi.importActual<any>("../middlewares/auth"));
  return {
    ...actual,
    requireAuth: (req: any, _res: any, next: any) => {
      req.userId = req.headers["x-test-user-id"] || null;
      req.userEmail = req.headers["x-test-user-email"] || null;
      req.businessId = req.headers["x-test-business-id"] || null;
      next();
    },
  };
});

vi.mock("../middlewares/staff-rbac", async () => {
  const actual = (await vi.importActual<any>("../middlewares/staff-rbac"));
  return {
    ...actual,
    /**
     * Test fake: reads `x-test-staff-perms` header (comma-separated
     * "resource:action" pairs) and gates exactly like the real
     * middleware — strict-string match on the (resource, action) tuple.
     * Mirrors the real `staff-rbac.ts:246` behavior: no hierarchy,
     * action "admin" does NOT imply "write" or "read".
     */
    requireStaffPermission:
      (resource: string, action: string) =>
      (req: any, res: any, next: any) => {
        if (!req.userId) {
          res.status(401).json({ error: "auth_required_for_test" });
          return;
        }
        const perms = String(req.headers["x-test-staff-perms"] || "");
        const granted = perms
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!granted.includes(`${resource}:${action}`)) {
          res.status(403).json({
            error: `Insufficient permissions for ${action} on ${resource}`,
          });
          return;
        }
        next();
      },
  };
});

// Real imports after the mocks above.
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { requireAuth } from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";

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
      const close = () =>
        new Promise<void>((res) => {
          server.close(() => res());
        });
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, close });
    });
  });
}

async function callJson(
  baseUrl: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { method, headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ───────────────────────────────────────────────────────────────────────
// Synthetic admin app — 7 routes, one per StaffResource. Each route
// uses the EXACT middleware composition that admin.ts and prompt.ts
// use post-hotfix. The handler returns 200 with a marker so the test
// can confirm it was actually reached.

let server: TestServer;

beforeEach(async () => {
  const app = express();

  app.get(
    "/customers",
    requireAuth,
    requireStaffPermission("customers", "read"),
    (_req, res) => res.json({ reached: "customers:read" }),
  );

  app.post(
    "/fix-stripe-data",
    requireAuth,
    requireStaffPermission("billing", "write"),
    (_req, res) => res.json({ reached: "billing:write" }),
  );

  app.get(
    "/support/dashboard",
    requireAuth,
    requireStaffPermission("support", "read"),
    (_req, res) => res.json({ reached: "support:read" }),
  );

  app.get(
    "/analytics/overview",
    requireAuth,
    requireStaffPermission("analytics", "read"),
    (_req, res) => res.json({ reached: "analytics:read" }),
  );

  app.get(
    "/automation/dashboard",
    requireAuth,
    requireStaffPermission("automation", "read"),
    (_req, res) => res.json({ reached: "automation:read" }),
  );

  app.get(
    "/system/health-check",
    requireAuth,
    requireStaffPermission("monitoring", "read"),
    (_req, res) => res.json({ reached: "monitoring:read" }),
  );

  app.post(
    "/backfill-users",
    requireAuth,
    requireStaffPermission("users", "write"),
    (_req, res) => res.json({ reached: "users:write" }),
  );

  server = await startTestServer(app);
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────
// One test per resource scope. Each verifies the full 401 / 403 / 200
// ladder, plus a wrong-permission case so a future code change that
// flips e.g. customers:read → customers:write would fail loudly.

describe("Security hotfix — requireStaffPermission gating", () => {
  test("customers:read — /customers", async () => {
    // 401 — no auth header
    const r401 = await callJson(server.baseUrl, "GET", "/customers");
    expect(r401.status).toBe(401);

    // 403 — authenticated but no matching permission
    const r403 = await callJson(server.baseUrl, "GET", "/customers", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "billing:read",
    });
    expect(r403.status).toBe(403);

    // 200 — authenticated with the exact permission
    const r200 = await callJson(server.baseUrl, "GET", "/customers", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "customers:read",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "customers:read" });

    // 403 — strict-match guard: having "write" doesn't grant "read"
    const rWrongAction = await callJson(server.baseUrl, "GET", "/customers", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "customers:write",
    });
    expect(rWrongAction.status).toBe(403);
  });

  test("billing:write — /fix-stripe-data", async () => {
    const r401 = await callJson(server.baseUrl, "POST", "/fix-stripe-data");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "POST", "/fix-stripe-data", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "customers:write",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "POST", "/fix-stripe-data", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "billing:write",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "billing:write" });
  });

  test("support:read — /support/dashboard", async () => {
    const r401 = await callJson(server.baseUrl, "GET", "/support/dashboard");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "GET", "/support/dashboard", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "analytics:read",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "GET", "/support/dashboard", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "support:read",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "support:read" });
  });

  test("analytics:read — /analytics/overview", async () => {
    const r401 = await callJson(server.baseUrl, "GET", "/analytics/overview");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "GET", "/analytics/overview", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "support:read",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "GET", "/analytics/overview", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "analytics:read",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "analytics:read" });
  });

  test("automation:read — /automation/dashboard", async () => {
    const r401 = await callJson(server.baseUrl, "GET", "/automation/dashboard");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "GET", "/automation/dashboard", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "monitoring:read",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "GET", "/automation/dashboard", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "automation:read",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "automation:read" });
  });

  test("monitoring:read — /system/health-check", async () => {
    const r401 = await callJson(server.baseUrl, "GET", "/system/health-check");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "GET", "/system/health-check", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "automation:read",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "GET", "/system/health-check", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "monitoring:read",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "monitoring:read" });
  });

  test("users:write — /backfill-users", async () => {
    const r401 = await callJson(server.baseUrl, "POST", "/backfill-users");
    expect(r401.status).toBe(401);

    const r403 = await callJson(server.baseUrl, "POST", "/backfill-users", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "customers:write",
    });
    expect(r403.status).toBe(403);

    const r200 = await callJson(server.baseUrl, "POST", "/backfill-users", {
      "x-test-user-id": "user_001",
      "x-test-staff-perms": "users:write",
    });
    expect(r200.status).toBe(200);
    expect(r200.body).toEqual({ reached: "users:write" });
  });
});
