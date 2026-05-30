import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

function ROICalculator() {
  const { t, i18n } = useTranslation();
  const [monthlyCallVolume, setMonthlyCallVolume] = useState(300);
  const [avgCallValue, setAvgCallValue] = useState(500);
  const [currentAnswerRate, setCurrentAnswerRate] = useState(60);

  const results = useMemo(() => {
    const missedCalls = Math.round((1 - currentAnswerRate / 100) * monthlyCallVolume);
    const conversionRate = 0.15;
    const revenueLostMonthly = Math.round(missedCalls * avgCallValue * conversionRate);
    const revenueRecoveredMonthly = revenueLostMonthly;
    const annualRecovered = revenueRecoveredMonthly * 12;

    let monthlyCost = 149;
    if (monthlyCallVolume > 4000) monthlyCost = 3499;
    else if (monthlyCallVolume > 2500) monthlyCost = 1499;
    else if (monthlyCallVolume > 1500) monthlyCost = 999;
    else if (monthlyCallVolume > 750) monthlyCost = 749;
    else if (monthlyCallVolume > 250) monthlyCost = 349;

    const annualCost = monthlyCost * 12;
    const netROI = annualRecovered - annualCost;
    const roiMultiple = annualCost > 0 ? annualRecovered / annualCost : 0;

    return {
      missedCalls,
      revenueRecoveredMonthly,
      annualRecovered,
      monthlyCost,
      netROI,
      roiMultiple,
    };
  }, [monthlyCallVolume, avgCallValue, currentAnswerRate]);

  // Number formatting follows the active locale; currency stays USD per business rules.
  const localeMap: Record<string, string> = { en: "en-US", fr: "fr-FR", es: "es-ES" };
  const numLocale = localeMap[i18n.language?.split("-")[0] || "en"] || "en-US";
  const fmt = (n: number) => n.toLocaleString(numLocale);

  return (
    <section className="py-20 px-6 bg-white" id="roi-calculator">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-14">
          <h2 className="text-3xl md:text-4xl font-bold text-[#1B2537] mb-4">{t("marketing.roi.hero.headline")}</h2>
          <p className="text-gray-500 text-lg">{t("marketing.roi.hero.subhead")}</p>
        </div>

        <div className="grid md:grid-cols-2 gap-8 items-start">
          <div className="space-y-8">
            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-semibold text-[#1B2537]">{t("marketing.roi.inputs.monthlyCallVolume")}</label>
                <span className="text-sm font-bold text-[#2E75B6] bg-[#2E75B6]/10 px-3 py-1 rounded-lg">{fmt(monthlyCallVolume)} {t("marketing.roi.inputs.monthlyCallVolumeUnit")}</span>
              </div>
              <input
                type="range"
                min={50}
                max={2000}
                step={10}
                value={monthlyCallVolume}
                onChange={(e) => setMonthlyCallVolume(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-full appearance-none cursor-pointer accent-[#2E75B6]"
              />
              <div className="flex justify-between text-[11px] text-gray-400 mt-1">
                <span>50</span>
                <span>2,000</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-semibold text-[#1B2537]">{t("marketing.roi.inputs.avgCustomerValue")}</label>
                <span className="text-sm font-bold text-[#2E75B6] bg-[#2E75B6]/10 px-3 py-1 rounded-lg">${fmt(avgCallValue)}</span>
              </div>
              <input
                type="range"
                min={50}
                max={5000}
                step={50}
                value={avgCallValue}
                onChange={(e) => setAvgCallValue(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-full appearance-none cursor-pointer accent-[#2E75B6]"
              />
              <div className="flex justify-between text-[11px] text-gray-400 mt-1">
                <span>$50</span>
                <span>$5,000</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <label className="text-sm font-semibold text-[#1B2537]">{t("marketing.roi.inputs.currentAnswerRate")}</label>
                <span className="text-sm font-bold text-[#2E75B6] bg-[#2E75B6]/10 px-3 py-1 rounded-lg">{currentAnswerRate}%</span>
              </div>
              <input
                type="range"
                min={20}
                max={100}
                step={1}
                value={currentAnswerRate}
                onChange={(e) => setCurrentAnswerRate(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-full appearance-none cursor-pointer accent-[#2E75B6]"
              />
              <div className="flex justify-between text-[11px] text-gray-400 mt-1">
                <span>20%</span>
                <span>100%</span>
              </div>
            </div>

            <div className="flex items-center gap-3 px-4 py-3 bg-[#2E75B6]/5 border border-[#2E75B6]/10 rounded-xl">
              <Check className="w-5 h-5 text-[#2E75B6] shrink-0" />
              <p className="text-sm text-gray-600">
                <span className="font-semibold text-[#1B2537]">{t("marketing.roi.neverrPitch.bold")}</span>{t("marketing.roi.neverrPitch.rest")}
              </p>
            </div>
          </div>

          <div className="bg-white border-2 border-[#2E75B6]/20 rounded-2xl p-8 shadow-lg shadow-[#2E75B6]/5">
            <div className="text-center mb-6 pb-6 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-500 mb-2">{t("marketing.roi.results.youRecover")}</p>
              <p className="text-4xl md:text-5xl font-extrabold text-emerald-600">${fmt(results.annualRecovered)}</p>
              <p className="text-sm font-medium text-gray-500 mt-1">{t("marketing.roi.results.perYear")}</p>
            </div>

            <div className="text-center mb-6 pb-6 border-b border-gray-100">
              <p className="text-2xl font-bold text-[#1B2537]">{results.roiMultiple.toFixed(1)}x</p>
              <p className="text-sm text-gray-500">{t("marketing.roi.results.roiSuffix")}</p>
            </div>

            <div className="space-y-3 mb-8">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">{t("marketing.roi.results.missedCallsMonthly")}</span>
                <span className="text-sm font-bold text-[#1B2537]">{fmt(results.missedCalls)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">{t("marketing.roi.results.revenueRecoveredMonthly")}</span>
                <span className="text-sm font-bold text-emerald-600">${fmt(results.revenueRecoveredMonthly)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-500">{t("marketing.roi.results.neverrCost")}</span>
                <span className="text-sm font-bold text-[#1B2537]">${fmt(results.monthlyCost)}{t("marketing.roi.results.monthlySuffix")}</span>
              </div>
              <div className="h-px bg-gray-100" />
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[#1B2537]">{t("marketing.roi.results.netAnnualGain")}</span>
                <span className={`text-sm font-extrabold ${results.netROI >= 0 ? "text-emerald-600" : "text-red-500"}`}>${fmt(results.netROI)}</span>
              </div>
            </div>

            <Link
              href="/signup"
              className="block w-full text-center py-3 bg-[#2E75B6] text-white text-sm font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-md shadow-[#2E75B6]/20"
            >
              {t("marketing.roi.results.cta")}
            </Link>
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-8">
          {t("marketing.roi.disclaimer")}
        </p>
      </div>
    </section>
  );
}

export default function RoiPage() {
  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <ROICalculator />
      <LandingFooter />
    </div>
  );
}
