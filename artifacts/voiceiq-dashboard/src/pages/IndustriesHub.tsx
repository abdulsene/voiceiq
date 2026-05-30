// /src/pages/IndustriesHub.tsx
// Position C industries hub: spotlighted (deep playbooks) + catalog (193+) bands.

import { useEffect } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import {
  CATEGORY_ORDER,
  INDUSTRIES,
  type IndustryBrief,
} from "../data/featured-industries";
import {
  useTranslatedFeaturedIndustries,
  useTranslatedIndustriesByCategory,
} from "../hooks/useTranslatedIndustries";

// ---------------------------------------------------------------------------
// Backward-compat: legacy named export (DO NOT REMOVE)
// IndustryCategoryPage imports this. Preserves /industries/<slug> functionality.
// ---------------------------------------------------------------------------

const LEGACY_CATEGORY_EMOJI: Record<string, string> = {
  "Automotive & Vehicle Services": "🚗",
  "Aviation & Travel": "✈️",
  "Beauty, Wellness & Personal Care": "💅",
  "Consulting": "💼",
  "Dental & Vision": "🦷",
  "Education & Childcare": "📚",
  "Entertainment & Events": "🎉",
  "Financial Services": "💰",
  "Fitness & Recreation": "💪",
  "Food, Hospitality & Events": "🍽️",
  "Government & Public Services": "🏛️",
  "Healthcare & Medical": "⚕️",
  "Home Services & Trades": "🔧",
  "Hospitality & Lodging": "🏨",
  "Insurance": "🛡️",
  "Legal": "⚖️",
  "Legal Services": "⚖️",
  "Marketing, Media & Creative": "🎨",
  "Mental & Behavioral Health": "🧠",
  "Nonprofits, Faith & Community": "🤝",
  "Pet Services": "🐾",
  "Professional Services": "💼",
  "Real Estate": "🏠",
  "Religious & Community": "🙏",
  "Retail & E-commerce": "🛍️",
  "Senior Care & Home Health": "👴",
  "Specialty Services": "✨",
  "Technology & Professional Services": "💻",
  "Technology & Software": "💻",
  "Transportation & Logistics": "🚚",
  "Veterinary": "🐕",
  "Veterinary & Pet Care": "🐾",
};

export function getCategoryEmoji(name: string): string {
  return LEGACY_CATEGORY_EMOJI[name] || "🏢";
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function SpotlightedCard({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <Link
      href={`/for/${brief.slug}`}
      className="group block bg-white rounded-2xl border border-slate-200 p-6 hover:border-indigo-300 hover:shadow-xl transition-all relative overflow-hidden"
    >
      {brief.featured && (
        <div className="absolute top-3 right-3">
          <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L8.5 5L13 5.5L9.5 8.5L10.5 13L7 10.5L3.5 13L4.5 8.5L1 5.5L5.5 5L7 1Z"
                  fill="#6366F1"/>
          </svg>
        </div>
      )}
      <div className="text-4xl mb-3">{brief.emoji}</div>
      <h3 className="text-lg font-bold text-slate-900 group-hover:text-indigo-600 transition-colors mb-2">
        {brief.name}
      </h3>
      <p className="text-sm text-slate-600 leading-relaxed mb-4">
        {brief.shortPitch}
      </p>
      <div className="text-sm font-semibold text-indigo-600 group-hover:text-indigo-700 inline-flex items-center gap-1">
        {t("marketing.industriesHub.seePlaybook")}
      </div>
    </Link>
  );
}

function CategorySection({ category }: { category: typeof CATEGORY_ORDER[number] }) {
  const { t } = useTranslation();
  const items = useTranslatedIndustriesByCategory(category);
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
        {t(`marketing.categories.${category}`)}
      </h3>
      <div className="space-y-2">
        {items.map((brief) => (
          <Link
            key={brief.slug}
            href={`/for/${brief.slug}`}
            className="group flex items-start gap-3 p-3 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <span className="text-2xl flex-shrink-0">{brief.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-slate-900 group-hover:text-indigo-600 transition-colors text-sm">
                {brief.name}
              </div>
              <div className="text-xs text-slate-500 mt-0.5 leading-snug">{brief.shortPitch}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function IndustriesHub() {
  const { t } = useTranslation();
  const featured = useTranslatedFeaturedIndustries();

  useEffect(() => {
    document.title = t("marketing.industriesHub.title");
    window.scrollTo(0, 0);
  }, [t]);

  return (
    <div className="min-h-screen bg-white">
      <LandingNav />

      {/* Hero with depth+breadth illustration */}
      <section className="pt-32 pb-16 px-6 bg-gradient-to-b from-white via-indigo-50/20 to-white">
        <div className="max-w-7xl mx-auto">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            {/* Left: text */}
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-indigo-100 rounded-full mb-6">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                  {t("marketing.industriesHub.eyebrow")}
                </span>
              </div>
              <h1 className="text-4xl md:text-6xl font-bold text-slate-900 mb-6 leading-tight">
                {t("marketing.industriesHub.headlinePart1")}<span className="text-indigo-600">{t("marketing.industriesHub.headlinePart2")}</span>
              </h1>
              <p className="text-lg md:text-xl text-slate-600 leading-relaxed mb-8">
                {t("marketing.industriesHub.subheadPrefix")}
                <strong className="text-slate-900"> {t("marketing.industriesHub.subheadStrong1")}</strong>{t("marketing.industriesHub.subheadMiddle")}
                <strong className="text-slate-900">{INDUSTRIES.length}{t("marketing.industriesHub.subheadStrong2Suffix")}</strong>{t("marketing.industriesHub.subheadEnd")}
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <a
                  href="#spotlighted"
                  className="inline-flex items-center justify-center px-6 py-3 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 transition-colors"
                >
                  {t("marketing.industriesHub.ctaPrimary")}
                </a>
                <a
                  href="#catalog"
                  className="inline-flex items-center justify-center px-6 py-3 bg-white text-slate-900 font-semibold rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  {t("marketing.industriesHub.ctaSecondary")}
                </a>
              </div>
            </div>

            {/* Right: SVG depth+breadth visual */}
            <div className="hidden md:block">
              <svg viewBox="0 0 400 320" className="w-full h-auto">
                <defs>
                  <linearGradient id="hub-spotlight" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#6366F1"/>
                    <stop offset="100%" stopColor="#8B5CF6"/>
                  </linearGradient>
                  <pattern id="hub-grid" width="20" height="20" patternUnits="userSpaceOnUse">
                    <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.5"/>
                  </pattern>
                </defs>
                <rect width="400" height="320" fill="url(#hub-grid)"/>

                {/* SPOTLIGHTED — deep cards stack on left */}
                <g transform="translate(40, 60)">
                  <text x="50" y="-15" textAnchor="middle" fill="#6366F1" fontSize="11" fontWeight="bold">{t("marketing.industriesHub.diagramSpotlighted")}</text>
                  <text x="50" y="-2" textAnchor="middle" fill="#94A3B8" fontSize="9">{t("marketing.industriesHub.diagramSpotlightedSubtitle", { count: INDUSTRIES.length })}</text>
                  {/* Card stack */}
                  {[0, 1, 2, 3].map((i) => (
                    <rect
                      key={i}
                      x={i * 4}
                      y={i * -4 + 16}
                      width="100"
                      height="140"
                      rx="6"
                      fill="url(#hub-spotlight)"
                      opacity={0.3 + i * 0.2}
                    />
                  ))}
                  <text x="56" y="80" textAnchor="middle" fill="white" fontSize="36" fontWeight="bold">{INDUSTRIES.length}</text>
                  <text x="56" y="100" textAnchor="middle" fill="white" fontSize="9" fontWeight="500">{t("marketing.industriesHub.diagramFullBriefs")}</text>
                  <text x="56" y="115" textAnchor="middle" fill="white" fontSize="7" opacity="0.8">{t("marketing.industriesHub.diagramProofIntegrations")}</text>
                  <text x="56" y="125" textAnchor="middle" fill="white" fontSize="7" opacity="0.8">{t("marketing.industriesHub.diagramRetention")}</text>
                </g>

                <g transform="translate(200, 60)">
                  <text x="80" y="-15" textAnchor="middle" fill="#475569" fontSize="11" fontWeight="bold">{t("marketing.industriesHub.diagramCatalog")}</text>
                  <text x="80" y="-2" textAnchor="middle" fill="#94A3B8" fontSize="9">{t("marketing.industriesHub.diagramCatalogSubtitle")}</text>
                  {/* 13 col x 11 row grid (143 visible representing 193+) */}
                  {Array.from({length: 143}).map((_, i) => {
                    const row = Math.floor(i / 13);
                    const col = i % 13;
                    return (
                      <rect
                        key={i}
                        x={col * 12}
                        y={row * 12 + 16}
                        width="9"
                        height="9"
                        rx="1.5"
                        fill="#94A3B8"
                        opacity={0.2 + (Math.sin(i * 0.7) * 0.3 + 0.5) * 0.4}
                      />
                    );
                  })}
                  <text x="80" y="180" textAnchor="middle" fill="#475569" fontSize="20" fontWeight="bold">193+</text>
                </g>

                {/* Connector line — flowing from spotlight to catalog */}
                <path
                  d="M 145 160 Q 175 160 195 160"
                  stroke="#CBD5E1"
                  strokeWidth="1.5"
                  strokeDasharray="3,3"
                  fill="none"
                />

                {/* Bottom label */}
                <text x="200" y="280" textAnchor="middle" fill="#64748B" fontSize="11" fontWeight="600">
                  {t("marketing.industriesHub.diagramFooter")}
                </text>
                <text x="200" y="295" textAnchor="middle" fill="#94A3B8" fontSize="9">
                  {t("marketing.industriesHub.diagramFooterSub")}
                </text>
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* SPOTLIGHTED BAND */}
      <section id="spotlighted" className="py-16 px-6 bg-gradient-to-b from-white to-slate-50">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 px-3 py-1 bg-indigo-50 rounded-full">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M7 1L8.5 5L13 5.5L9.5 8.5L10.5 13L7 10.5L3.5 13L4.5 8.5L1 5.5L5.5 5L7 1Z"
                        fill="#6366F1"/>
                </svg>
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                  {t("marketing.industriesHub.spotlightedLabel")}
                </span>
              </div>
            </div>
          </div>
          <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-3">
            {t("marketing.industriesHub.spotlightedTitle", { count: INDUSTRIES.length })}
          </h2>
          <p className="text-slate-600 leading-relaxed mb-10 max-w-2xl">
            {t("marketing.industriesHub.spotlightedSubhead")}
          </p>

          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">{t("marketing.industriesHub.featuredSection")}</h3>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-12">
            {featured.slice(0, 8).map((brief) => (
              <SpotlightedCard key={brief.slug} brief={brief} />
            ))}
          </div>

          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">{t("marketing.industriesHub.byCategorySection")}</h3>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-10">
            {CATEGORY_ORDER.map((cat) => (
              <CategorySection key={cat} category={cat} />
            ))}
          </div>
        </div>
      </section>

      {/* CATALOG BAND */}
      <section id="catalog" className="py-20 px-6 bg-slate-900 text-white">
        <div className="max-w-7xl mx-auto">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex items-center gap-2 px-3 py-1 bg-slate-800 rounded-full border border-slate-700">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1" fill="#94A3B8"/>
                <rect x="8" y="1" width="5" height="5" rx="1" fill="#94A3B8"/>
                <rect x="1" y="8" width="5" height="5" rx="1" fill="#94A3B8"/>
                <rect x="8" y="8" width="5" height="5" rx="1" fill="#94A3B8"/>
              </svg>
              <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
                {t("marketing.industriesHub.catalogLabel")}
              </span>
            </div>
            <span className="text-sm text-slate-400">{t("marketing.industriesHub.catalogMore")}</span>
          </div>
          <h2 className="text-3xl md:text-4xl font-bold mb-4 max-w-3xl">
            {t("marketing.industriesHub.catalogTitle")}
          </h2>
          <p className="text-slate-300 leading-relaxed mb-10 max-w-3xl">
            {t("marketing.industriesHub.catalogSubhead", { count: INDUSTRIES.length })}
          </p>

          <div className="bg-slate-800/50 border border-slate-700 rounded-2xl p-8">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400 mb-4">
              {t("marketing.industriesHub.sampleHeading")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {((t("marketing.industriesHub.sampleTags", { returnObjects: true }) as string[]) || []).map((cat, i, arr) => (
                <span
                  key={cat}
                  className={`text-sm px-3 py-1.5 rounded-full ${
                    i === arr.length - 1
                      ? "bg-indigo-600 text-white font-semibold"
                      : "bg-slate-700/50 border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors"
                  }`}
                >
                  {cat}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 bg-gradient-to-r from-indigo-600/20 to-purple-600/20 border border-indigo-500/30 rounded-2xl p-8">
            <div>
              <h3 className="text-2xl font-bold mb-2">{t("marketing.industriesHub.tellUsTitle")}</h3>
              <p className="text-slate-300 leading-relaxed max-w-2xl">
                {t("marketing.industriesHub.tellUsSubhead")}
              </p>
            </div>
            <Link
              href="/contact?topic=industry-fit"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white text-slate-900 font-semibold rounded-lg hover:bg-slate-100 transition-colors flex-shrink-0"
            >
              {t("marketing.industriesHub.tellUsCta")}
            </Link>
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
