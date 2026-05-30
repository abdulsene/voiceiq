// /src/pages/IndustryDetailPage.tsx
//
// Generic page component that renders any industry from /src/data/featured-industries.ts.
// Route: /for/<slug>  →  reads slug from wouter useRoute, looks up brief, renders.
// If slug is unknown, renders a 404-style fallback that links to the IndustriesHubPage.

import { useRoute, Link } from "wouter";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import {
  type IndustryBrief,
  type TranscriptTurn,
} from "../data/featured-industries";
import { useTranslatedIndustry } from "../hooks/useTranslatedIndustries";
import { getDiscoveryCallUrl } from "../lib/cta";

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HeroSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section className="relative pt-32 pb-20 px-6 bg-gradient-to-b from-white to-slate-50">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <span className="text-4xl">{brief.emoji}</span>
          <span className="text-sm font-semibold uppercase tracking-wider text-blue-600">
            {t("marketing.industryDetail.forLabel", { name: brief.name })}
          </span>
        </div>
        <h1 className="text-4xl md:text-6xl font-bold text-slate-900 leading-tight mb-6 max-w-4xl">
          {brief.hero.headline}
        </h1>
        <p className="text-lg md:text-xl text-slate-600 leading-relaxed mb-10 max-w-3xl">
          {brief.hero.subhead}
        </p>
        <div className="flex flex-col sm:flex-row gap-4">
          <Link
            href="/try-your-agent"
            className="inline-flex items-center justify-center px-8 py-4 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors"
          >
            {brief.hero.ctaPrimary}
          </Link>
          <a
            href="#proof"
            className="inline-flex items-center justify-center px-8 py-4 bg-white text-slate-900 font-semibold rounded-lg border border-slate-200 hover:bg-slate-50 transition-colors"
          >
            {brief.hero.ctaSecondary}
          </a>
        </div>
      </div>
    </section>
  );
}

function PainSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-12">
          {t("marketing.industryDetail.painHeading", { nameLower: brief.name.toLowerCase() })}
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          {brief.pain.map((p, i) => (
            <div key={i} className="bg-slate-50 p-8 rounded-xl">
              <div className="text-2xl font-bold text-blue-600 mb-3">0{i + 1}</div>
              <h3 className="text-xl font-semibold text-slate-900 mb-3">{p.title}</h3>
              <p className="text-slate-600 leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TranscriptTurnRow({ turn }: { turn: TranscriptTurn }) {
  if (turn.speaker === "System") {
    return (
      <div className="font-mono text-xs text-slate-500 my-3 text-center">
        — {turn.text} —
      </div>
    );
  }
  const isNeverr = turn.speaker === "Neverr";
  return (
    <div className={`flex ${isNeverr ? "justify-start" : "justify-end"} mb-4`}>
      <div className="max-w-[80%]">
        <div
          className={`text-xs font-semibold mb-1 ${
            isNeverr ? "text-blue-600 text-left" : "text-slate-500 text-right"
          }`}
        >
          {turn.speaker}
        </div>
        <div
          className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
            isNeverr
              ? "bg-blue-600 text-white rounded-bl-sm"
              : "bg-slate-200 text-slate-900 rounded-br-sm"
          }`}
        >
          {turn.text}
        </div>
      </div>
    </div>
  );
}

function ProofSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section id="proof" className="py-20 px-6 bg-slate-50">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-4">
          {brief.proof.title}
        </h2>
        <p className="text-slate-600 mb-8">{brief.proof.setup}</p>
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 md:p-8">
          <div className="border-b border-slate-100 pb-3 mb-6 flex items-center justify-between text-xs font-mono text-slate-500">
            <span>{t("marketing.industryDetail.incomingCall")}</span>
            <span>{brief.proof.durationLabel}</span>
          </div>
          {brief.proof.transcript.map((turn, i) => (
            <TranscriptTurnRow key={i} turn={turn} />
          ))}
          <div className="border-t border-slate-100 mt-6 pt-6">
            <div className="text-xs font-mono text-slate-500 mb-3">
              {t("marketing.industryDetail.afterTheCall")}
            </div>
            <ul className="space-y-2">
              {brief.proof.handoffMarkers.map((marker, i) => (
                <li key={i} className="text-sm text-slate-700 flex gap-2">
                  <span className="text-green-600 font-semibold flex-shrink-0">
                    ✓
                  </span>
                  <span>{marker}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-slate-600 mt-6 italic leading-relaxed">{brief.proof.caption}</p>
      </div>
    </section>
  );
}

function HowItWorksSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-12">{t("marketing.industryDetail.howItWorksHeading")}</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {brief.howItWorks.map((step, i) => (
            <div key={i}>
              <div className="text-5xl font-bold text-blue-600 mb-4">{step.step}</div>
              <h3 className="text-xl font-semibold text-slate-900 mb-3">{step.title}</h3>
              <p className="text-slate-600 leading-relaxed">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WhatItHandlesSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section className="py-20 px-6 bg-slate-50">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-12">
          {t("marketing.industryDetail.whatItHandlesHeading")}
        </h2>
        <ul className="grid md:grid-cols-2 gap-x-12 gap-y-4">
          {brief.whatItHandles.map((item, i) => (
            <li key={i} className="text-slate-700 flex gap-3 leading-relaxed">
              <span className="text-blue-600 font-bold flex-shrink-0 mt-1">→</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function BeyondTheCallSection({ brief }: { brief: IndustryBrief }) {
  const { t } = useTranslation();
  return (
    <section className="py-20 px-6 bg-slate-900 text-white">
      <div className="max-w-6xl mx-auto">
        <div className="text-sm font-semibold uppercase tracking-wider text-blue-400 mb-4">
          {t("marketing.industryDetail.beyondTheCallEyebrow")}
        </div>
        <h2 className="text-3xl md:text-4xl font-bold mb-4">
          {brief.beyondTheCall.headline}
        </h2>
        <p className="text-lg text-slate-300 mb-12 max-w-3xl">
          {brief.beyondTheCall.subhead}
        </p>
        <div className="grid md:grid-cols-2 gap-8">
          {brief.beyondTheCall.blocks.map((block, i) => (
            <div key={i} className="bg-slate-800 p-8 rounded-xl">
              <h3 className="text-xl font-semibold mb-3">{block.title}</h3>
              <p className="text-slate-300 leading-relaxed">{block.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WhyNeverrSection({ brief }: { brief: IndustryBrief }) {
  return (
    <section className="py-20 px-6 bg-white">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-12">
          {brief.whyNeverr.headline}
        </h2>
        <div className="grid md:grid-cols-2 gap-8">
          {brief.whyNeverr.blocks.map((block, i) => (
            <div key={i} className="border-l-4 border-blue-600 pl-6">
              <h3 className="text-xl font-semibold text-slate-900 mb-3">{block.title}</h3>
              <p className="text-slate-600 leading-relaxed">{block.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationsSection({ brief }: { brief: IndustryBrief }) {
  return (
    <section className="py-20 px-6 bg-slate-50">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-slate-900 mb-6">
          {brief.integrations.headline}
        </h2>
        <p className="text-slate-600 leading-relaxed mb-8 max-w-3xl">
          {brief.integrations.body}
        </p>
        <div className="flex flex-wrap gap-3">
          {brief.integrations.examples.map((vendor, i) => (
            <span
              key={i}
              className="bg-white border border-slate-200 px-4 py-2 rounded-lg text-sm font-medium text-slate-700"
            >
              {vendor}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function CloseSection({ brief }: { brief: IndustryBrief }) {
  return (
    <section className="py-24 px-6 bg-blue-600 text-white">
      <div className="max-w-4xl mx-auto text-center">
        <h2 className="text-3xl md:text-5xl font-bold mb-6">{brief.close.headline}</h2>
        <p className="text-lg md:text-xl text-blue-100 mb-10 max-w-2xl mx-auto leading-relaxed">
          {brief.close.subhead}
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/try-your-agent"
            className="inline-flex items-center justify-center px-8 py-4 bg-white text-blue-600 font-semibold rounded-lg hover:bg-slate-100 transition-colors"
          >
            {brief.close.ctaPrimary}
          </Link>
          <Link
            href={getDiscoveryCallUrl()}
            className="inline-flex items-center justify-center px-8 py-4 bg-blue-700 text-white font-semibold rounded-lg border border-blue-500 hover:bg-blue-800 transition-colors"
          >
            {brief.close.ctaSecondary}
          </Link>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------

function NotFoundFallback({ slug }: { slug: string }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <div className="pt-32 pb-20 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <h1 className="text-4xl font-bold text-slate-900 mb-4">
            {t("marketing.industryDetail.notFoundTitle")}
          </h1>
          <p className="text-slate-600 mb-8">
            {t("marketing.industryDetail.notFoundSubtitle", { slug })}
          </p>
          <Link
            href="/industries"
            className="inline-block px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700"
          >
            {t("marketing.industryDetail.notFoundCta")}
          </Link>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function IndustryDetailPage() {
  const [, params] = useRoute<{ slug: string }>("/for/:slug");
  const slug = params?.slug ?? "";
  const brief = useTranslatedIndustry(slug);

  // Update document title + meta description for SEO when brief changes
  useEffect(() => {
    if (!brief) return;
    const prevTitle = document.title;
    document.title = brief.seo.title;
    const metaDesc = document.querySelector('meta[name="description"]');
    const prevDesc = metaDesc?.getAttribute("content") ?? "";
    if (metaDesc) {
      metaDesc.setAttribute("content", brief.seo.description);
    }
    return () => {
      document.title = prevTitle;
      if (metaDesc) metaDesc.setAttribute("content", prevDesc);
    };
  }, [brief]);

  // Scroll to top on route change
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [slug]);

  if (!brief) {
    return <NotFoundFallback slug={slug} />;
  }

  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <main>
        <HeroSection brief={brief} />
        <PainSection brief={brief} />
        <ProofSection brief={brief} />
        <HowItWorksSection brief={brief} />
        <WhatItHandlesSection brief={brief} />
        <BeyondTheCallSection brief={brief} />
        <WhyNeverrSection brief={brief} />
        <IntegrationsSection brief={brief} />
        <CloseSection brief={brief} />
      </main>
      <LandingFooter />
    </div>
  );
}
