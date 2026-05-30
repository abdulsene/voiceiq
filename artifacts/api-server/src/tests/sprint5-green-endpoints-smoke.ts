/**
 * Sprint 5 — GREEN endpoints HTTP smoke harness.
 *
 * Probes the 7 enterprise endpoints the audit graded GREEN by code-read only.
 * Each endpoint is hit with a real Bearer token from a temp owner user
 * mapped to biz_1776968643213_dxwf60, and the response is asserted for
 * status + shape. State-changing endpoints have their side effects
 * verified or noted for manual cleanup.
 *
 * Idempotent: creates the fixture user + membership in setup, deletes both
 * in finally. No schema changes. PK columns untouched. Webhook/retention
 * rows that land in the contactPool DB are surfaced in the output for
 * manual cleanup since they live in a different DB than the Supabase
 * fixture and aren't referenced by FK from the deleted user.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/sprint5-green-endpoints-smoke.ts
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const TEST_BIZ_ID = "biz_1776968643213_dxwf60";

interface TestResult {
  endpoint: string;
  status: "PASS" | "FAIL" | "SKIP";
  http?: number;
  details: string;
}
const results: TestResult[] = [];
function record(endpoint: string, status: "PASS" | "FAIL" | "SKIP", http: number | undefined, details: string) {
  results.push({ endpoint, status, http, details });
  const tag = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "SKIP";
  console.log(`${tag}  ${endpoint}  http=${http ?? "-"}  ${details}`);
}

async function probe(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ http: number; body: any; raw: string }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Active-Business": TEST_BIZ_ID,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  const TEST_EMAIL = `green-smoke-${stamp}@neverr.test`;
  const TEST_PASSWORD = `GreenSmoke!${stamp}`;
  let createdUserId: string | null = null;
  let createdUb = false;
  let token: string | null = null;
  const manualCleanup: string[] = [];

  try {
    // ===== Setup: temp owner user mapped to existing test biz =====
    console.log(`[smoke] Creating fixture: user=${TEST_EMAIL} biz=${TEST_BIZ_ID}`);
    const { data: userCreated, error: userErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userErr || !userCreated.user) throw new Error(`createUser: ${userErr?.message}`);
    createdUserId = userCreated.user.id;
    console.log(`[smoke] user.id=${createdUserId.substring(0, 8)}`);

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
    console.log(`[smoke] obtained access_token (${token.substring(0, 12)}...)\n`);

    // Sanity: /api/auth/me with this token should be 200 and have userId set
    const me = await probe("GET", "/api/auth/me", token);
    if (me.http !== 200) {
      throw new Error(`Auth sanity failed: /api/auth/me returned ${me.http} body=${me.raw.slice(0, 200)}`);
    }
    console.log(`[smoke] auth sanity OK — /api/auth/me 200\n`);

    // ===== #2 POST /enterprise/bulk/users =====
    {
      const ep = "#2  POST /enterprise/bulk/users";
      try {
        // Use real domain (gmail) with +tag so Supabase invite validator
        // accepts it. @neverr.test is rejected (RFC 2606 reserved TLD).
        // The +tag keeps each run's email unique to avoid "user already
        // exists" on rerun. Per Abdul: invited user can stay, no cleanup.
        const fixtureEmail = `sene.abdul+sprint5-bulk-${stamp}@gmail.com`;
        const r = await probe("POST", "/api/enterprise/bulk/users", token, {
          users: [{ email: fixtureEmail, role: "user", firstName: "Bulk", lastName: "Smoke" }],
        });
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (typeof r.body.total !== "number" || !Array.isArray(r.body.results)) {
          record(ep, "FAIL", r.http, `unexpected shape: ${JSON.stringify(r.body).slice(0, 200)}`);
        } else {
          const created = (r.body.results || []).find((x: any) => x.email === fixtureEmail);
          if (created?.success && created.userId) {
            manualCleanup.push(`auth user '${fixtureEmail}' (id=${created.userId}) + user_businesses row`);
            record(ep, "PASS", r.http, `total=${r.body.total} successful=${r.body.successful} failed=${r.body.failed}`);
          } else {
            record(ep, "FAIL", r.http, `bulk row not successful: ${JSON.stringify(r.body.results).slice(0, 200)}`);
          }
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #6 POST /enterprise/integrations/crm/:id/trigger =====
    {
      const ep = "#6  POST /enterprise/integrations/crm/:id/trigger";
      try {
        // No CRM integration exists on the test biz. Probing with a fake id
        // proves auth + permission + route + integration-lookup all work.
        // 404 is the expected GREEN signal here. If we got 200 with a
        // bogus id, that would be a bug.
        const r = await probe("POST", "/api/enterprise/integrations/crm/nonexistent-crm-id/trigger", token, {
          action: "create_lead",
        });
        if (r.http === 404 && /not found/i.test(r.raw)) {
          record(ep, "PASS", r.http, `expected 404 (no CRM integration on test biz) — auth+route OK`);
        } else if (r.http === 400 && /action/i.test(r.raw)) {
          record(ep, "FAIL", r.http, `400 on action validation despite valid action — bug`);
        } else {
          record(ep, "FAIL", r.http, `expected 404, got body=${r.raw.slice(0, 200)}`);
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #7 POST /enterprise/webhooks =====
    {
      const ep = "#7  POST /enterprise/webhooks";
      try {
        // Use httpbin.org/post which echoes back 200 — the handler does a
        // 5s reachability check before saving.
        const r = await probe("POST", "/api/enterprise/webhooks", token, {
          name: `Smoke Webhook ${stamp}`,
          url: "https://httpbin.org/post",
          events: ["call.completed"],
        });
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (!r.body.id || !r.body.url) {
          record(ep, "FAIL", r.http, `missing id/url in response: ${JSON.stringify(r.body).slice(0, 200)}`);
        } else {
          manualCleanup.push(`enterprise_webhooks row id=${r.body.id} (Replit pg via contactPool)`);
          record(ep, "PASS", r.http, `id=${r.body.id} url=${r.body.url}`);
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #8 GET /enterprise/analytics/dashboard =====
    {
      const ep = "#8  GET /enterprise/analytics/dashboard";
      try {
        const r = await probe("GET", "/api/enterprise/analytics/dashboard?range=24h&timezone=UTC", token);
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (!r.body.metrics || !r.body.timeRange || !r.body.breakdowns) {
          record(ep, "FAIL", r.http, `missing required keys in response: ${Object.keys(r.body).join(",")}`);
        } else {
          record(
            ep,
            "PASS",
            r.http,
            `totalCalls=${r.body.metrics?.totalCalls ?? "?"} alerts=${r.body.alerts?.length ?? "?"}`,
          );
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #10 POST /enterprise/compliance/reports =====
    {
      const ep = "#10 POST /enterprise/compliance/reports";
      try {
        const r = await probe("POST", "/api/enterprise/compliance/reports", token, {
          reportType: "soc2",
        });
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (!r.body.id || !Array.isArray(r.body.findings)) {
          record(ep, "FAIL", r.http, `missing id/findings in response: ${JSON.stringify(r.body).slice(0, 200)}`);
        } else {
          record(ep, "PASS", r.http, `id=${r.body.id} findings=${r.body.findings.length}`);
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #11 POST /enterprise/security/pii/detect =====
    {
      const ep = "#11 POST /enterprise/security/pii/detect";
      try {
        const sample = "Hi, my SSN is 123-45-6789 and email is jdoe@example.com. Call me at 555-867-5309.";
        const r = await probe("POST", "/api/enterprise/security/pii/detect", token, { text: sample });
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (!Array.isArray(r.body.detections) || typeof r.body.totalFound !== "number") {
          record(ep, "FAIL", r.http, `unexpected shape: ${JSON.stringify(r.body).slice(0, 200)}`);
        } else if (r.body.totalFound < 1) {
          record(ep, "FAIL", r.http, `expected >=1 detection on SSN+email+phone sample, got 0`);
        } else {
          const types = (r.body.detections || []).map((d: any) => d.type).join(",");
          record(ep, "PASS", r.http, `totalFound=${r.body.totalFound} types=[${types}]`);
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }

    // ===== #14 POST /enterprise/security/retention/schedule =====
    {
      const ep = "#14 POST /enterprise/security/retention/schedule";
      try {
        const r = await probe("POST", "/api/enterprise/security/retention/schedule", token, {
          retentionDays: 90,
          categories: ["calls"],
          dryRun: true, // safe — does not delete data
        });
        if (r.http !== 200) {
          record(ep, "FAIL", r.http, `expected 200, body=${r.raw.slice(0, 250)}`);
        } else if (!r.body.id) {
          record(ep, "FAIL", r.http, `missing job id in response: ${JSON.stringify(r.body).slice(0, 200)}`);
        } else {
          manualCleanup.push(`enterprise_retention_jobs row id=${r.body.id} (Replit pg via contactPool, dry-run)`);
          record(ep, "PASS", r.http, `jobId=${r.body.id} dryRun=true`);
        }
      } catch (e: any) {
        record(ep, "FAIL", undefined, `exception: ${e.message}`);
      }
    }
  } catch (setupErr: any) {
    console.error(`\nFATAL setup error: ${setupErr.message}\n`);
  } finally {
    // ===== Teardown =====
    console.log("\n[smoke] Tearing down fixture...");
    if (createdUb && createdUserId) {
      await sb.from("user_businesses").delete().eq("user_id", createdUserId).eq("business_id", TEST_BIZ_ID);
      console.log("[smoke] deleted user_businesses row");
    }
    if (createdUserId) {
      const { error } = await sb.auth.admin.deleteUser(createdUserId);
      if (error) console.log(`[smoke] WARN: deleteUser failed: ${error.message}`);
      else console.log("[smoke] deleted auth.users row");
    }

    // Summary
    console.log("\n=== Sprint 5 GREEN endpoints smoke summary ===");
    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    const skipped = results.filter((r) => r.status === "SKIP").length;
    console.log(`Total: ${results.length}  PASS=${passed}  FAIL=${failed}  SKIP=${skipped}`);
    for (const r of results) {
      console.log(`  ${r.status}  ${r.endpoint}  http=${r.http ?? "-"}`);
    }
    if (manualCleanup.length > 0) {
      console.log("\nManual cleanup needed (rows that survived teardown):");
      for (const c of manualCleanup) console.log(`  - ${c}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
