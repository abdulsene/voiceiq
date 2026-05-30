/**
 * Sprint 5 — Phase 5 WorkOS SSO end-to-end smoke against the LIVE Auth0
 * connection (conn_01KQJAV4AMQQMW809WYQQK6TN2, "Neverr AI", state=ACTIVE).
 *
 * Pivoted from the Test Organization plan after the real Auth0 connection
 * went active in WorkOS. Exercises the full Phase 1→4 wiring end-to-end
 * up to the point where a browser round-trip is required:
 *
 *   1a. GET /api/sso/lookup?email=test-sso-phase5@gtacfinance.com
 *       → 200 + { connectionId: "conn_01KQJAV4AMQQMW809WYQQK6TN2" }
 *       (proves Phase 4 domain-lookup wiring against migration-014's
 *        sso_email_domains column)
 *
 *   1b. GET /api/sso/init?connectionId=<id>&as=json
 *       → 200 + { url, connectionId }
 *       (proves Phase 3 init endpoint accepts the live connection ID)
 *
 *   1c. Parse the `state` param from the returned auth URL → roundtrip
 *       through verifySsoState() → confirm HMAC signing decodes cleanly,
 *       returns the same connection ID, and reports a sensible age.
 *
 *   1d. Fetch the auth URL with redirect:manual → assert WorkOS does NOT
 *       302 us to error.workos.com/* (the universal "I can't resolve
 *       this" page; would mean the connection or client_id is broken).
 *       Successful path: 302 to a SAML SSO endpoint, typically Auth0's
 *       /samlp/<id> URL, OR a 200 HTML page rendered by WorkOS that
 *       fans out to the IdP.
 *
 * What this DOESN'T cover:
 *   - The actual SAML round-trip through Auth0 (browser-only — needs
 *     Abdul to click through, see "Manual browser walkthrough" at end).
 *   - JIT user provisioning (provisionSsoSession) — already covered by
 *     earlier Sprint 5 smokes against the same code path.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/sprint5-workos-phase5-real-auth0-smoke.ts
 *
 * Idempotent: makes no DB writes. The lookup endpoint emits one
 * sso.lookup.miss audit row only if the wired-up row has gone away,
 * which the smoke catches and surfaces — no cleanup required.
 */
import { verifySsoState } from "../routes/sso";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const TEST_BIZ_ID = "demo-business"; // see header — Settings UI saved here
const EXPECTED_CONN_ID = "conn_01KQJAV4AMQQMW809WYQQK6TN2";
const TEST_EMAIL = "test-sso-phase5@gtacfinance.com";
const ERROR_HOST = "error.workos.com";

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
  path: string,
): Promise<{ http: number; body: any; rawText: string }> {
  const r = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const txt = await r.text();
  let body: any = {};
  try {
    body = txt ? JSON.parse(txt) : {};
  } catch {
    body = { __raw: txt };
  }
  return { http: r.status, body, rawText: txt };
}

async function main(): Promise<void> {
  console.log(`\n=== Phase 5 real-Auth0 SSO smoke ===`);
  console.log(`API base:        ${API}`);
  console.log(`Test business:   ${TEST_BIZ_ID}`);
  console.log(`Expected conn:   ${EXPECTED_CONN_ID}`);
  console.log(`Test email:      ${TEST_EMAIL}\n`);

  // ──────────────────────────────────────────────────────────────────────
  // 1a. Lookup by email domain → Phase 4 wiring
  // ──────────────────────────────────────────────────────────────────────
  let lookedUpConnId: string | null = null;
  {
    const { http, body } = await getJson(
      `/api/sso/lookup?email=${encodeURIComponent(TEST_EMAIL)}`,
    );
    if (http === 200 && body?.connectionId === EXPECTED_CONN_ID) {
      lookedUpConnId = body.connectionId;
      rec(
        "1a lookup-by-domain returns expected connection",
        "PASS",
        http,
        `connectionId=${lookedUpConnId}`,
      );
    } else if (http === 200 && body?.connectionId) {
      rec(
        "1a lookup-by-domain returns expected connection",
        "FAIL",
        http,
        `got ${body.connectionId}, expected ${EXPECTED_CONN_ID} — wrong row wired up`,
      );
    } else if (http === 404) {
      rec(
        "1a lookup-by-domain returns expected connection",
        "FAIL",
        http,
        `404 — gtacfinance.com not in any business_configs.sso_email_domains, or matching row has sso_connection_id=NULL. Re-save in Settings UI on the right business.`,
      );
    } else {
      rec(
        "1a lookup-by-domain returns expected connection",
        "FAIL",
        http,
        `unexpected response: ${JSON.stringify(body).slice(0, 200)}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1b. Init endpoint builds the auth URL
  // ──────────────────────────────────────────────────────────────────────
  let authUrl: string | null = null;
  {
    const { http, body } = await getJson(
      `/api/sso/init?connectionId=${EXPECTED_CONN_ID}&as=json`,
    );
    if (
      http === 200 &&
      typeof body?.url === "string" &&
      body.url.startsWith("https://api.workos.com/sso/authorize") &&
      body.connectionId === EXPECTED_CONN_ID
    ) {
      authUrl = body.url;
      rec(
        "1b init builds WorkOS authorize URL",
        "PASS",
        http,
        `url length=${authUrl.length}, contains state param=${authUrl.includes("state=")}`,
      );
    } else {
      rec(
        "1b init builds WorkOS authorize URL",
        "FAIL",
        http,
        `body=${JSON.stringify(body).slice(0, 300)}`,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1c. State token roundtrip through HMAC verification
  // ──────────────────────────────────────────────────────────────────────
  if (authUrl) {
    const u = new URL(authUrl);
    const state = u.searchParams.get("state") || "";
    const verified = state ? verifySsoState(state) : null;
    if (
      verified &&
      verified.connectionId === EXPECTED_CONN_ID &&
      typeof verified.ageMs === "number" &&
      verified.ageMs >= 0 &&
      verified.ageMs < 60_000 // freshly minted in the last second
    ) {
      rec(
        "1c state token signs+verifies + binds to expected connection",
        "PASS",
        undefined,
        `connId=${verified.connectionId}, ageMs=${verified.ageMs}`,
      );
    } else {
      rec(
        "1c state token signs+verifies + binds to expected connection",
        "FAIL",
        undefined,
        verified
          ? `state decoded but mismatch: got connId=${verified.connectionId}, ageMs=${verified.ageMs}`
          : `state did not verify (HMAC mismatch or expired) — state.length=${state.length}`,
      );
    }

    // Sanity: tampered state must NOT verify (CSRF protection sanity).
    if (state.length > 10) {
      const flippedChar = state[5] === "a" ? "b" : "a";
      const tampered = state.slice(0, 5) + flippedChar + state.slice(6);
      const tamperedResult = verifySsoState(tampered);
      if (tamperedResult === null) {
        rec(
          "1c-bonus tampered state correctly rejected",
          "PASS",
          undefined,
          "verifySsoState() returned null on bit-flip",
        );
      } else {
        rec(
          "1c-bonus tampered state correctly rejected",
          "FAIL",
          undefined,
          `tampered state verified! HMAC check broken. result=${JSON.stringify(tamperedResult)}`,
        );
      }
    }
  } else {
    rec(
      "1c state token signs+verifies + binds to expected connection",
      "FAIL",
      undefined,
      "skipped — 1b did not produce an auth URL",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // 1d. WorkOS accepts the auth URL — does NOT 302 to error.workos.com
  // ──────────────────────────────────────────────────────────────────────
  if (authUrl) {
    try {
      const r = await fetch(authUrl, { redirect: "manual" });
      const loc = r.headers.get("location") || "";
      const isError = loc.includes(ERROR_HOST);
      const isAuth0 = /auth0\.com|samlp/.test(loc);
      const is302 = r.status === 302 || r.status === 303;

      if (is302 && !isError) {
        rec(
          "1d WorkOS accepts connection (no error redirect)",
          "PASS",
          r.status,
          `location=${loc.slice(0, 160)}${isAuth0 ? " [auth0/samlp]" : ""}`,
        );
      } else if (is302 && isError) {
        rec(
          "1d WorkOS accepts connection (no error redirect)",
          "FAIL",
          r.status,
          `WorkOS redirected to ${ERROR_HOST}: ${loc} — connection is broken or not active.`,
        );
      } else if (r.status === 200) {
        // WorkOS sometimes renders an HTML interstitial instead of 302ing.
        // Treat as PASS provided body doesn't contain the error sentinel.
        const body = await r.text();
        if (body.includes(ERROR_HOST) || /client.id.invalid/i.test(body)) {
          rec(
            "1d WorkOS accepts connection (no error redirect)",
            "FAIL",
            r.status,
            `200 HTML body contains error sentinel`,
          );
        } else {
          rec(
            "1d WorkOS accepts connection (no error redirect)",
            "PASS",
            r.status,
            `200 HTML interstitial (length=${body.length}) — likely WorkOS auth-screen`,
          );
        }
      } else {
        rec(
          "1d WorkOS accepts connection (no error redirect)",
          "FAIL",
          r.status,
          `unexpected status. location=${loc.slice(0, 200)}`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      rec(
        "1d WorkOS accepts connection (no error redirect)",
        "FAIL",
        undefined,
        `fetch threw: ${msg}`,
      );
    }
  } else {
    rec(
      "1d WorkOS accepts connection (no error redirect)",
      "FAIL",
      undefined,
      "skipped — 1b did not produce an auth URL",
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Summary + verdict
  // ──────────────────────────────────────────────────────────────────────
  const fails = steps.filter((s) => s.status === "FAIL");
  console.log(`\n=== Summary ===`);
  console.log(`Total: ${steps.length}  Pass: ${steps.length - fails.length}  Fail: ${fails.length}`);
  for (const f of fails) console.log(`  FAIL: ${f.step} — ${f.details}`);

  if (authUrl) {
    console.log(`\n=== Manual browser walkthrough (optional) ===`);
    console.log(`Open this URL in a browser:`);
    console.log(`  ${API}/api/sso/init?connectionId=${EXPECTED_CONN_ID}`);
    console.log(`Or follow the auth URL directly:`);
    console.log(`  ${authUrl}`);
    console.log(`Expected: redirected to Auth0 login → enter test user @gtacfinance.com`);
    console.log(`         → bounced through /api/sso/callback → land on /dashboard.`);
  }

  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("UNCAUGHT", err);
  process.exit(2);
});
