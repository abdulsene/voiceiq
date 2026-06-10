import { useState } from "react";
import { Link } from "wouter";
import * as Sentry from "@sentry/react";
import { CheckCircle2, Mail } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

// /forgot-username — for users who forgot which email they signed up with.
// Manual support intake: posts to /api/auth/help-recover-account, which
// audit-logs and emails the support inbox so a human can follow up. Always
// returns 204 (anti-enumeration), so the success state below is the same
// whether or not we found a matching business.
//
//   idle / submitting / error — form visible (error message inline)
//   success                   — confirmation copy referencing the
//                               contact_email the user gave us
type State = "idle" | "submitting" | "success" | "error";

export default function ForgotUsername() {
  const [businessName, setBusinessName] = useState("");
  const [businessPhone, setBusinessPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [detailsText, setDetailsText] = useState("");
  const [state, setState] = useState<State>("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!businessName.trim()) errs.business_name = "Business name is required";
    const phoneDigits = businessPhone.replace(/\D/g, "");
    if (!businessPhone.trim()) errs.business_phone = "Business phone is required";
    else if (phoneDigits.length < 7) errs.business_phone = "Enter a valid phone number";
    if (!contactEmail.trim()) errs.contact_email = "A contact email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim()))
      errs.contact_email = "Enter a valid contact email";
    if (detailsText.length > 500) errs.details = "Details must be 500 characters or fewer";
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError("");
    if (!validate()) return;
    setState("submitting");
    try {
      const r = await fetch(`${API}/auth/help-recover-account`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: businessName.trim(),
          business_phone: businessPhone.trim(),
          contact_email: contactEmail.trim(),
          details: detailsText.trim() || undefined,
        }),
      });
      if (r.ok || r.status === 204) {
        setState("success");
        return;
      }
      throw new Error(`help-recover-account returned ${r.status}`);
    } catch (err) {
      Sentry.captureException(err, { extra: { route: "/forgot-username" } });
      setServerError("We couldn't submit your request — please try again or email support directly.");
      setState("error");
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full">
          {(state === "idle" || state === "submitting" || state === "error") && (
            <>
              <h1 className="text-xl font-bold text-slate-900 mb-2 text-center">
                Forgot your email?
              </h1>
              <p className="text-sm text-slate-600 mb-6 text-center">
                Tell us about your account and we'll help you recover it within 24 hours.
              </p>
              <form onSubmit={handleSubmit}>
                <label className="block text-[13px] font-medium text-slate-900 mb-1.5">
                  Business name
                </label>
                <input
                  type="text"
                  value={businessName}
                  onChange={e => { setBusinessName(e.target.value); setFieldErrors(p => ({ ...p, business_name: "" })); }}
                  disabled={state === "submitting"}
                  className={`w-full px-3 py-2.5 border rounded-lg text-sm outline-none mb-1 box-border ${fieldErrors.business_name ? "border-[#dc2626]" : "border-slate-200"}`}
                />
                {fieldErrors.business_name && (
                  <p className="text-[#dc2626] text-xs mb-3 leading-snug">{fieldErrors.business_name}</p>
                )}

                <label className="block text-[13px] font-medium text-slate-900 mb-1.5 mt-3">
                  Business phone
                </label>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="(555) 123-4567"
                  value={businessPhone}
                  onChange={e => { setBusinessPhone(e.target.value); setFieldErrors(p => ({ ...p, business_phone: "" })); }}
                  disabled={state === "submitting"}
                  className={`w-full px-3 py-2.5 border rounded-lg text-sm outline-none mb-1 box-border ${fieldErrors.business_phone ? "border-[#dc2626]" : "border-slate-200"}`}
                />
                {fieldErrors.business_phone && (
                  <p className="text-[#dc2626] text-xs mb-3 leading-snug">{fieldErrors.business_phone}</p>
                )}

                <label className="block text-[13px] font-medium text-slate-900 mb-1.5 mt-3">
                  Contact email <span className="text-slate-400 font-normal">(where we should reach you)</span>
                </label>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={e => { setContactEmail(e.target.value); setFieldErrors(p => ({ ...p, contact_email: "" })); }}
                  disabled={state === "submitting"}
                  className={`w-full px-3 py-2.5 border rounded-lg text-sm outline-none mb-1 box-border ${fieldErrors.contact_email ? "border-[#dc2626]" : "border-slate-200"}`}
                />
                {fieldErrors.contact_email && (
                  <p className="text-[#dc2626] text-xs mb-3 leading-snug">{fieldErrors.contact_email}</p>
                )}

                <label className="block text-[13px] font-medium text-slate-900 mb-1.5 mt-3">
                  Additional details <span className="text-slate-400 font-normal">(optional)</span>
                </label>
                <textarea
                  value={detailsText}
                  onChange={e => { setDetailsText(e.target.value); setFieldErrors(p => ({ ...p, details: "" })); }}
                  disabled={state === "submitting"}
                  rows={3}
                  maxLength={500}
                  className={`w-full px-3 py-2.5 border rounded-lg text-sm outline-none mb-1 box-border resize-none ${fieldErrors.details ? "border-[#dc2626]" : "border-slate-200"}`}
                />
                <p className="text-[11px] text-slate-400 text-right mb-1">{detailsText.length}/500</p>
                {fieldErrors.details && (
                  <p className="text-[#dc2626] text-xs mb-3 leading-snug">{fieldErrors.details}</p>
                )}

                {serverError && (
                  <p className="text-[#dc2626] text-xs mt-1 mb-3 leading-snug">{serverError}</p>
                )}

                <button
                  type="submit"
                  disabled={state === "submitting"}
                  className="w-full mt-4 px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0] disabled:bg-slate-400 disabled:cursor-not-allowed"
                >
                  {state === "submitting" ? "Submitting..." : "Submit recovery request"}
                </button>
              </form>
              <div className="mt-6 pt-6 border-t border-slate-100 flex flex-col gap-2 text-center">
                <Link href="/login" className="text-xs text-[#2E75B6] font-medium hover:underline">
                  Back to login
                </Link>
                <Link href="/forgot-password" className="text-xs text-slate-500 hover:text-slate-700 hover:underline">
                  Forgot your password instead?
                </Link>
              </div>
            </>
          )}

          {state === "success" && (
            <div className="text-center">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Thanks — we got your request
              </h1>
              <p className="text-sm text-slate-600 mb-6 leading-relaxed">
                We'll email <strong>{contactEmail.trim()}</strong> within 24 hours with next steps for recovering your account.
              </p>
              <Link
                href="/login"
                className="inline-flex items-center justify-center w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0]"
              >
                <Mail className="w-4 h-4 mr-2" />
                Back to sign in
              </Link>
            </div>
          )}
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
