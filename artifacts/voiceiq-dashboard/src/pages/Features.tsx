import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { Briefcase, Clock, Sparkles, Check, ArrowRight } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const ICONS = [Briefcase, Clock, Sparkles];
const NUMS = ["01", "02", "03"];

interface FeatureItem {
  tag: string;
  title: string;
  paragraphs: string[];
  bullets: string[];
}

export default function Features() {
  const { t } = useTranslation();
  const items = (t("marketing.features.items", { returnObjects: true }) as FeatureItem[]) || [];

  return (
    <div className="min-h-screen bg-white overflow-x-hidden">
      <LandingNav />

      <section className="px-6 py-16 md:py-24 bg-gradient-to-b from-white to-slate-50">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs font-mono text-indigo-600 mb-3">{t("marketing.features.hero.eyebrow")}</p>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900 mb-5">
            {t("marketing.features.hero.headline")}
          </h1>
          <p className="text-base md:text-lg text-slate-600 max-w-2xl mx-auto">
            {t("marketing.features.hero.subhead")}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
            <Link
              href="/signup"
              className="px-5 py-3 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors flex items-center gap-1.5"
            >
              {t("marketing.features.hero.ctaPrimary")} <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/try-your-agent"
              className="px-5 py-3 border border-slate-300 text-slate-700 rounded-lg text-sm font-semibold hover:bg-slate-100 transition-colors"
            >
              {t("marketing.features.hero.ctaSecondary")}
            </Link>
          </div>
        </div>
      </section>

      <section className="px-6 py-16 md:py-20">
        <div className="max-w-5xl mx-auto space-y-16 md:space-y-24">
          {items.map((feature, idx) => {
            const Icon = ICONS[idx] ?? Briefcase;
            const num = NUMS[idx] ?? `0${idx + 1}`;
            return (
              <article key={num} className="grid md:grid-cols-[auto_1fr] gap-6 md:gap-10">
                <div className="flex md:flex-col items-start gap-4 md:gap-6">
                  <div className="w-12 h-12 md:w-14 md:h-14 bg-indigo-50 rounded-xl flex items-center justify-center shrink-0">
                    <Icon className="w-6 h-6 md:w-7 md:h-7 text-indigo-600" />
                  </div>
                  <span className="text-xs font-mono text-slate-400 self-center md:self-auto">{num}</span>
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-mono text-indigo-600 mb-2">{feature.tag}</p>
                  <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-slate-900 mb-4">
                    {feature.title}
                  </h2>
                  <div className="space-y-4 text-slate-600 leading-relaxed text-[15px] md:text-base">
                    {feature.paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                  <ul className="mt-6 space-y-3">
                    {feature.bullets.map((b, i) => (
                      <li key={i} className="flex items-start gap-3 text-[15px] text-slate-700">
                        <Check className="w-5 h-5 text-indigo-600 shrink-0 mt-0.5" />
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="px-6 py-16 md:py-20 bg-slate-900 text-white">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            {t("marketing.features.finalCta.headline")}
          </h2>
          <p className="text-slate-300 text-base md:text-lg mb-8 max-w-xl mx-auto">
            {t("marketing.features.finalCta.subhead")}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/signup"
              className="px-6 py-3 bg-white text-slate-900 rounded-lg text-sm font-semibold hover:bg-slate-100 transition-colors flex items-center gap-1.5"
            >
              {t("marketing.features.finalCta.ctaPrimary")} <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href="/pricing"
              className="px-6 py-3 border border-slate-700 text-slate-200 rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors"
            >
              {t("marketing.features.finalCta.ctaSecondary")}
            </Link>
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
