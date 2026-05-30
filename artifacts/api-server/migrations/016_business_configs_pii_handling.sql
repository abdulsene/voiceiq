-- Sprint / migration 016
--
-- Per-business PII redaction mode override.
--
-- Saturday's PII wiring (artifacts/api-server/src/lib/pii-redact-transcript.ts
-- + voiceiq-engine/lib/pii-redact-transcript.js) defaults globally to
-- 'minimize' with a PII_REDACTION_MODE=off env-var kill switch. Adding
-- this column lets resolveRedactionMode() consult the per-business
-- setting first, then fall back to the env var, then to 'minimize'.
--
-- Values:
--   'minimize' — HIPAA-conservative default (redact PHI from transcript
--                text before persistence). This is the spec'd default
--                and matches today's behaviour.
--   'off'      — bypass redaction for this business (e.g. customer
--                explicitly opts out, transcripts already arrive
--                pre-redacted, or compliance review needs raw text).
--
-- No UI to set this — admins flip via direct DB or future settings UI
-- (out of scope for this migration).
--
-- Idempotent — safe to re-run. ADD COLUMN IF NOT EXISTS + named CHECK
-- constraint guarded by pg_constraint lookup.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS pii_handling TEXT NOT NULL DEFAULT 'minimize';

-- Idempotency guard scoped to public.business_configs specifically.
-- Constraint names are NOT globally unique in Postgres (they're scoped
-- to relation), so a bare `WHERE conname = 'foo'` lookup could collide
-- with an unrelated table that happens to share the name and skip
-- adding the check here. Joining through conrelid pins it to this table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_configs_pii_handling_check'
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    ALTER TABLE business_configs
      ADD CONSTRAINT business_configs_pii_handling_check
      CHECK (pii_handling IN ('minimize', 'off'));
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only, prints once after migration runs)

SELECT 'pii_handling column added' AS status,
       count(*) AS total_rows,
       count(*) FILTER (WHERE pii_handling = 'minimize') AS minimize_rows,
       count(*) FILTER (WHERE pii_handling = 'off') AS off_rows
FROM business_configs;
