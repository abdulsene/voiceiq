-- 048_call_satisfaction_inferred.sql
-- Phase 4.5 — machine-inferred satisfaction, distinct from surveyed.
--
-- ONE new column: satisfaction_inferred integer (nullable).
--
-- Every other column the extended analysis writes already exists:
--   sentiment TEXT, sentiment_score INTEGER (never written pre-4.5),
--   dominant_emotion TEXT, emotion_journey JSONB, urgency TEXT,
--   caller_intent TEXT, summary TEXT, follow_up_required BOOLEAN.
-- Verified via information_schema.columns 2026-08-02.
--
-- Why a separate column instead of writing AI-inferred satisfaction
-- into satisfaction_rating: same discipline as Phase 3.12 call_outcome
-- vs disposition — machine inference and human ground truth never
-- share a column. Their disagreement is the signal. When a post-call
-- survey lands later, it writes satisfaction_rating; reports render
-- rating when present, fall back to inferred, and flag disagreement.
--
-- Scale: 1 (very unsatisfied) through 5 (very satisfied). Matches
-- the shape satisfaction_rating already uses (integer 1-5 per the
-- audit's expected NPS-adjacent convention).
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'calls' AND column_name = 'satisfaction_inferred';

BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS satisfaction_inferred INTEGER;

-- Constrain to 1..5 at the DB layer so a buggy analyzer prompt
-- can't write 7 or -1. The route layer also validates but this is
-- the belt-and-suspenders that survives a bad deploy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calls_satisfaction_inferred_range'
       AND conrelid = 'calls'::regclass
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_satisfaction_inferred_range
      CHECK (satisfaction_inferred IS NULL OR (satisfaction_inferred BETWEEN 1 AND 5));
  END IF;
END $$;

COMMENT ON COLUMN calls.satisfaction_inferred IS
  'Phase 4.5: AI-inferred caller satisfaction, integer 1 (very unsatisfied) to 5 (very satisfied). Populated by lib/call-analysis.ts (Haiku). MUST NOT be conflated with satisfaction_rating — that column is reserved for a real post-call survey response. When both are set, disagreement is a reporting signal; never overwrite one with the other. Same discipline as migration 046 (call_outcome vs disposition).';

COMMENT ON COLUMN calls.satisfaction_rating IS
  'Phase 4.5: surveyed satisfaction from a real post-call survey (integer 1-5). Not yet wired to any UI — the survey pipeline was designed but not built. NULL means the survey was never sent or never answered. Distinct from satisfaction_inferred (AI read). See migration 048 header.';

COMMIT;
