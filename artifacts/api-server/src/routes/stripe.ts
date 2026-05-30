import { Router, type Request, type Response } from "express";
import * as Sentry from "@sentry/node";
import getStripe, { PRICE_IDS, SETUP_FEES, SETUP_FEE_PRICE_IDS } from "../stripe";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middlewares/auth";

const router = Router();

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Sprint 1 BUG-17 sub-step 3b-extended: typed error so callers can map
// known business failures to HTTP status codes without leaking raw Stripe
// error messages.
export class CheckoutHelperError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CheckoutHelperError";
  }
}

export interface CreateCheckoutOpts {
  businessId: string;
  planId: string;
  billingCycle: string;
  email: string;
  // If the caller already knows the user has an existing Stripe customer
  // (e.g. from another tenant they own), pass it here. The helper will
  // reuse it instead of creating a new one. This is how Pattern 2 works
  // for /api/business/create-additional — same Stripe customer, multiple
  // subscriptions.
  customerIdHint?: string;
}

export interface CreateCheckoutResult {
  url: string;
  sessionId: string;
  customerId: string;
}

// Sprint 1 BUG-17 sub-step 3b-extended: shared helper used by both
// /api/stripe/create-checkout-session AND /api/business/create-additional
// so there's exactly one place that:
//   - validates the (plan, cycle) pair against PRICE_IDS
//   - reuses or creates the Stripe customer for the business
//   - composes the correct line_items (recurring + optional one-time setup fee)
//   - sets client_reference_id so the 3c webhook can look up the business
//
// Returns the Checkout URL on success; throws CheckoutHelperError(status, msg)
// on known failures so the route can translate to HTTP cleanly.
export async function createCheckoutSessionForBusiness(
  opts: CreateCheckoutOpts,
): Promise<CreateCheckoutResult> {
  const { businessId, planId, billingCycle, email, customerIdHint } = opts;

  const priceId = PRICE_IDS[planId]?.[billingCycle];
  if (!priceId) {
    throw new CheckoutHelperError(
      400,
      `Invalid plan '${planId}' or billing cycle '${billingCycle}'`,
    );
  }

  const supabase = getSupabase();
  if (!supabase) {
    throw new CheckoutHelperError(500, "Database unavailable");
  }

  const stripe = getStripe();

  // Step 1: resolve the Stripe customer for this business.
  let stripeCustomerId = customerIdHint;

  if (!stripeCustomerId) {
    const { data: biz } = await supabase
      .from("business_configs")
      .select("stripe_customer_id, business_name")
      .eq("business_id", businessId)
      .single();

    stripeCustomerId = biz?.stripe_customer_id || undefined;

    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { businessId, businessName: biz?.business_name || "" },
      });
      stripeCustomerId = customer.id;
      console.log("[Stripe] Customer created:", customer.id, "for", businessId);
    }
  }

  // Always make sure the business_configs row has the customer id pinned —
  // covers both the just-created case AND the customerIdHint case where the
  // new tenant's row hasn't been linked to the existing customer yet.
  await supabase
    .from("business_configs")
    .update({ stripe_customer_id: stripeCustomerId })
    .eq("business_id", businessId);

  // Step 2: build line_items. Recurring price is always present; the
  // optional one-time setup fee is added as a SECOND line item (the
  // Stripe-supported pattern, replacing the broken
  // subscription_data.add_invoke_items shape that 500'd in 3b).
  //
  // Sprint 1 BUG-17 sub-step 3c (Part 3): fail-closed on env drift. The
  // pre-3c code silently skipped the setup-fee line item when the env var
  // was missing, undercharging the customer by the setup fee amount. Now
  // if SETUP_FEES says this plan SHOULD charge a setup fee, the env var
  // MUST be present — otherwise we throw and Sentry fires. Customer sees
  // the existing rollback-path UX ("Could not start checkout, please try
  // again or contact support") and billing stays correct.
  const lineItems: Array<{ price: string; quantity: number }> = [
    { price: priceId, quantity: 1 },
  ];
  const expectedSetupFee = SETUP_FEES[planId] || 0;
  if (expectedSetupFee > 0) {
    const setupPriceId = SETUP_FEE_PRICE_IDS[planId];
    if (!setupPriceId) {
      Sentry.captureMessage("setup_fee_price_id_missing", {
        level: "error",
        extra: {
          event: "setup_fee_price_id_missing",
          plan_id: planId,
          expected_setup_fee_usd: expectedSetupFee,
        },
      });
      console.error(
        "[Stripe][SETUP_FEE_PRICE_ID_MISSING]",
        JSON.stringify({ event: "setup_fee_price_id_missing", plan_id: planId }),
      );
      throw new CheckoutHelperError(
        500,
        `Setup fee price ID missing for plan ${planId}. Cannot mint Checkout session.`,
      );
    }
    lineItems.push({ price: setupPriceId, quantity: 1 });
  }

  // Step 3: compose session params. `client_reference_id` is set so the
  // 3c webhook has a stable foreign key back to business_configs even if
  // the metadata is stripped during a later subscription mutation.
  const baseUrl = process.env.BASE_URL || "https://neverr.ai";
  const sessionParams: any = {
    mode: "subscription" as const,
    customer: stripeCustomerId,
    client_reference_id: businessId,
    line_items: lineItems,
    subscription_data: {
      metadata: { businessId, planId, billingCycle },
      trial_period_days: 7,
    },
    success_url: `${baseUrl}/dashboard?checkout=success&plan=${planId}`,
    // Sprint 1 BUG-17 sub-step 3b: cancelled checkout returns to /signup
    // (not /pricing) so the user lands in a "complete your signup" state
    // tied to the account they already created.
    cancel_url: `${baseUrl}/signup?checkout=cancelled`,
    metadata: { businessId, planId, billingCycle },
  };

  const session = await stripe.checkout.sessions.create(sessionParams);

  console.log(
    "[Stripe] Checkout session created:",
    session.id,
    "for",
    businessId,
    "plan:",
    planId,
    billingCycle,
    "items:",
    lineItems.length,
  );

  if (!session.url) {
    throw new CheckoutHelperError(500, "Stripe did not return a checkout URL");
  }

  return {
    url: session.url,
    sessionId: session.id,
    customerId: stripeCustomerId,
  };
}

// Sprint 1 BUG-17 sub-step 3b: this route requires auth. Previously any
// caller who knew (or guessed) a businessId could mint a Checkout session
// pointing at someone else's business. Signup now logs the user in
// synchronously before calling this route, so requiring auth is safe.
router.post("/stripe/create-checkout-session", requireAuth, async (req: Request, res: Response) => {
  const { planId, billingCycle, businessId, email } = req.body;

  if (!planId || !billingCycle || !businessId || !email) {
    res.status(400).json({ error: "planId, billingCycle, businessId, and email are required" });
    return;
  }

  // Tenant guard: the JWT'd caller MUST be a member of the businessId they
  // are minting a Checkout session for. requireAuth populates req.businessIds
  // with every membership; anything not in that list is a 403, not a 400,
  // because the caller IS authenticated — just not authorized for this tenant.
  if (!req.businessIds || !req.businessIds.includes(businessId)) {
    res.status(403).json({ error: "Not authorized for this business" });
    return;
  }

  try {
    const result = await createCheckoutSessionForBusiness({
      businessId,
      planId,
      billingCycle,
      email,
    });
    res.json({ url: result.url });
  } catch (err: any) {
    if (err instanceof CheckoutHelperError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[Stripe] Checkout error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sprint 1 BUG-17 sub-step 3b-extended-2: this route requires auth.
// Customer Portal lets the caller update payment methods, view invoices,
// AND CANCEL SUBSCRIPTIONS — so unauthed access meant anyone who knew (or
// guessed) a businessId could trigger a cancellation flow against another
// tenant's customer. requireAuth + req.businessIds membership check closes
// the hole. Existing response shape ({url}) is unchanged.
router.post("/stripe/portal", requireAuth, async (req: Request, res: Response) => {
  const { businessId } = req.body;
  if (!businessId) {
    res.status(400).json({ error: "businessId is required" });
    return;
  }

  // Tenant guard: the JWT'd caller MUST be a member of the businessId they
  // are opening the portal for. 403 (not 400) because the caller IS
  // authenticated — just not authorized for this tenant.
  if (!req.businessIds || !req.businessIds.includes(businessId)) {
    res.status(403).json({ error: "Not authorized for this business" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database unavailable" });
    return;
  }

  try {
    const { data: biz } = await supabase
      .from("business_configs")
      .select("stripe_customer_id")
      .eq("business_id", businessId)
      .single();

    if (!biz?.stripe_customer_id) {
      res.status(400).json({ error: "No Stripe customer found for this business" });
      return;
    }

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: biz.stripe_customer_id,
      return_url: `${process.env.BASE_URL || "https://neverr.ai"}/settings`,
    });

    res.json({ url: session.url });
  } catch (err: any) {
    console.error("[Stripe] Portal error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sprint 1 BUG-17 sub-step 3b-extended-2: this route requires auth.
// Returns subscription metadata (plan, billing cycle, status, period end)
// for a businessId — information disclosure if unauthed. Same lockdown
// pattern as /stripe/portal. Existing response shape unchanged.
router.get("/stripe/subscription/:businessId", requireAuth, async (req: Request, res: Response) => {
  const { businessId } = req.params;

  if (!req.businessIds || !req.businessIds.includes(businessId)) {
    res.status(403).json({ error: "Not authorized for this business" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database unavailable" });
    return;
  }

  try {
    const { data: biz } = await supabase
      .from("business_configs")
      .select("plan_id, billing_cycle, subscription_status, current_period_end, trial_ends_at, stripe_subscription_id")
      .eq("business_id", businessId)
      .single();

    res.json({
      success: true,
      subscription: biz || {
        plan_id: "essential",
        billing_cycle: "monthly",
        // Sprint 1 BUG-17 sub-step 3c-extended-3 (M5 fix): align fallback
        // default with the canonical Stripe-derived enum value the webhook
        // writes ("trialing", not "trial"). Keeps client-side comparisons
        // consistent with the row the webhook will populate momentarily.
        subscription_status: "trialing",
        current_period_end: null,
        trial_ends_at: null,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
