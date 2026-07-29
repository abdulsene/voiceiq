-- 038_business_hours.sql
-- Phase 3.1a — structured business hours per (business, day_of_week).
--
-- Today business_configs.business_hours is free-form TEXT ("Monday-Friday
-- 9AM-5PM", "9-5", "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 4:00 PM", ...).
-- The Phase 3.1 after-hours logic + Phase 3.2 routing engine need a
-- programmatic "is the business open right now?" answer, which requires
-- structured storage. This migration adds the structured table but does
-- NOT drop the free-form column — that's a Phase 3.1b UI concern (deprecate
-- from settings, keep column as legacy for a future cleanup migration).
--
-- Shape decisions:
--   * (business_id, day_of_week) UNIQUE — one row per weekday. Simpler than
--     a general (start, end) interval table; the real product surface is
--     the classic "9-5 Mon-Fri" schedule with per-day overrides.
--   * day_of_week SMALLINT 0-6 with 0=Sunday, matching JavaScript
--     Date.getDay() and PostgreSQL EXTRACT(DOW FROM ...) so the "is open
--     right now?" query has no offset math. (ISO 8601 uses 1=Monday
--     ... 7=Sunday — deliberately not used here to keep the JS/PG
--     mapping trivial.)
--   * opens_at / closes_at are TIME (no date component). Timezone lives
--     on the row (per-day) rather than on business_configs so different
--     locations of a multi-location enterprise (migration 011) can
--     eventually carry different timezones per day-row. For Phase 3.1a
--     the routes will always write the same timezone across the 7 rows.
--   * is_closed BOOLEAN with a CHECK constraint enforcing the invariant
--     "is_closed = true ⇒ opens_at IS NULL AND closes_at IS NULL, and
--      is_closed = false ⇒ both times NOT NULL." No accidental
--     half-configured rows.
--
-- updated_at auto-bump via trigger_set_updated_at() (from migration 030).
--
-- RLS enabled with no policies. Same posture as staff_topics —
-- service_role bypass + route-layer tenant scoping.
--
-- Backfill: this migration does NOT auto-parse the existing free-form
-- business_configs.business_hours values. That parser lives in the
-- TypeScript util lib/business-hours/parser.ts (Phase 3.1a; shipped
-- alongside this migration) so it can be shared between:
--   (a) the /api/business/hours PATCH endpoint (validation of user
--       input, or one-shot convert-from-text at first PATCH)
--   (b) any future backfill script or admin migration action.
--
-- If a business has never used the /api/business/hours PATCH endpoint,
-- GET /api/business/hours returns an empty array and the caller is
-- expected to prompt the user to configure hours. The routes helper
-- offers a "convert my current free-form text" action that runs the
-- TS parser and populates the 7 rows.
--
-- Idempotent — IF NOT EXISTS on all DDL; DROP+CREATE on the trigger.
--
-- Apply via Supabase apply_migration MCP against project
-- zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'business_hours';
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'business_hours'::regclass;
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'business_hours';

BEGIN;

CREATE TABLE IF NOT EXISTS business_hours (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   TEXT NOT NULL,
  day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  opens_at      TIME,
  closes_at     TIME,
  timezone      TEXT NOT NULL DEFAULT 'America/New_York',
  is_closed     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, day_of_week)
);

-- Enforce the "closed ⇔ both times NULL, open ⇔ both times NOT NULL"
-- invariant. CHECKs can't use IF NOT EXISTS; DO block guards re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'business_hours_closed_times_null_ck'
       AND conrelid = 'business_hours'::regclass
  ) THEN
    ALTER TABLE business_hours
      ADD CONSTRAINT business_hours_closed_times_null_ck
      CHECK (
        (is_closed = true  AND opens_at IS NULL     AND closes_at IS NULL) OR
        (is_closed = false AND opens_at IS NOT NULL AND closes_at IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_business_hours_lookup
  ON business_hours (business_id, day_of_week);

-- updated_at auto-bump. trigger_set_updated_at() was introduced in
-- migration 030 (see appointments table). Re-using the shared function
-- rather than defining a per-table copy.
DROP TRIGGER IF EXISTS trg_business_hours_updated_at ON business_hours;
CREATE TRIGGER trg_business_hours_updated_at
  BEFORE UPDATE ON business_hours
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE business_hours IS
  'Phase 3.1: Structured business hours per (business, day_of_week). Read by GET /api/business/hours/now to compute is_open + next_opens_at for the after-hours flow. Free-form business_configs.business_hours is legacy — see lib/business-hours/parser.ts for text→structured conversion.';

COMMENT ON COLUMN business_hours.day_of_week IS
  '0=Sunday, 1=Monday, ..., 6=Saturday. Matches JavaScript Date.getDay() and PostgreSQL EXTRACT(DOW FROM ...) so the "is open now?" query has no offset math. NOT ISO 8601 (which uses 1=Monday...7=Sunday) — deliberate JS/PG parity.';

COMMENT ON COLUMN business_hours.opens_at IS
  'Local opening time on this weekday. NULL when is_closed=true (CHECK enforced). Interpreted in the row''s timezone; the "is open now?" endpoint resolves current wall-clock in that tz before comparing.';

COMMENT ON COLUMN business_hours.closes_at IS
  'Local closing time on this weekday. NULL when is_closed=true. If closes_at < opens_at the business closes after midnight (Phase 3.5 concern — Phase 3.1a treats this as invalid at the API layer and rejects with 400).';

COMMENT ON COLUMN business_hours.timezone IS
  'IANA timezone name (e.g. America/New_York). Per-row rather than per-business so future multi-location tenants can have per-day overrides without schema churn.';

COMMENT ON COLUMN business_hours.is_closed IS
  'True on days the business is fully closed. When true, opens_at and closes_at MUST be NULL (CHECK enforced).';

COMMIT;
