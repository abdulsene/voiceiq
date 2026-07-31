-- 046_calls_disposition.sql
-- Phase 3.12 — staff-entered call disposition.
--
-- Replaces Answering Machine Detection (AMD) which Phase 3.11 proved
-- non-functional in the softphone's TwiML-App-with-Client-parent
-- topology (docs claimed <Dial><Number> supports AMD; live evidence
-- confirmed Twilio silently no-ops the amdStatusCallback fire in that
-- specific call shape). Even if AMD had worked, it could not answer
-- Abdul's actual reporting question — "voicemail: message left vs
-- not" — because AMD detects the answering-machine GREETING, not
-- whether the caller subsequently spoke. Disposition was therefore
-- required regardless of AMD, which made AMD redundant.
--
-- Design principle documented here so the next person doesn't undo it:
-- machine-observed data (call_outcome, derived from Twilio's
-- DialCallStatus + AnsweredBy) is stored in ONE set of columns; staff-
-- entered data (disposition) is stored in a DIFFERENT set of columns.
-- When they disagree, the disagreement is the signal — never overwrite
-- one with the other in the same column. Reporting reads disposition
-- when present, falls back to call_outcome.
--
-- New columns on `calls`:
--
--   disposition TEXT
--     Whitelisted values (enforced at the route layer for now; can
--     tighten to a CHECK constraint once the values are stable):
--       reached_person
--       voicemail_left_message
--       voicemail_no_message
--       wrong_number
--       no_answer_bad_line
--     NULL when staff did not disposition the call. NULL is a
--     meaningful state — reporting should render "not dispositioned"
--     rather than treating NULL as "reached_person."
--
--   dispositioned_by_user_id UUID  (FK → auth.users ON DELETE SET NULL)
--     Which staff member wrote the disposition. Enables per-staff
--     disposition-rate reporting and audit. FK ON DELETE SET NULL so
--     losing a staff account preserves the call record without
--     cascading the row away.
--
--   dispositioned_at TIMESTAMPTZ
--     When staff wrote the disposition. Distinct from handled_at
--     (which marks when the call was answered).
--
-- Retained columns (with new comment on answered_by):
--
--   answered_by TEXT — retained despite AMD being removed from the
--     softphone path. The Phase 2 campaign engine's
--     calls.create({machineDetection, asyncAmdStatusCallback}) flow
--     still populates this column for outbound campaign calls (that
--     path was already proven working in prod pre-3.9). Removing the
--     column would break that flow. See migration 045 for the original
--     rationale.
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'calls'
--      AND column_name IN ('disposition', 'dispositioned_by_user_id',
--                          'dispositioned_at');
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'calls'::regclass
--      AND conname = 'calls_dispositioned_by_user_id_fk';

BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS disposition TEXT;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS dispositioned_by_user_id UUID;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS dispositioned_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calls_dispositioned_by_user_id_fk'
       AND conrelid = 'calls'::regclass
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_dispositioned_by_user_id_fk
      FOREIGN KEY (dispositioned_by_user_id)
      REFERENCES auth.users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Index for per-staff disposition-rate reports.
CREATE INDEX IF NOT EXISTS idx_calls_disposition
  ON calls (business_id, disposition)
  WHERE disposition IS NOT NULL;

COMMENT ON COLUMN calls.disposition IS
  'Phase 3.12: staff-entered disposition of an outbound in-app call. Whitelist enforced at PATCH /api/voice/calls/:id/disposition. NULL = staff did not disposition. Distinct from call_outcome (Twilio-inferred). Reporting reads disposition when present, falls back to call_outcome. Never overwrite machine-observed data with human-entered data in the same column — see migration 046 header.';

COMMENT ON COLUMN calls.dispositioned_by_user_id IS
  'Phase 3.12: auth.users.id of the staff who wrote the disposition. FK ON DELETE SET NULL preserves the call record when a staff account is removed.';

COMMENT ON COLUMN calls.dispositioned_at IS
  'Phase 3.12: when the disposition was written. Distinct from handled_at (call answered).';

COMMENT ON COLUMN calls.answered_by IS
  'Phase 3.9 / RETAINED as of Phase 3.12: Twilio AMD (Answering Machine Detection) result. UNUSED by the softphone outbound path as of Phase 3.12 because AMD via <Dial><Number> proved non-functional in the TwiML-App / Client-parent topology (Phase 3.11 research). Retained for the Phase 2 campaign engine which still uses calls.create({machineDetection, asyncAmdStatusCallback}) and populates this column. Do NOT drop.';

COMMIT;
