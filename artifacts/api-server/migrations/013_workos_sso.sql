-- 013_workos_sso.sql
-- Sprint 5 WorkOS SSO Phase 2 — link a WorkOS Connection to a tenant.
--
-- Background:
--   Migration 012 already added a generic `sso_config JSONB DEFAULT NULL`
--   column to business_configs. That column is intended for IdP-side
--   metadata that we want to read alongside the rest of the config blob
--   (attribute mappings, JIT-provisioning defaults, etc.).
--
--   This migration adds a SECOND, deliberately separate column —
--   `sso_connection_id TEXT` — for the single WorkOS-side identifier
--   that the SSO callback handler must look up by. We keep it as a
--   first-class top-level column rather than a JSONB extraction for
--   three reasons:
--
--     1. Lookup speed / index. The Phase 3 SSO callback receives a
--        WorkOS connection_id from the IdP and needs to answer "which
--        of our tenants does this belong to?" in O(log n). A B-tree
--        index on a top-level TEXT column is straightforward; an index
--        on `(sso_config->>'connectionId')` works but adds a layer of
--        confusion and a JSONB cast on every query.
--
--     2. Uniqueness invariant. A WorkOS Connection should belong to at
--        most one of our tenants — re-using the same connection_id
--        across two tenants would mean callback ambiguity. We enforce
--        this with a partial UNIQUE index below (partial because the
--        thousands of existing rows have NULL here and NULL ≠ NULL in
--        a unique constraint already, but the partial form makes the
--        intent explicit and cheaper).
--
--     3. Separation of concerns. `sso_config` may evolve into a complex
--        IdP-settings blob (claim mappings, role rules, etc.). Pulling
--        the connection identifier out keeps the blob purely about
--        "how to interpret the IdP's payload" and the connection_id
--        purely about "which IdP."
--
-- Idempotent — safe to re-run. ADD COLUMN IF NOT EXISTS + CREATE INDEX
-- IF NOT EXISTS. No data is rewritten; existing rows acquire the new
-- column with NULL and no SSO behavior changes for them.
--
-- Same paste-safety pattern as 009/011/012 — every multi-word string
-- literal is dollar-quoted so smart-quote conversion in the SQL editor
-- cannot mangle string boundaries.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

-- ───────────────────────────────────────────────────────────────────────
-- 1. Add the WorkOS connection-id column. Nullable, no default — a
--    NULL value means "this tenant has no SSO connection wired up,"
--    which is the correct state for every existing row.
-- ───────────────────────────────────────────────────────────────────────

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS sso_connection_id TEXT DEFAULT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 2. Enforce one-tenant-per-WorkOS-connection. Partial unique index so
--    the thousands of existing NULL rows aren't constrained against
--    each other. WHERE NOT NULL is also the correct semantics — two
--    tenants both having "no SSO" is fine; two tenants pointing at the
--    same connection is not.
-- ───────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_configs_sso_connection_id
  ON business_configs (sso_connection_id)
  WHERE sso_connection_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- 3. Verification (run in psql / SQL editor after applying):
--
--   -- Column exists, is TEXT, is nullable
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'business_configs'
--     AND column_name = 'sso_connection_id';
--
--   -- Partial unique index exists with the expected predicate
--   SELECT indexname, indexdef
--   FROM pg_indexes
--   WHERE tablename = 'business_configs'
--     AND indexname = 'uq_business_configs_sso_connection_id';
--
--   -- Smoke: sample row should now show the new column as NULL
--   curl -s "${SUPABASE_URL}/rest/v1/business_configs?select=business_id,sso_connection_id&limit=1" \
--     -H "apikey: ${SUPABASE_SERVICE_KEY}"
-- ───────────────────────────────────────────────────────────────────────
