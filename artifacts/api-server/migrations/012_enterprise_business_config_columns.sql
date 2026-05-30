-- 012_enterprise_business_config_columns.sql
-- Sprint 5 enterprise-readiness STEP 2 — extend business_configs with the
-- 9 columns the enterprise.ts handlers + auth.ts hydration need.
--
-- Background:
--   routes/enterprise.ts handlers currently try to write enterprise config
--   to a `businesses` table that does not exist in production (PostgREST
--   confirms PGRST205 on /rest/v1/businesses). Phase 2 of tonight's work
--   repoints those writes to business_configs, but business_configs lacks
--   the destination columns. This migration adds them so Phase 2 has
--   somewhere to land.
--
--   routes/auth.ts:285-296 currently hydrates only {tier: row.plan_id}
--   into req.businessConfig. enterpriseIPFilter middleware reads
--   req.businessConfig.ipWhitelist — which is always undefined today.
--   Phase 3 expands the SELECT and the hydrated object; this migration
--   adds the source columns.
--
-- Design choices:
--   * enterprise_config is the catch-all JSONB blob (matches what the
--     legacy `businesses.enterprise_config` field was meant to hold).
--     Default '{}' instead of NULL so handlers can always do
--     enterprise_config->'foo' without a NULL check.
--   * branding_config / security_policy / sso_config default to NULL —
--     "no enterprise contract" is meaningfully different from
--     "enterprise contract with empty branding". NULL preserves that.
--   * ip_whitelist is JSONB (not TEXT[]) to match how the dashboard
--     submits it (JSON array of CIDR strings) and how enterpriseIPFilter
--     consumes it (Array.isArray check).
--   * sla_level + isolation_model are TEXT with CHECK constraints
--     matching the documented enum values. Constraints added inside DO
--     blocks so they're idempotent and don't break re-runs.
--   * sso_config is added now (defaulting to NULL, unused tonight) so
--     Saturday's WorkOS work doesn't require a second migration.
--   * parent_business_id is TEXT (not UUID) because business_id itself
--     is TEXT in business_configs — referential consistency.
--
-- Idempotent — safe to re-run. ADD COLUMN IF NOT EXISTS is supported on
-- PostgreSQL 9.6+ (Supabase runs 15.x). Same paste-safety pattern as
-- 009/011 — every multi-word literal is dollar-quoted so smart-quote
-- conversion in the SQL editor cannot mangle string boundaries.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

-- ───────────────────────────────────────────────────────────────────────
-- 1. Add the 9 new columns. All nullable / all defaulted — existing rows
--    are not rewritten and no app path that reads business_configs will
--    regress.
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS enterprise_config    JSONB   DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS branding_config      JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS security_policy      JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ip_whitelist         JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS mfa_required         BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sla_level            TEXT    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS isolation_model      TEXT    DEFAULT 'shared',
  ADD COLUMN IF NOT EXISTS sso_config           JSONB   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS parent_business_id   TEXT    DEFAULT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 2. CHECK constraint on sla_level — only the documented enum values
--    are accepted. NULL is allowed (means "no SLA negotiated").
-- ───────────────────────────────────────────────────────────────────────

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = $name$chk_business_configs_sla_level$name$
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    RAISE NOTICE $msg$chk_business_configs_sla_level already exists — skipping$msg$;
  ELSE
    EXECUTE $sql$
      ALTER TABLE business_configs
        ADD CONSTRAINT chk_business_configs_sla_level
        CHECK (sla_level IS NULL OR sla_level IN ('standard', 'enterprise', 'custom'))
    $sql$;
    RAISE NOTICE $msg$chk_business_configs_sla_level added$msg$;
  END IF;
END
$migration$;

-- ───────────────────────────────────────────────────────────────────────
-- 3. CHECK constraint on isolation_model — only the documented enum
--    values are accepted. NULL not allowed because column has a default.
-- ───────────────────────────────────────────────────────────────────────

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = $name$chk_business_configs_isolation_model$name$
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    RAISE NOTICE $msg$chk_business_configs_isolation_model already exists — skipping$msg$;
  ELSE
    EXECUTE $sql$
      ALTER TABLE business_configs
        ADD CONSTRAINT chk_business_configs_isolation_model
        CHECK (isolation_model IN ('shared', 'dedicated'))
    $sql$;
    RAISE NOTICE $msg$chk_business_configs_isolation_model added$msg$;
  END IF;
END
$migration$;

-- ───────────────────────────────────────────────────────────────────────
-- 4. Partial index on parent_business_id — supports the franchise
--    hierarchy walk in routes/enterprise.ts:67-108 without bloating the
--    index for the 99%+ of rows where parent_business_id IS NULL.
-- ───────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_business_configs_parent_id
  ON business_configs (parent_business_id)
  WHERE parent_business_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- Verification — uncomment after running to confirm all 9 columns + 2
-- constraints + 1 index exist:
--
-- SELECT column_name, data_type, column_default, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND table_name = 'business_configs'
--   AND column_name IN (
--     'enterprise_config','branding_config','security_policy',
--     'ip_whitelist','mfa_required','sla_level','isolation_model',
--     'sso_config','parent_business_id'
--   )
-- ORDER BY column_name;
--
-- SELECT conname, pg_get_constraintdef(oid)
-- FROM pg_constraint
-- WHERE conrelid = 'public.business_configs'::regclass
--   AND conname LIKE 'chk_business_configs_%';
--
-- SELECT indexname, indexdef FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'business_configs'
--   AND indexname = 'idx_business_configs_parent_id';
--
-- And from outside Postgres, this should now return rows (instead of
-- the 42703 "column does not exist" error):
--
-- curl -s "${SUPABASE_URL}/rest/v1/business_configs?select=business_id,enterprise_config,sla_level,isolation_model&limit=1" \
--   -H "apikey: ${SUPABASE_SERVICE_KEY}"
