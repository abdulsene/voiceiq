-- 033_delete_campaign_with_cancellations.sql
-- Phase 2.6a — atomic campaign deletion with scheduled-call cancellation.
--
-- Plain DELETE on outbound_campaigns cascades junction rows but leaves
-- already-scheduled lead_calls behind as zombies — the 1.5b fire-time
-- worker would still fire them. The supabase-js client has no transaction
-- API surface, so doing this as two separate UPDATE + DELETE calls from
-- the api-server leaves a tiny race window where a concurrent expansion
-- tick could insert NEW scheduled rows between our UPDATE and DELETE.
--
-- This function bundles the operations in a single SQL transaction with
-- a SELECT FOR UPDATE row-lock at the top, guaranteeing atomicity. The
-- api-server's DELETE handler calls this via supabase.rpc(...).
--
-- Behavior:
--   1. SELECT FOR UPDATE on outbound_campaigns(id, business_id) — locks
--      the campaign row. If no row matches (already deleted OR wrong
--      tenant), return an empty result set (caller maps to 404).
--   2. UPDATE lead_calls SET status='canceled',
--      end_reason='campaign_deleted', ended_at=NOW() WHERE id IN
--      (SELECT scheduled_call_id FROM outbound_campaign_leads WHERE
--      campaign_id=$1 AND state='scheduled' AND scheduled_call_id IS NOT
--      NULL). Captures affected row count via GET DIAGNOSTICS.
--   3. COUNT junction rows about to be cascaded (separate count because
--      cascade happens during step 4 — can't easily capture via
--      GET DIAGNOSTICS from a foreign-key-triggered cascade).
--   4. DELETE FROM outbound_campaigns WHERE id=$1 AND business_id=$2 —
--      ON DELETE CASCADE on outbound_campaign_leads.campaign_id wipes
--      junction rows (see migration 032).
--   5. RETURN QUERY { canceled_call_count, deleted_junction_count } so
--      the success toast can report "Canceled X scheduled calls."
--
-- SECURITY INVOKER (NOT DEFINER): the caller's RLS posture applies. The
-- api-server uses service_role so it has full access; this function
-- doesn't elevate privileges. If a future caller is RLS-constrained, the
-- function naturally respects their access — no unintended back door.
--
-- Atomic — wrapped in BEGIN/COMMIT around the CREATE OR REPLACE.
-- Idempotent — CREATE OR REPLACE FUNCTION is re-apply-safe.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

CREATE OR REPLACE FUNCTION delete_campaign_with_cancellations(
  p_campaign_id UUID,
  p_business_id TEXT
)
RETURNS TABLE(canceled_call_count INT, deleted_junction_count INT)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_canceled INT;
  v_deleted_junctions INT;
BEGIN
  -- (1) Lock the campaign row, cross-tenant scoped. If no row matches,
  --     return empty result set — caller maps to 404.
  PERFORM 1 FROM outbound_campaigns
    WHERE id = p_campaign_id AND business_id = p_business_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- (2) Cancel any 'scheduled' lead_calls owned by this campaign.
  UPDATE lead_calls
    SET status = 'canceled',
        end_reason = 'campaign_deleted',
        ended_at = NOW()
    WHERE id IN (
      SELECT scheduled_call_id
      FROM outbound_campaign_leads
      WHERE campaign_id = p_campaign_id
        AND state = 'scheduled'
        AND scheduled_call_id IS NOT NULL
    );
  GET DIAGNOSTICS v_canceled = ROW_COUNT;

  -- (3) Count junction rows about to be cascaded so we can return the
  --     count in the result. ON DELETE CASCADE handles the actual delete
  --     in step (4); GET DIAGNOSTICS on the DELETE wouldn't capture the
  --     cascade.
  SELECT COUNT(*)::INT INTO v_deleted_junctions
    FROM outbound_campaign_leads
    WHERE campaign_id = p_campaign_id;

  -- (4) Delete the campaign. Cascade wipes junction rows.
  DELETE FROM outbound_campaigns
    WHERE id = p_campaign_id
      AND business_id = p_business_id;

  RETURN QUERY SELECT v_canceled, v_deleted_junctions;
END;
$$;

COMMENT ON FUNCTION delete_campaign_with_cancellations(UUID, TEXT) IS
  'Phase 2.6a — atomic campaign deletion. Locks the campaign row, cancels any scheduled lead_calls, then DELETEs the campaign (cascade wipes outbound_campaign_leads). Returns counts for the success toast. Returns an empty result set if the campaign does not exist (caller maps to 404). SECURITY INVOKER — caller RLS applies; api-server runs as service_role.';

COMMIT;
