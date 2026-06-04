-- Sprint 3 Stage 1 / migration 021
--
-- Create prompt_audit_log table for tracking every change to a
-- business's AI receptionist prompt (system_prompt / _fr / _es on
-- business_configs, added in migration 020).
--
-- Every dashboard-driven edit, "Regenerate from helpers" click,
-- admin override, and one-off backfill writes a row here. The
-- old_prompt / new_prompt columns let us diff history and offer an
-- undo flow later if needed.
--
-- sync_to_elevenlabs_ok captures whether the matching ElevenLabs
-- PATCH succeeded:
--   NULL  = pending (write hasn't happened yet, or async sync not
--           yet attempted)
--   true  = PATCH succeeded (or, for backfill, the prompt was
--           pulled FROM ElevenLabs and DB now matches)
--   false = PATCH failed; elevenlabs_error has the detail
--
-- source enumerates *where* the change originated:
--   owner_raw            customer edited the raw textarea directly
--   owner_helpers_regen  customer hit "Regenerate from helpers"
--   admin_raw            staff/admin override
--   backfill             one-off ingest from ElevenLabs (script)
--   system               other system-initiated writes (reserved)
--
-- language ('en' / 'fr' / 'es') tracks which per-language prompt the
-- row mutated. Default 'en' because that's the only language
-- targeted in Sprint 3 Stage 1 and beyond it covers the vast
-- majority of writes.
--
-- Audit rows are bound to their business via FK CASCADE. If a business
-- is hard-deleted (rare; soft-delete is preferred), its audit history
-- is removed too. This prevents orphaned audit rows that can't be
-- reconstructed back to a business identity.
--
-- Idempotent — CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT
-- EXISTS. CHECK constraints are scoped via conrelid lookups (same
-- pattern as migrations 016, 017, 018).
--
-- Postgres 17 ships gen_random_uuid() in core — no pgcrypto needed.
--
-- Run via Supabase MCP apply_migration on project zqhijauefcpwggklshoa.

CREATE TABLE IF NOT EXISTS prompt_audit_log (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id              VARCHAR(255) NOT NULL,
  changed_by_user_id       UUID,
  changed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  language                 VARCHAR(8) NOT NULL DEFAULT 'en',
  source                   VARCHAR(32) NOT NULL,
  old_prompt               TEXT,
  new_prompt               TEXT NOT NULL,
  sync_to_elevenlabs_ok    BOOLEAN,
  elevenlabs_error         TEXT,
  ip_address               VARCHAR(45),
  user_agent               TEXT
);

CREATE INDEX IF NOT EXISTS idx_prompt_audit_log_business_changed
  ON prompt_audit_log (business_id, changed_at DESC);

-- FK to business_configs.business_id with ON DELETE CASCADE.
-- Wrapped in a DO-block so the migration stays idempotent if a
-- prior partial-apply created the table without the FK.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prompt_audit_log_business_id_fkey'
      AND conrelid = 'public.prompt_audit_log'::regclass
  ) THEN
    ALTER TABLE prompt_audit_log
      ADD CONSTRAINT prompt_audit_log_business_id_fkey
      FOREIGN KEY (business_id)
      REFERENCES business_configs(business_id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- CHECK constraint: language must be one of the supported codes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prompt_audit_log_language_check'
      AND conrelid = 'public.prompt_audit_log'::regclass
  ) THEN
    ALTER TABLE prompt_audit_log
      ADD CONSTRAINT prompt_audit_log_language_check
      CHECK (language IN ('en', 'fr', 'es'));
  END IF;
END $$;

-- CHECK constraint: source must be one of the enumerated origin tags.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prompt_audit_log_source_check'
      AND conrelid = 'public.prompt_audit_log'::regclass
  ) THEN
    ALTER TABLE prompt_audit_log
      ADD CONSTRAINT prompt_audit_log_source_check
      CHECK (source IN (
        'owner_raw',
        'owner_helpers_regen',
        'admin_raw',
        'backfill',
        'system'
      ));
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only, three separate SELECTs).

SELECT
  'table exists' AS check_name,
  EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'prompt_audit_log'
  ) AS result;

SELECT
  'index exists' AS check_name,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_prompt_audit_log_business_changed'
  ) AS result;

SELECT
  'initial row count' AS check_name,
  count(*) AS result
FROM prompt_audit_log;

-- Tell PostgREST to reload its schema cache so the new table is
-- queryable via the auto-generated REST API immediately.
NOTIFY pgrst, 'reload schema';
