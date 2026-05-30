import { useEffect, useState } from "react";
import { useRoute, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Sparkles, Phone, X } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import { getCategoryEmoji } from "./IndustriesHub";

const API = window.location.origin + "/api";

type Industry = {
  industry_id: string;
  name: string;
  description: string;
};

type IndustryPreview = {
  industry_id: string;
  name: string;
  description: string;
  canonical_category: string;
  pain_points: string[];
  value_props: string[];
  sample_script: { name?: string; trigger?: string; script?: string } | null;
  roi_snapshot: any;
};

export default function IndustryCategoryPage() {
  const { t } = useTranslation();
  const [, params] = useRoute<{ slug: string }>("/industries/:slug");
  const slug = params?.slug || "";

  const [category, setCategory] = useState<{ name: string; slug: string } | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedIndustry, setSelectedIndustry] = useState<IndustryPreview | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  useEffect(() => {
    if (!slug) return;
    fetch(`${API}/industries/category/${slug}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setCategory(d.category);
          setIndustries(d.industries || []);
        } else {
          setError(d.error || t("marketing.industryCategory.loadErrorFallback"));
        }
      })
      .catch(() => setError(t("marketing.industryCategory.loadError")))
      .finally(() => setLoading(false));
  }, [slug, t]);

  async function openModal(industryId: string) {
    setModalLoading(true);
    setSelectedIndustry(null);
    try {
      const r = await fetch(`${API}/industries/${industryId}/preview`);
      const d = await r.json();
      if (d.success) setSelectedIndustry(d.industry);
    } catch {
      // Modal stays in loading state momentarily, then closes via the close button.
    }
    setModalLoading(false);
  }

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <LandingNav />
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full" />
        </div>
        <LandingFooter />
      </div>
    );
  }

  if (error || !category) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <LandingNav />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-lg p-8 max-w-md text-center">
            <h1 className="text-xl font-bold text-slate-900 mb-2">{t("marketing.industryCategory.notFound.title")}</h1>
            <Link href="/industries" className="text-sm text-blue-600 hover:underline">
              {t("marketing.industryCategory.notFound.backLink")}
            </Link>
          </div>
        </div>
        <LandingFooter />
      </div>
    );
  }

  const count = industries.length;
  const description = t("marketing.industryCategory.description", { count, count_one: count, count_other: count }) ||
    (count === 1
      ? t("marketing.industryCategory.description_one", { count })
      : t("marketing.industryCategory.description_other", { count }));

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="max-w-7xl mx-auto px-6 py-12">
        <Link
          href="/industries"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("marketing.industryCategory.backToAll")}
        </Link>

        <div className="mb-10">
          <h1 className="text-4xl font-bold text-slate-900 mb-3 flex items-center gap-3">
            <span className="text-4xl flex-shrink-0" aria-hidden="true">
              {getCategoryEmoji(category.name)}
            </span>
            <span>{category.name}</span>
          </h1>
          <p className="text-lg text-slate-600">
            {count === 1
              ? t("marketing.industryCategory.description_one", { count })
              : t("marketing.industryCategory.description_other", { count })}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {industries.map((industry) => (
            <button
              key={industry.industry_id}
              onClick={() => openModal(industry.industry_id)}
              className="text-left bg-white rounded-xl border border-slate-200 p-5 hover:border-blue-400 hover:shadow-md transition-all"
            >
              <h3 className="font-bold text-slate-900 mb-1.5">{industry.name}</h3>
              {industry.description && (
                <p className="text-xs text-slate-500 line-clamp-2">{industry.description}</p>
              )}
              <div className="flex items-center gap-1 mt-3 text-xs text-blue-600 font-medium">
                <Sparkles className="w-3 h-3" />
                {t("marketing.industryCategory.previewAgent")}
              </div>
            </button>
          ))}
        </div>
      </div>

      {(selectedIndustry || modalLoading) && (
        <div
          className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto"
          onClick={() => setSelectedIndustry(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8"
            onClick={(e) => e.stopPropagation()}
          >
            {modalLoading ? (
              <div className="p-12 flex justify-center">
                <div className="animate-spin w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full" />
              </div>
            ) : (
              selectedIndustry && (
                <>
                  <div className="flex items-start justify-between p-6 border-b border-slate-100">
                    <div>
                      <p className="text-xs text-slate-500 uppercase tracking-wide font-semibold mb-1">
                        {selectedIndustry.canonical_category}
                      </p>
                      <h2 className="text-2xl font-bold text-slate-900">{selectedIndustry.name}</h2>
                      {selectedIndustry.description && (
                        <p className="text-sm text-slate-600 mt-1">{selectedIndustry.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => setSelectedIndustry(null)}
                      className="text-slate-400 hover:text-slate-600 flex-shrink-0 ml-4"
                      aria-label={t("marketing.industryCategory.modal.closeAria")}
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
                    {selectedIndustry.pain_points.length > 0 && (
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 mb-2">
                          {t("marketing.industryCategory.modal.commonConcerns")}
                        </h3>
                        <ul className="space-y-1.5">
                          {selectedIndustry.pain_points.map((p, i) => (
                            <li key={i} className="text-sm text-slate-700 flex gap-2">
                              <span className="text-blue-500 flex-shrink-0">•</span>
                              <span>{p}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {selectedIndustry.value_props.length > 0 && (
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 mb-2">{t("marketing.industryCategory.modal.howItHelps")}</h3>
                        <ul className="space-y-1.5">
                          {selectedIndustry.value_props.map((v, i) => (
                            <li key={i} className="text-sm text-slate-700 flex gap-2">
                              <span className="text-emerald-500 flex-shrink-0">✓</span>
                              <span>{v}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {selectedIndustry.sample_script && (
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 mb-2">
                          {t("marketing.industryCategory.modal.samplePlaybook")}
                        </h3>
                        <div className="bg-slate-50 rounded-lg p-4">
                          {selectedIndustry.sample_script.name && (
                            <p className="text-xs font-semibold text-slate-700 mb-1">
                              {t("marketing.industryCategory.modal.scenarioPrefix")} {selectedIndustry.sample_script.name}
                            </p>
                          )}
                          {selectedIndustry.sample_script.trigger && (
                            <p className="text-xs text-slate-500 italic mb-2">
                              {t("marketing.industryCategory.modal.triggerPrefix")} {selectedIndustry.sample_script.trigger}
                            </p>
                          )}
                          {selectedIndustry.sample_script.script && (
                            <p className="text-sm text-slate-700 whitespace-pre-wrap">
                              "{selectedIndustry.sample_script.script}"
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="p-6 border-t border-slate-100 bg-slate-50 rounded-b-2xl">
                    <Link
                      href={`/try-your-agent?industry=${selectedIndustry.industry_id}`}
                      className="flex items-center justify-center gap-2 w-full px-6 py-3 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 transition-colors"
                    >
                      <Phone className="w-4 h-4" />
                      {t("marketing.industryCategory.modal.tryAgent")}
                    </Link>
                  </div>
                </>
              )
            )}
          </div>
        </div>
      )}
      <LandingFooter />
    </div>
  );
}
