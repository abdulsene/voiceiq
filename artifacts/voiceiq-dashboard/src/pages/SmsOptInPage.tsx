import { useEffect, useState } from "react";
import { useRoute } from "wouter";

const API = "/api";

type BusinessInfo = {
  business_id: string;
  brand_display_name: string;
  campaign_description: string;
  terms_url: string | null;
  privacy_url: string | null;
  transactional_blurb: string;
  promotional_blurb: string;
};

export default function SmsOptInPage() {
  const [, params] = useRoute("/sms-optin/:businessId");
  const businessId = params?.businessId || "";

  const [biz, setBiz] = useState<BusinessInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Form state. Critical Twilio compliance: BOTH consent checkboxes must
  // default UNCHECKED. The submit button must remain enabled regardless of
  // which boxes are ticked — checking nothing is a valid submission that
  // captures contact info without subscribing them to SMS.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [consentTransactional, setConsentTransactional] = useState(false);
  const [consentPromotional, setConsentPromotional] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [thankYou, setThankYou] = useState<string | null>(null);

  useEffect(() => {
    if (!businessId) return;
    fetch(`${API}/optin/${encodeURIComponent(businessId)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => setBiz(d.business as BusinessInfo))
      .catch((e: any) => setLoadErr(e?.message || "Could not load form"));
  }, [businessId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitErr(null);
    setSubmitting(true);
    try {
      const r = await fetch(`${API}/optin/${encodeURIComponent(businessId)}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: firstName,
          last_name: lastName,
          phone,
          email,
          consent_transactional: consentTransactional,
          consent_promotional: consentPromotional,
          accepted_terms: acceptedTerms,
          page_url: typeof window !== "undefined" ? window.location.href : "",
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d?.success) {
        throw new Error(d?.error || `Submission failed (HTTP ${r.status})`);
      }
      setThankYou(d.message || `Thank you, ${firstName}. Your information has been recorded.`);
    } catch (err: any) {
      setSubmitErr(err?.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loadErr) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900 mb-2">Form unavailable</h1>
          <p className="text-sm text-slate-600">{loadErr}</p>
        </div>
      </div>
    );
  }

  if (!biz) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="text-sm text-slate-500">Loading…</div>
      </div>
    );
  }

  if (thankYou) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center mx-auto mb-4 text-2xl">
            ✓
          </div>
          <h1 className="text-xl font-semibold text-slate-900 mb-2">All set</h1>
          <p className="text-sm text-slate-600">{thankYou}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-xl mx-auto bg-white rounded-2xl shadow-sm p-8">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">{biz.brand_display_name}</h1>
          <p className="text-sm text-slate-600 mt-2 leading-relaxed">{biz.campaign_description}</p>
        </header>

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="optin-first" className="block text-sm font-medium text-slate-700 mb-1">
                First name <span className="text-red-500">*</span>
              </label>
              <input
                id="optin-first"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                required
                autoComplete="given-name"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label htmlFor="optin-last" className="block text-sm font-medium text-slate-700 mb-1">
                Last name
              </label>
              <input
                id="optin-last"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                autoComplete="family-name"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
              />
            </div>
          </div>

          <div>
            <label htmlFor="optin-phone" className="block text-sm font-medium text-slate-700 mb-1">
              Mobile phone <span className="text-red-500">*</span>
            </label>
            <input
              id="optin-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
              autoComplete="tel"
              placeholder="(555) 123-4567"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
          </div>

          <div>
            <label htmlFor="optin-email" className="block text-sm font-medium text-slate-700 mb-1">
              Email (optional)
            </label>
            <input
              id="optin-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
            />
          </div>

          <div className="space-y-4 pt-2 border-t border-slate-200">
            {/* Each consent gets its own label + checkbox per Twilio
                guidance. Checkboxes default unchecked above and the submit
                button is NOT gated on these — checking neither is valid. */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={consentTransactional}
                onChange={(e) => setConsentTransactional(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-xs text-slate-600 leading-relaxed">{biz.transactional_blurb}</span>
            </label>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={consentPromotional}
                onChange={(e) => setConsentPromotional(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-xs text-slate-600 leading-relaxed">{biz.promotional_blurb}</span>
            </label>

            {(biz.terms_url || biz.privacy_url) && (
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-xs text-slate-600 leading-relaxed">
                  I have read and agree to the{" "}
                  {biz.terms_url && (
                    <a href={biz.terms_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      Terms of Service
                    </a>
                  )}
                  {biz.terms_url && biz.privacy_url && " and "}
                  {biz.privacy_url && (
                    <a href={biz.privacy_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                      Privacy Policy
                    </a>
                  )}
                  .
                </span>
              </label>
            )}
          </div>

          {submitErr && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {submitErr}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            {submitting ? "Submitting…" : "Continue"}
          </button>

          <p className="text-[11px] text-slate-400 text-center pt-2">
            Message and data rates may apply. Reply STOP at any time to opt out.
          </p>
        </form>
      </div>
    </div>
  );
}
