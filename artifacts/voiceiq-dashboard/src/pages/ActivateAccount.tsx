import { useState, useEffect } from "react";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

export default function ActivateAccount() {
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token") || "");
    setEmail(params.get("email") || "");
  }, []);

  async function handleActivate() {
    setError(null);
    if (!token || !email) {
      setError("Invalid activation link. Check your invitation email.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match");
      return;
    }

    setSubmitting(true);
    try {
      const r = await fetch(`${API}/admin/team/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, password }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || `Activation failed (HTTP ${r.status})`);
        setSubmitting(false);
        return;
      }

      // Persist the new session so the user lands logged in.
      if (d.session?.access_token) {
        localStorage.setItem("neverr_token", d.session.access_token);
      }
      if (d.user?.businessId) {
        localStorage.setItem("neverr_active_business_id", d.user.businessId);
      }

      setSuccess(true);
      setTimeout(() => {
        window.location.href = "/dashboard";
      }, 1200);
    } catch (e: any) {
      setError(e.message || "Network error");
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
        <LandingNav />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md text-center">
          <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg
              className="w-8 h-8 text-emerald-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
            <h1 className="text-xl font-bold text-slate-900 mb-2">
              Account activated!
            </h1>
            <p className="text-sm text-slate-600">
              Redirecting you to your dashboard...
            </p>
          </div>
        </div>
        <LandingFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">
          Activate Your Account
        </h1>
        <p className="text-sm text-slate-600 mb-6">
          You've been invited to join Neverr. Set a password to get started.
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1.5">
              Email
            </label>
            <input
              type="email"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50"
              value={email}
              disabled
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1.5">
              Password
            </label>
            <input
              type="password"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              minLength={8}
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1.5">
              Confirm Password
            </label>
            <input
              type="password"
              className="w-full p-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="Re-enter password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              minLength={8}
            />
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}

          <button
            onClick={handleActivate}
            disabled={
              submitting ||
              !password ||
              !confirmPassword ||
              password !== confirmPassword
            }
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg font-semibold hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Activating..." : "Activate Account"}
          </button>
        </div>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}
