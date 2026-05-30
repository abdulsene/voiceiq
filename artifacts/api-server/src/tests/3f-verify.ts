/**
 * Sprint 1 BUG-17 sub-step 3f verification harness.
 *
 * Closes the unauth'd /onboard endpoint and removes the in-app affordances
 * that pointed at it (Sidebar wizard, Analytics CTA, /onboarding route).
 *
 * Strategy:
 *   - Network checks (T1-T4) hit the /onboard endpoint with anonymous / bad-
 *     token / authed-but-invalid bodies, all of which fail BEFORE any real
 *     ElevenLabs agent is provisioned. We never send a fully-valid /onboard
 *     body in tests, so no real money is spent.
 *   - Source checks (T5-T8) read the modified files and assert the structural
 *     changes (middleware wired, imports/components removed). These guard
 *     against future regressions where someone re-introduces the broken UI.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx ./src/tests/3f-verify.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${details}`);
}

async function readRepoFile(rel: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, rel), "utf8");
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
  const TEST_EMAIL = `sub3f-verify-${stamp}@neverr.test`;
  const TEST_PASSWORD = `Verify3f!${stamp}`;
  let createdUserId: string | null = null;
  let token: string | null = null;

  try {
    // ===== Setup: one disposable auth.users row, no business yet =====
    console.log(`[3f-verify] Creating fixture: user=${TEST_EMAIL}`);
    const { data: userCreated, error: userErr } = await sb.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
    });
    if (userErr || !userCreated.user) throw new Error(`createUser: ${userErr?.message}`);
    createdUserId = userCreated.user.id;
    console.log(`[3f-verify] user.id=${createdUserId.substring(0, 8)}`);

    const userClient = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: signIn, error: signInErr } = await userClient.auth.signInWithPassword({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    });
    if (signInErr || !signIn.session) throw new Error(`signInWithPassword: ${signInErr?.message}`);
    token = signIn.session.access_token;
    console.log(`[3f-verify] obtained access_token (${token.substring(0, 12)}...)\n`);

    const validBody = JSON.stringify({
      business_name: "3f Verify Co",
      industry: "general",
      email: TEST_EMAIL,
    });

    // ===== T1: anonymous POST /onboard rejected =====
    {
      const r = await fetch(`${API}/api/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: validBody,
      });
      const ok = r.status === 401;
      record("T1 anonymous POST /onboard returns 401",
        ok, `http=${r.status} (expected 401 — auth gate)`);
    }

    // ===== T2: garbage Bearer token rejected =====
    {
      const r = await fetch(`${API}/api/onboard`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer not-a-real-jwt-at-all",
        },
        body: validBody,
      });
      const ok = r.status === 401;
      record("T2 garbage Bearer POST /onboard returns 401",
        ok, `http=${r.status} (expected 401 — bad token rejected)`);
    }

    // ===== T3: authed POST with missing required fields returns 400 =====
    // Proves the validation in the handler still runs AFTER requireAuth
    // succeeds. We send {} so business_name/industry/email are missing.
    // No ElevenLabs call is reached because the handler returns early.
    {
      const r = await fetch(`${API}/api/onboard`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      const body: any = await r.json().catch(() => ({}));
      const ok = r.status === 400 && typeof body?.error === "string"
        && body.error.includes("required");
      record("T3 authed POST /onboard with empty body returns 400 (validation)",
        ok, `http=${r.status} error=${JSON.stringify(body?.error)}`);
    }

    // ===== T4: rate limiter wired — 6 rapid anonymous POSTs =====
    // costlyLimiter runs BEFORE requireAuth in the middleware chain, so an
    // anonymous burst will get 401s until the limiter trips, then 429.
    // We don't depend on a clean baseline — we just assert that the burst
    // contains AT LEAST ONE 429, proving the limiter is mounted on this
    // route. (Without it every response would be 401.)
    {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        const r = await fetch(`${API}/api/onboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: validBody,
        });
        statuses.push(r.status);
      }
      const got429 = statuses.includes(429);
      const allAuthOrLimit = statuses.every((s) => s === 401 || s === 429);
      const ok = got429 && allAuthOrLimit;
      record("T4 burst of 8 anonymous POSTs trips costlyLimiter (>=1 x 429)",
        ok, `statuses=${statuses.join(",")}`);
    }

    // ===== T5: source check — /onboard handler is auth+limiter+ub-insert =====
    {
      const src = await readRepoFile("artifacts/api-server/src/routes/api.ts");
      const hasMiddleware = /router\.post\(\s*["']\/onboard["']\s*,\s*costlyLimiter\s*,\s*requireAuth/.test(src);
      const hasUbInsert = /\.from\(\s*["']user_businesses["']\s*\)\s*\.insert\(\s*\{[^}]*business_id:\s*businessId/s.test(src);
      const hasImport = /import\s*\{[^}]*costlyLimiter[^}]*\}\s*from\s*["']\.\.\/rateLimiter["']/.test(src);
      const ok = hasMiddleware && hasUbInsert && hasImport;
      record("T5 api.ts /onboard handler: costlyLimiter+requireAuth+ub-insert wired",
        ok, `middleware=${hasMiddleware} ub-insert=${hasUbInsert} import=${hasImport}`);
    }

    // ===== T6: source check — Sidebar.tsx is clean =====
    {
      const src = await readRepoFile("artifacts/voiceiq-dashboard/src/components/Sidebar.tsx");
      const noWizardImport = !/from\s+["']\.\/OnboardingWizard["']/.test(src);
      const noRocketIcon = !/\bRocket\b/.test(src);
      const noPlusIcon = !/\bPlus\b/.test(src);
      const noShowWizard = !/\bshowWizard\b/.test(src);
      const noSetupComplete = !/\bsetupComplete\b/.test(src);
      const ok = noWizardImport && noRocketIcon && noPlusIcon && noShowWizard && noSetupComplete;
      record("T6 Sidebar.tsx: OnboardingWizard import + Rocket/Plus + state removed",
        ok, `wizardImport=${!noWizardImport} Rocket=${!noRocketIcon} Plus=${!noPlusIcon} showWizard=${!noShowWizard} setupComplete=${!noSetupComplete}`);
    }

    // ===== T7: source check — Analytics.tsx CTA gone =====
    {
      const src = await readRepoFile("artifacts/voiceiq-dashboard/src/pages/Analytics.tsx");
      const noSetupGuide = !/View Setup Guide/.test(src);
      const noOnboardingNav = !/navigate\(\s*["']\/onboarding["']\s*\)/.test(src);
      const noArrowRightImport = !/^\s*ArrowRight\s*,\s*$/m.test(src);
      const ok = noSetupGuide && noOnboardingNav && noArrowRightImport;
      record("T7 Analytics.tsx: View Setup Guide button + /onboarding nav removed",
        ok, `setupGuideText=${!noSetupGuide} onboardingNav=${!noOnboardingNav} arrowRight=${!noArrowRightImport}`);
    }

    // ===== T8: source check — App.tsx /onboarding route gone =====
    {
      const src = await readRepoFile("artifacts/voiceiq-dashboard/src/App.tsx");
      const noOnboardingImport = !/import\s+Onboarding\s+from\s+["']\.\/pages\/Onboarding["']/.test(src);
      const noOnboardingRoute = !/<Route\s+path=["']\/onboarding["']/.test(src);
      const ok = noOnboardingImport && noOnboardingRoute;
      record("T8 App.tsx: Onboarding import + <Route path=\"/onboarding\"> removed",
        ok, `import=${!noOnboardingImport} route=${!noOnboardingRoute}`);
    }
  } finally {
    // ===== Teardown — delete the disposable auth user =====
    if (createdUserId) {
      const { error } = await sb.auth.admin.deleteUser(createdUserId);
      if (error) console.warn(`[3f-verify] teardown deleteUser warn: ${error.message}`);
      else console.log(`[3f-verify] cleaned up user ${createdUserId.substring(0, 8)}`);
    }

    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log(`\n=========== 3f-verify summary ===========`);
    console.log(`PASS: ${passed} / ${results.length}`);
    if (failed > 0) {
      console.log(`FAIL: ${failed}`);
      for (const r of results) if (!r.pass) console.log(`  - ${r.name}: ${r.details}`);
      process.exit(1);
    }
    console.log(`All BUG-17 sub-step 3f checks passed.`);
  }
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
