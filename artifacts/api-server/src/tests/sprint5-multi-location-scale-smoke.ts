/**
 * Sprint 5 — Multi-location seeded scale smoke.
 *
 * Per the enterprise audit: today the largest production customer has 2
 * businesses. The platform's multi-business architecture (BUG-17 Pattern 2)
 * supports more on paper, but at scale (50+ locations under one customer)
 * the BusinessSwitcher dropdown, dashboard data fetches, and other UI
 * surfaces are untested. This harness seeds 50 businesses + locations under
 * one synthetic customer, probes the system, and surfaces breakage.
 *
 * SCOPE — observation only.
 *  - No code edited outside this file.
 *  - No Stripe writes (skipped per task brief — already trusted via BUG-17).
 *  - No deploy.
 *  - Cleanup is mandatory: deletes every fixture row and the synthetic auth
 *    user in finally{}. Verifies counts return to baseline.
 *
 * Strategy mirrors sprint5-audit-logs-smoke.ts:
 *  - Direct Supabase service-key writes for fixtures (bypasses /signup,
 *    bypasses Stripe — we're testing data-shape scale, not the payment
 *    flow).
 *  - Real Supabase password sign-in to mint a tenant access token.
 *  - All probes via HTTP against the running API server.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *      ./src/tests/sprint5-multi-location-scale-smoke.ts
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";

// ----------------------------------------------------------- env / config
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !serviceKey || !anonKey) {
  console.error(
    "Missing SUPABASE_URL / SUPABASE_SERVICE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY",
  );
  process.exit(2);
}

const API_BASE = process.env.API_BASE || "http://localhost:8080";
const N = Number(process.env.SCALE_N || 50);
const STAMP = Date.now().toString(36);
const TEST_EMAIL = `scale-test+${STAMP}@neverr.test`;
const PASSWORD = "ScaleTest!" + STAMP;
const BIZ_ID_PREFIX = `biz_scaletest_${STAMP}`;

// Industries to rotate through (sample from the 60 in industry_templates).
// Hard-coded so the smoke doesn't depend on a separate fetch round trip.
const INDUSTRIES = [
  "auto_repair",
  "hvac",
  "landscaping",
  "pest_control",
  "cleaning_service",
  "general_contractor",
  "plumbing",
  "electrician",
  "roofing",
  "painting",
  "marketing_agency",
  "it_msp",
  "bookkeeping",
  "estate_planning",
  "criminal_defense",
];

// ----------------------------------------------------------------- types
type ProbeResult = "PASS" | "FAIL" | "DEGRADED" | "SKIP";
type ProbeRecord = {
  name: string;
  result: ProbeResult;
  ms?: number;
  evidence?: string;
};

// ------------------------------------------------------------ http helper
async function getJson(token: string, path: string, headers?: Record<string,string>) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(headers || {}),
    },
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { http: r.status, body };
}

async function signIn(): Promise<string> {
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey! },
    body: JSON.stringify({ email: TEST_EMAIL, password: PASSWORD }),
  });
  const d: any = await r.json();
  if (!r.ok || !d?.access_token) {
    throw new Error(`signIn failed (${r.status}): ${JSON.stringify(d)}`);
  }
  return d.access_token as string;
}

// ----------------------------------------------------------------- main
async function main() {
  const sb = createClient(url!, serviceKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const probes: ProbeRecord[] = [];
  const rec = (
    name: string,
    result: ProbeResult,
    ms?: number,
    evidence?: string,
  ) => {
    probes.push({ name, result, ms, evidence });
    const tag = result === "PASS" ? "PASS"
      : result === "FAIL" ? "FAIL"
      : result === "SKIP" ? "SKIP" : "DEGR";
    console.log(
      `${tag}  ${name}` +
        (typeof ms === "number" ? `  ${ms}ms` : "") +
        (evidence ? `  ${evidence}` : ""),
    );
  };

  let synthUserId: string | null = null;
  const insertedBizIds: string[] = [];
  const baselineCounts = {
    business_configs: 0,
    user_businesses: 0,
    locations: 0,
  };

  try {
    // ----------------------------------------------- baseline counts (snapshot)
    {
      const bc = await sb
        .from("business_configs")
        .select("business_id", { count: "exact", head: true });
      const ub = await sb
        .from("user_businesses")
        .select("user_id", { count: "exact", head: true });
      const lc = await sb
        .from("locations")
        .select("business_id", { count: "exact", head: true });
      baselineCounts.business_configs = bc.count ?? 0;
      baselineCounts.user_businesses = ub.count ?? 0;
      baselineCounts.locations = lc.count ?? 0;
      console.log(
        `[scale-smoke] baseline: business_configs=${baselineCounts.business_configs} ` +
          `user_businesses=${baselineCounts.user_businesses} ` +
          `locations=${baselineCounts.locations}`,
      );
    }

    // ---------------------------------------------------- create synth user
    console.log(`[scale-smoke] Creating synth user ${TEST_EMAIL}`);
    const { data: created, error: cuErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cuErr) throw new Error(`createUser: ${cuErr.message}`);
    synthUserId = created.user!.id;
    console.log(`[scale-smoke] synth user id = ${synthUserId}`);

    // ---------------------------------------------------- seed N businesses
    const t0 = Date.now();
    const bizRows: any[] = [];
    const ubRows: any[] = [];
    const locRows: any[] = [];
    for (let i = 0; i < N; i++) {
      const bid = `${BIZ_ID_PREFIX}_${String(i + 1).padStart(3, "0")}`;
      insertedBizIds.push(bid);
      const industry = INDUSTRIES[i % INDUSTRIES.length];
      bizRows.push({
        business_id: bid,
        business_name: `Scale Test Loc ${i + 1}`,
        industry,
        ai_name: "Alex",
        tone: "professional",
        status: "active",
        email: TEST_EMAIL,
        timezone: "America/New_York",
        agent_id: null,
        plan_id: "essential",
        billing_cycle: "monthly",
        subscription_status: "active",
        onboarding_complete: true,
      });
      ubRows.push({
        user_id: synthUserId,
        business_id: bid,
        role: "owner",
      });
      locRows.push({
        business_id: bid,
        location_name: `Loc ${i + 1} HQ`,
        timezone: "America/New_York",
        is_primary: true,
        active: true,
      });
    }

    // Bulk insert business_configs
    {
      const r = await sb.from("business_configs").insert(bizRows);
      if (r.error) throw new Error(`business_configs insert: ${r.error.message}`);
    }
    // Bulk insert user_businesses
    {
      const r = await sb.from("user_businesses").insert(ubRows);
      if (r.error) throw new Error(`user_businesses insert: ${r.error.message}`);
    }
    // Bulk insert locations
    {
      const r = await sb.from("locations").insert(locRows);
      if (r.error)
        console.warn(`[scale-smoke] locations insert WARN: ${r.error.message}`);
    }
    const setupMs = Date.now() - t0;
    console.log(`[scale-smoke] seeded ${N} biz/user_biz/locations in ${setupMs}ms`);

    // Mint token for synth user
    const token = await signIn();
    console.log(`[scale-smoke] token minted`);

    // =========================================================== PROBE P1
    // GET /api/user/businesses — should return all N businesses, fast.
    {
      const tA = Date.now();
      const r = await getJson(token, `/api/user/businesses`);
      const ms = Date.now() - tA;
      const cnt = Array.isArray(r.body?.businesses)
        ? r.body.businesses.length
        : -1;
      let res: ProbeResult;
      if (r.http !== 200 || cnt !== N) res = "FAIL";
      else if (ms > 5000) res = "FAIL";
      else if (ms > 2000) res = "DEGRADED";
      else res = "PASS";
      rec(
        "P1 GET /api/user/businesses returns N businesses",
        res,
        ms,
        `http=${r.http} returned=${cnt} expected=${N}`,
      );
    }

    // =========================================================== PROBE P2
    // GET /api/business/configure?business_id=X looped over all N — N+1 sniff.
    // Budget per call: <500ms ideal, <1500ms degraded, >1500ms fail.
    // Loop budget: <25s ideal.
    {
      const perCall: number[] = [];
      let httpFail = 0;
      let nullConfig = 0;
      const tA = Date.now();
      for (const bid of insertedBizIds) {
        const tB = Date.now();
        const r = await getJson(
          token,
          `/api/business/configure?business_id=${encodeURIComponent(bid)}`,
          { "x-active-business": bid },
        );
        const dt = Date.now() - tB;
        perCall.push(dt);
        if (r.http !== 200) httpFail++;
        else if (!r.body?.config) nullConfig++;
      }
      const totalMs = Date.now() - tA;
      perCall.sort((a, b) => a - b);
      const p50 = perCall[Math.floor(perCall.length / 2)];
      const p95 = perCall[Math.floor(perCall.length * 0.95)];
      const max = perCall[perCall.length - 1];
      let res: ProbeResult;
      if (httpFail > 0 || nullConfig > 0) res = "FAIL";
      else if (max > 1500 || totalMs > 25000) res = "DEGRADED";
      else if (p95 > 500) res = "DEGRADED";
      else res = "PASS";
      rec(
        // Note: latency-only check. Linear p95 across N=50 implies no
        // *latency-blowing* N+1, but does not prove zero per-item DB
        // amplification — that needs query-count instrumentation which
        // is out of scope for this observation-only smoke.
        "P2 GET /api/business/configure × N (no latency blow-up at scale)",
        res,
        totalMs,
        `httpFail=${httpFail} nullConfig=${nullConfig} p50=${p50}ms p95=${p95}ms max=${max}ms`,
      );
    }

    // =========================================================== PROBE P3
    // DB query analysis: COUNT(*) FROM user_businesses for synth user.
    {
      const tA = Date.now();
      const { count, error } = await sb
        .from("user_businesses")
        .select("business_id", { count: "exact", head: true })
        .eq("user_id", synthUserId);
      const ms = Date.now() - tA;
      let res: ProbeResult;
      if (error) res = "FAIL";
      else if (count !== N) res = "FAIL";
      else if (ms > 1000) res = "DEGRADED";
      else res = "PASS";
      rec(
        "P3 DB count(user_businesses) = N for synth user",
        res,
        ms,
        `count=${count} error=${error?.message || "none"}`,
      );
    }

    // =========================================================== PROBE P4
    // Frontend BusinessSwitcher render-test — STATIC ANALYSIS
    // (Playwright requires the dashboard workflow up; per the operator's
    //  Sprint 5 hard rule the dashboard stays paused. Static analysis of
    //  the source is deterministic and answers the same three questions:
    //  does the dropdown have a max-h, a scroll cap, and search/filter?)
    {
      const sourcePath = join(
        process.cwd(),
        "../voiceiq-dashboard/src/components/BusinessSwitcher.tsx",
      );
      let src = "";
      try {
        src = readFileSync(sourcePath, "utf8");
      } catch {
        // Try absolute fallback
        try {
          src = readFileSync(
            "/home/runner/workspace/artifacts/voiceiq-dashboard/src/components/BusinessSwitcher.tsx",
            "utf8",
          );
        } catch {}
      }
      // Greedy match — nested conditional renders inside the dropdown
      // (e.g. `{showSearch && (...)}`) can introduce `</div>)}` patterns
      // before the OUTER dropdown close, which a non-greedy match would
      // stop at, silently truncating the captured JSX. Greedy walks to
      // the LAST `</div>)}` in the file, which is always the real
      // outer-dropdown close (nothing follows it but the function `}`).
      const dropdownMatch = src.match(/\{open && \(\s*<div([\s\S]*)<\/div>\s*\)\}/);
      const dropdownJsx = dropdownMatch?.[0] || "";
      const hasMaxH = /max-h-/.test(dropdownJsx);
      const hasOverflow = /overflow-y(-auto|-scroll)?/.test(dropdownJsx);
      const hasSearch =
        /\binput\b[^>]*type=["']search["']/i.test(src) ||
        /placeholder=["'][^"']*search/i.test(src) ||
        /filteredBusinesses|searchTerm/.test(src);
      // Sprint 5 P4 fix: separate hard markers (the 3 fixes the brief
      // mandates) from the informational dropdown-height note. The old
      // logic always pushed the height note into `issues`, so the array
      // was never empty and could never resolve to PASS — only FAIL or
      // DEGRADED. Now: 0 missing → PASS, 1-2 → DEGRADED, 3 → FAIL.
      const missingMarkers: string[] = [];
      if (!hasMaxH) missingMarkers.push("no max-h cap");
      if (!hasOverflow) missingMarkers.push("no overflow scroll");
      if (!hasSearch) missingMarkers.push("no search/filter input");
      // Each row ≈ 60-65px in this Tailwind layout. N=50 ⇒ ~3100px.
      const estPx = N * 62;
      const evidence =
        missingMarkers.length === 0
          ? `bounded (max-h cap + scroll + filter all present); raw N=${N} @ ~62px/row would be ${estPx}px without the cap`
          : `${missingMarkers.join(" | ")} | est dropdown height @ N=${N}: ~${estPx}px (typical viewport 720-900px)`;
      const res: ProbeResult =
        missingMarkers.length === 0
          ? "PASS"
          : missingMarkers.length >= 3
            ? "FAIL"
            : "DEGRADED";
      rec(
        "P4 BusinessSwitcher renders N entries",
        res,
        undefined,
        evidence,
      );
    }

    // =========================================================== PROBE P5
    // GET /api/analytics for one of the N businesses — must not crash on
    // a multi-tenant user (the synth user has 50 memberships).
    {
      const targetBiz = insertedBizIds[0];
      const tA = Date.now();
      const r = await getJson(
        token,
        `/api/analytics?business_id=${encodeURIComponent(targetBiz)}`,
        { "x-active-business": targetBiz },
      );
      const ms = Date.now() - tA;
      const ok = r.http === 200;
      let res: ProbeResult;
      if (!ok) res = "FAIL";
      else if (ms > 3000) res = "DEGRADED";
      else res = "PASS";
      rec(
        "P5 GET /api/analytics for one of N (multi-tenant user)",
        res,
        ms,
        `http=${r.http} body_keys=${r.body && typeof r.body === "object" ? Object.keys(r.body).slice(0, 6).join(",") : "n/a"}`,
      );
    }

    // =========================================================== PROBE P6
    // Stripe load test — explicitly skipped per task brief.
    rec(
      "P6 Stripe load test — SKIPPED per brief ($99×50 fees + BUG-17 already trusted)",
      "SKIP",
    );

    // =========================================================== PROBE P7
    // IDOR check on GET /api/business/configure — the synth user (who has
    // 50 fresh memberships) tries to fetch a business they are NOT a
    // member of. The handler at api.ts:5875 reads
    //   `const bid = business_id || req.businessId`
    // and queries business_configs without confirming the requested
    // business_id is in `req.businessIds`. If this returns 200 with a
    // populated config, the route has a tenant-scope bypass.
    //
    // We pick a *real* biz_id that exists in production but was not
    // seeded by us (find one outside our fixture prefix). We use a
    // service-key SELECT to grab a sample id — no production data is
    // mutated.
    {
      const { data: outsiders } = await sb
        .from("business_configs")
        .select("business_id")
        .not("business_id", "like", `${BIZ_ID_PREFIX}%`)
        .limit(1);
      const targetForeignBiz = outsiders?.[0]?.business_id as string | undefined;
      if (!targetForeignBiz) {
        rec("P7 IDOR /business/configure (no foreign biz to probe)", "SKIP");
      } else {
        const r = await getJson(
          token,
          `/api/business/configure?business_id=${encodeURIComponent(targetForeignBiz)}`,
        );
        const leaked =
          r.http === 200 && r.body?.config && r.body.config.business_id === targetForeignBiz;
        rec(
          "P7 IDOR /business/configure (foreign biz must NOT leak)",
          leaked ? "FAIL" : "PASS",
          undefined,
          leaked
            ? `LEAKED: foreign config returned (biz=${targetForeignBiz}, name=${r.body.config.business_name})`
            : `safe: http=${r.http} config=${r.body?.config ? "present" : "null"}`,
        );
      }
    }

    // ====================================================== PROBES P8-P10
    // Sprint 5 hotfix probes — verify Fixes B/C/D each block their
    // pre-fix bypass AND still allow the legitimate access path. Re-fetch
    // a foreign biz_id (P7's was inside its own scope) and use the synth
    // user's first own biz_id as the legitimate-access target.
    const { data: outsiders2 } = await sb
      .from("business_configs")
      .select("business_id")
      .not("business_id", "like", `${BIZ_ID_PREFIX}%`)
      .limit(1);
    const foreignBiz = outsiders2?.[0]?.business_id as string | undefined;
    const ownBiz = insertedBizIds[0];

    // ---------- P8: Fix B — /internal/transfer-config requires internal token
    {
      // Unauth: no internal-token header. Should 403 (was 200 with leak).
      // NOTE: validateInternalTransfer() has a localhost bypass (api.ts
      // line ~9050) — when Host starts with "localhost"/"127.0.0.1", it
      // returns true so dev-mode internal calls work without an
      // INTERNAL_API_TOKEN. The smoke runs against http://localhost:8080,
      // so we MUST spoof a non-localhost Host header to model the
      // production code path. (This same dev bypass is shared by every
      // other /internal/* route and is by design.)
      //
      // Node's fetch (undici) silently strips/rejects user-set Host
      // headers — we use the native http module which respects them.
      const probeId = foreignBiz || ownBiz || "biz_doesnotexist";
      const http = await import("http");
      const apiUrl = new URL(API_BASE);
      const p8Result = await new Promise<{ status: number; body: any }>((resolve) => {
        const req = http.request(
          {
            hostname: apiUrl.hostname,
            port: apiUrl.port || 80,
            path: `/api/internal/transfer-config/${encodeURIComponent(probeId)}`,
            method: "GET",
            headers: { Host: "api.neverr.ai" },
          },
          (resp) => {
            let raw = "";
            resp.on("data", (c) => (raw += c));
            resp.on("end", () => {
              let body: any = null;
              try { body = JSON.parse(raw); } catch {}
              resolve({ status: resp.statusCode || 0, body });
            });
          },
        );
        req.on("error", (e) => resolve({ status: 0, body: { error: e.message } }));
        req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, body: { error: "timeout" } }); });
        req.end();
      });
      const blocked = p8Result.status === 403;
      rec(
        "P8 Fix B /internal/transfer-config (no internal token must be 403)",
        blocked ? "PASS" : "FAIL",
        undefined,
        `http=${p8Result.status} body=${JSON.stringify(p8Result.body)?.slice(0, 80)}`,
      );
    }

    // ---------- P9: Fix C — /surveys/:businessId trio (foreign → 404, own → 200)
    if (!foreignBiz || !ownBiz) {
      rec("P9 Fix C /surveys/:businessId trio (no fixture pair to probe)", "SKIP");
    } else {
      const surveyPaths = [
        `/api/surveys/${encodeURIComponent(foreignBiz)}`,
        `/api/surveys/${encodeURIComponent(foreignBiz)}/stats`,
        `/api/surveys/${encodeURIComponent(foreignBiz)}/needs-followup`,
      ];
      const ownSurveyPath = `/api/surveys/${encodeURIComponent(ownBiz)}`;
      const foreignResults = await Promise.all(surveyPaths.map((p) => getJson(token, p)));
      const allBlocked = foreignResults.every((r) => r.http === 404);
      const ownR = await getJson(token, ownSurveyPath);
      const ownOk = ownR.http === 200 && Array.isArray(ownR.body?.surveys);
      rec(
        "P9 Fix C /surveys/:businessId × 3 (foreign must NOT leak, own still OK)",
        allBlocked && ownOk ? "PASS" : "FAIL",
        undefined,
        `foreign=[${foreignResults.map((r) => r.http).join(",")}] own=${ownR.http}`,
      );
    }

    // ---------- P10: Fix D — /usage/:businessId requires auth + membership
    {
      const probeId = foreignBiz || "biz_doesnotexist";
      // Unauth: no Bearer token. Should 401 (was 200 with full plan/usage).
      const rUnauth = await fetch(
        `${API_BASE}/api/usage/${encodeURIComponent(probeId)}`,
      );
      const unauthBlocked = rUnauth.status === 401;
      // Authed non-member: synth user has no membership for foreignBiz.
      // Should 404 (was 200 with full plan/usage).
      const rForeign = foreignBiz ? await getJson(token, `/api/usage/${encodeURIComponent(foreignBiz)}`) : null;
      const foreignBlocked = !rForeign || rForeign.http === 404;
      // Authed member: synth user IS member of ownBiz. Should 200.
      const rOwn = ownBiz ? await getJson(token, `/api/usage/${encodeURIComponent(ownBiz)}`) : null;
      const ownOk = !!rOwn && rOwn.http === 200;
      const allPass = unauthBlocked && foreignBlocked && ownOk;
      rec(
        "P10 Fix D /usage/:businessId (unauth=401, foreign=404, own=200)",
        allPass ? "PASS" : "FAIL",
        undefined,
        `unauth=${rUnauth.status} foreign=${rForeign?.http ?? "n/a"} own=${rOwn?.http ?? "n/a"}`,
      );
    }
  } catch (e: any) {
    rec("FATAL", "FAIL", undefined, e.message);
  } finally {
    // ============================================ MANDATORY CLEANUP
    // Cleanup is the most important part of this smoke. Failure to clean
    // up leaves rows in production. We:
    //  1. Delete in dependency order (locations → user_businesses →
    //     business_configs → auth.user) and HARD-FAIL on any error so
    //     Abdul sees it immediately.
    //  2. Verify residue with a FIXTURE-SCOPED query (LIKE biz_scaletest_<stamp>%)
    //     instead of global counts — concurrent production writes will
    //     no longer mask leaks or trip false alarms.
    console.log("\n[scale-smoke] Cleaning fixtures...");
    const cleanupErrors: string[] = [];
    if (insertedBizIds.length > 0) {
      const locDel = await sb
        .from("locations")
        .delete()
        .in("business_id", insertedBizIds);
      if (locDel.error) cleanupErrors.push(`locations: ${locDel.error.message}`);
      console.log(
        `[scale-smoke] deleted locations: error=${locDel.error?.message || "none"}`,
      );

      const ubDel = await sb
        .from("user_businesses")
        .delete()
        .in("business_id", insertedBizIds);
      if (ubDel.error) cleanupErrors.push(`user_businesses(biz): ${ubDel.error.message}`);
      console.log(
        `[scale-smoke] deleted user_businesses: error=${ubDel.error?.message || "none"}`,
      );

      const bcDel = await sb
        .from("business_configs")
        .delete()
        .in("business_id", insertedBizIds);
      if (bcDel.error) cleanupErrors.push(`business_configs: ${bcDel.error.message}`);
      console.log(
        `[scale-smoke] deleted business_configs: error=${bcDel.error?.message || "none"}`,
      );
    }
    if (synthUserId) {
      const ubAll = await sb
        .from("user_businesses")
        .delete()
        .eq("user_id", synthUserId);
      if (ubAll.error) cleanupErrors.push(`user_businesses(user): ${ubAll.error.message}`);
      console.log(
        `[scale-smoke] deleted any straggler user_businesses for synth user: error=${ubAll.error?.message || "none"}`,
      );
      try {
        await sb.auth.admin.deleteUser(synthUserId);
        console.log(`[scale-smoke] deleted auth user ${synthUserId}`);
      } catch (e: any) {
        cleanupErrors.push(`auth deleteUser: ${e?.message || e}`);
        console.log(`[scale-smoke] auth deleteUser warn: ${e?.message || e}`);
      }
    }

    // ---------- FIXTURE-SCOPED residue check (not global counts)
    // Race-safe: only counts rows we created ourselves.
    {
      const bcLeft = await sb
        .from("business_configs")
        .select("business_id", { count: "exact", head: true })
        .like("business_id", `${BIZ_ID_PREFIX}%`);
      const ubLeft = synthUserId
        ? await sb
            .from("user_businesses")
            .select("user_id", { count: "exact", head: true })
            .eq("user_id", synthUserId)
        : { count: 0, error: null };
      const locLeft = await sb
        .from("locations")
        .select("business_id", { count: "exact", head: true })
        .like("business_id", `${BIZ_ID_PREFIX}%`);

      const residue = {
        business_configs: bcLeft.count ?? 0,
        user_businesses: ubLeft.count ?? 0,
        locations: locLeft.count ?? 0,
      };
      const totalResidue =
        Math.abs(residue.business_configs) +
        Math.abs(residue.user_businesses) +
        Math.abs(residue.locations);
      console.log(
        `[scale-smoke] fixture-scoped residue: bc=${residue.business_configs} ` +
          `ub=${residue.user_businesses} loc=${residue.locations}`,
      );

      // Also log baseline → after global counts for visibility, but DO
      // NOT use them for the pass/fail decision.
      const bcAfter = await sb
        .from("business_configs")
        .select("business_id", { count: "exact", head: true });
      const ubAfter = await sb
        .from("user_businesses")
        .select("user_id", { count: "exact", head: true });
      const locAfter = await sb
        .from("locations")
        .select("business_id", { count: "exact", head: true });
      console.log(
        `[scale-smoke] global counts (informational only): ` +
          `bc=${bcAfter.count} (baseline=${baselineCounts.business_configs}) ` +
          `ub=${ubAfter.count} (baseline=${baselineCounts.user_businesses}) ` +
          `loc=${locAfter.count} (baseline=${baselineCounts.locations})`,
      );

      if (cleanupErrors.length > 0) {
        console.error(
          `[scale-smoke] ❌ CLEANUP HAD ERRORS:\n  - ${cleanupErrors.join("\n  - ")}`,
        );
      }
      if (totalResidue !== 0) {
        console.error(
          `[scale-smoke] ❌ FIXTURE RESIDUE DETECTED (${totalResidue} rows). ` +
            `Manual cleanup required: rows match LIKE '${BIZ_ID_PREFIX}%' or user_id=${synthUserId}.`,
        );
      } else if (cleanupErrors.length === 0) {
        console.log(
          `[scale-smoke] ✅ cleanup verified: zero fixture residue, no errors.`,
        );
      }
    }

    // -------------------- final summary
    const pass = probes.filter((p) => p.result === "PASS").length;
    const fail = probes.filter((p) => p.result === "FAIL").length;
    const degr = probes.filter((p) => p.result === "DEGRADED").length;
    const skip = probes.filter((p) => p.result === "SKIP").length;

    console.log(
      "\n=== Sprint 5 multi-location scale-smoke summary ===",
    );
    console.log(
      `Total: ${probes.length}  PASS=${pass}  DEGRADED=${degr}  FAIL=${fail}  SKIP=${skip}`,
    );
    for (const p of probes) {
      const tag =
        p.result === "PASS" ? "PASS"
          : p.result === "FAIL" ? "FAIL"
          : p.result === "SKIP" ? "SKIP" : "DEGR";
      console.log(
        `  ${tag}  ${p.name}` +
          (typeof p.ms === "number" ? `  ${p.ms}ms` : "") +
          (p.evidence ? `  ${p.evidence}` : ""),
      );
    }

    // verdict
    let verdict: string;
    if (fail > 0) verdict = "🔴 significant breakage — claim NOT supportable yet";
    else if (degr > 0) verdict = "🟡 works with specific issues — see DEGRADED items";
    else verdict = "🟢 multi-location scales cleanly to N";
    console.log(`\nVerdict: ${verdict}`);

    process.exit(fail > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("[scale-smoke] uncaught:", e);
  process.exit(2);
});
