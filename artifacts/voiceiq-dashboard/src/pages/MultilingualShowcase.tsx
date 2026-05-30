import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowRight, Globe, Phone } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

type FeaturedLanguage = {
  code: string;
  flag: string;
  i18nKey: string; // key under marketing.multilingual.languages
  nativeName: string;
  callerSays: string;
  agentResponds: string;
};

// Caller and agent dialogue stays in their native source language (it's the demo content).
// nativeName also stays in the source language (it's the language's own name for itself).
const FEATURED_LANGUAGES: FeaturedLanguage[] = [
  {
    code: "es",
    flag: "\uD83C\uDDF2\uD83C\uDDFD",
    i18nKey: "spanish",
    nativeName: "Espa\u00F1ol",
    callerSays: "Hola, tengo una fuga de agua en la cocina. \u00BFPueden venir hoy?",
    agentResponds: "Por supuesto, entiendo la urgencia. \u00BFEs la fuga grande o peque\u00F1a? Voy a enviar a un t\u00E9cnico esta tarde \u2014 tenemos disponibilidad despu\u00E9s de las 3.",
  },
  {
    code: "fr",
    flag: "\uD83C\uDDE8\uD83C\uDDE6",
    i18nKey: "french",
    nativeName: "Fran\u00E7ais",
    callerSays: "Bonjour, j'aimerais prendre rendez-vous pour un nettoyage. Avez-vous des disponibilit\u00E9s cette semaine?",
    agentResponds: "Bonjour! Avec plaisir. J'ai des ouvertures jeudi \u00E0 10h ou vendredi \u00E0 14h. Lequel vous convient mieux?",
  },
  {
    code: "pt",
    flag: "\uD83C\uDDE7\uD83C\uDDF7",
    i18nKey: "portuguese",
    nativeName: "Portugu\u00EAs",
    callerSays: "Oi! Eu queria agendar um hor\u00E1rio pra fazer escova. Tem hor\u00E1rio pra amanh\u00E3 de manh\u00E3?",
    agentResponds: "Ol\u00E1! Claro, deixa eu ver na agenda. Tenho 10h ou 11h30 amanh\u00E3 \u2014 qual prefere?",
  },
  {
    code: "zh",
    flag: "\uD83C\uDDE8\uD83C\uDDF3",
    i18nKey: "mandarin",
    nativeName: "\u4E2D\u6587",
    callerSays: "\u4F60\u597D\uFF0C\u6211\u60F3\u54A8\u8BE2\u4E00\u4E0B\u79FB\u6C11\u65B9\u9762\u7684\u6CD5\u5F8B\u95EE\u9898\u3002",
    agentResponds: "\u60A8\u597D\uFF01\u5F88\u9AD8\u5174\u4E3A\u60A8\u670D\u52A1\u3002\u6211\u53EF\u4EE5\u5E2E\u60A8\u5B89\u6392\u548C\u6211\u4EEC\u7684\u79FB\u6C11\u5F8B\u5E08\u7EA6\u65F6\u95F4\u3002\u8BF7\u95EE\u60A8\u5E0C\u671B\u4EC0\u4E48\u65F6\u5019\u65B9\u4FBF\uFF1F",
  },
  {
    code: "ar",
    flag: "\uD83C\uDDEA\uD83C\uDDEC",
    i18nKey: "arabic",
    nativeName: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629",
    callerSays: "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064A\u0643\u0645\u060C \u0623\u0631\u064A\u062F \u062D\u062C\u0632 \u0645\u0648\u0639\u062F \u0645\u0639 \u0627\u0644\u0637\u0628\u064A\u0628 \u0645\u0646 \u0641\u0636\u0644\u0643\u0645.",
    agentResponds: "\u0648\u0639\u0644\u064A\u0643\u0645 \u0627\u0644\u0633\u0644\u0627\u0645! \u0628\u0643\u0644 \u0633\u0631\u0648\u0631. \u0639\u0646\u062F\u064A \u0645\u0648\u0639\u062F \u0645\u062A\u0627\u062D \u064A\u0648\u0645 \u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621 \u0627\u0644\u0633\u0627\u0639\u0629 10 \u0635\u0628\u0627\u062D\u0627\u064B \u0623\u0648 \u0627\u0644\u062E\u0645\u064A\u0633 \u0627\u0644\u0633\u0627\u0639\u0629 2 \u0645\u0633\u0627\u0621\u064B. \u0623\u064A\u0647\u0645\u0627 \u064A\u0646\u0627\u0633\u0628\u0643\u061F",
  },
  {
    code: "de",
    flag: "\uD83C\uDDE9\uD83C\uDDEA",
    i18nKey: "german",
    nativeName: "Deutsch",
    callerSays: "Guten Tag, ich brauche einen Termin f\u00FCr die Inspektion meines Wagens. Haben Sie diese Woche etwas frei?",
    agentResponds: "Guten Tag! Selbstverst\u00E4ndlich. Ich habe Donnerstag um 9 Uhr oder Freitag um 14 Uhr verf\u00FCgbar. Was passt Ihnen besser?",
  },
];

export default function MultilingualShowcase() {
  const { t } = useTranslation();
  const [activeLang, setActiveLang] = useState<string>("es");
  const active = FEATURED_LANGUAGES.find((l) => l.code === activeLang) || FEATURED_LANGUAGES[0];
  const isRTL = active.code === "ar";

  const activeName = t(`marketing.multilingual.languages.${active.i18nKey}.name`);
  const industries = t(`marketing.multilingual.languages.${active.i18nKey}.industries`, { returnObjects: true }) as string[];

  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      <LandingNav />

      {/* Hero */}
      <section className="px-6 py-16 md:py-20">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-indigo-50 text-indigo-700 rounded-full text-sm font-mono mb-6">
            <Globe className="w-4 h-4" />
            {t("marketing.multilingual.badge")}
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight leading-[1.05] mb-6">
            {t("marketing.multilingual.hero.line1")}
            <br />
            <span className="bg-gradient-to-r from-indigo-600 to-violet-500 bg-clip-text text-transparent">
              {t("marketing.multilingual.hero.line2")}
            </span>
          </h1>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            {t("marketing.multilingual.subhead")}
          </p>
        </div>
      </section>

      {/* Language switcher tabs */}
      <section className="px-6 pb-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-wrap gap-2 justify-center">
            {FEATURED_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                onClick={() => setActiveLang(lang.code)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 font-medium text-sm transition-all ${
                  activeLang === lang.code
                    ? "border-indigo-600 bg-indigo-50 text-indigo-900"
                    : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                }`}
              >
                <span className="text-xl" aria-hidden="true">{lang.flag}</span>
                <span className="text-left">
                  <span className="block font-semibold">{t(`marketing.multilingual.languages.${lang.i18nKey}.name`)}</span>
                  <span className="block text-xs text-slate-500 font-normal">{lang.nativeName}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Active language showcase card */}
      <section className="px-6 pb-16">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-indigo-50 to-violet-50">
              <div className="flex items-center gap-3">
                <span className="text-3xl" aria-hidden="true">{active.flag}</span>
                <div>
                  <div className="text-xs font-mono text-slate-500 uppercase tracking-wide">{t(`marketing.multilingual.languages.${active.i18nKey}.exampleScenario`)}</div>
                  <div className="text-lg font-bold text-slate-900">{active.nativeName} · {activeName}</div>
                </div>
              </div>
              <p className="text-sm text-slate-600 mt-3">{t(`marketing.multilingual.languages.${active.i18nKey}.marketDescription`)}</p>
            </div>

            {/* Conversation */}
            <div className="px-6 py-6 space-y-4">
              <div className="text-xs font-mono text-slate-400 uppercase tracking-wide">{t("marketing.multilingual.sampleCallLabel")}</div>

              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-200 flex-shrink-0 flex items-center justify-center text-xs font-bold text-slate-600">
                  👤
                </div>
                <div className="flex-1">
                  <div className="text-xs text-slate-500 mb-1">{t("marketing.multilingual.callerLabel")}</div>
                  <div
                    className="bg-slate-100 rounded-2xl rounded-tl-sm p-3 text-sm text-slate-900"
                    lang={active.code}
                    dir={isRTL ? "rtl" : "ltr"}
                  >
                    {active.callerSays}
                  </div>
                </div>
              </div>

              <div className="flex gap-3 flex-row-reverse">
                <div className="w-8 h-8 rounded-full bg-indigo-500 text-white flex-shrink-0 flex items-center justify-center text-xs font-bold">
                  AI
                </div>
                <div className="flex-1 flex flex-col items-end">
                  <div className="text-xs text-slate-500 mb-1">{t("marketing.multilingual.agentLabel")}</div>
                  <div
                    className="bg-indigo-100 rounded-2xl rounded-tr-sm p-3 text-sm text-slate-900 max-w-[90%]"
                    lang={active.code}
                    dir={isRTL ? "rtl" : "ltr"}
                  >
                    {active.agentResponds}
                  </div>
                </div>
              </div>
            </div>

            {/* CTA */}
            <div className="px-6 py-5 bg-slate-50 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="text-xs font-mono text-slate-500 uppercase tracking-wide mb-1">{t("marketing.multilingual.commonInLabel")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {Array.isArray(industries) && industries.map((ind: string) => (
                    <span key={ind} className="text-xs px-2 py-0.5 bg-white border border-slate-200 text-slate-700 rounded">
                      {ind}
                    </span>
                  ))}
                </div>
              </div>
              <Link
                href={`/try-your-agent?language=${active.code}`}
                className="flex items-center justify-center gap-2 px-5 py-3 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                {t("marketing.multilingual.tryInLanguage", { language: activeName })} <ArrowRight className="w-4 h-4" />
              </Link>
            </div>
          </div>

          {/* All languages note */}
          <div className="mt-8 text-center">
            <p className="text-sm text-slate-500">{t("marketing.multilingual.allLanguagesNote")}</p>
          </div>
        </div>
      </section>

      {/* Why this matters section */}
      <section className="px-6 py-20 bg-white border-y border-slate-200">
        <div className="max-w-5xl mx-auto">
          <p className="text-xs font-mono text-indigo-600 mb-3 tracking-wider">{t("marketing.multilingual.whyMatters.eyebrow")}</p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-12 max-w-2xl">
            {t("marketing.multilingual.whyMatters.headline")}
          </h2>

          <div className="grid md:grid-cols-3 gap-6">
            <div className="p-6 bg-slate-50 rounded-xl border border-slate-200">
              <div className="text-xs font-mono text-slate-500 mb-2">01</div>
              <h3 className="font-bold text-lg mb-2">{t("marketing.multilingual.whyMatters.blocks.native.title")}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                {t("marketing.multilingual.whyMatters.blocks.native.body")}
              </p>
            </div>
            <div className="p-6 bg-slate-50 rounded-xl border border-slate-200">
              <div className="text-xs font-mono text-slate-500 mb-2">02</div>
              <h3 className="font-bold text-lg mb-2">{t("marketing.multilingual.whyMatters.blocks.codeSwitch.title")}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                {t("marketing.multilingual.whyMatters.blocks.codeSwitch.body")}
              </p>
            </div>
            <div className="p-6 bg-slate-50 rounded-xl border border-slate-200">
              <div className="text-xs font-mono text-slate-500 mb-2">03</div>
              <h3 className="font-bold text-lg mb-2">{t("marketing.multilingual.whyMatters.blocks.cultural.title")}</h3>
              <p className="text-sm text-slate-600 leading-relaxed">
                {t("marketing.multilingual.whyMatters.blocks.cultural.body")}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="px-6 py-20">
        <div className="max-w-4xl mx-auto bg-gradient-to-br from-slate-900 to-slate-800 rounded-3xl p-12 text-center">
          <h2 className="text-3xl md:text-4xl font-bold text-white tracking-tight mb-4">
            {t("marketing.multilingual.finalCta.headline", { language: activeName })}
          </h2>
          <p className="text-indigo-200 mb-8">
            {t("marketing.multilingual.finalCta.subhead")}
          </p>
          <Link
            href={`/try-your-agent?language=${active.code}`}
            className="inline-flex items-center gap-2 px-8 py-3.5 bg-indigo-500 text-white rounded-lg font-semibold hover:bg-indigo-600 transition-colors shadow-lg shadow-indigo-500/30"
          >
            <Phone className="w-4 h-4" />
            {t("marketing.multilingual.finalCta.button")}
          </Link>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
