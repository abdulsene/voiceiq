/**
 * Trust portal — public, mobile-first, no auth.
 *
 * URL: /r/:token  (token signed by api-server lib/trust-portal-token.ts)
 * Backend: GET /api/public/lead/:token + POST /api/public/lead/:token/action
 *
 * The customer sees:
 *   - Business name + phone (header)
 *   - Current status as a big visual indicator (one of 9 states)
 *   - Expected callback window (computed band from lib/lead-sla.ts)
 *   - Sanitized timeline (staff first names only, no recording / transcript)
 *   - Action buttons gated by can_rate / can_reschedule / can_cancel
 *
 * Polling: every 5s while status is non-terminal. Terminal states
 * (resolved, booked, cancelled) stop polling. Tab-visibility is NOT
 * a gate in v1 — kept simple; SSE migration is a follow-up.
 *
 * Timeline collapse (per Abdul's note): we filter outcome_recorded
 * events down to the latest one. Backend returns the full audit
 * history; the customer should see only the current state-of-truth
 * outcome. "Resolved → booked" reads as staff indecision otherwise.
 */

import { useEffect, useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle,
  Clock,
  Loader2,
  MessageCircle,
  Phone as PhoneIcon,
  PhoneCall,
  PhoneOff,
  Star,
  Sparkles,
  XCircle,
} from "lucide-react";

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_STATUSES = new Set(["resolved", "booked", "cancelled"]);

type PortalStatus =
  | "captured_awaiting_assignment"
  | "assigned"
  | "staff_acknowledged"
  | "on_call"
  | "resolved"
  | "booked"
  | "follow_up_scheduled"
  | "no_answer"
  | "cancelled";

type TimelineEvent = {
  type: string;
  at: string;
  staff_first_name?: string;
  duration_secs?: number;
  outcome?: string;
  channel?: string;
};

type PortalPayload = {
  business: { name: string; phone: string | null };
  lead: {
    reason: string;
    urgency: string;
    preferred_channel: string | null;
    created_at: string;
    contact_name: string | null;
  };
  status: PortalStatus;
  expected_callback_window: { earliest: string; latest: string };
  timeline: TimelineEvent[];
  can_rate: boolean;
  can_reschedule: boolean;
  can_cancel: boolean;
};

// Pick the user's locale from the browser; fall back to en. The trust
// portal i18n keys live under leads.portal.* (loaded in i18n bootstrap).
function browserLocale(): "en" | "es" | "fr" {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "en";
  const code = lang.toLowerCase().split(/[-_]/)[0];
  if (code === "es" || code === "fr") return code;
  return "en";
}

function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelative(iso: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return t("leads.portal.relative.justNow");
  const min = Math.round(diffSec / 60);
  if (min < 60) return t("leads.portal.relative.minutesAgo", { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("leads.portal.relative.hoursAgo", { count: hr });
  const day = Math.round(hr / 24);
  return t("leads.portal.relative.daysAgo", { count: day });
}

interface StatusVisual {
  Icon: typeof Check;
  tint: string;
  accent: string;
  ring: string;
}

function statusVisual(status: PortalStatus): StatusVisual {
  switch (status) {
    case "resolved":
    case "booked":
      return {
        Icon: CheckCircle,
        tint: "bg-emerald-50 text-emerald-700",
        accent: "text-emerald-600",
        ring: "ring-emerald-200",
      };
    case "follow_up_scheduled":
      return {
        Icon: Calendar,
        tint: "bg-amber-50 text-amber-800",
        accent: "text-amber-700",
        ring: "ring-amber-200",
      };
    case "on_call":
      return {
        Icon: PhoneCall,
        tint: "bg-blue-50 text-blue-800",
        accent: "text-blue-700",
        ring: "ring-blue-200",
      };
    case "no_answer":
      return {
        Icon: PhoneOff,
        tint: "bg-orange-50 text-orange-800",
        accent: "text-orange-700",
        ring: "ring-orange-200",
      };
    case "cancelled":
      return {
        Icon: XCircle,
        tint: "bg-gray-100 text-gray-700",
        accent: "text-gray-600",
        ring: "ring-gray-200",
      };
    case "staff_acknowledged":
    case "assigned":
      return {
        Icon: Sparkles,
        tint: "bg-indigo-50 text-indigo-800",
        accent: "text-indigo-700",
        ring: "ring-indigo-200",
      };
    case "captured_awaiting_assignment":
    default:
      return {
        Icon: Clock,
        tint: "bg-slate-50 text-slate-700",
        accent: "text-slate-600",
        ring: "ring-slate-200",
      };
  }
}

/**
 * Pull the headline label + supporting line for the current status.
 * Returns translation keys so the consuming render can interpolate
 * staff first name / business name / window text.
 */
function headlineKeys(status: PortalStatus): { titleKey: string; bodyKey: string } {
  return {
    titleKey: `leads.portal.status.${status}.title`,
    bodyKey: `leads.portal.status.${status}.body`,
  };
}

function timelineIcon(type: string) {
  switch (type) {
    case "captured":
      return Sparkles;
    case "assigned":
      return Sparkles;
    case "callback_started":
      return PhoneCall;
    case "callback_completed":
      return Check;
    case "callback_failed":
      return PhoneOff;
    case "sms_sent":
      return MessageCircle;
    case "outcome_recorded":
      return Check;
    case "customer_rated":
      return Star;
    case "customer_rescheduled":
      return Calendar;
    case "customer_cancelled":
      return XCircle;
    case "customer_marked_urgent":
      return AlertCircle;
    default:
      return Clock;
  }
}

interface RateModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (score: number, comment: string) => Promise<void>;
  submitting: boolean;
  serverError: string | null;
}

function RateModal({ open, onClose, onSubmit, submitting, serverError }: RateModalProps) {
  const { t } = useTranslation();
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl p-5 sm:p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-gray-900">{t("leads.portal.rate.title")}</h3>
        <p className="text-sm text-gray-500">{t("leads.portal.rate.subtitle")}</p>
        <div className="flex items-center justify-center gap-2 py-2" role="radiogroup" aria-label={t("leads.portal.rate.title")}>
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = score >= n;
            return (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={score === n}
                onClick={() => setScore(n)}
                className="p-1 rounded-md focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/40"
              >
                <Star
                  className={`h-9 w-9 transition-colors ${filled ? "text-amber-400 fill-amber-400" : "text-gray-300"}`}
                  strokeWidth={1.5}
                />
              </button>
            );
          })}
        </div>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder={t("leads.portal.rate.commentPlaceholder")}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
        />
        {serverError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 inline-flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{serverError}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            {t("leads.portal.rate.cancel")}
          </button>
          <button
            type="button"
            disabled={submitting || score === 0}
            onClick={() => { void onSubmit(score, comment); }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-[#2E75B6] text-white rounded-lg hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("leads.portal.rate.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

interface RescheduleModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (iso: string) => Promise<void>;
  submitting: boolean;
  serverError: string | null;
}

function RescheduleModal({ open, onClose, onSubmit, submitting, serverError }: RescheduleModalProps) {
  const { t } = useTranslation();
  const [when, setWhen] = useState("");
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl p-5 sm:p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900">{t("leads.portal.reschedule.title")}</h3>
        <p className="text-sm text-gray-500">{t("leads.portal.reschedule.subtitle")}</p>
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
        />
        {serverError && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 inline-flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>{serverError}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            {t("leads.portal.reschedule.cancel")}
          </button>
          <button
            type="button"
            disabled={submitting || !when}
            onClick={() => { void onSubmit(new Date(when).toISOString()); }}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-[#2E75B6] text-white rounded-lg hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t("leads.portal.reschedule.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TrustPortalPage() {
  const { t, i18n } = useTranslation();
  const [, params] = useRoute<{ token: string }>("/r/:token");
  const token = params?.token || "";
  const locale = useMemo(() => {
    const detected = browserLocale();
    return i18n.language?.toLowerCase().split(/[-_]/)[0] || detected;
  }, [i18n.language]);

  const [data, setData] = useState<PortalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [rateOpen, setRateOpen] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rated, setRated] = useState(false);

  // Initial fetch + polling. Stops on terminal status (resolved /
  // booked / cancelled).
  useEffect(() => {
    if (!token) {
      setLoadError(t("leads.portal.notFound"));
      setLoading(false);
      return;
    }
    let cancelled = false;
    let interval: number | null = null;

    async function fetchOnce() {
      try {
        const r = await fetch(`/api/public/lead/${encodeURIComponent(token)}`);
        if (cancelled) return;
        if (r.status === 404) {
          setLoadError(t("leads.portal.notFound"));
          setData(null);
          if (interval) { window.clearInterval(interval); interval = null; }
          return;
        }
        if (!r.ok) {
          setLoadError(t("leads.portal.networkError"));
          return;
        }
        const body = (await r.json()) as PortalPayload;
        if (cancelled) return;
        setData(body);
        setLoadError(null);
        if (TERMINAL_STATUSES.has(body.status) && interval) {
          window.clearInterval(interval);
          interval = null;
        }
      } catch {
        if (!cancelled) setLoadError(t("leads.portal.networkError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchOnce();
    interval = window.setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, [token, t]);

  // Collapse outcome_recorded events to the LATEST one — staff may have
  // re-recorded ("resolved" → "booked") and the customer should see
  // current truth, not staff indecision. Internal staff view keeps the
  // full audit history on the dashboard.
  const displayTimeline = useMemo<TimelineEvent[]>(() => {
    if (!data) return [];
    const outcomes = data.timeline
      .filter((e) => e.type === "outcome_recorded")
      .sort((a, b) => b.at.localeCompare(a.at));
    const latestOutcome = outcomes[0];
    const rest = data.timeline.filter((e) => e.type !== "outcome_recorded");
    const combined = latestOutcome ? [...rest, latestOutcome] : rest;
    return combined.sort((a, b) => a.at.localeCompare(b.at));
  }, [data]);

  async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    setActionSubmitting(true);
    setActionError(null);
    try {
      const r = await fetch(`/api/public/lead/${encodeURIComponent(token)}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setActionError(j.error || t("leads.portal.actionError"));
        return { ok: false, error: j.error };
      }
      return { ok: true };
    } catch (e: any) {
      const msg = e?.message || t("leads.portal.actionError");
      setActionError(msg);
      return { ok: false, error: msg };
    } finally {
      setActionSubmitting(false);
    }
  }

  async function handleRate(score: number, comment: string) {
    const r = await postAction({ action: "rate", score, comment });
    if (r.ok) {
      setRated(true);
      setRateOpen(false);
    }
  }

  async function handleReschedule(iso: string) {
    const r = await postAction({ action: "reschedule", requested_at: iso });
    if (r.ok) setRescheduleOpen(false);
  }

  async function handleCancel() {
    if (!window.confirm(t("leads.portal.confirmCancel"))) return;
    await postAction({ action: "cancel" });
  }

  async function handleMarkUrgent() {
    if (!window.confirm(t("leads.portal.confirmMarkUrgent"))) return;
    await postAction({ action: "mark_urgent" });
  }

  if (loading && !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full space-y-3">
          <div className="h-8 w-40 rounded bg-gray-200 animate-pulse" />
          <div className="h-40 rounded-2xl bg-gray-200 animate-pulse" />
          <div className="h-32 rounded-2xl bg-gray-200 animate-pulse" />
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-3">
          <div className="h-16 w-16 mx-auto rounded-full bg-gray-100 flex items-center justify-center">
            <AlertCircle className="h-8 w-8 text-gray-400" />
          </div>
          <h1 className="text-xl font-semibold text-gray-900">{t("leads.portal.notFound")}</h1>
          <p className="text-sm text-gray-500">{t("leads.portal.notFoundHint")}</p>
        </div>
      </div>
    );
  }

  const status = data.status;
  const visual = statusVisual(status);
  const { titleKey, bodyKey } = headlineKeys(status);

  // Find the most recent timeline event that references a staff member —
  // we use that name in the status body. Falls back to the business name.
  const latestStaff =
    [...displayTimeline].reverse().find((e) => e.staff_first_name)?.staff_first_name ||
    t("leads.portal.fallbackStaffName");

  const winLatest = data.expected_callback_window.latest;
  const winEarliest = data.expected_callback_window.earliest;

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-md mx-auto px-4 py-4 flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-[#2E75B6]/10 flex items-center justify-center">
            <PhoneIcon className="h-5 w-5 text-[#2E75B6]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500">{t("leads.portal.headerLabel")}</p>
            <h1 className="text-base font-semibold text-gray-900 truncate">{data.business.name}</h1>
          </div>
          {data.business.phone && (
            <a
              href={`tel:${data.business.phone}`}
              className="text-xs font-medium text-[#2E75B6] hover:underline"
            >
              {t("leads.portal.callBusiness")}
            </a>
          )}
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 py-6 space-y-5 pb-12">
        {/* Hero status */}
        <section className={`rounded-2xl ring-1 ${visual.ring} ${visual.tint} p-5 sm:p-6`}>
          <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-full bg-white/70 flex items-center justify-center ${visual.accent}`}>
              <visual.Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold leading-snug">
                {t(titleKey, {
                  staff_first_name: latestStaff,
                  business_name: data.business.name,
                  defaultValue: t("leads.portal.status.default.title"),
                })}
              </h2>
              <p className="text-sm mt-1 leading-relaxed opacity-90">
                {t(bodyKey, {
                  staff_first_name: latestStaff,
                  business_name: data.business.name,
                  window_latest: formatDateTime(winLatest, locale),
                  window_earliest: formatDateTime(winEarliest, locale),
                  defaultValue: t("leads.portal.status.default.body"),
                })}
              </p>
            </div>
          </div>
        </section>

        {/* Request summary */}
        <section className="rounded-2xl bg-white border border-gray-200 p-5 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            {t("leads.portal.requestSummaryLabel")}
          </p>
          <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">{data.lead.reason}</p>
          <p className="text-xs text-gray-400">
            {t("leads.portal.capturedAt", { when: formatRelative(data.lead.created_at, t) })}
          </p>
        </section>

        {/* Actions */}
        {(data.can_rate || data.can_reschedule || data.can_cancel || status !== "cancelled") && (
          <section className="rounded-2xl bg-white border border-gray-200 p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              {t("leads.portal.actionsLabel")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {data.can_rate && !rated && (
                <button
                  type="button"
                  onClick={() => { setActionError(null); setRateOpen(true); }}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold bg-[#2E75B6] text-white rounded-lg hover:bg-[#2563a0]"
                >
                  <Star className="h-4 w-4" />
                  {t("leads.portal.actions.rate")}
                </button>
              )}
              {rated && (
                <div className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200">
                  <Check className="h-4 w-4" />
                  {t("leads.portal.actions.rated")}
                </div>
              )}
              {data.can_reschedule && (
                <button
                  type="button"
                  onClick={() => { setActionError(null); setRescheduleOpen(true); }}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-gray-700 bg-gray-50 border border-gray-200 rounded-lg hover:bg-gray-100"
                >
                  <Calendar className="h-4 w-4" />
                  {t("leads.portal.actions.reschedule")}
                </button>
              )}
              {data.can_reschedule && (
                <button
                  type="button"
                  onClick={() => { void handleMarkUrgent(); }}
                  disabled={actionSubmitting}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50"
                >
                  <AlertCircle className="h-4 w-4" />
                  {t("leads.portal.actions.markUrgent")}
                </button>
              )}
              {data.can_cancel && (
                <button
                  type="button"
                  onClick={() => { void handleCancel(); }}
                  disabled={actionSubmitting}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 disabled:opacity-50"
                >
                  <XCircle className="h-4 w-4" />
                  {t("leads.portal.actions.cancel")}
                </button>
              )}
            </div>
            {actionError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 inline-flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>{actionError}</span>
              </div>
            )}
          </section>
        )}

        {/* Timeline */}
        <section className="rounded-2xl bg-white border border-gray-200 p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
            {t("leads.portal.timelineLabel")}
          </p>
          <ol className="space-y-3">
            {displayTimeline.map((e, idx) => {
              const Icon = timelineIcon(e.type);
              return (
                <li key={`${e.type}-${e.at}-${idx}`} className="flex items-start gap-2.5">
                  <div className="h-6 w-6 rounded-full bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="h-3.5 w-3.5 text-gray-500" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900">
                      {t(`leads.portal.timeline.${e.type}`, {
                        staff_first_name: e.staff_first_name || t("leads.portal.fallbackStaffName"),
                        outcome: e.outcome ? t(`leads.portal.outcomeLabel.${e.outcome}`, { defaultValue: e.outcome }) : "",
                        defaultValue: e.type,
                      })}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{formatRelative(e.at, t)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        <footer className="text-center text-xs text-gray-400 pt-4">
          <p>{t("leads.portal.footer")}</p>
        </footer>
      </main>

      <RateModal
        open={rateOpen}
        onClose={() => setRateOpen(false)}
        onSubmit={handleRate}
        submitting={actionSubmitting}
        serverError={actionError}
      />
      <RescheduleModal
        open={rescheduleOpen}
        onClose={() => setRescheduleOpen(false)}
        onSubmit={handleReschedule}
        submitting={actionSubmitting}
        serverError={actionError}
      />
    </div>
  );
}
