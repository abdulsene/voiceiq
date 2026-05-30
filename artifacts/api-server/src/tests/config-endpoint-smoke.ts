/**
 * /api/config endpoint smoke test — 2026-05-03 Calendly env-var swap.
 *
 * Hits the running api-server (default http://localhost:8080, override
 * with API_BASE_URL env var) and asserts:
 *   1. Status 200 + JSON shape { discovery_call_url: string, version: string }
 *   2. discovery_call_url is non-empty
 *   3. Cache-Control header is "public, max-age=60"
 *   4. Auth bypass works (no x-api-key / Authorization header sent)
 *   5. Cache layer behaves: two back-to-back calls return identical bodies
 *
 * This is a network test, not pure-data — kept separate from
 * alex-kb-smoke.ts so it can be skipped if the api-server isn't up.
 */

const API_BASE = process.env["API_BASE_URL"] || "http://localhost:8080";

let pass = 0;
let fail = 0;

function assert(cond: unknown, label: string, info = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}${info ? ` (${info})` : ""}`);
  }
}

console.log(`\n=== /api/config endpoint smoke (target: ${API_BASE}) ===\n`);

const url = `${API_BASE}/api/config`;
let res: Response;
try {
  res = await fetch(url);
} catch (e) {
  console.error(`Could not reach ${url}: ${(e as Error).message}`);
  console.error("Is the api-server workflow running?");
  process.exit(2);
}

assert(res.status === 200, "C1 status 200", `got ${res.status}`);

const cacheControl = res.headers.get("cache-control");
assert(cacheControl === "public, max-age=60",
  "C2 Cache-Control: public, max-age=60",
  `got ${cacheControl}`);

const contentType = res.headers.get("content-type") || "";
assert(contentType.includes("application/json"),
  "C3 Content-Type: application/json",
  `got ${contentType}`);

const body = (await res.json()) as { discovery_call_url?: unknown; version?: unknown };
assert(typeof body.discovery_call_url === "string",
  "C4 discovery_call_url is a string");
assert(typeof body.version === "string",
  "C5 version is a string");
assert((body.discovery_call_url as string).length > 0,
  "C6 discovery_call_url is non-empty");

// Optional deterministic check: when EXPECTED_DISCOVERY_URL is set
// (e.g. CI run with NEVERR_CALENDLY_URL exported to a known value),
// assert the endpoint surfaces exactly that URL. Skipped silently
// otherwise so the test still passes in dev where ops haven't pinned
// the URL yet.
const expected = process.env["EXPECTED_DISCOVERY_URL"];
if (expected) {
  assert(body.discovery_call_url === expected,
    `C6b discovery_call_url === EXPECTED_DISCOVERY_URL`,
    `expected=${expected} got=${body.discovery_call_url}`);
}

// Cache invariance: two back-to-back calls within the 60s TTL must
// return the same payload string. (We can't directly observe the cache
// hit/miss without instrumenting it, but identical payloads + the
// resolver being deterministic per env state is sufficient evidence.)
const res2 = await fetch(url);
const body2 = await res2.text();
const body1Text = JSON.stringify(body);
assert(body2 === body1Text,
  "C7 cache invariance: back-to-back calls return identical payloads",
  `got\n  call1=${body1Text}\n  call2=${body2}`);

// Auth-bypass: this whole test sent no Authorization header and got
// 200 — that's the auth-bypass assertion (encoded in C1's pass).

console.log(`\n=== RESULTS ===\nPass: ${pass}\nFail: ${fail}`);
if (fail > 0) {
  console.error("\n/api/config smoke FAILED");
  process.exit(1);
}
console.log("\nAll /api/config smoke tests passed.");
