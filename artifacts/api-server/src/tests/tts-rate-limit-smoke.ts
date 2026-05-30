/**
 * /api/chat/tts per-visitor rate limit smoke (2026-05-03).
 *
 * Hits the running api-server (default http://localhost:8080, override
 * with API_BASE_URL) and asserts:
 *   1. First N requests with a fixed visitor cookie all get a non-429
 *      response (status varies — could be 200/502/503 depending on
 *      ElevenLabs availability, but NOT 429).
 *   2. Request N+1 with the same cookie returns HTTP 429.
 *   3. The 429 response includes a Retry-After header.
 *   4. The 429 response body has { error: "rate_limited", message: ... }.
 *   5. The 429 response includes RateLimit-* standard headers.
 *   6. A DIFFERENT visitor cookie is NOT rate-limited (proves the
 *      keyGenerator is per-visitor, not global).
 *   7. /api/livez and /api/healthz return the expected JSON shape.
 *
 * Notes:
 *   - We test with NEVERR_TTS_RATE_LIMIT_PER_WINDOW=3 set in the
 *     api-server env to keep the test fast (≤4 requests instead of 31).
 *     If that env isn't applied (i.e. defaults are still 30/5min), the
 *     test detects this and falls back to the spec'd 31-request flow.
 *   - We send tiny text bodies. If ElevenLabs is configured the
 *     synthesis will succeed (200); if not, we'll see 502/503 — both
 *     count as "not 429" for purposes of the limit check.
 */

export {};

const API_BASE = process.env["API_BASE_URL"] || "http://localhost:8080";
const TEST_VISITOR_A = "11111111-1111-4111-8111-111111111111";
const TEST_VISITOR_B = "22222222-2222-4222-8222-222222222222";

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

function section(title: string): void {
  console.log(`\n${title}`);
}

async function ttsCall(visitorCookie: string): Promise<Response> {
  return fetch(`${API_BASE}/api/chat/tts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `neverr_visitor_id=${visitorCookie}`,
    },
    body: JSON.stringify({ text: "x" }),
  });
}

console.log(`\n=== /api/chat/tts rate-limit smoke (target: ${API_BASE}) ===`);

// Discover the configured limit by hammering visitor A until we see 429
// (capped at 35 so we never run forever if the limiter is misconfigured).
section("R1. Discover limit + assert N+1th request is 429:");
let firstLimitedAt = -1;
const responses: Response[] = [];
for (let i = 1; i <= 35; i++) {
  const res = await ttsCall(TEST_VISITOR_A);
  responses.push(res);
  if (res.status === 429) {
    firstLimitedAt = i;
    break;
  }
  // Drain body so we don't leak sockets (especially with audio streams).
  try {
    await res.arrayBuffer();
  } catch {
    /* ignore */
  }
}

assert(
  firstLimitedAt > 0,
  `R1.1 limiter eventually returns 429 (within 35 requests)`,
  `firstLimitedAt=${firstLimitedAt}`,
);
assert(
  firstLimitedAt > 1,
  `R1.2 at least one request succeeded before the limit fired`,
  `firstLimitedAt=${firstLimitedAt}`,
);

const limited = responses[firstLimitedAt - 1];
const retryAfter = limited?.headers.get("retry-after");
assert(
  !!retryAfter,
  "R1.3 429 response includes Retry-After header",
  `retry-after=${retryAfter}`,
);
const ratelimitLimit = limited?.headers.get("ratelimit-limit");
assert(
  !!ratelimitLimit,
  "R1.4 429 response includes RateLimit-Limit header (standardHeaders: true)",
  `ratelimit-limit=${ratelimitLimit}`,
);

const limitedBody = (await limited?.json()) as
  | { error?: unknown; message?: unknown }
  | undefined;
assert(
  limitedBody?.error === "rate_limited",
  `R1.5 429 body { error: "rate_limited" }`,
  `got ${JSON.stringify(limitedBody)}`,
);
assert(
  typeof limitedBody?.message === "string" &&
    (limitedBody.message as string).length > 0,
  `R1.6 429 body has user-facing message`,
);

// Visitor B is a different identity — the keyGenerator must NOT have
// blocked it just because visitor A blew past the limit.
section("R2. Per-visitor isolation:");
const resB = await ttsCall(TEST_VISITOR_B);
assert(
  resB.status !== 429,
  "R2.1 different visitor cookie not rate-limited by visitor A's overrun",
  `status=${resB.status}`,
);
try {
  await resB.arrayBuffer();
} catch {
  /* ignore */
}

// Health endpoints
section("H. Health endpoints:");
const livez = await fetch(`${API_BASE}/api/livez`);
assert(livez.status === 200, "H1 /api/livez returns 200", `got ${livez.status}`);
assert(
  livez.headers.get("cache-control") === "no-store",
  "H2 /api/livez Cache-Control: no-store",
  `got ${livez.headers.get("cache-control")}`,
);
const livezBody = (await livez.json()) as {
  status?: unknown;
  uptime_secs?: unknown;
};
assert(livezBody.status === "ok", "H3 /api/livez body status=ok");
assert(
  typeof livezBody.uptime_secs === "number" &&
    (livezBody.uptime_secs as number) >= 0,
  "H4 /api/livez body uptime_secs is a non-negative number",
);

const healthz = await fetch(`${API_BASE}/api/healthz`);
assert(
  healthz.status === 200 || healthz.status === 503,
  "H5 /api/healthz returns 200 or 503 (200 if all deps ok)",
  `got ${healthz.status}`,
);
assert(
  healthz.headers.get("cache-control") === "no-store",
  "H6 /api/healthz Cache-Control: no-store",
);
const healthzBody = (await healthz.json()) as {
  status?: unknown;
  version?: unknown;
  uptime_secs?: unknown;
  services?: Record<string, unknown>;
};
assert(
  healthzBody.status === "ok" ||
    healthzBody.status === "degraded" ||
    healthzBody.status === "down",
  "H7 /api/healthz status is ok|degraded|down",
  `got ${String(healthzBody.status)}`,
);
assert(
  typeof healthzBody.version === "string",
  "H8 /api/healthz body has version string",
);
assert(
  typeof healthzBody.uptime_secs === "number",
  "H9 /api/healthz body has uptime_secs number",
);
assert(
  healthzBody.services !== undefined &&
    "database" in healthzBody.services &&
    "supabase" in healthzBody.services &&
    "anthropic" in healthzBody.services &&
    "elevenlabs" in healthzBody.services,
  "H10 /api/healthz services map has all four keys (database, supabase, anthropic, elevenlabs)",
  `got ${JSON.stringify(healthzBody.services)}`,
);

console.log(`\n=== RESULTS ===\nPass: ${pass}\nFail: ${fail}`);
if (fail > 0) {
  console.error("\nTTS rate-limit / health smoke FAILED");
  process.exit(1);
}
console.log("\nAll TTS rate-limit + health smoke tests passed.");
