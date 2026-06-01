-- Sprint 2 / migration 019
--
-- reconciliation_reports table.
--
-- Twilio number reconciliation (artifacts/api-server/src/lib/twilio-reconciliation.ts)
-- runs nightly to catch the audit risk #3 money-leak class:
--
--   - "orphans"  DIDs that exist on Twilio's side but are not
--                referenced by any business_configs row. Caused by
--                process-death between IncomingPhoneNumbers.create
--                and markProvisioned, or by other lost-race scenarios
--                that escape the application-side rollback.
--   - "ghosts"   DIDs that the DB still references but no longer
--                exist on Twilio (admin manually released without
--                clearing the DB, billing dispute, etc.). Less
--                expensive than orphans (no Twilio charge) but still
--                represents corrupted DB state that breaks call
--                routing.
--
-- Each reconciliation run persists one row here so we have an audit
-- trail of what was found / released, and so the admin endpoint can
-- show "last 30 runs" without having to re-walk Twilio's API on every
-- dashboard load.
--
-- orphans_details and ghosts_details are JSONB arrays of per-resource
-- detail objects — see the Orphan / Ghost interfaces in
-- twilio-reconciliation.ts for the exact shapes.
--
-- errors JSONB captures per-stage failures (Twilio list timed out,
-- Supabase select failed, etc.) without aborting the run. Partial
-- reports are still useful for ops triage.
--
-- Idempotent — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
-- EXISTS. No CHECK constraints / DO-blocks needed at this stage.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.
--
-- Postgres 17 (this DB) ships gen_random_uuid() in the core
-- distribution; no pgcrypto extension required.

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  run_duration_ms               INTEGER,
  twilio_numbers_count          INTEGER NOT NULL DEFAULT 0,
  db_numbers_count              INTEGER NOT NULL DEFAULT 0,
  orphans_count                 INTEGER NOT NULL DEFAULT 0,
  ghosts_count                  INTEGER NOT NULL DEFAULT 0,
  orphans_auto_released_count   INTEGER NOT NULL DEFAULT 0,
  orphans_details               JSONB NOT NULL DEFAULT '[]'::jsonb,
  ghosts_details                JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors                        JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                         TEXT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_run_at
  ON reconciliation_reports (run_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only). Three separate SELECTs so each result is
-- distinct in the SQL editor; the admin path doesn't depend on these
-- — they're for post-apply confirmation only.

SELECT
  'table exists' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reconciliation_reports'
  ) AS result;

SELECT
  'index exists' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_reconciliation_reports_run_at'
  ) AS result;

SELECT
  'initial row count' AS check_name,
  count(*) AS result
FROM reconciliation_reports;

-- Tell PostgREST to reload its schema cache so the new table is
-- queryable via the auto-generated REST API immediately.
NOTIFY pgrst, 'reload schema';
