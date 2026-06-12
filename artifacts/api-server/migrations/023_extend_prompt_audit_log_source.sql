-- Migration 023 — extend prompt_audit_log.source CHECK to cover the
-- leads-capture-fix flow.
--
-- Context: Slice 1 of the leads epic was non-functional in production
-- because the rendered system prompt never named the request_callback
-- tool (only save_lead / check_availability — neither was registered).
-- The repair flow re-renders prompts and PATCHes ElevenLabs agents;
-- the audit row needs a distinct source tag so ops can filter the
-- repair sweep separately from owner edits and the older 020/021
-- backfill.
--
-- Two new source values:
--   leads_capture_repair    → single-business resync
--                              (scripts/resync-agent-prompt.ts)
--   leads_capture_backfill  → fleet-wide sweep
--                              (scripts/backfill-agent-prompts.ts,
--                              shipped in a follow-up commit)
--
-- Strategy: DROP the CHECK and re-ADD with the extended set. Safe
-- because the existing values ('owner_raw', 'owner_helpers_regen',
-- 'admin_raw', 'backfill', 'system') are retained.
--
-- Idempotent via the existence check on the old constraint name.
-- Apply via the Supabase SQL editor against project zqhijauefcpwggklshoa.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prompt_audit_log_source_check'
      AND conrelid = 'public.prompt_audit_log'::regclass
  ) THEN
    ALTER TABLE prompt_audit_log
      DROP CONSTRAINT prompt_audit_log_source_check;
  END IF;

  ALTER TABLE prompt_audit_log
    ADD CONSTRAINT prompt_audit_log_source_check
    CHECK (source IN (
      'owner_raw',
      'owner_helpers_regen',
      'admin_raw',
      'backfill',
      'system',
      'leads_capture_repair',
      'leads_capture_backfill'
    ));
END $$;

-- Verification (read-only).
SELECT
  'source CHECK extended' AS check_name,
  pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
WHERE c.conname = 'prompt_audit_log_source_check'
  AND c.conrelid = 'public.prompt_audit_log'::regclass;
