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
--       Phase 3.2c lifecycle: routing-time reasons end in _ringing; the
--       dial-status webhook promotes to _answered on completed OR
--       escalates to all_staff_no_answer on no-answer. Terminal
--       (no-dial) reasons are un-suffixed. Full list:
--         Routing-time (ringing):
--           'topic_match_ringing'            — matched topic specialists, ringing them
--           'fallback_any_on_duty_ringing'   — no topic match; ringing anyone on-duty
--           'no_staff_during_hours_ringing'  — nobody on-duty; ringing legacy transfer_to_phone
--         Post-dial (answered) — set by handleDialStatus on completed:
--           'topic_match_answered'
--           'fallback_any_on_duty_answered'
--           'no_staff_during_hours_answered'
--         Post-dial escalation — set by handleDialStatus on no-answer:
--           'all_staff_no_answer'            — rang, nobody picked up
--         Terminal (no dial):
--           'after_hours_callback'           — after hours; AI took a message
--           'graceful_hangup'                — no fallback config, AI said sorry and hung up
--         Race flag (routing-time, orthogonal to ringing/answered):
--           'topic_no_longer_configured'     — departments cleared after Alex read them
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
  'Phase 3.2: Routing engine decision + lifecycle stage. Routing-time values end in _ringing (topic_match_ringing, fallback_any_on_duty_ringing, no_staff_during_hours_ringing); post-dial-completed values end in _answered (topic_match_answered, fallback_any_on_duty_answered, no_staff_during_hours_answered); no-answer escalates to all_staff_no_answer; race flag topic_no_longer_configured is orthogonal. Terminal no-dial reasons: after_hours_callback, graceful_hangup. NULL when the AI handled the call natively (no routing invoked). Full enum in src/lib/routing/fallback-logic.ts:HandoffReason.';

COMMENT ON COLUMN calls.topic_slug IS
  'Phase 3.2: Topic Alex identified for this call, matching a slug in business_configs.departments. Written on every routing attempt — even ones that fell back or failed — so reporting can measure "topics identified but not routed." Different from the legacy calls.department_routed column (which is dead code — 0 rows populated in prod at migration time; superseded by this column).';

COMMENT ON COLUMN calls.rung_user_ids IS
  'Phase 3.2: auth.users.id[] of every staff cell dialed during simultaneous-ring, whether they answered or not. Not FK-enforced (Postgres does not support FK on array elements) — app layer tolerates stale UUIDs from deleted users. Enables post-incident "why did X not answer" forensics.';

-- Phase 3.2b — attach the deprecation notice to the table itself so
-- future readers grepping pg_description find it without needing to
-- open this migration file. See file header (Deprecation notes) for
-- full rationale.
COMMENT ON TABLE business_transfer_configs IS
  'DEPRECATED as of Phase 3.2 (migration 040). Superseded by topic-based routing via staff_topics + user_businesses.is_on_duty. Dead code — do not drop, do not extend.';

-- Phase 3.2b — deprecation notice on calls.transfer_reason.
-- handoff_reason (added in Phase 3.2a) is now the CANONICAL routing-
-- decision column. transfer_reason keeps its legacy values for pre-3.2
-- rows; new writes go to handoff_reason only.
COMMENT ON COLUMN calls.transfer_reason IS
  'DEPRECATED as of Phase 3.2b. handoff_reason is now the canonical routing-decision column. Pre-3.2 rows keep their legacy transfer_reason values; the Phase 3.2 routing engine does not write here. Future readers: use handoff_reason.';

COMMIT;
