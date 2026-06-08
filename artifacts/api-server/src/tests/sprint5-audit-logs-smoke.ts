/**
 * Sprint 5 — Admin audit-log viewer end-to-end smoke.
 *
 * Validates GET /api/admin/audit-logs:
 *  - 401 when no token
 *  - 403 for a non-admin user (role=user)
 *  - 200 for a user with an active user_roles row (staff RBAC)
 *  - filters: action, business_id, from/to, limit
 *  - pagination: offset reflected in response
 *  - audit-loop sanity: trigger an auth event, see the new row appear
 *
 * Strategy mirrors sprint5-ip-allowlist-smoke.ts:
 *  - Fresh temp users (admin + non-admin) on the existing test biz
 *  - Admin fixture also gets a `user_roles` row (role=admin, status=active)
 *    because the endpoint is gated by `requireStaffOrBootstrap` — once a
 *    super_admin exists in production (which it does), the tenant-owner
 *    bootstrap path is closed and only Neverr back-office staff get in.
 *  - Real Supabase password sign-in to mint access tokens
 *  - All probing via HTTP against the running API server
 *  - Idempotent: deletes both fixtures (user_roles too) in finally{}; no
 *    schema/PK touched
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *      ./src/tests/sprint5-audit-logs-smoke.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const TEST_BIZ_ID = "biz_1776968643213_dxwf60";

interface StepResult {
  step: string;
  status: "PASS" | "FAIL";
  http?: number;
  details: string;
}
const steps: StepResult[] = [];
function rec(
  step: string,
  status: "PASS" | "FAIL",
  http: number | undefined,
  details: string,
) {
  steps.push({ step, status, http, details });
  console.log(`${status}  ${step}  http=${http ?? "-"}  ${details}`);
}

async function getJson(
  token: string | null,
  path: string,
): Promise<{ http: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Active-Business": TEST_BIZ_ID,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { headers });
  const txt = await r.text();
  let body: any = {};
  try {
    body = txt ? JSON.parse(txt) : {};
  } catch {
    body = { __raw: txt };
  }
  return { http: r.status, body };
}

async function makeUser(
  sb: any, // supabase admin client; loose-typed to dodge generic mismatch
  email: string,
  password: string,
  role: "owner" | "user",
): Promise<{ userId: string; ubCreated: boolean }> {
  const { data: created, error: cErr } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (cErr || !created.user) throw new Error(`createUser: ${cErr?.message}`);
  const userId = created.user.id;

  const { error: ubErr } = await (sb as any)
    .from("user_businesses")
    .insert({ user_id: userId, business_id: TEST_BIZ_ID, role });
  if (ubErr) throw new Error(`user_businesses insert: ${ubErr.message}`);
  return { userId, ubCreated: true };
}

async function signIn(
  url: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<string> {
  const sbAnon = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: auth, error: aErr } = await sbAnon.auth.signInWithPassword({
    email,
    password,
  });
  if (aErr || !auth.session) throw new Error(`signIn: ${aErr?.message}`);
  return auth.session.access_token;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    console.error("FATAL: Missing SUPABASE env (URL / SERVICE_KEY / ANON_KEY)");
    process.exit(1);
  }
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = Date.now();
  const ADMIN_EMAIL = `audit-admin-${stamp}@neverr.test`;
  const USER_EMAIL = `audit-user-${stamp}@neverr.test`;
  const PASSWORD = `Audit!${stamp}`;
  let adminUserId: string | null = null;
  let userUserId: string | null = null;
  let adminToken: string | null = null;
  let userToken: string | null = null;

  try {
    console.log(
      `[audit-smoke] Creating fixtures: admin=${ADMIN_EMAIL} user=${USER_EMAIL} biz=${TEST_BIZ_ID}`,
    );
    const a = await makeUser(sb, ADMIN_EMAIL, PASSWORD, "owner");
    adminUserId = a.userId;
    const u = await makeUser(sb, USER_EMAIL, PASSWORD, "user");
    userUserId = u.userId;

    // Seat a back-office staff record for the admin fixture so the
    // requireStaffOrBootstrap gate accepts them. Use role=admin (NOT
    // super_admin) so this fixture cannot grant itself anything dangerous;
    // role=admin already has users.read which is all the gate checks.
    const { error: urErr } = await (sb as any)
      .from("user_roles")
      .insert({
        user_id: adminUserId,
        email: ADMIN_EMAIL,
        role: "admin",
        status: "active",
        permissions: {},
      });
    if (urErr) throw new Error(`user_roles insert: ${urErr.message}`);

    adminToken = await signIn(url, anonKey, ADMIN_EMAIL, PASSWORD);
    userToken = await signIn(url, anonKey, USER_EMAIL, PASSWORD);
    console.log(`[audit-smoke] tokens minted (admin/user); staff row seated`);

    // ------------------------------------------------------------- A1
    {
      const r = await getJson(null, "/api/admin/audit-logs?limit=1");
      rec(
        "A1 no auth → 401",
        r.http === 401 ? "PASS" : "FAIL",
        r.http,
        `body=${JSON.stringify(r.body).slice(0, 80)}`,
      );
    }

    // ------------------------------------------------------------- A2
    {
      const r = await getJson(userToken!, "/api/admin/audit-logs?limit=1");
      rec(
        "A2 non-admin (role=user) → 403",
        r.http === 403 ? "PASS" : "FAIL",
        r.http,
        `body=${JSON.stringify(r.body).slice(0, 80)}`,
      );
    }

    // ------------------------------------------------------------- A3
    let baselineTotal = 0;
    {
      const r = await getJson(adminToken!, "/api/admin/audit-logs?limit=5");
      const ok =
        r.http === 200 &&
        Array.isArray(r.body.logs) &&
        typeof r.body.total === "number" &&
        r.body.limit === 5 &&
        r.body.offset === 0;
      baselineTotal = r.body.total ?? 0;
      rec(
        "A3 admin → 200 + shape valid",
        ok ? "PASS" : "FAIL",
        r.http,
        `total=${baselineTotal} returned=${r.body.logs?.length ?? 0} limit=${r.body.limit} offset=${r.body.offset}`,
      );
    }

    // ------------------------------------------------------------- A4 (audit-loop sanity)
    // Trigger fresh audit events. The cleanest, no-side-effect trigger is
    // hitting a protected endpoint with no auth — app.ts logs `auth.rejected`
    // for every such request. Snapshot count → fire 3 → re-count → expect Δ≥3.
    {
      const before = await getJson(
        adminToken!,
        `/api/admin/audit-logs?limit=1&action=auth.rejected`,
      );
      const baseRej = before.body.total ?? 0;
      // Fire three no-auth probes against any protected endpoint
      await getJson(null, "/api/admin/audit-logs?limit=1");
      await getJson(null, "/api/admin/audit-logs?limit=1");
      await getJson(null, "/api/admin/audit-logs?limit=1");
      // Let the audit middleware flush (its insert is awaited but DB
      // visibility lags microscopically; 600ms is generous)
      await new Promise((res) => setTimeout(res, 600));
      const after = await getJson(
        adminToken!,
        `/api/admin/audit-logs?limit=1&action=auth.rejected`,
      );
      const newRej = after.body.total ?? 0;
      const delta = newRej - baseRej;
      rec(
        "A4 audit-loop → 3 fresh auth.rejected events visible (Δ≥3)",
        after.http === 200 && delta >= 3 ? "PASS" : "FAIL",
        after.http,
        `before=${baseRej} after=${newRej} delta=${delta}`,
      );
    }

    // ------------------------------------------------------------- A5
    // action filter: only matching rows. Use auth.rejected (we just
    // generated several; guaranteed to exist).
    {
      const r = await getJson(
        adminToken!,
        `/api/admin/audit-logs?limit=10&action=auth.rejected`,
      );
      const logs = r.body.logs || [];
      const allMatch =
        logs.length > 0 && logs.every((l: any) => l.action === "auth.rejected");
      rec(
        "A5 action filter → all rows action=auth.rejected",
        r.http === 200 && allMatch ? "PASS" : "FAIL",
        r.http,
        `returned=${logs.length} all_match=${allMatch}`,
      );
    }

    // ------------------------------------------------------------- A6
    // business_id filter: every returned row scoped to TEST_BIZ_ID
    {
      const r = await getJson(
        adminToken!,
        `/api/admin/audit-logs?limit=10&business_id=${TEST_BIZ_ID}`,
      );
      const logs = r.body.logs || [];
      const allScoped =
        logs.length === 0 ||
        logs.every((l: any) => l.business_id === TEST_BIZ_ID);
      rec(
        "A6 business_id filter → only that tenant",
        r.http === 200 && allScoped ? "PASS" : "FAIL",
        r.http,
        `returned=${logs.length} all_scoped=${allScoped}`,
      );
    }

    // ------------------------------------------------------------- A7
    // from/to filter: today only — should still return >0 rows since
    // we just inserted login events
    {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const tomorrow = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
      const r = await getJson(
        adminToken!,
        `/api/admin/audit-logs?limit=20&from=${todayStart.toISOString()}&to=${tomorrow.toISOString()}`,
      );
      const logs = r.body.logs || [];
      const allInRange = logs.every((l: any) => {
        const t = new Date(l.timestamp).getTime();
        return t >= todayStart.getTime() && t <= tomorrow.getTime();
      });
      rec(
        "A7 from/to filter → today's rows only",
        r.http === 200 && allInRange && logs.length > 0 ? "PASS" : "FAIL",
        r.http,
        `returned=${logs.length} all_in_range=${allInRange}`,
      );
    }

    // ------------------------------------------------------------- A8
    // pagination: offset reflected in response, different rows than page 0
    {
      const r1 = await getJson(adminToken!, `/api/admin/audit-logs?limit=3&offset=0`);
      const r2 = await getJson(adminToken!, `/api/admin/audit-logs?limit=3&offset=3`);
      const ids1 = new Set((r1.body.logs || []).map((l: any) => l.id));
      const ids2 = new Set((r2.body.logs || []).map((l: any) => l.id));
      const intersection = [...ids1].filter((id) => ids2.has(id));
      const offsetReflected = r2.body.offset === 3;
      const ok =
        r1.http === 200 &&
        r2.http === 200 &&
        offsetReflected &&
        intersection.length === 0;
      rec(
        "A8 pagination → offset reflected + non-overlapping page",
        ok ? "PASS" : "FAIL",
        r2.http,
        `page0=${ids1.size} page1=${ids2.size} overlap=${intersection.length} offset=${r2.body.offset}`,
      );
    }

    // ------------------------------------------------------------- A9
    // limit cap: requesting limit=10000 should cap at 500
    {
      const r = await getJson(adminToken!, `/api/admin/audit-logs?limit=10000`);
      rec(
        "A9 limit cap → 500 max",
        r.http === 200 && r.body.limit === 500 ? "PASS" : "FAIL",
        r.http,
        `returned_limit=${r.body.limit}`,
      );
    }

    // ------------------------------------------------------------- A10
    // bad date input → 400 with structured error (NOT a 500 with raw DB msg)
    {
      const r = await getJson(
        adminToken!,
        `/api/admin/audit-logs?from=not-a-date`,
      );
      const ok =
        r.http === 400 &&
        typeof r.body.error === "string" &&
        /from/i.test(r.body.error);
      rec(
        "A10 bad date input → 400 validation",
        ok ? "PASS" : "FAIL",
        r.http,
        `body=${JSON.stringify(r.body).slice(0, 100)}`,
      );
    }
  } catch (e: any) {
    rec("FATAL", "FAIL", undefined, e.message);
  } finally {
    console.log("\n[audit-smoke] Cleaning fixtures...");
    if (adminUserId) {
      // Order: child rows first (user_roles + user_businesses), then auth.user
      await (sb as any)
        .from("user_roles")
        .delete()
        .eq("user_id", adminUserId);
      await (sb as any)
        .from("user_businesses")
        .delete()
        .eq("user_id", adminUserId)
        .eq("business_id", TEST_BIZ_ID);
      await sb.auth.admin.deleteUser(adminUserId).catch(() => {});
      console.log(`[audit-smoke] deleted admin user ${adminUserId} + staff row`);
    }
    if (userUserId) {
      await (sb as any)
        .from("user_businesses")
        .delete()
        .eq("user_id", userUserId)
        .eq("business_id", TEST_BIZ_ID);
      await sb.auth.admin.deleteUser(userUserId).catch(() => {});
      console.log(`[audit-smoke] deleted non-admin user ${userUserId}`);
    }

    const pass = steps.filter((s) => s.status === "PASS").length;
    const fail = steps.filter((s) => s.status === "FAIL").length;
    console.log("\n=== Sprint 5 admin audit-logs smoke summary ===");
    console.log(`Total: ${steps.length}  PASS=${pass}  FAIL=${fail}`);
    for (const s of steps) {
      console.log(`  ${s.status}  ${s.step}  http=${s.http ?? "-"}`);
    }
    if (fail > 0) process.exit(1);
  }
}

main().catch((e) => {
  console.error("UNCAUGHT:", e);
  process.exit(2);
});
