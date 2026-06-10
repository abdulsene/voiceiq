/**
 * /auth/me staff_role extension smoke harness.
 *
 * Verifies the response shape addition that powers the Sidebar's adminOnly
 * filter:
 *   T1 — customer (no user_roles row) → /auth/me returns staff_role: null.
 *        This is the EZ Rentals case — owner has no row, must see no admin
 *        nav items.
 *   T2 — active super_admin (user_roles row, status='active') → /auth/me
 *        returns staff_role: 'super_admin'.
 *   T3 — inactive staff (user_roles row, status='suspended') → /auth/me
 *        returns staff_role: null. Suspended staff must not keep seeing
 *        admin nav.
 *
 * Pure data-only — fixtures are created, asserted, and deleted in each
 * test's finally so a crash mid-run doesn't leak rows.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/010-auth-me-staff-role-smoke.ts
 *
 * Requires (env): SUPABASE_URL, SUPABASE_SERVICE_KEY, and the api-server
 * running locally (default http://localhost:8080; override via TEST_API_BASE).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function createFixtureUser(supa: SupabaseClient, suffix: string): Promise<{ userId: string; email: string; password: string }> {
  const email = `staffrole-${suffix}-${crypto.randomBytes(4).toString("hex")}@neverr.test`;
  const password = `pw_${crypto.randomBytes(6).toString("hex")}`;
  const { data, error } = await supa.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return { userId: data.user.id, email, password };
}

async function deleteFixtureUser(supa: SupabaseClient, userId: string) {
  try {
    // user_roles rows reference user_id; clean them first.
    await supa.from("user_roles").delete().eq("user_id", userId);
    await supa.auth.admin.deleteUser(userId);
  } catch (err) {
    console.warn(`cleanup: deleteUser(${userId}) failed`, err);
  }
}

async function callAuthMe(accessToken: string): Promise<{ http: number; json: any; text: string }> {
  const r = await fetch(`${API}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { http: r.status, json, text };
}

async function signIn(supa: SupabaseClient, email: string, password: string): Promise<string> {
  const { data, error } = await supa.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(`signIn failed: ${error?.message}`);
  }
  return data.session.access_token;
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — cannot run.");
    process.exit(1);
  }
  const supa = adminClient();

  // ----- T1: customer with no user_roles row → staff_role: null -----
  let t1User: { userId: string; email: string; password: string } | null = null;
  try {
    t1User = await createFixtureUser(supa, "t1-customer");
    const token = await signIn(supa, t1User.email, t1User.password);
    const r = await callAuthMe(token);
    if (r.http !== 200) {
      record("T1 customer (no user_roles) → 200", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    } else if (!Object.prototype.hasOwnProperty.call(r.json, "staff_role")) {
      record("T1 customer (no user_roles) → staff_role field present", false, `response missing staff_role: ${r.text.slice(0, 200)}`);
    } else if (r.json.staff_role !== null) {
      record("T1 customer (no user_roles) → staff_role: null", false, `got staff_role=${JSON.stringify(r.json.staff_role)}`);
    } else {
      record("T1 customer (no user_roles) → staff_role: null", true, "field present, value null");
    }
  } catch (err: any) {
    record("T1 customer (no user_roles) → staff_role: null", false, `threw: ${err.message}`);
  } finally {
    if (t1User) await deleteFixtureUser(supa, t1User.userId);
  }

  // ----- T2: active super_admin → staff_role: "super_admin" -----
  let t2User: { userId: string; email: string; password: string } | null = null;
  try {
    t2User = await createFixtureUser(supa, "t2-admin");
    const { error: insErr } = await supa.from("user_roles").insert({
      user_id: t2User.userId,
      email: t2User.email,
      role: "super_admin",
      status: "active",
      permissions: {},
    });
    if (insErr) throw new Error(`fixture user_roles insert failed: ${insErr.message}`);
    const token = await signIn(supa, t2User.email, t2User.password);
    const r = await callAuthMe(token);
    if (r.http !== 200) {
      record("T2 active super_admin → staff_role: super_admin", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    } else if (r.json.staff_role !== "super_admin") {
      record("T2 active super_admin → staff_role: super_admin", false, `got staff_role=${JSON.stringify(r.json.staff_role)}`);
    } else {
      record("T2 active super_admin → staff_role: super_admin", true, "field present, value super_admin");
    }
  } catch (err: any) {
    record("T2 active super_admin → staff_role: super_admin", false, `threw: ${err.message}`);
  } finally {
    if (t2User) await deleteFixtureUser(supa, t2User.userId);
  }

  // ----- T3: suspended staff → staff_role: null -----
  let t3User: { userId: string; email: string; password: string } | null = null;
  try {
    t3User = await createFixtureUser(supa, "t3-suspended");
    const { error: insErr } = await supa.from("user_roles").insert({
      user_id: t3User.userId,
      email: t3User.email,
      role: "admin",
      status: "suspended",
      permissions: {},
    });
    if (insErr) throw new Error(`fixture user_roles insert failed: ${insErr.message}`);
    const token = await signIn(supa, t3User.email, t3User.password);
    const r = await callAuthMe(token);
    if (r.http !== 200) {
      record("T3 suspended staff → staff_role: null", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    } else if (r.json.staff_role !== null) {
      record("T3 suspended staff → staff_role: null", false, `got staff_role=${JSON.stringify(r.json.staff_role)}`);
    } else {
      record("T3 suspended staff → staff_role: null", true, "suspended row degraded to null");
    }
  } catch (err: any) {
    record("T3 suspended staff → staff_role: null", false, `threw: ${err.message}`);
  } finally {
    if (t3User) await deleteFixtureUser(supa, t3User.userId);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
