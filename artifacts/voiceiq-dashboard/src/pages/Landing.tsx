import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import NeverrVoiceWidget from "../components/NeverrVoiceWidget";
import EarlyAccessSection from "../components/EarlyAccessSection";
import {
  Sparkles, ArrowRight, Check, Clock,
  Briefcase, Heart, Wrench, Scale, Zap,
} from "lucide-react";
import { INDUSTRIES } from "../data/featured-industries";
import { getDiscoveryCallUrl } from "../lib/cta";

const HERO_KEYS = ["plumbing", "dental", "legal", "hvac"] as const;
type HeroKey = (typeof HERO_KEYS)[number];

const HERO_ICONS: Record<HeroKey, any> = {
  plumbing: Wrench,
  dental: Heart,
  legal: Scale,
  hvac: Zap,
};
const HERO_CALLERS: Record<HeroKey, string> = {
  plumbing: "+1 (415) ••• 0918",
  dental: "+1 (212) ••• 4471",
  legal: "+1 (305) ••• 8821",
  hvac: "+1 (713) ••• 0044",
};
const FEATURE_GRADIENTS = ["from-blue-500 to-cyan-500", "from-teal-500 to-emerald-500", "from-amber-500 to-orange-500", "from-pink-500 to-rose-500"];
const FEATURE_SLUGS = ["plumbers", "dental-practices", "law-firms", "med-spas"];
const FEATURE_ICONS = [
  <svg key="p" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <path d="M8 6 L8 14 L14 14 L14 26 L20 26 L20 14 L26 14 L26 6 L20 6 L20 12 L14 12 L14 6 Z" fill="white" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>,
  <svg key="d" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <path d="M11 6 C8 6 6 8 6 12 C6 18 8 22 10 26 C11 28 13 28 13 25 L13 18 C13 17 14 17 14 17 L18 17 C18 17 19 17 19 18 L19 25 C19 28 21 28 22 26 C24 22 26 18 26 12 C26 8 24 6 21 6 C18 6 17 8 16 8 C15 8 14 6 11 6 Z" fill="white" stroke="white" strokeWidth="1" strokeLinejoin="round"/>
  </svg>,
  <svg key="l" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <path d="M16 4 L16 28 M8 8 L24 8 M6 16 L10 16 L8 22 C8 23 9 24 10 24 C11 24 12 23 12 22 L10 16 M22 16 L26 16 L24 22 C24 23 25 24 26 24 C27 24 28 23 28 22 L26 16" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  </svg>,
  <svg key="m" width="32" height="32" viewBox="0 0 32 32" fill="none">
    <path d="M22 4 L28 10 L24 14 L20 10 Z M20 10 L8 22 L4 28 L10 24 L22 12 Z" fill="white" stroke="white" strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>,
];
const STEP_ICONS = [Briefcase, Clock, Sparkles];

interface HeroIndustryT {
  label: string;
  bookedLabel: string;
  bookedSubtitle: string;
  msg1: string;
  msg2: string;
  msg3: string;
  handoff: string;
}

interface SampleCallT {
  industry: string;
  caller: string;
  response: string;
}

export default function Landing() {
  const { t } = useTranslation();
  const [activeIndustry, setActiveIndustry] = useState<HeroKey>("plumbing");
  const conv = t(`marketing.landing.heroIndustries.${activeIndustry}`, { returnObjects: true }) as HeroIndustryT;
  const heroMessages: { from: "caller" | "ai"; text: string }[] = [
    { from: "caller", text: conv.msg1 },
    { from: "ai", text: conv.msg2 },
    { from: "caller", text: conv.msg3 },
  ];
  const featureItems = (t("marketing.landing.features.items", { returnObjects: true }) as { title: string; desc: string }[]) || [];
  const showcaseFeatured = (t("marketing.landing.showcase.featured", { returnObjects: true }) as { name: string; stat: string; statLabel: string; pitch: string }[]) || [];
  const catalogTags = (t("marketing.landing.showcase.catalog.tags", { returnObjects: true }) as string[]) || [];
  const howSteps = (t("marketing.landing.howItWorks.steps", { returnObjects: true }) as { time: string; title: string; desc: string }[]) || [];
  const sampleCalls = (t("marketing.landing.sampleCalls.items", { returnObjects: true }) as SampleCallT[]) || [];
  const conciergeBlocks = (t("marketing.landing.concierge.blocks", { returnObjects: true }) as { title: string; desc: string }[]) || [];
  const tierFeatures = (t("marketing.landing.pricingTeaser.tierFeatures", { returnObjects: true }) as string[]) || [];

  return (
    <div className="min-h-screen bg-[#FAFAF7] text-slate-900">
      <LandingNav />

      <section className="px-6 pt-12 pb-20 md:pt-20 md:pb-28">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-50 text-indigo-700 rounded-full text-xs font-mono mb-6">
              <span className="w-1.5 h-1.5 bg-indigo-600 rounded-full animate-pulse"></span>
              {t("marketing.landing.hero.eyebrow")}
            </div>

            <h1 className="text-5xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
              {t("marketing.landing.hero.headlineLine1")}
              <br />
              {t("marketing.landing.hero.headlineLine2Prefix")}
              <span className="bg-gradient-to-r from-indigo-600 to-violet-500 bg-clip-text text-transparent">
                {t("marketing.landing.hero.headlineLine2Highlight")}
              </span>
              {t("marketing.landing.hero.headlineLine2Suffix")}
            </h1>

            <p className="text-xl md:text-2xl font-bold text-slate-900 mb-4 max-w-lg leading-tight">
              {t("marketing.landing.hero.punchline")}
            </p>
            <p className="text-lg text-slate-600 mb-8 max-w-lg leading-relaxed">
              {t("marketing.landing.hero.subhead")}
            </p>

            <div className="flex flex-col sm:flex-row gap-3 mb-4">
              <Link href="/try-your-agent" className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800 transition-colors shadow-md">
                {t("marketing.landing.hero.ctaPrimary")} <ArrowRight className="w-4 h-4" />
              </Link>
              <Link href="/signup" className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-white border border-slate-300 text-slate-900 rounded-lg font-semibold hover:bg-slate-50 transition-colors">
                {t("marketing.landing.hero.ctaSecondary")}
              </Link>
            </div>
            <p className="text-xs text-slate-500 font-mono">{t("marketing.landing.hero.ctaNote")}</p>
          </div>

          <div className="relative">
            <div className="flex items-center gap-1 mb-3 p-1 bg-slate-100 rounded-lg w-fit">
              {HERO_KEYS.map((key) => {
                const Icon = HERO_ICONS[key];
                const label = t(`marketing.landing.heroIndustries.${key}.label`);
                return (
                  <button
                    key={key}
                    onClick={() => setActiveIndustry(key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      activeIndustry === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    <Icon className="w-3 h-3" />
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between text-xs">
                <span className="text-slate-500 font-mono">{t("marketing.landing.hero.incomingPrefix")} · {HERO_CALLERS[activeIndustry]}</span>
                <span className="flex items-center gap-1.5 text-emerald-600 font-medium">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                  {t("marketing.landing.hero.liveLabel")}
                </span>
              </div>

              <div className="mx-5 mt-4 px-3 py-2 bg-slate-900 text-white rounded-lg text-xs">
                <div className="font-semibold">{conv.bookedLabel}</div>
                <div className="text-slate-300 text-[11px] mt-0.5">{conv.bookedSubtitle}</div>
              </div>

              <div className="px-5 py-4 space-y-3">
                {heroMessages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.from === "ai" ? "justify-end" : "justify-start"}`}>
                    {msg.from === "caller" && <div className="w-7 h-7 rounded-full bg-slate-200 flex-shrink-0 mr-2"></div>}
                    <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${
                      msg.from === "ai" ? "bg-indigo-100 text-slate-900 rounded-br-sm" : "bg-slate-100 text-slate-900 rounded-bl-sm"
                    }`}>
                      {msg.text}
                    </div>
                    {msg.from === "ai" && <div className="w-7 h-7 rounded-full bg-indigo-500 text-white text-xs font-bold flex items-center justify-center flex-shrink-0 ml-2">AI</div>}
                  </div>
                ))}
              </div>

              <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between">
                <div className="flex items-end gap-0.5 h-6">
                  {[0.3, 0.7, 0.5, 0.9, 0.4, 0.8, 0.6, 0.3, 0.7, 0.5, 0.9, 0.4].map((h, i) => (
                    <div key={i} className="w-0.5 bg-indigo-400 rounded-full" style={{ height: `${h * 100}%`, animation: `pulse 1.5s ease-in-out ${i * 0.1}s infinite` }} />
                  ))}
                </div>
                <span className="text-[10px] text-slate-500 font-mono">{t("marketing.landing.hero.listenLink")}</span>
              </div>

              <div className="mx-5 mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                <span className="font-semibold uppercase tracking-wide text-[10px]">{t("marketing.landing.hero.handoffLabel")}</span>
                <div className="mt-0.5">{conv.handoff}</div>
              </div>
            </div>
          </div>
        </div>
        <div data-hero-sentinel aria-hidden="true" />
      </section>

      <section className="bg-gradient-to-r from-slate-900 via-indigo-900 to-slate-900 py-10 md:py-12 overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 text-center">
          <p className="text-2xl md:text-4xl font-bold tracking-tight leading-tight">
            <span className="text-white">{t("marketing.landing.brandPromise.line1")}</span>{" "}
            <span className="text-white/70">{t("marketing.landing.brandPromise.line2")}</span>{" "}
            <span className="bg-gradient-to-r from-indigo-300 via-violet-300 to-indigo-300 bg-clip-text text-transparent">
              {t("marketing.landing.brandPromise.line3")}
            </span>
          </p>
          <p className="text-xs md:text-sm font-mono text-indigo-300 mt-4 tracking-wider uppercase">
            {t("marketing.landing.brandPromise.footer")}
          </p>
        </div>
      </section>

      <section className="border-y border-slate-200 bg-white py-4">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-center">
          <p className="text-[11px] font-mono text-slate-400 tracking-wider">
            {t("marketing.landing.trustStrip.leading")} ·{" "}
            <Link href="/multilingual" className="hover:text-indigo-600 transition-colors underline-offset-2 hover:underline">
              {t("marketing.landing.trustStrip.languagesLink")}
            </Link>
            {" "}· {t("marketing.landing.trustStrip.trailing")}
          </p>
        </div>
      </section>

      <section id="features" className="px-6 py-20">
        <div className="max-w-7xl mx-auto">
          <div className="mb-12">
            <p className="text-xs font-mono text-indigo-600 mb-2">{t("marketing.landing.features.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight max-w-2xl">
              {t("marketing.landing.features.headline")}
            </h2>
            <p className="text-slate-600 mt-3 max-w-xl">
              {t("marketing.landing.features.subhead")}
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {featureItems.map((f, i) => {
              const Icon = STEP_ICONS[i] ?? Sparkles;
              const num = String(i + 1).padStart(2, "0");
              return (
                <div key={num} className="bg-white rounded-2xl p-6 border border-slate-200 hover:border-slate-300 transition-colors">
                  <div className="flex items-start justify-between mb-4">
                    <div className="w-10 h-10 bg-indigo-50 rounded-lg flex items-center justify-center">
                      <Icon className="w-5 h-5 text-indigo-600" />
                    </div>
                    <span className="text-xs font-mono text-slate-400">{num}</span>
                  </div>
                  <h3 className="text-lg font-bold mb-2">{f.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="px-6 py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 py-20">
          <div className="flex items-center gap-3 mb-3">
            <p className="text-xs font-mono text-indigo-600">{t("marketing.landing.showcase.eyebrow")}</p>
            <div className="h-px flex-1 bg-gradient-to-r from-indigo-200 to-transparent" />
          </div>

          <div className="flex items-end justify-between gap-8 mb-3">
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight max-w-3xl">
              {t("marketing.landing.showcase.headline")}
            </h2>
          </div>
          <p className="text-lg text-slate-600 max-w-2xl mb-12">
            {t("marketing.landing.showcase.subheadPrefix")}<strong className="text-slate-900">{t("marketing.landing.showcase.subheadStrong1")}</strong>{t("marketing.landing.showcase.subheadMiddle")}<strong className="text-slate-900">{INDUSTRIES.length}{t("marketing.landing.showcase.subheadStrong2Suffix")}</strong>{t("marketing.landing.showcase.subheadEnd")}
          </p>

          <div className="mb-16">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 px-3 py-1 bg-indigo-50 rounded-full">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1L8.5 5L13 5.5L9.5 8.5L10.5 13L7 10.5L3.5 13L4.5 8.5L1 5.5L5.5 5L7 1Z" fill="#6366F1" stroke="#6366F1" strokeWidth="0.5" strokeLinejoin="round"/>
                  </svg>
                  <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                    {t("marketing.landing.showcase.spotlightedLabel")}
                  </span>
                </div>
                <span className="text-sm text-slate-500">
                  {t("marketing.landing.showcase.spotlightedCount", { count: INDUSTRIES.length })}
                </span>
              </div>
              <Link href="/industries" className="hidden md:flex items-center gap-1 text-sm font-semibold text-indigo-600 hover:text-indigo-700">
                {t("marketing.landing.showcase.seeAll", { count: INDUSTRIES.length })} <ArrowRight className="w-4 h-4" />
              </Link>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {showcaseFeatured.map((p, i) => (
                <Link
                  key={FEATURE_SLUGS[i]}
                  href={`/for/${FEATURE_SLUGS[i]}`}
                  className="group relative overflow-hidden bg-white border border-slate-200 rounded-2xl hover:border-indigo-300 hover:shadow-xl transition-all"
                >
                  <div className={`h-24 bg-gradient-to-br ${FEATURE_GRADIENTS[i]} flex items-center justify-center relative overflow-hidden`}>
                    <svg className="absolute inset-0 w-full h-full opacity-20" viewBox="0 0 100 100" preserveAspectRatio="none">
                      <defs>
                        <pattern id={`grid-${FEATURE_SLUGS[i]}`} width="10" height="10" patternUnits="userSpaceOnUse">
                          <path d="M 10 0 L 0 0 0 10" fill="none" stroke="white" strokeWidth="0.5"/>
                        </pattern>
                      </defs>
                      <rect width="100" height="100" fill={`url(#grid-${FEATURE_SLUGS[i]})`} />
                    </svg>
                    {FEATURE_ICONS[i]}
                  </div>
                  <div className="p-5">
                    <div className="text-3xl font-bold text-slate-900 mb-1">{p.stat}</div>
                    <div className="text-xs text-slate-500 mb-3 leading-snug">{p.statLabel}</div>
                    <div className="border-t border-slate-100 pt-3">
                      <div className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors mb-1">
                        {p.name}
                      </div>
                      <div className="text-xs text-slate-600 leading-relaxed">{p.pitch}</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="bg-gradient-to-br from-slate-50 to-indigo-50/30 rounded-2xl p-8 md:p-10 border border-slate-200">
            <div className="grid md:grid-cols-3 gap-8 items-center">
              <div className="md:col-span-2">
                <div className="flex items-center gap-2 mb-4">
                  <div className="flex items-center gap-2 px-3 py-1 bg-white rounded-full border border-slate-200">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <rect x="1" y="1" width="5" height="5" rx="1" fill="#64748B"/>
                      <rect x="8" y="1" width="5" height="5" rx="1" fill="#64748B"/>
                      <rect x="1" y="8" width="5" height="5" rx="1" fill="#64748B"/>
                      <rect x="8" y="8" width="5" height="5" rx="1" fill="#64748B"/>
                    </svg>
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700">
                      {t("marketing.landing.showcase.catalog.label")}
                    </span>
                  </div>
                  <span className="text-sm text-slate-500">{t("marketing.landing.showcase.catalog.moreSuffix")}</span>
                </div>
                <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mb-3">
                  {t("marketing.landing.showcase.catalog.headline")}
                </h3>
                <p className="text-slate-600 leading-relaxed mb-5 max-w-2xl">
                  {t("marketing.landing.showcase.catalog.subheadPrefix")}{INDUSTRIES.length}{t("marketing.landing.showcase.catalog.subheadMiddle")}
                </p>
                <div className="flex flex-wrap gap-2">
                  {catalogTags.map((cat, i) => (
                    <span
                      key={cat}
                      className={`text-xs px-3 py-1.5 rounded-full ${
                        i === catalogTags.length - 1 ? "bg-indigo-600 text-white font-semibold" : "bg-white border border-slate-200 text-slate-700"
                      }`}
                    >
                      {cat}
                    </span>
                  ))}
                </div>
              </div>

              <div className="hidden md:block">
                <svg viewBox="0 0 200 200" className="w-full h-auto">
                  <defs>
                    <pattern id="catalog-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                      <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.5"/>
                    </pattern>
                    <linearGradient id="depth-gradient" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0%" stopColor="#6366F1"/>
                      <stop offset="100%" stopColor="#8B5CF6"/>
                    </linearGradient>
                  </defs>
                  <rect width="200" height="200" fill="url(#catalog-grid)"/>
                  <g transform="translate(20, 30)">
                    <rect x="0" y="0" width="60" height="80" rx="4" fill="url(#depth-gradient)" opacity="0.4"/>
                    <rect x="4" y="-4" width="60" height="80" rx="4" fill="url(#depth-gradient)" opacity="0.6"/>
                    <rect x="8" y="-8" width="60" height="80" rx="4" fill="url(#depth-gradient)" opacity="0.8"/>
                    <rect x="12" y="-12" width="60" height="80" rx="4" fill="url(#depth-gradient)"/>
                    <text x="42" y="22" textAnchor="middle" fill="white" fontSize="14" fontWeight="bold">{INDUSTRIES.length}</text>
                    <text x="42" y="38" textAnchor="middle" fill="white" fontSize="7" fontWeight="500">{t("marketing.landing.showcase.catalog.deepLabel")}</text>
                    <text x="42" y="48" textAnchor="middle" fill="white" fontSize="7" fontWeight="500">{t("marketing.landing.showcase.catalog.playbooksLabel")}</text>
                  </g>
                  <g transform="translate(105, 30)">
                    {Array.from({ length: 36 }).map((_, i) => {
                      const row = Math.floor(i / 6);
                      const col = i % 6;
                      return (
                        <rect key={i} x={col * 12} y={row * 12} width="9" height="9" rx="1.5" fill="#94A3B8" opacity={0.3 + (Math.sin(i * 0.5) * 0.2 + 0.4) * 0.4}/>
                      );
                    })}
                    <text x="36" y="92" textAnchor="middle" fill="#475569" fontSize="9" fontWeight="bold">193+</text>
                    <text x="36" y="103" textAnchor="middle" fill="#64748B" fontSize="6">{t("marketing.landing.showcase.catalog.catalogLabel")}</text>
                  </g>
                  <path d="M 88 60 L 102 60" stroke="#CBD5E1" strokeWidth="1.5" strokeDasharray="2,2"/>
                  <text x="100" y="170" textAnchor="middle" fill="#475569" fontSize="9" fontWeight="600">{t("marketing.landing.showcase.catalog.depthBreadth")}</text>
                  <text x="100" y="183" textAnchor="middle" fill="#94A3B8" fontSize="7">{t("marketing.landing.showcase.catalog.depthBreadthSubtitle")}</text>
                </svg>
              </div>
            </div>

            <div className="mt-8 pt-6 border-t border-slate-200/60 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <p className="text-sm text-slate-600">
                {t("marketing.landing.showcase.catalog.footerPrompt")}{" "}
                <Link href={getDiscoveryCallUrl()} className="text-indigo-600 hover:text-indigo-700 font-semibold">{t("marketing.landing.showcase.catalog.footerLink")}</Link>
                {" "}{t("marketing.landing.showcase.catalog.footerSuffix")}
              </p>
              <Link href="/industries" className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold rounded-lg transition-colors">
                {t("marketing.landing.showcase.catalog.browseCatalog")}
                <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="max-w-7xl mx-auto">
          <div className="mb-12">
            <p className="text-xs font-mono text-indigo-600 mb-2">{t("marketing.landing.howItWorks.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight max-w-3xl">
              {t("marketing.landing.howItWorks.headline")}
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {howSteps.map((step, i) => {
              const num = String(i + 1).padStart(2, "0");
              return (
                <div key={num} className="relative">
                  <div className="flex items-center gap-3 mb-3">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-mono text-sm font-bold ${
                      i === 2 ? "bg-indigo-600 text-white" : "bg-white border border-slate-300 text-slate-700"
                    }`}>
                      {num}
                    </div>
                    <span className="text-xs font-mono text-slate-500 tracking-wider">{step.time}</span>
                  </div>
                  <h3 className="text-xl font-bold mb-2">{step.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{step.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <EarlyAccessSection />

      <section className="px-6 py-20 bg-slate-900 text-white">
        <div className="max-w-7xl mx-auto">
          <div className="mb-12">
            <p className="text-xs font-mono text-indigo-400 mb-2">{t("marketing.landing.sampleCalls.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight max-w-3xl">
              {t("marketing.landing.sampleCalls.headline")}
            </h2>
            <p className="text-slate-400 mt-3 max-w-xl">
              {t("marketing.landing.sampleCalls.subhead")}
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {sampleCalls.map((call, i) => (
              <div key={i} className="bg-slate-800 rounded-2xl p-6 border border-slate-700">
                <div className="text-xs font-mono text-indigo-400 uppercase tracking-wider mb-4">
                  {call.industry}
                </div>
                <div className="mb-4">
                  <div className="text-xs text-slate-500 mb-1">{t("marketing.landing.sampleCalls.callerLabel")}</div>
                  <p className="text-sm text-slate-300 italic">{call.caller}</p>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">{t("marketing.landing.sampleCalls.neverrLabel")}</div>
                  <p className="text-sm text-slate-100 leading-relaxed">{call.response}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="max-w-7xl mx-auto">
          <div className="mb-12">
            <p className="text-xs font-mono text-indigo-600 mb-2">{t("marketing.landing.concierge.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight max-w-3xl">
              {t("marketing.landing.concierge.headline")}
            </h2>
            <p className="text-slate-600 mt-3 max-w-2xl">
              {t("marketing.landing.concierge.subhead")}
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-5">
            {conciergeBlocks.map((b) => (
              <div key={b.title} className="bg-white rounded-2xl p-6 border border-slate-200 hover:border-slate-300 transition-colors">
                <h3 className="text-lg font-bold mb-2">{b.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed">{b.desc}</p>
              </div>
            ))}
          </div>

          <p className="text-sm italic text-slate-500 mt-8 max-w-3xl">
            {t("marketing.landing.concierge.founderNote")}
          </p>
        </div>
      </section>

      <section className="px-6 py-20 bg-white">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs font-mono text-indigo-600 mb-2">{t("marketing.landing.pricingTeaser.eyebrow")}</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
              {t("marketing.landing.pricingTeaser.headline")}
            </h2>
            <p className="text-slate-600 mb-2">
              {t("marketing.landing.pricingTeaser.subheadPrefix")}<strong className="text-slate-900">{t("marketing.landing.pricingTeaser.subheadStrong")}</strong>{t("marketing.landing.pricingTeaser.subheadEnd")}
            </p>
            <Link href="/pricing" className="inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:text-indigo-700 mt-4">
              {t("marketing.landing.pricingTeaser.seeAllPlans")} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>

          <div className="bg-gradient-to-br from-indigo-50 to-violet-50 rounded-2xl p-8 border border-indigo-200 relative">
            <div className="absolute top-4 right-4 px-2 py-1 bg-slate-900 text-white text-[10px] font-mono uppercase tracking-wide rounded">
              {t("marketing.landing.pricingTeaser.popularBadge")}
            </div>

            <div className="text-xs font-mono text-slate-500 uppercase tracking-wider mb-2">{t("marketing.landing.pricingTeaser.tierLabel")}</div>
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-5xl font-bold">$749</span>
              <span className="text-slate-500 font-mono text-sm">{t("marketing.landing.pricingTeaser.perMonth")}</span>
            </div>
            <div className="text-xs text-slate-500 mb-6">{t("marketing.landing.pricingTeaser.tierMeta")}</div>

            <ul className="space-y-2.5 mb-6">
              {tierFeatures.map((f) => (
                <li key={f} className="flex items-center gap-2 text-sm">
                  <Check className="w-4 h-4 text-indigo-600 flex-shrink-0" />
                  <span className="text-slate-700">{f}</span>
                </li>
              ))}
            </ul>

            <Link href="/signup" className="block text-center w-full py-3 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800 transition-colors">
              {t("marketing.landing.pricingTeaser.ctaButton")}
            </Link>
            <p className="text-xs text-slate-500 text-center mt-3 font-mono">{t("marketing.landing.pricingTeaser.trial")}</p>
          </div>
        </div>
      </section>

      <section className="px-6 py-12 md:py-20">
        <div className="max-w-7xl mx-auto bg-gradient-to-br from-slate-900 to-slate-800 rounded-3xl p-12 md:p-16 relative overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/10 via-transparent to-violet-500/10"></div>

          <div className="relative grid lg:grid-cols-2 gap-8 items-center">
            <div>
              <p className="text-2xl md:text-3xl font-bold text-white/90 mb-8 tracking-tight">
                {t("marketing.landing.finalCta.slogan1")}{" "}
                <span className="text-white/60">{t("marketing.landing.finalCta.slogan2")}</span>{" "}
                <span className="bg-gradient-to-r from-indigo-300 to-violet-300 bg-clip-text text-transparent">{t("marketing.landing.finalCta.slogan3")}</span>
              </p>
              <p className="text-xs font-mono text-indigo-400 mb-3 tracking-wider">{t("marketing.landing.finalCta.timeMark")}</p>
              <h2 className="text-4xl md:text-5xl font-bold text-white tracking-tight leading-[1.1]">
                {t("marketing.landing.finalCta.headline")}
              </h2>
              <p className="text-indigo-200 mt-3 text-sm font-mono">
                {t("marketing.landing.finalCta.note")}
              </p>
            </div>

            <div className="flex flex-col gap-3 lg:items-end">
              <Link href="/try-your-agent" className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-indigo-500 text-white rounded-lg font-semibold hover:bg-indigo-600 transition-colors shadow-lg shadow-indigo-500/30 w-full lg:w-auto">
                {t("marketing.landing.finalCta.ctaPrimary")} <ArrowRight className="w-4 h-4" />
              </Link>
              <Link href="/signup" className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-white text-slate-900 rounded-lg font-semibold hover:bg-slate-100 transition-colors w-full lg:w-auto">
                {t("marketing.landing.finalCta.ctaSecondary")}
              </Link>
              <p className="text-xs text-slate-400 mt-1 font-mono lg:text-right">
                {t("marketing.landing.finalCta.ctaNote")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <NeverrVoiceWidget />
      <LandingFooter />
    </div>
  );
}
