-- Migration 025: allow 'admin_voice_change' in prompt_audit_log.source
--
-- Stage 6 admin override UI introduces admin voice switches. These
-- need a distinct audit source from owner-initiated voice_change so
-- the HistoryViewer can render "Admin voice override" with distinct
-- treatment (planned for Stage 6 Phase 3 frontend work).

ALTER TABLE prompt_audit_log
  DROP CONSTRAINT IF EXISTS prompt_audit_log_source_check;

ALTER TABLE prompt_audit_log
  ADD CONSTRAINT prompt_audit_log_source_check
  CHECK (source IN (
    'owner_raw',
    'owner_helpers_regen',
    'admin_raw',
    'admin_voice_change',
    'voice_change',
    'first_message_change',
    'first_message_backfill',
    'backfill',
    'system'
  ));

-- PostgREST cache reload so the new value is recognized
NOTIFY pgrst, 'reload schema';
