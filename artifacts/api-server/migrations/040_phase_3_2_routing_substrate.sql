-- 040_phase_3_2_routing_substrate.sql
-- Phase 3.2a — routing substrate for topic-aware inbound call handling.
--
-- Adds 5 columns to the `calls` table so the new /api/routing/route-to-topic
-- webhook (invoked by Alex's route_to_topic ElevenLabs tool in Phase 3.2b)
-- can record its decision, log accountability, and support Phase 3.5
-- reporting ("who handled which topics").
--
-- Design rationale:
--   * `handled_by_user_id` — auth.users.id FK. Set when a rung staff member
--     actually answers the transferred call. Nullable — a call can be
--     "routed but nobody answered" (fell through to fallback) or "not
--     routed at all" (AI handled fully, no transfer).
--   * `handled_at` — timestamp of pickup. Used for time-to-answer metrics.
--   * `handoff_reason` — TEXT explaining the routing decision. Free-form
--     but conventional values enumerated in the header of routes/routing.ts:
--       'topic_match_answered'          — routed to a topic specialist who picked up
--       'fallback_any_on_duty'          — no topic match; rang everyone on-duty
--       'no_staff_during_hours'         — nobody on-duty; used legacy transfer_to_phone
--       'after_hours_callback'          — after hours; AI took a message
--       'topic_no_longer_configured'    — race: departments cleared after Alex read them
--       'all_staff_no_answer'           — everyone rang, nobody answered
--       'graceful_hangup'               — no fallback config, AI said sorry and hung up
--   * `topic_slug` — the topic Alex identified (from business_configs.departments).
--     Written even on fallback paths so reporting can measure "topics Alex
--     identified but we couldn't route." Deliberately different from the
--     dead `department_routed` column (verified 0/323 rows populated in
--     production at migration time — see Deprecation note below).
--   * `rung_user_ids` — auth.users.id[] (NOT user_businesses.id per Phase A
--     lock-in). Array of every staff whose cell was dialed during the
--     simultaneous-ring attempt, whether they answered or not. Survives
--     user_businesses row deletion for post-incident forensics.
--
-- Foreign-key posture: `handled_by_user_id` → auth.users(id) ON DELETE
-- SET NULL. If a staff account is deleted, historical call records lose
-- the human name (fine — the transcript still exists) rather than the
-- whole row cascading away. `rung_user_ids` has no FK because Postgres
-- doesn't support FK on array elements; the app layer must tolerate
-- stale UUIDs (a deleted user's id can persist in old rows).
--
-- Deprecation notes:
--   * `calls.department_routed` (existing TEXT column, 0/323 rows populated
--     in prod verified 2026-07-29) is dead code. `calls.topic_slug` is its
--     effective replacement under a clearer name (snake_case routing key
--     vs. free-form display). Do NOT drop `department_routed` in this
--     migration — leave for a future cleanup migration once we've
--     confirmed no code path writes to it.
--   * `business_transfer_configs` (whole table, columns transfer_number,
--     triggers, fallback, active, transfer_type, transfer_hours) is
--     deprecated. Verified unused in production code at migration time.
--     Authoritative transfer config lives on business_configs.transfer_*.
--     Do NOT drop the table in this migration — leave for a future cleanup.
--
-- Idempotent — IF NOT EXISTS on every DDL. Additive, no drops. Atomic
-- BEGIN/COMMIT so a half-landing on one column doesn't leave the FK
-- attached to a missing target.
--
-- Apply via Supabase apply_migration MCP against project
-- zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'calls'
--      AND column_name IN ('handled_by_user_id','handled_at',
--                          'handoff_reason','topic_slug','rung_user_ids');
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'calls'::regclass
--      AND conname LIKE '%handled_by_user%';
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'calls'
--      AND indexname IN ('idx_calls_handled_by_user','idx_calls_topic_slug');

BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS handled_by_user_id UUID;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS handled_at TIMESTAMPTZ;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS handoff_reason TEXT;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS topic_slug TEXT;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS rung_user_ids UUID[];

-- FK constraint on handled_by_user_id → auth.users(id) ON DELETE SET NULL.
-- Postgres doesn't support IF NOT EXISTS on constraints; DO block guards
-- re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calls_handled_by_user_id_fk'
       AND conrelid = 'calls'::regclass
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_handled_by_user_id_fk
      FOREIGN KEY (handled_by_user_id)
      REFERENCES auth.users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_calls_handled_by_user
  ON calls (business_id, handled_by_user_id)
  WHERE handled_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calls_topic_slug
  ON calls (business_id, topic_slug)
  WHERE topic_slug IS NOT NULL;

COMMENT ON COLUMN calls.handled_by_user_id IS
  'Phase 3.2: auth.users.id of the staff member who picked up a transferred call. NULL if the call was not transferred, or was transferred but nobody answered. FK ON DELETE SET NULL — losing a staff account preserves the call record without losing the whole row.';

COMMENT ON COLUMN calls.handled_at IS
  'Phase 3.2: Timestamp when the staff member picked up (bridge connected). Powers time-to-answer metrics and per-staff reporting. NULL for calls that never bridged to a human.';

COMMENT ON COLUMN calls.handoff_reason IS
  'Phase 3.2: Which fallback path the routing engine took. Conventional values (enumerated in routes/routing.ts): topic_match_answered, fallback_any_on_duty, no_staff_during_hours, after_hours_callback, topic_no_longer_configured, all_staff_no_answer, graceful_hangup. NULL when the AI handled the call natively (no routing invoked).';

COMMENT ON COLUMN calls.topic_slug IS
  'Phase 3.2: Topic Alex identified for this call, matching a slug in business_configs.departments. Written on every routing attempt — even ones that fell back or failed — so reporting can measure "topics identified but not routed." Different from the legacy calls.department_routed column (which is dead code — 0 rows populated in prod at migration time; superseded by this column).';

COMMENT ON COLUMN calls.rung_user_ids IS
  'Phase 3.2: auth.users.id[] of every staff cell dialed during simultaneous-ring, whether they answered or not. Not FK-enforced (Postgres does not support FK on array elements) — app layer tolerates stale UUIDs from deleted users. Enables post-incident "why did X not answer" forensics.';

COMMIT;
