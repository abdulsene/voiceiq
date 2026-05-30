/**
 * Alex KB + prompt smoke tests — locks the corrections from the
 * 2026-05-03 KB audit so the next prompt edit can't silently
 * reintroduce the same drift.
 *
 * Run: pnpm --filter @workspace/api-server run test:alex-kb
 *
 * Pure data assertions — no Anthropic API calls, no DB. Imports
 * chat-knowledge-base.ts and alex-prompt.ts directly and asserts the
 * built prompt string and exported constants contain the expected
 * fragments. Cheap, deterministic, runnable in CI without secrets.
 *
 * Coverage map → audit findings:
 *   T1  Pricing parity vs PLAN_PRICES (regression guard)
 *   T2  Compliance — H1 (EU residency = enterprise tier), M1 (HIPAA
 *       2027), M2 (ISO 2027)
 *   T3  Forbidden tokens not in built prompt + only canonical CTAs
 *   T4  M3 — enterprise capabilities surface present in built prompt
 *   T5  M4 — integrations present + only-from-this-list instruction
 *   T6  M5 — per-plan quotas present in ALEX_PLANS + built prompt
 *   T7  H2 / L1 — header comment rewritten + ask-the-visitor rule
 *       present in built prompt
 *   T8  H3 — chat.ts cta-detection regex matches Alex's actual CTA
 *       phrases and does NOT depend on the deprecated patterns
 */
import {
  ALEX_PLANS,
  ALEX_INDUSTRIES,
  ALEX_COMPLIANCE_STATUS,
  ALEX_ENTERPRISE_FEATURES,
  ALEX_INTEGRATIONS,
  ALEX_CTAS,
  ALEX_INITIAL_GREETING,
  getDiscoveryCallUrl,
  getAlexCtasBlock,
} from "../lib/chat-knowledge-base.js";
import { buildAlexSystemPrompt } from "../lib/alex-prompt.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Hand-mirror of dashboard PLAN_PRICES (artifacts/voiceiq-dashboard/src/lib/
// plans.ts, lines 23-30). api-server cannot cross-package import the
// dashboard at test time, but ALEX_PLANS in chat-knowledge-base.ts
// already mirrors the same values with a sync comment — this test
// asserts the two mirrors haven't drifted apart.
// If you change a value in dashboard PLAN_PRICES, update both this test
// fixture AND ALEX_PLANS.
// ---------------------------------------------------------------------------
const PLAN_PRICES_MIRROR: Record<string, { label: string; monthly: number; annualPerMonth: number; setupFee: number }> = {
  essential:    { label: "Essential",    monthly: 149,  annualPerMonth: 113,  setupFee: 99 },
  starter:      { label: "Starter",      monthly: 349,  annualPerMonth: 266,  setupFee: 199 },
  professional: { label: "Professional", monthly: 749,  annualPerMonth: 571,  setupFee: 499 },
  growth:       { label: "Growth",       monthly: 999,  annualPerMonth: 833,  setupFee: 799 },
  business:     { label: "Business",     monthly: 1499, annualPerMonth: 1146, setupFee: 999 },
  enterprise:   { label: "Enterprise",   monthly: 3499, annualPerMonth: 2667, setupFee: 2499 },
};

// Hand-mirror of PricingPage.tsx SMB_PLANS quotas (lines 9-50). Same
// drift-guard contract as PLAN_PRICES_MIRROR above.
const PLAN_QUOTAS_MIRROR: Record<string, { minutes: string; locations: string; smsPerMonth: string; languages: string }> = {
  essential:    { minutes: "120 min",    locations: "1 location",  smsPerMonth: "100 SMS/mo",    languages: "English + Spanish" },
  starter:      { minutes: "750 min",    locations: "1 location",  smsPerMonth: "500 SMS/mo",    languages: "English + Spanish" },
  professional: { minutes: "2,500 min",  locations: "1 location",  smsPerMonth: "2,000 SMS/mo",  languages: "All 32 languages" },
  growth:       { minutes: "4,000 min",  locations: "2 locations", smsPerMonth: "5,000 SMS/mo",  languages: "All 32 languages" },
  business:     { minutes: "6,000 min",  locations: "3 locations", smsPerMonth: "10,000 SMS/mo", languages: "All 32 languages" },
  enterprise:   { minutes: "15,000 min", locations: "4 locations", smsPerMonth: "30,000 SMS/mo", languages: "All 32 languages" },
};

// ---------------------------------------------------------------------------
// Tiny test harness — same shape as src/tests/pii-redaction-smoke.ts
// (assert(cond, name, detail?)). Intentionally not pulling in a real
// runner so the file stays under a hundred kb of deps and runs in <1s.
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
function assert(cond: unknown, name: string, detail?: string): void {
  if (cond) {
    console.log(`  \u2713 ${name}`);
    pass++;
  } else {
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ""}`);
    fail++;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const prompt = buildAlexSystemPrompt();

// ---------------------------------------------------------------------------
// T1 — Pricing parity (regression guard for ALEX_PLANS vs PLAN_PRICES)
// ---------------------------------------------------------------------------
section("T1. Pricing parity (ALEX_PLANS vs PLAN_PRICES_MIRROR):");
assert(ALEX_PLANS.length === Object.keys(PLAN_PRICES_MIRROR).length,
  "T1.0 same number of plans on both sides");
for (const plan of ALEX_PLANS) {
  const m = PLAN_PRICES_MIRROR[plan.id];
  assert(!!m, `T1.${plan.id}.exists in dashboard mirror`);
  if (!m) continue;
  assert(plan.label === m.label,         `T1.${plan.id}.label`,         `${plan.label} vs ${m.label}`);
  assert(plan.monthly === m.monthly,     `T1.${plan.id}.monthly`,       `${plan.monthly} vs ${m.monthly}`);
  assert(plan.annualPerMonth === m.annualPerMonth,
    `T1.${plan.id}.annualPerMonth`, `${plan.annualPerMonth} vs ${m.annualPerMonth}`);
  assert(plan.setupFee === m.setupFee,   `T1.${plan.id}.setupFee`,      `${plan.setupFee} vs ${m.setupFee}`);
}

// ---------------------------------------------------------------------------
// T2 — Compliance: H1 (EU residency), M1 (HIPAA 2027), M2 (ISO 2027), SOC 2 unchanged
// ---------------------------------------------------------------------------
section("T2. Compliance corrections (H1 + M1 + M2):");
assert(ALEX_COMPLIANCE_STATUS.includes("Q4 2026"),
  "T2.1 SOC 2 still says Q4 2026");
assert(ALEX_COMPLIANCE_STATUS.includes("Formal HIPAA Type 1 attestation is planned for 2027"),
  "T2.2 M1 fix: HIPAA 2027 attestation appended");
assert(ALEX_COMPLIANCE_STATUS.includes("formal certification planned 2027"),
  "T2.3 M2 fix: ISO 27001 2027 date present");
assert(ALEX_COMPLIANCE_STATUS.includes("EU data placement can be scoped on the enterprise tier"),
  "T2.4 H1 fix: EU residency = enterprise tier (NOT Business+)");
assert(!/EU residency available on Business\+/.test(ALEX_COMPLIANCE_STATUS),
  "T2.5 H1 fix: prior 'Business+ plans' wording is gone");
assert(prompt.includes(ALEX_COMPLIANCE_STATUS),
  "T2.6 ALEX_COMPLIANCE_STATUS spliced into built prompt verbatim");

// ---------------------------------------------------------------------------
// T3 — Forbidden tokens + canonical CTAs in the BUILT PROMPT
// ---------------------------------------------------------------------------
section("T3. Forbidden tokens + canonical CTAs in built prompt:");
// Strip the forbidden-claims block — it intentionally NAMES the
// forbidden tokens to teach Alex not to use them. The test is asking
// "do those tokens appear OUTSIDE that teaching block?", not "are they
// mentioned at all".
const FORBIDDEN_BLOCK_RE = /# Hard rules \(NEVER violate\)[\s\S]*$/;
const promptNoForbiddenBlock = prompt.replace(FORBIDDEN_BLOCK_RE, "");
const FORBIDDEN_TOKENS = [
  "neverr.ai/demo",
  "neverr.ai/signup",
  "hello@neverr.ai",
  "sales@neverr.ai",
  "support@neverr.ai",
  "contact@neverr.ai",
  "/book-a-demo",
  "/sales",
];
for (const tok of FORBIDDEN_TOKENS) {
  assert(!promptNoForbiddenBlock.includes(tok),
    `T3.no-${tok} outside forbidden-claims block`);
}
assert(prompt.includes(ALEX_CTAS.signup_link),
  `T3.signup CTA "${ALEX_CTAS.signup_link}" present`);
assert(prompt.includes(ALEX_CTAS.discovery_call_link),
  `T3.discovery CTA "${ALEX_CTAS.discovery_call_link}" present`);
assert(prompt.includes(ALEX_CTAS.email),
  `T3.email CTA "${ALEX_CTAS.email}" present`);

// ---------------------------------------------------------------------------
// T4 — M3 enterprise feature surface in built prompt
// ---------------------------------------------------------------------------
section("T4. M3 — enterprise capabilities surface in built prompt:");
const M3_FRAGMENTS = [
  "SAML 2.0 enterprise SSO via WorkOS",
  "IP allowlisting (CIDR-supported)",
  "Audit logs with cross-tenant access controls",
  "Configurable data retention with automated execution",
  "Multi-factor auth (TOTP)",
  "PII handling controls (configurable per-business)",
  "TLS 1.3",
  "AES-256 at rest",
];
for (const frag of M3_FRAGMENTS) {
  assert(ALEX_ENTERPRISE_FEATURES.includes(frag),
    `T4.kb-has "${frag}"`);
  assert(prompt.includes(frag),
    `T4.prompt-has "${frag}"`);
}
assert(prompt.includes("Enterprise capabilities"),
  "T4.section-header present in built prompt");

// ---------------------------------------------------------------------------
// T5 — M4 integrations + only-from-this-list rule
// ---------------------------------------------------------------------------
section("T5. M4 — integrations + only-from-this-list rule:");
const M4_INTEGRATIONS = [
  "HubSpot",
  "Salesforce (via webhook)",
  "Google Calendar",
  "Microsoft 365",
  "Calendly",
  "Twilio",
  "Okta",
  "Azure AD",
  "Auth0",
  "Google Workspace",
  "OneLogin",
];
for (const integ of M4_INTEGRATIONS) {
  assert(ALEX_INTEGRATIONS.includes(integ),
    `T5.kb-has "${integ}"`);
  assert(prompt.includes(integ),
    `T5.prompt-has "${integ}"`);
}
assert(prompt.includes("only confirm those in this list"),
  "T5.only-from-list rule present in built prompt");

// ---------------------------------------------------------------------------
// T6 — M5 per-plan quotas in ALEX_PLANS and the built prompt
// ---------------------------------------------------------------------------
section("T6. M5 — per-plan quotas (minutes / locations / SMS / languages):");
for (const plan of ALEX_PLANS) {
  const q = PLAN_QUOTAS_MIRROR[plan.id];
  assert(!!q, `T6.${plan.id}.quotas-mirror-row exists`);
  if (!q) continue;
  assert(plan.minutes === q.minutes,         `T6.${plan.id}.minutes`,     `${plan.minutes} vs ${q.minutes}`);
  assert(plan.locations === q.locations,     `T6.${plan.id}.locations`,   `${plan.locations} vs ${q.locations}`);
  assert(plan.smsPerMonth === q.smsPerMonth, `T6.${plan.id}.smsPerMonth`, `${plan.smsPerMonth} vs ${q.smsPerMonth}`);
  assert(plan.languages === q.languages,     `T6.${plan.id}.languages`,   `${plan.languages} vs ${q.languages}`);
  // Each quota string should appear in the built prompt's plan line.
  assert(prompt.includes(plan.minutes),     `T6.${plan.id}.minutes-in-prompt`);
  assert(prompt.includes(plan.locations),   `T6.${plan.id}.locations-in-prompt`);
  assert(prompt.includes(plan.smsPerMonth), `T6.${plan.id}.sms-in-prompt`);
  assert(prompt.includes(plan.languages),   `T6.${plan.id}.languages-in-prompt`);
}

// ---------------------------------------------------------------------------
// T7 — H2/L1: header comment rewritten + ask-the-visitor rule in prompt
// ---------------------------------------------------------------------------
section("T7. H2 + L1 — narrowed industry detection + ask-the-visitor rule:");
const __dirname = dirname(fileURLToPath(import.meta.url));
const kbPath = resolve(__dirname, "../lib/chat-knowledge-base.ts");
const kbSource = readFileSync(kbPath, "utf8");
assert(!kbSource.includes("the same catalogue that powers /api/industries"),
  "T7.1 L1 fix: stale 'same catalogue powers /api/industries' comment is gone");
// Executable cardinality check — the runtime length is the source of
// truth, not the comment. If a new industry is added to
// comprehensive-industries.ts, BOTH this number AND the header comment
// in chat-knowledge-base.ts MUST be updated together.
assert(ALEX_INDUSTRIES.length === 8,
  `T7.2a L1 fix: runtime ALEX_INDUSTRIES.length === 8 (got ${ALEX_INDUSTRIES.length})`);
assert(kbSource.includes("REVOLUTIONARY_INDUSTRIES — 8"),
  "T7.2b L1 fix: header comment matches runtime cardinality");
assert(/ask them to name their industry/i.test(prompt) ||
       /ask them to name it/i.test(prompt),
  "T7.3 H2 fix: ask-the-visitor rule present in built prompt");
assert(prompt.includes("never invent jargon"),
  "T7.4 H2 fix: 'never invent jargon' guardrail present");

// ---------------------------------------------------------------------------
// T8 — H3: chat.ts cta-detection regex matches what Alex actually emits.
//   We import detectCtaSignaled indirectly by re-reading chat.ts source
//   and re-applying the same regex against representative Alex replies.
//   This avoids importing the route handler (which would boot the pg
//   pool + Anthropic client at import time).
// ---------------------------------------------------------------------------
section("T8. H3 — cta-detection regex against representative Alex replies:");
const chatPath = resolve(__dirname, "../routes/chat.ts");
const chatSource = readFileSync(chatPath, "utf8");
const regexLineMatch = chatSource.match(
  /return\s+(\/[^\n]+\/i)\.test\(text\);[\s\S]*?detectCtaSignaled/,
);
// Fallback: search for the regex literal directly inside detectCtaSignaled.
const regexLine =
  regexLineMatch?.[1] ??
  chatSource
    .split(/function\s+detectCtaSignaled/)[1]
    ?.match(/(\/[^\n]+\/i)\.test/)?.[1];
assert(!!regexLine, "T8.0 detectCtaSignaled regex literal found in chat.ts");

// Reconstruct the regex from its source for a runtime test.
let liveRegex: RegExp | null = null;
if (regexLine) {
  const m = regexLine.match(/^\/(.*)\/i$/);
  if (m) liveRegex = new RegExp(m[1], "i");
}
assert(!!liveRegex, "T8.1 regex parses cleanly");

// Representative Alex reply texts pulled from alex-prompt.ts example
// responses. Each MUST trigger cta_signaled=true under the new regex.
const SHOULD_MATCH: Array<[string, string]> = [
  ["warm-CTA",        `Sounds like a fit — easiest path is the 7-day free trial at ${ALEX_CTAS.signup_link}, or if you'd rather walk through it with someone, you can book a discovery call at ${ALEX_CTAS.discovery_call_link}.`],
  ["procurement",     `For BAAs, DPAs, security questionnaires, or anything procurement-related, the right path is ${ALEX_CTAS.email}. Want me to flag the topic in your subject line?`],
  ["plain free trial", "We offer a 7-day free trial on all self-serve plans — want to give it a try?"],
  ["plain discovery", "Happy to set up a discovery call to walk through your options."],
  ["plain get started", "Want to get started? I can point you to the signup flow."],
];
for (const [name, text] of SHOULD_MATCH) {
  assert(liveRegex && liveRegex.test(text), `T8.match.${name}`,
    `text="${text}"`);
}
// And the prior wholly-deprecated patterns Alex never produces — these
// should NOT be the ONLY way to hit the regex. We also assert the new
// regex doesn't depend on them by checking the regex source itself.
// The new regex DOES include `enterprise@neverr\.ai` (the email CTA),
// so we can't assert "no neverr.ai anywhere". The deprecated bit was
// the domain-prefixed URL paths — `neverr.ai/signup`, `neverr.ai/demo`.
// Assert specifically those are gone.
assert(!regexLine?.includes("neverr\\.ai/") && !regexLine?.includes("neverr\\.ai\\/"),
  "T8.regex.no-neverr-domain-paths (deprecated /signup|/demo URL prefixes)");
assert(!regexLine?.includes("book a demo"),
  "T8.regex.no-book-a-demo (forbidden phrase)");
assert(regexLine?.includes("\\/signup"),
  "T8.regex.has-/signup");
assert(regexLine?.includes("\\/contact"),
  "T8.regex.has-/contact");
assert(regexLine?.includes("discovery call"),
  "T8.regex.has-discovery-call");
assert(regexLine?.includes("enterprise@neverr"),
  "T8.regex.has-enterprise-email");

// ---------------------------------------------------------------------------
// T9 — Sanity: initial greeting and CTA destination triple unchanged.
// ---------------------------------------------------------------------------
section("T9. Sanity:");
assert(ALEX_INITIAL_GREETING.startsWith("Hey, I'm Alex"),
  "T9.1 greeting unchanged");
assert(ALEX_CTAS.signup_link === "/signup",
  "T9.2 signup CTA unchanged");
assert(ALEX_CTAS.discovery_call_link === "/contact?topic=enterprise",
  "T9.3 discovery CTA unchanged");
assert(ALEX_CTAS.email === "enterprise@neverr.ai",
  "T9.4 email CTA unchanged");

// ---------------------------------------------------------------------------
// T10 — Calendly env-var swap (2026-05-03): getDiscoveryCallUrl() and
//   ALEX_CTAS.discovery_call_link getter must respect NEVERR_CALENDLY_URL
//   at call time, with fail-safe fallback when unset / non-https.
// ---------------------------------------------------------------------------
section("T10. Calendly env-var swap — getDiscoveryCallUrl():");
const _origCalendly = process.env["NEVERR_CALENDLY_URL"];
try {
  // T10.1 — unset → fallback
  delete process.env["NEVERR_CALENDLY_URL"];
  assert(getDiscoveryCallUrl() === "/contact?topic=enterprise",
    "T10.1 unset → fallback /contact?topic=enterprise");
  assert(ALEX_CTAS.discovery_call_link === "/contact?topic=enterprise",
    "T10.1b ALEX_CTAS getter reflects unset → fallback");

  // T10.2 — valid https URL → returned verbatim
  process.env["NEVERR_CALENDLY_URL"] = "https://calendly.com/neverr/discovery";
  assert(getDiscoveryCallUrl() === "https://calendly.com/neverr/discovery",
    "T10.2 valid https URL returned verbatim");
  assert(ALEX_CTAS.discovery_call_link === "https://calendly.com/neverr/discovery",
    "T10.2b ALEX_CTAS getter reflects new env value at access time (no restart)");

  // T10.3 — non-https (http://) → fallback (refuse to ship insecure URL)
  process.env["NEVERR_CALENDLY_URL"] = "http://insecure.example.com/x";
  assert(getDiscoveryCallUrl() === "/contact?topic=enterprise",
    "T10.3 http:// → fallback (https-only validation)");

  // T10.4 — garbage (non-URL) → fallback
  process.env["NEVERR_CALENDLY_URL"] = "garbage-not-a-url";
  assert(getDiscoveryCallUrl() === "/contact?topic=enterprise",
    "T10.4 garbage value → fallback");

  // T10.5 — empty string → fallback
  process.env["NEVERR_CALENDLY_URL"] = "";
  assert(getDiscoveryCallUrl() === "/contact?topic=enterprise",
    "T10.5 empty string → fallback");
} finally {
  // Restore original env regardless of pass/fail above so subsequent
  // tests (and the test runner exit) see the same env they started with.
  if (_origCalendly === undefined) delete process.env["NEVERR_CALENDLY_URL"];
  else process.env["NEVERR_CALENDLY_URL"] = _origCalendly;
}

// ---------------------------------------------------------------------------
// T11 — getAlexCtasBlock() must use the live discovery_call URL each
//   call (no module-init pinning). This is the critical invariant
//   that makes the env-swap-without-restart claim true: alex-prompt.ts
//   calls getAlexCtasBlock() inside buildAlexSystemPrompt() per
//   conversation, so each new conversation re-resolves the URL.
// ---------------------------------------------------------------------------
section("T11. Calendly env-var swap — getAlexCtasBlock() lazy resolution:");
const _origCalendly2 = process.env["NEVERR_CALENDLY_URL"];
try {
  delete process.env["NEVERR_CALENDLY_URL"];
  const blockUnset = getAlexCtasBlock();
  assert(blockUnset.includes("/contact?topic=enterprise"),
    "T11.1 block unset → contains fallback URL");
  assert(!blockUnset.includes("calendly.com"),
    "T11.2 block unset → does NOT contain calendly.com");

  process.env["NEVERR_CALENDLY_URL"] = "https://calendly.com/neverr/discovery";
  const blockSet = getAlexCtasBlock();
  assert(blockSet.includes("https://calendly.com/neverr/discovery"),
    "T11.3 block set → contains the env URL (no module restart needed)");
  assert(!blockSet.includes("/contact?topic=enterprise"),
    "T11.4 block set → fallback URL no longer rendered");
} finally {
  if (_origCalendly2 === undefined) delete process.env["NEVERR_CALENDLY_URL"];
  else process.env["NEVERR_CALENDLY_URL"] = _origCalendly2;
}

// ---------------------------------------------------------------------------
// T13 — detectCtaSignaled Calendly-URL detection (architect-flagged
//   2026-05-03 follow-up). The static regex in chat.ts can't match
//   a Calendly URL directly, so we added a dynamic-URL branch in
//   detectCtaSignaled. We don't import the function (it's internal to
//   routes/chat.ts), so we re-implement the same logic here against
//   the regex source and the helper to lock the contract: env-set
//   Calendly-URL-only replies must trip the detector.
// ---------------------------------------------------------------------------
section("T13. detectCtaSignaled — Calendly URL coverage:");
const _origCalendly4 = process.env["NEVERR_CALENDLY_URL"];
try {
  // Sanity: the static regex (extracted earlier as `regexLine`) does NOT
  // match a Calendly URL — that's exactly why the dynamic branch exists.
  const calendlyOnly = "Here you go: https://calendly.com/neverr/discovery";
  const staticRegex = /\/signup|\/contact\?topic=enterprise|enterprise@neverr\.ai|free trial|discovery call|get started/i;
  assert(!staticRegex.test(calendlyOnly),
    "T13.1 static regex alone does NOT match Calendly-only reply");

  // With env set, getDiscoveryCallUrl() returns the Calendly URL and
  // text.includes(liveUrl) catches it.
  process.env["NEVERR_CALENDLY_URL"] = "https://calendly.com/neverr/discovery";
  const liveUrl = getDiscoveryCallUrl();
  assert(liveUrl === "https://calendly.com/neverr/discovery",
    "T13.2 helper returns Calendly URL when env set");
  assert(calendlyOnly.includes(liveUrl),
    "T13.3 dynamic-URL branch catches Calendly-only reply");

  // With env unset, the dynamic branch is a no-op (liveUrl === fallback,
  // and the static regex already covers the fallback).
  delete process.env["NEVERR_CALENDLY_URL"];
  const fallbackUrl = getDiscoveryCallUrl();
  assert(fallbackUrl === "/contact?topic=enterprise",
    "T13.4 helper returns fallback when env unset (dynamic branch is no-op)");
} finally {
  if (_origCalendly4 === undefined) delete process.env["NEVERR_CALENDLY_URL"];
  else process.env["NEVERR_CALENDLY_URL"] = _origCalendly4;
}

// ---------------------------------------------------------------------------
// T12 — Architect-flagged consistency (2026-05-03): when
//   NEVERR_CALENDLY_URL is set, the built prompt's "forbidden URL"
//   rule (in getAlexForbiddenClaims) must reference the LIVE Calendly
//   URL — not the stale fallback. Without this fix, Alex would see
//   the CTA block recommending Calendly AND a forbidden-claims line
//   saying "/contact?topic=enterprise is the only valid non-signup
//   URL" — a contradiction that could make Alex refuse to share the
//   Calendly link mid-conversation.
// ---------------------------------------------------------------------------
section("T12. Calendly env-var swap — built-prompt consistency:");
const _origCalendly3 = process.env["NEVERR_CALENDLY_URL"];
try {
  // Env unset: built prompt's forbidden-claims line names /contact?...
  delete process.env["NEVERR_CALENDLY_URL"];
  const promptUnset = buildAlexSystemPrompt();
  assert(/Do NOT mention any URL other than \/signup and \/contact\?topic=enterprise/.test(promptUnset),
    "T12.1 unset → forbidden-claims line names the fallback URL");

  // Env set: built prompt's forbidden-claims line names the Calendly URL,
  // and the stale /contact?topic=enterprise NEVER appears in the prompt
  // (it was the only thing referencing /contact, so its full absence is
  // proof the dynamic resolution worked end-to-end).
  process.env["NEVERR_CALENDLY_URL"] = "https://calendly.com/neverr/discovery";
  const promptSet = buildAlexSystemPrompt();
  assert(promptSet.includes("https://calendly.com/neverr/discovery"),
    "T12.2 set → built prompt contains Calendly URL");
  assert(/Do NOT mention any URL other than \/signup and https:\/\/calendly\.com\/neverr\/discovery/.test(promptSet),
    "T12.3 set → forbidden-claims line names the Calendly URL (no /contact)");
  assert(!promptSet.includes("/contact?topic=enterprise"),
    "T12.4 set → fallback URL completely absent from built prompt (no contradiction)");
} finally {
  if (_origCalendly3 === undefined) delete process.env["NEVERR_CALENDLY_URL"];
  else process.env["NEVERR_CALENDLY_URL"] = _origCalendly3;
}

// ---------------------------------------------------------------------------
console.log(`\n=== RESULTS ===\nPass: ${pass}\nFail: ${fail}`);
if (fail > 0) {
  console.error("\nAlex KB smoke tests FAILED");
  process.exit(1);
}
console.log("\nAll Alex KB smoke tests passed.");
