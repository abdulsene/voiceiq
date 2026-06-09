import { useLocation, Link } from "wouter";
import { useEffect, useState, useCallback } from "react";
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
} from "lucide-react";
// Sprint 1 BUG-17 sub-step 3f: removed import of OnboardingWizard. The
// in-sidebar "Start Setup" / "New Business" buttons used to open it and
// it called the anonymous POST /onboard which is now auth-gated. The
// legitimate add-a-business path is BusinessSwitcher's "Add Business"
// menu item which opens AddBusinessModal (Pattern 2 via
// /api/business/create-additional). FirstTimeOnboarding mounted in App.tsx
// covers the "no agent yet" state automatically.
import { getSmsUnreadCount, fetchApi } from "../lib/api";
// Sprint 4 TC-59: import the shared clearSession helper so this sign-out
// path uses the SAME key list as AuthGuard's idle/expired clear. Prevents
// drift (Sidebar was missing ACTIVITY_KEY and mfa_* keys before).
import { clearSession } from "../App";
import LanguageSwitcher from "./LanguageSwitcher";

const navItems = [
  { path: "/dashboard", labelKey: "nav.commandCenter", icon: LayoutDashboard },
  { path: "/calls", labelKey: "nav.callsLeads", icon: Phone },
  { path: "/contacts", labelKey: "nav.contacts", icon: Users },
  { path: "/appointments", labelKey: "nav.appointments", icon: Calendar },
  { path: "/sms", labelKey: "nav.sms", icon: MessageSquare },
  { path: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
  { path: "/benchmarks", labelKey: "nav.benchmarks", icon: Award },
  { path: "/government", labelKey: "nav.government", icon: Landmark },
  { path: "/demos", labelKey: "nav.demoLibrary", icon: Clapperboard, external: true },
  // Sprint 5: read-only admin viewer over audit_logs. Endpoint enforces
  // requireStaffPermission post-hotfix (aaf14de); non-staff clicking
  // through see the in-page "Admin access required" empty state.
  // Sidebar shows the link to everyone for simplicity — real gating
  // lives on the API.
  { path: "/admin/audit-logs", labelKey: "nav.auditLogs", label: "Audit Logs", icon: Shield },
  // Stage 6 Phase 2: admin override list. Same nav-visibility-for-all
  // precedent as audit-logs; server gates via requireStaffPermission
  // ("customers", "read").
  { path: "/admin/businesses", labelKey: "nav.customerBusinesses", label: "Customer Businesses", icon: Briefcase },
  { path: "/settings", labelKey: "nav.settings", icon: Settings },
];

export default function Sidebar() {
  const [location] = useLocation();
  const [businessName, setBusinessName] = useState("");
  const [smsUnread, setSmsUnread] = useState(0);
  const { t } = useTranslation();

  const pollUnread = useCallback(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) return;
    getSmsUnreadCount()
      .then((d) => setSmsUnread(d?.count || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) return;
    // fetchApi auto-injects Authorization + X-Active-Business, so the
    // backend resolves the membership for the tenant the user is
    // currently viewing instead of d.businesses[0] (their oldest).
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    fetchApi("/auth/me")
      .then((d) => {
        const list = (d?.businesses || []) as any[];
        const biz = (activeBiz && list.find((b) => b.business_id === activeBiz)) || list[0];
        const config = biz?.business_configs && (Array.isArray(biz.business_configs) ? biz.business_configs[0] : biz.business_configs);
        if (config?.business_name) setBusinessName(config.business_name);
      })
      .catch(() => {});
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
          <div className="flex items-center">
            <img src={`${import.meta.env.BASE_URL}neverr-logo.png`} alt="Neverr" className="h-9 brightness-0 invert" />
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {navItems.map((item) => {
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
