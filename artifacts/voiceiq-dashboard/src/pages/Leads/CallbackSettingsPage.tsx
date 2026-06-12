/**
 * Callback ring-number settings. Slice 2A — the "ring me at" preference
 * for the lead-bridge feature.
 *
 * Per-(user, business) preference stored on user_businesses.
 * The lead-bridge POST reads this when no override is passed; the
 * LeadDetailPage points the customer here when it's missing.
 *
 * Deliberately a separate page (not embedded in SettingsPage.tsx)
 * because:
 *   - SettingsPage is 1900+ lines; one more section there adds drag
 *     for a one-input form.
 *   - It needs to be deep-linkable from the LeadDetailPage banner;
 *     /settings/callback reads cleanly.
 *   - Future slices may add team-management and other callback prefs
 *     in this area; carve out the route now.
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { AlertCircle, ArrowLeft, Check, PhoneCall } from "lucide-react";

import { fetchApi, getAuthHeaders } from "@/lib/api";
import { formatPhoneForDisplay, isPhoneE164Valid, parsePhoneToE164 } from "@/lib/phone";

export default function CallbackSettingsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [savedToast, setSavedToast] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await fetchApi(`/business/me/callback-preference`)) as { callback_ring_number: string | null };
        if (cancelled) return;
        setSaved(r.callback_ring_number);
        setInput(r.callback_ring_number ? formatPhoneForDisplay(r.callback_ring_number) || r.callback_ring_number : "");
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "Failed to load preference");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const e164 = input.trim() ? parsePhoneToE164(input) : null;
  const inputValid = !input.trim() || isPhoneE164Valid(input);
  const dirty = (e164 || "") !== (saved || "");

  async function handleSave() {
    if (saving || !inputValid || !dirty) return;
    setSaving(true);
    setServerError(null);
    setSavedToast(false);
    try {
      const r = await fetch(`/api/business/me/callback-preference`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ callback_ring_number: e164 }),
      });
      const body = (await r.json().catch(() => ({}))) as { success?: boolean; callback_ring_number?: string | null; error?: string };
      if (!r.ok) {
        setServerError(body.error || `HTTP ${r.status}`);
        return;
      }
      setSaved(body.callback_ring_number ?? null);
      setInput(body.callback_ring_number ? formatPhoneForDisplay(body.callback_ring_number) || body.callback_ring_number : "");
      setSavedToast(true);
      window.setTimeout(() => setSavedToast(false), 3000);
    } catch (e: any) {
      setServerError(e?.message || "Network error");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
        <div className="h-6 w-40 rounded bg-gray-100 animate-pulse" />
        <div className="h-32 rounded-2xl bg-gray-100 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
      <div>
        <Link href="/settings" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("leads.callback.backToSettings")}
        </Link>
      </div>

      <div className="space-y-1">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-900">
          {t("leads.callback.title")}
        </h1>
        <p className="text-sm text-gray-500">{t("leads.callback.subtitle")}</p>
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {savedToast && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-center gap-2 text-sm text-emerald-800 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200 motion-safe:ease-out">
          <Check className="h-4 w-4" />
          <span>{t("leads.callback.savedToast")}</span>
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 space-y-4">
        <div className="flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-gray-400" />
          <h2 className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
            {t("leads.callback.section.ringNumber")}
          </h2>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          {t("leads.callback.section.description")}
        </p>
        <div className="space-y-2">
          <label htmlFor="callback-ring" className="text-sm font-medium text-gray-900 block">
            {t("leads.callback.section.phoneLabel")}
          </label>
          <input
            id="callback-ring"
            type="tel"
            inputMode="tel"
            placeholder="(443) 708-7894"
            value={input}
            onChange={(e) => { setInput(e.target.value); setServerError(null); }}
            onBlur={() => {
              if (!input.trim()) return;
              const norm = parsePhoneToE164(input);
              if (norm) setInput(formatPhoneForDisplay(norm) || norm);
            }}
            disabled={saving}
            aria-invalid={!inputValid || undefined}
            className={`w-full rounded-lg border px-3 py-2.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E75B6] focus:border-transparent ${
              !inputValid ? "border-red-400" : "border-gray-200"
            } disabled:bg-gray-50 disabled:cursor-not-allowed`}
          />
          {!inputValid && (
            <p className="text-xs text-red-600">{t("leads.callback.section.formatError")}</p>
          )}
          <p className="text-xs text-gray-500">{t("leads.callback.section.help")}</p>
        </div>
        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 flex items-start gap-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{serverError}</span>
          </div>
        )}
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !inputValid || !dirty}
            className="px-4 py-2 text-sm font-semibold bg-[#2E75B6] text-white rounded-lg hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? t("leads.callback.saving") : t("leads.callback.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
