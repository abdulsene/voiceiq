/**
 * Phase 2.7b — campaign activity table.
 *
 * Extracted from 2.6b's CampaignDetailPage "Recent activity" Card so the
 * detail page can drop its inline copy. Lives on the Reporting tab now.
 *
 * Enhancements over the 2.6b inline version:
 *   - State filter (MultiSelect over the canonical state allowlist)
 *   - Skip-reason filter (MultiSelect populated from the metrics
 *     response's skip_reasons array — limited to what's actually
 *     present in the data, so the dropdown isn't a wall of options)
 *   - Deeper pagination via "Load more" instead of fixed 20-row windows.
 *     Each click appends a fresh page; rows accumulate in component
 *     state so the user doesn't lose scroll position.
 *
 * URL-synced filter state was scoped out per the spec ("defer if scope
 * creeps"). Worth shipping later if ops asks; the contract is small.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import { fetchApi } from "@/lib/api";

interface ActivityRow {
  id: string;
  lead_id: string | null;
  state: string;
  skip_reason: string | null;
  scheduled_call_id: string | null;
  scheduled_for: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  leads?: { contact_name: string | null; contact_phone: string | null } | null;
}

interface ListResponse {
  rows: ActivityRow[];
  total: number;
}

interface RecentActivityTableProps {
  campaignId: string;
  /** Skip-reasons actually present in the data, for the filter dropdown. */
  availableSkipReasons: string[];
}

const ALL_STATES = ["pending", "scheduled", "completed", "succeeded", "failed", "voicemail", "skipped"];
const PAGE_SIZE = 50;

export default function RecentActivityTable({ campaignId, availableSkipReasons }: RecentActivityTableProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<string[]>([]);
  const [skipReasonFilter, setSkipReasonFilter] = useState<string[]>([]);

  const stateOptions: MultiSelectOption[] = useMemo(
    () =>
      ALL_STATES.map((s) => ({
        value: s,
        label: t(`campaigns.junctionState.${s}`, { defaultValue: s }),
      })),
    [t],
  );

  const skipReasonOptions: MultiSelectOption[] = useMemo(
    () =>
      availableSkipReasons.map((r) => ({
        value: r,
        label: t(`campaigns.skipReason.${r}`, { defaultValue: r }),
      })),
    [availableSkipReasons, t],
  );

  // Build the query string. Backend supports single state + single
  // skip_reason (?state=X&skip_reason=Y). Multi-select fires one
  // request when exactly one filter value is selected; multi-value
  // requires client-side post-filter.
  const buildQuery = useCallback(
    (queryOffset: number) => {
      const p = new URLSearchParams();
      p.set("offset", String(queryOffset));
      p.set("limit", String(PAGE_SIZE));
      if (stateFilter.length === 1) p.set("state", stateFilter[0]);
      if (skipReasonFilter.length === 1) p.set("skip_reason", skipReasonFilter[0]);
      return p.toString();
    },
    [stateFilter, skipReasonFilter],
  );

  // Reset and refetch from offset 0 whenever filters change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setOffset(0);
    (async () => {
      try {
        const data = (await fetchApi(`/business/campaigns/${campaignId}/leads?${buildQuery(0)}`)) as ListResponse;
        if (cancelled) return;
        const filtered = postFilter(data.rows, stateFilter, skipReasonFilter);
        setRows(filtered);
        setTotal(data.total ?? 0);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, buildQuery, stateFilter, skipReasonFilter]);

  async function loadMore() {
    if (loadingMore) return;
    setLoadingMore(true);
    const nextOffset = offset + PAGE_SIZE;
    try {
      const data = (await fetchApi(`/business/campaigns/${campaignId}/leads?${buildQuery(nextOffset)}`)) as ListResponse;
      const filtered = postFilter(data.rows, stateFilter, skipReasonFilter);
      setRows((prev) => [...prev, ...filtered]);
      setOffset(nextOffset);
    } catch (e: any) {
      setLoadError(e?.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  const canLoadMore = rows.length > 0 && offset + PAGE_SIZE < total;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("campaigns.reporting.activity.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs text-gray-600 font-medium">{t("campaigns.reporting.activity.filterState")}</p>
            <MultiSelect
              options={stateOptions}
              value={stateFilter}
              onChange={setStateFilter}
              placeholder={t("campaigns.reporting.activity.allStates")}
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs text-gray-600 font-medium">{t("campaigns.reporting.activity.filterSkipReason")}</p>
            <MultiSelect
              options={skipReasonOptions}
              value={skipReasonFilter}
              onChange={setSkipReasonFilter}
              placeholder={t("campaigns.reporting.activity.allReasons")}
            />
          </div>
        </div>

        {loadError && (
          <div className="rounded border border-red-200 bg-red-50 p-3 flex items-start gap-2 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{loadError}</span>
          </div>
        )}

        {loading ? (
          <div className="h-32 bg-gray-50 animate-pulse rounded" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            {t("campaigns.reporting.activity.empty")}
          </p>
        ) : (
          <div className="overflow-hidden rounded border border-gray-200">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.reporting.activity.col.lead")}</th>
                  <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.reporting.activity.col.phone")}</th>
                  <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.reporting.activity.col.state")}</th>
                  <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.reporting.activity.col.skipReason")}</th>
                  <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.reporting.activity.col.scheduledFor")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="px-3 py-1.5">{r.leads?.contact_name || "—"}</td>
                    <td className="px-3 py-1.5 font-mono">{r.leads?.contact_phone || "—"}</td>
                    <td className="px-3 py-1.5">{t(`campaigns.junctionState.${r.state}`, { defaultValue: r.state })}</td>
                    <td className="px-3 py-1.5">
                      {r.skip_reason ? t(`campaigns.skipReason.${r.skip_reason}`, { defaultValue: r.skip_reason }) : "—"}
                    </td>
                    <td className="px-3 py-1.5">{r.scheduled_for ? new Date(r.scheduled_for).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canLoadMore && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {t("campaigns.reporting.activity.showing", { shown: rows.length, total })}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>
              {loadingMore && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t("campaigns.reporting.activity.loadMore")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function postFilter(rows: ActivityRow[], stateFilter: string[], skipReasonFilter: string[]): ActivityRow[] {
  // Single-value filters are pushed server-side via buildQuery — no
  // local work needed. Multi-value filters fall back to client-side
  // post-filter on the page we already fetched.
  if (stateFilter.length <= 1 && skipReasonFilter.length <= 1) return rows;
  return rows.filter((r) => {
    if (stateFilter.length > 1 && !stateFilter.includes(r.state)) return false;
    if (skipReasonFilter.length > 1) {
      if (!r.skip_reason || !skipReasonFilter.includes(r.skip_reason)) return false;
    }
    return true;
  });
}
