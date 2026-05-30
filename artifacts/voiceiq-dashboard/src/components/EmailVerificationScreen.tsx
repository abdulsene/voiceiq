import { useState } from "react";
import { Loader2, Mail, AlertCircle, CheckCircle2 } from "lucide-react";

const API = "/api";

interface Props {
  email?: string;
}

// Sprint 2 STEP 4 / BUG-18 Part 6: full-screen blocking gate rendered by
// DashboardLayout when business_configs.email_verified=FALSE. Mirrors the
// structure of components/PendingPaymentScreen.tsx (BUG-17 sub-step 3e).
//
// Composition with PendingPaymentScreen: payment first, then email. A user
// in pending_payment never sees this screen — they see PendingPaymentScreen
// instead. Once they complete Stripe Checkout and the webhook flips them
// to 'trialing', the verification email fires, and IF they haven't clicked
// it yet they land here. See App.tsx DashboardLayout for the gate ordering
// and the explicit code comment forbidding reordering.
//
// Resend rate-limit: the server returns 429 with retry_after seconds when
// a user spams the button. The button surfaces the wait time inline; we
// don't auto-retry.
export default function EmailVerificationScreen({ email }: Props) {
  const [loading, setLoading] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sent" | "error" | "rate_limited">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [retryAfter, setRetryAfter] = useState<number | null>(null);

  async function handleResend() {
    setLoading(true);
    setErrorMsg("");
    setRetryAfter(null);
    try {
      const token = localStorage.getItem("neverr_token") || "";
      const activeBiz = localStorage.getItem("neverr_active_business_id");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };
      if (activeBiz) headers["X-Active-Business"] = activeBiz;

      const r = await fetch(`${API}/auth/resend-verification`, {
        method: "POST",
        headers,
      });
      const d = await r.json().catch(() => ({}));

      if (r.status === 429) {
        // Rate limited — show wait time. The server passes retry_after as
        // an integer number of seconds.
        const wait = Number(d?.retry_after) || 60;
        setRetryAfter(wait);
        setResendState("rate_limited");
        return;
      }

      if (!r.ok || !d?.success) {
        setErrorMsg(d?.error || `Resend failed (HTTP ${r.status})`);
        setResendState("error");
        return;
      }

      setResendState("sent");
    } catch (e: any) {
      setErrorMsg(e?.message || "Network error. Please try again.");
      setResendState("error");
    } finally {
      setLoading(false);
    }
  }

  function handleSignOut() {
    localStorage.removeItem("neverr_token");
    localStorage.removeItem("neverr_refresh");
    localStorage.removeItem("neverr_business_id");
    localStorage.removeItem("neverr_active_business_id");
    localStorage.removeItem("neverr_last_activity");
    window.location.href = "/signup";
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#f0f2f5] p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex justify-center mb-5">
          <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center">
            <Mail className="w-7 h-7 text-[#2E75B6]" />
          </div>
        </div>

        <h1 className="text-xl font-bold text-gray-900 text-center mb-2">
          Verify your email to continue
        </h1>
        <p className="text-sm text-gray-500 text-center mb-6">
          We sent a verification link to{" "}
          <strong className="text-gray-900">{email || "your email address"}</strong>.
          Click the link to activate your dashboard.
        </p>

        {resendState === "sent" && (
          <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            <p>A fresh verification email is on its way. Check your inbox.</p>
          </div>
        )}

        {resendState === "rate_limited" && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>
              Please wait {retryAfter ?? 60} seconds before requesting another
              email.
            </p>
          </div>
        )}

        {resendState === "error" && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{errorMsg || "Could not send. Please try again."}</p>
          </div>
        )}

        <button
          onClick={handleResend}
          disabled={loading || resendState === "rate_limited"}
          className="w-full inline-flex items-center justify-center gap-2 bg-[#2E75B6] text-white px-6 py-3 rounded-xl font-semibold hover:bg-[#2563a0] disabled:opacity-60 disabled:cursor-not-allowed transition-colors text-sm shadow-md shadow-[#2E75B6]/20"
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Sending...
            </>
          ) : (
            <>
              <Mail className="w-4 h-4" />
              Resend verification email
            </>
          )}
        </button>

        <p className="text-xs text-gray-400 text-center mt-4">
          Don't see it? Check your spam folder. Verification links expire after
          24 hours.
        </p>

        <div className="flex flex-col items-center gap-2 mt-5 text-sm">
          <button
            onClick={handleSignOut}
            disabled={loading}
            className="text-gray-500 hover:text-gray-700 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
