# Neverr AI — Development Guide

## Overview
Neverr AI is an AI receptionist platform that integrates voice AI, CRM, SMS campaigns, and analytics to automate customer interactions and streamline communication for businesses. It aims to enhance customer engagement, improve operational efficiency, and drive growth through intelligent automation, including AI-powered call handling, smart transfers, and multi-location support. The platform focuses on lead qualification and comprehensive communication management.

## User Preferences
I prefer clear, concise explanations and iterative development. Please ask before making any major architectural changes or decisions. When implementing features, prioritize security and scalability. I prefer detailed explanations for complex logic or significant design choices.

## System Architecture
The project is structured as a pnpm monorepo using React, Vite, Wouter, and Tailwind CSS for the frontend, and Express with TypeScript for the API server. The voice engine uses Fastify with ElevenLabs and Twilio. Supabase (PostgreSQL with Drizzle ORM) handles the database and authentication.

**Core Architectural Decisions:**
- **Monorepo Structure:** Organizes frontend, API, and voice engine into separate packages for maintainability.
- **Microservices-oriented:** Distinct API server and voice engine for scalability and separation of concerns.
- **Data Management:** Supabase for robust PostgreSQL database and built-in authentication.
- **UI/UX Design:** Navy and Blue branding, with a comprehensive dashboard featuring Command Center, Calls/Leads, Appointments, Analytics, Settings, Contacts/CRM, and SMS Campaigns.
- **Security-first Approach:** Implemented with Helmet, CORS allowlisting, rate limiting, brute-force protection, and audit logging.
- **Role-Based Access Control (RBAC):** Enterprise-grade RBAC with five distinct roles and granular, per-resource permissions.
- **AI Receptionist Customization:** Highly configurable AI agent with customizable name, voice, greeting, language support, and smart call transfer logic.
- **Multi-Location Support:** Designed to manage multiple business locations, each with independent configurations.
- **Advanced Analytics:** Comprehensive server-side analytics for calls, leads, and operational performance.
- **Integrated CRM & SMS:** Features paginated contacts with lead scoring, call history, and robust SMS campaign management including compliance.
- **Intelligent Features:** Includes objection intelligence, caller emotion detection, post-call satisfaction surveys, competitive intelligence, no-show prevention, caller DNA profiles, revenue recovery campaigns, industry benchmark reports, live call coaching, and multilingual cultural sentiment adaptation.
- **Internationalization:** Supports English, Spanish, and French.

## Runtime configuration

### Calendly link override (2026-05-03)
The discovery-call CTA destination ("book a call with sales") is config-driven so it can be swapped without code changes when ops drops the Calendly link.

### TTS rate limit + health endpoints (2026-05-03)
- `POST /api/chat/tts` is rate-limited two ways: 30 req / 5 min keyed by `neverr_visitor_id` cookie (env: `NEVERR_TTS_RATE_LIMIT_PER_WINDOW`, `NEVERR_TTS_RATE_LIMIT_WINDOW_MS`), plus a hard ceiling of 3× that per source IP to defeat cookie-rotation cost-abuse. 429 responses set `Retry-After` + `RateLimit-*` headers and return `{error:"rate_limited", message}`. Each block writes a `chat.tts.rate_limited` audit row with `reason`, `used`, `limit`, `remaining`, `reset_ms`. ChatWidget shows a transient "slow down" line on 429 without dropping voice mode.
- `GET /api/healthz` (readiness): probes DB (`BEGIN; SET LOCAL statement_timeout=500; SELECT 1; COMMIT`) + Supabase HEAD with 500ms timeouts, plus env-presence for Anthropic/ElevenLabs. Returns 503 if any required service is down. `Cache-Control: no-store`.
- `GET /api/livez` (liveness): trivial 200 with uptime; never touches a dependency.
- Both health routes bypass auth via `AUTH_BYPASS_PATTERNS` in `app.ts`.
- Smoke: `pnpm --filter @workspace/api-server run test:tts-rate-limit` (17 assertions).

### Monday-deploy preflight (2026-05-04)
- `pnpm --filter @workspace/api-server run preflight` runs ~34 read-only checks (schema/migrations via Supabase service-role, env-var presence + shape, live API reachability with no-charge env-only probes for paid vendors, app-health probes against the local dev server) and prints a green/yellow/red table.
- Hard read-only by default. The one write-touching probe (POST /api/chat/conversation) is gated behind `PREFLIGHT_ALLOW_WRITES=1` and skipped otherwise.
- `PREFLIGHT_VERBOSE=1` shows masked secret previews and detail rows on greens. `PREFLIGHT_APP_BASE` overrides the dev-server URL.
- Exit 0 if no RED, exit 1 otherwise — safe to wire into CI.

- **API server** — set Replit Secret `NEVERR_CALENDLY_URL=https://calendly.com/...` then **restart the `artifacts/api-server: API Server` workflow** (or redeploy). Replit Secrets do NOT hot-reload into already-running processes — `process.env` only picks up the new value on process start. Once restarted, every new conversation immediately sees the live URL (the resolver re-reads `process.env` per call, so we never have a stale boot-time snapshot). Boot log shows the active URL: `[config] discovery_call_url=...`. The value must start with `https://` or it's ignored with a warning, falling back to `/contact?topic=enterprise`.
- **Dashboard (frontend)** — set `VITE_CALENDLY_URL=https://calendly.com/...` then **rebuild + redeploy the dashboard** (Vite bakes env vars into the bundle at build time). Default fallback is `/contact?topic=enterprise`. Two consumer sites: `EnterprisePage.tsx`, `ChatWidget.tsx`. Both import the single helper `src/lib/cta.ts:getDiscoveryCallUrl()`.
- **Runtime config endpoint** — `GET /api/config` returns `{ discovery_call_url, version }`, public (in `AUTH_BYPASS_PATTERNS`), 60s in-memory cache. Available for any future runtime consumer (e.g. if we want the dashboard to pick up Calendly without a rebuild).

When `NEVERR_CALENDLY_URL` is unset (current state), behavior is identical to pre-2026-05-03: Alex chat + dashboard pages all link to `/contact?topic=enterprise`.

## External Dependencies
- **Supabase:** PostgreSQL database and Authentication.
- **Stripe:** Payment processing.
- **ElevenLabs:** Voice synthesis.
- **Twilio:** Telephony and SMS services.
- **Anthropic:** Call transcript analysis (Claude).
- **Resend:** Email notifications.
- **Google API:** Google Calendar integration.
- **Microsoft API:** Outlook integration.
- **Cloudflare:** CDN and security.

## Post-launch tech debt — week 1
Tracked April 27, 2026 (Phase 3k). Each item is non-blocking for launch but should be retired before scaling beyond the first 100 customers.

1. **`routes/enterprise.ts:225-234` writes to ghost `businesses` table.** The security-policy update endpoint writes `security_policy / mfa_required / ip_whitelist` to a non-existent `businesses` table — Supabase silently rejects the write with no error surfaced to the client. Fix: either add `security_policy jsonb` / `ip_whitelist text[]` / `mfa_required boolean` columns to `business_configs`, or create a proper `business_security_policies` table. Until then, the security-policy form on the dashboard does nothing.

2. **Real usage tracking aggregation.** `BillingTab` now shows a "Coming Soon" stub for usage. Replace with a `GET /api/usage/:businessId` endpoint that aggregates `calls.duration_seconds` and SMS rows in the current billing period, returning `{ minutesUsed, smsUsed }`. Wire into `BillingTab` to render real progress bars.

3. **Stripe API version pin (`2024-04-10`).** The pin is ~6 months behind the v21 SDK default. Audit `invoice.subscription` and `current_period_end` shape changes (notably the v2024-12-18 invoice schema split) before bumping. The `as any` cast on `apiVersion` in `stripe.ts` should also be removed once on a supported version string.

4. **Idempotency event ledger for Stripe webhooks.** Add `stripe_events(event_id text PRIMARY KEY, type text, received_at timestamptz default now())` and an upsert-or-skip check at the top of the webhook handler. Current event set (`subscription.updated`, `subscription.deleted`, `invoice.payment_succeeded`) is naturally idempotent because handlers UPDATE, but this is required before adding events that CREATE records (refunds, payment intents, credit grants) where double-processing causes data corruption.
## Sprint 1 BUG-17 — pending_payment UX bundle (April 28, 2026)
Status: **Implemented + verified, NOT deployed.** Full bundle (sub-steps 3c webhook fixes through 3c-extended-4 + 3d server-side gate + 3e dashboard UX) ships as ONE deploy after final user review.

- **3c bundle:** Stripe webhook event handling + setup-fee restoration + signup INSERT now sets `subscription_status='pending_payment'` upfront.
- **3d:** Server-side onboarding gate at `/auth/complete-onboarding` rejects with 403 when subscription_status is not in ONBOARDING_ALLOWED_STATUSES (`active`, `trialing`, `past_due`). Last verified 11/11 at HEAD `7319dea`.
- **3e:** Dashboard frontend gate (this turn).
  - NEW `lib/plans.ts` — hoisted PLAN_PRICES + VALID_PLANS + getPlanMeta + formatPriceLabel from Signup.tsx (kept in sync manually with PricingPage.SMB_PLANS — see comment).
  - NEW `components/PendingPaymentScreen.tsx` — full-screen blocking modal with Resume Checkout / Choose plan / Sign Out.
  - MODIFY `pages/Signup.tsx` — cancelled-checkout banner driven by 3-state classifier (logged_in / logged_out / none); on 4xx-from-/auth/me wipes stale localStorage to reset cleanly.
  - MODIFY `App.tsx` DashboardLayout — discriminated GateState union (loading / blocked / polling_success / polling_timeout / ready / error); polls /api/stripe/subscription every 2s for 30s after `?checkout=success`; SuccessToast + URL param stripping; only `pending_payment` blocks (null/past_due/cancelled fail open — 3d is the real action backstop).
  - Verification: `artifacts/api-server/src/tests/3e-verify.ts` — 11-test harness creates isolated fixture (auth.users + business_configs + user_businesses), exercises pending_payment / trialing / active / past_due / cancelled / unknown-biz, validates UI wiring, tears down. **PASS 11/11.** Re-runnable as a regression test.

## Sprint 2 STEP 4 / BUG-18 — email verification (April 29, 2026)
Status: **Implemented + architect-reviewed (PASS), NOT deployed, MIGRATION NOT YET APPLIED.** Ships behind the existing pending_payment gate (BUG-17 sub-step 3e). Verification email is sent by the Stripe webhook at the moment a business transitions out of `subscription_status='pending_payment'` into `trialing`/`active` — NEVER from `/signup` itself (which always writes pending_payment, see BUG-18 DO-NOT list).

- **Migration 008** (`artifacts/api-server/migrations/008_email_verification_tokens.sql`) — pending paste into Supabase SQL editor (project zqhijauefcpwggklshoa). Creates `email_verification_tokens` table (TEXT PK = the token itself, FK to auth.users with ON DELETE CASCADE, RLS enabled with no policies = service-role only) plus two defaulted columns on `business_configs`: `email_verified BOOLEAN NOT NULL DEFAULT FALSE` and `email_verified_at TIMESTAMPTZ NULL`. Three indexes including a partial `(user_id) WHERE used_at IS NULL` for the "claim prior unused tokens" sweep. Idempotent — safe to re-run.
- **Token format:** mirrors `/admin/team/activate` — `secureToken("evt", 32)` → 64-hex char token. 24-hour TTL. Single-use enforced via `used_at` plus a CAS-style claim (`UPDATE...WHERE used_at IS NULL...select()`) in the verify handler so concurrent double-clicks / strict-mode re-mounts don't double-spend.
- **Service** (`artifacts/api-server/src/services/verification-email-service.ts`): `issueAndSendVerification` claims any prior unused tokens for the user (so a freshly-issued link supersedes older ones), inserts the new token, dispatches via Resend (fire-and-forget on send failure — token still issued, user can hit Resend on the gate). `dispatchVerificationOnStatusFlip` is the webhook-side helper that gates on `(newStatus IN trialing/active)` AND `(previousStatus IN pending_payment OR null)` — only fires on the GENUINE transition out of pending_payment. Also checks `email_verified` to short-circuit re-sends.
- **Webhook wiring** (`app.ts`): the helper is called from BOTH `checkout.session.completed` AND `customer.subscription.created/updated`. Stripe doesn't guarantee event ordering between these two; whichever arrives first does the flip + send, the second event sees `previousStatus !== "pending_payment"` and short-circuits. Pre-UPDATE SELECT in `customer.subscription.*` captures `prevSubStatus` (the existing `currentStatus` at line 392 serves the same purpose in `checkout.session.completed`).
- **Verify route** (`/auth/verify-email`, public, anti-enumeration): collapses every no-go path (token-not-found / already-used / expired / CAS-race-lost / missing-token-param) to a SINGLE wire response — `200 {success: false, reason: "invalid_or_expired"}`. Internal distinctions logged via `failGeneric()`. If `business_configs.update` fails AFTER the token is claimed, auto-reissues a fresh token + email and returns 500 with copy gated on whether the reissue Resend call actually succeeded ("we've emailed you a fresh link" vs neutral retry guidance).
- **Resend route** (`/auth/resend-verification`, requireAuth, in-memory 60s cooldown): also gates on `subscription_status` so a `pending_payment` user CANNOT trigger a send via this path (defense in depth against the DO-NOT rule).
- **Dashboard gate** (`App.tsx`): NEW `GateState.email_unverified` kind composed AFTER the existing `pending_payment` branch. Both the main load effect AND the polling `pollOnce` now check `config.email_verified` after status resolves to trialing/active. NEW `/verify-email` route renders the public `VerifyEmail` page (POSTs token on mount, ref-based double-mount guard for React strict-mode). NEW `EmailVerificationScreen` is the full-screen blocking component shown when `email_verified=false`.
- **Architect re-review:** PASS on all 3 originally-flagged critical issues (missed status-flip surface / verify atomicity / anti-enumeration). One known-acceptable limitation logged below.
- **Known acceptable race** (post-launch tech debt): exact-once dedupe across BOTH webhook handlers under high-concurrency parallel delivery is not strictly guaranteed — both handlers can read `previousStatus="pending_payment"` in parallel and both fire dispatch. The `email_verified` short-circuit inside the helper masks this in practice (a stale read in the SECOND call sees the FIRST call's update), and even if two emails go out the prior-token-claim sweep in `issueAndSendVerification` ensures only the LATEST token is valid. Strict exact-once would require a DB-side compare-and-set or dispatch ledger keyed by `(business_id, verification_phase)` — out of scope for launch.
- **Post-merge action required:** apply migration 008 in Supabase SQL editor → restart `artifacts/api-server: API Server` workflow → run BUG-18 runtime tests 2-9 from the Sprint 2 STEP 4 brief.

## Dev DB Notes (2026-05-03)
- **audit_logs table** lives in shared Supabase project `zqhijauefcpwggklshoa` (accessed via `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`), NOT in helium PG (which `DATABASE_URL` points to but is empty/unused). Saturday's resume note "audit_logs missing in dev DB" was a helium-PG observation, not the actual runtime audit destination. Audit middleware writes have been landing correctly in dev all along.
- **business_configs.pii_handling** column added in migration `016_business_configs_pii_handling.sql`. Per-business override for PII redaction mode ('minimize' | 'off'). Resolution chain in `resolveRedactionMode()`: business_configs.pii_handling → `PII_REDACTION_MODE` env → 'minimize' default. Lookup is cached per-business for 60s; DB errors fall through to env/default and never throw. Single source of truth: `artifacts/api-server/src/lib/pii-redact-transcript.ts`. The historical `voiceiq-engine/lib/pii-redact-transcript.js` mirror was removed in Phase 0 prep when voiceiq-engine itself was retired (zero production traffic, all inbound voice routes via `routes/api.ts:3855` → ElevenLabs hosted `/twilio/inbound_call`).

## Preflight check — fully wired (2026-05-04)
Status: **Complete + architect-approved + production-deployed.** Result: `26 ✅  10 ⚠️  0 ❌` — exit 0 (green-light).

- **Script:** `artifacts/api-server/scripts/preflight-check.ts` — standalone tsx, READ-ONLY, no new deps. Run via `pnpm --filter @workspace/api-server run preflight`. Completes in <5s.
- **~26 checks across 6 sections:** Schema/DB (Supabase service-role connect, helium PG reachable, chat_conversations / chat_messages / business_configs / audit_logs existence, business_configs.pii_handling column from Mig 016), Env vars (Anthropic, ElevenLabs, Supabase, WorkOS, Stripe, Twilio — softened to minLen + prefix checks), Live API health (env-only probes for paid vendors to avoid charges, Supabase HEAD probe), App health (/api/livez, /api/healthz, /api/sso/init), Operational (CookieYes Pro Trial expiry hard-coded 2026-05-16 + override via `NEVERR_COOKIEYES_TRIAL_EXPIRES`, Anthropic rate-limit informational), Manual checks (WorkOS Phase 5 SAML ticket, cookie banner, ChatWidget voice mode, migration 016 applied, .replit secrets cleanup).
- **Critical fix during build:** chat_conversations + chat_messages live in **helium PG (DATABASE_URL) via pg.Pool**, NOT Supabase. Original probe was hitting Supabase and silently failing. Rewired to use pg.Client against DATABASE_URL with information_schema + count(*) checks.
- **Write-touching probe gate:** POST /api/chat/conversation smoke is GATED behind `PREFLIGHT_ALLOW_WRITES=1` (skipped by default — endpoint INSERTs rows).
- **Probe robustness fix:** Supabase `.head:true` swallows errors silently — replaced with explicit error check on the response body; schema probes parallelized via `Promise.all`.
- **Env knobs:** `PREFLIGHT_VERBOSE=1` (masked previews + green detail rows), `PREFLIGHT_APP_BASE` (override dev-server URL), `PREFLIGHT_ALLOW_WRITES=1` (opt-in to write probe), `NEVERR_COOKIEYES_TRIAL_EXPIRES` (override trial expiry).
- **Output:** Pretty stdout with ❌→⚠️→✅ priority ordering inside each section. Exit 0 if all green/yellow, exit 1 if any RED — safe to wire into CI.
- **Migration 016 applied** to Supabase prior to deploy (via Supabase SQL editor). Confirmed via preflight schema probe.

## Landing-page navigation restructure — Option C (2026-05-04)
Status: **Pieces 1 + 1.5 + 2 shipped. Piece 3 (Industries megamenu) discovered + pending execution.**

Single nav component owns both desktop and mobile rendering: `artifacts/voiceiq-dashboard/src/components/LandingNav.tsx`. Uses wouter `<Link>` for routing, shadcn `Sheet` for mobile, Tailwind v4 (no tailwind.config — CSS-native via `@import "tailwindcss"` + `@theme inline` in `src/index.css`).

### Piece 1 — Nav trim + "Sign in" → "Login" rename
**Why:** Pre-launch nav had 11 items wrapping awkwardly ("Early access" / "Sign in" both wrapping onto two lines). Trimmed to focus on the 4 highest-converting destinations.

- **NAV_LINKS** array reduced from 9 → 4: removed Languages (`/multilingual`), ROI (`/roi`), Early access (`/#early-access`), Demo (`/try-your-agent`), Contact (`/contact`). Final order: **Features · Industries · Pricing · Enterprise**.
- **All removed routes still resolve** — only nav surfaces removed. ROI + Contact already covered in `LandingFooter.tsx`. `/multilingual`, `/try-your-agent` remain externally linkable.
- **"Sign in" → "Login"** in both desktop (line 40) and mobile (line 90) renderings — literal text replacement (verified not JSX expression first).
- **Single source of truth:** the same `NAV_LINKS` array drives both desktop `<nav>` and the mobile `Sheet` — array mutations apply to both surfaces automatically.

### Piece 1.5 — Layout balance fix
**Why:** After Piece 1's trim, the parent `flex justify-between` container left a wide empty gap between Enterprise and the Login/CTA cluster (3 children spaced evenly with only 4 nav items).

- **Wrapping change:** desktop `<nav>` and the Login/CTA `<div>` now share a single outer wrapper `<div className="hidden md:flex items-center gap-8">` so they cluster on the right side of the `justify-between` parent. Logo stays far-left.
- **Inner elements** (`<nav>` and Login/CTA div) lost their `hidden md:flex` classes — the wrapper now controls visibility. `gap-6` between nav links and `gap-3` between Login + CTA preserved.
- **Mobile untouched.**

### Piece 2 — Scroll-triggered nav shrink
**Why:** Sticky nav was visually heavy when scrolled below the hero. Now shrinks logo + padding + intensifies blur on scroll past the hero, reverts on scroll back up.

- **Two files touched:**
  - `artifacts/voiceiq-dashboard/src/pages/Landing.tsx` — sentinel `<div data-hero-sentinel aria-hidden="true" />` inserted at the bottom of the hero `<section>` (line 251).
  - `artifacts/voiceiq-dashboard/src/components/LandingNav.tsx` — `useEffect` import, `isShrunk` state, `IntersectionObserver` effect, 3 conditional className applications.
- **Mechanism:** IntersectionObserver with `rootMargin: "-80px 0px 0px 0px"` watches the sentinel. When sentinel exits the viewport top zone (user scrolled ~80px past hero bottom), `isShrunk=true`. No scroll-event listener (cheap GPU-friendly approach).
- **Conditional styling:** header gets `backdrop-blur-lg shadow-sm` (vs `backdrop-blur-md`); container `py-3` (vs `py-5`); logo `md:h-10` (vs `md:h-16`). All transitions `transition-all duration-200 ease-out`.
- **Cross-page safety:** `if (!sentinel) return` early-exits the effect on pages without a hero (e.g. `/pricing`, `/enterprise`) — header stays at full size on those pages.
- **Cleanup:** `observer.disconnect()` in effect return.

### Piece 3 — Industries megamenu (DISCOVERED, NOT YET BUILT)
**Plan:** click-triggered shadcn `NavigationMenu` on the Industries nav item, showing a category grid + "View all 193 →" link to `/industries`.

- **NavigationMenu already installed:** `artifacts/voiceiq-dashboard/src/components/ui/navigation-menu.tsx` exists — no shadcn CLI step needed. Uses `@radix-ui/react-navigation-menu` + cva. components.json: style "new-york", baseColor "neutral".
- **Data source:** `artifacts/api-server/src/data/comprehensive-industries.ts` (981 lines). `INDUSTRY_CATEGORIES` array has **6 categories** (not 8 individual industries as originally planned): healthcare, professional_services, legal_services, health_fitness, transportation, specialized_retail. 5 of 6 are `isFeatured: true`. Icons are emoji strings.
- **Routes:** `/industries` (IndustriesHub category grid) + `/industries/:slug` (IndustryCategoryPage). No individual-industry routes exist — deepest level is the category page.
- **Icon convention:** IndustriesHub uses an inline `CATEGORY_EMOJI` Record<string, string> lookup — emoji not lucide-react. Megamenu should match this style for consistency.
- **Implication:** the originally-planned "8 industries with icons" needs to be revised to either (a) show the 6 categories directly, or (b) hardcode top 8 individual industries linking to category pages (since direct routes don't exist).
