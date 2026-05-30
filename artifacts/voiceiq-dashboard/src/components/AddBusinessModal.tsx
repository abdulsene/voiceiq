import { useEffect, useMemo, useState } from "react";
import { X, Loader2 } from "lucide-react";

const API = window.location.origin + "/api";

type Industry = { industry_id: string; name: string; category: string };

type Props = {
  open: boolean;
  onClose: () => void;
  // Kept for API compat with App.tsx. Not called in the new flow because
  // success now means "redirected to Stripe Checkout", which navigates the
  // whole window away from the dashboard. The user comes back via
  // /dashboard?checkout=success after completing payment, at which point
  // App.tsx re-bootstraps from scratch.
  onCreated: (newBusinessId: string) => void;
};

// Mirror PricingPage.tsx — kept tiny on purpose because every single price
// here is also defined in two other places (PricingPage and Signup). Sub-step
// 3f will fold all three into a shared module.
type PlanRow = {
  id: "essential" | "starter" | "professional" | "growth" | "business" | "enterprise";
  name: string;
  monthly: number;
  annual: number;
  setup: number;
  blurb: string;
};

const PLANS: PlanRow[] = [
  { id: "essential",    name: "Essential",    monthly: 149,  annual: 1355,  setup: 99,   blurb: "120 min · 1 location · 100 SMS/mo" },
  { id: "starter",      name: "Starter",      monthly: 349,  annual: 3175,  setup: 199,  blurb: "750 min · 1 location · 500 SMS/mo" },
  { id: "professional", name: "Professional", monthly: 749,  annual: 6815,  setup: 499,  blurb: "2,500 min · 1 location · 2,000 SMS/mo" },
  { id: "growth",       name: "Growth",       monthly: 1149, annual: 10455, setup: 799,  blurb: "4,000 min · 2 locations · 5,000 SMS/mo" },
  { id: "business",     name: "Business",     monthly: 1799, annual: 16373, setup: 999,  blurb: "6,000 min · 3 locations · 10,000 SMS/mo" },
  { id: "enterprise",   name: "Enterprise",   monthly: 4499, annual: 40941, setup: 2499, blurb: "15,000 min · 4 locations · 30,000 SMS/mo" },
];

function fmt(n: number) {
  return n.toLocaleString();
}

export default function AddBusinessModal({ open, onClose, onCreated: _onCreated }: Props) {
  const [industries, setIndustries] = useState<Record<string, Industry[]>>({});
  const [loadingIndustries, setLoadingIndustries] = useState(false);
  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("");
  const [planId, setPlanId] = useState<PlanRow["id"] | "">("");
  const [billingCycle, setBillingCycle] = useState<"monthly" | "annual">("monthly");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = localStorage.getItem("neverr_token");
  const activeBusinessId = localStorage.getItem("neverr_active_business_id");

  // Pre-select the plan that matches the user's existing tenant. Best-effort:
  // if the lookup fails (no active business, network error, etc.) we leave
  // the picker blank so the user has to make an explicit choice.
  //
  // Sprint 1 BUG-17 sub-step 3b-extended-2: /stripe/subscription/:id now
  // requires auth + tenant membership. Send the user's bearer token so
  // requireAuth passes; the activeBusinessId is by definition one of the
  // user's tenants so the membership check trivially passes too.
  useEffect(() => {
    if (!open || planId || !activeBusinessId) return;
    fetch(`${API}/stripe/subscription/${encodeURIComponent(activeBusinessId)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const sub = d?.subscription;
        if (!sub) return;
        if (sub.plan_id && PLANS.some((p) => p.id === sub.plan_id)) {
          setPlanId(sub.plan_id as PlanRow["id"]);
        }
        if (sub.billing_cycle === "annual" || sub.billing_cycle === "monthly") {
          setBillingCycle(sub.billing_cycle);
        }
      })
      .catch(() => {});
  }, [open, planId, activeBusinessId, token]);

  useEffect(() => {
    if (!open || Object.keys(industries).length > 0) return;
    setLoadingIndustries(true);
    fetch(`${API}/onboard/industries`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.categories) setIndustries(d.categories);
      })
      .catch(() => {})
      .finally(() => setLoadingIndustries(false));
  }, [open, industries]);

  const selectedPlan = useMemo(
    () => PLANS.find((p) => p.id === planId) || null,
    [planId],
  );

  function priceLabel(p: PlanRow): string {
    if (billingCycle === "annual") {
      const perMonth = Math.round(p.annual / 12);
      return `$${fmt(perMonth)}/mo · $${fmt(p.annual)}/yr`;
    }
    return `$${fmt(p.monthly)}/mo`;
  }

  async function handleCreate() {
    if (!businessName.trim() || !industry) {
      setError("Please enter a business name and select an industry");
      return;
    }
    if (!planId) {
      setError("Please select a plan");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`${API}/business/create-additional`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          business_name: businessName.trim(),
          industry,
          plan_id: planId,
          billing_cycle: billingCycle,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.success || !d.checkout_url) {
        setError(d.error || `Failed (HTTP ${r.status})`);
        setSubmitting(false);
        return;
      }
      // The new tenant has been created in pending_payment state. The only
      // valid "next state" is paying for it, so redirect the whole window
      // to Stripe rather than closing the modal back to the dashboard. The
      // user comes back via /dashboard?checkout=success or /signup?checkout=cancelled.
      window.location.href = d.checkout_url;
    } catch (e: any) {
      setError(e.message || "Network error");
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-xl my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-6 pb-3">
          <h2 className="text-lg font-bold text-slate-900">
            Add a new business
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            disabled={submitting}
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="px-6 text-sm text-slate-600">
          Each business is its own subscription on the same account. You'll be
          taken to Stripe to complete payment.
        </p>

        <div className="px-6 pt-5 space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1.5">
              Business name
            </label>
            <input
              type="text"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Acme Plumbing, Inc."
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              disabled={submitting}
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1.5">
              Industry
            </label>
            <select
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              disabled={submitting || loadingIndustries}
            >
              <option value="">
                {loadingIndustries ? "Loading..." : "Select industry..."}
              </option>
              {Object.entries(industries)
                .sort()
                .map(([category, items]) => (
                  <optgroup key={category} label={category}>
                    {items.map((i) => (
                      <option key={i.industry_id} value={i.industry_id}>
                        {i.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </div>
        </div>

        <div className="px-6 pt-5">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-semibold text-slate-900">
              Choose a plan
            </label>
            <div className="inline-flex rounded-lg border border-slate-300 p-0.5 text-xs">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setBillingCycle("monthly")}
                className={`px-3 py-1 rounded-md transition ${
                  billingCycle === "monthly"
                    ? "bg-blue-600 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setBillingCycle("annual")}
                className={`px-3 py-1 rounded-md transition ${
                  billingCycle === "annual"
                    ? "bg-blue-600 text-white"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Annual <span className="opacity-75">(save ~24%)</span>
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            {PLANS.map((p) => {
              const checked = planId === p.id;
              return (
                <label
                  key={p.id}
                  className={`flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition ${
                    checked
                      ? "border-blue-500 bg-blue-50"
                      : "border-slate-200 hover:border-slate-300 hover:bg-slate-50"
                  } ${submitting ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <input
                    type="radio"
                    name="plan"
                    value={p.id}
                    checked={checked}
                    disabled={submitting}
                    onChange={() => setPlanId(p.id)}
                    className="mt-1 accent-blue-600"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="font-semibold text-sm text-slate-900">
                        {p.name}
                      </div>
                      <div className="text-sm font-semibold text-slate-900 whitespace-nowrap">
                        {priceLabel(p)}
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {p.blurb}
                      <span className="ml-1.5 text-slate-400">
                        + ${fmt(p.setup)} one-time setup
                      </span>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {error && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="flex gap-2 p-6 pt-5">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 border border-slate-300 text-slate-700 rounded-lg font-medium hover:bg-slate-50 disabled:opacity-50"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={
              submitting ||
              !businessName.trim() ||
              !industry ||
              !planId
            }
            className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Redirecting to Stripe…
              </>
            ) : (
              <>Continue to Payment{selectedPlan ? ` — ${selectedPlan.name}` : ""}</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
