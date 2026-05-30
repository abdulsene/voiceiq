-- 011_enterprise_locations.sql
-- Sprint 5 enterprise-readiness STEP 1 — locations table.
--
-- Background:
--   The `locations` table is referenced by 5 endpoints in routes/api.ts
--   (GET/POST/PUT/DELETE /locations + /locations/stats) AND 2 endpoints in
--   routes/enterprise.ts (POST /enterprise/bulk/locations + GET
--   /enterprise/hierarchy). All 7 fail in production today because the
--   table does not exist (PostgREST returns HTTP 404 on /rest/v1/locations).
--
--   A lazy `CREATE TABLE IF NOT EXISTS locations (...)` block already
--   exists at routes/api.ts:6895-6913 — but it lives inside an
--   `ensureUsageTables()`-style helper that has not fired in production
--   (no /locations request has ever succeeded). Pasting this migration
--   into Supabase SQL editor materializes the table once, after which
--   the runtime lazy-create becomes a no-op (CREATE TABLE IF NOT EXISTS
--   is harmless when the table already exists).
--
-- Schema parity:
--   The columns + types + defaults below match routes/api.ts:6895-6909
--   EXACTLY. Do not drift from that schema without also editing api.ts —
--   the lazy-create will silently disagree on first cold start otherwise.
--
--   The enterprise-hierarchy endpoint (routes/enterprise.ts:67-108) does
--   NOT add new columns. It stashes parent_id / level / location_code /
--   managers / customizations inside `business_hours._enterprise` JSONB
--   on purpose — the original design choice was "no schema migration
--   required to start using the API." So this migration only needs the
--   12 columns the runtime actually reads/writes.
--
-- Idempotent — safe to re-run. Same paste-safety pattern as 009
-- (dollar-quoted string literals, IF NOT EXISTS guards, DO blocks
-- around any conditional ALTER).
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

CREATE TABLE IF NOT EXISTS locations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id     TEXT NOT NULL,
  location_name   TEXT NOT NULL,
  address         TEXT,
  phone_number    TEXT,
  agent_id        TEXT,
  agent_name      TEXT DEFAULT 'Alex',
  voice_id        TEXT,
  timezone        TEXT DEFAULT 'America/New_York',
  business_hours  JSONB DEFAULT '{}'::jsonb,
  is_primary      BOOLEAN DEFAULT FALSE,
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Hot-path index. Every query in api.ts + enterprise.ts filters by
-- business_id (multi-tenant scoping). Matches the index already declared
-- in api.ts:6912 so the runtime lazy-create stays a no-op.
CREATE INDEX IF NOT EXISTS idx_locations_biz
  ON locations (business_id);

-- Conditional FK on business_configs(business_id). We can only attach
-- this if business_configs has a UNIQUE or PRIMARY KEY constraint on
-- business_id (PostgreSQL requires the FK target to be uniquely indexed).
-- The constraint is added inside a DO block so the migration succeeds
-- either way — if the unique constraint is missing, the FK is silently
-- skipped and Abdul can add it later after running:
--   ALTER TABLE business_configs
--     ADD CONSTRAINT uq_business_configs_business_id UNIQUE (business_id);
-- followed by re-running this migration.
DO $migration$
BEGIN
  -- Skip if FK already exists (idempotent re-run safety).
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = $name$fk_locations_business_id$name$
      AND conrelid = 'public.locations'::regclass
  ) THEN
    RAISE NOTICE $msg$fk_locations_business_id already exists — skipping$msg$;
    RETURN;
  END IF;

  -- Only attempt the FK if business_configs.business_id has a unique index.
  IF EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'business_configs'
      AND indexdef ILIKE '%UNIQUE%(business_id)%'
  ) OR EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.business_configs'::regclass
      AND contype IN ('p', 'u')
      AND pg_get_constraintdef(oid) ILIKE '%(business_id)%'
  ) THEN
    EXECUTE $sql$
      ALTER TABLE locations
        ADD CONSTRAINT fk_locations_business_id
        FOREIGN KEY (business_id)
        REFERENCES business_configs(business_id)
        ON DELETE CASCADE
    $sql$;
    RAISE NOTICE $msg$fk_locations_business_id added (CASCADE on delete)$msg$;
  ELSE
    RAISE NOTICE $msg$Skipping FK — business_configs.business_id lacks a UNIQUE constraint. Add one and re-run if you want referential integrity.$msg$;
  END IF;
END
$migration$;

-- Service-role only — no app-tenant client should ever read or write
-- this table directly. All access goes through the api-server, which
-- uses SUPABASE_SERVICE_KEY (bypasses RLS) and applies its own
-- business_id scoping per the requireAuth middleware. Same pattern as
-- processed_webhook_events (007) and email_verification_tokens (008).
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

-- Verification — uncomment and run after the CREATE to confirm the
-- table is live and PostgREST has picked it up. Should return zero
-- rows in a fresh deploy (no locations created yet) but no error:
--
-- SELECT COUNT(*) FROM locations;
--
-- And from outside Postgres, this curl should flip from HTTP 404 to
-- HTTP 200 once the migration runs (PostgREST caches schema for ~10s):
--
-- curl -s -o /dev/null -w "%{http_code}\n" \
--   "${SUPABASE_URL}/rest/v1/locations?select=id&limit=1" \
--   -H "apikey: ${SUPABASE_SERVICE_KEY}"
