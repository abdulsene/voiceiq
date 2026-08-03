-- 050_deprecate_dead_call_columns.sql
-- Phase 4.4 — mark unused analysis columns as deprecated in DB metadata.
--
-- The Phase 4.3 audit found four columns on `calls` that are 0/45
-- populated across all real production rows. The Phase 4.4 detail
-- page does not render them. Their existence should not encourage
-- future writers to populate them without a real product decision.
--
-- We DO NOT drop the columns:
--   - They cost nothing at rest.
--   - Dropping is destructive; if a future product decision revives
--     one of these ideas, keeping the column preserves any orphan
--     historical data + saves a re-add migration.
--   - Comments are grep-able / show up in the Supabase table editor
--     which is where anyone considering renderer work will look.
--
-- The satisfaction_rating column is separately reserved for the
-- (as-yet-unbuilt) post-call survey — commented in migration 048.
-- This migration only touches columns that have NO product use.
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- No data change; no CHECK constraint change; only COMMENT ON COLUMN.
-- Verify:
--   SELECT column_name, col_description('calls'::regclass, ordinal_position)
--     FROM information_schema.columns
--    WHERE table_name = 'calls'
--      AND column_name IN ('cultural_profile', 'was_coached',
--                          'coaching_session_id', 'competitor_mentioned');

BEGIN;

COMMENT ON COLUMN calls.cultural_profile IS
  'DEPRECATED (Phase 4.4): 0/45 populated in production, no ingest path. NOT rendered on the call detail page. Retained on-disk to preserve any historical data and to avoid a destructive drop; do NOT populate without a product decision to revive this signal.';

COMMENT ON COLUMN calls.was_coached IS
  'DEPRECATED (Phase 4.4): 0/45 populated in production. Live-coaching feature never shipped past the schema. NOT rendered. See migration 050 header.';

COMMENT ON COLUMN calls.coaching_session_id IS
  'DEPRECATED (Phase 4.4): 0/45 populated. Companion to was_coached; see migration 050 header.';

COMMENT ON COLUMN calls.competitor_mentioned IS
  'DEPRECATED (Phase 4.4): 0/45 populated. Competitor-detection analysis never shipped. NOT rendered. See migration 050 header.';

COMMIT;
