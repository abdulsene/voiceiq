import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import { getDiscoveryCallUrl } from "../lib/cta";

const CONTACT_HREF = getDiscoveryCallUrl();

const FEATURE_EMOJIS = ["🏢", "🔐", "🌐", "📋", "⏰", "📜"];
const INDUSTRY_EMOJIS = ["🏥", "🏛️", "🍕", "⚖️", "🔧", "🏢"];
const INTEGRATION_KEYS = ["identity", "telephony", "crm"] as const;
const INTEGRATION_ITEMS: Record<(typeof INTEGRATION_KEYS)[number], string[]> = {
  identity: ["SAML 2.0 SSO", "Okta", "Azure AD", "Auth0", "Google Workspace", "OneLogin"],
  telephony: ["Twilio (SOC 2, HITRUST)", "Number porting available", "Multi-line per location"],
  crm: ["HubSpot", "Salesforce (via webhook)", "Google Calendar", "Microsoft 365", "Calendly"],
};

function FaqItem({ q, a, defaultOpen }: { q: string; a: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="text-base font-semibold text-slate-900">{q}</span>
        <ChevronDown
          className={`w-5 h-5 text-slate-400 flex-shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="px-5 pb-5 -mt-1 text-sm text-slate-600 leading-relaxed">{a}</div>
      )}
    </div>
  );
}

export default function EnterprisePage() {
  const { t } = useTranslation();
  const features = (t("marketing.enterprise.features", { returnObjects: true }) as { title: string; body: string }[]) || [];
  const live = (t("marketing.enterprise.complianceLive", { returnObjects: true }) as string[]) || [];
  const roadmap = (t("marketing.enterprise.complianceRoadmap", { returnObjects: true }) as string[]) || [];
  const steps = (t("marketing.enterprise.rolloutSteps", { returnObjects: true }) as { title: string; body: string }[]) || [];
  const industries = (t("marketing.enterprise.industries", { returnObjects: true }) as { title: string; body: string }[]) || [];
  const faqs = (t("marketing.enterprise.faqs", { returnObjects: true }) as { q: string; a: string }[]) || [];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />

      <section className="px-6 pt-16 pb-12 md:pt-24 md:pb-16">
        <div className="max-w-5xl mx-auto text-center">
          <p className="text-xs font-mono text-indigo-600 mb-4 tracking-wider">
            {t("marketing.enterprise.hero.eyebrow")}
          </p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900 mb-5 leading-tight">
            {t("marketing.enterprise.hero.headline")}
          </h1>
          <p className="text-base md:text-lg text-slate-600 max-w-3xl mx-auto">
            {t("marketing.enterprise.hero.subhead")}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
            <Link
              href={CONTACT_HREF}
              className="px-5 py-3 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors flex items-center gap-1.5"
            >
              {t("marketing.enterprise.hero.ctaPrimary")} <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="px-5 py-3 bg-white text-slate-700 border border-slate-300 rounded-lg text-sm font-semibold hover:bg-slate-50 transition-colors"
            >
              {t("marketing.enterprise.hero.ctaSecondary")}
            </Link>
          </div>
        </div>
      </section>

      <section className="bg-slate-900 text-slate-200 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-6 py-5">
          <p className="text-center text-[11px] md:text-xs font-mono tracking-wider uppercase text-slate-300 leading-relaxed">
            <span className="text-white font-semibold">{t("marketing.enterprise.trustStrip.locations")}</span>
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.saml")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.ipAllow")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.audit")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.retention")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.soc2")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.baa")}
            <span className="mx-2 text-slate-600">·</span>
            {t("marketing.enterprise.trustStrip.contracts")}
          </p>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.featuresHeading")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((f, i) => (
              <div
                key={i}
                className="bg-white rounded-xl border border-slate-200 p-6 hover:border-blue-400 hover:shadow-lg transition-all"
              >
                <div className="flex items-start gap-3 mb-3">
                  <span className="text-2xl flex-shrink-0" aria-hidden="true">{FEATURE_EMOJIS[i] ?? "✦"}</span>
                  <h3 className="text-lg font-bold text-slate-900 leading-tight">{f.title}</h3>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-slate-50/60 border-y border-slate-200/70">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.complianceHeading")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              <h3 className="text-sm font-mono text-emerald-700 uppercase tracking-wider mb-4">
                {t("marketing.enterprise.complianceLiveLabel")}
              </h3>
              <ul className="space-y-2.5">
                {live.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-slate-700">
                    <span className="text-emerald-600 font-bold mt-0.5 flex-shrink-0" aria-hidden="true">✓</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-6">
              <h3 className="text-sm font-mono text-amber-700 uppercase tracking-wider mb-4">
                {t("marketing.enterprise.complianceRoadmapLabel")}
              </h3>
              <ul className="space-y-2.5">
                {roadmap.map((item) => (
                  <li key={item} className="flex items-start gap-2.5 text-sm text-slate-700">
                    <span className="text-amber-600 mt-0.5 flex-shrink-0" aria-hidden="true">⏳</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="mt-6 text-sm text-slate-600 max-w-3xl mx-auto text-center leading-relaxed">
            {t("marketing.enterprise.complianceFooter")}
          </p>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.rolloutHeading")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {steps.map((s, i) => (
              <div
                key={i}
                className="bg-white rounded-xl border border-slate-200 p-6 hover:border-blue-400 hover:shadow-lg transition-all"
              >
                <div className="text-xs font-mono text-indigo-600 mb-3 tracking-wider">
                  {t("marketing.enterprise.rolloutStepLabel", { num: String(i + 1).padStart(2, "0") })}
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2">{s.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{s.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-slate-600 max-w-3xl mx-auto">
            {t("marketing.enterprise.rolloutFooter")}
          </p>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-slate-50/60 border-y border-slate-200/70">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.industriesHeading")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {industries.map((it, i) => (
              <div
                key={i}
                className="bg-white rounded-xl border border-slate-200 p-6 hover:border-blue-400 hover:shadow-lg transition-all"
              >
                <div className="flex items-start gap-3 mb-3">
                  <span className="text-2xl flex-shrink-0" aria-hidden="true">{INDUSTRY_EMOJIS[i] ?? "✦"}</span>
                  <h3 className="text-lg font-bold text-slate-900 leading-tight">{it.title}</h3>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed">{it.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.integrationsHeading")}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {INTEGRATION_KEYS.map((key) => (
              <div key={key} className="bg-white rounded-xl border border-slate-200 p-6">
                <h3 className="text-sm font-mono text-indigo-600 uppercase tracking-wider mb-4">
                  {t(`marketing.enterprise.integrationsHeadings.${key}`)}
                </h3>
                <ul className="space-y-2">
                  {INTEGRATION_ITEMS[key].map((it) => (
                    <li key={it} className="text-sm text-slate-700">{it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-6 text-center text-sm text-slate-600 max-w-3xl mx-auto">
            {t("marketing.enterprise.integrationsFooter")}
          </p>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-slate-50/60 border-y border-slate-200/70">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 text-center mb-10">
            {t("marketing.enterprise.faqHeading")}
          </h2>
          <div className="space-y-3">
            {faqs.map((f, idx) => (
              <FaqItem key={idx} q={f.q} a={f.a} defaultOpen={idx === 0} />
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20">
        <div className="max-w-7xl mx-auto">
          <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-8 md:p-12 text-center text-white">
            <h2 className="text-3xl md:text-4xl font-bold mb-3">{t("marketing.enterprise.finalCta.headline")}</h2>
            <p className="text-blue-100 mb-6 max-w-2xl mx-auto">
              {t("marketing.enterprise.finalCta.subhead")}
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link
                href={CONTACT_HREF}
                className="inline-flex items-center gap-2 px-6 py-3 bg-white text-blue-700 rounded-lg font-semibold hover:bg-blue-50 transition-colors shadow-md"
              >
                {t("marketing.enterprise.finalCta.ctaPrimary")} <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="mailto:enterprise@neverr.ai"
                className="inline-flex items-center gap-2 px-6 py-3 bg-blue-700/30 text-white border border-blue-300/40 rounded-lg font-semibold hover:bg-blue-700/50 transition-colors"
              >
                {t("marketing.enterprise.finalCta.ctaSecondary")}
              </a>
            </div>
            <p className="mt-6 text-sm text-blue-100/90">
              {t("marketing.enterprise.finalCta.footer")}
            </p>
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
