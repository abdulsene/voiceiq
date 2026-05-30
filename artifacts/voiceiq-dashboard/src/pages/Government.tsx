import { useState } from "react";
import {
  Zap,
  ArrowRight,
  Globe,
  Clock,
  Shield,
  DollarSign,
  ExternalLink,
  Check,
  Loader2,
} from "lucide-react";
import LandingNav from "../components/LandingNav";

const USE_CASES = [
  {
    icon: "🪪",
    title: "DMV / Motor Vehicles",
    description: "Schedule appointments, answer document requirement questions, check wait times, handle license and registration inquiries",
  },
  {
    icon: "🏛️",
    title: "City & Municipal Offices",
    description: "Route citizen inquiries to correct departments, handle permit questions, payment information, and complaint intake",
  },
  {
    icon: "🏢",
    title: "County Government",
    description: "Property tax inquiries, business licensing, voter registration, health services, and public records requests",
  },
  {
    icon: "👮",
    title: "Police Non-Emergency",
    description: "Handle non-emergency reports, records requests, parking complaints — always escalating life-threatening situations to 911",
  },
  {
    icon: "🎓",
    title: "Public Schools K-12",
    description: "Attendance reporting, enrollment inquiries, department routing, parent communications — 24/7",
  },
  {
    icon: "📚",
    title: "Public Libraries",
    description: "Hours, card registration, holds and renewals, program registration, room reservations",
  },
  {
    icon: "🚌",
    title: "Public Transit",
    description: "Trip planning, route information, fares, accessibility services, lost and found, service alerts",
  },
  {
    icon: "⚡",
    title: "Utilities — Electric, Gas, Water",
    description: "Outage reporting, billing inquiries, new service, emergency response (gas leaks = immediate escalation)",
  },
];

const FEATURES = [
  {
    icon: Globe,
    title: "Multilingual by Default",
    description: "32 languages supported. Handles any citizen in their native language automatically — no interpreter line needed.",
    color: "bg-blue-100 text-blue-600",
  },
  {
    icon: Clock,
    title: "24/7 Availability",
    description: "Citizens with jobs can't call during government hours. Neverr answers nights, weekends, and holidays.",
    color: "bg-purple-100 text-purple-600",
  },
  {
    icon: Shield,
    title: "Compliance Ready",
    description: "Call recording, audit trails, FOIA-compliant logging, ADA accessibility — built for public sector requirements.",
    color: "bg-green-100 text-green-600",
  },
  {
    icon: DollarSign,
    title: "Dramatic Cost Reduction",
    description: "Government call centers cost $8–15 per call. Neverr costs $0.50–2.00 per interaction — a 90%+ savings.",
    color: "bg-amber-100 text-amber-600",
  },
];

const PRICING = [
  {
    tier: "Municipal",
    price: "$999",
    period: "/mo",
    description: "Single department or small city office",
    features: ["Up to 5,000 calls/month", "32 languages", "FOIA export tools", "Email support", "1 department"],
    cta: "Request Pricing",
    highlight: false,
  },
  {
    tier: "County / Agency",
    price: "$2,999",
    period: "/mo",
    description: "Full county or state agency",
    features: ["Unlimited calls", "Compliance package", "Multi-department routing", "Dedicated account manager", "Custom integrations"],
    cta: "Request Pricing",
    highlight: true,
  },
  {
    tier: "Enterprise Government",
    price: "Custom",
    period: "",
    description: "Multi-department, state-level, federal",
    features: ["Unlimited everything", "Full procurement support", "On-premise options", "SLA guarantees", "Federal compliance (FedRAMP path)"],
    cta: "Contact Sales",
    highlight: false,
  },
];

export default function Government() {
  const [demoLoading, setDemoLoading] = useState(false);

  const handleDmvDemo = async () => {
    setDemoLoading(true);
    try {
      const r = await fetch("/api/demo/dmv_office/login", { method: "POST", headers: { "Content-Type": "application/json" } });
      const d = await r.json();
      if (d.success && d.session) {
        localStorage.setItem("neverr_token", d.session.access_token);
        localStorage.setItem("neverr_refresh", d.session.refresh_token);
        localStorage.setItem("neverr_business_id", d.business_id);
        localStorage.setItem("neverr_active_business_id", d.business_id);
        window.location.href = "/dashboard";
      } else {
        alert("DMV demo not available yet — check back soon!");
      }
    } catch {
      alert("Connection error. Please try again.");
    }
    setDemoLoading(false);
  };

  return (
    <div className="min-h-screen bg-white -mt-0">
      {/* Sprint 2 STEP 2 (BUG-13): page was bare — no nav at all. Adding
          LandingNav makes /government consistent with the rest of the
          marketing site. The dark hero immediately below renders cleanly
          against LandingNav's white sticky header (same pattern as /demo
          after Sprint 2 STEP 1). */}
      <LandingNav />

      <section className="bg-[#1B2537] text-white py-20 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-amber-500/20 text-amber-300 rounded-full text-sm font-semibold mb-6">
            <Zap className="w-4 h-4" />
            Zero competitors in this market
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-5 leading-tight">
            AI Communications for Government<br />& Public Institutions
          </h1>
          <p className="text-lg text-gray-300 max-w-3xl mx-auto mb-12">
            Neverr is the first AI communications platform purpose-built for government agencies,
            public institutions, and civic organizations — handling citizen inquiries 24/7 in any language.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
            {[
              { value: "$21B+", label: "US government call center market" },
              { value: "47 min", label: "Average DMV wait time" },
              { value: "35–55%", label: "Call abandonment rate at agencies" },
              { value: "ZERO", label: "Competitors targeting this market" },
            ].map((stat) => (
              <div key={stat.label} className="bg-white/10 backdrop-blur rounded-xl p-5">
                <p className="text-2xl md:text-3xl font-extrabold text-white">{stat.value}</p>
                <p className="text-xs text-gray-400 mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-gray-50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-3">Government Use Cases</h2>
            <p className="text-gray-500 max-w-2xl mx-auto">
              Purpose-built AI for every type of government institution — from your local DMV to state-level agencies.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {USE_CASES.map((uc) => (
              <div key={uc.title} className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-lg hover:border-[#2E75B6]/30 transition-all">
                <span className="text-3xl mb-3 block">{uc.icon}</span>
                <h3 className="text-base font-bold text-gray-900 mb-2">{uc.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{uc.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-3">Why Government Chooses Neverr</h2>
            <p className="text-gray-500">Built from the ground up for public sector requirements.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {FEATURES.map((feat) => {
              const Icon = feat.icon;
              return (
                <div key={feat.title} className="flex gap-4 p-6 bg-gray-50 rounded-xl border border-gray-100">
                  <div className={`w-12 h-12 rounded-xl ${feat.color} flex items-center justify-center shrink-0`}>
                    <Icon className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-gray-900 mb-1">{feat.title}</h3>
                    <p className="text-sm text-gray-600 leading-relaxed">{feat.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-gray-50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-3">Government Pricing</h2>
            <p className="text-gray-500">Transparent pricing designed for public sector procurement.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {PRICING.map((plan) => (
              <div
                key={plan.tier}
                className={`rounded-xl p-6 ${
                  plan.highlight
                    ? "bg-[#1B2537] text-white border-2 border-[#2E75B6] shadow-xl shadow-[#2E75B6]/20 relative"
                    : "bg-white border border-gray-200"
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 bg-[#2E75B6] text-white text-xs font-semibold rounded-full">
                    Most Popular
                  </div>
                )}
                <h3 className={`text-lg font-bold mb-1 ${plan.highlight ? "text-white" : "text-gray-900"}`}>
                  {plan.tier}
                </h3>
                <p className={`text-sm mb-4 ${plan.highlight ? "text-gray-300" : "text-gray-500"}`}>
                  {plan.description}
                </p>
                <div className="mb-6">
                  <span className={`text-4xl font-extrabold ${plan.highlight ? "text-white" : "text-gray-900"}`}>
                    {plan.price}
                  </span>
                  <span className={`text-sm ${plan.highlight ? "text-gray-400" : "text-gray-500"}`}>
                    {plan.period}
                  </span>
                </div>
                <ul className="space-y-2.5 mb-6">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2">
                      <Check className={`w-4 h-4 mt-0.5 shrink-0 ${plan.highlight ? "text-[#2E75B6]" : "text-green-500"}`} />
                      <span className={`text-sm ${plan.highlight ? "text-gray-300" : "text-gray-600"}`}>{f}</span>
                    </li>
                  ))}
                </ul>
                <a
                  href="mailto:government@neverr.ai"
                  className={`block text-center py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    plan.highlight
                      ? "bg-[#2E75B6] text-white hover:bg-[#2563a0]"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>

          <div className="text-center mt-8">
            <a
              href="mailto:government@neverr.ai"
              className="inline-flex items-center gap-2 px-6 py-3 bg-[#2E75B6] text-white text-base font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-lg shadow-[#2E75B6]/20"
            >
              Request Government Pricing <ArrowRight className="w-5 h-5" />
            </a>
          </div>
        </div>
      </section>

      <section className="py-20 px-6 bg-gradient-to-b from-[#1B2537] to-[#2a3f5f] text-white">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl font-bold mb-3">Experience Our DMV Demo</h2>
          <p className="text-gray-300 mb-8 max-w-2xl mx-auto">
            See how Neverr handles real DMV citizen inquiries — appointment scheduling, document requirements,
            wait times, and more. Log into the dashboard to see calls analyzed in real time.
          </p>

          <div className="inline-flex items-center gap-3 px-5 py-3 bg-white/10 rounded-xl mb-8">
            <span className="text-gray-400 text-sm">DMV Demo Line:</span>
            <span className="text-white font-semibold text-lg tracking-wide">Coming Soon</span>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={handleDmvDemo}
              disabled={demoLoading}
              className="flex items-center gap-2 px-6 py-3 bg-[#2E75B6] text-white text-base font-semibold rounded-xl hover:bg-[#2563a0] transition-colors disabled:opacity-60 shadow-lg shadow-[#2E75B6]/30"
            >
              {demoLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Loading DMV Dashboard...
                </>
              ) : (
                <>
                  <ExternalLink className="w-5 h-5" />
                  View DMV Dashboard
                </>
              )}
            </button>
            <a
              href="/demo"
              className="flex items-center gap-2 px-6 py-3 bg-white/10 text-white text-base font-semibold rounded-xl hover:bg-white/20 transition-colors"
            >
              Browse All Demos <ArrowRight className="w-5 h-5" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
