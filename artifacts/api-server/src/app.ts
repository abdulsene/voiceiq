import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import * as Sentry from "@sentry/node";
import router from "./routes";
import getStripe, { getCurrentPeriodEnd, mapStripeStatus, priceIdToPlan } from "./stripe";
import { createClient } from "@supabase/supabase-js";
import { auditLog, extractRequestMeta } from "./middlewares/audit";
import { widgetScriptHandler } from "./routes/widget";
import activationRouter from "./routes/activation";
import { costlyLimiter } from "./rateLimiter";
import { dispatchVerificationOnStatusFlip } from "./services/verification-email-service";

const app: Express = express();

app.set("trust proxy", 1);

app.use((req: Request, _res: Response, next: NextFunction) => {
  (req as any).id = uuidv4();
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://api.stripe.com", "https://api.elevenlabs.io", "https://neverr.ai", "https://app.neverr.ai"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

app.use((_req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Powered-By", "Neverr");
  next();
});

const isProduction = process.env.NODE_ENV === "production";

const allowedOrigins = [
  "https://neverr.ai",
  "https://www.neverr.ai",
  "https://app.neverr.ai",
];

if (!isProduction) {
  allowedOrigins.push("http://localhost:3000");
  allowedOrigins.push("http://localhost:5173");
}

const envOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      if (envOrigins.length > 0 && envOrigins.includes(origin)) return callback(null, true);
      if (!isProduction) {
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
        if (/\.replit\.(app|dev)$/.test(origin)) return callback(null, true);
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
});

// Sprint 1 BUG-17 sub-step 3f: costlyLimiter moved to ../rateLimiter so
// per-route handlers in routes/api.ts can apply it directly (e.g. /onboard).
// Single shared instance — see ../rateLimiter for the definition.

app.use("/api", generalLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", authLimiter);
// Both unauthenticated and either hit Supabase Auth's recovery endpoint
// (forgot-password → resetPasswordForEmail; spammable) or update a
// password from a token alone (reset-password; brute-forceable on
// access_token if an attacker is also probing). authLimiter throttles
// both surfaces under the same 10-req/15-min/IP envelope as login.
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
// Support-intake form for users who forgot which email they signed up
// with. Throttled because (a) it fans out to Resend on every submission
// and (b) the form is otherwise an anonymous spam vector.
app.use("/api/auth/help-recover-account", authLimiter);
// /api/leads/capture is anonymous (Bearer-secret only) and triggers a
// DB insert + audit log per call. Throttle to the same 10/15min/IP
// envelope as the other public anon endpoints — defends against a
// leaked-secret spam scenario without throttling legitimate AI
// conversations (one capture per conversation = nowhere near the limit).
app.use("/api/leads/capture", authLimiter);
// Activation is unauthenticated and creates a Supabase Auth user — apply
// the strict authLimiter to throttle brute-force on invite tokens and DoS
// on the upstream auth provider.
app.use("/api/admin/users/activate", authLimiter);
app.use("/api/admin/team/activate", authLimiter);

app.use("/api/call/outbound", costlyLimiter);
app.use("/api/call/missed", costlyLimiter);
app.use("/api/sms/test", costlyLimiter);
app.use("/api/sms/campaign", costlyLimiter);

const AUTH_BYPASS_PATTERNS = [
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
  // Slice 2A: Twilio-facing webhooks for the lead-bridge flow. Each
  // verifies X-Twilio-Signature inside the handler. The disclosure
  // audio endpoint is public-by-design (Twilio's <Play> fetches it
  // without signing); rate-limited via generalLimiter.
  /^\/api\/twilio\/voice\/lead-bridge$/,
  /^\/api\/twilio\/recording-status$/,
  /^\/api\/twilio\/call-status$/,
  /^\/api\/business\/disclosure-audio\/[^/]+\/(staff|customer)$/,
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

async function gatewayAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.path.startsWith("/api")) return next();

  for (const pattern of AUTH_BYPASS_PATTERNS) {
    if (pattern.test(req.path)) return next();
  }

  const apiKey = req.headers["x-api-key"] as string | undefined;
  const neverrKey = process.env.VOICEIQ_API_KEY;
  if (apiKey && neverrKey && apiKey === neverrKey) return next();

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (token.length > 20) {
      try {
        const url = process.env.SUPABASE_URL;
        const key = process.env.SUPABASE_SERVICE_KEY;
        if (url && key) {
          const supabase = createClient(url, key, { auth: { persistSession: false } });
          const { data: { user }, error } = await supabase.auth.getUser(token);
          if (!error && user) {
            (req as any).userId = user.id;
            (req as any).userEmail = user.email;
            return next();
          }
        }
      } catch {}
    }
  }

  const meta = extractRequestMeta(req);
  auditLog({
    action: "auth.rejected",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: false,
    details: { path: req.path, method: req.method },
  });

  res.status(401).json({ error: "Authentication required" });
}

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  const sig = req.headers["stripe-signature"] as string;
  if (!sig) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  try {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
    const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    const supabase = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;

    console.log("[Stripe Webhook] event:", event.type, event.id);

    // Sprint 1 BUG-17 sub-step 3c-extended-4 (H3 fix): event-id idempotency
    // ledger. Insert one row into processed_webhook_events keyed by
    // event.id BEFORE running any case-branch logic. Postgres unique-violation
    // (SQLSTATE 23505) on the PK is the "we already processed this event"
    // signal — return 200 with a replay flag and skip handler work.
    //
    // Complementary to (NOT replacing) the status-based idempotency in
    // checkout.session.completed (added in 3c). Status-based catches
    // "same effect, different event id" retries; H3 catches "exact same
    // event id" replays (Stripe retry on a 5xx, mid-handler crash, etc).
    //
    // Fail-open behavior: if the idempotency table is unreachable (network
    // blip, missing table, RLS misconfiguration), we log to Sentry and
    // proceed with the handler. We'd rather risk a duplicate write —
    // which the per-handler idempotency from 3c will catch in most cases —
    // than drop an event entirely and leave a row stuck.
    if (supabase) {
      try {
        const { error: idemErr } = await (supabase as any)
          .from("processed_webhook_events")
          .insert({
            stripe_event_id: event.id,
            event_type: event.type,
          });
        if (idemErr) {
          if ((idemErr as any).code === "23505") {
            // Replay detected — already processed this exact event.id.
            const replayPayload = {
              event: "webhook_replay_short_circuit",
              stripe_event_id: event.id,
              stripe_event_type: event.type,
            };
            console.log(
              "[Stripe Webhook][REPLAY]",
              JSON.stringify(replayPayload),
            );
            try {
              Sentry.addBreadcrumb({
                category: "stripe.webhook",
                level: "info",
                message: "replay_short_circuit",
                data: replayPayload,
              });
            } catch {}
            res.status(200).json({ received: true, replay: true });
            return;
          }
          // Some other DB error — log and fall through to handler.
          console.warn(
            "[Stripe Webhook][IDEMPOTENCY_INSERT_FAILED]",
            JSON.stringify({
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              code: (idemErr as any).code || null,
              message: idemErr.message,
            }),
          );
          Sentry.captureMessage("webhook_idempotency_insert_failed", {
            level: "error",
            extra: {
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              code: (idemErr as any).code || null,
              error: idemErr.message,
            },
          });
        }
      } catch (e: any) {
        // Catch-all: Supabase client throwing (network, auth, etc.).
        console.warn(
          "[Stripe Webhook][IDEMPOTENCY_CHECK_THREW]",
          JSON.stringify({
            stripe_event_id: event.id,
            stripe_event_type: event.type,
            error: String(e?.message || e),
          }),
        );
        Sentry.captureMessage("webhook_idempotency_check_threw", {
          level: "error",
          extra: {
            stripe_event_id: event.id,
            stripe_event_type: event.type,
            error: String(e?.message || e),
          },
        });
      }
    }

    switch (event.type) {
      case "checkout.session.completed": {
        // Sprint 1 BUG-17 sub-step 3c: full rewrite. Closes three real bugs:
        //   1. business-id was previously read from metadata only — sessions
        //      that only carry client_reference_id (the canonical post-3b
        //      shape) silently no-op'd the webhook, leaving the row stuck
        //      at pending_payment forever.
        //   2. status was hardcoded to 'active' regardless of trial state.
        //      Every new signup has trial_period_days=7, so the row should
        //      land in 'trialing', not 'active'. Hardcoding 'active' meant
        //      tier gates (e.g. trial-only banners, agent provisioning gate)
        //      could never see the trial state.
        //   3. trial_ends_at was never written by code — UI showed "no trial"
        //      even when the user was in one.
        // Plus pragmatic launch-day idempotency: if the row is already in a
        // good state ('trialing'/'active') and we get a replay, no-op cleanly
        // instead of clobbering fields that may have moved on.
        const session = event.data.object as any;
        const md = session.metadata || {};

        // 1. Business-id resolution priority: client_reference_id
        //    (canonical, set by createCheckoutSessionForBusiness) →
        //    metadata.business_id || metadata.businessId (legacy/external).
        const clientRef = session.client_reference_id as string | null | undefined;
        const businessId: string | undefined =
          (clientRef && String(clientRef)) ||
          md.business_id ||
          md.businessId;
        const businessIdSource = clientRef
          ? "client_reference_id"
          : (md.business_id || md.businessId)
          ? "metadata"
          : "none";

        if (!businessId) {
          // No business resolvable — log AND return 200 so Stripe doesn't
          // retry an event we can never process. This is a code/integration
          // bug somewhere upstream; pages on it via Sentry error level.
          const payload = {
            event: "webhook_no_business_id",
            stripe_event_id: event.id,
            stripe_event_type: event.type,
            session_id: session.id,
            metadata_keys: Object.keys(md),
            has_client_reference_id: clientRef != null,
          };
          console.error("[Stripe Webhook][NO_BUSINESS_ID]", JSON.stringify(payload));
          Sentry.captureMessage("webhook_no_business_id", { level: "error", extra: payload });
          break;
        }

        if (!supabase) {
          console.error("[Stripe Webhook] DB unavailable for", event.id, "skipping update");
          break;
        }

        // 2. Idempotency check (status-based — pragmatic launch-day
        //    equivalent of a proper event-id ledger; see post-launch
        //    tech-debt item). If the row is already 'trialing'/'active',
        //    a replay must NOT clobber fields that may have moved on
        //    (e.g. period_end advanced via subscription.updated). past_due
        //    is intentionally NOT protected so a customer fixing their
        //    card can recover.
        const { data: existing } = await supabase
          .from("business_configs")
          .select("subscription_status")
          .eq("business_id", businessId)
          .maybeSingle();
        const currentStatus = existing?.subscription_status || null;

        if (currentStatus === "trialing" || currentStatus === "active") {
          const replayPayload = {
            event: "webhook_replay_noop",
            business_id: businessId,
            current_status: currentStatus,
            stripe_event_id: event.id,
            stripe_event_type: event.type,
            business_id_source: businessIdSource,
          };
          console.log("[Stripe Webhook][REPLAY_NOOP]", JSON.stringify(replayPayload));
          Sentry.addBreadcrumb({
            category: "billing",
            level: "info",
            message: "webhook_replay_noop",
            data: replayPayload,
          });
          break;
        }

        // 3. Retrieve subscription to derive verbatim status + trial_end +
        //    current_period_end. Status hardcoding ('active') was the real
        //    BUG-17 disease here — every new self-serve signup is in TRIAL
        //    at this moment, not active.
        const planId = md.plan || md.planId;
        const billingCycle = md.billing_cycle || md.billingCycle;
        const subscriptionId = session.subscription as string | null;
        const customerId = session.customer as string | null;

        let stripeStatus: string | null = null;
        let currentPeriodEnd: string | null = null;
        let trialEndsAt: string | null = null;

        if (subscriptionId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            stripeStatus = (sub as any).status || null;
            // Sprint 1 BUG-17 sub-step 3c-extended-2: read current_period_end
            // through the helper so we work under both pre-2025-10-29 (top-level)
            // and 2025-10-29.clover+ (items[0]) Stripe API versions.
            const cpe = getCurrentPeriodEnd(sub);
            if (cpe != null) currentPeriodEnd = new Date(cpe * 1000).toISOString();
            const tEnd = (sub as any).trial_end;
            if (tEnd) trialEndsAt = new Date(tEnd * 1000).toISOString();
          } catch (e: any) {
            console.error("[Stripe Webhook] retrieve sub failed:", e.message);
            Sentry.captureMessage("webhook_subscription_retrieve_failed", {
              level: "warning",
              extra: {
                event: "webhook_subscription_retrieve_failed",
                business_id: businessId,
                stripe_event_id: event.id,
                subscription_id: subscriptionId,
                error: e?.message || String(e),
              },
            });
          }
        }

        // Sprint 1 BUG-17 sub-step 3c-extended-3 (X7 fix): map Stripe
        // sub-status to our column via the shared mapStripeStatus helper.
        // The same helper is used by customer.subscription.created/updated
        // so spelling normalization ('canceled' → 'cancelled') is now
        // consistent across every handler that writes subscription_status.
        // Unexpected states get a Sentry warning at the call site (so we
        // can include event id + business id + subscription id context),
        // but the verbatim value is still written so the row reflects
        // reality.
        const mapped = mapStripeStatus(stripeStatus);
        const mappedStatus = mapped.status;
        if (mapped.isUnexpected) {
          const warnPayload = {
            event: "webhook_unexpected_subscription_status",
            business_id: businessId,
            stripe_status: stripeStatus,
            stripe_event_id: event.id,
            subscription_id: subscriptionId,
          };
          console.warn(
            "[Stripe Webhook][UNEXPECTED_STATUS]",
            JSON.stringify(warnPayload),
          );
          Sentry.captureMessage(
            `webhook_unexpected_subscription_status: ${stripeStatus}`,
            { level: "warning", extra: warnPayload },
          );
        }

        const update: Record<string, any> = {
          subscription_status: mappedStatus,
          plan_id: planId || "essential",
          billing_cycle: billingCycle || "monthly",
          updated_at: new Date().toISOString(),
        };
        if (subscriptionId) update.stripe_subscription_id = subscriptionId;
        if (customerId) update.stripe_customer_id = customerId;
        if (currentPeriodEnd) update.current_period_end = currentPeriodEnd;
        // trial_ends_at: write only when we have a non-null value. Leave
        // unchanged when null (defensive — prevents a post-trial replay
        // from accidentally nulling a previously-written trial_ends_at).
        if (trialEndsAt) update.trial_ends_at = trialEndsAt;

        const { error } = await supabase
          .from("business_configs")
          .update(update)
          .eq("business_id", businessId);
        if (error) {
          console.error("[Stripe Webhook] checkout update failed:", error.message);
          Sentry.captureMessage("webhook_checkout_update_failed", {
            level: "error",
            extra: {
              event: "webhook_checkout_update_failed",
              business_id: businessId,
              stripe_event_id: event.id,
              error: error.message,
            },
          });
        } else {
          console.log(
            "[Stripe Webhook] checkout.session.completed:",
            JSON.stringify({
              business_id: businessId,
              business_id_source: businessIdSource,
              plan_id: update.plan_id,
              billing_cycle: update.billing_cycle,
              status: mappedStatus,
              stripe_status: stripeStatus,
              trial_ends_at: trialEndsAt,
              current_period_end: currentPeriodEnd,
              stripe_event_id: event.id,
            }),
          );

          // Sprint 2 STEP 4 / BUG-18: fire the email-verification token +
          // Resend send AT the genuine pending_payment → trialing/active
          // transition. The shared helper guards on:
          //   * mappedStatus IN (trialing, active)
          //   * currentStatus (read at line 392 above) === pending_payment
          //     OR null (legacy)
          //   * email not already verified
          // These guards are also the reason we can safely call this
          // helper from BOTH the checkout.session.completed handler
          // (here) AND the customer.subscription.created/updated handler
          // (below) without spamming duplicate emails — whichever event
          // arrives first does the flip + send, the second event sees
          // currentStatus already === trialing/active and short-circuits
          // inside the helper.
          //
          // We deliberately do NOT call this from /signup because /signup
          // ALWAYS sets pending_payment, and the BUG-18 DO-NOT list bans
          // verification emails to pending_payment users (Resend
          // reputation / spam-flag risk).
          //
          // Errors swallowed at this layer per webhook durability
          // requirements — Stripe re-delivery would land on a row whose
          // status is now trialing/active and hit the replay-noop branch,
          // never re-firing the email. Logging + Sentry suffices.
          try {
            await dispatchVerificationOnStatusFlip(supabase, {
              businessId,
              newStatus: mappedStatus,
              previousStatus: currentStatus,
              stripeEventId: event.id,
              source: "checkout.session.completed",
            });
          } catch (e: any) {
            console.error("[Stripe Webhook] Verification email dispatch failed:", e?.message ?? String(e));
            Sentry.captureException(e, {
              extra: {
                event: "verification_email_dispatch_failed",
                source: "checkout.session.completed",
                business_id: businessId,
                stripe_event_id: event.id,
              },
            });
          }
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object as any;
        if (supabase) {
          const businessIdMeta = sub.metadata?.business_id || sub.metadata?.businessId;

          // Sprint 1 BUG-17 sub-step 3c-extended-3 (X7 fix): map Stripe
          // status through the shared helper so 'canceled' → 'cancelled'
          // (two L's) writes consistently here too, matching
          // checkout.session.completed and subscription.deleted. Without
          // this, a Stripe Customer Portal cancellation that fires
          // subscription.updated would write the one-L 'canceled' while
          // subscription.deleted writes the two-L 'cancelled' — same
          // logical state, two spellings, downstream filters miss rows.
          const mapped = mapStripeStatus(sub.status);
          if (mapped.isUnexpected) {
            const warnPayload = {
              event: "webhook_unexpected_subscription_status",
              business_id: businessIdMeta || null,
              stripe_status: sub.status,
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              subscription_id: sub.id,
            };
            console.warn(
              "[Stripe Webhook][UNEXPECTED_STATUS]",
              JSON.stringify(warnPayload),
            );
            Sentry.captureMessage(
              `webhook_unexpected_subscription_status: ${sub.status}`,
              { level: "warning", extra: warnPayload },
            );
          }

          // Sprint 1 BUG-17 sub-step 3c-extended Issue A:
          // Build the update payload CONDITIONALLY so a null value in the
          // Stripe payload never clobbers a value already written by a
          // sibling event (mirrors checkout.session.completed's defensive
          // pattern from 3c). Stripe sends current_period_end=null on trial
          // subscriptions created with payment_behavior:default_incomplete;
          // a naive unconditional write would race with checkout.session.completed
          // and null out the value the checkout handler just wrote.
          // Same defensive treatment for trial_ends_at — only write when present.
          const update: Record<string, any> = {
            subscription_status: mapped.status,
            stripe_subscription_id: sub.id,
            updated_at: new Date().toISOString(),
          };
          // Sprint 1 BUG-17 sub-step 3c-extended-2: read current_period_end
          // through the helper so we work under both pre-2025-10-29 (top-level)
          // and 2025-10-29.clover+ (items[0]) Stripe API versions. Webhook
          // events use the endpoint's pinned API version, which can differ
          // from this api-server's own client version.
          const cpeUnix = getCurrentPeriodEnd(sub);
          if (cpeUnix != null) {
            update.current_period_end = new Date(cpeUnix * 1000).toISOString();
          }
          if (sub.trial_end) {
            update.trial_ends_at = new Date(sub.trial_end * 1000).toISOString();
          }

          // Sprint 1 BUG-17 sub-step 3c-extended-4 (H4 fix): derive plan_id
          // and billing_cycle from the recurring subscription item's price
          // ID and reverse-lookup against PRICE_IDS. This is what reflects
          // a Stripe Customer Portal upgrade/downgrade/cycle-switch in
          // business_configs — the portal only fires customer.subscription.updated
          // (no checkout.session.completed), so without this the dashboard
          // and tier gates would silently keep the OLD plan after a portal
          // change.
          //
          // Interaction with B2 (3c-extended-3): signup INSERT now writes
          // plan_id immediately at /api/auth/signup. The webhook write
          // here is therefore a no-op for the happy path (same plan), and
          // a CORRECT update for a portal-initiated change. Not in conflict.
          //
          // Edge: race where this event arrives before the row exists.
          // In that case the surrounding update().eq("stripe_subscription_id"…)
          // matches zero rows and the metadata.business_id fallback handles it,
          // so the plan_id ends up correctly set on the existing row that
          // signup INSERT already populated.
          const priceId: string | undefined = sub.items?.data?.[0]?.price?.id;
          if (priceId) {
            const planInfo = priceIdToPlan(priceId);
            if (planInfo) {
              update.plan_id = planInfo.planId;
              update.billing_cycle = planInfo.billingCycle;
            } else {
              const unkPayload = {
                event: "webhook_unknown_price_id",
                business_id: businessIdMeta || null,
                price_id: priceId,
                stripe_subscription_id: sub.id,
                stripe_event_id: event.id,
                stripe_event_type: event.type,
              };
              console.warn(
                "[Stripe Webhook][UNKNOWN_PRICE_ID]",
                JSON.stringify(unkPayload),
              );
              Sentry.captureMessage("webhook_unknown_price_id", {
                level: "warning",
                extra: unkPayload,
              });
            }
          }

          // Sprint 2 STEP 4 / BUG-18: capture previous status BEFORE the
          // UPDATE so dispatchVerificationOnStatusFlip can detect the
          // genuine pending_payment → trialing/active transition. We
          // look up by stripe_subscription_id first (matches the UPDATE
          // path below), falling back to businessIdMeta. If neither
          // matches we have nothing to dispatch against anyway.
          let prevSubStatus: string | null | undefined = undefined;
          let prevBusinessId: string | undefined;
          {
            const { data: prevBySub } = await supabase
              .from("business_configs")
              .select("business_id, subscription_status")
              .eq("stripe_subscription_id", sub.id)
              .maybeSingle();
            if (prevBySub) {
              prevSubStatus = prevBySub.subscription_status as string | null;
              prevBusinessId = prevBySub.business_id as string;
            } else if (businessIdMeta) {
              const { data: prevByMeta } = await supabase
                .from("business_configs")
                .select("business_id, subscription_status")
                .eq("business_id", businessIdMeta)
                .maybeSingle();
              if (prevByMeta) {
                prevSubStatus = prevByMeta.subscription_status as string | null;
                prevBusinessId = prevByMeta.business_id as string;
              }
            }
          }

          // Sprint 1 BUG-17 sub-step 3c-extended-3 (B1 fix): match by
          // stripe_subscription_id first; fall back ONLY to metadata.business_id.
          // The previous stripe_customer_id fallback was a cross-tenant data
          // corruption blocker — Pattern 2 (3b-extended) reuses one Stripe
          // customer across multiple business_configs rows, so .update().eq(
          // "stripe_customer_id", sub.customer) would clobber every business
          // owned by the same user with the same subscription's status and
          // stripe_subscription_id. Removed entirely.
          let { data: matched, error: mErr } = await supabase
            .from("business_configs")
            .update(update)
            .eq("stripe_subscription_id", sub.id)
            .select("business_id");

          if ((!matched || matched.length === 0) && businessIdMeta) {
            ({ data: matched, error: mErr } = await supabase
              .from("business_configs")
              .update(update)
              .eq("business_id", businessIdMeta)
              .select("business_id"));
          }

          if (mErr) {
            console.error("[Stripe Webhook] subscription update failed:", mErr.message);
          }
          if (!matched || matched.length === 0) {
            // Neither stripe_subscription_id nor metadata.business_id
            // matched a row. Surface so we can investigate (could be an
            // event for a different environment's subscription, or a
            // legitimate ordering issue we haven't anticipated).
            const noMatchPayload = {
              event: "webhook_subscription_no_match",
              stripe_subscription_id: sub.id,
              stripe_customer_id: sub.customer || null,
              stripe_event_id: event.id,
              stripe_event_type: event.type,
              business_id_meta: businessIdMeta || null,
            };
            console.warn(
              "[Stripe Webhook][SUBSCRIPTION_NO_MATCH]",
              JSON.stringify(noMatchPayload),
            );
            Sentry.captureMessage("webhook_subscription_no_match", {
              level: "warning",
              extra: noMatchPayload,
            });
          }
          console.log(
            "[Stripe Webhook]", event.type, sub.id, "status:", mapped.status,
            "matched:", matched?.length ?? 0,
          );

          // Sprint 2 STEP 4 / BUG-18: also fire verification email here so
          // a `customer.subscription.created/updated` event that flips status
          // BEFORE checkout.session.completed (Stripe doesn't guarantee
          // ordering) still triggers the email exactly once. The helper
          // gates on previousStatus === pending_payment so the second event
          // in the sequence (whichever order they arrive) becomes a no-op.
          //
          // We use prevBusinessId from the pre-UPDATE lookup (above) rather
          // than `matched` because `matched` rows have already had their
          // status overwritten — we need the OLD status for the transition
          // check.
          const targetBizId = prevBusinessId || businessIdMeta;
          if (targetBizId && (matched?.length ?? 0) > 0) {
            try {
              await dispatchVerificationOnStatusFlip(supabase, {
                businessId: targetBizId,
                newStatus: mapped.status,
                previousStatus: prevSubStatus,
                stripeEventId: event.id,
                source: event.type,
              });
            } catch (e: any) {
              console.error("[Stripe Webhook] Verification email dispatch failed:", e?.message ?? String(e));
              Sentry.captureException(e, {
                extra: {
                  event: "verification_email_dispatch_failed",
                  source: event.type,
                  business_id: targetBizId,
                  stripe_event_id: event.id,
                },
              });
            }
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as any;
        if (supabase) {
          await supabase
            .from("business_configs")
            .update({
              subscription_status: "cancelled",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", sub.id);
          console.log("[Stripe Webhook] subscription.deleted:", sub.id);
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as any;
        if (supabase && invoice.subscription) {
          // Sprint 1 BUG-17 sub-step 3c-extended Issue B:
          // Read-then-write guard. Every customer pays a non-zero setup fee
          // on signup day; when that setup-fee invoice clears, a naive
          // "always flip to active" handler would prematurely promote a
          // trialing user to active. Also catches the legitimate past_due
          // recovery case (card was declined, customer fixed it, payment
          // succeeded, flip back to active).
          //
          // Branch on current status:
          //   - trialing:  skip status change, log info — preserves trial
          //   - past_due:  flip to active — legitimate card-recovery path
          //   - active:    no-op — already correct
          //   - cancelled: warn + no-op — anomalous, surface for visibility
          //   - pending_payment: warn + no-op — anomalous, surface
          //   - other:     warn + no-op — surface unknown states
          const { data: rows, error: selErr } = await supabase
            .from("business_configs")
            .select("business_id, subscription_status")
            .eq("stripe_subscription_id", invoice.subscription)
            .limit(1);
          if (selErr) {
            console.error(
              "[Stripe Webhook] invoice.payment_succeeded select failed:",
              selErr.message,
            );
            Sentry.captureMessage("webhook_invoice_paid_select_failed", {
              level: "error",
              extra: {
                event: "webhook_invoice_paid_select_failed",
                stripe_subscription_id: invoice.subscription,
                invoice_id: invoice.id,
                error: selErr.message,
              },
            });
            break;
          }
          const row = rows?.[0];
          if (!row) {
            console.log(
              "[Stripe Webhook] invoice.payment_succeeded: no matching row for",
              invoice.subscription,
            );
            break;
          }
          const current = row.subscription_status;
          const baseLog = {
            business_id: row.business_id,
            invoice_id: invoice.id,
            stripe_subscription_id: invoice.subscription,
            current_status: current,
          };
          if (current === "trialing") {
            const payload = { event: "webhook_invoice_paid_during_trial", ...baseLog };
            Sentry.captureMessage("webhook_invoice_paid_during_trial", {
              level: "info",
              extra: payload,
            });
            console.log(
              "[Stripe Webhook][INVOICE_PAID_DURING_TRIAL]",
              JSON.stringify(payload),
            );
          } else if (current === "past_due") {
            await supabase
              .from("business_configs")
              .update({
                subscription_status: "active",
                updated_at: new Date().toISOString(),
              })
              .eq("stripe_subscription_id", invoice.subscription);
            console.log(
              "[Stripe Webhook] invoice.payment_succeeded:",
              invoice.subscription,
              "past_due → active",
            );
          } else if (current === "active") {
            console.log(
              "[Stripe Webhook] invoice.payment_succeeded:",
              invoice.subscription,
              "already active, no-op",
            );
          } else {
            const payload = { event: "webhook_invoice_paid_unexpected_state", ...baseLog };
            Sentry.captureMessage("webhook_invoice_paid_unexpected_state", {
              level: "warning",
              extra: payload,
            });
            console.warn(
              "[Stripe Webhook][INVOICE_PAID_UNEXPECTED_STATE]",
              JSON.stringify(payload),
            );
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as any;
        if (supabase) {
          // Sprint 1 BUG-17 sub-step 3c-extended-3 (B1 fix): match ONLY by
          // stripe_subscription_id. The previous stripe_customer_id
          // fallback was a cross-tenant data corruption blocker — Pattern 2
          // reuses one Stripe customer across multiple business_configs
          // rows, so a .eq("stripe_customer_id", ...) update would mark
          // EVERY business owned by the same user as past_due even though
          // only one of their subscriptions actually failed.
          if (invoice.subscription) {
            const { data: matched } = await supabase
              .from("business_configs")
              .update({
                subscription_status: "past_due",
                updated_at: new Date().toISOString(),
              })
              .eq("stripe_subscription_id", invoice.subscription)
              .select("business_id");
            if (!matched || matched.length === 0) {
              const noMatchPayload = {
                event: "webhook_subscription_no_match",
                stripe_subscription_id: invoice.subscription,
                stripe_customer_id: invoice.customer || null,
                stripe_event_id: event.id,
                stripe_event_type: event.type,
                invoice_id: invoice.id,
              };
              console.warn(
                "[Stripe Webhook][SUBSCRIPTION_NO_MATCH]",
                JSON.stringify(noMatchPayload),
              );
              Sentry.captureMessage("webhook_subscription_no_match", {
                level: "warning",
                extra: noMatchPayload,
              });
            }
          } else {
            // No subscription on the invoice (e.g. one-time invoice
            // outside any subscription). Nothing to mark past_due — log
            // for visibility.
            console.warn(
              "[Stripe Webhook] invoice.payment_failed without subscription, no-op:",
              invoice.id,
              "customer:", invoice.customer || null,
            );
          }
          console.log(
            "[Stripe Webhook] invoice.payment_failed:",
            invoice.subscription || `(no-sub) inv=${invoice.id}`,
          );
        }
        break;
      }
    }

    res.json({ received: true, type: event.type });
  } catch (err: any) {
    console.error("[Stripe Webhook] Error:", err.message);
    res.status(400).json({ error: "Webhook signature verification failed" });
  }
});

app.use(express.json({
  limit: "10mb",
}));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use((_req, res, next) => {
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Keep-Alive", "timeout=30");
  next();
});

app.use(gatewayAuth);


// Phase 3d: production proxy only routes /api/* to the backend, so the
// widget script must live under /api. Keep the legacy /widget.js path
// registered for any embed snippets that still reference the old URL.
app.get("/api/widget.js", widgetScriptHandler);
app.get("/widget.js", widgetScriptHandler);

// Public activation page (mounted before the SPA/router so it owns /activate).
// gatewayAuth only intercepts /api/* paths, so this is naturally public.
app.use("/", activationRouter);

app.use("/api", router);

// Sentry Express error handler — registered AFTER all routes, BEFORE other
// error handlers so it captures every unhandled route error.
if (process.env.SENTRY_API_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Page not found. Go to neverr.ai" });
});

app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  console.error("[Server Error]", err.stack || err.message);

  if (isProduction) {
    res.status(err.status || 500).json({
      error: "An unexpected error occurred",
      requestId: (req as any).id,
    });
  } else {
    res.status(err.status || 500).json({
      error: err.message || "Something went wrong",
      requestId: (req as any).id,
    });
  }
});

export default app;
