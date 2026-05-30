import { useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  Phone, Mail, MessageSquare, Clock, Calendar, ArrowRight, X, CheckCircle, Loader2,
} from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";
import { getDiscoveryCallUrl } from "../lib/cta";

const INDUSTRY_KEYS = [
  "homeServices", "healthcare", "mentalHealth", "legal", "automotive",
  "foodHospitality", "hotelsLodging", "beautyWellness", "fitnessGyms",
  "bankingFinancial", "realEstate", "insurance", "accountingTax",
  "government", "entertainment", "parksAmusement", "movieTheaters",
  "educationTutoring", "childcareDaycare", "petServices", "veterinary",
  "transportationAviation", "limoLuxury", "retailShopping",
  "grocerySupermarkets", "utilities", "funeralMemorial",
  "nonprofits", "photographyCreative", "printingSignage",
] as const;

const CALL_VOLUME_KEYS = ["under100", "range100to500", "range500to2000", "over2000"] as const;

function ContactForm() {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: "", business_name: "", email: "", phone: "", industry: "", call_volume: "", message: "" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const set = (field: string, value: string) => setForm((p) => ({ ...p, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setResult({ success: true, message: data.message });
        setForm({ name: "", business_name: "", email: "", phone: "", industry: "", call_volume: "", message: "" });
      } else {
        setResult({ success: false, message: data.error || t("marketing.contact.form.errorGeneric") });
      }
    } catch {
      setResult({ success: false, message: t("marketing.contact.form.errorConnection") });
    }
    setSubmitting(false);
  };

  const inputClass = "w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-sm placeholder-gray-400 focus:outline-none focus:border-[#2E75B6] focus:ring-1 focus:ring-[#2E75B6] transition-colors";
  const selectClass = "w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:border-[#2E75B6] focus:ring-1 focus:ring-[#2E75B6] transition-colors appearance-none";

  return (
    <section className="bg-[#1B2537] py-20 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">{t("marketing.contact.hero.headline")}</h2>
          <p className="text-gray-300 text-lg max-w-2xl mx-auto">
            {t("marketing.contact.hero.subhead")}
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-10">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <input type="text" placeholder={t("marketing.contact.form.fullNamePlaceholder")} required value={form.name} onChange={(e) => set("name", e.target.value)} className={inputClass} />
              <input type="text" placeholder={t("marketing.contact.form.businessNamePlaceholder")} value={form.business_name} onChange={(e) => set("business_name", e.target.value)} className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <input type="email" placeholder={t("marketing.contact.form.emailPlaceholder")} required value={form.email} onChange={(e) => set("email", e.target.value)} className={inputClass} />
              <input type="tel" placeholder={t("marketing.contact.form.phonePlaceholder")} value={form.phone} onChange={(e) => set("phone", e.target.value)} className={inputClass} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <select value={form.industry} onChange={(e) => set("industry", e.target.value)} className={selectClass}>
                <option value="" className="text-gray-900">{t("marketing.contact.form.industryLabel")}</option>
                {INDUSTRY_KEYS.map((key) => {
                  const label = t(`marketing.contact.industries.${key}`);
                  return (
                    <option key={key} value={label} className="text-gray-900">{label}</option>
                  );
                })}
              </select>
              <select value={form.call_volume} onChange={(e) => set("call_volume", e.target.value)} className={selectClass}>
                <option value="" className="text-gray-900">{t("marketing.contact.form.callVolumeLabel")}</option>
                {CALL_VOLUME_KEYS.map((key) => {
                  const label = t(`marketing.contact.callVolumes.${key}`);
                  return (
                    <option key={key} value={label} className="text-gray-900">{label}</option>
                  );
                })}
              </select>
            </div>
            <textarea placeholder={t("marketing.contact.form.messagePlaceholder")} value={form.message} onChange={(e) => set("message", e.target.value)} rows={3} className={`${inputClass} resize-none`} />

            {result && (
              <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm ${result.success ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
                {result.success ? <CheckCircle className="w-4 h-4 shrink-0" /> : <X className="w-4 h-4 shrink-0" />}
                {result.message}
              </div>
            )}

            <button type="submit" disabled={submitting} className="w-full py-3.5 bg-white/10 text-white text-base font-semibold rounded-xl hover:bg-white/15 border border-white/20 transition-colors disabled:opacity-60 flex items-center justify-center gap-2">
              {submitting ? <><Loader2 className="w-5 h-5 animate-spin" /> {t("marketing.contact.form.submitting")}</> : <>{t("marketing.contact.form.sendMessage")} <ArrowRight className="w-5 h-5" /></>}
            </button>
            <Link href={getDiscoveryCallUrl()} className="w-full py-3.5 bg-[#2E75B6] text-white text-base font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-lg shadow-[#2E75B6]/20 flex items-center justify-center gap-2">
              {t("marketing.contact.form.bookMyDemo")} <ArrowRight className="w-5 h-5" />
            </Link>
          </form>

          <div className="flex flex-col justify-center space-y-8">
            <div>
              <h3 className="text-lg font-semibold text-white mb-5">{t("marketing.contact.direct.heading")}</h3>
              <div className="space-y-4">
                <a href="tel:+19789638377" className="flex items-center gap-3 text-gray-300 hover:text-white transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                    <Phone className="w-5 h-5 text-[#2E75B6]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{t("marketing.contact.direct.callOrText")}</p>
                    <p className="font-semibold">{t("marketing.contact.direct.phone")}</p>
                  </div>
                </a>
                <a href="mailto:hello@neverr.ai" className="flex items-center gap-3 text-gray-300 hover:text-white transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                    <Mail className="w-5 h-5 text-[#2E75B6]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{t("marketing.contact.direct.emailLabel")}</p>
                    <p className="font-semibold">{t("marketing.contact.direct.emailAddress")}</p>
                  </div>
                </a>
                <a href="/try-your-agent" className="flex items-center gap-3 text-gray-300 hover:text-white transition-colors">
                  <div className="w-10 h-10 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                    <MessageSquare className="w-5 h-5 text-[#2E75B6]" />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500">{t("marketing.contact.direct.tryDemoLabel")}</p>
                    <p className="font-semibold">{t("marketing.contact.direct.tryDemoCta")}</p>
                  </div>
                </a>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2 px-4 py-2.5 bg-green-500/15 border border-green-500/20 rounded-xl">
                <Clock className="w-4 h-4 text-green-400 shrink-0" />
                <span className="text-sm text-green-300 font-medium">{t("marketing.contact.reassurance.respondTime")}</span>
              </div>
              <div className="flex items-center gap-2 px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl">
                <Calendar className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="text-sm text-gray-400">{t("marketing.contact.reassurance.demoHours")}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-white">
      <LandingNav />
      <ContactForm />
      <LandingFooter />
    </div>
  );
}
