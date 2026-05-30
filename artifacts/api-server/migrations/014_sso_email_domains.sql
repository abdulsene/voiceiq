-- Sprint 5 WorkOS Phase 4 / migration 014
--
-- Adds the SSO domain → connection mapping needed by the public
-- /api/sso/lookup endpoint. The signup page asks the user for their
-- company email, extracts the domain, and looks up the matching
-- business_configs row to find the WorkOS connection_id to redirect to.
--
-- Schema choices:
--   - TEXT[] (Postgres native array) over a separate join table because
--     domains rarely number more than a handful per tenant, lookup is a
--     single GIN-indexed `= ANY` query, and there's no separate metadata
--     per domain (no per-domain "verified" status, no expiry, etc.)
--     that would justify the join table overhead.
--   - GIN index on the array column is what makes the lookup cheap —
--     without it `= ANY(sso_email_domains)` would table-scan every row.
--   - No CHECK constraint on element values: the application layer
--     normalises (lowercase, trim, strip leading dot) and rejects known
--     public-mail providers (gmail.com / outlook.com / etc.) before
--     insert. Pushing that into a CHECK would couple the public-mail
--     deny-list to the schema and require a migration every time the
--     list shifts.
--   - ADD-ONLY: no existing column or constraint is touched. Migration
--     013 added sso_connection_id; this one is fully orthogonal and the
--     two operate together via a coalesce-friendly NULL-by-default
--     pattern (a tenant with no SSO has both columns NULL; a tenant
--     with SSO sets both).
--
-- Rollback: drop column + drop index. Both are IF EXISTS-guarded so the
-- forward and reverse paths can be re-run safely.

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS sso_email_domains TEXT[];

CREATE INDEX IF NOT EXISTS idx_business_configs_sso_email_domains
  ON business_configs USING GIN (sso_email_domains);
