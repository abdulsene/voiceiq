/**
 * Lead detail — Slice 1 of the leads epic. Read-only.
 *
 * Two sections:
 *   1. Lead Info — contact name/phone/email, reason (full text, not
 *      truncated), preferred channel (with explanatory text), urgency,
 *      status, captured time (absolute + relative).
 *   2. Activity — chronological timeline of lead_activities, oldest
 *      first. The 'captured' entry (always the first row, seeded by
 *      the AI on POST /api/leads/capture) renders its metadata richly:
 *      the conversation_id becomes a deep link to /calls/<source_call_id>
 *      when the calls row exists, or a plain reference otherwise. This
 *      makes the escalation traceable end-to-end in the UI.
 *
 * No action buttons in this slice — Slice 2 will add claim, resolve,
 * SMS/email response. The muted footer at the bottom of the detail
 * page tells the customer those are coming.
 *
 * Stage 6 apiBase pattern preserved for parity with LeadsListPage.
 */

import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CornerDownRight,
  Cog,
  Mail,
  MessageSquare,
  Phone as PhoneIcon,
  PhoneCall,
  PhoneOutgoing,
  User,
  XCircle,
} from "lucide-react";

import { fetchApi } from "@/lib/api";

type Lead = {
  id: string;
  business_id: string;
  source: string;
  source_call_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  preferred_channel: string | null;
  reason: string;
  urgency: string;
  status: string;
  assigned_to: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  dismissed_reason: string | null;
  created_at: string;
  updated_at: string;
};

type Activity = {
  id: string;
  lead_id: string;
  actor_id: string | null;
  actor_type: "ai" | "staff" | "system" | string;
  action: string;
  metadata: any;
  note: string | null;
  created_at: string;
};

type DetailResponse = {
  lead: Lead;
  activities: Activity[];
};

function urgencyStyle(urgency: string): { pill: string; dot: string } {
  switch (urgency) {
    case "emergency":
      return { pill: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" };
    case "high":
      return { pill: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" };
    case "low":
      return { pill: "bg-gray-50 text-gray-500 border-gray-200", dot: "bg-gray-400" };
    case "medium":
    default:
      return { pill: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-400" };
  }
}

function statusStyle(status: string): string {
  switch (status) {
    case "new":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "claimed":
      return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "in_progress":
      return "bg-yellow-50 text-yellow-800 border-yellow-200";
    case "resolved":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "dismissed":
      return "bg-gray-100 text-gray-500 border-gray-200";
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

function channelIcon(channel: string | null) {
  switch (channel) {
    case "text":
      return MessageSquare;
    case "call":
      return PhoneIcon;
    case "email":
      return Mail;
    case "voice_callback":
      return PhoneCall;
    default:
      return MessageSquare;
  }
}

function ActorBadge({ actor_type, t }: { actor_type: string; t: (k: string) => string }) {
  if (actor_type === "ai") {
    return (
      <div
        className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0"
        aria-label={t("leads.activity.actor.ai")}
      >
        <Bot className="h-4 w-4 text-white" />
      </div>
    );
  }
  if (actor_type === "system") {
    return (
      <div
        className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0"
        aria-label={t("leads.activity.actor.system")}
      >
        <Cog className="h-4 w-4 text-gray-500" />
      </div>
    );
  }
  return (
    <div
      className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0"
      aria-label={t("leads.activity.actor.staff")}
    >
      <User className="h-4 w-4 text-emerald-700" />
    </div>
  );
}

function ActionIcon({ action }: { action: string }) {
  switch (action) {
    case "captured":
      return <CornerDownRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
    case "resolved":
      return <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
    case "dismissed":
      return <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
    case "sms_sent":
      return <MessageSquare className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    case "email_sent":
      return <Mail className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    default:
      return <CornerDownRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
  }
}

function formatTimestamp(iso: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  void t;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Locale-aware; the i18next instance's resolved language is in
  // navigator.language territory. Use the browser's default
  // formatter so we don't ship our own date library.
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

// apiBase hardcoded for Slice 1 — see LeadsListPage for the same
// rationale (admin drill-in is a future slice; wouter's Route type
// rejects extra props on the customer-facing route).
export default function LeadDetailPage() {
  const apiBase = "business";
  const { t } = useTranslation();
  const [, params] = useRoute<{ id: string }>("/leads/:id");
  const leadId = params?.id || "";

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) {
      setLoadError("No lead specified");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = (await fetchApi(`/${apiBase}/leads/${leadId}`)) as DetailResponse;
        if (cancelled) return;
        setData(r);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message || "Failed to load lead");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, leadId]);

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
        <div className="h-40 rounded-2xl bg-gray-100 animate-pulse" />
        <div className="h-60 rounded-2xl bg-gray-100 animate-pulse" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <Link href="/leads" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("leads.detail.backToList")}
        </Link>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError || t("leads.detail.notFound")}</span>
        </div>
      </div>
    );
  }

  const { lead, activities } = data;
  const u = urgencyStyle(lead.urgency);
  const ChannelIcon = channelIcon(lead.preferred_channel);

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-6 pb-12">
      <div>
        <Link href="/leads" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("leads.detail.backToList")}
        </Link>
      </div>

      {/* Header card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
        <div className="flex items-start gap-4">
          <div className="relative shrink-0">
            <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center">
              <ChannelIcon className="h-6 w-6 text-gray-500" />
            </div>
            <span
              className={`absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${u.dot}`}
              aria-label={t(`leads.urgency.${lead.urgency}`)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 leading-tight">
              {lead.contact_name || t("leads.unknownCaller")}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              {lead.contact_phone && (
                <a
                  href={`tel:${lead.contact_phone}`}
                  className="inline-flex items-center gap-1 text-[#2E75B6] hover:underline font-mono"
                >
                  <PhoneOutgoing className="h-3.5 w-3.5" />
                  {lead.contact_phone}
                </a>
              )}
              {lead.contact_email && (
                <a
                  href={`mailto:${lead.contact_email}`}
                  className="inline-flex items-center gap-1 text-[#2E75B6] hover:underline truncate"
                >
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{lead.contact_email}</span>
                </a>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {t("leads.detail.capturedAt", { when: formatTimestamp(lead.created_at, t) })}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1.5 shrink-0">
            <span
              className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border ${u.pill}`}
            >
              {t(`leads.urgency.${lead.urgency}`)}
            </span>
            <span
              className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border ${statusStyle(lead.status)}`}
            >
              {t(`leads.status.${lead.status}`)}
            </span>
          </div>
        </div>
      </div>

      {/* Lead info */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
          {t("leads.detail.leadInfo")}
        </h2>

        <div>
          <p className="text-xs text-gray-500 uppercase font-medium tracking-wide">
            {t("leads.detail.reason")}
          </p>
          <p className="text-sm text-gray-900 mt-1 leading-relaxed whitespace-pre-wrap">{lead.reason}</p>
        </div>

        {lead.preferred_channel && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-medium tracking-wide">
              {t("leads.detail.preferredChannel")}
            </p>
            <p className="text-sm text-gray-900 mt-1">
              {t(`leads.preferredChannelExplain.${lead.preferred_channel}`)}
            </p>
          </div>
        )}
      </div>

      {/* Activity timeline */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
        <h2 className="text-sm font-semibold tracking-wide text-gray-600 uppercase mb-4">
          {t("leads.detail.activity")}
        </h2>

        <ol className="space-y-4">
          {activities.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <ActorBadge actor_type={a.actor_type} t={t} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm text-gray-900">
                  <ActionIcon action={a.action} />
                  <span className="font-medium">{t(`leads.activity.action.${a.action}`)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-xs text-gray-500">{formatTimestamp(a.created_at, t)}</span>
                </div>

                {/* Rich rendering for the 'captured' seed entry — deep
                    link to the source call if we have it, otherwise
                    plain conversation_id reference. */}
                {a.action === "captured" && (
                  <div className="mt-1.5 text-xs text-gray-600 space-y-1">
                    <p>{t("leads.activity.capturedDescription")}</p>
                    {(() => {
                      const md = (a.metadata || {}) as { conversation_id?: string; source_call_id?: string };
                      if (md.source_call_id) {
                        return (
                          <p>
                            {t("leads.activity.linkedCallPrefix")}{" "}
                            <Link
                              href={`/calls/${md.source_call_id}`}
                              className="text-[#2E75B6] hover:underline font-medium"
                            >
                              {t("leads.activity.viewSourceCall")}
                            </Link>
                          </p>
                        );
                      }
                      if (md.conversation_id) {
                        return (
                          <p className="text-gray-500">
                            {t("leads.activity.conversationRef")}{" "}
                            <span className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">{md.conversation_id}</span>
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </div>
                )}

                {a.note && (
                  <p className="mt-1.5 text-xs text-gray-700 leading-relaxed bg-gray-50 border border-gray-100 rounded-md p-2">{a.note}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Actions coming soon — muted footer */}
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 text-center">
        {t("leads.detail.actionsComingSoon")}
      </div>
    </div>
  );
}
