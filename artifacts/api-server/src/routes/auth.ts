import { Router, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import * as Sentry from "@sentry/node";
import { requireAuth } from "../middlewares/auth";
import { createAgentForBusiness } from "../agents";
import { sendSMS } from "../sms";
import { auditLog, extractRequestMeta } from "../middlewares/audit";
import { validate, authLoginSchema, authSignupSchema, authForgotPasswordSchema, authResetPasswordSchema } from "../middlewares/validate";
import { OBJECTION_TEMPLATES } from "../objectionTemplates";
import { buildSystemPrompt, fetchIndustryTemplate, fetchObjectionHandlers } from "./api";
import { scrapeWebsite, type ScrapedData } from "../scraping";
import { issueAndSendVerification } from "../services/verification-email-service";
import { renderFirstMessage } from "../lib/first-message-renderer";
import {
  provisionTwilioNumberForBusiness,
  TwilioProvisioningError,
} from "../lib/twilio-provisioning";
import { extractAreaCodeFromPhoneNumber } from "../lib/phone-utils";

// Sprint 2 STEP 4 / BUG-18 Part 5: per-user resend rate limit. Simple
// in-memory map of userId -> last-sent epoch ms. Lost on process restart
// (acceptable — the failure mode is "user can resend once more" which is
// strictly less harmful than persisting and accidentally locking users
// out across deploys). Brief specifies max 1 resend per 60 seconds per
// user.
const RESEND_COOLDOWN_MS = 60_000;
const lastResendByUser = new Map<string, number>();

// Sub-step 3d gate: only customers whose subscription is active (or in
// reasonable transit states) may complete onboarding and provision a
// real ElevenLabs agent on the shared Twilio number. Anything outside
// this set — pending_payment, cancelled, paused, incomplete*, null —
// returns 403 with error code `subscription_required`.
//
// 'past_due' is intentionally allowed: a customer whose card declined
// recently is still a real paying customer; renewal failure is handled
// separately. Locking onboarding for past_due would punish the wrong user.
const ONBOARDING_ALLOWED_STATUSES = ["trialing", "active", "past_due"] as const;

const contactPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const router = Router();

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

router.post("/auth/signup", validate(authSignupSchema), async (req: Request, res: Response) => {
  const { email, password, business_name, industry, phone_number, timezone, sms_opt_in } = req.body;
  // Twilio 10DLC compliance: capture the two separate consent flags. Both
  // are voluntary — neither blocks signup. We persist them to audit_logs as
  // an immutable, timestamped record for Twilio audits.
  const smsConsentTransactional = req.body?.sms_consent_transactional === true;
  const smsConsentMarketing = req.body?.sms_consent_marketing === true;
  // Sprint 1 BUG-17 sub-step 3b: read the optional plan selection. The
  // schema (validate.ts) already constrains these to one of the 6
  // self-serve plans + monthly|annual; we default here when the client
  // didn't send anything (matches the locked "essential / monthly"
  // default for the no-param signup entry path). The chosen plan is NOT
  // written to business_configs in this step — the webhook (sub-step 3c)
  // will write the canonical plan_id when checkout completes. We just
  // echo it back so the frontend can mint a Checkout session in one hop.
  const planId: string = (req.body?.plan_id as string) || "essential";
  const billingCycle: string = (req.body?.billing_cycle as string) || "monthly";
  if (!business_name) {
    res.status(400).json({ error: "business_name is required" });
    return;
  }
  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);
  try {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authError || !authData.user) {
      await auditLog({
        action: "auth.signup.failed",
        ...meta,
        success: false,
        details: { email, reason: authError?.message },
      });
      res.status(400).json({ error: authError?.message || "Failed to create user" });
      return;
    }
    const userId = authData.user.id;
    const businessId = "biz_" + Date.now() + "_" + Math.random().toString(36).substring(2, 8);
    const configInsert: any = {
      business_id: businessId,
      business_name,
      industry: industry || "general",
      phone_number: phone_number || "",
      email,
      timezone: timezone || "America/New_York",
      business_hours: "Monday-Friday 9AM-5PM",
      status: "active",
      // Sprint 1 BUG-17 sub-step 3b: every new business starts in
      // "pending_payment" until the Stripe webhook (sub-step 3c) flips
      // it to "trialing" on checkout.session.completed. The legacy
      // `status` column above is the active/demo flag — separate
      // concern, intentionally untouched.
      subscription_status: "pending_payment",
      // Sprint 1 BUG-17 sub-step 3c-extended-3 (B2 fix): persist plan_id
      // and billing_cycle at INSERT time so they're correct from the
      // moment the row exists. Removes the out-of-order race where
      // customer.subscription.created arrives before checkout.session.completed
      // and flips the row to "trialing" with no plan_id ever written.
      // The webhook is now a status-flipper, not a plan-setter — if
      // checkout writes the same plan_id again later it's an idempotent
      // no-op write (same value).
      plan_id: planId,
      billing_cycle: billingCycle,
      created_at: new Date().toISOString(),
    };
    if (sms_opt_in) {
      configInsert.sms_opt_in = true;
      configInsert.sms_opt_in_timestamp = new Date().toISOString();
      configInsert.sms_opt_in_ip = req.ip || req.headers["x-forwarded-for"] || "";
    }
    await supabase.from("business_configs").insert(configInsert);
    await supabase.from("user_businesses").insert({
      user_id: userId,
      business_id: businessId,
      role: "owner",
      created_at: new Date().toISOString(),
    });

    await auditLog({
      userId,
      businessId,
      action: "auth.signup.success",
      ...meta,
      details: { email, plan_id: planId, billing_cycle: billingCycle },
    });

    // Twilio 10DLC compliance: record the user's SMS consent decisions as an
    // immutable, timestamped audit-log entry. Always written, regardless of
    // whether the user opted in — a "false / false" record is itself the
    // proof that we did not assume consent.
    await auditLog({
      userId,
      businessId,
      action: "auth.signup.sms_consent",
      resource: "auth_users",
      resourceId: userId,
      success: true,
      details: {
        sms_consent_transactional: smsConsentTransactional,
        sms_consent_marketing: smsConsentMarketing,
        source: "signup_form",
      },
      ...meta,
    });

    console.log("[Signup] Business created:", businessId, "- pending_payment, plan:", planId, billingCycle);

    const { data: session } = await supabase.auth.signInWithPassword({ email, password });
    res.status(201).json({
      success: true,
      business_id: businessId,
      // Sprint 1 BUG-17 sub-step 3b: echo back the chosen plan so the
      // frontend can immediately mint a Stripe Checkout session without
      // re-deriving them from the URL.
      plan_id: planId,
      billing_cycle: billingCycle,
      session: session.session,
      user: { id: userId, email },
    });
  } catch (err: any) {
    await auditLog({
      action: "auth.signup.error",
      ...meta,
      success: false,
      details: { email, error: err.message },
    });
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

router.post("/auth/login", validate(authLoginSchema), async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      await auditLog({
        action: "auth.login.failed",
        ...meta,
        success: false,
        details: { email },
      });
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    await auditLog({
      userId: data.user.id,
      action: "auth.login.success",
      ...meta,
      details: { email },
    });

    let mfaRequired = false;
    let mfaFactorId: string | null = null;
    try {
      const userSupabase = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY!,
        {
          global: { headers: { Authorization: `Bearer ${data.session?.access_token}` } },
          auth: { persistSession: false },
        }
      );
      const { data: factorsData } = await userSupabase.auth.mfa.listFactors();
      const verifiedFactors = factorsData?.totp?.filter((f: any) => f.status === "verified") || [];
      if (verifiedFactors.length > 0) {
        mfaRequired = true;
        mfaFactorId = verifiedFactors[0].id;
      }
    } catch {}

    const { data: memberships } = await supabase
      .from("user_businesses")
      .select("business_id, role, business_configs(business_name, industry, status)")
      .eq("user_id", data.user.id)
      .order("created_at", { ascending: true });
    const primaryBusiness = memberships?.[0]?.business_id || null;
    res.json({
      success: true,
      mfa_required: mfaRequired,
      mfa_factor_id: mfaFactorId,
      session: data.session,
      user: { id: data.user.id, email: data.user.email, business_id: primaryBusiness },
      businesses: memberships || [],
    });
  } catch (err: any) {
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

// Build the redirect URL Supabase will land the user on after they click
// the link in the recovery email. Prefers DASHBOARD_URL (explicit
// configuration), falls back to the Origin header (dashboard and api-server
// share an origin on Replit), and last-resorts to the request's own
// protocol+host. The path is appended here, not configured in Supabase
// Studio, so a single Site URL whitelist entry covers the full callback URL.
function resolveDashboardUrl(req: Request): string {
  const fromEnv = process.env.DASHBOARD_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const origin = req.get("origin");
  if (origin) return origin.replace(/\/+$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

// PUBLIC — bypass-listed in app.ts AUTH_BYPASS_PATTERNS. Always returns 204
// so an attacker can't enumerate which emails have accounts by probing
// status codes (matches the anti-enumeration posture of /auth/verify-email).
// Real upstream failures (Supabase Auth down, bad SERVICE_KEY, etc.) are
// captured to Sentry so on-call sees them without changing the wire
// response.
router.post("/auth/forgot-password", validate(authForgotPasswordSchema), async (req: Request, res: Response) => {
  const { email } = req.body;
  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);
  const redirectTo = `${resolveDashboardUrl(req)}/reset-password`;
  try {
    // resetPasswordForEmail does NOT distinguish "user not found" from
    // success at the SDK level — both shapes return { error: null }. So
    // any error here is a real upstream problem, not a missing user.
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) {
      Sentry.captureMessage("forgot_password_supabase_error", {
        level: "error",
        extra: { email, error: error.message, redirectTo },
      });
    }
    await auditLog({
      action: "auth.forgot_password.requested",
      ...meta,
      details: { email, redirectTo },
    });
  } catch (err: any) {
    Sentry.captureException(err, { extra: { email, route: "/auth/forgot-password" } });
  }
  res.status(204).end();
});

// PUBLIC — bypass-listed in app.ts AUTH_BYPASS_PATTERNS. The access_token
// in the request body IS the credential: it's the JWT Supabase Auth
// minted when the user clicked their recovery link and was redirected
// back to /reset-password#access_token=…&type=recovery. We validate it
// via getUser (which checks signature + expiry against Supabase Auth)
// and update the password with the service-key admin client.
router.post("/auth/reset-password", validate(authResetPasswordSchema), async (req: Request, res: Response) => {
  const { access_token, new_password } = req.body;
  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);
  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser(access_token);
    if (userErr || !userData?.user?.id) {
      await auditLog({
        action: "auth.reset_password.invalid_token",
        ...meta,
        success: false,
        details: { reason: userErr?.message || "no_user" },
      });
      res.status(401).json({ error: "Link expired or invalid" });
      return;
    }
    const userId = userData.user.id;
    const { error: updateErr } = await supabase.auth.admin.updateUserById(userId, {
      password: new_password,
    });
    if (updateErr) {
      Sentry.captureMessage("reset_password_update_failed", {
        level: "error",
        extra: { user_id: userId, error: updateErr.message },
      });
      await auditLog({
        userId,
        action: "auth.reset_password.update_failed",
        ...meta,
        success: false,
        details: { error: updateErr.message },
      });
      res.status(500).json({ error: "Couldn't update password" });
      return;
    }
    await auditLog({
      userId,
      action: "auth.reset_password.success",
      ...meta,
      details: {},
    });
    res.json({ success: true });
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "/auth/reset-password" } });
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

router.post("/auth/refresh", async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) { res.status(400).json({ error: "refresh_token required" }); return; }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.auth.refreshSession({ refresh_token });
  if (error || !data.session) { res.status(401).json({ error: "Could not refresh session" }); return; }
  res.json({ success: true, session: data.session });
});

router.get("/auth/me", requireAuth, async (req: Request, res: Response) => {
  const supabase = getSupabaseAdmin();
  const { data: memberships } = await supabase
    .from("user_businesses")
    // Sprint 2 STEP 4 / BUG-18: include email_verified + email_verified_at so
    // DashboardLayout can render <EmailVerificationScreen /> after the
    // pending_payment gate clears. Don't ship the verified_at timestamp to
    // the client without need — it's a leak vector — but it's harmless and
    // the dashboard reads it for "verified at <date>" surfacing later.
    .select("business_id, role, business_configs(business_name, industry, phone_number, status, agent_id, onboarding_complete, email_verified, email_verified_at)")
    .eq("user_id", req.userId!)
    .order("created_at", { ascending: true });

  let userMeta: any = {};
  try {
    const { data: userData } = await supabase.auth.admin.getUserById(req.userId!);
    if (userData?.user?.user_metadata) {
      userMeta = userData.user.user_metadata;
    }
  } catch {}

  // Best-effort staff role lookup — mirrors staff-rbac.ts:200-223. Customer
  // accounts have NO row in user_roles, so they get staff_role: null and the
  // dashboard's Sidebar uses that to hide admin nav items (Government, Demo
  // Library, Audit Logs, Customer Businesses). This is purely a UI hint —
  // the API still enforces per-resource gating via requireStaffPermission on
  // every admin endpoint. Inactive rows also degrade to null so a suspended
  // staff member doesn't keep seeing admin nav. Any DB hiccup falls through
  // to null too: failing-closed is the right call for an authorization hint.
  let staffRole: string | null = null;
  try {
    let { data: roleRow } = await supabase
      .from("user_roles")
      .select("role, status")
      .eq("user_id", req.userId!)
      .maybeSingle();
    if (!roleRow && req.userEmail) {
      const { data: byEmail } = await supabase
        .from("user_roles")
        .select("role, status")
        .ilike("email", req.userEmail)
        .maybeSingle();
      if (byEmail) roleRow = byEmail;
    }
    if (roleRow && roleRow.status === "active") {
      staffRole = roleRow.role as string;
    }
  } catch {
    // Best-effort: keep null on any error rather than 500 the whole /auth/me.
  }

  res.json({
    success: true,
    user: { id: req.userId, email: req.userEmail, user_metadata: userMeta },
    current_business_id: req.businessId,
    businesses: memberships || [],
    staff_role: staffRole,
  });
});

router.post("/auth/complete-onboarding", requireAuth, async (req: Request, res: Response) => {
  const { industry, business_name, city_state, phone_number, website, business_hours } = req.body;
  if (!industry || !business_name || !city_state) {
    res.status(400).json({ error: "industry, business_name, and city_state are required" });
    return;
  }

  const supabase = getSupabaseAdmin();
  const businessId = req.businessId;
  if (!businessId) {
    res.status(400).json({ error: "No business associated with this account" });
    return;
  }

  const meta = extractRequestMeta(req);

  try {
    // Sub-step 3d gate + existing idempotency check, combined into a
    // single SELECT so paying customers don't pay an extra round-trip.
    const { data: bizConfig, error: bizErr } = await supabase
      .from("business_configs")
      .select("agent_id, subscription_status")
      .eq("business_id", businessId)
      .single();

    if (bizErr || !bizConfig) {
      // Defensive — shouldn't happen since signup creates the row before
      // /auth/complete-onboarding can be called, and requireAuth has
      // already populated req.businessId from a verified user_businesses
      // membership row.
      Sentry.captureMessage("complete_onboarding_no_business_config", {
        level: "error",
        extra: {
          user_id: req.userId,
          business_id: businessId,
          error: bizErr?.message,
        },
      });
      res.status(404).json({ error: "Business configuration not found" });
      return;
    }

    const status = bizConfig.subscription_status;
    if (!ONBOARDING_ALLOWED_STATUSES.includes(status as any)) {
      // Logged as console + Sentry so we can spot launch-day patterns
      // (e.g., a frontend tab going stale and re-firing the call after
      // a customer abandoned checkout).
      console.log("[ONBOARDING_GATE] Blocked — subscription not active", {
        user_id: req.userId,
        business_id: businessId,
        subscription_status: status,
      });
      Sentry.captureMessage("onboarding_gate_blocked", {
        level: "info",
        extra: {
          user_id: req.userId,
          business_id: businessId,
          subscription_status: status,
        },
      });
      res.status(403).json({
        error: "subscription_required",
        message:
          "Your subscription must be active to complete onboarding. Please complete checkout to activate your account.",
        subscription_status: status,
      });
      return;
    }

    if (bizConfig.agent_id) {
      res.json({
        success: true,
        business_id: businessId,
        agent_id: bizConfig.agent_id,
        agent_created: true,
        message: "Onboarding already completed",
      });
      return;
    }

    const hoursStr = business_hours || "Monday-Friday 9AM-5PM";

    let websiteContext: string | null = null;
    let scrapedData: ScrapedData | null = null;
    if (website && typeof website === "string" && website.trim().length > 0) {
      try {
        scrapedData = await scrapeWebsite(website);
        if (scrapedData.success && scrapedData.context_text) {
          websiteContext = scrapedData.context_text;
          console.log("[Signup] Website scraped via", scrapedData.tier_used,
            "- structured fields:", Object.keys(scrapedData.structured || {}).length);
        } else {
          console.log("[Signup] Website scrape failed:", scrapedData.reason, "- continuing without");
        }
      } catch (e: any) {
        console.warn("[Signup] Scrape exception (continuing):", e.message ?? String(e));
      }
    }

    const businessUpdatePayload: any = {
      business_name,
      industry,
      phone_number: phone_number || "",
      website: website || "",
      address: city_state,
      business_hours: hoursStr,
    };
    if (scrapedData?.success) {
      businessUpdatePayload.website_scraped_at = scrapedData.scraped_at;
      businessUpdatePayload.website_scraped_data = scrapedData.structured;
      businessUpdatePayload.website_context_text = scrapedData.context_text;
    }
    await supabase.from("business_configs").update(businessUpdatePayload)
      .eq("business_id", businessId);

    const industryTemplate = await fetchIndustryTemplate(industry);
    console.log("[Signup] Template resolved:",
      industryTemplate ? `${industryTemplate.industry_id} (${industryTemplate.name})` : "NONE — using generic prompt",
      "for industry:", industry);

    const objectionHandlersFromTable = await fetchObjectionHandlers(businessId);

    const systemPrompt = buildSystemPrompt({
      business_name,
      industry,
      business_hours: hoursStr,
      website,
      timezone: "America/New_York",
      industryTemplate,
      websiteContext,
      objectionHandlersFromTable,
    });

    const agentResult = await createAgentForBusiness({
      businessId,
      businessName: business_name,
      systemPrompt,
      firstMessage: renderFirstMessage({ business_name }),
    });

    if (agentResult.success && agentResult.agentId) {
      await supabase.from("business_configs").update({
        agent_id: agentResult.agentId,
        onboarding_complete: true,
      }).eq("business_id", businessId);
      console.log("[Onboarding] Agent created:", agentResult.agentId, "for", businessId);
    } else {
      await supabase.from("business_configs").update({
        onboarding_complete: true,
      }).eq("business_id", businessId);
      console.log("[Onboarding] Completed without agent for", businessId);
    }

    try {
      const templates = OBJECTION_TEMPLATES[industry] || OBJECTION_TEMPLATES["general"] || [];
      for (const t of templates) {
        await contactPool.query(
          `INSERT INTO objection_handlers (business_id, objection_phrase, objection_category, ai_response, follow_up_action)
           VALUES ($1, $2, $3, $4, $5)`,
          [businessId, t.objection_phrase, t.objection_category, t.ai_response, t.follow_up_action]
        );
      }
      if (templates.length > 0) console.log(`[Onboarding] Seeded ${templates.length} objection handlers for ${industry}`);
    } catch (seedErr: any) {
      console.error("[Onboarding] Objection seed error:", seedErr.message);
    }

    await auditLog({
      userId: req.userId,
      businessId,
      action: "business.onboarding.completed",
      ...meta,
      details: { business_name, industry, agentCreated: agentResult.success },
    });

    // Sprint 2: auto-provision a per-tenant Twilio DID for this
    // business. Soft-fail on provisioning errors — the business_configs
    // row already exists and onboarding has otherwise succeeded, so a
    // Twilio-side failure should not roll back the whole signup. The
    // dashboard's existing empty-state UI renders "being provisioned"
    // copy when neverr_phone is null, and the admin endpoint can
    // backfill the number later (POST /api/admin/provision/:businessId).
    let provisionedPhone: string | null = null;
    let provisioningStatus: string = "failed_no_inventory";
    const areaCode = extractAreaCodeFromPhoneNumber(phone_number);
    if (!areaCode) {
      console.warn(
        `[Onboarding] Could not extract area code from phone_number "${phone_number}" for ${businessId}; defaulting to 443`,
      );
    }
    const requestedAreaCode = areaCode || "443";
    try {
      const result = await provisionTwilioNumberForBusiness(
        businessId,
        requestedAreaCode,
      );
      provisionedPhone = result.phoneNumber;
      provisioningStatus = "provisioned";
    } catch (err) {
      if (err instanceof TwilioProvisioningError) {
        console.error(
          `[Onboarding] Provisioning failed for ${businessId}: ${err.subcode} - ${err.message}`,
        );
        provisioningStatus = `failed_${err.subcode}`;
      } else {
        // Non-provisioning errors (DB outage, etc.) bubble up to the
        // outer try/catch and surface as 500 to the client.
        throw err;
      }
    }

    if (phone_number) {
      const welcomeBody = provisionedPhone
        ? `Welcome to Neverr! 🎉 Your AI receptionist is live. Forward your calls to ${provisionedPhone} to activate — The Neverr Team`
        : `Welcome to Neverr! Your account is being set up. We'll text you again with your forwarding number shortly. — The Neverr Team`;
      sendSMS(phone_number, welcomeBody).catch((err: any) =>
        console.error("[Onboarding] Welcome SMS failed:", err.message)
      );
    }

    res.json({
      success: true,
      business_id: businessId,
      agent_id: agentResult.agentId || null,
      agent_created: agentResult.success,
      neverr_phone: provisionedPhone,
      provisioning_status: provisioningStatus,
    });
  } catch (err: any) {
    console.error("[Onboarding] Error:", err.message);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

router.post("/auth/update-password", requireAuth, async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    res.status(400).json({ error: "current_password and new_password are required" });
    return;
  }
  if (new_password.length < 8) {
    res.status(400).json({ error: "New password must be at least 8 characters" });
    return;
  }

  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);

  try {
    const { data: userData } = await supabase.auth.admin.getUserById(req.userId!);
    if (!userData?.user?.email) {
      res.status(400).json({ error: "User not found" });
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: userData.user.email,
      password: current_password,
    });
    if (signInError) {
      await auditLog({
        userId: req.userId,
        action: "auth.password_update.failed",
        ...meta,
        success: false,
        details: { reason: "incorrect_current_password" },
      });
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const { error: updateError } = await supabase.auth.admin.updateUserById(req.userId!, {
      password: new_password,
    });
    if (updateError) {
      res.status(500).json({ error: updateError.message });
      return;
    }

    await auditLog({
      userId: req.userId,
      action: "auth.password_update.success",
      ...meta,
      details: {},
    });

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err: any) {
    console.error("[Auth] Password update error:", err.message);
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

router.post("/auth/logout", requireAuth, (_req: Request, res: Response) => {
  res.json({ success: true });
});

// Sprint 2 STEP 4 / BUG-18 Part 4: PUBLIC verify-email endpoint. The token
// in the request body IS the credential — no requireAuth. Bypassed in
// app.ts AUTH_BYPASS_PATTERNS via the /api/auth/verify-email regex.
//
// Anti-enumeration: returns the same generic shape for "token doesn't
// exist" and "token already used" so an attacker can't map valid tokens
// from probe responses. The internal `reason` field still distinguishes
// for legitimate UI rendering on /verify-email.
router.post("/auth/verify-email", async (req: Request, res: Response) => {
  const { token } = (req.body || {}) as { token?: string };
  if (!token || typeof token !== "string") {
    res.status(400).json({ success: false, reason: "invalid_or_expired" });
    return;
  }

  const supabase = getSupabaseAdmin();
  const meta = extractRequestMeta(req);

  // Anti-enumeration: collapse every "no-go" path to the SAME response
  // shape (`reason: "invalid_or_expired"`) so an attacker can't tell
  // valid-but-used from never-existed from expired. The internal
  // distinction lives only in audit/log via `internal_reason`.
  const failGeneric = (internalReason: string) => {
    console.log("[VerifyEmail] Reject:", internalReason);
    res.status(200).json({ success: false, reason: "invalid_or_expired" });
  };

  try {
    const { data: row, error: lookupErr } = await supabase
      .from("email_verification_tokens")
      .select("token, user_id, email, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();

    if (lookupErr) {
      Sentry.captureMessage("verify_email_lookup_failed", {
        level: "error",
        extra: { error: lookupErr.message },
      });
      res.status(500).json({ success: false, reason: "error" });
      return;
    }

    if (!row) {
      failGeneric("token_not_found");
      return;
    }

    if (row.used_at) {
      failGeneric("token_already_used");
      return;
    }

    const expiresAt = new Date(row.expires_at).getTime();
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      failGeneric("token_expired");
      return;
    }

    // CAS-style claim: UPDATE...WHERE used_at IS NULL ... .select() returns
    // the affected rows. If zero rows come back, ANOTHER concurrent verify
    // call won the race (e.g. user double-clicked the link, or React
    // strict-mode re-mount). Treat as already-used.
    const usedAt = new Date().toISOString();
    const { data: claimed, error: useErr } = await supabase
      .from("email_verification_tokens")
      .update({ used_at: usedAt })
      .eq("token", token)
      .is("used_at", null)
      .select("token");

    if (useErr) {
      Sentry.captureMessage("verify_email_mark_used_failed", {
        level: "error",
        extra: { token_user_id: row.user_id, error: useErr.message },
      });
      res.status(500).json({ success: false, reason: "error" });
      return;
    }
    if (!claimed || claimed.length === 0) {
      // Lost the CAS race — another request claimed this token in
      // between our SELECT and our UPDATE. Generic reject.
      failGeneric("token_cas_lost");
      return;
    }

    // We own this token. Now flip email_verified across every business
    // this user belongs to. A user may belong to multiple businesses
    // (Phase 3e multi-business); verifying their email verifies their
    // identity across all of them.
    const { data: memberships, error: memErr } = await supabase
      .from("user_businesses")
      .select("business_id")
      .eq("user_id", row.user_id);

    if (memErr) {
      // Membership lookup failed AFTER we burned the token. Auto-reissue
      // so the user isn't stuck — see updateErr branch below for the
      // same pattern.
      Sentry.captureMessage("verify_email_membership_lookup_failed", {
        level: "error",
        extra: { user_id: row.user_id, error: memErr.message },
      });
      let reissuedOk = false;
      try {
        const r = await issueAndSendVerification(supabase, row.user_id, row.email);
        reissuedOk = r.tokenIssued && r.emailSent;
      } catch (reissueErr: any) {
        console.error("[VerifyEmail] Auto-reissue failed:", reissueErr?.message ?? String(reissueErr));
      }
      res.status(500).json({
        success: false,
        reason: "error",
        message: reissuedOk
          ? "We hit a snag finishing your verification. We've emailed you a fresh link — please try that one."
          : "We hit a snag finishing your verification. Please head to your account and request a new verification link.",
      });
      return;
    }

    const businessIds = (memberships || []).map((m: any) => m.business_id).filter(Boolean);
    if (businessIds.length > 0) {
      const { error: updateErr } = await supabase
        .from("business_configs")
        .update({ email_verified: true, email_verified_at: usedAt })
        .in("business_id", businessIds);
      if (updateErr) {
        // CRITICAL atomicity failure: token already burned, but
        // email_verified did NOT take. Without recovery the user is
        // permanently stuck behind the gate. Auto-reissue a fresh token
        // + email so they can retry on a clean slate.
        Sentry.captureMessage("verify_email_business_update_failed", {
          level: "error",
          extra: { user_id: row.user_id, business_ids: businessIds, error: updateErr.message },
        });
        // Track whether the auto-reissue actually delivered. Without
        // this, a downstream Resend hiccup makes us lie to the user
        // ("we've emailed you a fresh link" when no email actually
        // shipped). reissuedOk gates the user-facing message.
        let reissuedOk = false;
        try {
          const r = await issueAndSendVerification(supabase, row.user_id, row.email);
          reissuedOk = r.tokenIssued && r.emailSent;
        } catch (reissueErr: any) {
          console.error("[VerifyEmail] Auto-reissue failed:", reissueErr?.message ?? String(reissueErr));
          Sentry.captureException(reissueErr, {
            extra: { route: "verify-email", phase: "auto_reissue", user_id: row.user_id },
          });
        }
        res.status(500).json({
          success: false,
          reason: "error",
          message: reissuedOk
            ? "We hit a snag finishing your verification. We've emailed you a fresh link — please try that one."
            : "We hit a snag finishing your verification. Please head to your account and request a new verification link.",
        });
        return;
      }
    }

    await auditLog({
      userId: row.user_id,
      action: "auth.email_verification.success",
      ...meta,
      details: { email: row.email, businesses: businessIds.length },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("[VerifyEmail] Error:", err.message);
    Sentry.captureException(err, { extra: { route: "verify-email" } });
    res.status(500).json({ success: false, reason: "error" });
  }
});

// Sprint 2 STEP 4 / BUG-18 Part 5: authenticated resend endpoint. Used by
// EmailVerificationScreen.tsx when the original email was lost or expired.
// Rate-limited to 1 resend per 60 seconds per user via in-memory map.
//
// Defense-in-depth: gates on subscription_status. Per the BUG-18 DO-NOT
// list, we MUST NOT send verification email to users in pending_payment —
// the EmailVerificationScreen never renders for them (PendingPaymentScreen
// renders first), but a hand-crafted POST could still land here. Gate
// returns 403 subscription_required mirroring /auth/complete-onboarding.
router.post("/auth/resend-verification", requireAuth, async (req: Request, res: Response) => {
  const userId = req.userId!;
  const userEmail = req.userEmail;
  const meta = extractRequestMeta(req);

  // Rate limit check.
  const last = lastResendByUser.get(userId) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
    res.status(429).json({
      success: false,
      error: "Please wait before requesting another email",
      retry_after: retryAfter,
    });
    return;
  }

  if (!userEmail) {
    res.status(400).json({ success: false, error: "User email not found" });
    return;
  }

  const supabase = getSupabaseAdmin();

  try {
    // Subscription gate (DO-NOT spam pending_payment users).
    const businessId = req.businessId;
    if (businessId) {
      const { data: bizConfig } = await supabase
        .from("business_configs")
        .select("subscription_status, email_verified")
        .eq("business_id", businessId)
        .single();
      if (bizConfig?.subscription_status === "pending_payment") {
        res.status(403).json({
          success: false,
          error: "subscription_required",
          message: "Complete checkout before requesting verification email.",
        });
        return;
      }
      if (bizConfig?.email_verified === true) {
        // Already verified — don't waste a Resend send. Return success
        // so the UI advances cleanly to the dashboard on next refresh.
        res.json({ success: true, already_verified: true });
        return;
      }
    }

    const result = await issueAndSendVerification(supabase, userId, userEmail);

    if (!result.tokenIssued) {
      res.status(500).json({ success: false, error: result.error || "Could not issue token" });
      return;
    }

    // Stamp rate-limit timer ONLY after a successful issuance — a failed
    // DB insert shouldn't lock the user out for 60s.
    lastResendByUser.set(userId, Date.now());

    await auditLog({
      userId,
      action: "auth.email_verification.resend",
      ...meta,
      details: { email: userEmail, email_sent: result.emailSent },
    });

    res.json({ success: true });
  } catch (err: any) {
    console.error("[ResendVerification] Error:", err.message);
    Sentry.captureException(err, { extra: { route: "resend-verification", user_id: userId } });
    res.status(500).json({ success: false, error: "An unexpected error occurred" });
  }
});

export default router;
