import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import LandingNav from "../components/LandingNav";
// Sprint 1 BUG-17 sub-step 3e: PLAN_PRICES + VALID_PLANS were hoisted to
// lib/plans.ts so PendingPaymentScreen renders the same labels and prices
// without duplicating the constant. Behavior here is unchanged — same
// shape, same numbers, same fallback to Essential.
import { PLAN_PRICES, VALID_PLANS, formatPriceLabel } from "../lib/plans";

const API = "/api";

type Cycle = "monthly" | "annual";

// Sprint 1 BUG-40: AuthGuard sends users here as
// /signup?redirect=<original-path> so we can return them to where they
// tried to go after a successful sign-in. Sign-up no longer uses this
// helper (it now redirects to Stripe Checkout instead — BUG-17 sub-step
// 3b), but the LOGIN tab still does. We sanitize the param to a same-
// origin path before navigating: only values that start with a single
// "/" (and not "//" or "/\") are accepted. Anything else (absolute
// URLs, protocol-relative URLs, javascript:, data:, empty) falls back
// to /dashboard. This closes the open-redirect attack surface.
function getSafeRedirect(): string {
  if (typeof window === "undefined") return "/dashboard";
  const params = new URLSearchParams(window.location.search);
  const r = params.get("redirect");
  if (!r) return "/dashboard";
  if (!r.startsWith("/")) return "/dashboard";
  if (r.startsWith("//")) return "/dashboard";
  if (r.startsWith("/\\")) return "/dashboard";
  return r;
}

// Sprint 1 BUG-17 sub-step 3b: parse the optional ?plan=&cycle= params
// PricingPage.tsx forwards when an unauthenticated visitor clicks a tier.
// Invalid or missing values fall back to the locked default of
// essential / monthly so direct hits on /signup (LandingNav, hero CTAs,
// Features bottom CTA) still pre-select a plan and can mint a Stripe
// Checkout session without a separate plan-picker step.
function readSelectedPlan(): { planId: string; cycle: Cycle } {
  if (typeof window === "undefined") return { planId: "essential", cycle: "monthly" };
  const params = new URLSearchParams(window.location.search);
  const plan = (params.get("plan") || "").toLowerCase();
  const cycleRaw = (params.get("cycle") || "").toLowerCase();
  const planId = VALID_PLANS.includes(plan) ? plan : "essential";
  const cycle: Cycle = cycleRaw === "annual" ? "annual" : "monthly";
  return { planId, cycle };
}

// Sprint 5 WorkOS Phase 4: secondary "Sign in with SSO" button on the
// login tab. Reuses the email already typed into the email field above
// (no extra input needed). On click:
//   1. Validates email shape locally (cheap UX win — avoid a roundtrip)
//   2. POST /api/sso/lookup?email=…
//   3. On 200, full-page navigates to /api/sso/init (server 302 → IdP)
//   4. On 404, renders the unified "no SSO configured" message — same
//      string the API returns. We deliberately do not differentiate
//      between "domain not registered" and "you typed a gmail address"
//      because the server doesn't either (anti-enumeration).
//   5. On 503, falls back to "SSO is temporarily unavailable" — happens
//      while migration 014 is still pending in production.
function SsoLoginButton({
  email,
  setError,
  clearError,
}: {
  email: string;
  setError: (m: string) => void;
  clearError: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleSso() {
    clearError();
    const e = (email || "").trim();
    if (!e) {
      setError("Enter your work email above first, then click Sign in with SSO.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      setError("That doesn't look like a valid email address.");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch(`/api/sso/lookup?email=${encodeURIComponent(e)}`, {
        headers: { Accept: "application/json" },
      });
      if (resp.status === 200) {
        const json = (await resp.json()) as { connectionId?: string };
        if (!json.connectionId) {
          setError("Unexpected response from SSO lookup. Try again.");
          setBusy(false);
          return;
        }
        // Full-page nav so the browser hits the api-server's 302 to the
        // IdP. Using fetch() here would just download the redirect.
        window.location.href = `/api/sso/init?connectionId=${encodeURIComponent(json.connectionId)}`;
        return; // leave busy=true so the button stays disabled during nav
      }
      if (resp.status === 404) {
        const json = (await resp.json().catch(() => ({}))) as { message?: string };
        setError(json.message || "SSO is not configured for this email address.");
      } else if (resp.status === 503) {
        setError("SSO is temporarily unavailable. Try again shortly or use password sign-in.");
      } else if (resp.status === 409) {
        setError("Multiple SSO configurations match this email. Contact your administrator.");
      } else {
        setError(`SSO lookup failed (${resp.status}). Use password sign-in for now.`);
      }
    } catch {
      setError("Couldn't reach the SSO service. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleSso}
      disabled={busy}
      style={{
        width: "100%",
        marginTop: "10px",
        padding: "10px",
        background: "white",
        color: busy ? "#94a3b8" : "#2E75B6",
        border: `1px solid ${busy ? "#cbd5e1" : "#2E75B6"}`,
        borderRadius: "10px",
        fontSize: "14px",
        fontWeight: 600,
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      {busy ? "Checking SSO..." : "Sign in with SSO"}
    </button>
  );
}

export default function Signup({ initialTab = "signup" }: { initialTab?: "login" | "signup" }) {
  const [tab, setTab] = useState<"login" | "signup">(initialTab);
  const [loading, setLoading] = useState(false);
  // Drives the submit button label so the user sees a continuous spinner
  // through BOTH the /auth/signup call and the /stripe/create-checkout-session
  // call — never a "done" flash between them.
  const [stage, setStage] = useState<"idle" | "creating" | "checkout">("idle");
  const [error, setError] = useState("");
  // When /auth/signup succeeds but the Checkout session call fails, we
  // surface a "Retry checkout" affordance instead of looping the user back
  // through signup. The account already exists; localStorage stays intact
  // so the retry uses the same JWT and businessId.
  const [retryCheckout, setRetryCheckout] = useState<null | {
    businessId: string;
    email: string;
    planId: string;
    cycle: Cycle;
    token: string;
  }>(null);

  const [smsConsentTransactional, setSmsConsentTransactional] = useState(false);
  const [smsConsentMarketing, setSmsConsentMarketing] = useState(false);
  // Lazy initializer — read URL once on mount; the user can't change plan
  // from inside the form (they go to /pricing via the "Change plan →" link).
  const [{ planId, cycle }] = useState(readSelectedPlan);
  const [form, setForm] = useState({
    business_name: "", email: "", password: "", phone_number: "",
    industry: "general", timezone: "America/New_York",
  });

  // Sprint 3 BUG-07/09: per-field validation. Keyed by the same `key`
  // string used in the inputs .map() below so a single source of truth
  // drives both the red-border + error-text styling AND the focus-on-
  // submit behavior. Cleared on tab switch (so login errors don't leak
  // into the signup form when the user toggles back) and on each field
  // change (so the error disappears the instant the user starts typing
  // a fix, not on the next submit). Never persisted to anywhere.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  function clearFieldError(key: string) {
    setFieldErrors(prev => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function validateSignupForm(): { errors: Record<string, string>; firstInvalid: string | null } {
    const errors: Record<string, string> = {};
    if (!form.business_name.trim()) errors.business_name = "Business name is required";
    if (!form.email.trim()) errors.email = "Email is required";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = "Enter a valid email address";
    if (!form.password) errors.password = "Password is required";
    else if (form.password.length < 8) errors.password = "Password must be at least 8 characters";
    // phone_number / industry / timezone are either optional, default-set,
    // or validated server-side — keep them out of the client gate so the
    // user isn't blocked by anything they can't immediately understand.
    const order = ["business_name", "email", "password"];
    const firstInvalid = order.find(k => errors[k]) || null;
    return { errors, firstInvalid };
  }

  function validateLoginForm(): { errors: Record<string, string>; firstInvalid: string | null } {
    const errors: Record<string, string> = {};
    if (!form.email.trim()) errors.email = "Email is required";
    if (!form.password) errors.password = "Password is required";
    const order = ["email", "password"];
    const firstInvalid = order.find(k => errors[k]) || null;
    return { errors, firstInvalid };
  }

  // Sprint 1 BUG-17 sub-step 3e (Part 4): Stripe Checkout's cancel_url is
  // `${BASE_URL}/signup?checkout=cancelled` (set by 3b/3b-extended). When a
  // user bails at Checkout they land back here. We classify their state and
  // show a recovery banner:
  //   - "logged_in"  → token valid AND row is in 'pending_payment' →
  //                    "Resume Checkout" banner with the same plan they
  //                    originally chose (mints a fresh Checkout session).
  //   - "logged_out" → no token (bailed before signup completed, or signed
  //                    out before bailing) → generic "try signing up again"
  //                    banner that strips the query param.
  //   - "none"       → no ?checkout=cancelled param OR the row isn't
  //                    pending_payment (they paid via another tab, etc.) →
  //                    no banner.
  type CancelState =
    | { kind: "none" }
    | { kind: "checking" }
    | { kind: "logged_in"; businessId: string; planId: string; billingCycle: Cycle; email: string; token: string }
    | { kind: "logged_out" };
  const [cancelState, setCancelState] = useState<CancelState>(() => {
    if (typeof window === "undefined") return { kind: "none" };
    const params = new URLSearchParams(window.location.search);
    return params.get("checkout") === "cancelled" ? { kind: "checking" } : { kind: "none" };
  });
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelError, setCancelError] = useState("");

  useEffect(() => {
    if (cancelState.kind !== "checking") return;
    let cancelled = false;
    const token = localStorage.getItem("neverr_token");
    if (!token) {
      setCancelState({ kind: "logged_out" });
      return;
    }
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (activeBiz) headers["X-Active-Business"] = activeBiz;
    (async () => {
      try {
        const meRes = await fetch(`${API}/auth/me`, { headers });
        if (!meRes.ok) {
          // Sprint 1 BUG-17 sub-step 3e (post-review): if the token was
          // rejected (401/403) the entries in localStorage are stale and
          // the user IS effectively logged out. Wipe them so the next
          // signup attempt starts from a clean slate. 5xx responses are
          // also wiped because the user has to re-auth either way; we
          // distinguish those from real network failures (handled in the
          // catch block below, which leaves the token intact for retry).
          if (!cancelled) {
            localStorage.removeItem("neverr_token");
            localStorage.removeItem("neverr_refresh");
            localStorage.removeItem("neverr_business_id");
            localStorage.removeItem("neverr_active_business_id");
            setCancelState({ kind: "logged_out" });
          }
          return;
        }
        const me = await meRes.json();
        const list = (me?.businesses || []) as any[];
        const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
        if (!biz) { if (!cancelled) setCancelState({ kind: "none" }); return; }
        const businessId = biz.business_id || "";
        const email = me?.user?.email || "";
        // Read the canonical state via /stripe/subscription/:businessId so we
        // honor the same auth+tenant check the gate uses (3b-extended-2).
        const subRes = await fetch(`${API}/stripe/subscription/${encodeURIComponent(businessId)}`, { headers });
        if (!subRes.ok) { if (!cancelled) setCancelState({ kind: "none" }); return; }
        const subData = await subRes.json();
        const sub = subData?.subscription || null;
        if (sub?.subscription_status !== "pending_payment") {
          // They paid in another tab, or were never pending — no banner.
          if (!cancelled) setCancelState({ kind: "none" });
          return;
        }
        const rowPlan = (sub.plan_id as string) || "essential";
        const rowCycleRaw = (sub.billing_cycle as string) || "monthly";
        const rowCycle: Cycle = rowCycleRaw === "annual" ? "annual" : "monthly";
        if (!cancelled) {
          setCancelState({
            kind: "logged_in",
            businessId,
            planId: rowPlan,
            billingCycle: rowCycle,
            email,
            token,
          });
        }
      } catch {
        if (!cancelled) setCancelState({ kind: "logged_out" });
      }
    })();
    return () => { cancelled = true; };
  }, [cancelState.kind]);

  function dismissCancelledParam() {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
  }

  async function handleCancelledResume() {
    if (cancelState.kind !== "logged_in") return;
    setCancelError("");
    setCancelLoading(true);
    try {
      await startCheckout({
        businessId: cancelState.businessId,
        email: cancelState.email,
        planId: cancelState.planId,
        cycle: cancelState.billingCycle,
        token: cancelState.token,
      });
      // window.location.href = data.url inside startCheckout — never returns.
    } catch (e: any) {
      setCancelError(e?.message || "Could not start checkout. Please try again.");
      setCancelLoading(false);
    }
  }

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const planMeta = PLAN_PRICES[planId];
  const priceLabel = cycle === "annual"
    ? `$${planMeta.annualPerMonth}/mo billed annually`
    : `$${planMeta.monthly}/mo`;

  const buttonLabel =
    stage === "creating" ? "Creating account..." :
    stage === "checkout" ? "Starting checkout..." :
    "Create account \u2014 continue to checkout";

  async function startCheckout(args: { businessId: string; email: string; planId: string; cycle: Cycle; token: string }) {
    const r = await fetch(`${API}/stripe/create-checkout-session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({
        planId: args.planId,
        billingCycle: args.cycle,
        businessId: args.businessId,
        email: args.email,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.url) {
      throw new Error(data?.error || "Could not start checkout");
    }
    // Browser navigates to Stripe and never comes back to this page on
    // success — handled by success_url / cancel_url server-side.
    window.location.href = data.url;
  }

  async function handleSignup() {
    // Sprint 3 BUG-07: gate the network call behind client-side validation
    // so the user gets per-field errors INSTANTLY rather than waiting for
    // the server to return a generic "Validation failed" string. Server
    // remains the source of truth for anything we can't check here
    // (duplicate email, plan mismatch, etc.) — those still surface via
    // the existing `error` banner.
    const { errors, firstInvalid } = validateSignupForm();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError("");
      if (firstInvalid) setTimeout(() => inputRefs.current[firstInvalid]?.focus(), 0);
      return;
    }
    setFieldErrors({});
    setError("");
    setRetryCheckout(null);
    setLoading(true);
    setStage("creating");
    try {
      const r = await fetch(`${API}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          plan_id: planId,
          billing_cycle: cycle,
          sms_consent_transactional: smsConsentTransactional,
          sms_consent_marketing: smsConsentMarketing,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.error || "Signup failed");
        setStage("idle");
        setLoading(false);
        return;
      }

      // Persist the session immediately — the account exists from this
      // point. If the Checkout call below fails, we KEEP localStorage so
      // the retry button can use the same JWT and businessId.
      const token = d.session.access_token;
      localStorage.setItem("neverr_token", token);
      localStorage.setItem("neverr_refresh", d.session.refresh_token);
      localStorage.setItem("neverr_business_id", d.business_id);
      localStorage.setItem("neverr_active_business_id", d.business_id);

      const checkoutArgs = {
        businessId: d.business_id,
        email: form.email,
        planId: (d.plan_id as string) || planId,
        cycle: (d.billing_cycle as Cycle) || cycle,
        token,
      };

      // Continuous spinner: don't toggle loading off here — flow straight
      // into the checkout-session call so the user never sees an idle blip.
      setStage("checkout");
      try {
        await startCheckout(checkoutArgs);
        // Browser navigates away on success.
      } catch (e: any) {
        setError(
          "Account created, but we couldn't start checkout. Please try again, or visit /pricing to choose a plan."
        );
        setRetryCheckout(checkoutArgs);
        setStage("idle");
        setLoading(false);
      }
    } catch {
      setError("Connection error. Please try again.");
      setStage("idle");
      setLoading(false);
    }
  }

  async function handleRetryCheckout() {
    if (!retryCheckout) return;
    setError("");
    setLoading(true);
    setStage("checkout");
    try {
      await startCheckout(retryCheckout);
    } catch {
      setError(
        "Still couldn't start checkout. Please try again, or visit /pricing to choose a plan."
      );
      setStage("idle");
      setLoading(false);
    }
  }

  async function handleLogin() {
    // Sprint 3 BUG-09: same client-side gate as handleSignup. Login only
    // requires email + password to be present — format validation is the
    // server's job (and "wrong password" is what /auth/login returns;
    // we keep that behavior intact via the existing `error` banner).
    const { errors, firstInvalid } = validateLoginForm();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError("");
      if (firstInvalid) setTimeout(() => inputRefs.current[firstInvalid]?.focus(), 0);
      return;
    }
    setFieldErrors({});
    setError(""); setLoading(true);
    try {
      const r = await fetch(`${API}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email, password: form.password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Login failed"); return; }
      if (d.mfa_required && d.mfa_factor_id) {
        localStorage.setItem("neverr_token", d.session.access_token);
        localStorage.setItem("neverr_refresh", d.session.refresh_token);
        localStorage.setItem("neverr_business_id", d.user.business_id);
        localStorage.setItem("neverr_active_business_id", d.user.business_id);
        localStorage.setItem("mfa_factor_id", d.mfa_factor_id);
        localStorage.setItem("mfa_pending", "true");
        window.location.href = "/mfa-verify";
        return;
      }

      localStorage.setItem("neverr_token", d.session.access_token);
      localStorage.setItem("neverr_refresh", d.session.refresh_token);
      localStorage.setItem("neverr_business_id", d.user.business_id);
      localStorage.setItem("neverr_active_business_id", d.user.business_id);
      // Sprint 1 BUG-40: honor ?redirect= (sanitized) on the non-MFA login
      // path. The MFA branch above intentionally still goes to /mfa-verify
      // — preserving the redirect across MFA is out of scope for this step.
      window.location.href = getSafeRedirect();
    } catch { setError("Connection error. Please try again."); }
    finally { setLoading(false); }
  }

  return (
    /* Sprint 2 STEP 2 (BUG-13): outer wrapper changed from a flex-centered
       container to a column block so LandingNav can sit above the form
       without being pulled into the centering. The duplicate logo+tagline
       header that used to sit above the form card has been removed —
       LandingNav now provides the brand mark. The form-card is centered
       horizontally inside a nested flex container with comfortable
       padding so the visual rhythm is preserved. */
    <div style={{ minHeight: "100vh", background: "#f8fafc", fontFamily: "system-ui, sans-serif" }}>
      <LandingNav />
      <div style={{ display: "flex", justifyContent: "center", padding: "32px 24px" }}>
        <div style={{ width: "100%", maxWidth: "440px" }}>

        {/* Sprint 1 BUG-17 sub-step 3e Part 4: ?checkout=cancelled banner.
            Sits ABOVE the form card so it's the first thing the user sees
            after bailing at Stripe. Hidden when the URL param isn't present
            or when classification finds the row isn't actually pending. */}
        {cancelState.kind === "logged_in" && (
          <div style={{
            background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "12px",
            padding: "16px", marginBottom: "16px",
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "10px" }}>
              <AlertCircle style={{ width: "18px", height: "18px", color: "#b45309", flexShrink: 0, marginTop: "2px" }} />
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "13px", fontWeight: 600, color: "#92400e", margin: 0 }}>
                  Checkout cancelled
                </p>
                <p style={{ fontSize: "12.5px", color: "#92400e", marginTop: "2px", lineHeight: 1.45 }}>
                  Your account is created but not yet active. You selected the{" "}
                  <strong>{PLAN_PRICES[cancelState.planId]?.label || cancelState.planId}</strong>{" "}
                  plan ({formatPriceLabel(cancelState.planId, cancelState.billingCycle)}).
                </p>
              </div>
            </div>
            {cancelError && (
              <div style={{
                background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c",
                padding: "8px 10px", borderRadius: "6px", fontSize: "12px", marginBottom: "10px",
              }}>
                {cancelError}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button
                onClick={handleCancelledResume}
                disabled={cancelLoading}
                style={{
                  display: "inline-flex", alignItems: "center", gap: "6px",
                  background: "#2E75B6", color: "white", border: "none",
                  padding: "8px 14px", borderRadius: "8px", fontSize: "13px",
                  fontWeight: 600, cursor: cancelLoading ? "not-allowed" : "pointer",
                  opacity: cancelLoading ? 0.6 : 1,
                }}
              >
                {cancelLoading ? (
                  <><Loader2 style={{ width: "14px", height: "14px" }} className="animate-spin" /> Starting checkout...</>
                ) : (
                  <><CreditCard style={{ width: "14px", height: "14px" }} /> Resume Checkout</>
                )}
              </button>
              <a
                href="/pricing"
                style={{
                  display: "inline-flex", alignItems: "center",
                  background: "transparent", color: "#2E75B6", border: "1px solid #cbd5e1",
                  padding: "8px 14px", borderRadius: "8px", fontSize: "13px",
                  fontWeight: 500, textDecoration: "none",
                }}
              >
                Choose a different plan
              </a>
            </div>
          </div>
        )}
        {cancelState.kind === "logged_out" && (
          <div style={{
            background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "12px",
            padding: "14px", marginBottom: "16px",
            display: "flex", alignItems: "flex-start", gap: "10px",
          }}>
            <AlertCircle style={{ width: "18px", height: "18px", color: "#b45309", flexShrink: 0, marginTop: "2px" }} />
            <div style={{ flex: 1, fontSize: "13px", color: "#92400e", lineHeight: 1.45 }}>
              Checkout was cancelled.{" "}
              <button
                type="button"
                onClick={() => {
                  dismissCancelledParam();
                  setCancelState({ kind: "none" });
                }}
                style={{
                  background: "none", border: "none", color: "#2E75B6",
                  textDecoration: "underline", cursor: "pointer",
                  fontWeight: 500, fontSize: "13px", padding: 0,
                }}
              >
                Try signing up again
              </button>
            </div>
          </div>
        )}

        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "36px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ display: "flex", background: "#f8fafc", borderRadius: "8px", padding: "3px", marginBottom: "20px" }}>
            {(["signup", "login"] as const).map(t => (
              <button key={t} onClick={() => { setTab(t); setError(""); setFieldErrors({}); }} style={{ flex: 1, padding: "8px", border: "none", borderRadius: "6px", fontSize: "14px", fontWeight: 500, cursor: "pointer", background: tab === t ? "white" : "transparent", color: tab === t ? "#1B2537" : "#64748b", boxShadow: tab === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none", transition: "all 0.15s" }}>
                {t === "signup" ? "Create account" : "Sign in"}
              </button>
            ))}
          </div>

          {/* BUG-17 sub-step 3b: read-only "selected plan" pill. Subtle band
              above the form fields so the user knows what they're being
              checked out into and can switch via /pricing if they want a
              different tier. Only shown on the signup tab. */}
          {tab === "signup" && (
            <div style={{
              background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: "12px",
              padding: "14px 16px", marginBottom: "20px",
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
              flexWrap: "wrap",
            }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "3px", flex: "1 1 auto", minWidth: "200px" }}>
                <div style={{ fontSize: "16px", fontWeight: 600, color: "#0f172a", lineHeight: 1.3 }}>
                  Starting on {planMeta.label} &mdash; 7 days free
                </div>
                <div style={{ fontSize: "13px", color: "#475569", lineHeight: 1.4 }}>
                  {priceLabel} + ${planMeta.setupFee} one-time setup after trial
                </div>
              </div>
              <a href="/pricing" style={{ fontSize: "13px", color: "#2E75B6", whiteSpace: "nowrap", textDecoration: "none", fontWeight: 500 }}>
                View all plans &rarr;
              </a>
            </div>
          )}

          {error && <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "11px 14px", borderRadius: "8px", fontSize: "13px", marginBottom: "18px" }}>{error}</div>}

          {tab === "signup" && (
            <div>
              {[
                { label: "Business name", key: "business_name", type: "text", placeholder: "Acme Dental, Smith Law Firm..." },
                { label: "Work email", key: "email", type: "email", placeholder: "you@yourbusiness.com" },
                { label: "Password", key: "password", type: "password", placeholder: "Min 8 characters" },
                { label: "Business phone", key: "phone_number", type: "text", placeholder: "+1 555 000 0000" },
              ].map(({ label, key, type, placeholder }) => {
                // Sprint 3 BUG-07: per-field error rendering. Red border +
                // inline message below the input. Clears on input change so
                // typing a fix immediately resolves the error UI without
                // waiting for the next submit.
                const fe = fieldErrors[key];
                return (
                  <div key={key} style={{ marginBottom: "16px" }}>
                    <label style={{ display: "block", fontSize: "13px", fontWeight: 500, color: "#0f172a", marginBottom: "6px" }}>{label}</label>
                    <input
                      ref={el => { inputRefs.current[key] = el; }}
                      type={type} placeholder={placeholder} value={(form as any)[key]}
                      onChange={e => { set(key, e.target.value); clearFieldError(key); }}
                      disabled={!!retryCheckout}
                      aria-invalid={fe ? true : undefined}
                      aria-describedby={fe ? `signup-err-${key}` : undefined}
                      style={{ width: "100%", padding: "10px 13px", border: fe ? "1px solid #dc2626" : "1px solid #e2e8f0", borderRadius: "10px", fontSize: "14px", outline: "none", boxSizing: "border-box", background: retryCheckout ? "#f8fafc" : "white" }} />
                    {fe && (
                      <p id={`signup-err-${key}`} style={{ color: "#dc2626", fontSize: "12px", marginTop: "6px", marginBottom: 0, lineHeight: 1.4 }}>
                        {fe}
                      </p>
                    )}
                  </div>
                );
              })}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "16px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 500, color: "#0f172a", marginBottom: "6px" }}>Industry</label>
                  <select value={form.industry} onChange={e => set("industry", e.target.value)} disabled={!!retryCheckout} style={{ width: "100%", padding: "10px 13px", border: "1px solid #e2e8f0", borderRadius: "10px", fontSize: "14px", outline: "none", background: retryCheckout ? "#f8fafc" : "white" }}>
                    <option value="general">General Business</option>
                    <optgroup label="Healthcare">
                      <option value="dental">Dental</option>
                      <option value="medical">Medical</option>
                    </optgroup>
                    <optgroup label="Professional Services">
                      <option value="consulting">Consulting / Professional Services</option>
                      <option value="legal">Legal</option>
                      <option value="real_estate">Real Estate</option>
                    </optgroup>
                    <optgroup label="Home Services">
                      <option value="hvac">HVAC / Plumbing</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="automotive">Automotive</option>
                      <option value="beauty">Beauty / Wellness</option>
                      <option value="government">Government</option>
                      <option value="restaurant">Restaurant</option>
                      <option value="solo_entrepreneur">Solo Entrepreneur</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 500, color: "#0f172a", marginBottom: "6px" }}>Timezone</label>
                  <select value={form.timezone} onChange={e => set("timezone", e.target.value)} disabled={!!retryCheckout} style={{ width: "100%", padding: "10px 13px", border: "1px solid #e2e8f0", borderRadius: "10px", fontSize: "14px", outline: "none", background: retryCheckout ? "#f8fafc" : "white" }}>
                    <option value="America/New_York">Eastern (ET)</option>
                    <option value="America/Chicago">Central (CT)</option>
                    <option value="America/Denver">Mountain (MT)</option>
                    <option value="America/Los_Angeles">Pacific (PT)</option>
                    <option value="America/Phoenix">Arizona</option>
                    <option value="Pacific/Honolulu">Hawaii</option>
                  </select>
                </div>
              </div>

              {/* TWO SEPARATE CONSENT CHECKBOXES — Twilio 10DLC compliance.
                  Both voluntary, both default unchecked, neither gates submit. */}
              <div style={{ marginBottom: "16px" }}>
                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "12px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={smsConsentTransactional}
                    onChange={e => setSmsConsentTransactional(e.target.checked)}
                    disabled={!!retryCheckout}
                    style={{ marginTop: "2px", width: "16px", height: "16px", accentColor: "#2E75B6", flexShrink: 0 }}
                  />
                  <span style={{ fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
                    I agree to receive <strong>transactional SMS</strong> from Neverr.ai (call summaries, lead alerts, account notifications). Message frequency varies. Data rates may apply. Reply STOP to opt out.
                  </span>
                </label>

                <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={smsConsentMarketing}
                    onChange={e => setSmsConsentMarketing(e.target.checked)}
                    disabled={!!retryCheckout}
                    style={{ marginTop: "2px", width: "16px", height: "16px", accentColor: "#2E75B6", flexShrink: 0 }}
                  />
                  <span style={{ fontSize: "13px", color: "#334155", lineHeight: "1.5" }}>
                    I agree to receive <strong>marketing SMS</strong> from Neverr.ai (product updates, promotions, tips). Frequency varies. Data rates may apply. Reply HELP for help, STOP to opt out.
                  </span>
                </label>
              </div>

              {retryCheckout ? (
                <button onClick={handleRetryCheckout} disabled={loading} style={{ width: "100%", padding: "11px", background: loading ? "#94a3b8" : "#2E75B6", color: "white", border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}>
                  {loading ? "Starting checkout..." : "Retry checkout"}
                </button>
              ) : (
                <button onClick={handleSignup} disabled={loading} style={{ width: "100%", padding: "11px", background: loading ? "#94a3b8" : "#2E75B6", color: "white", border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}>
                  {buttonLabel}
                </button>
              )}

              <p style={{ fontSize: "12px", color: "#64748B", lineHeight: "1.6", marginTop: "14px" }}>
                By creating an account, you agree to our{" "}
                <a href="/terms" style={{ color: "#2E75B6", textDecoration: "underline" }}>Terms of Service</a>{" "}and{" "}
                <a href="/privacy" style={{ color: "#2E75B6", textDecoration: "underline" }}>Privacy Policy</a>.
                SMS communications are sent only with your explicit consent above. Message frequency varies. Data rates may apply. Reply STOP to unsubscribe.
              </p>

              <div style={{ textAlign: "center", marginTop: "12px", fontSize: "12px", color: "#94a3b8" }}>
                AI receptionist live within 48 hours · No credit card required
              </div>
            </div>
          )}

          {tab === "login" && (
            <div>
              {[
                { label: "Email address", key: "email", type: "email", placeholder: "you@yourbusiness.com" },
                { label: "Password", key: "password", type: "password", placeholder: "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" },
              ].map(({ label, key, type, placeholder }) => {
                // Sprint 3 BUG-09: per-field error rendering for sign-in.
                // Same red-border + inline-message + clear-on-change pattern
                // as the signup tab above. Also keeps the existing
                // Enter-to-submit affordance.
                const fe = fieldErrors[key];
                return (
                  <div key={key} style={{ marginBottom: "16px" }}>
                    <label style={{ display: "block", fontSize: "13px", fontWeight: 500, color: "#0f172a", marginBottom: "6px" }}>{label}</label>
                    <input
                      ref={el => { inputRefs.current[key] = el; }}
                      type={type} placeholder={placeholder} value={(form as any)[key]}
                      onChange={e => { set(key, e.target.value); clearFieldError(key); }}
                      onKeyDown={e => e.key === "Enter" && handleLogin()}
                      aria-invalid={fe ? true : undefined}
                      aria-describedby={fe ? `login-err-${key}` : undefined}
                      style={{ width: "100%", padding: "10px 13px", border: fe ? "1px solid #dc2626" : "1px solid #e2e8f0", borderRadius: "10px", fontSize: "14px", outline: "none", boxSizing: "border-box" }} />
                    {fe && (
                      <p id={`login-err-${key}`} style={{ color: "#dc2626", fontSize: "12px", marginTop: "6px", marginBottom: 0, lineHeight: 1.4 }}>
                        {fe}
                      </p>
                    )}
                  </div>
                );
              })}
              {/* Forgot password? / Forgot email? — both link to dedicated
                  pages. Forgot password was previously an inline POST +
                  state machine on this tab; Forgot email is new and routes
                  to the help-recover-account support intake. Both pages
                  handle their own success/error states. */}
              <div style={{ textAlign: "right", marginTop: "-4px", marginBottom: "14px", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
                <Link
                  href="/forgot-password"
                  style={{
                    fontSize: "12.5px",
                    color: "#2E75B6",
                    fontWeight: 500,
                    textDecoration: "none",
                  }}
                >
                  Forgot password?
                </Link>
                <span style={{ fontSize: "12.5px", color: "#cbd5e1" }}>·</span>
                <Link
                  href="/forgot-username"
                  style={{
                    fontSize: "12.5px",
                    color: "#2E75B6",
                    fontWeight: 500,
                    textDecoration: "none",
                  }}
                >
                  Forgot email?
                </Link>
              </div>
              <button onClick={handleLogin} disabled={loading} style={{ width: "100%", padding: "11px", background: loading ? "#94a3b8" : "#2E75B6", color: "white", border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}>
                {loading ? "Signing in..." : "Sign in to dashboard"}
              </button>

              {/* Sprint 5 WorkOS Phase 4: SSO entry point. Reuses the
                  email already entered in the form above to keep the
                  flow one-click. Calls /api/sso/lookup; on hit, full-
                  page navigates to /api/sso/init (server 302s to IdP).
                  Inline error rendering matches the same red-text
                  pattern as the per-field errors above so the styling
                  stays consistent. Kept visually secondary (outlined,
                  not solid) so password sign-in remains the primary
                  call-to-action — most users do NOT have SSO. */}
              <SsoLoginButton email={form.email} setError={(m) => setFieldErrors(prev => ({ ...prev, sso: m }))} clearError={() => setFieldErrors(prev => { const n = { ...prev }; delete n.sso; return n; })} />
              {fieldErrors.sso && (
                <p style={{ color: "#dc2626", fontSize: "12px", marginTop: "8px", marginBottom: 0, lineHeight: 1.4, textAlign: "center" }}>
                  {fieldErrors.sso}
                </p>
              )}
            </div>
          )}
        </div>
        <div style={{ textAlign: "center", marginTop: "16px" }}>
          <a href="/demo" style={{ fontSize: "13px", color: "#2E75B6", textDecoration: "none", fontWeight: 500 }}>
            Try a live demo first &rarr;
          </a>
        </div>
        <div style={{ textAlign: "center", marginTop: "12px", fontSize: "12px", color: "#94a3b8" }}>
          Powered by ElevenLabs + Anthropic Claude
        </div>
        </div>
      </div>
    </div>
  );
}
