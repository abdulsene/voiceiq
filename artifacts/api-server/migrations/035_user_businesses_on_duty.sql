-- 035_user_businesses_on_duty.sql
-- Phase 3.1a — clock-in / clock-out state for staff on the user_businesses row.
--
-- The routing target we're building toward (Phase 3.2+) is:
--   "which employees are currently ON DUTY for this business AND handle
--    this topic?" — a single indexed query. Storing on-duty state on
--    user_businesses (rather than a separate business_users table that
--    is currently empty in production) keeps the read path a single
--    row per user+business, matches every existing route that already
--    reads user_businesses for role / callback_ring_number, and avoids
--    the two-table JOIN we would otherwise pay on every routing hop.
--
-- Design notes:
--   * is_on_duty is a BOOL — no third state. "Away" / "Break" style
--     nuance can go on a future column when the product ships that
--     concept; today it's just clocked-in or not.
--   * on_duty_since is TIMESTAMPTZ, set to NOW() on clock-in and
--     NULLed on clock-out. Two consumers depend on it: reporting
--     (average shift length) and Phase 3.5 stuck-session detection
--     (a session > N hours flags for an ops sweep).
--   * The partial index (business_id, is_on_duty) WHERE is_on_duty
--     is exactly the shape of the Phase 3.2 routing hot path — index
--     rows only when true so it stays small (typical business has
--     0-2 on-duty staff at any moment, out of dozens of members).
--
-- Idempotent — IF NOT EXISTS guards on all DDL. Additive, no drops.
-- Wrapped in BEGIN/COMMIT so a mid-migration failure doesn't leave
-- half the columns landed.
--
-- Apply via Supabase apply_migration MCP (preferred) or SQL editor
-- against project zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'user_businesses'
--      AND column_name IN ('is_on_duty', 'on_duty_since');
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'user_businesses'
--      AND indexname = 'idx_user_businesses_on_duty';

BEGIN;

ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS is_on_duty BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS on_duty_since TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_businesses_on_duty
  ON user_businesses (business_id, is_on_duty)
  WHERE is_on_duty = true;

COMMENT ON COLUMN user_businesses.is_on_duty IS
  'Phase 3.1: Whether the staff member is currently clocked in to receive calls. Toggled via POST /api/business/team/me/on-duty (true) and POST /api/business/team/me/off-duty (false). Cleared to false on log-out. Read by the Phase 3.2 routing engine to shortlist candidates for simultaneous-ring first-answer-wins.';

COMMENT ON COLUMN user_businesses.on_duty_since IS
  'When the current on-duty session began (set to NOW() when is_on_duty flips true; NULL when is_on_duty is false). Consumers: (a) reporting — average shift length, (b) Phase 3.5 stuck-session detection — sessions older than N hours flag for an ops sweep in case the staff forgot to clock out.';

COMMIT;
