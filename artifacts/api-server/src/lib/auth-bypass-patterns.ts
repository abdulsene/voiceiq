/**
 * AUTH_BYPASS_PATTERNS — the list of URL prefixes that skip
 * gatewayAuth in app.ts. Extracted from app.ts in Phase 6.8 so the
 * webhook-audit smoke test can import it without triggering app.ts's
 * boot side-effects (Sentry init, DB pools, express.listen).
 *
 * Any Twilio-facing or ElevenLabs-tool webhook needs an entry here or
 * gatewayAuth returns 401 BEFORE the handler runs — the handler's
 * internal signature/token check never gets a chance. That failure
 * mode has bitten us twice (Phase 6.4's two callbacks) and produces
 * silent data loss because Twilio treats 401 as a webhook failure
 * (in some cases audibly, in others as a retry-then-give-up).
 *
 * See src/lib/webhook-audit.ts + the boot-time assertion in app.ts
 * for the guard that prevents recurrence.
 */

export const AUTH_BYPASS_PATTERNS: readonly RegExp[] = [
  /^\/api\/(health(z)?|livez)$/,
  /\/webhook/,
  /\/billing\/webhook/,
  /^\/api\/lead$/,
  /^\/api\/contact$/,
  /^\/api\/onboard$/,
  /^\/api\/onboard\/scrape-website$/,
  /^\/api\/onboard\/industries$/,
  /^\/api\/onboard\/template\//,
  // Phase 3d: public "Try Your Agent" preview generator
  /^\/api\/preview\//,
  // Phase 3d: widget loader script must be publicly fetchable by anonymous
  // browsers visiting embed sites (and the /try-your-agent demo).
  /^\/api\/widget\.js$/,
  // Sprint 2 STEP 4 / BUG-18: /auth/verify-email is public — the token
  // in the request body IS the credential. /auth/resend-verification is
  // NOT public (requireAuth — must be a logged-in user requesting a
  // resend for their own account).
  /^\/api\/auth\/(login|signup|refresh|verify-email|forgot-password|reset-password|help-recover-account)$/,
  // Leads epic Slice 1: /api/leads/capture is the request_callback tool
  // endpoint ElevenLabs's agent POSTs to mid-conversation. The token in
  // the Authorization header (ELEVENLABS_TOOL_SECRET) IS the credential.
  /^\/api\/leads\/capture$/,
  // Phase 2.2.5: /api/leads/record-appointment is the record_appointment
  // tool endpoint. Same Bearer-token auth via ELEVENLABS_TOOL_SECRET.
  /^\/api\/leads\/record-appointment$/,
  // Phase 3.2a: /api/routing/route-to-topic is the route_to_topic tool
  // endpoint (registered on the agent in Phase 3.2b). Same Bearer-token
  // auth via ELEVENLABS_TOOL_SECRET as the other tool endpoints.
  /^\/api\/routing\/route-to-topic$/,
  // Phase 3.2a: /api/routing/whisper is the staff-side whisper TwiML.
  // Called by Twilio infra when a rung staff cell answers — no auth
  // needed (the query text is public; Twilio is a trusted caller by
  // network topology).
  /^\/api\/routing\/whisper$/,
  // Phase 3.2a: /api/routing/dial-status is the Twilio Dial action
  // callback. Signature verification happens inside the handler.
  /^\/api\/routing\/dial-status$/,
  // Phase 6.8 (backfill of Phase 6.4 miss): Twilio hits these two on
  // the no-answer voicemail-capture flow. Both do internal
  // X-Twilio-Signature verification + always-200 discipline per Phase
  // 3.4. Without these entries, gatewayAuth returns 401 BEFORE the
  // handler runs — captured voicemails are silently lost. Six live
  // occurrences 2026-08-15 15:07-15:40 EDT before this landed.
  /^\/api\/routing\/dial-fallback-record-done$/,
  /^\/api\/routing\/dial-fallback-transcript$/,
  // Phase 5.1: /api/routing/opt-out is the record_opt_out
  // ElevenLabs tool endpoint (registered unconditionally on every
  // agent). Bearer-authed via ELEVENLABS_TOOL_SECRET — same
  // discipline as route_to_topic. Bypass listed here because the
  // tool has no JWT, only the shared bearer token.
  /^\/api\/routing\/opt-out$/,
  // Phase 3.3: /api/voice/outbound is the TwiML App webhook Twilio hits
  // when the browser Device places an outbound call. Signature verified
  // inside the handler. /api/voice/token and /api/voice/heartbeat are
  // requireAuth-guarded and NOT bypass-listed.
  /^\/api\/voice\/outbound$/,
  // Phase 3.8: /api/voice/outbound-status is the <Dial action> callback
  // Twilio POSTs when a softphone-initiated outbound call terminates.
  // Signature verified inside the handler + 200-always discipline
  // (Phase 3.4) so an internal auth failure never becomes a
  // customer-audible error.
  /^\/api\/voice\/outbound-status$/,
  // Phase 3.10 /api/voice/amd-status entry REMOVED in Phase 3.12.
  // See phase 3.11 research report + phase 3.12 header: AMD via
  // <Dial><Number> silently no-ops when the parent is a Client-
  // initiated call, and even when it worked it couldn't answer
  // Abdul's actual reporting question ("voicemail: message left vs
  // not"). Replaced by staff disposition on hangup at
  // PATCH /api/voice/calls/:id/disposition (requireAuth, NOT
  // bypass-listed — it's a customer action, not a Twilio webhook).
  // Slice 3A pillar 3: customer trust portal. GET /api/public/lead/:token
  // and POST /api/public/lead/:token/action. Token IS the credential
  // (HS256-signed by lib/trust-portal-token.ts). Tight regex so future
  // /api/public/* routes don't inherit no-auth.
  /^\/api\/public\/lead\/[^/]+(\/action)?$/,
  // Slice 2A: Twilio-facing webhooks for the lead-bridge flow. Each
  // verifies X-Twilio-Signature inside the handler. The disclosure
  // audio endpoint is public-by-design (Twilio's <Play> fetches it
  // without signing); rate-limited via generalLimiter.
  /^\/api\/twilio\/voice\/lead-bridge$/,
  /^\/api\/twilio\/recording-status$/,
  /^\/api\/twilio\/call-status$/,
  // Phase 0 Commit 0-D: outbound voice TwiML, AMD, status webhooks.
  // Phase 1.6: added /voicemail for the AMD-machine redirect target.
  // Tight entries match Slice 2A precedent (documenting intent even
  // though the catch-all /^\/api\/twilio\// below would cover these).
  // Each handler verifies X-Twilio-Signature internally.
  /^\/api\/twilio\/outbound-voice\/twiml$/,
  /^\/api\/twilio\/outbound-voice\/amd$/,
  /^\/api\/twilio\/outbound-voice\/status$/,
  /^\/api\/twilio\/outbound-voice\/voicemail$/,
  /^\/api\/business\/disclosure-audio\/[^/]+\/(staff|customer)$/,
  // Phase 4.2 — disclosure-audio whisper wrapper. Twilio's <Number url>
  // fetches this for TwiML when the callee answers, before bridging.
  // Fixes the Phase 3.6 audit bug where <Number url> pointed at the
  // raw audio endpoint (GET-only, returned audio/mpeg not TwiML).
  /^\/api\/business\/disclosure-audio\/[^/]+\/(staff|customer)\/whisper$/,
  /^\/api\/auth\/google/,
  /^\/api\/auth\/microsoft/,
  /^\/api\/twilio\//,
  /^\/api\/internal\//,
  /^\/api\/sms\/compliance$/,
  /^\/api\/demo/,
  // Public industry catalogue: powers landing pages and the on-site demo
  // generator — no tenant data involved.
  /^\/api\/industries(\/|$)/,
  /^\/api\/widget\/config$/,
  /^\/api\/widget\/event$/,
  /^\/api\/test\/email$/,
  /^\/api\/test\/stripe$/,
  // Invitation activation: invitee has no auth yet — the invite token in
  // the request body IS the credential. The route itself does constant-time
  // token comparison + expiry check before minting the Supabase auth user.
  /^\/api\/admin\/users\/activate$/,
  /^\/api\/admin\/team\/activate$/,
  // Phase 3.17 — first-class business invites. Two public routes:
  //   GET  /api/invites/lookup/:token → side-effect free lookup for
  //        the /invite/:token SPA page. A scanner GET can hit this
  //        as many times as it likes; no DB mutation.
  //   POST /api/invites/accept → the mutation. Creates the Supabase
  //        auth user + user_businesses row atomically. Body carries
  //        { token, password, full_name? } — the token IS the credential.
  // See routes/team.ts Phase 3.17 header for the full flow rationale
  // (Microsoft Defender Safe Links prefetch broke the old Supabase
  // magic-link flow on corporate M365 domains).
  /^\/api\/invites\/lookup\/[^/]+$/,
  /^\/api\/invites\/accept$/,
  // Phase 3f: public SMS opt-in pages — businesses share these URLs with
  // their customers to capture Twilio-compliant consent. Submission is
  // IP rate-limited (5/hr/biz) inside the route itself. Tight regex (only
  // GET /optin/:id and POST /optin/:id/submit) so any future /api/optin/*
  // admin or analytics route doesn't accidentally inherit no-auth.
  /^\/api\/optin\/[^/]+(\/submit)?$/,
  // Phase 3j: public marketing-list opt-in submission. IP rate-limited
  // (5/hr) inside the route. Tight regex so no other /api/marketing/*
  // route inherits no-auth.
  /^\/api\/marketing\/subscribe$/,
  // Hidden Sentry test endpoint — gated by x-sentry-test-token header in production
  /^\/api\/_sentry-test$/,
  // Sprint 5 WorkOS Phase 3: SSO login flow entrypoints. Both are
  // pre-login by definition (the user has no Supabase session yet —
  // that's the whole point of these endpoints).
  //   - /api/sso/init: kicks off the IdP redirect; CSRF-protected by
  //     the HMAC-signed `state` token verified at /callback.
  //   - /api/sso/callback: IdP returns here. Auth is established by
  //     the WorkOS code exchange + state-signature check inside the
  //     handler, NOT by gatewayAuth.
  // /api/sso/connection* (admin link/unlink) is INTENTIONALLY NOT
  // listed — those endpoints must remain gated through gatewayAuth
  // and their own requireAuth + requireStaffOrBootstrap middleware.
  /^\/api\/sso\/(init|callback)$/,
  // Sprint 5 WorkOS Phase 4: /api/sso/lookup is the public email →
  // connection lookup the /signup page hits before redirecting to
  // /api/sso/init. The handler returns a unified 404 for malformed
  // emails / public-mail domains / no-match so it can't be used to
  // enumerate which org owns which domain.
  // /api/sso/tenant-connection is INTENTIONALLY NOT bypassed — it
  // requires requireAuth + req.isAdmin (tenant admin/owner).
  /^\/api\/sso\/lookup$/,
  // Sprint 5 Alex Phase 1: public AI chat. All four endpoints
  // (POST /conversation, POST /conversation/:id/message, GET
  // /conversation/:id, DELETE /conversation/:id) are anonymous-by-
  // default — identity is the HttpOnly `neverr_visitor_id` cookie set
  // by the conversation-create handler, ownership is enforced inside
  // the route by matching that cookie against chat_conversations.visitor_id.
  /^\/api\/chat\//,
  // 2026-05-03 Calendly env-var swap: GET /api/config exposes the
  // runtime discovery_call_url + api-server version. No tenant data,
  // no secrets — safe to serve anonymously. 60s in-memory cache lives
  // in the route handler.
  /^\/api\/config$/,
];
