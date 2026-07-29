import { useState, useEffect } from "react";
import { Switch, Route, Router as WouterRouter, useLocation, Redirect } from "wouter";
import { ArrowRight } from "lucide-react";
import Sidebar from "./components/Sidebar";
import CommandCenter from "./pages/CommandCenter";
import CallsLeads from "./pages/CallsLeads";
import LeadsListPage from "./pages/Leads/LeadsListPage";
import LeadDetailPage from "./pages/Leads/LeadDetailPage";
import CampaignsListPage from "./pages/Campaigns/CampaignsListPage";
import CampaignDetailPage from "./pages/Campaigns/CampaignDetailPage";
import { Toaster as SonnerToaster } from "./components/ui/sonner";
import CallbackSettingsPage from "./pages/Leads/CallbackSettingsPage";
import TrustPortalPage from "./pages/Public/TrustPortalPage";
import Contacts from "./pages/Contacts";
import Appointments from "./pages/Appointments";
import SmsCampaigns from "./pages/SmsCampaigns";
import Analytics from "./pages/Analytics";
import Benchmarks from "./pages/Benchmarks";
import AdminAuditLogs from "./pages/AdminAuditLogs";
import BusinessesList from "./pages/admin/BusinessesList";
import BusinessDetail from "./pages/admin/BusinessDetail";
import Government from "./pages/Government";
import SettingsPage from "./pages/SettingsPage";
import AiSettingsPage from "./pages/AiSettingsPage";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Signup from "./pages/Signup";
import Demo from "./pages/Demo";
import DemoCall from "./pages/DemoCall";
import Demos from "./pages/Demos";
import Landing from "./pages/Landing";
import TryYourAgent from "./pages/TryYourAgent";
import SalesDemoPage from "./pages/SalesDemoPage";
import IndustriesHub from "./pages/IndustriesHub";
import IndustryDetailPage from "./pages/IndustryDetailPage";
import IndustryCategoryPage from "./pages/IndustryCategoryPage";
import PricingPage from "./pages/PricingPage";
import RoiPage from "./pages/RoiPage";
import Features from "./pages/Features";
import ContactPage from "./pages/ContactPage";
import MultilingualShowcase from "./pages/MultilingualShowcase";
import EnterprisePage from "./pages/EnterprisePage";
import Partner from "./pages/Partner";
import MfaSetup from "./pages/MfaSetup";
import MfaVerify from "./pages/MfaVerify";
import FirstTimeOnboarding from "./components/FirstTimeOnboarding";
import PendingPaymentScreen from "./components/PendingPaymentScreen";
import { LocationProvider } from "./components/LocationContext";
import LocationSwitcher from "./components/LocationSwitcher";
import BusinessSwitcher from "./components/BusinessSwitcher";
import AddBusinessModal from "./components/AddBusinessModal";
// Phase 3.1b: On-duty toggle for the dashboard header. Mounted alongside
// BusinessSwitcher + LocationSwitcher so any staff member can clock in /
// out from any dashboard page without navigating to /team.
import OnDutyToggle from "./components/OnDutyToggle";
// Phase 3.1b: new /team page.
import TeamPage from "./pages/Team/TeamPage";
import ActivateAccount from "./pages/ActivateAccount";
import SmsOptInPage from "./pages/SmsOptInPage";
import VerifyEmail from "./pages/VerifyEmail";
import ForgotPassword from "./pages/ForgotPassword";
import ForgotUsername from "./pages/ForgotUsername";
import ResetPassword from "./pages/ResetPassword";
import EmailVerificationScreen from "./components/EmailVerificationScreen";
// Sprint 5 Alex Phase 2: floating chat widget mounted at App level so a
// single instance survives client-side navigations. The component
// self-hides on auth/contact forms and on authenticated dashboard routes
// via its own useLocation() check (see ChatWidget.tsx HIDE_EXACT /
// HIDE_PREFIX).
import ChatWidget from "./components/ChatWidget";
// GDPR cookie consent (CookieYes). Renders nothing — only toggles a
// CSS class on <html> based on route so the CookieYes banner UI is
// suppressed on auth/contact forms and inside the authenticated
// dashboard. Script itself is loaded in index.html so consent state is
// available app-wide. See CookieConsentManager.tsx + index.css
// ("CookieYes — route-scoped UI suppression").
import CookieConsentManager from "./components/CookieConsentManager";

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const ACTIVITY_KEY = "neverr_last_activity";

function updateActivity() {
  localStorage.setItem(ACTIVITY_KEY, Date.now().toString());
}

function isSessionExpired(): boolean {
  const last = localStorage.getItem(ACTIVITY_KEY);
  if (!last) return false;
  return Date.now() - parseInt(last, 10) > SESSION_TIMEOUT_MS;
}

// Sprint 4 TC-59: exported so Sidebar.handleLogout (and any future
// sign-out path) can call the SAME clear used by AuthGuard's idle/expired
// path. Previously each call site duplicated a partial removeItem list,
// which drifted (Sidebar was missing ACTIVITY_KEY and the mfa_* keys).
// Single source of truth = no key-list drift between paths.
export function clearSession() {
  localStorage.removeItem("neverr_token");
  localStorage.removeItem("neverr_refresh");
  localStorage.removeItem("neverr_business_id");
  // Phase 3e multi-business: also drop the active-business pointer on
  // logout, otherwise the next user on this device would inherit the
  // previous user's tenant selection.
  localStorage.removeItem("neverr_active_business_id");
  localStorage.removeItem(ACTIVITY_KEY);
  // Sprint 4 TC-59: also wipe MFA scratch keys so a partial-MFA state
  // from a previous user doesn't leak into the next user's signin on a
  // shared device.
  localStorage.removeItem("mfa_pending");
  localStorage.removeItem("mfa_factor_id");
  localStorage.removeItem("mfa_attempts");
  localStorage.removeItem("mfa_locked_until");
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  // Sprint 1 BUG-40: the previous AuthGuard only checked
  // `localStorage.getItem("neverr_token")` for *presence* of any string,
  // which a user could trivially bypass by pasting a fake token in devtools
  // and briefly seeing the dashboard chrome render. We now validate the
  // token against the server (Supabase via /auth/me) on mount and gate
  // children on success. Loading state renders a minimal spinner — never
  // the dashboard chrome — so a 401 token never paints UI.
  const [authState, setAuthState] = useState<"checking" | "ok" | "denied">(
    () => (localStorage.getItem("neverr_token") ? "checking" : "denied"),
  );

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem("neverr_token");

    // No token at mount: skip the server roundtrip and redirect immediately.
    // (initial state above is already "denied" in that case, but we re-assert
    // here for the rare race where the key was cleared between the lazy
    // initialiser and this effect.)
    if (!token) {
      setAuthState("denied");
      return;
    }

    // Idle timeout still trumps the server call — if the user has been gone
    // for >30 min we don't want to ping the server with a token we're about
    // to discard.
    if (isSessionExpired()) {
      clearSession();
      setAuthState("denied");
      return;
    }

    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) {
          updateActivity();
          setAuthState("ok");
        } else {
          // 401 / 403 / any non-2xx: token is invalid, expired, or
          // tampered. Wipe ALL neverr_* keys so a stale tenant pointer
          // doesn't leak into the next session, then fall through to the
          // Redirect below with a ?redirect= param so post-auth lands the
          // user back where they tried to go.
          clearSession();
          setAuthState("denied");
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Network error: be conservative and treat as denied. Letting a
        // flaky network silently expose dashboard chrome would defeat the
        // entire point of this guard.
        clearSession();
        setAuthState("denied");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Idle-timeout listeners are only relevant once we've confirmed the
  // user is authenticated. Splitting them out of the validation effect
  // keeps the spinner state clean and avoids attaching listeners that we'd
  // immediately tear down on a denied response.
  useEffect(() => {
    if (authState !== "ok") return;
    const events = ["mousedown", "keydown", "scroll", "touchstart"];
    const handler = () => updateActivity();
    events.forEach((e) => window.addEventListener(e, handler, { passive: true }));
    const interval = setInterval(() => {
      if (isSessionExpired()) {
        clearSession();
        setAuthState("denied");
      }
    }, 60 * 1000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, handler));
      clearInterval(interval);
    };
  }, [authState]);

  // Sprint 4 TC-59: bfcache (back-forward cache) restore handler.
  //
  // QA reproduced this: user signs out -> /signup loads -> user clicks
  // browser BACK -> the dashboard re-appears fully rendered, even though
  // localStorage has been wiped. Root cause: modern browsers (Safari /
  // Firefox / Chrome since 2022) restore the previous page from an
  // in-memory snapshot on back navigation. React does NOT remount, so
  // the mount-time useEffect above never re-runs and AuthGuard's state
  // is restored as "ok" from before the logout.
  //
  // The `pageshow` event fires on EVERY navigation including bfcache
  // restore, and `event.persisted === true` is the bfcache flag. On a
  // bfcache restore we re-check the token: if it's gone (or the session
  // is idle-expired), force the guard back to "denied" which triggers
  // the <Redirect to="/signup"> path below.
  //
  // On a fresh load (`persisted === false`) we no-op because the mount
  // effect above has already run the full /auth/me validation. Adding
  // this listener does NOT alter BUG-40's existing behavior; it only
  // covers the bfcache hole that BUG-40 couldn't see (BUG-40 relied on
  // mount, bfcache deliberately skips mount).
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      const token = localStorage.getItem("neverr_token");
      if (!token || isSessionExpired()) {
        clearSession();
        setAuthState("denied");
      }
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  if (authState === "checking") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#f0f2f5]">
        <div className="animate-spin w-8 h-8 border-[3px] border-[#2E75B6] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (authState === "denied") {
    // Preserve the path the user actually requested so post-auth can send
    // them back. encodeURIComponent handles query strings / hashes safely.
    const redirectTo = encodeURIComponent(location || "/dashboard");
    return <Redirect to={`/signup?redirect=${redirectTo}`} />;
  }

  if (localStorage.getItem("mfa_pending") === "true") {
    return <Redirect to="/mfa-verify" />;
  }
  return <>{children}</>;
}

function DemoBanner() {
  const [demoInfo, setDemoInfo] = useState<{ isDemo: boolean; businessName: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) return;
    // Pass active business so we surface the membership for the tenant
    // the user is currently viewing, not d.businesses[0] (their oldest).
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (activeBiz) headers["X-Active-Business"] = activeBiz;
    fetch("/api/auth/me", { headers })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        const list = (d?.businesses || []) as any[];
        const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
        if (!biz) return;
        const config = Array.isArray(biz.business_configs) ? biz.business_configs[0] : biz.business_configs;
        // The banner is a "you're poking at the public demo, sign up for
        // your own account" prompt — only the explicit `demo` viewer role
        // should see it. Owners / admins / members of a business that
        // happens to have a `demo-` id prefix or status="demo" already
        // own the data; nagging them to "Get your own account" is wrong.
        if (biz.role === "demo") {
          setDemoInfo({ isDemo: true, businessName: config?.business_name || "Demo Business" });
        }
      })
      .catch(() => {});
  }, []);

  if (!demoInfo?.isDemo) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-amber-800">
        <span>🎯</span>
        <span>
          You are viewing a demo account — <strong>{demoInfo.businessName}</strong> | This is sample data
        </span>
      </div>
      <a
        href="/signup"
        className="flex items-center gap-1 text-sm font-semibold text-amber-900 hover:text-amber-700 transition-colors"
      >
        Get your own account <ArrowRight className="w-4 h-4" />
      </a>
    </div>
  );
}

// Sprint 1 BUG-17 sub-step 3e: state machine for the dashboard's
// subscription_status gate. This sits INSIDE AuthGuard (auth has already
// validated) and decides what to render based on the active business's
// Stripe subscription state. The "loading" state mandatory render rule
// mirrors BUG-40: dashboard children NEVER paint before the gate resolves
// or pending_payment users would see the dashboard flash before being
// redirected to PendingPaymentScreen.
type GateState =
  | { kind: "loading" }
  | { kind: "blocked"; businessId: string; planId: string; billingCycle: string; email?: string }
  | { kind: "polling_success"; businessId: string }
  | { kind: "polling_timeout"; businessId: string }
  // Sprint 2 STEP 4 / BUG-18 Part 6: composed AFTER the pending_payment
  // gate clears. A user in pending_payment never sees this — they see
  // PendingPaymentScreen instead. Only after they complete Stripe
  // Checkout AND business_configs.email_verified is still false do they
  // land here.
  | { kind: "email_unverified"; email?: string }
  | { kind: "ready"; showOnboarding: boolean }
  | { kind: "error"; showOnboarding: boolean };

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

function stripCheckoutSuccessParam() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  url.searchParams.delete("plan");
  window.history.replaceState({}, "", url.pathname + (url.search ? url.search : "") + url.hash);
}

function DashboardLayout() {
  const [gateState, setGateState] = useState<GateState>({ kind: "loading" });
  const [showAddBiz, setShowAddBiz] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const token = localStorage.getItem("neverr_token");
    if (!token) { setGateState({ kind: "ready", showOnboarding: false }); return; }

    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (activeBiz) headers["X-Active-Business"] = activeBiz;

    // Sprint 1 BUG-17 sub-step 3e Part 5: detect ?checkout=success up front
    // so we can show the celebratory toast immediately and start polling
    // even before the first /stripe/subscription fetch resolves.
    const params = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
    const isCheckoutSuccess = params.get("checkout") === "success";
    if (isCheckoutSuccess) {
      setShowSuccessToast(true);
      stripCheckoutSuccessParam();
    }

    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", { headers });
        if (!meRes.ok) {
          // Should be impossible inside AuthGuard (which already validated),
          // but if /auth/me fails here we fall through to the error state
          // and render the dashboard so we don't trap a real user.
          if (!cancelled) setGateState({ kind: "error", showOnboarding: false });
          return;
        }
        const me = await meRes.json();
        const list = (me?.businesses || []) as any[];
        const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
        if (!biz) {
          // No business memberships at all — render dashboard so the user
          // can see the chrome and (if relevant) add a business.
          if (!cancelled) setGateState({ kind: "ready", showOnboarding: false });
          return;
        }
        const config = Array.isArray(biz.business_configs) ? biz.business_configs[0] : biz.business_configs;
        const businessId = biz.business_id || "";
        const isDemo = config?.status === "demo" || biz.role === "demo" || businessId.startsWith("demo-");
        const hasAgent = !!config?.agent_id;
        const onboardingDone = !!config?.onboarding_complete;
        const wantsOnboarding = !isDemo && !hasAgent && !onboardingDone;

        // Demo accounts have no Stripe subscription row; the gate doesn't
        // apply to them. Render dashboard normally.
        if (isDemo || !businessId) {
          if (!cancelled) setGateState({ kind: "ready", showOnboarding: wantsOnboarding });
          return;
        }

        const subRes = await fetch(`/api/stripe/subscription/${encodeURIComponent(businessId)}`, { headers });
        if (!subRes.ok) {
          // Defensive: subscription endpoint failed. The 3d gate on
          // /auth/complete-onboarding is the actual entitlement backstop
          // server-side, so failing open here is safer than trapping the
          // user behind PendingPaymentScreen they can't escape.
          if (!cancelled) setGateState({ kind: "error", showOnboarding: wantsOnboarding });
          return;
        }
        const subData = await subRes.json();
        const sub = subData?.subscription || null;
        const status = sub?.subscription_status || null;
        const planId = (sub?.plan_id as string) || "essential";
        const billingCycle = (sub?.billing_cycle as string) || "monthly";
        const email = me?.user?.email || undefined;

        if (cancelled) return;

        if (status === "pending_payment") {
          if (isCheckoutSuccess) {
            // The user just completed Stripe Checkout but the webhook
            // hasn't flipped the row to 'trialing' yet. Enter polling mode
            // instead of showing PendingPaymentScreen so the post-Checkout
            // race feels seamless.
            setGateState({ kind: "polling_success", businessId });
          } else {
            setGateState({ kind: "blocked", businessId, planId, billingCycle, email });
          }
        } else if (config?.email_verified === false) {
          // Sprint 2 STEP 4 / BUG-18 Part 7: composed AFTER pending_payment.
          // Only fires when the user has paid (status NOT pending_payment)
          // but has not yet clicked the verification link in the email
          // dispatched by the Stripe webhook. DO NOT reorder the branches
          // — payment must always be checked first so we never email a
          // user we didn't take money from.
          setGateState({ kind: "email_unverified", email });
        } else {
          // Per spec: only 'pending_payment' triggers PendingPaymentScreen.
          // Everything else (trialing/active/past_due/cancelled/etc. — and
          // null, see below) renders the normal dashboard. past_due is
          // intentionally NOT gated — those are real customers with a
          // card hiccup.
          //
          // null/missing status is also treated as ready. The only way a
          // non-demo business reaches here with null is a legacy row from
          // before sub-step 3b's signup INSERT existed. Failing OPEN
          // matches the 'error' branch above and is safe because the 3d
          // server-side gate on /auth/complete-onboarding still blocks
          // any provisioning action — the worst the user can do here is
          // see the chrome with no agent attached.
          //
          // email_verified=true OR null/undefined (legacy rows pre-BUG-18
          // migration) both fall through to ready — failing OPEN matches
          // the rest of this gate.
          setGateState({ kind: "ready", showOnboarding: wantsOnboarding });
        }
      } catch {
        if (!cancelled) setGateState({ kind: "error", showOnboarding: false });
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Sprint 1 BUG-17 sub-step 3e Part 5: polling loop for ?checkout=success.
  // Runs only while gateState.kind === "polling_success". Polls every 2s
  // for up to 30s; flips to "ready" on 'trialing'/'active', or to
  // "polling_timeout" if neither arrives in time.
  useEffect(() => {
    if (gateState.kind !== "polling_success") return;
    let cancelled = false;
    const businessId = gateState.businessId;
    const token = localStorage.getItem("neverr_token") || "";
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (activeBiz) headers["X-Active-Business"] = activeBiz;

    const startedAt = Date.now();

    async function pollOnce() {
      if (cancelled) return;
      try {
        const r = await fetch(`/api/stripe/subscription/${encodeURIComponent(businessId)}`, { headers });
        if (!cancelled && r.ok) {
          const d = await r.json();
          const status = d?.subscription?.subscription_status;
          if (status === "trialing" || status === "active") {
            // Webhook completed; recompute onboarding flag off /auth/me
            // before unlocking so FirstTimeOnboarding fires correctly.
            try {
              const meRes = await fetch("/api/auth/me", { headers });
              if (meRes.ok) {
                const me = await meRes.json();
                const list = (me?.businesses || []) as any[];
                const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
                const config = biz && (Array.isArray(biz.business_configs) ? biz.business_configs[0] : biz.business_configs);
                const isDemo = config?.status === "demo" || biz?.role === "demo" || (biz?.business_id || "").startsWith("demo-");
                const hasAgent = !!config?.agent_id;
                const onboardingDone = !!config?.onboarding_complete;
                // Sprint 2 STEP 4 / BUG-18 Part 7: after polling-success
                // unlocks the payment gate, also gate on email_verified.
                // The webhook just queued the verification email — most
                // users will land here BEFORE they've clicked it, so the
                // expected flow is polling_success → email_unverified →
                // (user clicks email) → ready.
                const emailVerified = config?.email_verified !== false;
                if (!cancelled) {
                  if (!emailVerified) {
                    setGateState({ kind: "email_unverified", email: me?.user?.email });
                  } else {
                    setGateState({ kind: "ready", showOnboarding: !isDemo && !hasAgent && !onboardingDone });
                  }
                }
              } else if (!cancelled) {
                setGateState({ kind: "ready", showOnboarding: false });
              }
            } catch {
              if (!cancelled) setGateState({ kind: "ready", showOnboarding: false });
            }
            return;
          }
        }
      } catch {
        // Swallow transient network errors; the next tick will retry until
        // the timeout elapses.
      }
      if (cancelled) return;
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        setGateState({ kind: "polling_timeout", businessId });
        return;
      }
      setTimeout(pollOnce, POLL_INTERVAL_MS);
    }

    // First poll fires after one interval (give webhook a beat to land).
    const initial = setTimeout(pollOnce, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearTimeout(initial); };
  }, [gateState.kind === "polling_success" ? (gateState as any).businessId : null]);

  // Auto-dismiss the celebratory toast after 5s. Independent of polling so
  // the toast goes away even if polling lingers.
  useEffect(() => {
    if (!showSuccessToast) return;
    const t = setTimeout(() => setShowSuccessToast(false), 5_000);
    return () => clearTimeout(t);
  }, [showSuccessToast]);

  // Loading + polling-success render: full-screen spinner, NEVER dashboard
  // children. (BUG-40 lesson: any flash of dashboard chrome behind a gate
  // defeats the gate.)
  if (gateState.kind === "loading" || gateState.kind === "polling_success") {
    return (
      <AuthGuard>
        <div className="flex flex-col items-center justify-center min-h-screen bg-[#f0f2f5] gap-4">
          <div className="animate-spin w-8 h-8 border-[3px] border-[#2E75B6] border-t-transparent rounded-full" />
          {gateState.kind === "polling_success" && (
            <p className="text-sm text-gray-500">Activating your subscription...</p>
          )}
        </div>
        {showSuccessToast && <SuccessToast onDismiss={() => setShowSuccessToast(false)} />}
      </AuthGuard>
    );
  }

  if (gateState.kind === "polling_timeout") {
    return (
      <AuthGuard>
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-[#f0f2f5] p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 text-center">
            <h1 className="text-lg font-bold text-gray-900 mb-2">
              Your subscription is still being set up
            </h1>
            <p className="text-sm text-gray-500 mb-6">
              Refresh in a moment to continue.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center justify-center gap-2 bg-[#2E75B6] text-white px-6 py-2.5 rounded-xl font-semibold hover:bg-[#2563a0] transition-colors text-sm"
            >
              Refresh
            </button>
          </div>
        </div>
      </AuthGuard>
    );
  }

  if (gateState.kind === "blocked") {
    return (
      <AuthGuard>
        <PendingPaymentScreen
          businessId={gateState.businessId}
          planId={gateState.planId}
          billingCycle={gateState.billingCycle}
          email={gateState.email}
        />
      </AuthGuard>
    );
  }

  // Sprint 2 STEP 4 / BUG-18 Part 6: email-verification gate. Renders
  // AFTER the pending_payment branch above (ordering matters — see the
  // GateState union comment + the load effect's branch ordering).
  if (gateState.kind === "email_unverified") {
    return (
      <AuthGuard>
        <EmailVerificationScreen email={gateState.email} />
      </AuthGuard>
    );
  }

  // "ready" or "error" — render the normal dashboard chrome.
  const showOnboarding = gateState.showOnboarding;

  return (
    <AuthGuard>
      <LocationProvider>
        <div className="flex min-h-screen bg-[#f0f2f5]">
          <Sidebar />
          <main className="flex-1 min-w-0 md:ml-[220px] overflow-y-auto min-h-screen">
            <DemoBanner />
            <div className="flex justify-end items-center gap-3 px-6 pt-4 pb-0">
              {/* Phase 3.1b: on-duty toggle. Sits leftmost in the header
                  chip row so it's always accessible without hunting for it. */}
              <OnDutyToggle />
              <BusinessSwitcher onAddBusiness={() => setShowAddBiz(true)} />
              <LocationSwitcher />
            </div>
            <Switch>
              <Route path="/dashboard" component={CommandCenter} />
              <Route path="/calls" component={CallsLeads} />
              {/* Leads epic Slice 1: the lead detail page deep-links to
                  /calls/:id when a source_call_id exists. CallsLeads
                  currently renders the list view for both /calls and
                  /calls/:id; auto-selecting the specific call from
                  the URL param is a follow-up. Routing it here so the
                  link lands on a real page instead of the catch-all
                  "page not found". */}
              <Route path="/calls/:callId" component={CallsLeads} />
              {/* Leads epic Slice 1: callback queue. Sits next to
                  /calls so the leads list lives alongside the call
                  list it escalates from. AuthGuard already wraps
                  DashboardLayout; no extra gating needed here. */}
              <Route path="/leads" component={LeadsListPage} />
              <Route path="/leads/:id" component={LeadDetailPage} />
              {/* Phase 2.6b: outbound voice campaigns. Backend routes
                  under /api/business/campaigns are mounted in
                  api-server/routes/index.ts ahead of the catch-all. */}
              <Route path="/campaigns" component={CampaignsListPage} />
              <Route path="/campaigns/:id">
                {(params) => <CampaignDetailPage campaignId={params.id} />}
              </Route>
              {/* Phase 3.1b: team management (/team). Server routes at
                  /api/business/team/* enforce requirePermission — non-admin
                  members see the table read-only via a 403 on invite/remove. */}
              <Route path="/team" component={TeamPage} />
              <Route path="/contacts" component={Contacts} />
              <Route path="/appointments" component={Appointments} />
              <Route path="/sms" component={SmsCampaigns} />
              <Route path="/analytics" component={Analytics} />
              <Route path="/benchmarks" component={Benchmarks} />
              <Route path="/admin/audit-logs" component={AdminAuditLogs} />
              {/* Stage 6 Phase 2: admin override UI list page. Auth
                  gated server-side via requireStaffPermission("customers",
                  "read") on GET /api/admin/businesses. Non-staff callers
                  see an "Admin access required" empty state on the page
                  itself (same pattern as AdminAuditLogs). */}
              <Route path="/admin/businesses" component={BusinessesList} />
              {/* Stage 6 Phase 3B: admin drill-in. Reuses VoiceTab +
                  PromptEditor + HistoryViewer via apiBase prop. Auth
                  gated server-side; non-staff see "Admin access
                  required" on the page itself. */}
              <Route
                path="/admin/businesses/:businessId"
                component={BusinessDetail}
              />
              <Route path="/settings" component={SettingsPage} />
              {/* Sprint 3 Stage 5 / Phase 3: AI receptionist voice picker. */}
              <Route path="/settings/ai" component={AiSettingsPage} />
              {/* Slice 2A leads epic: user's "ring me at" preference
                  for the lead-bridge feature. Deep-linked from the
                  LeadDetailPage banner when the preference is missing. */}
              <Route path="/settings/callback" component={CallbackSettingsPage} />
              <Route>
                <div className="flex items-center justify-center h-64">
                  <p className="text-gray-500">Page not found</p>
                </div>
              </Route>
            </Switch>
          </main>
          {showOnboarding && (
            <FirstTimeOnboarding onComplete={() => {
              // After the wizard finishes the agent is provisioned and
              // onboarding_complete is true; collapse the modal locally.
              setGateState((g) => g.kind === "ready" ? { kind: "ready", showOnboarding: false } : g);
            }} />
          )}
          <AddBusinessModal
            open={showAddBiz}
            onClose={() => setShowAddBiz(false)}
            onCreated={() => {
              setShowAddBiz(false);
              // Hard reload so all per-tenant state (calls, contacts,
              // settings) re-fetches under the newly-created business.
              window.location.reload();
            }}
          />
        </div>
        {showSuccessToast && <SuccessToast onDismiss={() => setShowSuccessToast(false)} />}
        {/* Phase 2.6b: shared Sonner toaster for inline action feedback
            (campaign save / activate / delete). Mounted inside the
            dashboard wrapper so toasts only render on authenticated
            routes, not on marketing/auth pages. */}
        <SonnerToaster position="bottom-right" richColors />
      </LocationProvider>
    </AuthGuard>
  );
}

// Sprint 1 BUG-17 sub-step 3e Part 5: small celebratory toast shown after
// ?checkout=success. Auto-dismisses (driven by parent timer); the X is for
// users who want to clear it sooner. No external Toaster infrastructure
// required — this is a single-shot welcome banner, not a general toast
// system.
function SuccessToast({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[300] bg-white border border-green-200 shadow-lg rounded-xl px-4 py-3 max-w-sm flex items-start gap-3"
    >
      <span className="text-2xl leading-none">🎉</span>
      <div className="flex-1">
        <p className="text-sm font-semibold text-gray-900">Welcome to Neverr!</p>
        <p className="text-xs text-gray-500 mt-0.5">Your 7-day trial has started.</p>
      </div>
      <button
        onClick={onDismiss}
        className="text-gray-400 hover:text-gray-600 text-sm leading-none"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function LoginPage() {
  return <Signup initialTab="login" />;
}

function App() {
  return (
    <WouterRouter base="/">
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/signup" component={Signup} />
        <Route path="/login" component={LoginPage} />
        {/* Phase 3i: dedicated marketing routes — Pricing, ROI calculator,
            and Contact form were previously inline sections on Landing.tsx.
            Each page mounts the same LandingNav + LandingFooter so they
            feel like a coherent marketing site. */}
        <Route path="/pricing" component={PricingPage} />
        <Route path="/roi" component={RoiPage} />
        {/* Sprint 1 BUG-02: dedicated /features deep-dive page. The
            previous nav link pointed at /#features (a hash anchor on the
            landing page) which felt like a broken redirect. The landing
            section is preserved untouched for any external deep links. */}
        <Route path="/features" component={Features} />
        <Route path="/contact" component={ContactPage} />
        <Route path="/multilingual" component={MultilingualShowcase} />
        <Route path="/enterprise" component={EnterprisePage} />
        <Route path="/demo" component={Demo} />
        <Route path="/demo-call" component={DemoCall} />
        <Route path="/demos" component={Demos} />
        <Route path="/try-your-agent" component={TryYourAgent} />
        {/* Phase 3g: persistent sales-created demo. Reuses GET /api/preview/:id
            so the same revoked / expired guards apply. Must be declared before
            the dashboard catch-alls so wouter routes /demo/<demoBusinessId>
            here instead of falling through to DashboardLayout. */}
        <Route path="/demo/:demoBusinessId" component={SalesDemoPage} />
        {/* Phase 3h: industry catalogue navigation. The /industries/:slug
            route MUST be declared after /try-your-agent (and the other
            literal routes) so wouter's first-match-wins doesn't shadow
            them when slug happens to collide. */}
        <Route path="/industries" component={IndustriesHub} />
        <Route path="/industries/:slug" component={IndustryCategoryPage} />
        {/* New industry detail pages — 17 verticals at /for/<slug> */}
        <Route path="/for/:slug" component={IndustryDetailPage} />
        <Route path="/government" component={Government} />
        <Route path="/privacy" component={Privacy} />
        <Route path="/terms" component={Terms} />
        {/* Sprint 2 STEP 3 (BUG-16): /partners is now the canonical
            partner-program URL. The historical /partner (singular) is
            kept as a 301-style client redirect so any inbound links
            (footers, emails, search results) still land on the page
            instead of the auth-redirect catch-all. Both routes must sit
            BEFORE the DashboardLayout catch-all at the bottom of this
            Switch. */}
        <Route path="/partners" component={Partner} />
        <Route path="/partner">
          <Redirect to="/partners" />
        </Route>
        <Route path="/sms-optin/:businessId" component={SmsOptInPage} />
        <Route path="/mfa-setup" component={MfaSetup} />
        <Route path="/mfa-verify" component={MfaVerify} />
        <Route path="/activate" component={ActivateAccount} />
        {/* Sprint 2 STEP 4 / BUG-18: standalone verification page reached
            from the verify@neverr.ai email link. Sits OUTSIDE
            DashboardLayout so a logged-out user clicking the link still
            lands cleanly (the page itself doesn't need auth — the token
            in the URL is the credential). */}
        <Route path="/verify-email" component={VerifyEmail} />
        {/* Dedicated /forgot-password entry. Replaced the inline button
            that lived on the login tab of Signup.tsx so the affordance
            is bookmarkable, shareable, and consistent with
            /reset-password. Public, outside AuthGuard. */}
        <Route path="/forgot-password" component={ForgotPassword} />
        {/* "I forgot which email I signed up with" — manual support
            intake. POSTs to /api/auth/help-recover-account which audit-
            logs + emails the support inbox. Public, outside AuthGuard. */}
        <Route path="/forgot-username" component={ForgotUsername} />
        {/* Public landing for Supabase Auth recovery redirect. The
            recovery email's link sends users to /reset-password with the
            access_token in the URL fragment — page reads it client-side,
            posts to /api/auth/reset-password, then routes to /login.
            Sits OUTSIDE DashboardLayout so a logged-out user landing
            here doesn't bounce off AuthGuard. */}
        <Route path="/reset-password" component={ResetPassword} />
        {/* Slice 3A pillar 3: customer trust portal. Token is HS256-
            signed by the api-server (lib/trust-portal-token.ts) and IS
            the credential — no auth wrap. Sits OUTSIDE DashboardLayout
            so an unauthenticated customer landing here doesn't bounce
            off AuthGuard. Mobile-first by design. */}
        <Route path="/r/:token" component={TrustPortalPage} />
        <Route path="/dashboard" component={() => <DashboardLayout />} />
        <Route path="/calls" component={() => <DashboardLayout />} />
        <Route path="/leads" component={() => <DashboardLayout />} />
        <Route path="/leads/:id" component={() => <DashboardLayout />} />
        <Route path="/campaigns" component={() => <DashboardLayout />} />
        <Route path="/campaigns/:id" component={() => <DashboardLayout />} />
        <Route path="/team" component={() => <DashboardLayout />} />
        <Route path="/contacts" component={() => <DashboardLayout />} />
        <Route path="/appointments" component={() => <DashboardLayout />} />
        <Route path="/sms" component={() => <DashboardLayout />} />
        <Route path="/analytics" component={() => <DashboardLayout />} />
        <Route path="/benchmarks" component={() => <DashboardLayout />} />
        <Route path="/settings" component={() => <DashboardLayout />} />
        <Route path="/settings/callback" component={() => <DashboardLayout />} />
        <Route><DashboardLayout /></Route>
      </Switch>
      {/* Sprint 5 Alex Phase 2: mounted OUTSIDE <Switch> so the widget's
          state (open/closed, in-flight conversation, scroll position)
          survives route changes. The widget itself decides whether to
          render based on the current path. */}
      <ChatWidget />
      {/* Cookie consent UI gating — must be inside <WouterRouter> so
          useLocation() works. Renders nothing; pure side effect on
          <html> classList. */}
      <CookieConsentManager />
    </WouterRouter>
  );
}

export default App;
