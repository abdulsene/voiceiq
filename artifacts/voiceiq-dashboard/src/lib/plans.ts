// Sprint 1 BUG-17 sub-step 3e: hoisted from pages/Signup.tsx so both the
// signup form and the new PendingPaymentScreen render the same plan label
// and price strings without duplicating the constant. Numbers MUST stay in
// sync with `SMB_PLANS` in artifacts/voiceiq-dashboard/src/pages/PricingPage.tsx
// — if a monthly or annual price changes there, change the matching entry
// here too. Annual is shown as Math.round(annual / 12) to match the
// per-month figure rendered on /pricing. Only the 6 self-serve plans live
// here; franchise/volume tiers route to /contact and never reach signup or
// the pending-payment recovery flow.

export type BillingCycle = "monthly" | "annual";

export interface PlanMeta {
  label: string;
  monthly: number;
  annualPerMonth: number;
  // Sprint 4 FIX 2: one-time setup fee shown in the signup pill so users
  // are not surprised at checkout. Numbers MUST stay in sync with the
  // Stripe setup price IDs (STRIPE_*_SETUP_PRICE_ID env secrets).
  setupFee: number;
}

export const PLAN_PRICES: Record<string, PlanMeta> = {
  essential:    { label: "Essential",    monthly: 149,  annualPerMonth: 113,  setupFee: 99 },
  starter:      { label: "Starter",      monthly: 349,  annualPerMonth: 266,  setupFee: 199 },
  professional: { label: "Professional", monthly: 749,  annualPerMonth: 571,  setupFee: 499 },
  growth:       { label: "Growth",       monthly: 999,  annualPerMonth: 833,  setupFee: 799 },
  business:     { label: "Business",     monthly: 1499, annualPerMonth: 1146, setupFee: 999 },
  enterprise:   { label: "Enterprise",   monthly: 3499, annualPerMonth: 2667, setupFee: 2499 },
};

export const VALID_PLANS = Object.keys(PLAN_PRICES);

// Resolve an arbitrary plan id (possibly missing or invalid coming back from
// the DB row) to a known PlanMeta. Falls back to Essential — the cheapest
// self-serve tier — so the UI never crashes on a malformed value.
export function getPlanMeta(planId: string | null | undefined): PlanMeta {
  if (planId && PLAN_PRICES[planId]) return PLAN_PRICES[planId];
  return PLAN_PRICES.essential;
}

// Format the price-per-month string for a (planId, billingCycle) pair, in
// the same shape /pricing and /signup already render: "$149/mo" for monthly,
// "$113/mo billed annually" for annual.
export function formatPriceLabel(planId: string | null | undefined, cycle: BillingCycle | string | null | undefined): string {
  const meta = getPlanMeta(planId);
  if (cycle === "annual") {
    return `$${meta.annualPerMonth}/mo billed annually`;
  }
  return `$${meta.monthly}/mo`;
}
