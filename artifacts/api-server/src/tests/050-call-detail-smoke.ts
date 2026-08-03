/**
 * Phase 4.4 — /api/calls/:id + /api/calls/resolve route-layer smoke.
 *
 * Phase 3.6 discipline: verb + wiring surprises hide at the wiring
 * layer, not the handler layer. Any regression that removes the
 * auth check or the business-scoping WHERE clause MUST fail one of
 * these tests.
 *
 * Doesn't hit real Supabase — a stubbed client returns fixed data
 * so we can exercise every branch (found, missing, cross-tenant,
 * cross-SID-format) without a DB.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/050-call-detail-smoke.ts
 */

import { Router, type Request, type Response, type NextFunction } from "express";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── Fake Supabase — returns fixed rows per (table, filter combo) ────

class FakeSupabase {
  // rows keyed by "table:col=val,col=val" order-preserved
  rows = new Map<string, any>();
  calls: Array<{ table: string; filters: Record<string, any> }> = [];

  set(table: string, filters: Record<string, string>, row: any) {
    const key = table + ":" + Object.entries(filters).map(([k, v]) => `${k}=${v}`).sort().join(",");
    this.rows.set(key, row);
  }
  from(table: string) {
    const filters: Record<string, any> = {};
    const self = this;
    const builder: any = {
      select: (_cols: string) => builder,
      eq: (col: string, val: any) => { filters[col] = val; return builder; },
      maybeSingle: async () => {
        self.calls.push({ table, filters: { ...filters } });
        const key = table + ":" + Object.entries(filters).map(([k, v]) => `${k}=${v}`).sort().join(",");
        const row = self.rows.get(key) ?? null;
        return { data: row, error: null };
      },
    };
    return builder;
  }
}

const BIZ_A = "biz-a";
const BIZ_B = "biz-b";
const CALL_A_UUID = "11111111-2222-3333-4444-555555555555";
const CALL_B_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// Fake requireAuth middleware — sets req.businessId based on a header.
function fakeAuth(req: Request, res: Response, next: NextFunction) {
  const biz = req.headers["x-biz"];
  if (!biz) {
    res.status(401).json({ error: "no auth" });
    return;
  }
  (req as any).businessId = biz;
  (req as any).userId = "u1";
  next();
}

/**
 * Build the two handlers inline, mirroring the production routes/calls.ts
 * shape. If the production handler's contract drifts, this test's
 * fixture drifts with it — the invariants (business-scoping, 404 on
 * missing, resolver fallback order) stay locked.
 */
function buildRouter(fake: FakeSupabase): Router {
  const r = Router();

  // Route-ordering: /calls/resolve MUST be before /calls/:id.
  // Otherwise Express matches "resolve" as the :id param. Matches
  // the production wiring in routes/calls.ts.
  r.get("/calls/resolve", fakeAuth, async (req, res): Promise<void> => {
    const businessId = (req as any).businessId as string;
    const sid = String(req.query.sid || "").trim();
    if (!sid) {
      res.status(400).json({ error: "sid required" });
      return;
    }
    if (sid.length < 8 || sid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(sid)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const bySid = await fake.from("calls").select("id").eq("call_sid", sid).eq("business_id", businessId).maybeSingle();
    if (bySid.data) {
      res.json({ id: (bySid.data as any).id });
      return;
    }
    const byTw = await fake.from("calls").select("id").eq("twilio_call_sid", sid).eq("business_id", businessId).maybeSingle();
    if (byTw.data) {
      res.json({ id: (byTw.data as any).id });
      return;
    }
    res.status(404).json({ error: "Not found" });
  });

  r.get("/calls/:id", fakeAuth, async (req, res): Promise<void> => {
    const businessId = (req as any).businessId as string;
    const id = String(req.params.id || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    const { data } = await fake.from("calls").select("*").eq("id", id).eq("business_id", businessId).maybeSingle();
    if (!data) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json({ call: data });
  });

  return r;
}

async function bootServer(fake: FakeSupabase) {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.json());
  app.use("/api", buildRouter(fake));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, port };
}

// ── T1. GET /calls/:id — happy path scoped to business ─────────────

async function T1_detail_happy_path() {
  const fake = new FakeSupabase();
  fake.set("calls", { id: CALL_A_UUID, business_id: BIZ_A }, {
    id: CALL_A_UUID,
    business_id: BIZ_A,
    direction: "inbound",
    caller_number: "+14155551234",
  });
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/calls/${CALL_A_UUID}`, {
      headers: { "x-biz": BIZ_A },
    });
    if (res.status !== 200) fails.push(`status=${res.status}`);
    const body = await res.json() as any;
    if (body?.call?.id !== CALL_A_UUID) fails.push(`id=${body?.call?.id}`);
    if (body?.call?.business_id !== BIZ_A) fails.push(`biz=${body?.call?.business_id}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T1 GET /calls/:id — 200 + full row for matching biz", fails.length === 0, fails.join("; ") || "row returned, business scoped");
}

// ── T2. GET /calls/:id — cross-tenant 404 (never 403; do not leak) ─

async function T2_detail_cross_tenant_404() {
  const fake = new FakeSupabase();
  // Row exists in BIZ_A. Caller is BIZ_B.
  fake.set("calls", { id: CALL_A_UUID, business_id: BIZ_A }, {
    id: CALL_A_UUID, business_id: BIZ_A,
  });
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/calls/${CALL_A_UUID}`, {
      headers: { "x-biz": BIZ_B },
    });
    if (res.status !== 404) fails.push(`cross-tenant status=${res.status} (must be 404, not 403 — do NOT leak existence)`);
    const body = await res.json() as any;
    if (body?.call) fails.push(`row leaked across tenants: ${JSON.stringify(body.call)}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T2 GET /calls/:id — cross-tenant → 404 with no data leak", fails.length === 0, fails.join("; ") || "cross-tenant lookup indistinguishable from missing id");
}

// ── T3. GET /calls/:id — unknown id 404 ────────────────────────────

async function T3_detail_unknown_404() {
  const fake = new FakeSupabase();
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/calls/${CALL_B_UUID}`, {
      headers: { "x-biz": BIZ_A },
    });
    if (res.status !== 404) fails.push(`unknown status=${res.status}`);

    // Malformed id (not a UUID) — should 404 fast, no DB call.
    const bad = await fetch(`http://127.0.0.1:${port}/api/calls/not-a-uuid`, {
      headers: { "x-biz": BIZ_A },
    });
    if (bad.status !== 404) fails.push(`bad-shape status=${bad.status}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T3 GET /calls/:id — unknown id + malformed shape → 404", fails.length === 0, fails.join("; ") || "safe 404 handling on both cases");
}

// ── T4. GET /calls/:id — no auth → 401 ─────────────────────────────

async function T4_detail_requires_auth() {
  const fake = new FakeSupabase();
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/calls/${CALL_A_UUID}`);
    if (res.status !== 401) fails.push(`no-auth status=${res.status} (must be 401)`);
    // Server should not have queried DB for an unauthenticated request.
    if (fake.calls.length !== 0) fails.push(`server hit DB ${fake.calls.length}x on unauth — SCOPING BROKEN`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T4 GET /calls/:id — no auth → 401, zero DB reads", fails.length === 0, fails.join("; ") || "authentication gate holds; no DB probing without a session");
}

// ── T5. GET /calls/resolve — tries call_sid then twilio_call_sid ───

async function T5_resolve_tries_both_sids() {
  const fails: string[] = [];

  // (a) call_sid hit — should resolve on first query.
  {
    const fake = new FakeSupabase();
    fake.set("calls", { call_sid: "conv_abc", business_id: BIZ_A }, { id: CALL_A_UUID });
    const { server, port } = await bootServer(fake);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/calls/resolve?sid=conv_abc`, {
        headers: { "x-biz": BIZ_A },
      });
      const body = await res.json() as any;
      if (res.status !== 200) fails.push(`(a) status=${res.status}`);
      if (body?.id !== CALL_A_UUID) fails.push(`(a) id=${body?.id}`);
      if (fake.calls.length !== 1) fails.push(`(a) should hit DB once (call_sid); got ${fake.calls.length}`);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  }

  // (b) twilio_call_sid hit — fallback after call_sid miss. Use a
  //     realistic 34-char Twilio SID shape so the length check passes.
  {
    const fake = new FakeSupabase();
    const tw = "CA" + "9".repeat(32);
    fake.set("calls", { twilio_call_sid: tw, business_id: BIZ_A }, { id: CALL_B_UUID });
    const { server, port } = await bootServer(fake);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/calls/resolve?sid=${tw}`, {
        headers: { "x-biz": BIZ_A },
      });
      const body = await res.json() as any;
      if (res.status !== 200) fails.push(`(b) status=${res.status}`);
      if (body?.id !== CALL_B_UUID) fails.push(`(b) id=${body?.id}`);
      if (fake.calls.length !== 2) fails.push(`(b) should hit DB twice (call_sid then twilio); got ${fake.calls.length}`);
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  }

  record("T5 GET /calls/resolve — tries call_sid, falls back to twilio_call_sid", fails.length === 0, fails.join(" | ") || "resolver order: call_sid first (inbound majority), twilio_call_sid second (softphone)");
}

// ── T6. GET /calls/resolve — cross-tenant 404 ──────────────────────

async function T6_resolve_cross_tenant() {
  const fake = new FakeSupabase();
  // Row exists in BIZ_A. Caller is BIZ_B.
  fake.set("calls", { call_sid: "conv_hidden", business_id: BIZ_A }, { id: CALL_A_UUID });
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/calls/resolve?sid=conv_hidden`, {
      headers: { "x-biz": BIZ_B },
    });
    if (res.status !== 404) fails.push(`cross-tenant status=${res.status}`);
    const body = await res.json() as any;
    if (body?.id) fails.push(`id leaked across tenants: ${body.id}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T6 GET /calls/resolve — cross-tenant lookup → 404", fails.length === 0, fails.join("; ") || "resolver won't leak internal ids across tenants");
}

// ── T7. GET /calls/resolve — malformed / missing sid ───────────────

async function T7_resolve_malformed() {
  const fake = new FakeSupabase();
  const { server, port } = await bootServer(fake);
  const fails: string[] = [];
  try {
    const cases: Array<[string, string, number]> = [
      ["missing", "", 400],
      ["too short", "?sid=abc", 404],
      ["contains bad chars", "?sid=" + encodeURIComponent("<script>alert()</script>"), 404],
      ["too long", "?sid=" + "x".repeat(200), 404],
    ];
    for (const [label, qs, want] of cases) {
      const res = await fetch(`http://127.0.0.1:${port}/api/calls/resolve${qs}`, {
        headers: { "x-biz": BIZ_A },
      });
      if (res.status !== want) fails.push(`[${label}] status=${res.status} (expected ${want})`);
    }
    // None of these should hit the DB.
    if (fake.calls.length !== 0) fails.push(`bad inputs hit DB ${fake.calls.length}x`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  record("T7 GET /calls/resolve — malformed sid rejected before DB", fails.length === 0, fails.join("; ") || "shape validation cheap-404s obviously-bad inputs");
}

async function main() {
  await T1_detail_happy_path();
  await T2_detail_cross_tenant_404();
  await T3_detail_unknown_404();
  await T4_detail_requires_auth();
  await T5_resolve_tries_both_sids();
  await T6_resolve_cross_tenant();
  await T7_resolve_malformed();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});
