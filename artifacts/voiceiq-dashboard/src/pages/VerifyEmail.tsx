import { useState, useEffect, useRef } from "react";
import { CheckCircle2, AlertTriangle, Loader2, Mail } from "lucide-react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

// Sprint 2 STEP 4 / BUG-18: standalone verification page. The user lands
// here from the /verify-email?token=<…> link in the verification email
// sent by the Stripe webhook (app.ts checkout.session.completed). Mirrors
// the structure of pages/ActivateAccount.tsx — same chrome (LandingNav +
// LandingFooter), same card pattern.
//
// State machine:
//   loading            — initial mount + fetch in flight
//   success            — token valid, email_verified flipped TRUE
//   invalid_or_expired — server collapsed every no-go path (not-found,
//                        already-used, expired, CAS-race-lost) into a
//                        single response shape per anti-enumeration. The
//                        UI mirrors that — one branch, one affordance
//                        (request a new link → /dashboard which renders
//                        EmailVerificationScreen with the resend button).
//   error              — network error / 5xx (server reached but failed)
type VerifyState = "loading" | "success" | "invalid_or_expired" | "error";

export default function VerifyEmail() {
  const [state, setState] = useState<VerifyState>("loading");
  const calledRef = useRef(false);

  useEffect(() => {
    // Strict-mode double-mount guard — without this the verify POST fires
    // twice in dev, the second call hits the already-used branch, and
    // a successful verify visually flickers to "expired". Ref-based latch
    // because the network call needs to fire exactly once per mount.
    if (calledRef.current) return;
    calledRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get("token") || "";
    if (!token) {
      setState("invalid_or_expired");
      return;
    }

    (async () => {
      try {
        const r = await fetch(`${API}/auth/verify-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d?.success) {
          setState("success");
          return;
        }
        // Server returns ONE generic reason ("invalid_or_expired") for
        // not-found / already-used / expired / CAS-race per anti-enumeration.
        // 5xx with reason "error" is a real server hiccup → "error" state.
        const reason = (d?.reason as string) || "";
        if (reason === "error") {
          setState("error");
        } else {
          setState("invalid_or_expired");
        }
      } catch {
        setState("error");
      }
    })();
  }, []);

  const goDashboard = () => {
    window.location.href = "/dashboard";
  };

  const goRequestNewLink = () => {
    // Sending the user to the dashboard hands them off to the
    // EmailVerificationScreen gate (App.tsx DashboardLayout) which has the
    // proper "Resend verification email" button + rate-limit handling.
    window.location.href = "/dashboard";
  };

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full text-center">
          {state === "loading" && (
            <>
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-8 h-8 text-slate-500 animate-spin" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Verifying your email...
              </h1>
              <p className="text-sm text-slate-600">
                One moment while we confirm your link.
              </p>
            </>
          )}

          {state === "success" && (
            <>
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-emerald-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Email verified!
              </h1>
              <p className="text-sm text-slate-600 mb-6">
                Your email is confirmed. You can now access your Neverr
                dashboard.
              </p>
              <button
                onClick={goDashboard}
                className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0]"
              >
                Continue to dashboard
              </button>
            </>
          )}

          {state === "invalid_or_expired" && (
            <>
              <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-8 h-8 text-red-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                This link is invalid or expired
              </h1>
              <p className="text-sm text-slate-600 mb-6">
                Verification links expire 24 hours after they're sent and
                can only be used once. Sign in to your dashboard to request
                a fresh link.
              </p>
              <button
                onClick={goRequestNewLink}
                className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0] inline-flex items-center justify-center gap-2"
              >
                <Mail className="w-4 h-4" />
                Request a new link
              </button>
            </>
          )}

          {state === "error" && (
            <>
              <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="w-8 h-8 text-amber-600" />
              </div>
              <h1 className="text-xl font-bold text-slate-900 mb-2">
                Something went wrong
              </h1>
              <p className="text-sm text-slate-600 mb-6">
                We couldn't reach our servers. Check your connection and try
                again.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="w-full px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg font-semibold hover:bg-[#2563a0]"
              >
                Try again
              </button>
            </>
          )}
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
