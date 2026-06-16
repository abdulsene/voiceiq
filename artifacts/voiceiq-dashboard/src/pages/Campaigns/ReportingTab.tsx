/**
 * Phase 2.7b — Reporting tab of the campaign detail page.
 *
 * Owns the GET /api/business/campaigns/:id/metrics fetch, holds the
 * response in state, and distributes pieces of it to the child viz
 * components. Fetch is lazy: ReportingTab only mounts when its tab is
 * active (via Tabs' content rendering), and refetches on focus when
 * the cached data is older than FRESH_THRESHOLD_MS.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";
import {
  CounterCards,
  CsvExportButton,
  RecentActivityTable,
  SkipReasonPareto,
  StateDistributionDonut,
  TimeSeriesChart,
  type CampaignMetricsResponse,
} from "@/components/Reporting";

interface ReportingTabProps {
  campaignId: string;
  campaignName: string;
}

const FRESH_THRESHOLD_MS = 30_000;

export default function ReportingTab({ campaignId, campaignName }: ReportingTabProps) {
  const { t } = useTranslation();
  const [metrics, setMetrics] = useState<CampaignMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const fetchSeqRef = useRef(0);

  const fetchMetrics = useCallback(async () => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const data = (await fetchApi(`/business/campaigns/${campaignId}/metrics`)) as {
        metrics: CampaignMetricsResponse;
      };
      if (seq !== fetchSeqRef.current) return;
      setMetrics(data.metrics);
      setLastFetchedAt(Date.now());
    } catch (e: any) {
      if (seq !== fetchSeqRef.current) return;
      setLoadError(e?.message || String(e));
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  // Refetch on tab focus when the cached data is stale enough that the
  // user might have walked away and back. Cheap freshness; same idea as
  // TanStack Query's refetchOnWindowFocus default behavior.
  useEffect(() => {
    function onVis() {
      if (document.visibilityState !== "visible") return;
      if (lastFetchedAt && Date.now() - lastFetchedAt < FRESH_THRESHOLD_MS) return;
      fetchMetrics();
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [fetchMetrics, lastFetchedAt]);

  const lastUpdatedLabel = lastFetchedAt
    ? t("campaigns.reporting.lastUpdated", { when: new Date(lastFetchedAt).toLocaleTimeString() })
    : "";

  const availableSkipReasons = metrics?.skip_reasons.map((r) => r.reason) ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500">{lastUpdatedLabel}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={fetchMetrics} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1.5" />
            )}
            {t("campaigns.reporting.refresh")}
          </Button>
          <CsvExportButton campaignId={campaignId} campaignName={campaignName} />
        </div>
      </div>

      {loadError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={fetchMetrics}
              className="mt-2"
            >
              {t("campaigns.reporting.retry")}
            </Button>
          </div>
        </div>
      )}

      {loading && !metrics && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-xl bg-gray-50 animate-pulse" />
            ))}
          </div>
          <div className="h-64 rounded-xl bg-gray-50 animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="h-64 rounded-xl bg-gray-50 animate-pulse" />
            <div className="h-64 rounded-xl bg-gray-50 animate-pulse" />
          </div>
        </div>
      )}

      {metrics && (
        <>
          <CounterCards counters={metrics.counters} rates={metrics.rates} />
          <TimeSeriesChart data={metrics.time_series} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <StateDistributionDonut data={metrics.state_distribution} />
            <SkipReasonPareto data={metrics.skip_reasons} />
          </div>
          <RecentActivityTable
            campaignId={campaignId}
            availableSkipReasons={availableSkipReasons}
          />
        </>
      )}
    </div>
  );
}
