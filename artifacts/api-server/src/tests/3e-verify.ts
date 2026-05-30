/**
 * Sprint 1 BUG-17 sub-step 3e verification harness.
 *
 * Creates an ISOLATED test fixture (one auth.users row, one business_configs
 * row, one user_businesses row), exercises every status the dashboard gate
 * cares about, then tears the fixture down in finally. Pure data-only — no
 * schema changes. PK columns untouched. Restores nothing on the existing DB
 * because the fixture itself is brand new and disposable.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/3e-verify.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.TEST_API_BASE || "http://localhost:8080";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${details}`);
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !serviceKey || !anonKey) {
    console.error("FATAL: Missing SUPABASE env (URL / SERVICE_KEY / ANON_KEY)");
    process.exit(1);
  }
  const sb = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const stamp = Date.now();
  const TEST_EMAIL = `sub3e-verify-${stamp}@neverr.test`;
  const TEST_PASSWORD = `Verify3e!${stamp}`;
  const TEST_BIZ_ID = `biz_3e_verify_${stamp}`;
  let createdUserId: string | null = null;
  let createdBiz = false;
  let createdUb = false;
  let token: string | null = null;

  try {
    // ===== Setup: create user + business + membership =====
    console.log(`[3e-verify] Creating fixture: user=${TEST_EMAIL} biz=${TEST_BIZ_ID}`);
    const { data: userCreated, error: userErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userErr || !userCreated.user) throw new Error(`createUser: ${userErr?.message}`);
    createdUserId = userCreated.user.id;
    console.log(`[3e-verify] user.id=${createdUserId.substring(0, 8)}`);

    const { error: bizErr } = await sb.from("business_configs").insert({
      business_id: TEST_BIZ_ID,
      business_name: "3e Verify Fixture",
      industry: "general",
      timezone: "America/New_York",
      status: "active",
      subscription_status: "pending_payment",
      plan_id: "professional",
      billing_cycle: "monthly",
      onboarding_complete: false,
    });
    if (bizErr) throw new Error(`business_configs insert: ${bizErr.message}`);
    createdBiz = true;

    const { error: ubErr } = await sb.from("user_businesses").insert({
      user_id: createdUserId,
      business_id: TEST_BIZ_ID,
      role: "owner",
    });
    if (ubErr) throw new Error(`user_businesses insert: ${ubErr.message}`);
    createdUb = true;

    // Login to get a session token (anon-key client mirrors real frontend)
    const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: signIn, error: signInErr } = await userClient.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr || !signIn.session) throw new Error(`signInWithPassword: ${signInErr?.message}`);
    token = signIn.session.access_token;
    console.log(`[3e-verify] obtained access_token (${token.substring(0, 12)}...)\n`);

    async function setStatus(status: string) {
      const { error } = await sb
        .from("business_configs")
        .update({ subscription_status: status })
        .eq("business_id", TEST_BIZ_ID);
      if (error) throw new Error(`set ${status}: ${error.message}`);
    }
    async function fetchSub(): Promise<{ http: number; body: any }> {
      const r = await fetch(`${API}/api/stripe/subscription/${encodeURIComponent(TEST_BIZ_ID)}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Active-Business": TEST_BIZ_ID },
      });
      const body = await r.json().catch(() => ({}));
      return { http: r.status, body };
    }
    async function fetchMe(): Promise<{ http: number; body: any }> {
      const r = await fetch(`${API}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, "X-Active-Business": TEST_BIZ_ID },
      });
      const body = await r.json().catch(() => ({}));
      return { http: r.status, body };
    }

    // ===== T1: pending_payment endpoint shape =====
    await setStatus("pending_payment");
    {
      const { http, body } = await fetchSub();
      const sub = body?.subscription;
      const ok = http === 200 && sub?.subscription_status === "pending_payment"
        && sub?.plan_id === "professional" && sub?.billing_cycle === "monthly";
      record("T1 pending_payment endpoint exposes status+plan+cycle for the gate",
        ok, `http=${http} status=${sub?.subscription_status} plan=${sub?.plan_id} cycle=${sub?.billing_cycle}`);
    }

    // ===== T2: trialing endpoint shape =====
    await setStatus("trialing");
    {
      const { http, body } = await fetchSub();
      record("T2 trialing flips endpoint status (gate must let user through)",
        http === 200 && body?.subscription?.subscription_status === "trialing",
        `http=${http} status=${body?.subscription?.subscription_status}`);
    }

    // ===== T3: active =====
    await setStatus("active");
    {
      const { http, body } = await fetchSub();
      record("T3 active flips endpoint status (gate must let user through)",
        http === 200 && body?.subscription?.subscription_status === "active",
        `http=${http} status=${body?.subscription?.subscription_status}`);
    }

    // ===== T4: past_due =====
    await setStatus("past_due");
    {
      const { http, body } = await fetchSub();
      record("T4 past_due is reported (gate intentionally does NOT block past_due)",
        http === 200 && body?.subscription?.subscription_status === "past_due",
        `http=${http} status=${body?.subscription?.subscription_status}`);
    }

    // ===== T5: cancelled =====
    await setStatus("cancelled");
    {
      const { http, body } = await fetchSub();
      record("T5 cancelled is reported (gate does NOT block cancelled — keep view-only access)",
        http === 200 && body?.subscription?.subscription_status === "cancelled",
        `http=${http} status=${body?.subscription?.subscription_status}`);
    }

    // ===== T6: /auth/me carries this business in memberships under the active header =====
    {
      const { http, body } = await fetchMe();
      const list = body?.businesses || [];
      const has = list.some((b: any) => b.business_id === TEST_BIZ_ID);
      record("T6 /auth/me returns the business in memberships (gate uses this to find businessId)",
        http === 200 && has, `http=${http} match=${has} count=${list.length}`);
    }

    // ===== T7: endpoint returns subscription:null defensively for an unknown businessId =====
    {
      const r = await fetch(`${API}/api/stripe/subscription/biz_no_such_3e_xxxx`, {
        headers: { Authorization: `Bearer ${token}`, "X-Active-Business": TEST_BIZ_ID },
      });
      const body: any = await r.json().catch(() => ({}));
      const ok = r.status < 500;
      record("T7 endpoint handles unknown businessId without 5xx (gate fail-open path stays clean)",
        ok, `http=${r.status} body=${JSON.stringify(body).substring(0, 80)}`);
    }

    // ===== T8: dashboard SPA shell renders =====
    {
      const r = await fetch("http://localhost:80/dashboard/");
      const html = await r.text();
      const ok = r.ok && html.includes("</html>") && html.includes("<div id=\"root\"");
      record("T8 dashboard SPA shell loads (vite is serving)",
        ok, `http=${r.status} bytes=${html.length}`);
    }

    // ===== T9: Signup.tsx imports hoisted constants =====
    {
      const fs = await import("node:fs/promises");
      const sig = await fs.readFile(
        "/home/runner/workspace/artifacts/voiceiq-dashboard/src/pages/Signup.tsx", "utf-8");
      const ok = sig.includes('from "../lib/plans"')
        && sig.includes("PLAN_PRICES") && sig.includes("VALID_PLANS")
        && /handleCancelledResume/.test(sig)
        && sig.includes('checkout") === "cancelled"');
      record("T9 Signup.tsx hoisted import + cancelled-banner handler in place",
        ok, ok ? "import+handler+param-detect found" : "missing pieces");
    }

    // ===== T10: lib/plans.ts surface =====
    {
      const fs = await import("node:fs/promises");
      const lib = await fs.readFile(
        "/home/runner/workspace/artifacts/voiceiq-dashboard/src/lib/plans.ts", "utf-8");
      const ok =
        lib.includes("export const PLAN_PRICES") &&
        lib.includes("export const VALID_PLANS") &&
        lib.includes("export function getPlanMeta") &&
        lib.includes("export function formatPriceLabel") &&
        ["essential", "starter", "professional", "growth", "business", "enterprise"].every((p) => lib.includes(`${p}:`));
      record("T10 lib/plans.ts exports PLAN_PRICES + VALID_PLANS + helpers + 6 plans",
        ok, ok ? "complete" : "missing exports");
    }

    // ===== T11: PendingPaymentScreen + DashboardLayout gate hookup =====
    {
      const fs = await import("node:fs/promises");
      const screen = await fs.readFile(
        "/home/runner/workspace/artifacts/voiceiq-dashboard/src/components/PendingPaymentScreen.tsx", "utf-8");
      const app = await fs.readFile(
        "/home/runner/workspace/artifacts/voiceiq-dashboard/src/App.tsx", "utf-8");
      const screenOk = screen.includes("Resume Checkout")
        && screen.includes("create-checkout-session")
        && screen.includes("Choose a different plan")
        && screen.includes("Sign out");
      const appOk = app.includes('import PendingPaymentScreen from "./components/PendingPaymentScreen"')
        && app.includes('"pending_payment"')
        && app.includes("polling_success") && app.includes("polling_timeout")
        && app.includes("stripCheckoutSuccessParam")
        && app.includes("SuccessToast");
      record("T11 PendingPaymentScreen + DashboardLayout gate fully wired",
        screenOk && appOk, `screen=${screenOk} app=${appOk}`);
    }
  } finally {
    // ===== Teardown: delete fixture rows then user =====
    if (createdUb) {
      const { error } = await sb.from("user_businesses").delete().eq("business_id", TEST_BIZ_ID);
      if (error) console.error(`[teardown] user_businesses delete err: ${error.message}`);
    }
    if (createdBiz) {
      const { error } = await sb.from("business_configs").delete().eq("business_id", TEST_BIZ_ID);
      if (error) console.error(`[teardown] business_configs delete err: ${error.message}`);
    }
    if (createdUserId) {
      const { error } = await sb.auth.admin.deleteUser(createdUserId);
      if (error) console.error(`[teardown] deleteUser err: ${error.message}`);
    }
    console.log(`\n[3e-verify] Teardown complete (user=${createdUserId?.substring(0, 8)} biz=${TEST_BIZ_ID})`);
  }

  // ===== Summary =====
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log(`\n========== 3e VERIFICATION ==========`);
  console.log(`PASS: ${pass} / ${results.length}`);
  console.log(`FAIL: ${fail} / ${results.length}`);
  if (fail > 0) {
    console.log("\nFailures:");
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name}: ${r.details}`));
    process.exit(1);
  }
}

main().catch((e) => { console.error("FATAL:", e); process.exit(2); });
