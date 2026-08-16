/**
 * Phase 6.8 — webhook bypass audit smoke.
 *
 * Every Twilio-facing or ElevenLabs-tool endpoint MUST have an entry
 * in AUTH_BYPASS_PATTERNS or gatewayAuth returns 401 BEFORE the
 * handler's internal signature/token check runs. That failure mode
 * has bitten us twice (Phase 6.4 shipped two callbacks without
 * entries, six lost voicemails 2026-08-15 15:07-15:40 EDT).
 *
 * The startup assertion in app.ts is the primary safety net — it
 * runs on every boot and throws if a webhook route lacks a bypass
 * entry. This smoke is the fast CI-parity check that uses the same
 * helper against the same imported apiRouter, so a developer can
 * catch the miss BEFORE pushing without waiting for a deploy.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx ./src/tests/098-webhook-bypass-audit-smoke.ts
 */

// Set env dummies BEFORE any import that could pull in boot-time
// env-checking modules (workos, elevenlabs, anthropic). ES module
// import hoisting means top-level `import` runs before module body,
// so imports that require env vars must be dynamic — invoked from
// main() after the env dummies are set here.
process.env.WORKOS_API_KEY = process.env.WORKOS_API_KEY || "smoke-dummy";
process.env.WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || "smoke-dummy";
process.env.WORKOS_STATE_SECRET = process.env.WORKOS_STATE_SECRET || "smoke-dummy-32-bytes-aaaaaaaaaaaaaaaaa";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "smoke-dummy";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "smoke-dummy";

import {
  enumerateRoutePaths,
  findMissingBypassEntries,
  isWebhookShapedPath,
  WEBHOOK_EXACT_PATHS,
  WEBHOOK_PATH_PREFIXES,
} from "../lib/webhook-audit";
import { AUTH_BYPASS_PATTERNS } from "../lib/auth-bypass-patterns";

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${details}`);
}

// ── W1 the classifier itself ──────────────────────────────────────────

function testClassifier() {
  const shouldMatch = [
    "/api/twilio/voice",
    "/api/twilio/sms-status",
    "/api/routing/dial-status",
    "/api/routing/dial-fallback-record-done",
    "/api/routing/dial-fallback-transcript",
    "/api/webhook/elevenlabs",
    "/api/voice/outbound",
    "/api/voice/outbound-status",
  ];
  const shouldNotMatch = [
    "/api/voice/token",
    "/api/voice/heartbeat",
    "/api/voice/reachability",
    "/api/business/leads",
    "/api/webhooks", // plural — tenant-managed webhooks admin surface
    "/api/webhooks/config",
    "/api/webhooks/:id",
    "/api/leads/capture", // ElevenLabs tool but not under a webhook prefix — handled by explicit bypass entry
  ];
  const misclassified: string[] = [];
  for (const p of shouldMatch) if (!isWebhookShapedPath(p)) misclassified.push(`missed: ${p}`);
  for (const p of shouldNotMatch) if (isWebhookShapedPath(p)) misclassified.push(`false+: ${p}`);
  record(
    "W1 classifier matches only webhook-shape paths",
    misclassified.length === 0,
    misclassified.join("; ") ||
      `${shouldMatch.length} matched, ${shouldNotMatch.length} correctly skipped`,
  );
}

// ── W2 the auditor with a synthetic missing entry ─────────────────────

function testAuditorDetectsMissing() {
  const paths = [
    "/api/twilio/voice",
    "/api/routing/dial-status",
    "/api/routing/dial-fantasy-endpoint", // no bypass entry
  ];
  const patterns = [
    /^\/api\/twilio\//,
    /^\/api\/routing\/dial-status$/,
  ];
  const missing = findMissingBypassEntries(paths, patterns);
  record(
    "W2 auditor flags webhook-shape path with no bypass match",
    missing.length === 1 && missing[0] === "/api/routing/dial-fantasy-endpoint",
    `missing=${JSON.stringify(missing)}`,
  );
}

// ── W3 the auditor with a synthetic all-covered set ───────────────────

function testAuditorHappyPath() {
  const paths = [
    "/api/twilio/voice",
    "/api/routing/dial-status",
    "/api/routing/dial-fallback-record-done",
    "/api/routing/dial-fallback-transcript",
    "/api/voice/outbound",
  ];
  const patterns = [
    /^\/api\/twilio\//,
    /^\/api\/routing\/dial-status$/,
    /^\/api\/routing\/dial-fallback-record-done$/,
    /^\/api\/routing\/dial-fallback-transcript$/,
    /^\/api\/voice\/outbound$/,
  ];
  const missing = findMissingBypassEntries(paths, patterns);
  record(
    "W3 auditor returns empty when everything is covered",
    missing.length === 0,
    missing.length === 0 ? "no missing" : `unexpected missing=${JSON.stringify(missing)}`,
  );
}

// ── W4 the enumerator finds routes on the real apiRouter ──────────────

let cachedApiRouter: { stack?: unknown[] } | null = null;
async function loadApiRouter(): Promise<{ stack?: unknown[] }> {
  if (cachedApiRouter) return cachedApiRouter;
  // Dynamic import so the env dummies at the top of this file are set
  // BEFORE the module chain (routes → auth → workos, etc) evaluates.
  const mod = await import("../routes");
  cachedApiRouter = mod.default as unknown as { stack?: unknown[] };
  return cachedApiRouter;
}

async function testEnumeratorAgainstApiRouter() {
  const apiRouter = await loadApiRouter();
  const paths = enumerateRoutePaths(apiRouter, "/api");
  // Sanity: we expect at least a handful of webhook-shape routes to
  // show up. Zero would signal the enumerator is broken.
  const webhookPaths = paths.filter(isWebhookShapedPath);
  record(
    "W4 enumerator finds webhook-shape routes on real apiRouter",
    webhookPaths.length >= 5,
    `total=${paths.length}, webhook-shape=${webhookPaths.length}`,
  );
}

// ── W5 THE MAIN CHECK — every real webhook route is bypass-listed ─────

async function testRealAppHasNoMissingBypass() {
  const apiRouter = await loadApiRouter();
  const paths = enumerateRoutePaths(apiRouter, "/api");
  const missing = findMissingBypassEntries(paths, AUTH_BYPASS_PATTERNS);
  record(
    "W5 every webhook-shape route on the real apiRouter has a bypass entry",
    missing.length === 0,
    missing.length === 0
      ? "clean — no missing bypass entries"
      : `MISSING: ${JSON.stringify(missing)}`,
  );
}

// ── W6 config sanity: the constants are what the doc says ─────────────

function testConfigConstants() {
  const failures: string[] = [];
  if (!WEBHOOK_PATH_PREFIXES.includes("/api/twilio/")) failures.push("prefixes missing /api/twilio/");
  if (!WEBHOOK_PATH_PREFIXES.includes("/api/routing/")) failures.push("prefixes missing /api/routing/");
  if (!WEBHOOK_PATH_PREFIXES.includes("/api/webhook/")) failures.push("prefixes missing /api/webhook/");
  if (!WEBHOOK_EXACT_PATHS.has("/api/voice/outbound")) failures.push("exact missing /api/voice/outbound");
  if (!WEBHOOK_EXACT_PATHS.has("/api/voice/outbound-status")) failures.push("exact missing /api/voice/outbound-status");
  record(
    "W6 WEBHOOK_PATH_PREFIXES + WEBHOOK_EXACT_PATHS carry the documented values",
    failures.length === 0,
    failures.join("; ") || `${WEBHOOK_PATH_PREFIXES.length} prefixes, ${WEBHOOK_EXACT_PATHS.size} exact paths`,
  );
}

// ── Runner ────────────────────────────────────────────────────────────

async function main() {
  testClassifier();
  testAuditorDetectsMissing();
  testAuditorHappyPath();
  await testEnumeratorAgainstApiRouter();
  await testRealAppHasNoMissingBypass();
  testConfigConstants();

  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(`Total: ${results.length}  Pass: ${results.length - failed.length}  Fail: ${failed.length}`);
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[audit-smoke] unexpected:", err?.message || err);
  process.exit(1);
});
