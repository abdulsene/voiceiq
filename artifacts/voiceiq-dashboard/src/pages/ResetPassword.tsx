import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import * as Sentry from "@sentry/react";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

// Landing page for the Supabase Auth recovery redirect. The URL fragment
// (NOT the search string) carries access_token, refresh_token, and type;
// e.g. /reset-password#access_token=<JWT>&refresh_token=<...>&type=recovery.
// Reading window.location.hash is the only way to grab them — the server
// never sees the fragment.
//
// State machine mirrors VerifyEmail.tsx so the chrome and affordances feel
// consistent across the two pre-login email-link surfaces.
//   form     — fragment parsed, recovery token present, show password form
//   submitting — POST in flight
//   success  — password updated, redirecting to /login
//   invalid  — no/expired/bad token (covers both "missing fragment" and
//              the api-server 401 from /auth/reset-password)
//   error    — network or 5xx; user can retry without losing the fragment
type ResetState = "form" | "submitting" | "success" | "invalid" | "error";

function readRecoveryFragment(): { accessToken: string | null; type: string | null } {
  if (typeof window === "undefined") return { accessToken: null, type: null };
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.substring(1)
    : window.location.hash;
  if (!raw) return { accessToken: null, type: null };
  const params = new URLSearchParams(raw);
  return {
    accessToken: params.get("access_token"),
    type: params.get("type"),
  };
}

export default function ResetPassword() {
  const [, navigate] = useLocation();
  const [state, setState] = useState<ResetState>("form");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [serverError, setServerError] = useState("");
  // Frozen at mount: hash params persist even if the user types into the
  // form and React re-renders. Read once, hold here.
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    const { accessToken, type } = readRecoveryFragment();
    if (!accessToken || type !== "recovery") {
      setState("invalid");
      return;
    }
    tokenRef.current = accessToken;
    // Strip the token out of the URL bar so it's not left in browser
    // history / shoulder-surf range while the user fills out the form.
    // Replace the hash with an empty string; pathname stays intact.
    try {
      window.history.replaceState({}, "", window.location.pathname);
    } catch {
      // history.replaceState is a UX nice-to-have, not load-bearing.
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFieldError("");
    setServerError("");
    if (!password || password.length < 8) {
      setFieldError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setFieldError("Passwords don't match");
      return;
    }
    const accessToken = tokenRef.current;
    if (!accessToken) {
      setState("invalid");
      return;
    }
    setState("submitting");
    try {
      const r = await fetch(`${API}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken, new_password: password }),
      });
      if (r.ok) {
        setState("success");
        // Tokens expire ~1hr after issuance — don't leave the user
        // re-clickable on the form post-success. Brief delay so they read
        // the confirmation, then hand off to /login.
        setTimeout(() => navigate("/login"), 1800);
        return;
      }
      if (r.status === 401) {
        setState("invalid");
        return;
      }
      // 400 (weak password slipping past the client-side gate) or any
      // other non-OK shape. Surface as an inline error so the user can
      // pick a stronger password without losing the recovery session.
      const d = await r.json().catch(() => ({}));
      setServerError(d?.error || "Couldn't update password. Please try again.");
      setState("form");
    } catch (err) {
      Sentry.captureException(err, { extra: { route: "/reset-password" } });
      setState("error");
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full">
          {(state === "form" || state === "submitting") && (
            <>
              <h1 className="text-xl font-bold text-slate-900 mb-2 text-center">
                Set a new password
              </h1>
              <p className="text-sm text-slate-600 mb-6 text-center">
                Choose a new password for your Neverr account. You'll be
                signed back in after you save.
              </p>
              <form onSubmit={handleSubmit}>
                <label className="block text-[13px] font-medium text-slate-900 mb-1.5">
                  New password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={e => { setPassword(e.target.value); setFieldError(""); setServerError(""); }}
                  disabled={state === "submitting"}
                  autoComplete="new-password"
                  className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm outline-none mb-4 box-border"
                />
                <label className="block text-[13px] font-medium text-slate-900 mb-1.5">
                  Confirm new password
                </label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => { setConfirm(e.target.value); setFieldError(""); setServerError(""); }}
                  disabled={state === "submitting"}
                  autoComplete="new-password"
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
                  {state === "submitting" ? "Updating..." : "Update password"}
                </button>
              </form>
            </>
          )}

          {state === "success" && (
            <div className="text-center">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Password updated
              </h1>
              <p className="text-sm text-slate-600">
                Taking you to the sign-in page...
              </p>
            </div>
          )}

          {state === "invalid" && (
            <div className="text-center">
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                This link is invalid or expired
              </h1>
              <p className="text-sm text-slate-600 mb-6">
                Password reset links expire about an hour after they're
                sent and can only be used once. Head back to sign-in and
                request a new one.
              </p>
              <button
                onClick={() => navigate("/login")}
                className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0]"
              >
                Back to sign in
              </button>
            </div>
          )}

          {state === "error" && (
            <div className="text-center">
              <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-8 h-8 text-amber-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Something went wrong
              </h1>
              <p className="text-sm text-slate-600 mb-6">
                We couldn't reach our servers. Check your connection and
                try again.
              </p>
              <button
                onClick={() => setState("form")}
                className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0]"
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
