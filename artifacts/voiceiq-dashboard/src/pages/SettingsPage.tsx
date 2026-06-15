import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import {
  Bot, Building2, Bell, Phone, Shield, CreditCard, Save, CheckCircle,
  AlertTriangle, Globe, ShieldCheck, ShieldOff, Loader2, Lock, Eye,
  EyeOff, ExternalLink, Copy, PhoneCall, ChevronRight, Zap, Plug,
  RefreshCw, Send, Check, MapPin, Plus, Trash2, Edit3, PhoneForwarded,
  Clock, Users, ArrowRightLeft, Brain, X, ToggleLeft, ToggleRight,
  Swords, Headphones, MessageSquare, Code2, Sparkles,
} from "lucide-react";
import SalesDemosTab from "../components/SalesDemosTab";

const API = "/api";

const LANGUAGE_REGIONS = [
  {
    region: "Americas",
    langs: [
      { code: "en", flag: "\uD83C\uDDFA\uD83C\uDDF8", name: "English", native: "English", locked: true },
      { code: "es", flag: "\uD83C\uDDEA\uD83C\uDDF8", name: "Spanish", native: "Espa\u00F1ol" },
      { code: "pt", flag: "\uD83C\uDDE7\uD83C\uDDF7", name: "Portuguese", native: "Portugu\u00EAs" },
      { code: "fr", flag: "\uD83C\uDDEB\uD83C\uDDF7", name: "French", native: "Fran\u00E7ais" },
    ],
  },
  {
    region: "Europe",
    langs: [
      { code: "de", flag: "\uD83C\uDDE9\uD83C\uDDEA", name: "German", native: "Deutsch" },
      { code: "it", flag: "\uD83C\uDDEE\uD83C\uDDF9", name: "Italian", native: "Italiano" },
      { code: "nl", flag: "\uD83C\uDDF3\uD83C\uDDF1", name: "Dutch", native: "Nederlands" },
      { code: "pl", flag: "\uD83C\uDDF5\uD83C\uDDF1", name: "Polish", native: "Polski" },
      { code: "sv", flag: "\uD83C\uDDF8\uD83C\uDDEA", name: "Swedish", native: "Svenska" },
      { code: "no", flag: "\uD83C\uDDF3\uD83C\uDDF4", name: "Norwegian", native: "Norsk" },
      { code: "da", flag: "\uD83C\uDDE9\uD83C\uDDF0", name: "Danish", native: "Dansk" },
      { code: "fi", flag: "\uD83C\uDDEB\uD83C\uDDEE", name: "Finnish", native: "Suomi" },
      { code: "ro", flag: "\uD83C\uDDF7\uD83C\uDDF4", name: "Romanian", native: "Rom\u00E2n\u0103" },
      { code: "cs", flag: "\uD83C\uDDE8\uD83C\uDDFF", name: "Czech", native: "\u010Ce\u0161tina" },
      { code: "sk", flag: "\uD83C\uDDF8\uD83C\uDDF0", name: "Slovak", native: "Sloven\u010Dina" },
      { code: "hu", flag: "\uD83C\uDDED\uD83C\uDDFA", name: "Hungarian", native: "Magyar" },
      { code: "el", flag: "\uD83C\uDDEC\uD83C\uDDF7", name: "Greek", native: "\u0395\u03BB\u03BB\u03B7\u03BD\u03B9\u03BA\u03AC" },
    ],
  },
  {
    region: "Eastern Europe & Russia",
    langs: [
      { code: "ru", flag: "\uD83C\uDDF7\uD83C\uDDFA", name: "Russian", native: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439" },
      { code: "uk", flag: "\uD83C\uDDFA\uD83C\uDDE6", name: "Ukrainian", native: "\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430" },
    ],
  },
  {
    region: "Middle East",
    langs: [
      { code: "ar", flag: "\uD83C\uDDF8\uD83C\uDDE6", name: "Arabic", native: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629" },
      { code: "he", flag: "\uD83C\uDDEE\uD83C\uDDF1", name: "Hebrew", native: "\u05E2\u05D1\u05E8\u05D9\u05EA" },
      { code: "tr", flag: "\uD83C\uDDF9\uD83C\uDDF7", name: "Turkish", native: "T\u00FCrk\u00E7e" },
    ],
  },
  {
    region: "Asia",
    langs: [
      { code: "hi", flag: "\uD83C\uDDEE\uD83C\uDDF3", name: "Hindi", native: "\u0939\u093F\u0928\u094D\u0926\u0940" },
      { code: "ja", flag: "\uD83C\uDDEF\uD83C\uDDF5", name: "Japanese", native: "\u65E5\u672C\u8A9E" },
      { code: "ko", flag: "\uD83C\uDDF0\uD83C\uDDF7", name: "Korean", native: "\uD55C\uAD6D\uC5B4" },
      { code: "zh", flag: "\uD83C\uDDE8\uD83C\uDDF3", name: "Mandarin", native: "\u666E\u901A\u8BDD" },
      { code: "yue", flag: "\uD83C\uDDED\uD83C\uDDF0", name: "Cantonese", native: "\u5EE3\u6771\u8A71" },
      { code: "id", flag: "\uD83C\uDDEE\uD83C\uDDE9", name: "Indonesian", native: "Bahasa Indonesia" },
      { code: "ms", flag: "\uD83C\uDDF2\uD83C\uDDFE", name: "Malay", native: "Bahasa Melayu" },
      { code: "vi", flag: "\uD83C\uDDFB\uD83C\uDDF3", name: "Vietnamese", native: "Ti\u1EBFng Vi\u1EC7t" },
      { code: "th", flag: "\uD83C\uDDF9\uD83C\uDDED", name: "Thai", native: "\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22" },
      { code: "tl", flag: "\uD83C\uDDF5\uD83C\uDDED", name: "Filipino", native: "Filipino" },
    ],
  },
];

// Sprint 4 FIX 3+4d: optgroup-shaped industry list for Settings industry
// dropdown. Mirrors the Signup form's optgroup structure (with Consulting
// added under Professional Services) so the two surfaces stay consistent.
// "General Business" is rendered as a standalone option above the groups.
const INDUSTRY_GROUPS: { label: string; items: { value: string; label: string }[] }[] = [
  { label: "Healthcare", items: [
    { value: "dental", label: "Dental" },
    { value: "medical", label: "Medical" },
    { value: "veterinary", label: "Veterinary" },
  ]},
  { label: "Professional Services", items: [
    { value: "accounting", label: "Accounting" },
    { value: "consulting", label: "Consulting / Professional Services" },
    { value: "insurance", label: "Insurance" },
    { value: "legal", label: "Legal" },
    { value: "real_estate", label: "Real Estate" },
  ]},
  { label: "Home Services", items: [
    { value: "construction", label: "Construction" },
    { value: "hvac", label: "HVAC / Plumbing" },
  ]},
  { label: "Other", items: [
    { value: "automotive", label: "Automotive" },
    { value: "beauty", label: "Beauty / Wellness" },
    { value: "education", label: "Education" },
    { value: "fitness", label: "Fitness / Gym" },
    { value: "government", label: "Government" },
    { value: "restaurant", label: "Restaurant" },
    { value: "solo_entrepreneur", label: "Solo Entrepreneur" },
  ]},
];

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HST)" },
];

const VOICES = [
  { value: "professional_female", label: "Professional Female" },
  { value: "professional_male", label: "Professional Male" },
  { value: "friendly_female", label: "Friendly Female" },
  { value: "friendly_male", label: "Friendly Male" },
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const TIME_OPTIONS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of [0, 30]) {
    const hr = h % 12 === 0 ? 12 : h % 12;
    const ampm = h < 12 ? "AM" : "PM";
    TIME_OPTIONS.push(`${hr}:${m === 0 ? "00" : "30"} ${ampm}`);
  }
}

const PLAN_NAMES: Record<string, string> = {
  starter: "Starter", essential: "Essential", growth: "Growth",
  professional: "Professional", business: "Business", enterprise: "Enterprise",
};

const PLAN_LIMITS: Record<string, { minutes: number; sms: number }> = {
  starter: { minutes: 100, sms: 50 },
  essential: { minutes: 500, sms: 500 },
  growth: { minutes: 1000, sms: 1000 },
  professional: { minutes: 2500, sms: 2000 },
  business: { minutes: 5000, sms: 5000 },
  enterprise: { minutes: 99999, sms: 99999 },
};

function getAuth() {
  return {
    token: localStorage.getItem("neverr_token") || "",
    businessId: localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "",
  };
}

async function apiFetch(path: string, opts?: RequestInit) {
  const { token } = getAuth();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-11 h-6 rounded-full transition-colors ${checked ? "bg-[#2E75B6]" : "bg-gray-300"}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-5" : ""}`} />
    </button>
  );
}

type DayHours = { closed: boolean; open: string; close: string };

function parseBusinessHours(raw: string): DayHours[] {
  const defaults: DayHours[] = DAYS.map((_, i) => ({
    closed: i >= 5,
    open: "9:00 AM",
    close: "5:00 PM",
  }));
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 7) return parsed;
  } catch {}
  return defaults;
}

function BusinessHoursEditor({ hours, onChange }: { hours: DayHours[]; onChange: (h: DayHours[]) => void }) {
  const update = (idx: number, patch: Partial<DayHours>) => {
    const next = [...hours];
    next[idx] = { ...next[idx], ...patch };
    onChange(next);
  };

  const copyToWeekdays = () => {
    const mon = hours[0];
    const next = hours.map((h, i) => (i < 5 ? { ...mon } : h));
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {DAYS.map((day, i) => (
        <div key={day} className="flex items-center gap-3">
          <span className="w-24 text-sm font-medium text-gray-700">{day}</span>
          <label className="flex items-center gap-1.5 text-sm text-gray-500 cursor-pointer w-20">
            <input
              type="checkbox"
              checked={hours[i].closed}
              onChange={(e) => update(i, { closed: e.target.checked })}
              className="w-3.5 h-3.5 rounded border-gray-300 text-red-500 focus:ring-red-400"
            />
            Closed
          </label>
          {!hours[i].closed && (
            <>
              <select
                value={hours[i].open}
                onChange={(e) => update(i, { open: e.target.value })}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
              >
                {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="text-xs text-gray-400">to</span>
              <select
                value={hours[i].close}
                onChange={(e) => update(i, { close: e.target.value })}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
              >
                {TIME_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={copyToWeekdays}
        className="text-xs text-[#2E75B6] font-medium hover:underline mt-1"
      >
        Copy Monday to all weekdays
      </button>
    </div>
  );
}

function SecurityTab() {
  const [mfaFactors, setMfaFactors] = useState<any[]>([]);
  const [hasVerified, setHasVerified] = useState(false);
  const [loadingMfa, setLoadingMfa] = useState(true);
  const [disabling, setDisabling] = useState(false);
  const [mfaError, setMfaError] = useState("");
  const [mfaSuccess, setMfaSuccess] = useState("");
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => { loadMfaStatus(); }, []);

  async function loadMfaStatus() {
    setLoadingMfa(true);
    try {
      const { token } = getAuth();
      const res = await fetch(`${API}/mfa/factors`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) { setMfaError(data.error || "Failed to load MFA status"); return; }
      if (data.success) {
        setMfaFactors(data.factors || []);
        setHasVerified(data.has_verified || false);
      }
    } catch { setMfaError("Failed to load MFA status"); }
    finally { setLoadingMfa(false); }
  }

  async function disableMfa(factorId: string) {
    if (!confirm("Are you sure you want to disable two-factor authentication? This will make your account less secure.")) return;
    setDisabling(true);
    setMfaError("");
    try {
      const { token } = getAuth();
      const res = await fetch(`${API}/mfa/unenroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ factor_id: factorId }),
      });
      const data = await res.json();
      if (!res.ok) { setMfaError(data.error || "Failed to disable MFA"); return; }
      setMfaSuccess("Two-factor authentication has been disabled");
      await loadMfaStatus();
      setTimeout(() => setMfaSuccess(""), 3000);
    } catch { setMfaError("Connection error"); }
    finally { setDisabling(false); }
  }

  async function updatePassword() {
    setPwMsg(null);
    if (!pwCurrent || !pwNew || !pwConfirm) { setPwMsg({ type: "err", text: "All fields are required" }); return; }
    if (pwNew !== pwConfirm) { setPwMsg({ type: "err", text: "Passwords do not match" }); return; }
    if (pwNew.length < 8) { setPwMsg({ type: "err", text: "Password must be at least 8 characters" }); return; }
    setPwSaving(true);
    try {
      await apiFetch("/auth/update-password", {
        method: "POST",
        body: JSON.stringify({ current_password: pwCurrent, new_password: pwNew }),
      });
      setPwMsg({ type: "ok", text: "Password updated successfully" });
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
    } catch (e: any) {
      const msg = e.message?.includes("incorrect") ? "Current password is incorrect" : "Failed to update password";
      setPwMsg({ type: "err", text: msg });
    }
    setPwSaving(false);
  }

  if (loadingMfa) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Two-Factor Authentication (2FA)</h3>
        <p className="text-sm text-gray-500">Add an extra layer of security to your account using an authenticator app.</p>
      </div>

      {mfaError && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {mfaError}
        </div>
      )}
      {mfaSuccess && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 flex items-center gap-2">
          <CheckCircle className="w-4 h-4" /> {mfaSuccess}
        </div>
      )}

      {hasVerified ? (
        <div className="p-5 border-2 border-green-200 rounded-xl bg-green-50/30">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-green-100 rounded-full flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900">2FA is enabled</h4>
              <p className="text-xs text-green-600">Your account is protected with two-factor authentication</p>
            </div>
          </div>
          {mfaFactors.filter(f => f.status === "verified").map((factor) => (
            <div key={factor.id} className="flex items-center justify-between p-3 bg-white rounded-lg border border-gray-200 mt-3">
              <div>
                <p className="text-sm font-medium text-gray-900">{factor.friendly_name || "Authenticator App"}</p>
                <p className="text-xs text-gray-500">Added {new Date(factor.created_at).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => disableMfa(factor.id)}
                disabled={disabling}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50"
              >
                <ShieldOff className="w-3.5 h-3.5" /> {disabling ? "Removing..." : "Remove"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="p-5 border-2 border-amber-200 rounded-xl bg-amber-50/30">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center">
              <Shield className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-gray-900">2FA is not enabled</h4>
              <p className="text-xs text-amber-600">Enable two-factor authentication for better security</p>
            </div>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            Two-factor authentication adds an extra layer of security by requiring a code from your authenticator app when you sign in.
          </p>
          <button
            onClick={() => (window.location.href = "/mfa-setup")}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
          >
            <Shield className="w-4 h-4" /> Enable Two-Factor Authentication
          </button>
        </div>
      )}

      <div className="p-4 bg-gray-50 rounded-xl">
        <h4 className="text-sm font-medium text-gray-900 mb-2">Supported authenticator apps</h4>
        <div className="grid grid-cols-2 gap-2">
          {["Google Authenticator", "Authy", "Microsoft Authenticator", "1Password"].map((app) => (
            <div key={app} className="flex items-center gap-2 text-xs text-gray-600">
              <div className="w-1.5 h-1.5 bg-green-400 rounded-full" /> {app}
            </div>
          ))}
        </div>
      </div>

      <hr className="border-gray-200" />

      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Lock className="w-4 h-4" /> Update Password
        </h3>
        <p className="text-sm text-gray-500 mb-4">Change your account password. You will need your current password to confirm.</p>

        {pwMsg && (
          <div className={`p-3 rounded-xl text-sm flex items-center gap-2 mb-4 ${pwMsg.type === "ok" ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-700"}`}>
            {pwMsg.type === "ok" ? <CheckCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />} {pwMsg.text}
          </div>
        )}

        <div className="space-y-3 max-w-md">
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1.5 block">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? "text" : "password"}
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
              />
              <button type="button" onClick={() => setShowCurrent(!showCurrent)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                {showCurrent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1.5 block">New Password</label>
            <div className="relative">
              <input
                type={showNew ? "text" : "password"}
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
              />
              <button type="button" onClick={() => setShowNew(!showNew)} className="absolute right-3 top-2.5 text-gray-400 hover:text-gray-600">
                {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1.5 block">Confirm New Password</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
            />
          </div>
          <button
            onClick={updatePassword}
            disabled={pwSaving}
            className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
          >
            <Lock className="w-4 h-4" /> {pwSaving ? "Updating..." : "Update Password"}
          </button>
        </div>
      </div>

      {/* Sprint 5 WorkOS Phase 4: Single sign-on configuration card.
          Lives at the bottom of the Security tab so it sits next to
          2FA + password — all the "how users log in" controls in one
          place. Self-contained component (own state, own API calls,
          own role gate) so it can be moved later without touching
          the surrounding tab logic. */}
      <SsoTenantConfigCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SsoTenantConfigCard — Phase 4 tenant self-service SSO config UI.
// ---------------------------------------------------------------------------
// Reads + writes /api/sso/tenant-connection. The API enforces admin/owner
// on the write side, but we ALSO check role client-side to:
//   1. Render read-only mode for members (avoids them clicking Save and
//      hitting an authoritative 403 — bad UX).
//   2. Avoid showing the WorkOS connection ID input at all to non-admins
//      (defence-in-depth against shoulder-surfing in a shared screen).
// On a fresh tenant with no connection yet, both fields are empty and
// the card prompts the admin to paste their connection ID. The
// connection ID itself is provisioned by Replit staff via the existing
// Phase 2 endpoints — we don't expose connection creation to tenants.
// ---------------------------------------------------------------------------
function SsoTenantConfigCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [myRole, setMyRole] = useState<string>("member");
  const [connectionId, setConnectionId] = useState<string>("");
  const [domainsInput, setDomainsInput] = useState<string>("");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<{ name?: string; state?: string } | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [schemaDegraded, setSchemaDegraded] = useState(false);
  const [copied, setCopied] = useState(false);

  const isAdmin = myRole === "owner" || myRole === "admin";

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { token } = getAuth();
      const headers = { Authorization: `Bearer ${token}` };
      // Resolve role + SSO config in parallel — same pattern as TeamTab.
      const [ssoRes, bizRes] = await Promise.all([
        fetch(`${API}/sso/tenant-connection`, { headers }),
        fetch(`${API}/user/businesses`, { headers }).catch(() => null),
      ]);

      if (bizRes && bizRes.ok) {
        const bd = await bizRes.json();
        const list = (bd?.businesses || []) as Array<{
          business_id: string;
          role: string;
          is_active: boolean;
        }>;
        const active = list.find((b) => b.is_active) || list[0];
        if (active?.role) setMyRole(active.role);
      }

      if (ssoRes.status === 404) {
        // No business_configs row yet — treat as empty config. Save
        // will succeed once the row gets created (admin onboarding).
        return;
      }
      if (!ssoRes.ok) {
        const j = await ssoRes.json().catch(() => ({} as { error?: string }));
        setError(j.error || `Failed to load SSO config (HTTP ${ssoRes.status})`);
        return;
      }
      const data = (await ssoRes.json()) as {
        connectionId: string | null;
        emailDomains: string[];
        loginUrl: string | null;
        connectionStatus: { name?: string; state?: string } | null;
        connectionError: string | null;
        schemaDegraded: boolean;
      };
      setConnectionId(data.connectionId || "");
      setDomainsInput((data.emailDomains || []).join(", "));
      setLoginUrl(data.loginUrl);
      setConnectionStatus(data.connectionStatus);
      setConnectionError(data.connectionError);
      setSchemaDegraded(!!data.schemaDegraded);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { token } = getAuth();
      // Parse domain input: split on commas, semicolons, OR whitespace
      // so admins can paste any reasonable format. Server normalises +
      // validates each, so we just pass them through.
      const rawDomains = domainsInput
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);

      const body: Record<string, unknown> = {
        connectionId: connectionId.trim() || null,
        emailDomains: rawDomains,
      };

      const res = await fetch(`${API}/sso/tenant-connection`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({} as { error?: string; details?: string }));
      if (!res.ok) {
        const detail = (data as { details?: string }).details;
        setError(detail || data.error || `Save failed (HTTP ${res.status})`);
        return;
      }
      setSuccess("SSO settings saved.");
      // Reload so we get the fresh loginUrl + connection name from WorkOS.
      await load();
      setTimeout(() => setSuccess(null), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setSaving(false);
    }
  }

  async function copyLoginUrl() {
    if (!loginUrl) return;
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in iframes / insecure contexts. Silent
      // failure is fine — the URL is still visible on screen for
      // manual copy.
    }
  }

  return (
    <div>
      <h3 className="text-base font-semibold text-gray-900 mb-1">Single Sign-On (SSO)</h3>
      <p className="text-sm text-gray-500 mb-4">
        Let your team sign in with your company identity provider (Okta, Microsoft Entra, Google
        Workspace, etc.). Your connection is provisioned by Neverr — paste the connection ID
        below once you've received it.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading SSO config...
        </div>
      ) : (
        <div className="space-y-4">
          {schemaDegraded && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                Email-domain mapping is being rolled out. You can still configure the connection
                ID; domain auto-discovery will activate once the rollout finishes.
              </span>
            </div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> {error}
            </div>
          )}
          {success && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-700 flex items-start gap-2">
              <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" /> {success}
            </div>
          )}

          {!isAdmin && (
            <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-600">
              Only owners and admins can change SSO settings. Contact your administrator to make
              changes.
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-700 mb-1.5 block">
              WorkOS Connection ID
            </label>
            <input
              type="text"
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              disabled={!isAdmin || saving}
              placeholder="conn_..."
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 disabled:bg-gray-50 disabled:text-gray-500"
            />
            {connectionStatus && (
              <p className="text-xs text-gray-500 mt-1.5">
                Connected to{" "}
                <span className="font-medium text-gray-700">
                  {connectionStatus.name || "(unnamed)"}
                </span>{" "}
                — state:{" "}
                <span
                  className={
                    connectionStatus.state === "active"
                      ? "text-green-600 font-medium"
                      : "text-amber-600 font-medium"
                  }
                >
                  {connectionStatus.state || "unknown"}
                </span>
              </p>
            )}
            {connectionError && (
              <p className="text-xs text-red-600 mt-1.5">
                Couldn't reach WorkOS to verify this connection: {connectionError}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-700 mb-1.5 block">
              Email Domains
            </label>
            <input
              type="text"
              value={domainsInput}
              onChange={(e) => setDomainsInput(e.target.value)}
              disabled={!isAdmin || saving || schemaDegraded}
              placeholder="acme.com, acme.co.uk"
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="text-xs text-gray-500 mt-1.5">
              Comma-separated list of email domains your team uses. When someone enters one of
              these on the sign-in page, they'll be redirected to your SSO provider automatically.
              Public domains like gmail.com are not allowed.
            </p>
          </div>

          {loginUrl && (
            <div>
              <label className="text-xs font-medium text-gray-700 mb-1.5 block">
                Direct SSO Sign-In URL
              </label>
              <div className="flex items-stretch gap-2">
                <input
                  type="text"
                  value={loginUrl}
                  readOnly
                  className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-mono bg-gray-50 text-gray-700 focus:outline-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  type="button"
                  onClick={copyLoginUrl}
                  className="px-3 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1.5">
                Share this with your team or bookmark it — bypasses the email lookup step.
              </p>
            </div>
          )}

          {isAdmin && (
            <button
              onClick={save}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
            >
              <ShieldCheck className="w-4 h-4" /> {saving ? "Saving..." : "Save SSO Settings"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PhoneSetupTab({ neverrPhone }: { neverrPhone: string }) {
  const [carrierTab, setCarrierTab] = useState("att");
  const [copied, setCopied] = useState(false);
  const formatted = neverrPhone;

  const copyNumber = () => {
    navigator.clipboard.writeText(formatted.replace(/[\s()-]/g, ""));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const carriers = [
    { id: "att", name: "AT&T", instructions: `Dial *72 then ${formatted} then press #. Wait for confirmation tone.` },
    { id: "verizon", name: "Verizon", instructions: `Dial *72 then ${formatted}. Wait for confirmation tone.` },
    { id: "tmobile", name: "T-Mobile", instructions: "Log into your T-Mobile account. Go to Account > Features > Call Forwarding. Enter your Neverr number and save." },
    { id: "google", name: "Google Voice", instructions: "Open Google Voice Settings. Go to Calls > Forward calls. Add your Neverr number and verify." },
    { id: "other", name: "Other", instructions: "Contact your phone carrier and ask them to set up unconditional call forwarding to your Neverr number." },
  ];

  if (!neverrPhone) {
    return (
      <div className="space-y-6">
        <div>
          <h3 className="text-base font-semibold text-gray-900 mb-1">Connect Your Phone Number</h3>
          <p className="text-sm text-gray-500">Forward your business phone calls to your Neverr AI receptionist.</p>
        </div>

        <div className="p-6 bg-gray-50 border border-gray-200 rounded-2xl">
          <p className="text-sm text-gray-700">
            Your Neverr number is being provisioned. This usually takes under a minute. If you've been waiting longer than 5 minutes, contact support at hello@neverr.ai.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Connect Your Phone Number</h3>
        <p className="text-sm text-gray-500">Forward your business phone calls to your Neverr AI receptionist.</p>
      </div>

      <div className="p-6 bg-gradient-to-r from-[#1B2537] to-[#2E75B6] rounded-2xl text-white">
        <p className="text-sm text-white/70 mb-1">Your Neverr number</p>
        <div className="flex items-center gap-3">
          <PhoneCall className="w-6 h-6" />
          <span className="text-2xl font-bold tracking-wide">{formatted}</span>
          <button onClick={copyNumber} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-white/20 rounded-lg text-sm hover:bg-white/30 transition-colors">
            <Copy className="w-3.5 h-3.5" /> {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-3">How to set up call forwarding</h4>
        <div className="space-y-3">
          {[
            "Log into your phone carrier account or pick up your phone",
            "Find Call Forwarding settings",
            `Set "Forward all calls" to: ${formatted}`,
            "Save and test by calling your business number",
          ].map((step, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-[#2E75B6] text-white flex items-center justify-center text-xs font-bold flex-shrink-0">
                {i + 1}
              </div>
              <p className="text-sm text-gray-700 pt-1">{step}</p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-3">Carrier-specific instructions</h4>
        <div className="flex gap-1 mb-3 overflow-x-auto">
          {carriers.map((c) => (
            <button
              key={c.id}
              onClick={() => setCarrierTab(c.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                carrierTab === c.id ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
          <p className="text-sm text-gray-700">{carriers.find((c) => c.id === carrierTab)?.instructions}</p>
        </div>
      </div>

      <div className="p-5 border-2 border-[#2E75B6]/20 rounded-xl bg-blue-50/30">
        <h4 className="text-sm font-semibold text-gray-900 mb-2">Test Your AI Receptionist</h4>
        <p className="text-sm text-gray-600 mb-3">
          Call your Neverr number to hear your AI receptionist in action. Make sure you've completed your Business Profile and AI Receptionist setup first.
        </p>
        <a
          href={`tel:${formatted.replace(/[\s()-]/g, "")}`}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
        >
          <Phone className="w-4 h-4" /> Call {formatted}
        </a>
      </div>
    </div>
  );
}

const WEBHOOK_EVENTS = [
  { id: "call.completed", label: "New call completed", desc: "Fires after every completed call with transcript and analysis", defaultOn: true, available: true },
  { id: "lead.hot", label: "Hot lead captured", desc: "Fires when a caller is scored as a hot lead", defaultOn: true, available: true },
  { id: "appointment.booked", label: "Appointment booked", desc: "Fires when a caller successfully books an appointment", defaultOn: true, available: true },
  { id: "caller.returning", label: "Caller recognized (returning caller)", desc: "Coming soon — fires when a returning caller is identified", defaultOn: false, available: false },
  { id: "emergency.detected", label: "Emergency detected", desc: "Coming soon — fires when an urgent or emergency situation is detected", defaultOn: false, available: false },
];

const PLAN_LOC_LIMITS: Record<string, number> = {
  starter: 1, essential: 1, professional: 1,
  growth: 2, business: 3, enterprise: 4,
};

function LocationsTab({ plan }: { plan: string }) {
  const [locations, setLocations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ location_name: "", address: "", phone_number: "", agent_name: "Alex", timezone: "America/New_York" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const maxLocs = PLAN_LOC_LIMITS[plan] || 1;
  const canAdd = locations.length < maxLocs;

  const loadLocations = () => {
    fetch(`${API}/locations`, { headers: { Authorization: `Bearer ${localStorage.getItem("neverr_token")}` } })
      .then(r => r.json())
      .then(d => { setLocations(d?.locations || []); setLoading(false); })
      .catch(() => setLoading(false));
  };

  useEffect(() => { loadLocations(); }, []);

  const handleSave = async () => {
    if (!form.location_name.trim()) { setError("Location name is required"); return; }
    setSaving(true); setError("");
    try {
      const url = editingId ? `${API}/locations/${editingId}` : `${API}/locations`;
      const method = editingId ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("neverr_token")}` },
        body: JSON.stringify(form),
      });
      const d = await res.json();
      if (!res.ok) { setError(d.error || "Failed to save"); setSaving(false); return; }
      setShowForm(false); setEditingId(null); setForm({ location_name: "", address: "", phone_number: "", agent_name: "Alex", timezone: "America/New_York" });
      loadLocations();
    } catch { setError("Failed to save location"); }
    setSaving(false);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this location?")) return;
    await fetch(`${API}/locations/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${localStorage.getItem("neverr_token")}` },
    });
    loadLocations();
  };

  const startEdit = (loc: any) => {
    setEditingId(loc.id);
    setForm({ location_name: loc.location_name, address: loc.address || "", phone_number: loc.phone_number || "", agent_name: loc.agent_name || "Alex", timezone: loc.timezone || "America/New_York" });
    setShowForm(true);
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Locations</h3>
          <p className="text-sm text-gray-500">Manage your business locations. Your plan supports up to {maxLocs} location{maxLocs > 1 ? "s" : ""}.</p>
        </div>
        {canAdd ? (
          <button onClick={() => { setEditingId(null); setForm({ location_name: "", address: "", phone_number: "", agent_name: "Alex", timezone: "America/New_York" }); setShowForm(true); setError(""); }} className="flex items-center gap-1.5 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20">
            <Plus className="w-4 h-4" /> Add Location
          </button>
        ) : (
          <div className="text-xs text-gray-500 bg-gray-50 px-3 py-1.5 rounded-lg">
            {maxLocs === 1 ? "Upgrade to Growth for multi-location" : `${locations.length}/${maxLocs} locations used`}
          </div>
        )}
      </div>

      {showForm && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <h4 className="text-sm font-semibold text-gray-900">{editingId ? "Edit Location" : "New Location"}</h4>
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Location Name *</label>
              <input value={form.location_name} onChange={e => setForm({ ...form, location_name: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] outline-none" placeholder="e.g. Downtown Branch" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Address</label>
              <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] outline-none" placeholder="123 Main St, City, State" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Phone Number</label>
              <input value={form.phone_number} onChange={e => setForm({ ...form, phone_number: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] outline-none" placeholder="+1 (555) 000-0000" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Agent Name</label>
              <input value={form.agent_name} onChange={e => setForm({ ...form, agent_name: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] outline-none" placeholder="Alex" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Timezone</label>
              <select value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] outline-none bg-white">
                <option value="America/New_York">Eastern Time</option>
                <option value="America/Chicago">Central Time</option>
                <option value="America/Denver">Mountain Time</option>
                <option value="America/Los_Angeles">Pacific Time</option>
                <option value="America/Anchorage">Alaska Time</option>
                <option value="Pacific/Honolulu">Hawaii Time</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {editingId ? "Update" : "Create"} Location
            </button>
            <button onClick={() => { setShowForm(false); setEditingId(null); setError(""); }} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {locations.map((loc: any) => (
          <div key={loc.id} className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between hover:border-gray-300 transition-colors">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${loc.is_primary ? "bg-[#2E75B6]/10" : "bg-gray-100"}`}>
                <MapPin className={`w-5 h-5 ${loc.is_primary ? "text-[#2E75B6]" : "text-gray-500"}`} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900">{loc.location_name}</p>
                  {loc.is_primary && <span className="text-[10px] bg-[#2E75B6]/10 text-[#2E75B6] px-2 py-0.5 rounded-full font-medium">Primary</span>}
                </div>
                <p className="text-xs text-gray-500">{[loc.address, loc.phone_number].filter(Boolean).join(" · ") || "No details"}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => startEdit(loc)} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors">
                <Edit3 className="w-4 h-4" />
              </button>
              {!loc.is_primary && (
                <button onClick={() => handleDelete(loc.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntegrationsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [plan, setPlan] = useState("starter");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(false);
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["call.completed", "lead.hot", "appointment.booked"]);
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  const isGated = plan === "starter" || plan === "essential" || plan === "growth";

  useEffect(() => {
    apiFetch("/webhooks/config")
      .then((d) => {
        setPlan(d.plan || "starter");
        if (d.webhook_config) {
          setWebhookUrl(d.webhook_config.url || "");
          setWebhookSecret(d.webhook_config.secret || "");
          setWebhookEnabled(d.webhook_config.enabled || false);
          setWebhookEvents(d.webhook_config.events || ["call.completed", "lead.hot", "appointment.booked"]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleEvent = (eventId: string) => {
    setWebhookEvents(prev =>
      prev.includes(eventId) ? prev.filter(e => e !== eventId) : [...prev, eventId]
    );
  };

  const saveWebhook = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await apiFetch("/webhooks/config", {
        method: "POST",
        body: JSON.stringify({ url: webhookUrl, events: webhookEvents, enabled: webhookEnabled }),
      });
      setSaveMsg({ ok: true, msg: "Webhook settings saved" });
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (e: any) {
      setSaveMsg({ ok: false, msg: e.message?.includes("403") ? "Upgrade to Professional plan to use webhooks." : "Failed to save" });
    }
    setSaving(false);
  };

  const sendTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const d = await apiFetch("/webhooks/test", { method: "POST" });
      if (d.success) {
        setTestResult({ ok: true, msg: `Response: ${d.status} ${d.statusText}` });
      } else {
        setTestResult({ ok: false, msg: d.error || "Test failed" });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message || "Failed to send test" });
    }
    setTesting(false);
  };

  const regenerateSecret = async () => {
    if (!confirm("Regenerating your secret will invalidate the current one. Any existing integrations using the old secret will need to be updated. Continue?")) return;
    setRegenerating(true);
    try {
      const d = await apiFetch("/webhooks/regenerate-secret", { method: "POST" });
      if (d.secret) setWebhookSecret(d.secret);
    } catch {}
    setRegenerating(false);
  };

  const copySecret = () => {
    navigator.clipboard.writeText(webhookSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Integrations</h3>
        <p className="text-sm text-gray-500">Connect Neverr to your favorite tools and CRM platforms.</p>
      </div>

      {isGated && (
        <div className="p-5 bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl border border-amber-200">
          <div className="flex items-start gap-3">
            <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Webhooks and integrations are available on Professional plan and above.</p>
              <p className="text-xs text-gray-600 mt-1">Upgrade your plan to connect Neverr with Zapier, custom webhooks, and more.</p>
            </div>
            <a href="/pricing" className="flex items-center gap-1 text-sm font-semibold text-[#2E75B6] hover:underline whitespace-nowrap">
              Upgrade <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      )}

      <div className={`grid grid-cols-2 gap-4 ${isGated ? "opacity-50 pointer-events-none" : ""}`}>
        <div className="border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-orange-100 rounded-lg flex items-center justify-center">
              <Zap className="w-5 h-5 text-orange-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Zapier</p>
              <p className="text-xs text-gray-500">Connect to 5,000+ apps</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">Automatically send call data, leads, and appointments to any app through Zapier.</p>
          <a
            href="https://zapier.com/apps/neverr/integrations"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-orange-50 text-orange-700 rounded-lg text-xs font-semibold hover:bg-orange-100 transition-colors"
          >
            Connect to Zapier <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="border border-gray-200 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-[#2E75B6]/10 rounded-lg flex items-center justify-center">
              <Plug className="w-5 h-5 text-[#2E75B6]" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Custom Webhook</p>
              <p className="text-xs text-gray-500">Send data to your own URL</p>
            </div>
          </div>
          <p className="text-xs text-gray-500 mb-4">Receive real-time POST requests for call events with HMAC-SHA256 signature verification.</p>
          <div className="flex items-center gap-2">
            <Toggle checked={webhookEnabled} onChange={(v) => setWebhookEnabled(v)} />
            <span className="text-xs font-medium text-gray-700">{webhookEnabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>

        <div className="border border-gray-200 rounded-xl p-5 opacity-60">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-orange-50 rounded-lg flex items-center justify-center text-xl">🟠</div>
            <div>
              <p className="text-sm font-semibold text-gray-900">HubSpot</p>
              <p className="text-xs text-gray-400">Coming soon</p>
            </div>
          </div>
          <p className="text-xs text-gray-400">Auto-create contacts and deals in HubSpot when calls come in.</p>
        </div>

        <div className="border border-gray-200 rounded-xl p-5 opacity-60">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center text-xl">☁️</div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Salesforce</p>
              <p className="text-xs text-gray-400">Coming soon</p>
            </div>
          </div>
          <p className="text-xs text-gray-400">Sync leads and call logs to Salesforce automatically.</p>
        </div>
      </div>

      {webhookEnabled && !isGated && (
        <div className="border border-gray-200 rounded-xl p-6 space-y-5">
          <h4 className="text-sm font-semibold text-gray-900">Webhook Configuration</h4>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Webhook URL</label>
            <input
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://your-crm.com/webhook/neverr"
              className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
            />
            <p className="text-xs text-gray-400 mt-1">We'll POST event data to this URL in real-time.</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1.5">Signing Secret</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showSecret ? "text" : "password"}
                  value={webhookSecret}
                  readOnly
                  className="w-full px-3 py-2.5 pr-20 border border-gray-200 rounded-xl text-sm bg-gray-50 font-mono"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                  <button
                    onClick={() => setShowSecret(!showSecret)}
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                    title={showSecret ? "Hide" : "Show"}
                  >
                    {showSecret ? <EyeOff className="w-3.5 h-3.5 text-gray-500" /> : <Eye className="w-3.5 h-3.5 text-gray-500" />}
                  </button>
                  <button
                    onClick={copySecret}
                    className="p-1 rounded hover:bg-gray-200 transition-colors"
                    title="Copy"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Copy className="w-3.5 h-3.5 text-gray-500" />}
                  </button>
                </div>
              </div>
              <button
                onClick={regenerateSecret}
                disabled={regenerating}
                className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-xl text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${regenerating ? "animate-spin" : ""}`} />
                Regenerate
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">Use this secret to verify webhook signatures. Header: <code className="bg-gray-100 px-1 py-0.5 rounded text-[10px]">X-Neverr-Signature</code></p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-2">Events to send</label>
            <div className="space-y-2">
              {WEBHOOK_EVENTS.map(ev => (
                <label key={ev.id} className={`flex items-start gap-3 p-3 rounded-lg transition-colors ${ev.available ? "hover:bg-gray-50 cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
                  <input
                    type="checkbox"
                    checked={webhookEvents.includes(ev.id)}
                    onChange={() => ev.available && toggleEvent(ev.id)}
                    disabled={!ev.available}
                    className="w-4 h-4 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6] mt-0.5 disabled:opacity-50"
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {ev.label}
                      {!ev.available && <span className="ml-2 text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">Coming soon</span>}
                    </p>
                    <p className="text-xs text-gray-500">{ev.desc}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={saveWebhook}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
            >
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Webhook Settings"}
            </button>
            <button
              onClick={sendTest}
              disabled={testing || !webhookUrl}
              className="flex items-center gap-2 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send Test Event
            </button>
          </div>

          {saveMsg && (
            <div className={`p-3 rounded-xl text-sm ${saveMsg.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              {saveMsg.msg}
            </div>
          )}

          {testResult && (
            <div className={`p-3 rounded-xl text-sm ${testResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              {testResult.ok ? "Test webhook sent successfully!" : "Test failed:"} {testResult.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BillingTab() {
  const [sub, setSub] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    const { businessId } = getAuth();
    apiFetch(`/stripe/subscription/${businessId}`)
      .then((d) => setSub(d.subscription || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const openPortal = async () => {
    setPortalLoading(true);
    try {
      const { businessId } = getAuth();
      const d = await apiFetch("/stripe/portal", {
        method: "POST",
        body: JSON.stringify({ businessId }),
      });
      if (d.url) window.location.href = d.url;
    } catch {
      alert("Unable to open billing portal. Please contact support.");
    }
    setPortalLoading(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" />
      </div>
    );
  }

  const planId = sub?.plan_id || "essential";
  const planName = PLAN_NAMES[planId] || "Essential";
  const cycle = sub?.billing_cycle || "monthly";
  // Sprint 1 BUG-17 sub-step 3c-extended-3 (M5 fix): the canonical status
  // value the webhook writes is "trialing" (verbatim from Stripe), not the
  // legacy "trial" placeholder. The displayed label "Trial" is preserved
  // for the user — only the comparisons changed.
  const status = sub?.subscription_status || "trialing";
  const nextBilling = sub?.current_period_end ? new Date(sub.current_period_end).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  const trialEnds = sub?.trial_ends_at ? new Date(sub.trial_ends_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  const limits = PLAN_LIMITS[planId] || PLAN_LIMITS.essential;

  return (
    <div className="space-y-6">
      {!sub?.stripe_customer_id && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
          <strong>You're on a 7-day free trial.</strong> Add a payment method to keep your service active after the trial ends.{" "}
          <a href="/pricing" className="underline font-medium">View plans →</a>
        </div>
      )}

      <div className="p-6 border-2 border-[#2E75B6]/20 rounded-2xl bg-gradient-to-br from-blue-50/50 to-white">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">{planName} Plan</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {cycle === "annual" ? "Billed annually" : "Billed monthly"}
              {" \u00B7 "}
              <span className={`font-medium ${status === "active" ? "text-green-600" : status === "trialing" ? "text-amber-600" : "text-gray-600"}`}>
                {status === "active" ? "Active" : status === "trialing" ? "Trial" : status.charAt(0).toUpperCase() + status.slice(1)}
              </span>
            </p>
            {nextBilling && <p className="text-xs text-gray-400 mt-1">Next billing: {nextBilling}</p>}
            {trialEnds && <p className="text-xs text-gray-400 mt-1">Trial ends: {trialEnds}</p>}
          </div>
          <button
            onClick={openPortal}
            disabled={portalLoading || !sub?.stripe_customer_id}
            className="flex items-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-[#2E75B6]/20"
            title={!sub?.stripe_customer_id ? "Available after you add a payment method" : undefined}
          >
            {portalLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ExternalLink className="w-4 h-4" />}
            Manage Billing
          </button>
        </div>
      </div>

      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-500 uppercase tracking-wide">
            Usage Tracking
          </span>
          <span className="text-[10px] px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded font-medium uppercase tracking-wide">
            Coming Soon
          </span>
        </div>
        <p className="text-xs text-slate-600 mt-2 leading-relaxed">
          Real-time minute and SMS usage tracking is being calibrated. Your current plan{" "}
          <strong className="capitalize">{planName}</strong> includes{" "}
          <strong>{limits.minutes.toLocaleString()} minutes/mo</strong> and{" "}
          <strong>{limits.sms.toLocaleString()} SMS/mo</strong>.
        </p>
      </div>

      {(planId === "starter" || planId === "essential") && (
        <div className="p-4 bg-gradient-to-r from-amber-50 to-orange-50 rounded-xl border border-amber-200">
          <div className="flex items-center gap-3">
            <Zap className="w-5 h-5 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-gray-900">Need more minutes?</p>
              <p className="text-xs text-gray-600">Upgrade your plan for more call minutes and SMS.</p>
            </div>
            <a href="/pricing" className="flex items-center gap-1 text-sm font-semibold text-[#2E75B6] hover:underline">
              Upgrade <ChevronRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

const OBJECTION_CATEGORIES = ["price", "insurance", "availability", "anxiety", "competition", "delay", "loyalty", "dietary", "qualification", "urgency", "other"];
const FOLLOW_UP_ACTIONS = [
  { value: "", label: "None" },
  { value: "schedule_appointment", label: "Schedule appointment" },
  { value: "offer_consultation", label: "Offer consultation" },
  { value: "transfer_to_human", label: "Transfer to human" },
  { value: "send_sms", label: "Send SMS with info" },
  { value: "hold_appointment", label: "Hold appointment" },
  { value: "offer_payment_plan", label: "Offer payment plan" },
  { value: "schedule_free_consult", label: "Schedule free consult" },
  { value: "offer_free_diagnostic", label: "Offer free diagnostic" },
];

interface ObjectionHandler {
  id: string;
  business_id: string;
  objection_phrase: string;
  objection_category: string;
  ai_response: string;
  follow_up_action: string | null;
  active: boolean;
  times_triggered: number;
  times_converted: number;
  created_at: string;
}

function CompetitorsTab() {
  const [competitors, setCompetitors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ competitor_name: "", competitor_response: "" });

  const token = localStorage.getItem("neverr_token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function loadCompetitors() {
    try {
      const r = await fetch(`${API}/competitors`, { headers });
      const d = await r.json();
      if (d.competitors) setCompetitors(d.competitors);
    } catch {}
    setLoading(false);
  }

  useEffect(() => { loadCompetitors(); }, []);

  async function handleSave() {
    if (!form.competitor_name.trim() || !form.competitor_response.trim()) return;
    setSaving(true);
    try {
      if (editingId) {
        await fetch(`${API}/competitors/${editingId}`, { method: "PUT", headers, body: JSON.stringify(form) });
      } else {
        await fetch(`${API}/competitors`, { method: "POST", headers, body: JSON.stringify(form) });
      }
      setShowModal(false);
      setEditingId(null);
      setForm({ competitor_name: "", competitor_response: "" });
      loadCompetitors();
    } catch {}
    setSaving(false);
  }

  async function handleDelete(id: string) {
    try {
      await fetch(`${API}/competitors/${id}`, { method: "DELETE", headers });
      loadCompetitors();
    } catch {}
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" /></div>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Competitive Intelligence</h3>
          <p className="text-sm text-gray-500 mt-0.5">When callers mention a competitor, your AI responds with your best counter.</p>
        </div>
        <button
          onClick={() => { setEditingId(null); setForm({ competitor_name: "", competitor_response: "" }); setShowModal(true); }}
          className="flex items-center gap-1.5 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
        >
          <Plus className="w-4 h-4" /> Add Competitor
        </button>
      </div>

      {competitors.length === 0 ? (
        <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-300">
          <Swords className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-500">No competitors configured yet</p>
          <p className="text-xs text-gray-400 mt-1">Add competitors your callers might mention so your AI can respond intelligently.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {competitors.map((c) => (
            <div key={c.id} className="bg-white border border-gray-200 rounded-xl p-4 hover:border-[#2E75B6]/20 transition-all">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5">
                    <p className="text-sm font-semibold text-gray-900">{c.competitor_name}</p>
                    {c.times_mentioned > 0 && (
                      <span className="px-2 py-0.5 bg-amber-50 text-amber-700 text-[10px] font-semibold rounded-full border border-amber-200">
                        {c.times_mentioned} mention{c.times_mentioned !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">{c.competitor_response}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => { setEditingId(c.id); setForm({ competitor_name: c.competitor_name, competitor_response: c.competitor_response }); setShowModal(true); }}
                    className="p-1.5 text-gray-400 hover:text-[#2E75B6] hover:bg-blue-50 rounded-lg transition-all"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(c.id)}
                    className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h3 className="text-base font-semibold text-gray-900">{editingId ? "Edit Competitor" : "Add Competitor"}</h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded-lg">
                <X className="w-4 h-4 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Competitor Name</label>
                <input
                  value={form.competitor_name}
                  onChange={(e) => setForm({ ...form, competitor_name: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder='e.g. "ABC Dental", "Smith & Jones Law"'
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">When a caller mentions this competitor, your AI should say:</label>
                <textarea
                  value={form.competitor_response}
                  onChange={(e) => setForm({ ...form, competitor_response: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
                  rows={4}
                  placeholder={"e.g. \"We're actually rated #1 in the area and offer free consultations unlike most firms. Can I tell you more about what makes us different?\""}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-5 border-t border-gray-100">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-xl">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.competitor_name.trim() || !form.competitor_response.trim()}
                className="px-5 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
              >
                {saving ? "Saving..." : editingId ? "Update" : "Add Competitor"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ObjectionHandlersTab({ industry }: { industry: string }) {
  const [handlers, setHandlers] = useState<ObjectionHandler[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    objection_phrase: "",
    objection_category: "price",
    ai_response: "",
    follow_up_action: "",
  });

  const token = localStorage.getItem("neverr_token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  async function loadHandlers() {
    try {
      const r = await fetch(`${API}/objections`, { headers });
      const d = await r.json();
      if (d.handlers) setHandlers(d.handlers);
    } catch {}
    setLoading(false);
  }

  useEffect(() => { loadHandlers(); }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const url = editingId ? `${API}/objections/${editingId}` : `${API}/objections`;
      const method = editingId ? "PUT" : "POST";
      const r = await fetch(url, { method, headers, body: JSON.stringify(form) });
      if (r.ok) {
        setShowModal(false);
        setEditingId(null);
        setForm({ objection_phrase: "", objection_category: "price", ai_response: "", follow_up_action: "" });
        loadHandlers();
      }
    } catch {}
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this objection handler?")) return;
    await fetch(`${API}/objections/${id}`, { method: "DELETE", headers });
    loadHandlers();
  }

  async function handleToggle(h: ObjectionHandler) {
    await fetch(`${API}/objections/${h.id}`, { method: "PUT", headers, body: JSON.stringify({ active: !h.active }) });
    loadHandlers();
  }

  async function loadTemplates() {
    const r = await fetch(`${API}/objections/load-templates`, {
      method: "POST", headers, body: JSON.stringify({ industry })
    });
    const d = await r.json();
    if (d.loaded > 0) loadHandlers();
    alert(d.loaded > 0 ? `Loaded ${d.loaded} industry templates!` : "Templates already loaded.");
  }

  function openEdit(h: ObjectionHandler) {
    setForm({
      objection_phrase: h.objection_phrase,
      objection_category: h.objection_category,
      ai_response: h.ai_response,
      follow_up_action: h.follow_up_action || "",
    });
    setEditingId(h.id);
    setShowModal(true);
  }

  function openAdd() {
    setForm({ objection_phrase: "", objection_category: "price", ai_response: "", follow_up_action: "" });
    setEditingId(null);
    setShowModal(true);
  }

  const totalTriggered = handlers.reduce((s, h) => s + (h.times_triggered || 0), 0);
  const totalConverted = handlers.reduce((s, h) => s + (h.times_converted || 0), 0);

  const catColors: Record<string, string> = {
    price: "bg-red-100 text-red-700",
    insurance: "bg-blue-100 text-blue-700",
    anxiety: "bg-purple-100 text-purple-700",
    delay: "bg-amber-100 text-amber-700",
    loyalty: "bg-green-100 text-green-700",
    availability: "bg-cyan-100 text-cyan-700",
    dietary: "bg-orange-100 text-orange-700",
    qualification: "bg-indigo-100 text-indigo-700",
    urgency: "bg-rose-100 text-rose-700",
    competition: "bg-teal-100 text-teal-700",
    other: "bg-gray-100 text-gray-700",
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" /></div>;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold text-gray-900 mb-1">Objection Intelligence</h3>
        <p className="text-sm text-gray-500">Train your AI to handle common objections and turn hesitant callers into booked customers</p>
      </div>

      <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-xl">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <Brain className="w-4 h-4 text-[#2E75B6]" />
          <span className="font-semibold text-gray-900">{totalTriggered}</span> objections handled
        </div>
        <div className="w-px h-4 bg-gray-300" />
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <CheckCircle className="w-4 h-4 text-green-500" />
          <span className="font-semibold text-gray-900">{totalConverted}</span> converted to appointments
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20">
          <Plus className="w-4 h-4" /> Add Objection Handler
        </button>
        <button onClick={loadTemplates} className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50">
          <Zap className="w-4 h-4 text-amber-500" /> Load {industry} templates
        </button>
      </div>

      {handlers.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <Brain className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No objection handlers yet.</p>
          <p className="text-xs mt-1">Add custom handlers or load industry templates to get started.</p>
        </div>
      )}

      <div className="space-y-3">
        {handlers.map(h => {
          const catClass = catColors[h.objection_category] || catColors.other;
          const convRate = h.times_triggered > 0 ? Math.round((h.times_converted / h.times_triggered) * 100) : 0;
          return (
            <div key={h.id} className={`border rounded-xl p-4 transition-colors ${h.active ? "border-gray-200 bg-white" : "border-gray-100 bg-gray-50 opacity-60"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${catClass}`}>{h.objection_category}</span>
                    {h.follow_up_action && <span className="text-xs text-gray-400">{h.follow_up_action.replace(/_/g, " ")}</span>}
                  </div>
                  <p className="text-xs font-medium text-gray-500 mb-1">When caller says: <span className="text-gray-700 italic">"{h.objection_phrase}"</span></p>
                  <p className="text-sm text-gray-800 leading-relaxed">{h.ai_response}</p>
                  <div className="flex items-center gap-4 mt-3 text-xs text-gray-400">
                    <span>Triggered {h.times_triggered}x</span>
                    <span>Converted {h.times_converted}x ({convRate}%)</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button onClick={() => handleToggle(h)} className="p-1.5 rounded-lg hover:bg-gray-100" title={h.active ? "Deactivate" : "Activate"}>
                    {h.active ? <ToggleRight className="w-5 h-5 text-green-500" /> : <ToggleLeft className="w-5 h-5 text-gray-300" />}
                  </button>
                  <button onClick={() => openEdit(h)} className="p-1.5 rounded-lg hover:bg-gray-100" title="Edit">
                    <Edit3 className="w-4 h-4 text-gray-400" />
                  </button>
                  <button onClick={() => handleDelete(h.id)} className="p-1.5 rounded-lg hover:bg-red-50" title="Delete">
                    <Trash2 className="w-4 h-4 text-red-400" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-gray-900">{editingId ? "Edit" : "Add"} Objection Handler</h3>
              <button onClick={() => setShowModal(false)} className="p-1 hover:bg-gray-100 rounded-lg"><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
                <select value={form.objection_category} onChange={e => setForm({ ...form, objection_category: e.target.value })} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20">
                  {OBJECTION_CATEGORIES.map(c => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Trigger phrases</label>
                <textarea value={form.objection_phrase} onChange={e => setForm({ ...form, objection_phrase: e.target.value })} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none" rows={2} placeholder="too expensive, can't afford, out of budget" />
                <p className="text-xs text-gray-400 mt-1">Comma-separated phrases that trigger this response</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">AI Response <span className="text-gray-400">({form.ai_response.length}/300)</span></label>
                <textarea value={form.ai_response} onChange={e => setForm({ ...form, ai_response: e.target.value.slice(0, 300) })} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none" rows={4} placeholder="What should your AI say when it hears these phrases?" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Follow-up action</label>
                <select value={form.follow_up_action} onChange={e => setForm({ ...form, follow_up_action: e.target.value })} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20">
                  {FOLLOW_UP_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={handleSave} disabled={!form.objection_phrase || !form.ai_response || saving} className="px-5 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50">
                {saving ? "Saving..." : editingId ? "Save Changes" : "Add Handler"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Legacy AiCustomizationTab + redirect card removed in Stage 6
// follow-ups (commit dropped ~250 lines of dead code). The /settings/ai
// surface has been the only path for AI customization since the
// Monday decommission; the redirect card had been in place long enough
// for any bookmark traffic to discover the new location.

type WebsiteState = {
  website: string | null;
  website_scraped_at: string | null;
  website_scraped_data: any | null;
};

function WebsiteTab({ businessId }: { businessId: string }) {
  const [state, setState] = useState<WebsiteState>({ website: null, website_scraped_at: null, website_scraped_data: null });
  const [loading, setLoading] = useState(true);
  const [rescraping, setRescraping] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err" | "cooldown"; text: string } | null>(null);
  const [cooldownSec, setCooldownSec] = useState(0);

  const token = localStorage.getItem("neverr_token");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(`${API}/business/configure?business_id=${businessId}`, { headers });
        const d = await r.json();
        const c = d.config || {};
        setState({
          website: c.website || null,
          website_scraped_at: c.website_scraped_at || null,
          website_scraped_data: c.website_scraped_data || null,
        });
      } catch {}
      setLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  async function handleRescrape() {
    setRescraping(true);
    setMsg(null);
    try {
      const r = await fetch(`${API}/business/${businessId}/rescrape`, { method: "POST", headers });
      if (r.status === 429) {
        const d = await r.json();
        const secs = d.retry_after_seconds || 60;
        setCooldownSec(secs);
        setMsg({ type: "cooldown", text: `Cooldown active: please wait ${secs}s before re-scraping.` });
      } else if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setMsg({ type: "err", text: d.error || `Rescrape failed (HTTP ${r.status})` });
      } else {
        const d = await r.json();
        if (d.success) {
          setState({
            website: state.website,
            website_scraped_at: d.scraped_at || new Date().toISOString(),
            website_scraped_data: d.structured,
          });
          setMsg({ type: "ok", text: `Re-scraped successfully via ${d.tier_used}.` });
        } else {
          setMsg({ type: "err", text: `Scrape failed: ${d.reason || "unknown"}` });
        }
      }
    } catch (e: any) {
      setMsg({ type: "err", text: e.message || "Rescrape failed" });
    }
    setRescraping(false);
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" /></div>;
  }

  const data = state.website_scraped_data;
  const hasScrape = !!state.website_scraped_at && !!data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Website Integration</h2>
        <p className="text-sm text-gray-500">
          Your AI receptionist uses information from your website to answer questions about your business accurately.
        </p>
      </div>

      <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
        <div className="flex items-start justify-between mb-4">
          <div>
            <label className="block text-sm font-semibold text-gray-900">Current Website</label>
            <p className="text-xs text-gray-500 mt-1">
              {state.website ? (
                <a href={state.website} target="_blank" rel="noopener noreferrer" className="text-[#2E75B6] hover:underline">
                  {state.website}
                </a>
              ) : (
                <span className="text-gray-400">No website on file. Add one in Business Profile tab.</span>
              )}
            </p>
          </div>
          <button
            onClick={handleRescrape}
            disabled={rescraping || !state.website || cooldownSec > 0}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              rescraping || !state.website || cooldownSec > 0
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-[#2E75B6] text-white hover:bg-[#1e5a8f] shadow-sm"
            }`}
          >
            {rescraping ? "Scanning..." : cooldownSec > 0 ? `Wait ${cooldownSec}s` : "Refresh from Website"}
          </button>
        </div>

        {state.website_scraped_at && (
          <p className="text-xs text-gray-400">
            Last scanned: {new Date(state.website_scraped_at).toLocaleString()}
          </p>
        )}

        {msg && (
          <div className={`mt-3 text-sm ${msg.type === "ok" ? "text-green-600" : msg.type === "cooldown" ? "text-amber-600" : "text-red-600"}`}>
            {msg.text}
          </div>
        )}
      </div>

      {hasScrape && (
        <div className="bg-white rounded-xl p-5 border border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">What We Found on Your Website</h3>
          <dl className="space-y-3">
            {data.business_name && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Business Name</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.business_name}</dd>
              </div>
            )}
            {data.tagline && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Tagline</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.tagline}</dd>
              </div>
            )}
            {data.phone && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Phone</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.phone}</dd>
              </div>
            )}
            {data.email && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Email</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.email}</dd>
              </div>
            )}
            {data.address && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Address</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.address}</dd>
              </div>
            )}
            {data.hours && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Hours</dt>
                <dd className="text-sm text-gray-900 mt-0.5">{data.hours}</dd>
              </div>
            )}
            {data.services && data.services.length > 0 && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Services Detected ({data.services.length})</dt>
                <dd className="text-sm text-gray-900 mt-0.5">
                  <ul className="list-disc pl-5 space-y-0.5">
                    {data.services.slice(0, 10).map((s: string, i: number) => <li key={i}>{s}</li>)}
                    {data.services.length > 10 && <li className="text-gray-400">... and {data.services.length - 10} more</li>}
                  </ul>
                </dd>
              </div>
            )}
            {data.pages_scraped && data.pages_scraped.length > 0 && (
              <div>
                <dt className="text-xs font-medium text-gray-500 uppercase">Pages Read</dt>
                <dd className="text-sm text-gray-900 mt-0.5">
                  {data.pages_scraped.length} page{data.pages_scraped.length === 1 ? "" : "s"}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {!hasScrape && state.website && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-800">
          No website data yet. Click "Refresh from Website" above to pull in your site content.
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState("business");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPlan, setCurrentPlan] = useState("starter");

  const [biz, setBiz] = useState({
    business_name: "",
    industry: "general",
    phone_number: "",
    address: "",
    website: "",
    timezone: "America/New_York",
    notification_email: "",
    notification_phone: "",
  });
  const [hours, setHours] = useState<DayHours[]>(parseBusinessHours(""));

  const [ai, setAi] = useState({
    agent_name: "Alex",
    voice: "professional_female",
    greeting_message: "",
    languages: ["en"] as string[],
    custom_instructions: "",
    hipaa_mode: false,
  });

  const [transfer, setTransfer] = useState({
    transfer_number: "",
    transfer_hours: "business_hours" as string,
    triggers: ["human_request", "emergency"] as string[],
    transfer_type: "warm" as string,
    fallback: "message" as string,
  });

  const [emotionConfig, setEmotionConfig] = useState({
    auto_detect: true,
    adjust_tone: true,
    auto_transfer_distressed: true,
    alert_frustrated: false,
    prioritize_frustrated: false,
  });

  const [coaching, setCoaching] = useState({
    enabled: false,
    coach_phone: "",
    triggers: ["price_objection", "competitor_mention", "ready_to_book", "frustrated", "long_call"] as string[],
  });

  const [notif, setNotif] = useState({
    email_after_call: true,
    daily_briefing_sms: true,
    hot_lead_alerts: true,
    weekly_report: false,
    monthly_billing_summary: false,
    benchmark_report: true,
    satisfaction_survey: true,
  });

  const [neverrPhone, setNeverrPhone] = useState("");
  // Phase 3g: gate the Sales Demos tab to admins/owners. The endpoint already
  // returns 403 for non-admins, but hiding the tab keeps the UI honest.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("neverr_token");
    if (!token) return;
    const activeBiz = localStorage.getItem("neverr_active_business_id");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (activeBiz) headers["X-Active-Business"] = activeBiz;
    fetch("/api/auth/me", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (d?.businesses || []) as Array<{ role?: string }>;
        const adminLike = list.some((b) => b.role === "owner" || b.role === "admin");
        setIsAdmin(adminLike);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const { businessId } = getAuth();
    apiFetch(`/business/configure?business_id=${businessId}`)
      .then((d) => {
        const c = d.config || {};
        let langs: string[] = c.languages || ["en"];
        if (typeof langs === "string") { try { langs = JSON.parse(langs); } catch { langs = ["en"]; } }
        if (!langs.includes("en")) langs = ["en", ...langs];
        if (c.spanish_enabled && !langs.includes("es")) langs.push("es");
        if (c.french_enabled && !langs.includes("fr")) langs.push("fr");

        setBiz({
          business_name: c.business_name || "",
          industry: c.industry || "general",
          phone_number: c.phone_number || "",
          address: c.address || "",
          website: c.website || "",
          timezone: c.timezone || "America/New_York",
          notification_email: c.notification_email || c.email || "",
          notification_phone: c.notification_phone || "",
        });
        setHours(parseBusinessHours(c.business_hours_detailed || c.structured_hours || c.business_hours || ""));
        setAi({
          agent_name: c.agent_name || "Alex",
          voice: c.voice || "professional_female",
          greeting_message: c.greeting_message || `Thank you for calling ${c.business_name || "our business"}! How can I help you today?`,
          languages: langs,
          custom_instructions: c.custom_instructions || "",
          hipaa_mode: c.hipaa_mode || false,
        });
        setNeverrPhone(c.neverr_phone || "");
        setCurrentPlan(c.plan || "starter");

        let tc = c.transfer_config || {};
        if (typeof tc === "string") { try { tc = JSON.parse(tc); } catch { tc = {}; } }
        setTransfer({
          transfer_number: tc.transfer_number || "",
          transfer_hours: tc.transfer_hours || "business_hours",
          triggers: tc.triggers || ["human_request", "emergency"],
          transfer_type: tc.transfer_type || "warm",
          fallback: tc.fallback || "message",
        });

        let ec = c.emotion_config || {};
        if (typeof ec === "string") { try { ec = JSON.parse(ec); } catch { ec = {}; } }
        setEmotionConfig({
          auto_detect: ec.auto_detect !== false,
          adjust_tone: ec.adjust_tone !== false,
          auto_transfer_distressed: ec.auto_transfer_distressed !== false,
          alert_frustrated: ec.alert_frustrated || false,
          prioritize_frustrated: ec.prioritize_frustrated || false,
        });

        let cc = c.coaching_config || {};
        if (typeof cc === "string") { try { cc = JSON.parse(cc); } catch { cc = {}; } }
        setCoaching({
          enabled: cc.enabled || false,
          coach_phone: cc.coach_phone || "",
          triggers: cc.triggers || ["price_objection", "competitor_mention", "ready_to_book", "frustrated", "long_call"],
        });

        let notifData = c.notifications || {};
        if (typeof notifData === "string") { try { notifData = JSON.parse(notifData); } catch { notifData = {}; } }
        setNotif({
          email_after_call: notifData.email_after_call !== false,
          daily_briefing_sms: notifData.daily_briefing_sms !== false,
          hot_lead_alerts: notifData.hot_lead_alerts !== false,
          weekly_report: notifData.weekly_report || false,
          monthly_billing_summary: notifData.monthly_billing_summary || false,
          benchmark_report: notifData.benchmark_report !== false,
          satisfaction_survey: notifData.satisfaction_survey !== false,
        });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const saveConfig = async (data: any) => {
    setSaving(true);
    setError(null);
    try {
      const { businessId } = getAuth();
      await apiFetch("/business/configure", {
        method: "POST",
        body: JSON.stringify({ ...data, business_id: businessId }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e.message || "Failed to save");
      setTimeout(() => setError(null), 5000);
    }
    setSaving(false);
  };

  const saveBiz = () => saveConfig({
    ...biz,
    business_hours_detailed: hours,
    business_hours: JSON.stringify(hours),
  });

  const saveAi = async () => {
    const { businessId } = getAuth();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...ai,
        business_id: businessId,
        spanish_enabled: ai.languages.includes("es"),
        french_enabled: ai.languages.includes("fr"),
        transfer_config: transfer,
        emotion_config: emotionConfig,
        coaching_config: coaching,
      };
      try {
        await apiFetch(`/business/${businessId}/agent`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } catch {}
      await apiFetch("/business/configure", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e.message || "Failed to save AI settings");
      setTimeout(() => setError(null), 5000);
    }
    setSaving(false);
  };

  const saveNotif = () => saveConfig({ notifications: notif });

  const tabs = [
    { id: "business", label: "Business Profile", icon: Building2 },
    { id: "ai", label: "AI Receptionist", icon: Bot },
    { id: "callback", label: t("nav.callbackNumber"), icon: PhoneCall },
    { id: "website", label: "Website", icon: Globe },
    { id: "phone", label: "Phone Setup", icon: Phone },
    { id: "locations", label: "Locations", icon: MapPin },
    { id: "integrations", label: "Integrations", icon: Plug },
    { id: "team", label: "Team", icon: Users },
    { id: "security", label: "Security", icon: Shield },
    { id: "billing", label: "Billing", icon: CreditCard },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "objections", label: "Objection Handlers", icon: Brain },
    { id: "competitors", label: "Competitors", icon: Swords },
    { id: "widget", label: "Website Widget", icon: Code2 },
    { id: "sms_optin", label: "SMS Opt-In", icon: MessageSquare },
    // Phase 3g: Sales Demos tab — admin/owner only.
    ...(isAdmin ? [{ id: "sales_demos", label: "Sales Demos", icon: Sparkles }] : []),
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Configure your AI receptionist and business preferences</p>
        </div>
        {saved && (
          <span className="flex items-center gap-2 text-sm font-medium text-green-600">
            <CheckCircle className="w-4 h-4" /> Saved!
          </span>
        )}
        {error && (
          <span className="flex items-center gap-2 text-sm font-medium text-red-600">
            <AlertTriangle className="w-4 h-4" /> {error}
          </span>
        )}
      </div>

      <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all whitespace-nowrap ${
                tab === t.id
                  ? "bg-[#2E75B6] text-white shadow-md"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl border border-gray-200 p-6">

        {tab === "business" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Business Name</label>
                <input
                  value={biz.business_name}
                  onChange={(e) => setBiz({ ...biz, business_name: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Industry</label>
                <select
                  value={biz.industry}
                  onChange={(e) => setBiz({ ...biz, industry: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                >
                  <option value="general">General Business</option>
                  {INDUSTRY_GROUPS.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.items.map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Business Phone</label>
                <input
                  value={biz.phone_number}
                  onChange={(e) => setBiz({ ...biz, phone_number: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="+1 555 000 0000"
                />
                <p className="text-xs text-gray-400 mt-1">This is the number callers dial. Forward it to your Neverr number.</p>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Website</label>
                <input
                  type="url"
                  value={biz.website}
                  onChange={(e) => setBiz({ ...biz, website: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="https://yourbusiness.com"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 mb-1.5 block">Business Address</label>
              <input
                value={biz.address}
                onChange={(e) => setBiz({ ...biz, address: e.target.value })}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                placeholder="123 Main St, City, State ZIP"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Timezone</label>
                <select
                  value={biz.timezone}
                  onChange={(e) => setBiz({ ...biz, timezone: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                >
                  {TIMEZONES.map((tz) => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 mb-2 block">Business Hours</label>
              <BusinessHoursEditor hours={hours} onChange={setHours} />
            </div>

            <hr className="border-gray-200" />

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Notification Email</label>
                <input
                  type="email"
                  value={biz.notification_email}
                  onChange={(e) => setBiz({ ...biz, notification_email: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="owner@yourbusiness.com"
                />
                <p className="text-xs text-gray-400 mt-1">Where call summaries are sent</p>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Notification Phone</label>
                <input
                  value={biz.notification_phone}
                  onChange={(e) => setBiz({ ...biz, notification_phone: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="+1 555 000 0000"
                />
                <p className="text-xs text-gray-400 mt-1">Where daily briefing SMS is sent</p>
                <p className="text-xs text-[#64748B] leading-relaxed mt-2">By saving your phone number, you agree to receive service notifications and SMS alerts from Neverr.ai. Reply STOP to unsubscribe at any time.</p>
              </div>
            </div>

            <button
              onClick={saveBiz}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
            >
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Business Profile"}
            </button>
          </div>
        )}

        {tab === "ai" && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Agent Name</label>
                <input
                  value={ai.agent_name}
                  onChange={(e) => setAi({ ...ai, agent_name: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  placeholder="Alex"
                />
                <p className="text-xs text-gray-400 mt-1">What your AI calls itself on calls</p>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1.5 block">Voice</label>
                <select
                  value={ai.voice}
                  onChange={(e) => setAi({ ...ai, voice: e.target.value })}
                  className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                >
                  {VOICES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 mb-1.5 block">Greeting Message</label>
              <textarea
                value={ai.greeting_message}
                onChange={(e) => setAi({ ...ai, greeting_message: e.target.value })}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm h-24 resize-none focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                placeholder="Thank you for calling..."
              />
              {ai.greeting_message && (
                <div className="mt-2 p-3 bg-blue-50 rounded-xl border border-blue-100">
                  <p className="text-xs text-gray-500 mb-1">Preview:</p>
                  <p className="text-sm text-gray-800 italic">"{ai.greeting_message}"</p>
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2 mb-3">
                <Globe className="w-4 h-4 text-gray-700" />
                <label className="text-xs font-medium text-gray-700">Languages ({ai.languages.filter(l => l !== "en").length} additional enabled)</label>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-4 pr-1">
                {LANGUAGE_REGIONS.map((region) => (
                  <div key={region.region}>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{region.region}</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {region.langs.map((lang: any) => {
                        const enabled = lang.code === "en" || ai.languages.includes(lang.code);
                        return (
                          <label
                            key={lang.code}
                            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-all text-sm ${
                              enabled ? "bg-[#2E75B6]/10 border border-[#2E75B6]/30" : "bg-gray-50 border border-gray-100 hover:bg-gray-100"
                            } ${lang.locked ? "opacity-80 cursor-default" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={enabled}
                              disabled={lang.locked}
                              onChange={() => {
                                if (lang.locked) return;
                                const langs = ai.languages.includes(lang.code)
                                  ? ai.languages.filter((l: string) => l !== lang.code)
                                  : [...ai.languages, lang.code];
                                setAi({ ...ai, languages: langs });
                              }}
                              className="w-3.5 h-3.5 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                            />
                            <span className="text-base leading-none">{lang.flag}</span>
                            <span className="text-xs font-medium text-gray-900">{lang.name}</span>
                            <span className="text-[10px] text-gray-400 ml-auto">({lang.native})</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-xl border border-emerald-100">
              <div className="flex items-center gap-2 mb-2">
                <Globe className="w-4 h-4 text-emerald-600" />
                <p className="text-sm font-semibold text-gray-900">Cultural Intelligence: Active</p>
                <span className="ml-auto inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">AUTO</span>
              </div>
              <p className="text-xs text-gray-600 leading-relaxed">
                Neverr automatically adapts communication style for <strong>16 cultural profiles</strong> across{" "}
                <strong>8 languages</strong>. When a caller speaks in a non-English language, the AI detects the language
                variant and adjusts formality, pace, directness, and greeting style to match cultural expectations.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[
                  { flag: "🇺🇸", label: "English" },
                  { flag: "🇲🇽", label: "Spanish (MX)" },
                  { flag: "🇨🇴", label: "Spanish (CO)" },
                  { flag: "🇪🇬", label: "Arabic (EG)" },
                  { flag: "🇸🇦", label: "Arabic (SA)" },
                  { flag: "🇫🇷", label: "French" },
                  { flag: "🇧🇷", label: "Portuguese (BR)" },
                  { flag: "🇨🇳", label: "Chinese" },
                  { flag: "🇮🇳", label: "Hindi" },
                  { flag: "🇰🇷", label: "Korean" },
                ].map((l) => (
                  <span key={l.label} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/80 rounded text-[10px] text-gray-600 border border-emerald-100">
                    <span>{l.flag}</span> {l.label}
                  </span>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-gray-700 mb-1.5 block">Custom Instructions</label>
              <textarea
                value={ai.custom_instructions}
                onChange={(e) => setAi({ ...ai, custom_instructions: e.target.value })}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                placeholder='e.g. "Always mention our free consultation", "Never quote prices over the phone"'
              />
              <p className="text-xs text-gray-400 mt-1">Special instructions for how the AI should handle calls</p>
            </div>

            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
              <div>
                <p className="text-sm font-medium text-gray-900">HIPAA Mode</p>
                <p className="text-xs text-gray-500 mt-0.5">Enable for healthcare businesses. Limits data the AI collects and stores.</p>
              </div>
              <Toggle checked={ai.hipaa_mode} onChange={(v) => setAi({ ...ai, hipaa_mode: v })} />
            </div>

            <div className="border-t border-gray-200 pt-5">
              <div className="flex items-center gap-2 mb-4">
                <PhoneForwarded className="w-5 h-5 text-[#2E75B6]" />
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Call Transfer</h3>
                  <p className="text-xs text-gray-500">Transfer calls to a live person when needed</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1.5 block">Transfer Phone Number</label>
                  <input
                    value={transfer.transfer_number}
                    onChange={(e) => setTransfer({ ...transfer, transfer_number: e.target.value })}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    placeholder="+1 (555) 123-4567"
                  />
                  <p className="text-xs text-gray-400 mt-1">Your cell phone, office line, or any number you want calls transferred to</p>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1.5 block flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" /> Transfer Hours
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: "always", label: "Always (24/7)" },
                      { value: "business_hours", label: "Business Hours Only" },
                      { value: "never", label: "Never (AI Only)" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setTransfer({ ...transfer, transfer_hours: opt.value })}
                        className={`px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
                          transfer.transfer_hours === opt.value
                            ? "bg-[#2E75B6] text-white border-[#2E75B6]"
                            : "bg-white text-gray-700 border-gray-200 hover:border-[#2E75B6]/30"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-700 mb-2 block">Transfer Triggers</label>
                  <div className="space-y-1.5">
                    {[
                      { value: "human_request", label: "When caller asks for a human", desc: '"speak to a person", "operator", "transfer me"', plan: "all" },
                      { value: "emergency", label: "Emergency situations", desc: '"emergency", "urgent", "911"', plan: "all" },
                      { value: "hot_lead", label: "Hot leads (immediate transfer)", desc: "Transfer high-value leads instantly", plan: "professional" },
                      { value: "timeout", label: "After 3 minutes of conversation", desc: "Auto-transfer if AI can't resolve", plan: "professional" },
                      { value: "vip", label: "VIP / returning callers", desc: "Transfer known important contacts", plan: "professional" },
                    ].map((trigger) => {
                      const locked = trigger.plan === "professional" && !["professional", "growth", "business", "enterprise"].includes(currentPlan);
                      const checked = transfer.triggers.includes(trigger.value);
                      return (
                        <label
                          key={trigger.value}
                          className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                            checked ? "bg-[#2E75B6]/5 border border-[#2E75B6]/20" : "bg-gray-50 border border-gray-100 hover:bg-gray-100"
                          } ${locked ? "opacity-60 cursor-default" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked}
                            onChange={() => {
                              if (locked) return;
                              const triggers = checked
                                ? transfer.triggers.filter((t) => t !== trigger.value)
                                : [...transfer.triggers, trigger.value];
                              setTransfer({ ...transfer, triggers });
                            }}
                            className="w-4 h-4 mt-0.5 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{trigger.label}</span>
                              {locked && (
                                <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full font-medium">Professional+</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">{trigger.desc}</p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1.5 block flex items-center gap-1.5">
                    <ArrowRightLeft className="w-3.5 h-3.5" /> Transfer Type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: "warm", label: "Warm Transfer", desc: "AI announces caller" },
                      { value: "cold", label: "Cold Transfer", desc: "Direct connect" },
                      { value: "sms_alert", label: "Transfer + SMS", desc: "SMS alert sent" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setTransfer({ ...transfer, transfer_type: opt.value })}
                        className={`px-3 py-2.5 rounded-xl text-left border transition-all ${
                          transfer.transfer_type === opt.value
                            ? "bg-[#2E75B6] text-white border-[#2E75B6]"
                            : "bg-white text-gray-700 border-gray-200 hover:border-[#2E75B6]/30"
                        }`}
                      >
                        <p className="text-xs font-medium">{opt.label}</p>
                        <p className={`text-[10px] mt-0.5 ${transfer.transfer_type === opt.value ? "text-blue-100" : "text-gray-400"}`}>{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1.5 block">If No Answer</label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { value: "message", label: "Take a Message" },
                      { value: "callback", label: "Book Callback" },
                      { value: "ai", label: "Return to AI" },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setTransfer({ ...transfer, fallback: opt.value })}
                        className={`px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
                          transfer.fallback === opt.value
                            ? "bg-[#2E75B6] text-white border-[#2E75B6]"
                            : "bg-white text-gray-700 border-gray-200 hover:border-[#2E75B6]/30"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-gray-200 pt-5">
              <div className="flex items-center gap-2 mb-4">
                <Headphones className="w-5 h-5 text-[#2E75B6]" />
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">Live Call Coaching</h3>
                  <p className="text-xs text-gray-500">Send real-time SMS tips to your team during transferred calls</p>
                </div>
              </div>

              {!["enterprise"].includes(currentPlan) ? (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Lock className="w-4 h-4 text-amber-600" />
                    <p className="text-sm font-medium text-amber-800">Enterprise Feature</p>
                  </div>
                  <p className="text-xs text-amber-700">Live Call Coaching is available on the Enterprise plan. Upgrade to coach your team in real time during calls.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                    <div>
                      <p className="text-sm font-medium text-gray-900">Enable Live Coaching</p>
                      <p className="text-xs text-gray-500 mt-0.5">When a call is warm-transferred, the AI monitors the conversation and sends coaching tips via SMS</p>
                    </div>
                    <Toggle checked={coaching.enabled} onChange={(v) => setCoaching({ ...coaching, enabled: v })} />
                  </div>

                  {coaching.enabled && (
                    <>
                      <div>
                        <label className="text-xs font-medium text-gray-700 mb-1.5 block">Coach SMS Number</label>
                        <input
                          value={coaching.coach_phone}
                          onChange={(e) => setCoaching({ ...coaching, coach_phone: e.target.value })}
                          className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                          placeholder="+1 (555) 123-4567"
                        />
                        <p className="text-xs text-gray-400 mt-1">Where should coaching tips be sent during calls?</p>
                      </div>

                      <div>
                        <label className="text-xs font-medium text-gray-700 mb-2 block">Coaching Triggers</label>
                        <div className="space-y-1.5">
                          {[
                            { key: "price_objection", label: "Price objections detected", desc: "Tips when callers push back on pricing" },
                            { key: "competitor_mention", label: "Competitor mentions", desc: "Counter-scripts when competitors come up" },
                            { key: "ready_to_book", label: "Caller ready to book", desc: "Prompt to close when buying signals detected" },
                            { key: "frustrated", label: "Caller frustration", desc: "De-escalation tips when frustration detected" },
                            { key: "long_call", label: "Call exceeds 5 minutes", desc: "Check-in tips for long conversations" },
                            { key: "silence", label: "Silence over 10 seconds", desc: "Prompts when dead air is detected (requires Twilio real-time audio)" },
                          ].map((trigger) => (
                            <label key={trigger.key} className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={coaching.triggers.includes(trigger.key)}
                                onChange={(e) => {
                                  const next = e.target.checked
                                    ? [...coaching.triggers, trigger.key]
                                    : coaching.triggers.filter(t => t !== trigger.key);
                                  setCoaching({ ...coaching, triggers: next });
                                }}
                                className="rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                              />
                              <div>
                                <p className="text-sm font-medium text-gray-900">{trigger.label}</p>
                                <p className="text-xs text-gray-500">{trigger.desc}</p>
                              </div>
                            </label>
                          ))}
                        </div>
                      </div>

                      <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                        <p className="text-xs text-blue-700">
                          <span className="font-medium">How it works:</span> When a call is warm-transferred to your team, the AI continues listening and sends coaching tips via SMS. Tips are rate-limited to 1 per trigger type every 60 seconds.
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={saveAi}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
            >
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save AI Settings"}
            </button>
          </div>
        )}

        {tab === "callback" && (
          <Link
            href="/settings/callback"
            className="flex items-center gap-4 p-5 border border-gray-200 rounded-2xl hover:border-[#2E75B6]/40 hover:bg-[#2E75B6]/5 transition-all group"
          >
            <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center flex-shrink-0">
              <PhoneCall className="w-5 h-5 text-[#2E75B6]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-base font-semibold text-gray-900 mb-0.5">{t("nav.callbackNumber")}</h3>
              <p className="text-sm text-gray-500">
                Set which phone rings when a staff member clicks <span className="font-medium text-gray-700">Call customer</span> on a lead.
              </p>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-[#2E75B6] flex-shrink-0" />
          </Link>
        )}

        {tab === "phone" && <PhoneSetupTab neverrPhone={neverrPhone} />}

        {tab === "locations" && <LocationsTab plan={currentPlan} />}

        {tab === "integrations" && <IntegrationsTab />}

        {tab === "security" && <SecurityTab />}

        {tab === "billing" && <BillingTab />}

        {tab === "objections" && <ObjectionHandlersTab industry={biz.industry} />}

        {tab === "competitors" && <CompetitorsTab />}

        {tab === "widget" && <WidgetTab />}

        {tab === "sms_optin" && (() => {
          // biz.business_id isn't part of the form-state shape (only the
          // editable fields are), so it's undefined on first render. Fall
          // back to the BusinessSwitcher's active id (Phase 3e.2 key).
          const activeBizId = (biz as any)?.business_id || localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "";
          if (!activeBizId) {
            return (
              <div className="p-6 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                Loading business context… If this persists, try selecting a business from the switcher.
              </div>
            );
          }
          return <SmsOptInTab businessId={activeBizId} />;
        })()}

        {tab === "team" && <TeamTab />}

        {tab === "sales_demos" && isAdmin && <SalesDemosTab />}

        {tab === "website" && <WebsiteTab businessId={localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || ""} />}

        {tab === "notifications" && (
          <div className="space-y-5">
            <div>
              <h3 className="text-base font-semibold text-gray-900 mb-1">Notification Preferences</h3>
              <p className="text-sm text-gray-500">Choose which notifications you'd like to receive.</p>
            </div>

            <div className="space-y-1">
              {[
                { key: "email_after_call", label: "Email summary after every call", desc: "Receive a detailed email with transcript and caller info after each call" },
                { key: "daily_briefing_sms", label: "Daily briefing SMS (sent at 8am)", desc: "A morning summary of yesterday's calls, leads, and appointments" },
                { key: "hot_lead_alerts", label: "Hot lead alerts (immediate SMS)", desc: "Get an instant text when a high-value lead calls your business" },
                { key: "weekly_report", label: "Weekly performance report email", desc: "A weekly digest with call stats, trends, and AI performance metrics" },
                { key: "monthly_billing_summary", label: "Monthly billing summary", desc: "An email summary of your monthly usage and billing details" },
                { key: "benchmark_report", label: "Monthly benchmark report", desc: "Receive a monthly report comparing your performance to industry peers" },
                { key: "satisfaction_survey", label: "Post-call satisfaction survey", desc: "Send 1-5 rating request via SMS after each call (only for calls over 60 seconds, max 1 per caller per week)" },
              ].map((item) => (
                <div key={item.key} className="flex items-center justify-between p-4 rounded-xl hover:bg-gray-50 transition-colors">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{item.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                  </div>
                  <Toggle
                    checked={(notif as any)[item.key]}
                    onChange={(v) => setNotif({ ...notif, [item.key]: v })}
                  />
                </div>
              ))}
            </div>

            <button
              onClick={saveNotif}
              disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 shadow-md shadow-[#2E75B6]/20"
            >
              <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Notification Settings"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function WidgetTab() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [analytics, setAnalytics] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [color, setColor] = useState("#2E75B6");
  const [position, setPosition] = useState<"bottom-right" | "bottom-left">("bottom-right");
  const [delay, setDelay] = useState(3);
  const [greeting, setGreeting] = useState("");
  const [enabled, setEnabled] = useState(true);

  const businessId = localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "";
  const token = localStorage.getItem("neverr_token") || "";
  const apiBase = window.location.origin;
  const widgetSrc = `${apiBase}/widget.js`;

  const embedCode = `<script src="${widgetSrc}" data-business="${businessId}" data-color="${color}"></script>`;

  async function load() {
    setLoading(true);
    try {
      const [s, a] = await Promise.all([
        fetch(`/api/widget/status`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
        fetch(`/api/widget/analytics/${businessId}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      setStatus(s);
      setAnalytics(a);
      if (s?.config) {
        setColor(s.config.color || "#2E75B6");
        setPosition(s.config.position || "bottom-right");
        setDelay(s.config.delay_seconds ?? 3);
        setGreeting(s.config.greeting || "");
        setEnabled(s.config.enabled !== false);
      }
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/widget/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ color, position, delay_seconds: delay, greeting, enabled }),
      });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function startCheckout() {
    const email = localStorage.getItem("neverr_user_email") || "";
    // Sprint 1 BUG-17 sub-step 3b: /api/stripe/create-checkout-session
    // now requires auth. SettingsPage already has `token` in scope from
    // the WidgetTab closure (line ~77) — pass it through so this button
    // doesn't 401 after the security cleanup.
    const r = await fetch(`/api/stripe/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ planId: "growth", billingCycle: "monthly", businessId, email }),
    });
    const j = await r.json();
    if (j.url) window.location.href = j.url;
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" /></div>;
  }

  const eligible = status?.eligibleByPlan || status?.addonPurchased;

  if (!eligible) {
    return (
      <div className="max-w-2xl">
        <div className="rounded-2xl border-2 border-dashed border-[#2E75B6]/30 bg-gradient-to-br from-blue-50 to-white p-8 text-center">
          <div className="w-14 h-14 rounded-2xl bg-[#1B2537] text-white flex items-center justify-center mx-auto mb-4">
            <Code2 className="w-7 h-7" />
          </div>
          <h3 className="text-xl font-bold text-gray-900 mb-2">Add the Website Widget to your plan</h3>
          <p className="text-sm text-gray-600 mb-6 max-w-md mx-auto">
            Let website visitors talk to your AI receptionist directly on your site. Capture leads, book appointments, and answer FAQs 24/7.
          </p>
          <ul className="text-left text-sm text-gray-700 space-y-2 mb-6 max-w-sm mx-auto">
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600" /> Floating button on any website</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600" /> Custom branding & color</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600" /> Lead capture with SMS alerts</li>
            <li className="flex items-center gap-2"><Check className="w-4 h-4 text-emerald-600" /> Full analytics dashboard</li>
          </ul>
          <button onClick={startCheckout} className="inline-flex items-center gap-2 px-6 py-3 bg-[#2E75B6] text-white rounded-xl font-semibold hover:bg-[#2563a0] shadow-md">
            <Sparkles className="w-4 h-4" /> Add Widget — $79/mo
          </button>
          <p className="text-xs text-gray-400 mt-3">Included free with Growth plan and above</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">Website Widget</h3>
          <p className="text-sm text-gray-500">Let website visitors talk to your AI receptionist directly on your website</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${enabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
          <span className={`w-2 h-2 rounded-full ${enabled ? "bg-emerald-500" : "bg-gray-400"}`} /> {enabled ? "Active" : "Disabled"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="text-xs font-medium text-gray-700 mb-1.5 block">Widget color</label>
          <div className="flex items-center gap-2">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-12 h-10 border border-gray-200 rounded-lg cursor-pointer" />
            <input value={color} onChange={(e) => setColor(e.target.value)} className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm font-mono" />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 mb-1.5 block">Position</label>
          <div className="flex gap-2">
            {(["bottom-right", "bottom-left"] as const).map(p => (
              <button key={p} onClick={() => setPosition(p)} className={`flex-1 px-3 py-2 text-sm rounded-xl border ${position === p ? "border-[#2E75B6] bg-[#2E75B6]/10 text-[#1B2537] font-semibold" : "border-gray-200 text-gray-600"}`}>
                {p === "bottom-right" ? "Bottom Right" : "Bottom Left"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-700 mb-1.5 block">Show after (seconds)</label>
          <input type="number" min={0} max={60} value={delay} onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
        </div>
        <div className="flex items-end">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4" />
            Widget enabled
          </label>
        </div>
        <div className="col-span-2">
          <label className="text-xs font-medium text-gray-700 mb-1.5 block">Greeting message (leave blank to use default)</label>
          <input value={greeting} onChange={(e) => setGreeting(e.target.value)} placeholder="Hi! I'm Nova from Neverr. How can I help you today?" className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm" />
        </div>
      </div>

      <button onClick={save} disabled={saving} className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50">
        <Save className="w-4 h-4" /> {saving ? "Saving..." : "Save Widget Settings"}
      </button>

      <div className="bg-gray-900 rounded-2xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold text-white flex items-center gap-2"><Code2 className="w-4 h-4" /> Embed code</h4>
          <div className="flex gap-2">
            <button onClick={() => { navigator.clipboard.writeText(embedCode); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg">
              {copied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy code</>}
            </button>
            <a href={widgetSrc + "?test=1"} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold rounded-lg">
              <ExternalLink className="w-3.5 h-3.5" /> Test
            </a>
          </div>
        </div>
        <pre className="text-xs text-emerald-400 font-mono whitespace-pre-wrap break-all leading-relaxed">{embedCode}</pre>
        <p className="text-[11px] text-gray-400 mt-3">Paste this into your website's HTML, just before the closing &lt;/body&gt; tag.</p>
      </div>

      {analytics && (
        <div>
          <h4 className="text-sm font-semibold text-gray-900 mb-3">Last 30 days</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Widget opens", value: analytics.opens || 0 },
              { label: "Conversations", value: analytics.conversations || 0 },
              { label: "Leads captured", value: analytics.leads || 0 },
              { label: "Bookings", value: analytics.bookings || 0 },
            ].map(s => (
              <div key={s.label} className="bg-white border border-gray-200 rounded-xl p-3">
                <p className="text-2xl font-bold text-[#1B2537]">{s.value}</p>
                <p className="text-xs text-gray-500">{s.label}</p>
              </div>
            ))}
          </div>
          {analytics.avgDuration > 0 && (
            <p className="text-xs text-gray-500 mt-2">Average conversation: {Math.floor(analytics.avgDuration / 60)}m {analytics.avgDuration % 60}s</p>
          )}
        </div>
      )}
    </div>
  );
}

type TeamMember = {
  userId: string;
  email: string;
  // Slice 3: nullable until the (small) legacy user set is backfilled.
  // Frontend renders "${firstName} ${lastName}" when both are set; falls
  // back to email local-part otherwise.
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  joinedAt: string;
  permissions?: any;
};

// Render the most human-readable display name for a member, with a
// graceful fallback chain for accounts that signed up before Slice 3
// captured first_name + last_name.
function memberDisplayName(m: TeamMember): string {
  const first = m.firstName?.trim();
  const last = m.lastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  // Email local-part (lowercased, before the @) — not pretty, but
  // identifiable. Preferable to a literal "undefined undefined".
  const local = (m.email || "").split("@")[0];
  return local || "Team member";
}

type Organization = {
  name: string;
  maxUsers: number;
  currentUsers: number;
};

const UI_ROLES = [
  { value: "admin", label: "Admin", description: "Manage settings, invite members" },
  { value: "manager", label: "Manager", description: "Manage day-to-day operations" },
  { value: "user", label: "Member", description: "View dashboard, take calls" },
];

const ROLE_LABEL_MAP: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  team_lead: "Team Lead",
  agent_manager: "Agent Manager",
  analyst: "Analyst",
  user: "Member",
  readonly: "Viewer",
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  owner: "bg-violet-100 text-violet-700 ring-1 ring-violet-200",
  admin: "bg-blue-100 text-blue-700 ring-1 ring-blue-200",
  manager: "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200",
  user: "bg-slate-100 text-slate-700 ring-1 ring-slate-200",
};

function TeamTab() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Caller's role in the active business — null until /user/businesses resolves.
  // Drives whether the invite form and per-row admin actions are visible at all.
  // Backend still authoritatively rejects writes from non-admins; this just
  // hides controls the caller can't successfully use so the UX isn't misleading.
  const [myRole, setMyRole] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("user");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [actionUserId, setActionUserId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null);

  const token = localStorage.getItem("neverr_token");
  // Phase 3e multi-business: include the active-business pointer so this
  // tab always operates on the tenant the BusinessSwitcher selected.
  const activeBusinessId = localStorage.getItem("neverr_active_business_id") || "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (activeBusinessId) headers["X-Active-Business"] = activeBusinessId;

  const canManageTeam = myRole === "owner" || myRole === "admin";

  async function load() {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      // Resolve caller's role in the active business in parallel with the
      // member list so we can correctly gate the management UI on first paint.
      const [membersRes, bizRes] = await Promise.all([
        fetch(`${API}/admin/team/members`, { headers }),
        fetch(`${API}/user/businesses`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null),
      ]);

      if (bizRes && bizRes.ok) {
        const bd = await bizRes.json();
        const list = (bd?.businesses || []) as Array<{ business_id: string; role: string; is_active: boolean }>;
        const active = list.find((b) => b.is_active) || list[0];
        if (active?.role) setMyRole(active.role);
      }

      if (membersRes.status === 403) {
        setForbidden(true);
        setLoading(false);
        return;
      }
      const d = await membersRes.json();
      if (!membersRes.ok) {
        setError(d.error || `Failed to load (HTTP ${membersRes.status})`);
      } else {
        setMembers(d.members || []);
        setOrganization(d.organization || null);
      }
    } catch (e: any) {
      setError(e.message || "Network error");
    }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleInvite() {
    if (!inviteEmail.trim() || !inviteEmail.includes("@")) {
      setInviteMsg({ type: "err", text: "Valid email required" });
      return;
    }
    setInviting(true);
    setInviteMsg(null);
    try {
      const r = await fetch(`${API}/admin/team/invite`, {
        method: "POST",
        headers,
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const d = await r.json();
      if (!r.ok) {
        setInviteMsg({ type: "err", text: d.error || `Failed (HTTP ${r.status})` });
      } else {
        setInviteMsg({
          type: "ok",
          text: d.user?.emailDelivered
            ? `Invitation sent to ${inviteEmail}`
            : `Invitation created — email delivery may have failed. Token: ${d.user?.inviteToken || "(check email)"}`,
        });
        setInviteEmail("");
        setInviteRole("user");
        await load();
      }
    } catch (e: any) {
      setInviteMsg({ type: "err", text: e.message || "Network error" });
    }
    setInviting(false);
  }

  async function handleRoleChange(userId: string, newRole: string) {
    setActionUserId(userId);
    try {
      const r = await fetch(`${API}/admin/team/members/${userId}/role`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ role: newRole }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.error || `Role change failed (HTTP ${r.status})`);
      } else {
        await load();
      }
    } catch (e: any) {
      alert(e.message);
    }
    setActionUserId(null);
  }

  async function handleRemove(member: TeamMember) {
    setActionUserId(member.userId);
    try {
      const r = await fetch(`${API}/admin/team/members/${member.userId}`, {
        method: "DELETE",
        headers,
      });
      const d = await r.json();
      if (!r.ok) {
        alert(d.error || `Removal failed (HTTP ${r.status})`);
      } else {
        await load();
      }
    } catch (e: any) {
      alert(e.message);
    }
    setActionUserId(null);
    setConfirmRemove(null);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
        You don't have permission to view team members for this business. Ask
        an owner or admin to grant you access.
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-1">Team Members</h2>
        <p className="text-sm text-slate-500">
          {organization
            ? `${organization.currentUsers} of ${organization.maxUsers} seats used in ${organization.name}`
            : "Manage who has access to this business"}
        </p>
      </div>

      {!canManageTeam && (
        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
          You're viewing the team in read-only mode. Only owners and admins can
          invite, remove, or change roles.
        </div>
      )}

      {canManageTeam && (
      <div className="bg-gray-50 rounded-xl p-5 border border-gray-200">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">Invite Team Member</h3>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-start">
          <input
            type="email"
            placeholder="colleague@example.com"
            className="md:col-span-6 p-2.5 border border-slate-300 rounded-lg text-sm"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            disabled={inviting}
          />
          <select
            className="md:col-span-3 p-2.5 border border-slate-300 rounded-lg text-sm bg-white"
            value={inviteRole}
            onChange={e => setInviteRole(e.target.value)}
            disabled={inviting}
          >
            {UI_ROLES.map(r => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <button
            onClick={handleInvite}
            disabled={inviting || !inviteEmail.trim()}
            className="md:col-span-3 px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg text-sm font-semibold hover:bg-[#1e5a8f] disabled:opacity-50"
          >
            {inviting ? "Sending..." : "Send Invitation"}
          </button>
        </div>
        {inviteMsg && (
          <div className={`mt-3 text-sm ${inviteMsg.type === "ok" ? "text-emerald-700" : "text-red-700"}`}>
            {inviteMsg.text}
          </div>
        )}
        <p className="text-xs text-slate-500 mt-3">
          Invitees receive an email with a link to set their password. Invitations expire in 7 days.
        </p>
      </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-semibold text-slate-700 text-xs uppercase tracking-wide">Member</th>
              <th className="text-left px-4 py-3 font-semibold text-slate-700 text-xs uppercase tracking-wide">Role</th>
              <th className="text-left px-4 py-3 font-semibold text-slate-700 text-xs uppercase tracking-wide">Joined</th>
              <th className="text-right px-4 py-3 font-semibold text-slate-700 text-xs uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.userId} className="border-b border-gray-100 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{memberDisplayName(m)}</div>
                  {m.email && (m.firstName || m.lastName) && (
                    <div className="text-xs text-slate-500 mt-0.5">{m.email}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-[10px] uppercase font-semibold tracking-wide px-2 py-0.5 rounded ${ROLE_BADGE_STYLES[m.role] || ROLE_BADGE_STYLES.user}`}>
                    {ROLE_LABEL_MAP[m.role] || m.role}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-500 text-xs">
                  {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  {!canManageTeam ? (
                    <span className="text-xs text-slate-400">—</span>
                  ) : m.role === "owner" ? (
                    <span className="text-xs text-slate-400 italic">No actions</span>
                  ) : (
                    <div className="inline-flex items-center gap-2">
                      <select
                        defaultValue={m.role}
                        onChange={e => handleRoleChange(m.userId, e.target.value)}
                        disabled={actionUserId === m.userId}
                        className="text-xs p-1 border border-slate-300 rounded"
                      >
                        {UI_ROLES.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => setConfirmRemove(m)}
                        disabled={actionUserId === m.userId}
                        className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {members.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-400 text-sm">
                  No team members yet. Invite your first colleague above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {confirmRemove && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setConfirmRemove(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Remove team member?</h3>
            <p className="text-sm text-slate-600 mb-5">
              <strong>{memberDisplayName(confirmRemove)}</strong> ({confirmRemove.email}) will lose access to this business immediately.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmRemove(null)}
                className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemove(confirmRemove)}
                disabled={actionUserId === confirmRemove.userId}
                className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50"
              >
                {actionUserId === confirmRemove.userId ? "Removing..." : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Phase 3f: SMS opt-in settings tab
// ────────────────────────────────────────────────────────────────────────
//
// Two responsibilities:
//   1. Display the public opt-in URL + iframe embed snippet so the
//      business can share / embed the form on their own site.
//   2. Let owners/admins customize the brand display copy + Twilio-required
//      consent blurbs that appear on that page.
// Read access is "member" (any role can view URL + see current copy);
// writes require admin (mirrors the backend gate in canAccessBusinessForOptin).

type SmsOptInSettings = {
  brand_display_name?: string;
  campaign_description?: string;
  terms_url?: string;
  privacy_url?: string;
  transactional_blurb?: string;
  promotional_blurb?: string;
};

function SmsOptInTab({ businessId }: { businessId: string }) {
  const [settings, setSettings] = useState<SmsOptInSettings>({});
  const [businessName, setBusinessName] = useState("");
  const [optinUrl, setOptinUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState<"url" | "embed" | null>(null);

  const token = localStorage.getItem("neverr_token");
  const activeBusinessId = localStorage.getItem("neverr_active_business_id") || "";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (activeBusinessId) headers["X-Active-Business"] = activeBusinessId;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API}/business/${encodeURIComponent(businessId)}/optin/settings`, { headers })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        if (cancelled) return;
        setSettings((d.settings || {}) as SmsOptInSettings);
        setBusinessName(d.business_name || "");
        setOptinUrl(d.optin_url || "");
      })
      .catch((e: any) => { if (!cancelled) setError(e?.message || "Could not load settings"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [businessId]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API}/business/${encodeURIComponent(businessId)}/optin/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(settings),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || `Save failed (HTTP ${r.status})`);
      setSettings((d.settings || settings) as SmsOptInSettings);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function copyToClipboard(text: string, which: "url" | "embed") {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Older browsers / insecure contexts: fall back to a hidden textarea
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    }
  }

  const embedSnippet = optinUrl
    ? `<iframe src="${optinUrl}" width="100%" height="720" style="border:0;border-radius:12px" loading="lazy" title="SMS opt-in"></iframe>`
    : "";

  if (loading) {
    return <div className="p-6 text-sm text-slate-500">Loading SMS opt-in settings…</div>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-1">SMS Opt-In Page</h2>
        <p className="text-sm text-slate-500">
          Share this Twilio-compliant page to capture SMS consent from{" "}
          <span className="font-medium text-slate-700">{businessName || "your customers"}</span>.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          {error}
        </div>
      )}

      {/* Public URL + embed snippet ---------------------------------- */}
      <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 space-y-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
            Public opt-in URL
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={optinUrl}
              readOnly
              className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm font-mono text-slate-700"
            />
            <button
              onClick={() => copyToClipboard(optinUrl, "url")}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5"
            >
              <Copy className="w-4 h-4" />
              {copied === "url" ? "Copied" : "Copy"}
            </button>
            <a
              href={optinUrl}
              target="_blank"
              rel="noreferrer"
              className="px-3 py-2 border border-slate-300 hover:bg-slate-100 rounded-lg text-sm font-medium inline-flex items-center gap-1.5 text-slate-700"
            >
              <ExternalLink className="w-4 h-4" />
              Open
            </a>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-600 mb-2">
            Embed on your website
          </label>
          <div className="flex gap-2">
            <textarea
              value={embedSnippet}
              readOnly
              rows={3}
              className="flex-1 px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-mono text-slate-700 resize-none"
            />
            <button
              onClick={() => copyToClipboard(embedSnippet, "embed")}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium inline-flex items-center gap-1.5 self-start"
            >
              <Copy className="w-4 h-4" />
              {copied === "embed" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      {/* Editable copy ------------------------------------------------- */}
      <div className="space-y-5">
        <h3 className="text-sm font-semibold text-slate-900">Form copy</h3>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Brand display name</label>
          <input
            type="text"
            value={settings.brand_display_name || ""}
            onChange={(e) => setSettings({ ...settings, brand_display_name: e.target.value })}
            placeholder={businessName}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">Defaults to your business name if left blank.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Campaign description</label>
          <textarea
            value={settings.campaign_description || ""}
            onChange={(e) => setSettings({ ...settings, campaign_description: e.target.value })}
            rows={2}
            maxLength={1000}
            placeholder={`Receive updates and notifications from ${businessName || "your business"}.`}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Terms of Service URL</label>
            <input
              type="url"
              value={settings.terms_url || ""}
              onChange={(e) => setSettings({ ...settings, terms_url: e.target.value })}
              placeholder="https://example.com/terms"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Privacy Policy URL</label>
            <input
              type="url"
              value={settings.privacy_url || ""}
              onChange={(e) => setSettings({ ...settings, privacy_url: e.target.value })}
              placeholder="https://example.com/privacy"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Transactional consent blurb</label>
          <textarea
            value={settings.transactional_blurb || ""}
            onChange={(e) => setSettings({ ...settings, transactional_blurb: e.target.value })}
            rows={3}
            maxLength={1000}
            placeholder="Defaults to standard transactional SMS disclosure."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">Shown next to the transactional consent checkbox. Must include opt-out instructions.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Promotional consent blurb</label>
          <textarea
            value={settings.promotional_blurb || ""}
            onChange={(e) => setSettings({ ...settings, promotional_blurb: e.target.value })}
            rows={3}
            maxLength={1000}
            placeholder="Defaults to standard promotional/marketing SMS disclosure."
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <p className="text-xs text-slate-500 mt-1">Shown next to the promotional consent checkbox. Must include opt-out instructions.</p>
        </div>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white rounded-lg text-sm font-semibold"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>
        {savedAt && !saving && (
          <span className="text-xs text-emerald-700">Saved.</span>
        )}
      </div>
    </div>
  );
}
