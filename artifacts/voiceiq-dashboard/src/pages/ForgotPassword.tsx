import { useState } from "react";
import { Link } from "wouter";
import * as Sentry from "@sentry/react";
import { CheckCircle2, Mail } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

// Dedicated /forgot-password page — replaces the inline button that lived
// on the login tab of Signup.tsx. Same /api/auth/forgot-password endpoint
// (no backend changes). State machine mirrors ResetPassword.tsx for visual
// consistency across the two recovery surfaces.
//
//   idle       — form visible, ready for input
//   submitting — POST in flight, button shows "Sending..."
//   success    — server returned 204; show success message with "check
//                your inbox" copy. The link is valid for ~1 hour per
//                Supabase Auth's recovery default.
//   error      — network or 5xx; inline message + Sentry capture.
type State = "idle" | "submitting" | "success" | "error";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");
  const [fieldError, setFieldError] = useState("");
  const [serverError, setServerError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError("");
    setServerError("");
    const trimmed = email.trim();
    if (!trimmed) {
      setFieldError("Enter your email address");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setFieldError("Enter a valid email address");
      return;
    }
    setState("submitting");
    try {
      const r = await fetch(`${API}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      // Server always 204s on success regardless of whether the email
      // exists (anti-enumeration). The only realistic non-2xx is the
      // rate limiter or a transient 5xx.
      if (r.ok || r.status === 204) {
        setState("success");
        return;
      }
      throw new Error(`forgot-password returned ${r.status}`);
    } catch (err) {
      Sentry.captureException(err, { extra: { route: "/forgot-password" } });
      setServerError("We couldn't send the email — please try again or contact support.");
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
                Forgot your password?
              </h1>
              <p className="text-sm text-slate-600 mb-6 text-center">
                Enter the email you signed up with. We'll send you a reset link.
              </p>
              <form onSubmit={handleSubmit}>
                <label className="block text-[13px] font-medium text-slate-900 mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={e => { setEmail(e.target.value); setFieldError(""); setServerError(""); }}
                  disabled={state === "submitting"}
                  autoComplete="email"
                  autoFocus
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm outline-none mb-2 box-border"
                />
                {fieldError && (
                  <p className="text-[#dc2626] text-xs mt-1 mb-3 leading-snug">{fieldError}</p>
                )}
                {serverError && (
                  <p className="text-[#dc2626] text-xs mt-1 mb-3 leading-snug">{serverError}</p>
                )}
                <button
                  type="submit"
                  disabled={state === "submitting"}
                  className="w-full mt-4 px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0] disabled:bg-slate-400 disabled:cursor-not-allowed"
                >
                  {state === "submitting" ? "Sending..." : "Send reset link"}
                </button>
              </form>
              <div className="mt-6 pt-6 border-t border-slate-100 flex flex-col gap-2 text-center">
                <Link href="/login" className="text-xs text-[#2E75B6] font-medium hover:underline">
                  Back to login
                </Link>
                <Link href="/forgot-username" className="text-xs text-slate-500 hover:text-slate-700 hover:underline">
                  Forgot your email instead?
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
                Check your inbox
              </h1>
              <p className="text-sm text-slate-600 mb-6 leading-relaxed">
                If an account exists with that email, we sent a password
                reset link. Check your inbox — the link is valid for
                1 hour.
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
