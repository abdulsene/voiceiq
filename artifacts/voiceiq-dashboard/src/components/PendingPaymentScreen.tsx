import { useState } from "react";
import { Loader2, CreditCard, AlertCircle } from "lucide-react";
import { formatPriceLabel, getPlanMeta, type BillingCycle } from "../lib/plans";

const API = "/api";

interface Props {
  businessId: string;
  planId: string;
  billingCycle: string;
  email?: string;
}

// Sprint 1 BUG-17 sub-step 3e: full-screen blocking gate rendered by
// DashboardLayout when business_configs.subscription_status='pending_payment'.
// The user signed up and a row was created (per 3b), but they bailed at
// Stripe Checkout. This screen explains the situation and gives them three
// recovery paths:
//   1. Resume Checkout — mint a new Checkout session for the SAME plan they
//      originally chose (plan_id + billing_cycle were saved on the row by
//      3c-extended-3 B2's signup INSERT fix), redirect to Stripe.
//   2. Choose a different plan — go to /pricing where the existing
//      PricingPage flow handles minting a Checkout for a different tier.
//   3. Sign out — for users who want to abandon and start over with a
//      different email.
//
// Visual style matches the rest of the dashboard (neutral background, white
// card, brand-blue primary CTA #2E75B6) — no new design tokens introduced.
export default function PendingPaymentScreen({ businessId, planId, billingCycle, email }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const meta = getPlanMeta(planId);
  const priceLabel = formatPriceLabel(planId, billingCycle);
  const cycleNote = billingCycle === "annual" ? "annually" : "monthly";

  async function handleResumeCheckout() {
    setError("");
    setLoading(true);
    try {
      const token = localStorage.getItem("neverr_token") || "";
      const r = await fetch(`${API}/stripe/create-checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          planId,
          billingCycle: (billingCycle === "annual" ? "annual" : "monthly") as BillingCycle,
          businessId,
          // email is best-effort; backend already has the email on file via
          // the auth token. Falling back to "" keeps the request well-formed.
          email: email || "",
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.url) {
        // Surface the server's error verbatim if it's user-readable, else
        // a generic recovery message. We do NOT silently navigate anywhere
        // unexpected — the user stays on this screen and can retry.
        throw new Error(data?.error || "Could not start checkout. Please try again.");
      }
      window.location.href = data.url;
    } catch (e: any) {
      setError(e?.message || "Network error. Please try again.");
      setLoading(false);
    }
  }

  function handleChoosePlan() {
    window.location.href = "/pricing";
  }

  function handleSignOut() {
    // Mirror App.tsx clearSession() — wipe ALL neverr_* keys so the next
    // user on this device doesn't inherit a stale tenant pointer.
    localStorage.removeItem("neverr_token");
    localStorage.removeItem("neverr_refresh");
    localStorage.removeItem("neverr_business_id");
    localStorage.removeItem("neverr_active_business_id");
    localStorage.removeItem("neverr_last_activity");
    window.location.href = "/signup";
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#f0f2f5] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center">
            <CreditCard className="w-7 h-7 text-amber-600" />
          </div>
        </div>

        <h1 className="text-xl font-bold text-gray-900 text-center mb-2">
          Complete your signup to activate Neverr
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          Your account is created but your subscription isn't active yet.
          Complete checkout to start your 7-day free trial.
        </p>

        <div className="rounded-xl border-2 border-[#2E75B6]/20 bg-gradient-to-br from-blue-50/50 to-white p-4 mb-6">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">Selected plan</p>
          <p className="text-lg font-bold text-gray-900 mt-1">{meta.label}</p>
          <p className="text-sm text-gray-600 mt-0.5">
            {priceLabel} <span className="text-gray-400">· billed {cycleNote}</span>
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p>{error}</p>
              <button
                onClick={handleResumeCheckout}
                className="mt-1.5 text-red-800 underline font-medium hover:text-red-900"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        <button
          onClick={handleResumeCheckout}
          disabled={loading}
          className="w-full inline-flex items-center justify-center gap-2 bg-[#2E75B6] text-white px-6 py-3 rounded-xl font-semibold hover:bg-[#2563a0] disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-sm shadow-md shadow-[#2E75B6]/20"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Starting checkout...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4" />
              Resume Checkout
            </>
          )}
        </button>

        <div className="flex flex-col items-center gap-2 mt-5 text-sm">
          <button
            onClick={handleChoosePlan}
            disabled={loading}
            className="text-[#2E75B6] hover:underline disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Choose a different plan
          </button>
          <button
            onClick={handleSignOut}
            disabled={loading}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
