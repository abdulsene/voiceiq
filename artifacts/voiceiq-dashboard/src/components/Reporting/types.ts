/**
 * Phase 2.7b — Reporting shared types. Mirrors the server response
 * shape from GET /api/business/campaigns/:id/metrics
 * (artifacts/api-server/src/routes/campaigns.ts).
 */

export interface CampaignMetricsCounters {
  target: number;
  pending: number;
  scheduled: number;
  completed: number;
  succeeded: number;
  failed: number;
  voicemail: number;
  skipped: number;
}

export interface CampaignMetricsRates {
  connect_rate: number;
  voicemail_rate: number;
  skip_rate: number;
  completion_rate: number;
}

export interface CampaignMetricsTimeSeriesRow {
  date: string;
  scheduled: number;
  succeeded: number;
  failed: number;
  voicemail: number;
  skipped: number;
}

export interface CampaignMetricsResponse {
  campaign_id: string;
  counters: CampaignMetricsCounters;
  rates: CampaignMetricsRates;
  time_series: CampaignMetricsTimeSeriesRow[];
  skip_reasons: Array<{ reason: string; count: number }>;
  state_distribution: Array<{ state: string; count: number }>;
}

/** Brand-aligned color tokens for chart series. Match Tailwind palette. */
export const STATE_COLORS: Record<string, string> = {
  pending: "#9ca3af",
  scheduled: "#2E75B6",
  completed: "#6366f1",
  succeeded: "#10b981",
  failed: "#ef4444",
  voicemail: "#f59e0b",
  skipped: "#6b7280",
};

export function formatPct(rate: number): string {
  if (!Number.isFinite(rate)) return "0%";
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString();
}
