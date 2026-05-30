import { useTranslation } from "react-i18next";
import { InlineWidget } from "react-calendly";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

export default function DemoCall() {
  const { t } = useTranslation();
  const calendlyUrl = (import.meta.env.VITE_CALENDLY_URL as string | undefined) ?? "";
  const hasCalendly = calendlyUrl.startsWith("https://");

  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <section className="pt-32 pb-12 px-6 bg-gradient-to-b from-white to-slate-50">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 leading-tight mb-5">
            {t("marketing.demoCall.headline")}
          </h1>
          <p className="text-lg md:text-xl text-slate-600 leading-relaxed max-w-3xl mx-auto">
            {t("marketing.demoCall.subhead")}
          </p>
        </div>
      </section>

      <section className="px-6 pb-12 bg-slate-50">
        <div className="max-w-5xl mx-auto">
          {hasCalendly ? (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              <InlineWidget
                url={calendlyUrl}
                styles={{ height: "700px", width: "100%" }}
              />
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-12 text-center">
              <p className="text-base text-slate-700">
                {t("marketing.demoCall.fallbackMessage")}
              </p>
            </div>
          )}
          <p className="text-center text-sm text-slate-500 mt-6">
            {t("marketing.demoCall.trustSignal")}
          </p>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
