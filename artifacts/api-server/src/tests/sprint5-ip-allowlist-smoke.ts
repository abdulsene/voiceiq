/**
 * Sprint 5 — enterpriseIPFilter end-to-end enforcement harness.
 *
 * First real proof that IP allowlisting works now that Phase 3 hydrates
 * `req.businessConfig.ipWhitelist`. Up until tonight the middleware was
 * a silent no-op for everyone (whitelist always undefined).
 *
 * Strategy:
 *  - Temp owner user mapped to biz_1776968643213_dxwf60 (Phase 2 test biz)
 *  - Promote plan_id='enterprise' via direct Supabase write (so the
 *    middleware's tier gate engages). Saved baseline restored in finally.
 *  - Set ip_whitelist via direct Supabase write (NOT via PUT /enterprise/config —
 *    that endpoint is itself IP-filter-gated, chicken-and-egg). Phase 2 smoke
 *    already proved the write path; this run tests the READ/ENFORCE path.
 *  - Probe POST /enterprise/security/pii/detect (gated, pure function, no
 *    side effects) and control the source IP via X-Forwarded-For header.
 *    `app.set("trust proxy", 1)` is enabled (app.ts:18) so XFF is honored.
 *
 * Idempotent: restores plan_id + ip_whitelist to their starting values
 * in finally. No schema changes. PK columns untouched.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/sprint5-ip-allowlist-smoke.ts
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
function rec(step: string, status: "PASS" | "FAIL", http: number | undefined, details: string) {
  steps.push({ step, status, http, details });
  console.log(`${status}  ${step}  http=${http ?? "-"}  ${details}`);
}

async function probe(
  token: string,
  forwardedFor: string | null,
  body: unknown,
): Promise<{ http: number; body: any; raw: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Active-Business": TEST_BIZ_ID,
  };
  if (forwardedFor) headers["X-Forwarded-For"] = forwardedFor;
  const r = await fetch(`${API}/api/enterprise/security/pii/detect`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let parsed: any = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { __raw: raw }; }
  return { http: r.status, body: parsed, raw };
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
  const TEST_EMAIL = `ip-smoke-${stamp}@neverr.test`;
  const TEST_PASSWORD = `IpSmoke!${stamp}`;
  let createdUserId: string | null = null;
  let createdUb = false;
  let token: string | null = null;
  let baselinePlan: string | null = null;
  let baselineWhitelist: any = null;

  try {
    // ===== Setup: temp owner user =====
    console.log(`[ip-smoke] Creating fixture: user=${TEST_EMAIL} biz=${TEST_BIZ_ID}`);
    const { data: userCreated, error: userErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userErr || !userCreated.user) throw new Error(`createUser: ${userErr?.message}`);
    createdUserId = userCreated.user.id;

    const { error: ubErr } = await sb.from("user_businesses").insert({
      user_id: createdUserId,
      business_id: TEST_BIZ_ID,
      role: "owner",
    });
    if (ubErr) throw new Error(`user_businesses insert: ${ubErr.message}`);
    createdUb = true;

    const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: signIn, error: signInErr } = await userClient.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr || !signIn.session) throw new Error(`signInWithPassword: ${signInErr?.message}`);
    token = signIn.session.access_token;
    console.log(`[ip-smoke] obtained access_token (${token.substring(0, 12)}...)`);

    // Read baseline
    const { data: rowBefore, error: rbErr } = await sb
      .from("business_configs")
      .select("plan_id, ip_whitelist")
      .eq("business_id", TEST_BIZ_ID)
      .single();
    if (rbErr || !rowBefore) throw new Error(`read baseline: ${rbErr?.message}`);
    baselinePlan = rowBefore.plan_id;
    baselineWhitelist = rowBefore.ip_whitelist;
    console.log(`[ip-smoke] baseline: plan_id=${baselinePlan} ip_whitelist=${JSON.stringify(baselineWhitelist)}\n`);

    // ===== Step 1: pre-promotion sanity (non-enterprise tier should bypass IP filter) =====
    {
      // Set a whitelist that wouldn't match anything
      await sb.from("business_configs").update({ ip_whitelist: ["9.9.9.9"] }).eq("business_id", TEST_BIZ_ID);
      const r = await probe(token, null, { text: "test" });
      if (r.http === 200) {
        rec("S1 non-enterprise + whitelist set → bypass (200)", "PASS", r.http, "tier gate works: non-enterprise no-ops");
      } else {
        rec("S1 non-enterprise + whitelist set → bypass (200)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Promote to enterprise tier =====
    const { error: promErr } = await sb
      .from("business_configs")
      .update({ plan_id: "enterprise", ip_whitelist: [] })
      .eq("business_id", TEST_BIZ_ID);
    if (promErr) throw new Error(`promote to enterprise: ${promErr.message}`);
    console.log(`[ip-smoke] promoted plan_id='enterprise', ip_whitelist=[]`);

    // ===== Step 2: enterprise tier + empty whitelist → bypass =====
    {
      const r = await probe(token, null, { text: "test" });
      if (r.http === 200) {
        rec("S2 enterprise + empty whitelist → bypass (200)", "PASS", r.http, "empty-whitelist short-circuit works");
      } else {
        rec("S2 enterprise + empty whitelist → bypass (200)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Set whitelist to a specific IP we can match later via XFF =====
    await sb.from("business_configs").update({ ip_whitelist: ["9.9.9.9"] }).eq("business_id", TEST_BIZ_ID);
    console.log(`[ip-smoke] set ip_whitelist=["9.9.9.9"]`);

    // ===== Step 3: enterprise + non-empty whitelist + no XFF → BLOCK =====
    {
      const r = await probe(token, null, { text: "test" });
      const blockedBody = /access denied from this ip/i.test(r.raw);
      if (r.http === 403 && blockedBody) {
        rec("S3 enterprise + WL=[9.9.9.9], no XFF → 403", "PASS", r.http, `blocked: body="${r.raw.slice(0, 60)}"`);
      } else {
        rec("S3 enterprise + WL=[9.9.9.9], no XFF → 403", "FAIL", r.http, `expected 403 'Access denied from this IP', body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Step 4: enterprise + WL=[9.9.9.9] + XFF=1.2.3.4 → BLOCK =====
    {
      const r = await probe(token, "1.2.3.4", { text: "test" });
      const blockedBody = /access denied from this ip/i.test(r.raw);
      if (r.http === 403 && blockedBody) {
        rec("S4 enterprise + WL=[9.9.9.9], XFF=1.2.3.4 → 403", "PASS", r.http, `blocked correctly`);
      } else {
        rec("S4 enterprise + WL=[9.9.9.9], XFF=1.2.3.4 → 403", "FAIL", r.http, `expected 403, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Step 5: enterprise + WL=[9.9.9.9] + XFF=9.9.9.9 → ALLOW =====
    {
      const r = await probe(token, "9.9.9.9", { text: "test" });
      if (r.http === 200) {
        rec("S5 enterprise + WL=[9.9.9.9], XFF=9.9.9.9 → 200", "PASS", r.http, `XFF matched whitelist`);
      } else {
        rec("S5 enterprise + WL=[9.9.9.9], XFF=9.9.9.9 → 200", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Step 6: regression — clear whitelist → ALLOW (no XFF needed) =====
    await sb.from("business_configs").update({ ip_whitelist: [] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, null, { text: "test" });
      if (r.http === 200) {
        rec("S6 enterprise + WL=[] → 200 (no XFF)", "PASS", r.http, `cleared whitelist short-circuits`);
      } else {
        rec("S6 enterprise + WL=[] → 200 (no XFF)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== Step 7: CIDR universal range (0.0.0.0/0) NOW allows all =====
    // Was asserting NOT-supported; flipped after OPTION X CIDR implementation.
    await sb.from("business_configs").update({ ip_whitelist: ["0.0.0.0/0"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "9.9.9.9", { text: "test" });
      if (r.http === 200) {
        rec("S7 WL=[0.0.0.0/0], XFF=9.9.9.9 → 200 (CIDR allows all)", "PASS", r.http, "universal CIDR range matches every IPv4");
      } else {
        rec("S7 WL=[0.0.0.0/0], XFF=9.9.9.9 → 200 (CIDR allows all)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S8: /8 in-range allow =====
    await sb.from("business_configs").update({ ip_whitelist: ["10.0.0.0/8"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "10.5.5.5", { text: "test" });
      if (r.http === 200) {
        rec("S8 WL=[10.0.0.0/8], XFF=10.5.5.5 → 200", "PASS", r.http, "/8 range matches");
      } else {
        rec("S8 WL=[10.0.0.0/8], XFF=10.5.5.5 → 200", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S9: /8 out-of-range block =====
    {
      const r = await probe(token, "192.168.1.1", { text: "test" });
      if (r.http === 403 && /access denied from this ip/i.test(r.raw)) {
        rec("S9 WL=[10.0.0.0/8], XFF=192.168.1.1 → 403", "PASS", r.http, "out of /8 range correctly blocked");
      } else {
        rec("S9 WL=[10.0.0.0/8], XFF=192.168.1.1 → 403", "FAIL", r.http, `expected 403, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S10: /24 small-range allow =====
    await sb.from("business_configs").update({ ip_whitelist: ["192.168.1.0/24"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "192.168.1.5", { text: "test" });
      if (r.http === 200) {
        rec("S10 WL=[192.168.1.0/24], XFF=192.168.1.5 → 200", "PASS", r.http, "/24 range matches");
      } else {
        rec("S10 WL=[192.168.1.0/24], XFF=192.168.1.5 → 200", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S11: /24 just-outside block =====
    {
      const r = await probe(token, "192.168.2.5", { text: "test" });
      if (r.http === 403 && /access denied from this ip/i.test(r.raw)) {
        rec("S11 WL=[192.168.1.0/24], XFF=192.168.2.5 → 403", "PASS", r.http, "adjacent /24 correctly blocked");
      } else {
        rec("S11 WL=[192.168.1.0/24], XFF=192.168.2.5 → 403", "FAIL", r.http, `expected 403, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S12: mixed CIDR + exact, exact match wins =====
    await sb.from("business_configs").update({ ip_whitelist: ["10.0.0.0/8", "9.9.9.9"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "9.9.9.9", { text: "test" });
      if (r.http === 200) {
        rec("S12 WL=[10.0.0.0/8, 9.9.9.9], XFF=9.9.9.9 → 200 (exact)", "PASS", r.http, "mixed list, exact entry matches");
      } else {
        rec("S12 WL=[10.0.0.0/8, 9.9.9.9], XFF=9.9.9.9 → 200 (exact)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S13: mixed CIDR + exact, CIDR match wins =====
    {
      const r = await probe(token, "10.5.5.5", { text: "test" });
      if (r.http === 200) {
        rec("S13 WL=[10.0.0.0/8, 9.9.9.9], XFF=10.5.5.5 → 200 (CIDR)", "PASS", r.http, "mixed list, CIDR entry matches");
      } else {
        rec("S13 WL=[10.0.0.0/8, 9.9.9.9], XFF=10.5.5.5 → 200 (CIDR)", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S14: malformed CIDR entry skipped, no other valid match → 403 =====
    await sb.from("business_configs").update({ ip_whitelist: ["malformed/99"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "9.9.9.9", { text: "test" });
      if (r.http === 403 && /access denied from this ip/i.test(r.raw)) {
        rec("S14 WL=[malformed/99], XFF=9.9.9.9 → 403", "PASS", r.http, "malformed entry skipped, no other match");
      } else {
        rec("S14 WL=[malformed/99], XFF=9.9.9.9 → 403", "FAIL", r.http, `expected 403, body=${r.raw.slice(0, 200)}`);
      }
    }

    // ===== S15: regression — exact-IP path still works (re-run of S5) =====
    await sb.from("business_configs").update({ ip_whitelist: ["9.9.9.9"] }).eq("business_id", TEST_BIZ_ID);
    {
      const r = await probe(token, "9.9.9.9", { text: "test" });
      if (r.http === 200) {
        rec("S15 regression: WL=[9.9.9.9], XFF=9.9.9.9 → 200", "PASS", r.http, "exact-IP path preserved post-CIDR refactor");
      } else {
        rec("S15 regression: WL=[9.9.9.9], XFF=9.9.9.9 → 200", "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 200)}`);
      }
    }
  } catch (setupErr: any) {
    console.error(`\nFATAL setup error: ${setupErr.message}\n`);
  } finally {
    // ===== Restore baseline =====
    console.log("\n[ip-smoke] Restoring baseline...");
    if (baselinePlan !== null) {
      const { error } = await sb
        .from("business_configs")
        .update({ plan_id: baselinePlan, ip_whitelist: baselineWhitelist })
        .eq("business_id", TEST_BIZ_ID);
      if (error) console.log(`[ip-smoke] WARN: restore failed: ${error.message}`);
      else console.log(`[ip-smoke] restored plan_id=${baselinePlan} ip_whitelist=${JSON.stringify(baselineWhitelist)}`);

      // Verify restore
      const { data: rowAfter } = await sb
        .from("business_configs")
        .select("plan_id, ip_whitelist")
        .eq("business_id", TEST_BIZ_ID)
        .single();
      console.log(`[ip-smoke] verify: plan_id=${rowAfter?.plan_id} ip_whitelist=${JSON.stringify(rowAfter?.ip_whitelist)}`);
    }

    if (createdUb && createdUserId) {
      await sb.from("user_businesses").delete().eq("user_id", createdUserId).eq("business_id", TEST_BIZ_ID);
      console.log("[ip-smoke] deleted user_businesses row");
    }
    if (createdUserId) {
      const { error } = await sb.auth.admin.deleteUser(createdUserId);
      if (error) console.log(`[ip-smoke] WARN: deleteUser failed: ${error.message}`);
      else console.log("[ip-smoke] deleted auth.users row");
    }

    // Summary
    console.log("\n=== Sprint 5 IP-allowlist smoke summary ===");
    const passed = steps.filter((s) => s.status === "PASS").length;
    const failed = steps.filter((s) => s.status === "FAIL").length;
    console.log(`Total: ${steps.length}  PASS=${passed}  FAIL=${failed}`);
    for (const s of steps) console.log(`  ${s.status}  ${s.step}  http=${s.http ?? "-"}`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
