import Stripe from 'stripe';

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
    _stripe = new Stripe(key, { apiVersion: '2024-04-10' as any });
  }
  return _stripe;
}

// ============================================================================
// STRIPE DATA-TRANSLATION HELPERS — DO NOT BYPASS
// ============================================================================
// Every read of Stripe-shaped data that crosses an api-version boundary or
// an internal-vs-Stripe enum boundary MUST go through one of the helpers in
// this section. Reading sub.current_period_end directly, or writing
// sub.status verbatim, will cause silent data corruption when Stripe rolls
// API versions or when an event arrives under a different api-version than
// the one this client is pinned to.
//
// If you find yourself writing `sub.current_period_end`, `sub.status`, or
// any other field where Stripe's surface differs from our internal column
// names, ADD a helper here instead of inlining the access. Then grep the
// codebase to make sure the new helper is the only path.
// ============================================================================

/**
 * Sprint 1 BUG-17 sub-step 3c-extended-2: read current_period_end from a
 * Stripe Subscription, handling the API version 2025-10-29 (and later
 * versions like 2025-10-29.clover) where the field moved from the
 * Subscription top-level to the SubscriptionItem level:
 *   sub.current_period_end (top-level)            <= 2024-04-10 and earlier
 *   sub.items.data[0].current_period_end (item)   >= 2025-10-29.clover
 *
 * The api-server's Stripe client is currently pinned to apiVersion
 * '2024-04-10' (see getStripe above), but webhook events delivered to
 * production endpoints use whatever apiVersion the endpoint is pinned to in
 * the Stripe dashboard, which can differ from this client. Helper checks
 * the new path first then falls back to the top-level so it works under
 * BOTH API versions and is robust to future endpoint-level upgrades.
 *
 * Returns Unix timestamp in seconds, or null if not present in either path.
 *
 * DO NOT read sub.current_period_end directly anywhere in this codebase.
 * A grep for `current_period_end` should turn up only this helper, the
 * verification harness, and writes to business_configs.current_period_end.
 * If a future API version adds yet another path, EXTEND this helper rather
 * than working around it inline.
 *
 * Note: only `current_period_end` and `current_period_start` moved in
 * 2025-10-29.clover. `trial_end`, `trial_start`, `cancel_at_period_end`,
 * and `canceled_at` remain at the Subscription top-level.
 */
export function getCurrentPeriodEnd(sub: Stripe.Subscription): number | null {
  const itemLevel = (sub as any).items?.data?.[0]?.current_period_end;
  if (itemLevel != null) return itemLevel;
  const topLevel = (sub as any).current_period_end;
  if (topLevel != null) return topLevel;
  return null;
}

/**
 * Sprint 1 BUG-17 sub-step 3c-extended-3 (X7 fix): map a Stripe subscription
 * status string to our normalized internal value, and flag whether the
 * value was unexpected (so the caller can decide to log/alert with its own
 * context).
 *
 * Mapping table:
 *   "trialing"            → "trialing"             (verbatim)
 *   "active"              → "active"               (verbatim)
 *   "past_due"            → "past_due"             (verbatim)
 *   "paused"              → "paused"               (verbatim, but flagged unexpected)
 *   "canceled"            → "cancelled"            (Stripe spelling → our spelling, two L's,
 *                                                   matches subscription.deleted convention)
 *   "incomplete"          → "incomplete"           (verbatim, flagged unexpected)
 *   "incomplete_expired"  → "incomplete_expired"   (verbatim, flagged unexpected)
 *   "unpaid"              → "unpaid"               (verbatim, flagged unexpected)
 *   anything else         → verbatim               (flagged unexpected — covers future
 *                                                   Stripe statuses we don't know yet)
 *   null/empty            → "trialing"             (defensive default — every plan has a
 *                                                   7-day trial, never default to "active")
 *
 * Caller is responsible for any side effects (logging, Sentry breadcrumbs,
 * etc) so the call site can include event id, business id, and other
 * context that doesn't belong in this stateless helper.
 *
 * DO NOT write sub.status verbatim into business_configs.subscription_status
 * anywhere in this codebase. Always go through this helper. Otherwise the
 * "canceled" → "cancelled" spelling will diverge between handlers and
 * downstream queries that compare to "cancelled" will silently miss rows.
 */
export function mapStripeStatus(stripeStatus: string | null | undefined): {
  status: string;
  isUnexpected: boolean;
} {
  if (!stripeStatus) return { status: "trialing", isUnexpected: false };
  switch (stripeStatus) {
    case "trialing":
    case "active":
    case "past_due":
      return { status: stripeStatus, isUnexpected: false };
    case "canceled":
      return { status: "cancelled", isUnexpected: false };
    case "incomplete":
    case "incomplete_expired":
    case "unpaid":
    case "paused":
      return { status: stripeStatus, isUnexpected: true };
    default:
      return { status: stripeStatus, isUnexpected: true };
  }
}

/**
 * Sprint 1 BUG-17 sub-step 3c-extended-4 (H4 fix): reverse-lookup of
 * PRICE_IDS. Given a Stripe price ID (the recurring price on a
 * subscription item), returns the matching `{ planId, billingCycle }`,
 * or null if not a known recurring plan price.
 *
 * Used in customer.subscription.created/updated to detect portal-initiated
 * plan changes (upgrade / downgrade / cycle switch) and reflect them in
 * business_configs.plan_id and business_configs.billing_cycle.
 *
 * DO NOT manually parse Stripe price IDs anywhere in this codebase —
 * always go through this helper. Otherwise a Stripe Customer Portal
 * upgrade/downgrade will silently leave business_configs.plan_id stale
 * (the user pays for Professional but the dashboard still shows
 * Essential), and downstream tier gates will enforce the wrong limits.
 *
 * Note on setup-fee prices (STRIPE_<PLAN>_SETUP_PRICE_ID): those are
 * one-time prices added as a SECOND line item on the Checkout Session
 * (see 3b-extended Finding A fix and SETUP_FEE_PRICE_IDS below). They
 * are NOT recurring and do NOT appear on `subscription.items.data[]`.
 * Stripe only lists recurring items there. So this helper does not need
 * to handle them — and if one ever did appear, the function returns
 * null and the caller logs a `webhook_unknown_price_id` warning rather
 * than silently writing the wrong plan_id.
 */
export function priceIdToPlan(
  priceId: string | null | undefined,
): { planId: string; billingCycle: "monthly" | "annual" } | null {
  if (!priceId) return null;
  for (const [planId, cycles] of Object.entries(PRICE_IDS)) {
    if (cycles.monthly === priceId) return { planId, billingCycle: "monthly" };
    if (cycles.annual === priceId) return { planId, billingCycle: "annual" };
  }
  return null;
}

const PRICE_IDS: Record<string, Record<string, string>> = {
  essential:     { monthly: process.env.STRIPE_ESSENTIAL_MONTHLY_PRICE_ID!,     annual: process.env.STRIPE_ESSENTIAL_ANNUAL_PRICE_ID! },
  starter:       { monthly: process.env.STRIPE_STARTER_MONTHLY_PRICE_ID!,       annual: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID! },
  professional:  { monthly: process.env.STRIPE_PROFESSIONAL_MONTHLY_PRICE_ID!,  annual: process.env.STRIPE_PROFESSIONAL_ANNUAL_PRICE_ID! },
  growth:        { monthly: process.env.STRIPE_GROWTH_MONTHLY_PRICE_ID!,        annual: process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID! },
  business:      { monthly: process.env.STRIPE_BUSINESS_MONTHLY_PRICE_ID!,      annual: process.env.STRIPE_BUSINESS_ANNUAL_PRICE_ID! },
  enterprise:    { monthly: process.env.STRIPE_ENTERPRISE_MONTHLY_PRICE_ID!,    annual: process.env.STRIPE_ENTERPRISE_ANNUAL_PRICE_ID! },
};

// Display-only USD setup-fee amounts. The actual charge is driven by the
// matching one-time price ID in SETUP_FEE_PRICE_IDS below — these are kept
// in sync with the Stripe-side prices and used by the dashboard pricing UI.
const SETUP_FEES: Record<string, number> = {
  essential: 99,
  starter: 199,
  professional: 499,
  growth: 799,
  business: 999,
  enterprise: 2499,
};

// Sprint 1 BUG-17 sub-step 3b-extended (Finding A fix): setup fees are
// charged via a real Stripe one-time price added as a SECOND line item on
// the Checkout Session, not via the bogus subscription_data.add_invoice_items
// param Stripe rejects. All 6 IDs are pre-created in the Stripe dashboard
// and exported as STRIPE_<PLAN>_SETUP_PRICE_ID env vars.
const SETUP_FEE_PRICE_IDS: Record<string, string | undefined> = {
  essential:    process.env.STRIPE_ESSENTIAL_SETUP_PRICE_ID,
  starter:      process.env.STRIPE_STARTER_SETUP_PRICE_ID,
  professional: process.env.STRIPE_PROFESSIONAL_SETUP_PRICE_ID,
  growth:       process.env.STRIPE_GROWTH_SETUP_PRICE_ID,
  business:     process.env.STRIPE_BUSINESS_SETUP_PRICE_ID,
  enterprise:   process.env.STRIPE_ENTERPRISE_SETUP_PRICE_ID,
};

export { PRICE_IDS, SETUP_FEES, SETUP_FEE_PRICE_IDS };
export default getStripe;
