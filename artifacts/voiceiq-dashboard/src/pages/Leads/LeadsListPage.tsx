/**
 * Leads list — Slice 1 of the leads epic. Read-only. Three tabs:
 * "My Open" (assigned_to_me + status≠resolved/dismissed), "Unassigned"
 * (assigned_to IS NULL + status=new), "All".
 *
 * Mobile-first: each row renders as a card on small viewports; an
 * inline table on md+ so leads scan quickly on desktop. Click anywhere
 * on the row → /leads/:id.
 *
 * Stage 6 apiBase pattern: customer flow uses apiBase="business"
 * (default). The admin drill-in at /admin/businesses/:id/leads can
 * reuse this same component by passing apiBase=`admin/business/${id}`
 * — same wire shape on both surfaces.
 *
 * No action buttons in this slice — staff actions (claim, resolve,
 * SMS/email) land in Slice 2. The empty state explains the AI
 * connection so it doesn't read as "your dashboard is broken."
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
// Phase 3.3: click-to-call via the WebRTC softphone. Falls back to
// tel: link when the softphone isn't registered so no capability
// regression on staff who haven't opted in.
import { useSoftphone } from "../../components/Softphone";
import {
  AlertTriangle,
  ArrowUpRight,
  Inbox,
  Mail,
  MessageSquare,
  Phone as PhoneIcon,
  PhoneCall,
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
  urgency: "low" | "medium" | "high" | "emergency" | string;
  status: "new" | "claimed" | "in_progress" | "resolved" | "dismissed" | string;
  assigned_to: string | null;
  created_at: string;
  // Phase 6.0 — nullable for pre-6.0 rows and non-qualification captures.
  qualification_status?: "qualified" | "unqualified_temporary" | "unqualified_permanent" | null;
  disqualifier_id?: string | null;
};

// Phase 6.0 — disqualifier catalog fetched once from Settings→Topics.
// Used to render human labels next to the raw disqualifier_id on
// unqualified leads. Missing/orphaned ids fall back to the raw id
// display so a row never shows a blank reason.
type DisqualifierEntry = { id: string; label: string; kind: "permanent" | "temporary" };
type DisqualifierIndex = Map<string, DisqualifierEntry>;

async function fetchDisqualifierIndex(apiBase: string): Promise<DisqualifierIndex> {
  const index = new Map<string, DisqualifierEntry>();
  if (apiBase !== "business") return index;
  try {
    const data = (await fetchApi(`/business/topics`)) as {
      topics?: Array<{ qualification?: { disqualifiers?: DisqualifierEntry[] } | null }>;
    };
    for (const t of data?.topics ?? []) {
      const list = t?.qualification?.disqualifiers ?? [];
      for (const d of list) {
        if (d?.id && d?.label) index.set(d.id, d);
      }
    }
  } catch {
    // Non-fatal — dashboard still renders with raw-id fallback.
  }
  return index;
}

function disqualifierLabel(index: DisqualifierIndex, id: string | null | undefined): string | null {
  if (!id) return null;
  const entry = index.get(id);
  // Fallback: show the raw id so a stale reference is legible ("under_25"
  // rather than an empty pill).
  return entry?.label ?? id;
}

type LeadsListResponse = {
  leads: Lead[];
  total: number;
  limit: number;
  offset: number;
};

type TabKey = "myOpen" | "unassigned" | "all" | "waitingToQualify" | "notEligible";

const REASON_PREVIEW_CHARS = 80;

function relativeTime(iso: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return t("leads.relative.justNow");
  const min = Math.round(diffSec / 60);
  if (min < 60) return t("leads.relative.minutesAgo", { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("leads.relative.hoursAgo", { count: hr });
  const day = Math.round(hr / 24);
  if (day < 30) return t("leads.relative.daysAgo", { count: day });
  const mo = Math.round(day / 30);
  return t("leads.relative.monthsAgo", { count: mo });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

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
      return Inbox;
  }
}

// apiBase is hardcoded for Slice 1 — the admin drill-in
// (/admin/businesses/:id/leads) doesn't exist yet. When it lands, this
// function will accept an `apiBase` prop and the admin route will pass
// `admin/business/${id}`. Wouter's <Route component={X}> typing rejects
// arbitrary extra props, so keeping the function parameterless avoids the
// same prop-type complaint the existing Signup Route has.
export default function LeadsListPage() {
  const apiBase = "business";
  const { t } = useTranslation();
  const softphone = useSoftphone();
  // Initial tab from ?tab= query param. When unset, `tab` stays null until
  // the counts fetch resolves so smartDefault() can pick the most useful
  // bucket — avoids the "1 lead invisible on landing because owner is
  // staring at My open" failure mode.
  const explicitTab = useMemo<TabKey | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const ti = params.get("tab");
    if (
      ti === "myOpen" ||
      ti === "unassigned" ||
      ti === "all" ||
      ti === "waitingToQualify" ||
      ti === "notEligible"
    ) {
      return ti;
    }
    return null;
  }, []);
  const [tab, setTab] = useState<TabKey | null>(explicitTab);
  const [counts, setCounts] = useState<{
    myOpen: number;
    unassigned: number;
    all: number;
    waitingToQualify: number;
    notEligible: number;
  } | null>(null);
  const [disqualifierIndex, setDisqualifierIndex] = useState<DisqualifierIndex>(() => new Map());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Query is built per-tab. The "myOpen" tab uses the assigned_to_me
  // query param the server already understands; the actual "open" filter
  // (status NOT IN ('resolved','dismissed')) is applied client-side
  // since the server's status param is single-value. Slice 1 acceptable;
  // tighten on the server when Slices 2+ make this a hot list.
  const queryString = useMemo(() => {
    if (!tab) return null;
    const p = new URLSearchParams();
    p.set("limit", "200");
    if (tab === "myOpen") p.set("assigned_to_me", "true");
    if (tab === "unassigned") p.set("status", "new");
    if (tab === "waitingToQualify") p.set("qualification_status", "unqualified_temporary");
    if (tab === "notEligible") p.set("qualification_status", "unqualified_permanent");
    return p.toString();
  }, [tab]);

  // One-shot counts fetch on mount. Three parallel requests; myOpen
  // uses limit=200 because we have to post-filter resolved/dismissed
  // client-side (same as visibleLeads) — total alone is inaccurate.
  // After counts resolve, pick smart default unless ?tab= pinned one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [myOpenResp, unassignedResp, allResp, waitingResp, notEligibleResp, idx] = await Promise.all([
          fetchApi(`/${apiBase}/leads?assigned_to_me=true&limit=200`) as Promise<LeadsListResponse>,
          fetchApi(`/${apiBase}/leads?status=new&limit=1`) as Promise<LeadsListResponse>,
          fetchApi(`/${apiBase}/leads?limit=1`) as Promise<LeadsListResponse>,
          fetchApi(`/${apiBase}/leads?qualification_status=unqualified_temporary&limit=1`) as Promise<LeadsListResponse>,
          fetchApi(`/${apiBase}/leads?qualification_status=unqualified_permanent&limit=1`) as Promise<LeadsListResponse>,
          fetchDisqualifierIndex(apiBase),
        ]);
        if (cancelled) return;
        const myOpenCount = (myOpenResp.leads || []).filter(
          (l) => l.status !== "resolved" && l.status !== "dismissed",
        ).length;
        const next = {
          myOpen: myOpenCount,
          unassigned: unassignedResp.total ?? 0,
          all: allResp.total ?? 0,
          waitingToQualify: waitingResp.total ?? 0,
          notEligible: notEligibleResp.total ?? 0,
        };
        setCounts(next);
        setDisqualifierIndex(idx);
        if (!explicitTab) {
          if (next.myOpen > 0) setTab("myOpen");
          else if (next.unassigned > 0) setTab("unassigned");
          else if (next.all > 0) setTab("all");
          else setTab("myOpen");
        }
      } catch {
        // Counts failed — fall through to default tab so the page still
        // renders. Badges stay hidden.
        if (cancelled) return;
        if (!explicitTab) setTab("myOpen");
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, explicitTab]);

  useEffect(() => {
    if (!queryString) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const data = (await fetchApi(`/${apiBase}/leads?${queryString}`)) as LeadsListResponse;
        if (cancelled) return;
        setLeads(data.leads || []);
        setTotal(data.total ?? data.leads?.length ?? 0);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message || "Failed to load leads");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, queryString]);

  // Client-side post-filter for "myOpen": drop resolved/dismissed so
  // the tab only shows actionable leads. Server returns everything
  // assigned to me; the dashboard's daily-driver view wants open work.
  const visibleLeads = useMemo(() => {
    if (tab !== "myOpen") return leads;
    return leads.filter((l) => l.status !== "resolved" && l.status !== "dismissed");
  }, [leads, tab]);

  // Count source: counts state (fetched once on mount) for ALL tabs so the
  // badges stay consistent. For the active tab we prefer the live
  // visibleLeads.length / total because it reflects in-session mutations
  // once the per-tab fetch resolves; falls back to counts otherwise.
  const tabs: { key: TabKey; label: string; count: number }[] = [
    {
      key: "myOpen",
      label: t("leads.tabs.myOpen"),
      count: tab === "myOpen" && !loading ? visibleLeads.length : counts?.myOpen ?? 0,
    },
    {
      key: "unassigned",
      label: t("leads.tabs.unassigned"),
      count: tab === "unassigned" && !loading ? visibleLeads.length : counts?.unassigned ?? 0,
    },
    {
      key: "all",
      label: t("leads.tabs.all"),
      count: tab === "all" && !loading ? total : counts?.all ?? 0,
    },
    {
      key: "waitingToQualify",
      label: "Waiting to qualify",
      count: tab === "waitingToQualify" && !loading ? total : counts?.waitingToQualify ?? 0,
    },
    {
      key: "notEligible",
      label: "Not eligible",
      count: tab === "notEligible" && !loading ? total : counts?.notEligible ?? 0,
    },
  ];

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-900">
          {t("leads.listTitle")}
        </h1>
        <p className="text-sm text-gray-500">
          {t("leads.listSubtitle")}
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <div className="flex gap-1 -mb-px overflow-x-auto">
          {tabs.map((tabDef) => (
            <button
              key={tabDef.key}
              type="button"
              onClick={() => setTab(tabDef.key)}
              className={`px-3 sm:px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === tabDef.key
                  ? "border-[#2E75B6] text-[#2E75B6]"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tabDef.label}
              {tabDef.count > 0 && (
                <span className="ml-1.5 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-600 tabular-nums">
                  {tabDef.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {(tab === null || loading) && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 rounded-xl border border-gray-200 bg-gray-50 animate-pulse" />
          ))}
        </div>
      )}

      {loadError && !loading && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {!loading && !loadError && tab !== null && visibleLeads.length === 0 && (() => {
        // Count-aware empty state: if the active tab is empty but a
        // sibling bucket has leads, route the owner there explicitly so
        // a captured lead doesn't read as "nothing happened."
        const showMyOpenRedirect = tab === "myOpen" && (counts?.unassigned ?? 0) > 0;
        const showUnassignedRedirect = tab === "unassigned" && (counts?.myOpen ?? 0) > 0;
        if (showMyOpenRedirect) {
          return (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center">
              <Inbox className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700">
                {t("leads.empty.myOpenButOtherHas", { count: counts!.unassigned })}
              </p>
              <button
                type="button"
                onClick={() => setTab("unassigned")}
                className="mt-3 inline-flex items-center text-sm font-medium text-[#2E75B6] hover:underline"
              >
                {t("leads.empty.viewUnassigned")}
              </button>
            </div>
          );
        }
        if (showUnassignedRedirect) {
          return (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center">
              <Inbox className="h-10 w-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700">
                {t("leads.empty.unassignedAllClaimed", { count: counts!.myOpen })}
              </p>
              <button
                type="button"
                onClick={() => setTab("myOpen")}
                className="mt-3 inline-flex items-center text-sm font-medium text-[#2E75B6] hover:underline"
              >
                {t("leads.empty.viewMyOpen")}
              </button>
            </div>
          );
        }
        return (
          <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center">
            <Inbox className="h-10 w-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-700">{t("leads.empty.noLeads")}</p>
            <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
              {t("leads.empty.noLeadsHint")}
            </p>
          </div>
        );
      })()}

      {!loading && !loadError && tab !== null && visibleLeads.length > 0 && (
        <div className="space-y-2">
          {visibleLeads.map((lead) => {
            const u = urgencyStyle(lead.urgency);
            const ChannelIcon = channelIcon(lead.preferred_channel);
            return (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="block rounded-xl border border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm transition-all"
              >
                <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                  {/* Avatar / urgency dot */}
                  <div className="flex items-start gap-3 sm:gap-4 flex-1 min-w-0">
                    <div className="relative shrink-0 mt-0.5">
                      <div className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center">
                        <ChannelIcon className="h-5 w-5 text-gray-500" />
                      </div>
                      <span
                        className={`absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white ${u.dot}`}
                        aria-label={t(`leads.urgency.${lead.urgency}`)}
                      />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <p className="text-sm font-semibold text-gray-900 truncate">
                          {lead.contact_name || t("leads.unknownCaller")}
                        </p>
                        {lead.contact_phone && (
                          <a
                            href={`tel:${lead.contact_phone}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              // Phase 3.3: if the WebRTC softphone is
                              // registered, place the call in-browser
                              // instead of handing off to the OS tel:
                              // handler. Non-registered users fall
                              // through to the native handler.
                              if (softphone.status === "registered" && lead.contact_phone) {
                                e.preventDefault();
                                void softphone.callNumber(lead.contact_phone);
                              }
                            }}
                            className="text-xs text-[#2E75B6] hover:underline font-mono"
                          >
                            {lead.contact_phone}
                          </a>
                        )}
                      </div>
                      <p className="text-xs text-gray-600 mt-1 leading-relaxed">
                        {truncate(lead.reason, REASON_PREVIEW_CHARS)}
                      </p>
                      {/* Phase 6.0 — surface the disqualifier label on
                          unqualified rows. Falls back to raw id when the
                          topic config no longer resolves it, so a stale
                          reference is legible instead of blank. */}
                      {lead.qualification_status && lead.qualification_status !== "qualified" && (() => {
                        const label = disqualifierLabel(disqualifierIndex, lead.disqualifier_id);
                        if (!label) return null;
                        const pill =
                          lead.qualification_status === "unqualified_permanent"
                            ? "bg-gray-100 text-gray-600 border-gray-200"
                            : "bg-amber-50 text-amber-800 border-amber-200";
                        return (
                          <span className={`mt-1.5 inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${pill}`}>
                            {label}
                          </span>
                        );
                      })()}
                      <p className="text-[11px] text-gray-400 mt-1.5">
                        {relativeTime(lead.created_at, t)}
                      </p>
                    </div>
                  </div>

                  {/* Pills */}
                  <div className="flex items-center gap-1.5 self-start sm:self-center shrink-0">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full border ${u.pill}`}
                    >
                      {t(`leads.urgency.${lead.urgency}`)}
                    </span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-full border ${statusStyle(lead.status)}`}
                    >
                      {t(`leads.status.${lead.status}`)}
                    </span>
                    <ArrowUpRight className="h-4 w-4 text-gray-300 shrink-0" aria-hidden="true" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
