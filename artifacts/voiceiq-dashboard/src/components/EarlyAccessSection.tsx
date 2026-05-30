import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";

const API = window.location.origin + "/api";

export default function EarlyAccessSection() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [consentTransactional, setConsentTransactional] = useState(false);
  const [consentMarketing, setConsentMarketing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!email.trim() || !email.includes("@")) {
      setError("Valid email required");
      return;
    }

    if ((consentTransactional || consentMarketing) && !phone.trim()) {
      setError("Phone number required if you want to receive SMS");
      return;
    }

    setSubmitting(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const r = await fetch(`${API}/marketing/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          phone: phone.trim() || undefined,
          business_name: businessName.trim() || undefined,
          consent_transactional: consentTransactional,
          consent_marketing: consentMarketing,
          source: "landing_section",
          page_url: window.location.href,
          utm_source: params.get("utm_source") || undefined,
          utm_medium: params.get("utm_medium") || undefined,
          utm_campaign: params.get("utm_campaign") || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || `Submission failed (HTTP ${r.status})`);
      } else {
        setSubmitted(true);
      }
    } catch (e: any) {
      setError(e.message || "Network error");
    }
    setSubmitting(false);
  }

  return (
    <section id="early-access" className="px-6 py-20 bg-gradient-to-br from-slate-50 via-indigo-50/30 to-violet-50/30">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-xs font-mono text-indigo-600 mb-3 tracking-wider">
            // EARLY ACCESS
          </p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            Now accepting first 100 businesses.
          </h2>
          <p className="text-base text-slate-600 max-w-xl mx-auto">
            Get product updates, launch invites, and early-access pricing. No spam — just the moments that matter as we ship.
          </p>
        </div>

        {submitted ? (
          <div className="bg-white rounded-2xl border border-emerald-200 shadow-md p-8 text-center max-w-md mx-auto">
            <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-6 h-6 text-emerald-600" />
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">You're on the list.</h3>
            <p className="text-sm text-slate-600">
              We'll be in touch with what we ship next.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200 shadow-md p-6 md:p-8 max-w-2xl mx-auto">
            <div className="grid md:grid-cols-2 gap-3 mb-3">
              <input
                type="email"
                placeholder="you@business.com"
                className="md:col-span-2 p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={submitting}
                required
              />
              <input
                type="tel"
                placeholder="(555) 123-4567 (optional)"
                className="p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={submitting}
              />
              <input
                type="text"
                placeholder="Your business name (optional)"
                className="p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                disabled={submitting}
              />
            </div>

            <div className="space-y-2.5 my-5 px-1">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 flex-shrink-0"
                  checked={consentTransactional}
                  onChange={(e) => setConsentTransactional(e.target.checked)}
                  disabled={submitting}
                />
                <span className="text-xs text-slate-700 leading-relaxed">
                  I agree to receive <strong>transactional SMS</strong> from Neverr (account/launch updates). Frequency varies. Data rates may apply. Reply STOP to opt out.
                </span>
              </label>

              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 flex-shrink-0"
                  checked={consentMarketing}
                  onChange={(e) => setConsentMarketing(e.target.checked)}
                  disabled={submitting}
                />
                <span className="text-xs text-slate-700 leading-relaxed">
                  I agree to receive <strong>marketing SMS</strong> from Neverr (promotions, tips, new features). Frequency varies. Data rates may apply. Reply HELP for help, STOP to opt out.
                </span>
              </label>
            </div>

            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 mb-4">
                {error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={submitting || !email.trim()}
              className="w-full px-6 py-3 bg-slate-900 text-white rounded-lg font-semibold hover:bg-slate-800 transition-colors shadow-md flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? "Submitting..." : <>Join the early access list <ArrowRight className="w-4 h-4" /></>}
            </button>

            <p className="text-[10px] text-slate-400 text-center mt-3">
              By joining, you agree to our{" "}
              <a href="/terms" className="underline">Terms</a> and{" "}
              <a href="/privacy" className="underline">Privacy Policy</a>.
              SMS consent (above) is voluntary and not required to receive email updates.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
