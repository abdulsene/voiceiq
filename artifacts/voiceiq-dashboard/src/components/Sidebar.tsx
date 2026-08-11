import { useLocation, Link } from "wouter";
import { useEffect, useState, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Phone,
  Users,
  Calendar,
  MessageSquare,
  Settings,
  Building2,
  BarChart3,
  Landmark,
  LogOut,
  Award,
  Briefcase,
  Clapperboard,
  Shield,
  Bot,
  Inbox,
  Megaphone,
  UsersRound,
} from "lucide-react";
// Sprint 1 BUG-17 sub-step 3f: removed import of OnboardingWizard. The
// in-sidebar "Start Setup" / "New Business" buttons used to open it and
// it called the anonymous POST /onboard which is now auth-gated. The
// legitimate add-a-business path is BusinessSwitcher's "Add Business"
// menu item which opens AddBusinessModal (Pattern 2 via
// /api/business/create-additional). FirstTimeOnboarding mounted in App.tsx
// covers the "no agent yet" state automatically.
import { getSmsUnreadCount } from "../lib/api";
import { useAuth } from "../lib/auth-context";
// Sprint 4 TC-59: import the shared clearSession helper so this sign-out
// path uses the SAME key list as AuthGuard's idle/expired clear. Prevents
// drift (Sidebar was missing ACTIVITY_KEY and mfa_* keys before).
import { clearSession } from "../App";
import LanguageSwitcher from "./LanguageSwitcher";

// adminOnly items are filtered out for any caller whose /auth/me returns a
// null staff_role. The four flagged below are the ones a paying customer
// (e.g. EZ Rentals) was seeing in the sidebar despite the backend gating
// them via requireStaffPermission. The API gate stays — this is purely a
// UI fix to stop showing nav for routes the customer can't usefully reach.
type NavItem = {
  path: string;
  labelKey: string;
  label?: string;
  icon: typeof LayoutDashboard;
  external?: boolean;
  adminOnly?: boolean;
  // Phase 4.4 — hide a nav item unless the caller's business
  // membership role is in this list. Enforced client-side ONLY as
  // a UX / anti-403 measure; the API endpoints remain the
  // authoritative gate (users:write / users:read).
  requiresBusinessRole?: string[];
};

const navItems: NavItem[] = [
  { path: "/dashboard", labelKey: "nav.commandCenter", icon: LayoutDashboard },
  // /settings/ai → AiSettingsPage (voice + prompt + history tabs). Surfaced
  // here so customers don't have to dig through Settings to find their AI
  // configuration. Placed directly under Command Center so it reads as a
  // first-class daily-driver feature, not a "deep settings" item.
  { path: "/settings/ai", labelKey: "nav.myReceptionist", icon: Bot },
  // Phase 3.3c: the softphone as a first-class destination. Sits between
  // My Receptionist (which configures the AI that fields the call) and
  // Calls & Leads (which shows what happened after) — mirrors the actual
  // "before / during / after" narrative of a call.
  { path: "/phone", labelKey: "nav.phone", label: "Phone", icon: Phone },
  { path: "/calls", labelKey: "nav.callsLeads", icon: Phone },
  // Leads epic Slice 1: callback-first escalation flow. Slotted between
  // "Calls & Leads" (the existing transcript-focused view) and
  // "Contacts" so the callback queue sits alongside the call list it
  // escalates from. Visible to all business members; admin override
  // available at /admin/businesses/:id/leads.
  { path: "/leads", labelKey: "nav.leads", icon: Inbox },
  // Phase 2.6b: outbound voice campaigns dashboard. Slotted between
  // Leads (which can act as the source of segment-able leads) and
  // Contacts so the outbound-call workflow lives alongside the lead
  // pipeline it draws from.
  { path: "/campaigns", labelKey: "nav.campaigns", icon: Megaphone },
  // Phase 3.1b: team management — staff on this business, role +
  // on-duty state + topic assignments. UsersRound (not Users) so it
  // reads distinct from Contacts below.
  // Phase 4.4: gated on business role via the requiresBusinessRole
  // filter below. Only owner / admin / manager / team_lead can
  // actually manage the team (users:write on the API); hiding the
  // link for other roles prevents "clicks into a 403" — Abdul's
  // brief flagged this as the first thing new staff will click.
  { path: "/team", labelKey: "nav.team", icon: UsersRound, requiresBusinessRole: ["owner", "admin", "manager", "team_lead"] },
  { path: "/contacts", labelKey: "nav.contacts", icon: Users },
  { path: "/appointments", labelKey: "nav.appointments", icon: Calendar },
  { path: "/sms", labelKey: "nav.sms", icon: MessageSquare },
  { path: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
  { path: "/benchmarks", labelKey: "nav.benchmarks", icon: Award },
  { path: "/government", labelKey: "nav.government", icon: Landmark, adminOnly: true },
  { path: "/demos", labelKey: "nav.demoLibrary", icon: Clapperboard, external: true, adminOnly: true },
  // Sprint 5: read-only admin viewer over audit_logs. Endpoint enforces
  // requireStaffPermission post-hotfix (aaf14de); customer-side visibility
  // is now gated by adminOnly (was: "shown to everyone for simplicity").
  { path: "/admin/audit-logs", labelKey: "nav.auditLogs", label: "Audit Logs", icon: Shield, adminOnly: true },
  // Stage 6 Phase 2: admin override list. Server gates via
  // requireStaffPermission ("customers", "read"); sidebar visibility now
  // also gated by adminOnly.
  { path: "/admin/businesses", labelKey: "nav.customerBusinesses", label: "Customer Businesses", icon: Briefcase, adminOnly: true },
  { path: "/settings", labelKey: "nav.settings", icon: Settings },
];

export default function Sidebar() {
  const [location] = useLocation();
  const [smsUnread, setSmsUnread] = useState(0);
  const { t } = useTranslation();
  // Phase 5.6 — read businesses / staff_role from the shared AuthContext
  // instead of firing a duplicate /api/auth/me. Cuts request volume by
  // 1 per page load and eliminates the "sidebar also gets rate-limited
  // out" failure mode. Consumers must handle auth.data === null (initial
  // load + transient failure fallback) gracefully.
  const auth = useAuth();
  const { businessName, staffRole, businessRole } = useMemo(() => {
    if (!auth.data) {
      return { businessName: "", staffRole: null as string | null, businessRole: null as string | null };
    }
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const list = auth.data.businesses || [];
    const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
    const config = biz?.business_configs
      ? Array.isArray(biz.business_configs)
        ? biz.business_configs[0]
        : biz.business_configs
      : null;
    return {
      businessName: (config as any)?.business_name || "",
      // staff_role is null for customers; a string for active staff.
      staffRole: (auth.data.staff_role as string | null) ?? null,
      // business membership role for the active biz (used to hide
      // nav items whose API endpoints will 403 for this role).
      businessRole: (biz?.role as string | null) ?? null,
    };
  }, [auth.data]);

  const pollUnread = useCallback(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) return;
    getSmsUnreadCount()
      .then((d) => setSmsUnread(d?.count || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    pollUnread();
    const interval = setInterval(pollUnread, 30000);
    return () => clearInterval(interval);
  }, [pollUnread]);

  const handleLogout = () => {
    // Sprint 4 TC-59: delegate to the shared clearSession helper from
    // App.tsx so we wipe the SAME set of keys AuthGuard wipes on idle /
    // 401. Previously this path was missing ACTIVITY_KEY and the mfa_*
    // scratch keys, which (a) drifted from the AuthGuard list and (b)
    // could leak partial-MFA state to the next signin on a shared device.
    clearSession();
    window.location.href = "/signup";
  };

  return (
    <aside className="hidden md:flex w-[220px] bg-[#1B2537] min-h-screen flex-col shrink-0 fixed left-0 top-0 z-40">
        <div className="px-5 py-5 flex items-center justify-between border-b border-white/10">
          <div className="flex items-center h-9">
            {/* Text wordmark fallback. The previous render was
                <img src="/neverr-logo.png" className="brightness-0 invert" />
                but public/neverr-logo.png is an RGB-only PNG (no alpha
                channel) — brightness-0 forces every pixel black, invert
                flips it to white, and the result is a solid white
                rectangle (the "empty white box" customers reported). A
                text wordmark renders reliably on the #1B2537 sidebar
                background without depending on image post-processing. */}
            <span className="text-white font-bold text-xl tracking-tight">Neverr</span>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {/* TODO: tighten to per-resource gating (analyst sees Audit Logs
              but not Customer Businesses) — binary "any staff role" is the
              hot-fix for the EZ Rentals leak; per-resource is the follow-up.
              Default for null/unknown role = HIDE adminOnly items. */}
          {navItems
            .filter((item) => !item.adminOnly || staffRole !== null)
            // Phase 4.4 — business-role gate. Hide items whose
            // requiresBusinessRole list doesn't include the current
            // membership's role. Owner sees everything; role='user'
            // and 'readonly' don't see /team (would 403).
            .filter((item) => !item.requiresBusinessRole || (businessRole !== null && item.requiresBusinessRole.includes(businessRole)))
            .map((item) => {
            const active =
              item.path === "/"
                ? location === "/" || location === ""
                : location.startsWith(item.path);
            const Icon = item.icon;
            const showBadge = item.path === "/sms" && smsUnread > 0;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13px] font-medium transition-all duration-200 relative ${
                  active
                    ? "bg-[#2E75B6] text-white shadow-md shadow-[#2E75B6]/20"
                    : "text-gray-400 hover:text-white hover:bg-white/[0.06]"
                }`}
              >
                <Icon className="w-[18px] h-[18px] shrink-0" />
                {(item as any).label ?? t(item.labelKey)}
                {showBadge && (
                  <span className="ml-auto w-5 h-5 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {smsUnread > 9 ? "9+" : smsUnread}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="px-3 pb-4 border-t border-white/10 pt-3">
          <div className="flex items-center justify-between px-3 py-2 mb-2">
            <LanguageSwitcher variant="dark" />
          </div>

          <button
            onClick={handleLogout}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-[12px] text-gray-400 hover:text-white hover:bg-white/[0.06] transition-colors mb-2"
          >
            <LogOut className="w-3.5 h-3.5" /> {t("nav.logout")}
          </button>
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center">
              <Building2 className="w-4 h-4 text-gray-400" />
            </div>
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-white truncate">{businessName || t("nav.myBusiness")}</p>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <p className="text-[10px] text-gray-500">{t("common.proPlan")}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 px-3 pt-1">
            <Link href="/privacy" className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">{t("nav.privacy")}</Link>
            <span className="text-gray-600 text-[10px]">|</span>
            <Link href="/terms" className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors">{t("nav.terms")}</Link>
          </div>
        </div>
      </aside>
  );
}
