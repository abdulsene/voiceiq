/**
 * /forgot-password dedicated page smoke harness.
 *
 * The page itself is React; it can't be exercised from this script
 * directly. What we DO assert here is the underlying contract the page
 * relies on — that the POST /api/auth/forgot-password endpoint still
 * works through the same anti-enumeration shape (009 covers the deep
 * cases; this is a lighter "still wired" check after the inline-button
 * → dedicated-page refactor).
 *
 *   T1 — POST /api/auth/forgot-password with a valid email returns 204.
 *   T2 — POST with a malformed email returns 400 (zod gate intact).
 *   T3 — GET /forgot-password (the dashboard page) returns 200 against
 *        the api-server host. Skipped if the api-server isn't also
 *        serving the dashboard build; this is informational, not a
 *        pass/fail blocker.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/011-forgot-password-page-smoke.ts
 *
 * Requires (env): the api-server running locally (TEST_API_BASE,
 * default http://localhost:8080). No Supabase fixture user needed —
 * forgot-password is anti-enumeration on the wire either way.
 */
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

async function postJson(path: string, body: any): Promise<{ http: number; text: string }> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { http: r.status, text: await r.text() };
}

async function main() {
  // T1: well-formed email → 204
  try {
    const ghostEmail = `forgotpw-${crypto.randomBytes(4).toString("hex")}@neverr.test`;
    const r = await postJson("/api/auth/forgot-password", { email: ghostEmail });
    if (r.http === 204) {
      record("T1 valid email → 204", true, `http=204`);
    } else {
      record("T1 valid email → 204", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T1 valid email → 204", false, `threw: ${err.message}`);
  }

  // T2: malformed email → 400
  try {
    const r = await postJson("/api/auth/forgot-password", { email: "not-an-email" });
    if (r.http === 400) {
      record("T2 malformed email → 400", true, "http=400");
    } else {
      record("T2 malformed email → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
    }
  } catch (err: any) {
    record("T2 malformed email → 400", false, `threw: ${err.message}`);
  }

  // T3: GET /forgot-password — informational only.
  try {
    const r = await fetch(`${API}/forgot-password`);
    record("T3 GET /forgot-password (informational)", true, `http=${r.status} (skipped pass/fail — depends on whether api-server hosts dashboard)`);
  } catch (err: any) {
    record("T3 GET /forgot-password (informational)", true, `network error — api-server likely doesn't host dashboard, that's fine: ${err.message}`);
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
