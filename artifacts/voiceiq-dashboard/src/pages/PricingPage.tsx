import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowRight, Check, X } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import { getDiscoveryCallUrl } from "../lib/cta";

const API = window.location.origin + "/api";

interface SmbPlan {
  id: string;
  price: number;
  setup: number;
  annual: number;
  minutes: string;
  locations: string;
  sms: string;
  support: string;
  popular: boolean;
  ctaStyle: "outline" | "filled" | "filled-dark";
  badge?: string;
}

const SMB_PLANS: SmbPlan[] = [
  { id: "essential", price: 149, setup: 99, annual: 1350, minutes: "120 min", locations: "1 location", sms: "100 SMS/mo", support: "Email only 72hr", popular: false, ctaStyle: "outline" },
  { id: "starter", price: 349, setup: 199, annual: 3190, minutes: "750 min", locations: "1 location", sms: "500 SMS/mo", support: "Email 48hr", popular: false, ctaStyle: "outline" },
  { id: "professional", price: 749, setup: 499, annual: 6850, minutes: "2,500 min", locations: "1 location", sms: "2,000 SMS/mo", support: "Email + chat 24hr", popular: true, ctaStyle: "filled" },
  { id: "growth", price: 999, setup: 799, annual: 9990, badge: "NEW", minutes: "4,000 min", locations: "2 locations", sms: "5,000 SMS/mo", support: "Priority 8hr", popular: false, ctaStyle: "outline" },
  { id: "business", price: 1499, setup: 999, annual: 13750, minutes: "6,000 min", locations: "3 locations", sms: "10,000 SMS/mo", support: "Priority 4hr", popular: false, ctaStyle: "outline" },
  { id: "enterprise", price: 3499, setup: 2499, annual: 32000, minutes: "15,000 min", locations: "4 locations", sms: "30,000 SMS/mo", support: "Dedicated 1hr SLA", popular: false, ctaStyle: "filled-dark" },
];

const FRANCHISE_PLANS = [
  { id: "starter", price: 4999, setup: 4999, annual: 45000, minutes: "20,000 min", locations: "5–10 locations", sms: "50,000 SMS/mo" },
  { id: "pro", price: 6999, setup: 6999, annual: 64000, minutes: "60,000 min", locations: "11–20 locations", sms: "150,000 SMS/mo" },
  { id: "enterprise", price: 0, setup: 0, annual: 0, minutes: "Unlimited", locations: "21+ locations", sms: "Unlimited" },
];

const VOLUME_TIERS = [
  { id: "starter", price: "$7,499/mo", setup: "$7,499 setup", minutes: "40,000 min", locations: "Up to 3 locations", range: "10K–25K calls/mo" },
  { id: "pro", price: "$14,999/mo", setup: "$14,999 setup", minutes: "100,000 min", locations: "Up to 10 locations", range: "25K–75K calls/mo" },
  { id: "enterprise", price: "Custom", setup: "Custom", minutes: "Unlimited", locations: "Unlimited", range: "75K+ calls/mo" },
];

const OVERAGE_TABLE = [
  { plan: "Essential", mins: "120 min", minOver: "$0.15/min", sms: "100 SMS", smsOver: "$0.035/SMS" },
  { plan: "Starter", mins: "750 min", minOver: "$0.12/min", sms: "500 SMS", smsOver: "$0.035/SMS" },
  { plan: "Professional", mins: "2,500 min", minOver: "$0.10/min", sms: "2,000 SMS", smsOver: "$0.030/SMS" },
  { plan: "Growth", mins: "4,000 min", minOver: "$0.09/min", sms: "5,000 SMS", smsOver: "$0.025/SMS" },
  { plan: "Business", mins: "6,000 min", minOver: "$0.08/min", sms: "10,000 SMS", smsOver: "$0.020/SMS" },
  { plan: "Enterprise", mins: "15,000 min", minOver: "$0.06/min", sms: "30,000 SMS", smsOver: "$0.015/SMS" },
  { plan: "Franchise Starter", mins: "20,000 min", minOver: "$0.05/min", sms: "50,000 SMS", smsOver: "$0.012/SMS" },
  { plan: "Franchise Pro", mins: "60,000 min", minOver: "$0.04/min", sms: "150,000 SMS", smsOver: "$0.010/SMS" },
];

function PricingSection() {
  const { t, i18n } = useTranslation();
  const [annual, setAnnual] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const lng = i18n.resolvedLanguage || i18n.language || "en";
  const fmt = (n: number) =>
    n.toLocaleString(lng.startsWith("fr") ? "fr-CA" : lng.startsWith("es") ? "es-MX" : "en-US");

  async function handleGetStarted(planId: string) {
    const billingCycle = annual ? "annual" : "monthly";
    const token = localStorage.getItem("neverr_token");
    if (!token) {
      window.location.href = `/signup?plan=${planId}&cycle=${billingCycle}`;
      return;
    }
    const businessId =
      localStorage.getItem("neverr_active_business_id") ||
      localStorage.getItem("neverr_business_id");
    const email = localStorage.getItem("neverr_email");
    if (!businessId || !email) {
      window.location.href = `/signup?plan=${planId}&cycle=${billingCycle}`;
      return;
    }
    setLoadingPlan(planId);
    try {
      const r = await fetch(`${API}/stripe/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ planId, billingCycle, businessId, email }),
      });
      const data = await r.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert(data.error || t("marketing.pricing.errors.checkoutFailed"));
        setLoadingPlan(null);
      }
    } catch {
      alert(t("marketing.pricing.errors.network"));
      setLoadingPlan(null);
    }
  }

  const stages = (t("marketing.pricing.firstWeek.stages", { returnObjects: true }) as { stage: string; label: string; all: string; pro: string; ent: string }[]) || [];

  return (
    <>
      <section className="py-20 px-6 bg-gray-50" id="pricing">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-6">
            <h2 className="text-3xl md:text-4xl font-bold text-[#1B2537] mb-2">{t("marketing.pricing.title")}</h2>
            <p className="text-gray-500 text-lg mb-2">{t("marketing.pricing.subtitle")}</p>
            <p className="text-sm text-gray-400">{t("marketing.pricing.noSalesCall")}</p>
          </div>

          <div className="flex items-center justify-center gap-3 mb-12">
            <span className={`text-sm font-medium ${!annual ? "text-[#1B2537]" : "text-gray-400"}`}>{t("marketing.pricing.monthly")}</span>
            <button onClick={() => setAnnual(!annual)} className={`relative w-12 h-6 rounded-full transition-colors ${annual ? "bg-[#2E75B6]" : "bg-gray-300"}`}>
              <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${annual ? "translate-x-6" : "translate-x-0.5"}`} />
            </button>
            <span className={`text-sm font-medium ${annual ? "text-[#1B2537]" : "text-gray-400"}`}>{t("marketing.pricing.annual")}</span>
            {annual && <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-semibold">{t("marketing.pricing.monthFree")}</span>}
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {SMB_PLANS.map(plan => {
              const displayPrice = annual ? Math.round(plan.annual / 12) : plan.price;
              const features = (t(`marketing.pricing.plans.${plan.id}.features`, { returnObjects: true }) as string[]) || [];
              const notIncluded = (t(`marketing.pricing.plans.${plan.id}.notIncluded`, { returnObjects: true }) as string[]) || [];
              return (
                <div key={plan.id} className={`relative bg-white rounded-2xl p-6 text-left border-2 transition-all flex flex-col ${plan.popular ? "border-[#2E75B6] shadow-xl shadow-[#2E75B6]/10 scale-[1.01]" : "border-gray-200 hover:border-gray-300"}`}>
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-[#2E75B6] text-white text-[10px] font-bold rounded-full uppercase tracking-wider">{t("marketing.pricing.popularBadge")}</div>
                  )}
                  {plan.badge && (
                    <div className="absolute -top-3 right-4 px-2.5 py-0.5 bg-green-500 text-white text-[10px] font-bold rounded-full uppercase tracking-wider">{plan.badge}</div>
                  )}
                  <h3 className="text-lg font-bold text-[#1B2537] mb-1">{t(`marketing.pricing.plans.${plan.id}.name`)}</h3>
                  <div className="flex items-baseline gap-1 mb-1">
                    <span className="text-3xl font-extrabold text-[#1B2537]">${fmt(displayPrice)}</span>
                    <span className="text-sm text-gray-400">{t("marketing.pricing.perMonth")}</span>
                  </div>
                  <p className="text-xs text-gray-400 mb-4">
                    {annual
                      ? t("marketing.pricing.perYear", { annual: `$${fmt(plan.annual)}`, savings: `$${fmt(plan.price * 12 - plan.annual)}` })
                      : t("marketing.pricing.setupSuffix", { setup: `$${fmt(plan.setup)}` })}
                  </p>
                  <div className="flex flex-wrap gap-2 mb-4">
                    <span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-md font-medium">{plan.minutes}</span>
                    <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium">{plan.locations}</span>
                    <span className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded-md font-medium">{plan.sms}</span>
                  </div>
                  <ul className="space-y-2 mb-4 flex-1">
                    {features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                        <Check className="w-3.5 h-3.5 text-[#2E75B6] shrink-0 mt-0.5" />{f}
                      </li>
                    ))}
                    {notIncluded.map(f => (
                      <li key={f} className="flex items-start gap-2 text-sm text-gray-400">
                        <X className="w-3.5 h-3.5 text-gray-300 shrink-0 mt-0.5" />{f}
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-gray-400 mb-3">{plan.support}</p>
                  {(() => {
                    if (plan.id === "enterprise") {
                      return (
                        <Link
                          href={getDiscoveryCallUrl()}
                          className={`block text-center w-full py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                            plan.ctaStyle === "filled-dark" ? "bg-[#1B2537] text-white hover:bg-[#2a3a52]"
                            : "bg-[#2E75B6] text-white hover:bg-[#2563a0]"
                          }`}
                        >
                          {t("marketing.pricing.ctaBookCall")}
                        </Link>
                      );
                    }
                    const isLoading = loadingPlan === plan.id;
                    return (
                      <button
                        type="button"
                        onClick={() => handleGetStarted(plan.id)}
                        disabled={isLoading}
                        className={`block text-center w-full py-2.5 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                          plan.ctaStyle === "filled" ? "bg-[#2E75B6] text-white hover:bg-[#2563a0]"
                          : plan.ctaStyle === "filled-dark" ? "bg-[#1B2537] text-white hover:bg-[#2a3a52]"
                          : "border-2 border-gray-200 text-gray-700 hover:border-[#2E75B6] hover:text-[#2E75B6]"
                        }`}
                      >
                        {isLoading ? t("marketing.pricing.loading") : t("marketing.pricing.getStarted")}
                      </button>
                    );
                  })()}
                </div>
              );
            })}
          </div>

          <div className="mt-12 bg-white border border-gray-200 rounded-2xl p-6 text-center">
            <div className="flex flex-wrap items-center justify-center gap-6 text-sm text-gray-600">
              <span>{t("marketing.pricing.guarantees.moneyBack")}</span>
              <span>{t("marketing.pricing.guarantees.noContracts")}</span>
              <span>{t("marketing.pricing.guarantees.goLive")}</span>
              <span>{t("marketing.pricing.guarantees.languages")}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-white border-t border-gray-100">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold text-[#1B2537] mb-2">{t("marketing.pricing.firstWeek.title")}</h2>
            <p className="text-gray-500 text-lg max-w-2xl mx-auto">
              {t("marketing.pricing.firstWeek.subtitle")}
            </p>
          </div>

          <div className="space-y-6">
            {stages.map((row) => (
              <div key={row.stage} className="bg-white border border-gray-200 rounded-2xl p-6">
                <div className="flex items-baseline gap-3 mb-4 pb-4 border-b border-gray-100">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#2E75B6] whitespace-nowrap">{row.stage}</span>
                  <h3 className="text-lg font-bold text-[#1B2537]">{row.label}</h3>
                </div>
                <div className="grid md:grid-cols-3 gap-5">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">{t("marketing.pricing.firstWeek.allPlans")}</div>
                    <p className="text-sm text-gray-600 leading-relaxed">{row.all}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#2E75B6] mb-2">{t("marketing.pricing.firstWeek.professionalPlus")}</div>
                    <p className="text-sm text-gray-700 leading-relaxed">{row.pro}</p>
                  </div>
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#1B2537] mb-2">{t("marketing.pricing.firstWeek.enterpriseBusiness")}</div>
                    <p className="text-sm text-gray-700 leading-relaxed">{row.ent}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="text-sm text-gray-500 mt-8 text-center max-w-3xl mx-auto">
            {t("marketing.pricing.firstWeek.footer")}
          </p>
        </div>
      </section>

      <section className="py-20 px-6 bg-amber-50/50 border-t border-amber-200/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-amber-600 font-semibold text-sm uppercase tracking-wider mb-2">{t("marketing.pricing.franchise.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold text-[#1B2537] mb-2">{t("marketing.pricing.franchise.title")}</h2>
            <p className="text-gray-500 text-lg">{t("marketing.pricing.franchise.subtitle")}</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            {FRANCHISE_PLANS.map(plan => {
              const features = (t(`marketing.pricing.franchisePlans.${plan.id}.features`, { returnObjects: true }) as string[]) || [];
              return (
              <div key={plan.id} className="bg-white rounded-2xl p-6 text-left border-2 border-amber-200 hover:border-amber-400 transition-all flex flex-col">
                <h3 className="text-lg font-bold text-[#1B2537] mb-1">{t(`marketing.pricing.franchisePlans.${plan.id}.name`)}</h3>
                <div className="flex items-baseline gap-1 mb-1">
                  {plan.price > 0 ? (
                    <>
                      <span className="text-3xl font-extrabold text-[#1B2537]">${fmt(annual ? Math.round(plan.annual / 12) : plan.price)}</span>
                      <span className="text-sm text-gray-400">{t("marketing.pricing.perMonth")}</span>
                    </>
                  ) : (
                    <span className="text-3xl font-extrabold text-[#1B2537]">{t("marketing.pricing.customPrice")}</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mb-4">
                  {plan.price > 0
                    ? (annual ? `$${fmt(plan.annual)}/yr` : t("marketing.pricing.setupSuffix", { setup: `$${fmt(plan.setup)}` }))
                    : t("marketing.pricing.franchise.contactPricing")}
                </p>
                <div className="flex flex-wrap gap-2 mb-4">
                  <span className="text-xs bg-amber-50 text-amber-700 px-2 py-1 rounded-md font-medium">{plan.minutes}</span>
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded-md font-medium">{plan.locations}</span>
                  <span className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded-md font-medium">{plan.sms}</span>
                </div>
                <ul className="space-y-2 mb-6 flex-1">
                  {features.map(f => (
                    <li key={f} className="flex items-start gap-2 text-sm text-gray-600">
                      <Check className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />{f}
                    </li>
                  ))}
                </ul>
                <Link href={getDiscoveryCallUrl()} className="block text-center w-full py-2.5 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 transition-colors">{t("marketing.pricing.franchise.contactSales")}</Link>
              </div>
            );})}
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-[#1B2537]">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-4">
            <p className="text-[#2E75B6] font-semibold text-sm uppercase tracking-wider mb-2">{t("marketing.pricing.volume.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-2">{t("marketing.pricing.volume.title")}</h2>
            <p className="text-gray-400 text-lg mb-2">{t("marketing.pricing.volume.subtitle")}</p>
            <p className="text-xs text-gray-500 bg-white/5 inline-block px-4 py-1.5 rounded-full">{t("marketing.pricing.volume.tag")}</p>
          </div>
          <div className="space-y-4 mt-10">
            {VOLUME_TIERS.map(v => (
              <div key={v.id} className="bg-white/[0.06] border border-white/10 rounded-xl p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold text-white">{t(`marketing.pricing.volumeTiers.${v.id}.name`)}</h3>
                  <p className="text-sm text-gray-400">{v.range}</p>
                </div>
                <div className="flex flex-wrap gap-4 text-sm">
                  <span className="text-white font-semibold">{v.price}</span>
                  <span className="text-gray-400">{v.setup}</span>
                  <span className="text-[#2E75B6]">{v.minutes}</span>
                  <span className="text-gray-400">{v.locations}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/contact" className="inline-flex items-center gap-2 px-8 py-3 bg-[#2E75B6] text-white font-semibold rounded-xl hover:bg-[#2563a0] transition-colors">
              {t("marketing.pricing.volume.contactSales")} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      <section className="py-16 px-6 bg-gray-50">
        <div className="max-w-5xl mx-auto">
          <h3 className="text-xl font-bold text-[#1B2537] mb-6 text-center">{t("marketing.pricing.overage.title")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b-2 border-gray-200">
                  <th className="text-left py-3 px-4 font-semibold text-[#1B2537]">{t("marketing.pricing.overage.plan")}</th>
                  <th className="text-left py-3 px-4 font-semibold text-[#1B2537]">{t("marketing.pricing.overage.includedMinutes")}</th>
                  <th className="text-left py-3 px-4 font-semibold text-[#1B2537]">{t("marketing.pricing.overage.minuteOverage")}</th>
                  <th className="text-left py-3 px-4 font-semibold text-[#1B2537]">{t("marketing.pricing.overage.includedSms")}</th>
                  <th className="text-left py-3 px-4 font-semibold text-[#1B2537]">{t("marketing.pricing.overage.smsOverage")}</th>
                </tr>
              </thead>
              <tbody>
                {OVERAGE_TABLE.map((row, i) => (
                  <tr key={row.plan} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                    <td className="py-2.5 px-4 font-medium text-[#1B2537]">{row.plan}</td>
                    <td className="py-2.5 px-4 text-gray-600">{row.mins}</td>
                    <td className="py-2.5 px-4 text-gray-600">{row.minOver}</td>
                    <td className="py-2.5 px-4 text-gray-600">{row.sms}</td>
                    <td className="py-2.5 px-4 text-gray-600">{row.smsOver}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <PricingSection />
      <LandingFooter />
    </div>
  );
}
