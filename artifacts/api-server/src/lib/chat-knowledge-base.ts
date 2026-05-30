/**
 * Alex Phase 1 knowledge base — single source of truth for everything
 * Alex is allowed to claim about Neverr in a chat.
 *
 * Composition:
 *   - Industries: a small named list (REVOLUTIONARY_INDUSTRIES — 8
 *     entries: Dental, Veterinary, Tax Prep, Immigration Law, Fitness
 *     Centers, Personal Trainers, Car Rental, Firearms Dealers) used
 *     ONLY for substring detection in
 *     chat.ts:detectIndustry. These are the highest-revenue verticals
 *     where Alex is most likely to ground a quick match. The full
 *     marketing-site catalogue (~22 categories, "193+ templates") lives
 *     in the Supabase `industry_templates` table and powers
 *     /api/industries — Alex does NOT load it (boot-time DB dependency
 *     deemed not worth the startup risk per Abdul, 2026-05-03 audit).
 *     The prompt instead instructs Alex to ASK the visitor to name
 *     their industry rather than guess from this narrow detection set.
 *   - Plans: mirrored from artifacts/voiceiq-dashboard/src/lib/plans.ts.
 *     api-server cannot import the dashboard package, so the prices are
 *     re-stated here with a hard sync-comment. Numbers MUST match
 *     dashboard plans.ts (which itself MUST match PricingPage.tsx).
 *   - Product facts: hand-curated, kept short on purpose so Alex's
 *     system prompt stays under ~1500 tokens with the rest combined.
 *
 * The opening greeting is also exported here so the route handler and
 * any future widget can render the same first line without drift.
 */

import {
  REVOLUTIONARY_INDUSTRIES,
  INDUSTRY_CATEGORIES,
  type IndustryTemplate,
} from "../data/comprehensive-industries.js";

// ---------------------------------------------------------------------------
// Plans — MUST stay in sync with:
//   * artifacts/voiceiq-dashboard/src/lib/plans.ts (PLAN_PRICES)
//   * artifacts/voiceiq-dashboard/src/pages/PricingPage.tsx (SMB_PLANS)
// If you change a price here, change all three places. Setup-fee numbers
// must also match the STRIPE_*_SETUP_PRICE_ID env secrets.
// ---------------------------------------------------------------------------
export interface AlexPlan {
  id: string;
  label: string;
  monthly: number;
  annualPerMonth: number;
  setupFee: number;
  // M5 (2026-05-03 KB audit): per-plan quotas hand-mirrored verbatim
  // from PricingPage.tsx SMB_PLANS so Alex can answer "how many minutes
  // does Starter include?" without deflecting. If you change a value
  // here, change SMB_PLANS too.
  minutes: string;
  locations: string;
  smsPerMonth: string;
  languages: string;
}

export const ALEX_PLANS: AlexPlan[] = [
  { id: "essential",    label: "Essential",    monthly: 149,  annualPerMonth: 113,  setupFee: 99,
    minutes: "120 min",     locations: "1 location",   smsPerMonth: "100 SMS/mo",     languages: "English + Spanish" },
  { id: "starter",      label: "Starter",      monthly: 349,  annualPerMonth: 266,  setupFee: 199,
    minutes: "750 min",     locations: "1 location",   smsPerMonth: "500 SMS/mo",     languages: "English + Spanish" },
  { id: "professional", label: "Professional", monthly: 749,  annualPerMonth: 571,  setupFee: 499,
    minutes: "2,500 min",   locations: "1 location",   smsPerMonth: "2,000 SMS/mo",   languages: "All 32 languages" },
  { id: "growth",       label: "Growth",       monthly: 999,  annualPerMonth: 833,  setupFee: 799,
    minutes: "4,000 min",   locations: "2 locations",  smsPerMonth: "5,000 SMS/mo",   languages: "All 32 languages" },
  { id: "business",     label: "Business",     monthly: 1499, annualPerMonth: 1146, setupFee: 999,
    minutes: "6,000 min",   locations: "3 locations",  smsPerMonth: "10,000 SMS/mo",  languages: "All 32 languages" },
  { id: "enterprise",   label: "Enterprise",   monthly: 3499, annualPerMonth: 2667, setupFee: 2499,
    minutes: "15,000 min",  locations: "4 locations",  smsPerMonth: "30,000 SMS/mo",  languages: "All 32 languages" },
];

// ---------------------------------------------------------------------------
// Industries — derived views the prompt builder consumes. We intentionally
// export only NAMES + categories here (not the full template payload) to
// keep the system prompt token-bounded; the per-industry pain-points and
// scripts are pulled at demo-generation time, not chat time.
// ---------------------------------------------------------------------------
export const ALEX_INDUSTRY_CATEGORY_NAMES: string[] =
  INDUSTRY_CATEGORIES.map((c) => c.name);

export const ALEX_INDUSTRIES: ReadonlyArray<IndustryTemplate> =
  REVOLUTIONARY_INDUSTRIES;

// Pre-formatted strings the prompt builder can splice in directly.
export const ALEX_INDUSTRIES_SUMMARY: string =
  ALEX_INDUSTRY_CATEGORY_NAMES.join(", ");

export const ALEX_INDUSTRY_NAMES_LIST: string =
  ALEX_INDUSTRIES.map((i) => `- ${i.industryName} (${i.industryCategory})`).join("\n");

// ---------------------------------------------------------------------------
// Product facts — hand-curated. KEEP SHORT. Anything Alex states about
// Neverr's capabilities, onboarding, or pricing structure must trace
// back to a literal line in this block (or to ALEX_PLANS).
//
// 2026-05 fix: previously listed "neverr.ai/signup" and "neverr.ai/demo"
// as the canonical destinations. /demo doesn't exist (it's a sales-demo
// dynamic route, not a CTA target) and the absolute "neverr.ai/..."
// form caused Alex to also hallucinate variants like "hello@neverr.ai".
// All CTA destinations now live in ALEX_CTAS below as the SINGLE source
// of truth — product facts only mention them descriptively.
// ---------------------------------------------------------------------------
export const ALEX_PRODUCT_FACTS: string = `
Neverr is an AI voice agent platform built for small and mid-sized businesses. Voice agents answer inbound calls, qualify leads, book appointments, and follow up on missed calls 24/7, in natural conversation.

Core capabilities:
- Inbound call answering with industry-tuned scripts
- Appointment booking via calendar integration
- Missed-call SMS follow-up
- Lead qualification + routing rules
- Call analytics, transcripts, and recordings
- Multi-language support

Onboarding:
- 5-minute web form, agent live within hours
- 7-day free trial on every self-serve plan
- One-time setup fee per plan (see pricing)
- Self-serve signup is available; for larger / franchise / volume tiers
  the team offers a discovery call. Use the canonical CTA destinations
  in ALEX_CTAS — never invent URLs or emails.
`.trim();

// ---------------------------------------------------------------------------
// CTA destinations — THE ONLY URLs and EMAIL Alex is allowed to mention.
// Everything else (neverr.ai/demo, hello@neverr.ai, sales@neverr.ai,
// /book-a-demo, etc.) is forbidden. The prompt builder splices these
// strings in literally so Alex's reply text matches what the user can
// actually click on the marketing site.
//
// If a destination changes, update HERE and only here. The forbidden
// list below should be kept in sync — if you ADD a real URL, remove
// any of its near-misses from forbidden_claims.
// ---------------------------------------------------------------------------
export interface AlexCtas {
  signup_link: string;
  discovery_call_link: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Discovery-call URL resolver (2026-05-03 Calendly env-var swap).
//
// Why a helper, not a const string:
//   The discovery-call destination is a tech-debt placeholder
//   (/contact?topic=enterprise — generic contact form) until ops drops
//   the Calendly link in NEVERR_CALENDLY_URL. We want the swap to be a
//   pure config change (set the secret, restart) with NO file edits
//   hunting through the codebase.
//
// No module-init caching:
//   process.env is re-read on every call rather than snapshotted at
//   module-import time. This keeps the helper forward-compatible with
//   any env-rotation mechanism — a hypothetical future tool that
//   updates process.env on the live process would Just Work, and tests
//   can override the env per-case without re-importing the module.
//
//   IMPORTANT — Replit secret-rotation reality: as of 2026-05, Replit
//   Secrets changes do NOT propagate into already-running workflow
//   processes. Operators rotating NEVERR_CALENDLY_URL must restart the
//   api-server workflow (or redeploy) for Node's process.env to pick
//   up the new value. The "re-read on each call" design just means
//   that, post-restart, every new conversation sees the live value —
//   we don't have a stale snapshot lurking from boot.
//
//   The cost is one process.env lookup per CTA-block render — negligible.
//
// Validation:
//   If NEVERR_CALENDLY_URL is set but doesn't start with https://, the
//   boot-time IIFE below logs a warning and the resolver falls back to
//   the contact-form path. Refusing to ship an invalid URL into Alex's
//   prompt is safer than letting Alex paste "garbage" at customers.
// ---------------------------------------------------------------------------
const DISCOVERY_CALL_FALLBACK = "/contact?topic=enterprise";

export function getDiscoveryCallUrl(): string {
  const env = process.env["NEVERR_CALENDLY_URL"];
  if (env && env.startsWith("https://")) return env;
  return DISCOVERY_CALL_FALLBACK;
}

// Boot-time logging + validation (runs once on module import — same
// fail-loud / log-loud pattern as lib/anthropic.ts). The IIFE is
// guarded so test files importing this module repeatedly don't spam.
let _bootLogged = false;
(function bootLogConfig() {
  if (_bootLogged) return;
  _bootLogged = true;
  const env = process.env["NEVERR_CALENDLY_URL"];
  if (env && !env.startsWith("https://")) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] NEVERR_CALENDLY_URL is set but does not start with https:// — ignoring and falling back to ${DISCOVERY_CALL_FALLBACK}. (Got: "${env.slice(0, 80)}${env.length > 80 ? "..." : ""}")`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[config] discovery_call_url=${getDiscoveryCallUrl()}`);
})();

// ALEX_CTAS keeps its original shape for backward-compat (every caller
// reads `ALEX_CTAS.discovery_call_link` as a string) — we just back it
// with a getter so the value re-resolves from the env on each read.
// Tests yesterday locked the literal `/contact?topic=enterprise` value;
// they continue to pass when NEVERR_CALENDLY_URL is unset.
export const ALEX_CTAS: AlexCtas = {
  signup_link: "/signup",
  get discovery_call_link(): string {
    return getDiscoveryCallUrl();
  },
  email: "enterprise@neverr.ai",
};

// ---------------------------------------------------------------------------
// Compliance status — mirrors the wording on /enterprise and /privacy
// pages so a visitor who reads both gets a consistent story. Hand-
// curated; if legal changes any wording on the marketing site, update
// here too. Alex is allowed to give these answers DIRECTLY with
// confidence — they are NOT a "deflect to the team" topic.
//
// 2026-05 fix: previously not in the knowledge base at all, so Alex
// (correctly) treated SOC 2 / HIPAA / ISO questions as out-of-scope and
// deflected. Adding them here + a knowledge-confidence directive in the
// prompt fixes the over-deflection.
// ---------------------------------------------------------------------------
export const ALEX_COMPLIANCE_STATUS: string = `
- HIPAA: NOT certified. Designed HIPAA-conscious — we minimize PHI on the line and escalate calls to your staff per your protocol. BAAs are available for healthcare customers on request. Formal HIPAA Type 1 attestation is planned for 2027.
- SOC 2: Type 1 audit is underway right now, targeting Q4 2026. Readiness documentation can be shared for procurement / vendor review on request.
- ISO 27001: Not certified yet — aligned with the controls; formal certification planned 2027.
- GDPR / CCPA: Data-processing terms and a DPA are available on request.
- Data residency: US-hosted by default. EU data placement can be scoped on the enterprise tier — discovery call to confirm.
`.trim();

// ---------------------------------------------------------------------------
// Enterprise capabilities (M3 fix, 2026-05-03 KB audit) — mirrors
// COMPLIANCE_LIVE on EnterprisePage.tsx:46-55 verbatim. Without this
// block Alex would deflect on "do you support SAML SSO?" / "do you have
// audit logs?" — questions /enterprise answers confidently. The list is
// security/compliance-controls flavored (what's LIVE today); the
// rollout-style features (multi-location, custom contracts) stay in
// product-facts.
// ---------------------------------------------------------------------------
export const ALEX_ENTERPRISE_FEATURES: string = `
- TLS 1.3 in transit (HSTS enforced)
- AES-256 at rest (Supabase + Twilio + ElevenLabs all certified)
- Multi-factor auth (TOTP) for all dashboard accounts
- SAML 2.0 enterprise SSO via WorkOS
- IP allowlisting (CIDR-supported)
- Audit logs with cross-tenant access controls
- Configurable data retention with automated execution
- PII handling controls (configurable per-business)
`.trim();

// ---------------------------------------------------------------------------
// Integrations (M4 fix, 2026-05-03 KB audit) — mirrors INTEGRATIONS on
// EnterprisePage.tsx:122-152. Without this block Alex deflects on "do
// you integrate with HubSpot?" even though Growth+ ships native HubSpot.
// Prompt instruction: only confirm integrations IN this list.
// ---------------------------------------------------------------------------
export const ALEX_INTEGRATIONS: string = `
Identity: SAML 2.0 SSO, Okta, Azure AD, Auth0, Google Workspace, OneLogin
Telephony: Twilio (SOC 2, HITRUST), Number porting available, Multi-line per location
CRM & calendar: HubSpot, Salesforce (via webhook), Google Calendar, Microsoft 365, Calendly
`.trim();

// ---------------------------------------------------------------------------
// Forbidden claims — explicit list of things Alex has said in the wild
// that are wrong or fabricated. The prompt instructs Alex to never say
// any of these. Add to this list whenever a real-user-test surfaces
// another fabrication so the next iteration of the prompt closes it.
//
// 2026-05-03 Calendly swap: this WAS a static const that hard-coded
// "/contact?topic=enterprise" as "the only valid non-signup URL".
// When NEVERR_CALENDLY_URL is set, that line would CONTRADICT the
// CTA block (which would then list the Calendly URL as the discovery
// call destination). Alex would see both rules and could refuse to
// share Calendly or apologize for breaking its own rule. Converted
// to a function that interpolates ALEX_CTAS getters so the
// "only valid URL" list always matches the live CTA destinations.
// Architect-flagged 2026-05-03.
// ---------------------------------------------------------------------------
export function getAlexForbiddenClaims(): string {
  return `
- Do NOT mention any URL other than ${ALEX_CTAS.signup_link} and ${ALEX_CTAS.discovery_call_link}. Specifically forbidden: neverr.ai/demo, /demo, /book-a-demo, /sales, /book.
- Do NOT mention any email other than ${ALEX_CTAS.email}. Specifically forbidden: hello@neverr.ai, sales@neverr.ai, support@neverr.ai, contact@neverr.ai.
- Do NOT claim SOC 2 certification — only the Type 1 audit-underway status above is true.
- Do NOT claim HIPAA certification or "HIPAA-compliant" — only "HIPAA-conscious + BAAs available" is true.
- Do NOT claim ISO 27001 certification — only "aligned with controls" is true.
- Do NOT invent customer names, case studies, logos, or specific metrics ("90% of our dental customers see X").
- Do NOT promise discounts, custom pricing, or features not in the published plan list.
`.trim();
}

// Pre-formatted CTA block the prompt builder splices in.
//
// 2026-05-03 Calendly swap: this WAS a static template-literal const,
// which would have pinned the discovery_call URL at module-import time
// and defeated the env-swap-without-restart goal. Converted to a
// function so the URL is re-resolved every time buildAlexSystemPrompt()
// runs (i.e. on every new conversation start). Callers that previously
// did `${ALEX_CTAS_BLOCK}` now do `${getAlexCtasBlock()}`.
export function getAlexCtasBlock(): string {
  return `
- Self-serve signup link: ${ALEX_CTAS.signup_link}
- Discovery call (for larger / franchise / volume / enterprise tiers): ${ALEX_CTAS.discovery_call_link}
- Email for procurement / security / contract questions: ${ALEX_CTAS.email}
`.trim();
}

// ---------------------------------------------------------------------------
// Opening line. Used by routes/chat.ts on conversation create AND will
// be re-used by the Sunday widget so first paint matches the API.
// ---------------------------------------------------------------------------
export const ALEX_INITIAL_GREETING: string =
  "Hey, I'm Alex — Neverr's AI guide. I can answer questions about how Neverr would work for your business, walk you through pricing, or help you get set up. What kind of business do you run?";
