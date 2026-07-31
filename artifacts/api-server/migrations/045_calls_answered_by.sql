-- 045_calls_answered_by.sql
-- Phase 3.9 — store Twilio's AMD (Answering Machine Detection) result
-- on the calls row so voicemail vs human is distinguishable in
-- reporting.
--
-- Live test 2026-07-31: staff dialed out, call went to voicemail,
-- Twilio reported DialCallStatus=completed (because the voicemail
-- machine answered). Row was written call_outcome='answered' with
-- duration 0:05 — the wrong disposition. Every downstream conversion
-- metric built on call_outcome would misread voicemails as human
-- answers.
--
-- Fix: attach machineDetection="Enable" to the outbound <Number> and
-- store Twilio's `AnsweredBy` value here. handleOutboundStatus then
-- maps (DialCallStatus, AnsweredBy) → the new richer taxonomy on
-- call_outcome:
--
--   answered_human               (completed + human)
--   voicemail                    (completed + machine_*)
--   no_answer                    (no-answer)
--   busy                         (busy)
--   failed                       (failed)
--   canceled                     (canceled)
--   caller_hung_up_during_ring   (canceled with call_duration=0
--                                 and no answer signal)
--
-- Column addition is small, nullable, safe on 323 existing rows.
-- lead_calls already has an equivalent `answered_by` column added
-- in the Phase 2 campaign engine migrations; adding it here brings
-- parity so ops can grep either table by the same field.
--
-- After apply, verify:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'calls' AND column_name = 'answered_by';

BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS answered_by TEXT;

COMMENT ON COLUMN calls.answered_by IS
  'Phase 3.9: Twilio AMD (Answering Machine Detection) result — human, machine_start, machine_end_beep, machine_end_silence, machine_end_other, fax, unknown. NULL when AMD was disabled or the call did not answer. Feeds mapDialOutcome(DialCallStatus, AnsweredBy) → call_outcome taxonomy so voicemail is distinguishable from human answers in reporting.';

COMMIT;
