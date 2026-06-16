-- 034_campaign_metrics_time_series.sql
-- Phase 2.7a — daily time-series aggregation for campaign metrics.
--
-- supabase-js's PostgREST builder cannot express date_trunc, so the
-- 30-day daily-by-state aggregation for the metrics endpoint needs to
-- live in Postgres. Two options were considered:
--   (a) a materialized view of (campaign_id, day, state, count) refreshed
--       on a schedule
--   (b) a parameterised function that groups on demand
-- (b) wins for pilot scale: no view-maintenance cron, no staleness
-- window, single index on (campaign_id, scheduled_for) on the existing
-- outbound_campaign_leads table covers the query. Re-evaluate if cross-
-- campaign rollups land in Phase 3 — at that point a daily view becomes
-- justifiable.
--
-- Behavior:
--   - Returns one row per (day, state) for the last 30 days of
--     outbound_campaign_leads scoped to a single campaign.
--   - Excludes rows with NULL scheduled_for (those represent pending
--     leads that haven't been expanded yet — they count in the totals
--     but don't belong to any calendar day).
--   - 30-day cutoff is computed inside the function so callers don't
--     have to track wall-clock; pilot scale doesn't benefit from making
--     the window configurable.
--
-- SECURITY INVOKER (NOT DEFINER): caller's RLS posture applies. The
-- api-server runs as service_role so it has full access; this function
-- doesn't elevate privileges. The route handler already gates by
-- tenant ownership (SELECT id FROM outbound_campaigns WHERE id=$1
-- AND business_id=$2) before invoking — this RPC is a pure aggregation
-- and never touches tenant identity itself.
--
-- Atomic — wrapped in BEGIN/COMMIT around the CREATE OR REPLACE.
-- Idempotent — CREATE OR REPLACE FUNCTION is re-apply-safe.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

CREATE OR REPLACE FUNCTION campaign_metrics_time_series(
  p_campaign_id UUID
)
RETURNS TABLE(day DATE, state TEXT, count BIGINT)
LANGUAGE sql
SECURITY INVOKER
AS $$
  SELECT
    date_trunc('day', scheduled_for)::date AS day,
    state,
    COUNT(*) AS count
  FROM outbound_campaign_leads
  WHERE campaign_id = p_campaign_id
    AND scheduled_for IS NOT NULL
    AND scheduled_for > NOW() - INTERVAL '30 days'
  GROUP BY 1, 2
  ORDER BY 1 ASC, 2 ASC;
$$;

COMMENT ON FUNCTION campaign_metrics_time_series(UUID) IS
  'Phase 2.7a — returns (day, state, count) rows for the last 30 days of a campaign''s outbound_campaign_leads, grouped by day and state. NULL scheduled_for rows excluded (those are still-pending pre-expansion). SECURITY INVOKER — caller RLS applies; api-server runs as service_role and gates tenant ownership before invoking.';

COMMIT;
