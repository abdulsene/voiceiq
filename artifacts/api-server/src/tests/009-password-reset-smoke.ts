/**
 * Password reset smoke harness.
 *
 * What this exercises:
 *   T1 — POST /auth/forgot-password with an existing user's email returns
 *        204 (anti-enumeration: same wire shape regardless of whether the
 *        user exists). Doesn't assert email delivery; that would require a
 *        Resend-mock or live inbox. Just asserts the endpoint completed
 *        cleanly without surfacing user existence.
 *   T2 — POST /auth/forgot-password with a definitely-nonexistent email
 *        ALSO returns 204. This is the anti-enumeration assertion.
 *   T3 — POST /auth/forgot-password with a malformed email returns 400
 *        (zod schema rejects at the middleware layer before the handler).
 *   T4 — POST /auth/reset-password happy path: with a valid access_token
 *        (obtained via signInWithPassword on a fixture user), the password
 *        is updated and the user can sign in with the new password.
 *   T5 — POST /auth/reset-password with a bogus access_token returns 401
 *        (Supabase Auth's getUser rejects the JWT).
 *   T6 — POST /auth/reset-password with a too-short new_password returns
 *        400 (zod schema rejects).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/009-password-reset-smoke.ts
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

async function createFixtureUser(supa: SupabaseClient, suffix: string, password: string): Promise<{ userId: string; email: string }> {
  const email = `pwreset-${suffix}-${crypto.randomBytes(4).toString("hex")}@neverr.test`;
  const { data, error } = await supa.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
  return { userId: data.user.id, email };
}

async function deleteFixtureUser(supa: SupabaseClient, userId: string) {
  try {
    await supa.auth.admin.deleteUser(userId);
  } catch (err) {
    console.warn(`cleanup: deleteUser(${userId}) failed`, err);
  }
}

async function postJson(path: string, body: any): Promise<{ http: number; json: any; text: string }> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 204s have empty bodies */ }
  return { http: r.status, json, text };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — cannot run.");
    process.exit(1);
  }
  const supa = adminClient();

  // ----- T1: forgot-password, existing user -----
  let t1User: { userId: string; email: string } | null = null;
  try {
    t1User = await createFixtureUser(supa, "t1", "originalpass1");
    const r = await postJson("/api/auth/forgot-password", { email: t1User.email });
    if (r.http === 204) {
      record("T1 forgot-password existing user → 204", true, `http=204 body=${r.text || "(empty)"}`);
    } else {
      record("T1 forgot-password existing user → 204", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T1 forgot-password existing user → 204", false, `threw: ${err.message}`);
  } finally {
    if (t1User) await deleteFixtureUser(supa, t1User.userId);
  }

  // ----- T2: forgot-password, nonexistent email (anti-enumeration) -----
  try {
    const ghostEmail = `ghost-${crypto.randomBytes(4).toString("hex")}@neverr.test`;
    const r = await postJson("/api/auth/forgot-password", { email: ghostEmail });
    if (r.http === 204) {
      record("T2 forgot-password nonexistent email → 204 (anti-enumeration)", true, `http=204`);
    } else {
      record("T2 forgot-password nonexistent email → 204 (anti-enumeration)", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T2 forgot-password nonexistent email → 204 (anti-enumeration)", false, `threw: ${err.message}`);
  }

  // ----- T3: forgot-password, malformed email -----
  try {
    const r = await postJson("/api/auth/forgot-password", { email: "not-an-email" });
    if (r.http === 400) {
      record("T3 forgot-password malformed email → 400", true, `http=400`);
    } else {
      record("T3 forgot-password malformed email → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T3 forgot-password malformed email → 400", false, `threw: ${err.message}`);
  }

  // ----- T4: reset-password happy path -----
  let t4User: { userId: string; email: string } | null = null;
  try {
    const originalPassword = "originalpass4";
    const newPassword = "freshpass4567";
    t4User = await createFixtureUser(supa, "t4", originalPassword);
    // Mint a real access_token. The endpoint just validates the JWT via
    // getUser — it doesn't care whether the session came from a password
    // or a recovery link, mirroring the security envelope Supabase's own
    // updateUser({ password }) call provides client-side.
    const { data: sess, error: sessErr } = await supa.auth.signInWithPassword({
      email: t4User.email,
      password: originalPassword,
    });
    if (sessErr || !sess.session?.access_token) {
      throw new Error(`fixture signIn failed: ${sessErr?.message}`);
    }
    const r = await postJson("/api/auth/reset-password", {
      access_token: sess.session.access_token,
      new_password: newPassword,
    });
    if (r.http !== 200 || !r.json?.success) {
      record("T4 reset-password happy path → 200 + success", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    } else {
      // Verify the password actually changed: original should now fail,
      // new should succeed.
      const { error: oldShouldFail } = await supa.auth.signInWithPassword({
        email: t4User.email,
        password: originalPassword,
      });
      const { data: newSess, error: newShouldPass } = await supa.auth.signInWithPassword({
        email: t4User.email,
        password: newPassword,
      });
      if (oldShouldFail && newSess.session && !newShouldPass) {
        record("T4 reset-password happy path → password actually changed", true, "old rejected, new accepted");
      } else {
        record("T4 reset-password happy path → password actually changed", false, `oldErr=${oldShouldFail?.message} newErr=${newShouldPass?.message}`);
      }
    }
  } catch (err: any) {
    record("T4 reset-password happy path", false, `threw: ${err.message}`);
  } finally {
    if (t4User) await deleteFixtureUser(supa, t4User.userId);
  }

  // ----- T5: reset-password, bogus access_token -----
  try {
    // 100 chars of "x" passes the schema (min 20) but isn't a valid JWT;
    // Supabase getUser will reject it.
    const r = await postJson("/api/auth/reset-password", {
      access_token: "x".repeat(100),
      new_password: "anotherfreshpass",
    });
    if (r.http === 401) {
      record("T5 reset-password bogus token → 401", true, `http=401 body=${r.text.slice(0, 120)}`);
    } else {
      record("T5 reset-password bogus token → 401", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T5 reset-password bogus token → 401", false, `threw: ${err.message}`);
  }

  // ----- T6: reset-password, weak new_password -----
  try {
    const r = await postJson("/api/auth/reset-password", {
      access_token: "x".repeat(100),
      new_password: "short",
    });
    if (r.http === 400) {
      record("T6 reset-password weak password → 400", true, `http=400`);
    } else {
      record("T6 reset-password weak password → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T6 reset-password weak password → 400", false, `threw: ${err.message}`);
  }

  // ----- Summary -----
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
