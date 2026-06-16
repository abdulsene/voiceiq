/**
 * Phase 2.6b — Campaigns list page.
 *
 * GET /api/business/campaigns?offset&limit&status returns a paginated
 * list of outbound_campaigns for the active tenant. Server-side route
 * is mounted in routes/campaigns.ts; the response shape is
 *   { campaigns: Campaign[]; total: number }
 *
 * "Create draft" POSTs a minimal payload (name, call_objective, status)
 * + a default tomorrow-noon bulk schedule so the next page (detail) has
 * something to bind to without empty-state UI quirks. Server returns
 * the created row including its id; we navigate straight to it.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, Link } from "wouter";
import { AlertTriangle, Megaphone, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import { defaultBulkSchedule } from "@/components/ScheduleBuilder";

type Status = "draft" | "queued" | "active" | "paused" | "completed" | "cancelled" | string;

interface Campaign {
  id: string;
  business_id: string;
  name: string;
  call_objective: string;
  status: Status;
  agent_id: string | null;
  target_count: number | null;
  completed_count: number | null;
  succeeded_count: number | null;
  failed_count: number | null;
  voicemail_count: number | null;
  daily_cap: number | null;
  voicemail_text_override: string | null;
  schedule_strategy: string | null;
  last_expansion_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ListResponse {
  campaigns: Campaign[];
  total: number;
}

const PAGE_SIZE = 25;

function statusStyle(s: Status): string {
  switch (s) {
    case "draft": return "bg-gray-100 text-gray-700 border-gray-200";
    case "queued": return "bg-blue-50 text-blue-700 border-blue-200";
    case "active": return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "paused": return "bg-amber-50 text-amber-700 border-amber-200";
    case "completed": return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "cancelled": return "bg-red-50 text-red-700 border-red-200";
    default: return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function relTime(iso: string | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
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

export default function CampaignsListPage() {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const initialOffset = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const o = parseInt(p.get("offset") || "0", 10);
    return Number.isFinite(o) && o >= 0 ? o : 0;
  }, []);
  const initialStatus = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get("status") || "";
  }, []);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(initialOffset);
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Stale-response guard — see BusinessesList convention.
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const p = new URLSearchParams();
        p.set("offset", String(offset));
        p.set("limit", String(PAGE_SIZE));
        if (statusFilter) p.set("status", statusFilter);
        const data = (await fetchApi(`/business/campaigns?${p.toString()}`)) as ListResponse;
        if (cancelled || seq !== fetchSeqRef.current) return;
        setCampaigns(data.campaigns || []);
        setTotal(data.total ?? data.campaigns?.length ?? 0);
        // Reflect filters in URL — bookmarkable, back-button-friendly.
        const url = new URL(window.location.href);
        if (offset > 0) url.searchParams.set("offset", String(offset));
        else url.searchParams.delete("offset");
        if (statusFilter) url.searchParams.set("status", statusFilter);
        else url.searchParams.delete("status");
        window.history.replaceState(null, "", url.toString());
      } catch (e: any) {
        if (cancelled || seq !== fetchSeqRef.current) return;
        setLoadError(e?.message || String(e));
      } finally {
        if (!cancelled && seq === fetchSeqRef.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [offset, statusFilter]);

  async function handleCreateDraft() {
    if (creating) return;
    setCreating(true);
    setLoadError(null);
    try {
      const body = {
        name: t("campaigns.list.untitledName"),
        call_objective: "appointment_reminder",
        status: "draft",
        segment_definition: { version: 1, filters: { all: [], any: [] } },
        schedule_definition: defaultBulkSchedule(),
        schedule_strategy: "bulk",
      };
      const resp = (await fetchApi("/business/campaigns", {
        method: "POST",
        body: JSON.stringify(body),
      })) as { campaign: Campaign };
      if (resp?.campaign?.id) {
        setLocation(`/campaigns/${resp.campaign.id}`);
        return;
      }
      setLoadError(t("campaigns.list.createFailed"));
    } catch (e: any) {
      setLoadError(e?.message || t("campaigns.list.createFailed"));
    } finally {
      setCreating(false);
    }
  }

  const hasNext = offset + PAGE_SIZE < total;
  const hasPrev = offset > 0;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-gray-900">
            {t("campaigns.list.title")}
          </h1>
          <p className="text-sm text-gray-500">{t("campaigns.list.subtitle")}</p>
        </div>
        <Button
          type="button"
          onClick={handleCreateDraft}
          disabled={creating}
          className="bg-[#2E75B6] hover:bg-[#256094]"
        >
          <Plus className="h-4 w-4 mr-1" />
          {t("campaigns.list.createDraft")}
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-600">
          {t("campaigns.list.filterStatus")}
        </label>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
          className="text-sm border border-gray-300 rounded-md px-2 py-1 bg-white"
        >
          <option value="">{t("campaigns.list.statusAll")}</option>
          <option value="draft">{t("campaigns.status.draft")}</option>
          <option value="queued">{t("campaigns.status.queued")}</option>
          <option value="active">{t("campaigns.status.active")}</option>
          <option value="paused">{t("campaigns.status.paused")}</option>
          <option value="completed">{t("campaigns.status.completed")}</option>
          <option value="cancelled">{t("campaigns.status.cancelled")}</option>
        </select>
      </div>

      {loading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-xl border border-gray-200 bg-gray-50 animate-pulse" />
          ))}
        </div>
      )}

      {loadError && !loading && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
      )}

      {!loading && !loadError && campaigns.length === 0 && (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-6 py-12 text-center">
          <Megaphone className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-700">{t("campaigns.list.empty.title")}</p>
          <p className="text-xs text-gray-500 mt-1">{t("campaigns.list.empty.hint")}</p>
          <Button
            type="button"
            onClick={handleCreateDraft}
            disabled={creating}
            className="mt-4 bg-[#2E75B6] hover:bg-[#256094]"
          >
            <Plus className="h-4 w-4 mr-1" />
            {t("campaigns.list.createDraft")}
          </Button>
        </div>
      )}

      {!loading && !loadError && campaigns.length > 0 && (
        <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr className="text-left text-xs text-gray-500">
                <th className="px-4 py-2 font-medium">{t("campaigns.list.col.name")}</th>
                <th className="px-4 py-2 font-medium">{t("campaigns.list.col.status")}</th>
                <th className="px-4 py-2 font-medium">{t("campaigns.list.col.objective")}</th>
                <th className="px-4 py-2 font-medium text-right">{t("campaigns.list.col.target")}</th>
                <th className="px-4 py-2 font-medium text-right">{t("campaigns.list.col.completed")}</th>
                <th className="px-4 py-2 font-medium">{t("campaigns.list.col.lastExpansion")}</th>
                <th className="px-4 py-2 font-medium">{t("campaigns.list.col.created")}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer">
                  <td className="px-4 py-2 font-medium text-gray-900">
                    <Link href={`/campaigns/${c.id}`} className="hover:underline text-[#2E75B6]">
                      {c.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border font-medium ${statusStyle(c.status)}`}>
                      {t(`campaigns.status.${c.status}`, c.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{c.call_objective}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{c.target_count ?? 0}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{c.completed_count ?? 0}</td>
                  <td className="px-4 py-2 text-gray-600">{relTime(c.last_expansion_at, t)}</td>
                  <td className="px-4 py-2 text-gray-600">{fmtDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !loadError && total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>
            {t("campaigns.list.showingRange", {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, total),
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={!hasPrev}
            >
              {t("campaigns.list.prev")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={!hasNext}
            >
              {t("campaigns.list.next")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
