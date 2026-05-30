import { Link } from "wouter";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { getDiscoveryCallUrl } from "../lib/cta";

const API = window.location.origin + "/api";

function FooterEmailSignup() {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!email.trim() || !email.includes("@")) {
      setError(t("marketing.footer.validEmail"));
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/marketing/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          consent_transactional: false,
          consent_marketing: false,
          source: "footer_widget",
          page_url: window.location.href,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || t("marketing.footer.submitFailed"));
      } else {
        setSubmitted(true);
        setEmail("");
      }
    } catch (e: any) {
      setError(e.message);
    }
    setSubmitting(false);
  }

  if (submitted) {
    return (
      <div className="text-sm text-emerald-700 font-medium">
        {t("marketing.footer.thanksMessage")}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-2 max-w-md w-full">
      <input
        type="email"
        placeholder={t("marketing.footer.emailPlaceholder")}
        className="flex-1 p-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={submitting}
      />
      <button
        type="submit"
        disabled={submitting || !email.trim()}
        className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-semibold hover:bg-slate-800 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
      >
        {submitting ? "..." : <>{t("marketing.footer.joinButton")} <ArrowRight className="w-3.5 h-3.5" /></>}
      </button>
      {error && <p className="text-xs text-red-600 mt-1 sm:absolute">{error}</p>}
    </form>
  );
}

export default function LandingFooter() {
  const { t } = useTranslation();
  return (
    <footer className="bg-slate-50 border-t border-slate-200">
      <div className="border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold text-slate-900 mb-1">{t("marketing.footer.earlyAccessHeading")}</h3>
            <p className="text-sm text-slate-600">{t("marketing.footer.earlyAccessSubhead")}</p>
          </div>
          <FooterEmailSignup />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
        <div>
          <h3 className="font-semibold text-slate-900 mb-3">{t("marketing.footer.productHeading")}</h3>
          <ul className="space-y-2 text-slate-600">
            <li><Link href="/try-your-agent" className="hover:text-slate-900">{t("marketing.footer.tryDemo")}</Link></li>
            <li><Link href="/industries" className="hover:text-slate-900">{t("marketing.footer.industries")}</Link></li>
            <li><Link href="/pricing" className="hover:text-slate-900">{t("marketing.footer.pricing")}</Link></li>
            <li><Link href="/roi" className="hover:text-slate-900">{t("marketing.footer.roi")}</Link></li>
          </ul>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-3">{t("marketing.footer.companyHeading")}</h3>
          <ul className="space-y-2 text-slate-600">
            <li><Link href="/enterprise" className="hover:text-slate-900">{t("marketing.footer.enterprise")}</Link></li>
            <li><Link href={getDiscoveryCallUrl()} className="hover:text-slate-900">{t("marketing.footer.contactSales")}</Link></li>
            <li><a href="mailto:hello@neverr.ai" className="hover:text-slate-900">{t("marketing.footer.emailUs")}</a></li>
            <li><Link href="/partners" className="hover:text-slate-900">{t("marketing.footer.partners")}</Link></li>
            <li>
              <a href="tel:+19789638377" className="hover:text-slate-900">
                +1 (978) 9NEVERR
              </a>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-3">{t("marketing.footer.accountHeading")}</h3>
          <ul className="space-y-2 text-slate-600">
            <li><Link href="/login" className="hover:text-slate-900">{t("marketing.footer.signIn")}</Link></li>
            <li><Link href="/signup" className="hover:text-slate-900">{t("marketing.footer.getStartedFree")}</Link></li>
          </ul>
        </div>

        <div>
          <h3 className="font-semibold text-slate-900 mb-3">{t("marketing.footer.legalHeading")}</h3>
          <ul className="space-y-2 text-slate-600">
            <li><Link href="/privacy" className="hover:text-slate-900">{t("marketing.footer.privacy")}</Link></li>
            <li><Link href="/terms" className="hover:text-slate-900">{t("marketing.footer.terms")}</Link></li>
          </ul>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 mt-2 pb-8 pt-6 border-t border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-2 text-xs text-slate-500">
        <div>{t("marketing.footer.copyright", { year: new Date().getFullYear() })}</div>
        <div>{t("marketing.footer.availableIn")}</div>
      </div>
    </footer>
  );
}
