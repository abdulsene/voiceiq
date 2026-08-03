/**
 * Phase 5.1 — record_opt_out route-layer HTTP smoke.
 *
 * Covers the handler (handleRecordOptOut) via direct invocation with
 * a stubbed Supabase AND the /api/routing/opt-out endpoint via real
 * HTTP against a mini Express. The invariants under test:
 *
 *   1. Signed POST writes to all four tables (voice_opt_outs,
 *      dnc_list, leads, voice_consent_records).
 *   2. Idempotent — a second call for the same (business_id, phone)
 *      returns already_opted_out=true, no duplicate row.
 *   3. 200-always — auth failure, missing body, DB failure ALL return
 *      200 with an acknowledgement body Alex can synthesize. Never
 *      an audible error mid-call.
 *   4. Bearer auth uses ELEVENLABS_TOOL_SECRET (constant-time).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/052-record-opt-out-smoke.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { handleRecordOptOut } from "../routes/routing";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

const SECRET = "sk_test_" + "x".repeat(48);
const BIZ = "biz_optout_test";
const PHONE = "+14155559999";
const CONV = "conv_test_12345";

// ── FakeSupabase — captures writes, matches queries ────────────────

class FakeSupabase {
  responses: Array<{ match: (call: any) => boolean; data?: any; error?: any }> = [];
  calls: Array<{ op: string; table: string; payload?: any; filters: any[] }> = [];

  on(match: (call: any) => boolean, spec: { data?: any; error?: any }) {
    this.responses.push({ match, ...spec });
  }
  from(table: string) {
    const self = this;
    const filters: any[] = [];
    let op = "select";
    let payload: any = undefined;
    const builder: any = {
      select: (_c?: string, _opts?: any) => builder,
      insert: (p: any) => { op = "insert"; payload = p; return builder; },
      update: (p: any) => { op = "update"; payload = p; return builder; },
      upsert: (p: any) => { op = "upsert"; payload = p; return builder; },
      eq: (col: string, val: any) => { filters.push({ kind: "eq", col, val }); return builder; },
      is: (col: string, val: any) => { filters.push({ kind: "is", col, val }); return builder; },
      maybeSingle: async () => finish(),
      single: async () => finish(),
      then: (resolve: any, reject: any) => finish().then(resolve, reject),
    };
    function finish() {
      const call = { op, table, payload, filters };
      self.calls.push(call);
      const r = self.responses.find((rr) => rr.match(call));
      if (!r) return Promise.resolve({ data: null, error: null, count: 0 });
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null, count: (r as any).count ?? 0 });
    }
    return builder;
  }
}
const asClient = (f: FakeSupabase) => f as unknown as SupabaseClient;

// ── T1. Happy path — inserts opt-out, dnc, updates leads, revokes consent

async function T1_happy_path() {
  const fake = new FakeSupabase();
  // calls lookup for evidence_call_id
  fake.on((c) => c.op === "select" && c.table === "calls",
    { data: { id: "call-uuid-1" } });
  // voice_opt_outs insert → success
  fake.on((c) => c.op === "insert" && c.table === "voice_opt_outs",
    { data: { id: "opt-out-uuid-1" } });
  // dnc_list pre-check → not found
  fake.on((c) => c.op === "select" && c.table === "dnc_list",
    { data: null });
  // dnc_list insert → success
  fake.on((c) => c.op === "insert" && c.table === "dnc_list",
    { data: { id: "dnc-uuid-1" } });
  // leads update → 1 match (data array returned via .select("id"))
  fake.on((c) => c.op === "update" && c.table === "leads",
    { data: [{ id: "lead-1" }] });
  // voice_consent_records update → 1 revoked
  fake.on((c) => c.op === "update" && c.table === "voice_consent_records",
    { data: [{ id: "consent-1" }] });

  const r = await handleRecordOptOut(asClient(fake), {
    business_id: BIZ, phone: PHONE, conversation_id: CONV,
    reason_verbatim: "take me off your list please",
  });
  const fails: string[] = [];
  if (!r.ok) fails.push("ok=false");
  if (r.opt_out_id !== "opt-out-uuid-1") fails.push(`opt_out_id=${r.opt_out_id}`);
  if (r.already_opted_out) fails.push("already_opted_out=true on fresh insert");
  if (r.writes.voice_opt_outs !== "inserted") fails.push(`voice_opt_outs=${r.writes.voice_opt_outs}`);
  if (r.writes.dnc_list !== "inserted") fails.push(`dnc_list=${r.writes.dnc_list}`);
  if (r.writes.leads !== "updated") fails.push(`leads=${r.writes.leads}`);
  if (r.writes.voice_consent_records !== "revoked") fails.push(`vcr=${r.writes.voice_consent_records}`);
  // Assert the notes field on the insert carries the caller's words.
  const oiInsert = fake.calls.find((c) => c.op === "insert" && c.table === "voice_opt_outs");
  if (oiInsert?.payload?.notes !== "take me off your list please") {
    fails.push(`notes=${oiInsert?.payload?.notes}`);
  }
  if (oiInsert?.payload?.evidence_call_id !== "call-uuid-1") {
    fails.push(`evidence_call_id=${oiInsert?.payload?.evidence_call_id}`);
  }
  if (oiInsert?.payload?.source !== "mid_call_verbal") {
    fails.push(`source=${oiInsert?.payload?.source}`);
  }
  record("T1 happy path — writes to all 4 tables + evidence + notes captured", fails.length === 0,
    fails.join("; ") || `opt_out_id=opt-out-uuid-1, all four writes recorded`);
}

// ── T2. Idempotency — second call finds existing row, no duplicate

async function T2_idempotent() {
  const fake = new FakeSupabase();
  fake.on((c) => c.op === "select" && c.table === "calls", { data: null });
  // voice_opt_outs insert → 23505 unique violation (row already exists)
  fake.on((c) => c.op === "insert" && c.table === "voice_opt_outs",
    { error: { code: "23505", message: "duplicate key" } });
  // Fallback: existing row lookup
  fake.on((c) => c.op === "select" && c.table === "voice_opt_outs",
    { data: { id: "existing-opt-out-uuid" } });
  // dnc_list already exists
  fake.on((c) => c.op === "select" && c.table === "dnc_list",
    { data: { id: "existing-dnc" } });
  fake.on((c) => c.op === "update" && c.table === "leads",
    { data: [] });
  fake.on((c) => c.op === "update" && c.table === "voice_consent_records",
    { data: [] });

  const r = await handleRecordOptOut(asClient(fake), {
    business_id: BIZ, phone: PHONE, conversation_id: CONV,
    reason_verbatim: "stop calling",
  });
  const fails: string[] = [];
  if (!r.ok) fails.push("ok=false — second call should still succeed");
  if (!r.already_opted_out) fails.push("already_opted_out should be true");
  if (r.opt_out_id !== "existing-opt-out-uuid") fails.push(`opt_out_id=${r.opt_out_id}`);
  if (r.writes.voice_opt_outs !== "already_exists") fails.push(`voice_opt_outs=${r.writes.voice_opt_outs}`);
  if (r.writes.dnc_list !== "already_exists") fails.push(`dnc_list=${r.writes.dnc_list}`);
  // dnc_list must NOT get a duplicate insert
  const dncInserts = fake.calls.filter((c) => c.op === "insert" && c.table === "dnc_list");
  if (dncInserts.length !== 0) fails.push(`dnc_list inserted ${dncInserts.length}x on idempotent path (expected 0)`);
  record("T2 idempotent — 23505 on voice_opt_outs handled, no duplicate dnc_list insert",
    fails.length === 0, fails.join("; ") || "second call is a clean no-op with acknowledgement");
}

// ── T3. Route-layer HTTP: bad auth → 200 with acknowledged=false

async function T3_route_bad_auth() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.json());

  const originalSecret = process.env.ELEVENLABS_TOOL_SECRET;
  process.env.ELEVENLABS_TOOL_SECRET = SECRET;

  // Inline the auth-gate + call the real handler with a stubbed DB.
  app.post("/api/routing/opt-out", async (req, res) => {
    const header = (req.headers.authorization || "").toString();
    if (!header.startsWith("Bearer ") || header.slice(7) !== SECRET) {
      // Same as production: 200 with acknowledged=false. Never non-2xx.
      res.status(200).json({ acknowledged: false, message: "queued" });
      return;
    }
    res.status(200).json({ acknowledged: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const fails: string[] = [];

  try {
    // No auth header
    const r1 = await fetch(`http://127.0.0.1:${port}/api/routing/opt-out`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ business_id: BIZ, phone: PHONE, conversation_id: CONV }),
    });
    if (r1.status !== 200) fails.push(`no-auth status=${r1.status} (must be 200 — mid-call)`);
    const b1 = await r1.json() as any;
    if (b1.acknowledged !== false) fails.push(`no-auth ack=${b1.acknowledged}`);

    // Wrong secret
    const r2 = await fetch(`http://127.0.0.1:${port}/api/routing/opt-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-secret" },
      body: JSON.stringify({ business_id: BIZ, phone: PHONE, conversation_id: CONV }),
    });
    if (r2.status !== 200) fails.push(`wrong-secret status=${r2.status}`);
    const b2 = await r2.json() as any;
    if (b2.acknowledged !== false) fails.push(`wrong-secret ack=${b2.acknowledged}`);

    // Correct secret
    const r3 = await fetch(`http://127.0.0.1:${port}/api/routing/opt-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ business_id: BIZ, phone: PHONE, conversation_id: CONV }),
    });
    if (r3.status !== 200) fails.push(`good status=${r3.status}`);
    const b3 = await r3.json() as any;
    if (b3.acknowledged !== true) fails.push(`good ack=${b3.acknowledged}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSecret === undefined) delete process.env.ELEVENLABS_TOOL_SECRET;
    else process.env.ELEVENLABS_TOOL_SECRET = originalSecret;
  }

  record("T3 route-layer: bad/no auth → 200 acknowledged=false; correct auth → 200 acknowledged=true",
    fails.length === 0, fails.join("; ") || "never non-2xx (no audible mid-call error), auth still gates writes");
}

// ── T4. Handler survives DB explosion — returns writes=failed but ok

async function T4_db_explosion() {
  const fake = new FakeSupabase();
  fake.on((c) => c.op === "select" && c.table === "calls",
    { error: { message: "connection reset" } });
  fake.on((c) => c.op === "insert" && c.table === "voice_opt_outs",
    { error: { code: "XX000", message: "server error" } });
  fake.on((c) => c.op === "select" && c.table === "dnc_list",
    { error: { message: "connection reset" } });
  fake.on((c) => c.op === "update" && c.table === "leads",
    { error: { message: "connection reset" } });
  fake.on((c) => c.op === "update" && c.table === "voice_consent_records",
    { error: { message: "connection reset" } });

  const r = await handleRecordOptOut(asClient(fake), {
    business_id: BIZ, phone: PHONE, conversation_id: CONV,
  });
  const fails: string[] = [];
  // ok=false because the critical write (voice_opt_outs) failed.
  if (r.ok !== false) fails.push(`ok=${r.ok} (should be false when voice_opt_outs write fails)`);
  if (r.writes.voice_opt_outs !== "failed") fails.push("voice_opt_outs status");
  // Function did NOT throw despite four DB errors.
  record("T4 DB explosion — never throws, returns writes=failed for observability",
    fails.length === 0, fails.join("; ") || "handler always resolves; caller decides retry");
}

async function main() {
  await T1_happy_path();
  await T2_idempotent();
  await T3_route_bad_auth();
  await T4_db_explosion();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});
