/**
 * /auth/help-recover-account smoke harness.
 *
 *   T1 — valid submission returns 204. Does NOT assert Resend delivery
 *        (would require a Resend-mock or test API key); the handler logs
 *        a skip when RESEND_API_KEY isn't set, so the 204 is what we
 *        care about.
 *   T2 — missing required field (business_name) returns 400 with the
 *        zod validation shape.
 *   T3 — missing contact_email returns 400.
 *   T4 — malformed business_phone (letters mixed in) returns 400.
 *   T5 — details overflow (>500 chars) returns 400.
 *   T6 — rate limit fires after the 11th request from the same IP.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/012-help-recover-account-smoke.ts
 *
 * Requires (env): api-server running locally (TEST_API_BASE, default
 * http://localhost:8080). No Supabase fixture needed — anti-enumeration
 * means the wire shape doesn't depend on a real business_configs match.
 */
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

async function post(body: any): Promise<{ http: number; text: string }> {
  const r = await fetch(`${API}/api/auth/help-recover-account`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { http: r.status, text: await r.text() };
}

function uniqueBody(overrides: Partial<Record<string, any>> = {}) {
  const suffix = crypto.randomBytes(3).toString("hex");
  return {
    business_name: `Test Business ${suffix}`,
    business_phone: "(555) 123-4567",
    contact_email: `recover-${suffix}@neverr.test`,
    details: `Submitted by smoke harness ${suffix}`,
    ...overrides,
  };
}

async function main() {
  // T1
  try {
    const r = await post(uniqueBody());
    if (r.http === 204) record("T1 valid submission → 204", true, "http=204");
    else record("T1 valid submission → 204", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
  } catch (err: any) {
    record("T1 valid submission → 204", false, `threw: ${err.message}`);
  }

  // T2
  try {
    const r = await post(uniqueBody({ business_name: "" }));
    if (r.http === 400) record("T2 missing business_name → 400", true, "http=400");
    else record("T2 missing business_name → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
  } catch (err: any) {
    record("T2 missing business_name → 400", false, `threw: ${err.message}`);
  }

  // T3
  try {
    const r = await post(uniqueBody({ contact_email: "" }));
    if (r.http === 400) record("T3 missing contact_email → 400", true, "http=400");
    else record("T3 missing contact_email → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
  } catch (err: any) {
    record("T3 missing contact_email → 400", false, `threw: ${err.message}`);
  }

  // T4
  try {
    const r = await post(uniqueBody({ business_phone: "letters-not-allowed-abc" }));
    if (r.http === 400) record("T4 malformed business_phone → 400", true, "http=400");
    else record("T4 malformed business_phone → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
  } catch (err: any) {
    record("T4 malformed business_phone → 400", false, `threw: ${err.message}`);
  }

  // T5
  try {
    const longDetails = "x".repeat(501);
    const r = await post(uniqueBody({ details: longDetails }));
    if (r.http === 400) record("T5 details > 500 chars → 400", true, "http=400");
    else record("T5 details > 500 chars → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
  } catch (err: any) {
    record("T5 details > 500 chars → 400", false, `threw: ${err.message}`);
  }

  // T6 — fire 12 valid requests from the same IP and expect the 11th or
  // 12th to come back 429. The authLimiter is 10 per 15 min per IP and
  // ALL the prior tests (T1-T5) also hit this same limiter from the same
  // IP, so we may already be over by now — accept either "429 within 12
  // more attempts" or "already throttled when test runs."
  try {
    let saw429 = false;
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await post(uniqueBody());
      lastStatus = r.http;
      if (r.http === 429) { saw429 = true; break; }
    }
    if (saw429) record("T6 rate limit fires → 429", true, "saw 429 within 12 attempts");
    else record("T6 rate limit fires → 429", false, `never saw 429; last status=${lastStatus}`);
  } catch (err: any) {
    record("T6 rate limit fires → 429", false, `threw: ${err.message}`);
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
