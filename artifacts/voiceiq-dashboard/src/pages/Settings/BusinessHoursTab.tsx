/**
 * Phase 3.1b — Business hours tab for the SettingsPage.
 *
 * Structured 7-row weekly schedule (Sun-Sat) + single timezone. Replaces
 * the free-form business_configs.business_hours text input in the UI;
 * that column stays in the DB for the AI prompt renderer until Phase 3.2
 * switches to structured hours.
 *
 * PATCH is a bulk replace — send all 7 rows every time. Overnight
 * windows (closes past midnight) rejected by the backend and by our
 * client-side validation for parity with the CHECK constraint.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../../lib/api";

interface Row {
  day_of_week: number; // 0=Sun .. 6=Sat
  opens_at: string | null; // "HH:MM"
  closes_at: string | null;
  timezone: string;
  is_closed: boolean;
}

const DEFAULT_TZ = "America/New_York";

const TZ_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "America/New_York", label: "Eastern (America/New_York)" },
  { value: "America/Chicago", label: "Central (America/Chicago)" },
  { value: "America/Denver", label: "Mountain (America/Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (America/Los_Angeles)" },
  { value: "America/Anchorage", label: "Alaska (America/Anchorage)" },
  { value: "America/Phoenix", label: "Arizona (America/Phoenix)" },
  { value: "Pacific/Honolulu", label: "Hawaii (Pacific/Honolulu)" },
  { value: "Europe/London", label: "London (Europe/London)" },
  { value: "Europe/Paris", label: "Paris (Europe/Paris)" },
  { value: "Europe/Berlin", label: "Berlin (Europe/Berlin)" },
  { value: "Asia/Tokyo", label: "Tokyo (Asia/Tokyo)" },
  { value: "Australia/Sydney", label: "Sydney (Australia/Sydney)" },
  { value: "UTC", label: "UTC" },
];

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function defaultRows(tz: string): Row[] {
  return Array.from({ length: 7 }, (_, dow) => ({
    day_of_week: dow,
    opens_at: dow >= 1 && dow <= 5 ? "09:00" : null,
    closes_at: dow >= 1 && dow <= 5 ? "17:00" : null,
    timezone: tz,
    is_closed: !(dow >= 1 && dow <= 5),
  }));
}

// The API may return fewer than 7 rows (or none at all if never
// configured). Normalize to always render exactly 7 in Sun-Sat order.
function normalize(rows: Row[] | undefined | null): Row[] {
  const byDow = new Map<number, Row>();
  for (const r of rows ?? []) byDow.set(r.day_of_week, r);
  const tz = rows?.[0]?.timezone || DEFAULT_TZ;
  return Array.from({ length: 7 }, (_, dow) =>
    byDow.get(dow) || {
      day_of_week: dow,
      opens_at: null,
      closes_at: null,
      timezone: tz,
      is_closed: true,
    },
  );
}

export default function BusinessHoursTab() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() => defaultRows(DEFAULT_TZ));
  const [tz, setTz] = useState<string>(DEFAULT_TZ);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchApi("/business/hours");
      const normalized = normalize(data?.hours as Row[] | undefined);
      setRows(normalized);
      setTz(normalized[0]?.timezone || DEFAULT_TZ);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateRow = useCallback((dow: number, patch: Partial<Row>) => {
    setRows((prev) =>
      prev.map((r) => (r.day_of_week === dow ? { ...r, ...patch, timezone: tz } : r)),
    );
  }, [tz]);

  const setTimezoneAll = useCallback((nextTz: string) => {
    setTz(nextTz);
    setRows((prev) => prev.map((r) => ({ ...r, timezone: nextTz })));
  }, []);

  const validate = useCallback((): string | null => {
    for (const r of rows) {
      if (r.is_closed) continue;
      if (!r.opens_at || !r.closes_at) return t("hours.validationOpensBeforeCloses");
      if (r.opens_at >= r.closes_at) return t("hours.validationOpensBeforeCloses");
    }
    return null;
  }, [rows, t]);

  async function handleSave() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      const payload = rows.map((r) => ({
        day_of_week: r.day_of_week,
        opens_at: r.is_closed ? null : r.opens_at,
        closes_at: r.is_closed ? null : r.closes_at,
        timezone: tz,
        is_closed: r.is_closed,
      }));
      const res = await fetch("/api/business/hours", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ hours: payload }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setRows(normalize(body?.hours as Row[] | undefined));
      toast.success(t("hours.saveSuccess"));
    } catch (e: any) {
      toast.error(e?.message || t("hours.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const orderedRows = useMemo(() => [...rows].sort((a, b) => a.day_of_week - b.day_of_week), [rows]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("hours.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t("hours.title")}</h2>
        <p className="text-sm text-slate-500 mt-1">{t("hours.subtitle")}</p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          {error}
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-slate-700 mb-1 block">{t("hours.timezone")}</label>
        <select
          value={tz}
          onChange={(e) => setTimezoneAll(e.target.value)}
          className="w-full max-w-md px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
        >
          {TZ_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-700">
              <th className="px-4 py-3 font-semibold">Day</th>
              <th className="px-4 py-3 font-semibold">{t("hours.closed")}</th>
              <th className="px-4 py-3 font-semibold">{t("hours.opens")}</th>
              <th className="px-4 py-3 font-semibold">{t("hours.closes")}</th>
            </tr>
          </thead>
          <tbody>
            {orderedRows.map((r) => {
              const dayKey = DAY_KEYS[r.day_of_week];
              return (
                <tr key={r.day_of_week} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-900">{t(`hours.days.${dayKey}`)}</td>
                  <td className="px-4 py-3">
                    <label className="inline-flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={r.is_closed}
                        onChange={(e) =>
                          updateRow(r.day_of_week, {
                            is_closed: e.target.checked,
                            opens_at: e.target.checked ? null : r.opens_at || "09:00",
                            closes_at: e.target.checked ? null : r.closes_at || "17:00",
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                      />
                      <span className="text-xs text-slate-600">{t("hours.closed")}</span>
                    </label>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="time"
                      value={r.opens_at ?? ""}
                      onChange={(e) => updateRow(r.day_of_week, { opens_at: e.target.value })}
                      disabled={r.is_closed}
                      className="px-2 py-1 border border-slate-300 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="time"
                      value={r.closes_at ?? ""}
                      onChange={(e) => updateRow(r.day_of_week, { closes_at: e.target.value })}
                      disabled={r.is_closed}
                      className="px-2 py-1 border border-slate-300 rounded-md text-sm disabled:bg-slate-50 disabled:text-slate-400 focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">{t("hours.note")}</p>

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#1e5a8f] disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? t("hours.saving") : t("hours.save")}
        </button>
      </div>
    </div>
  );
}
