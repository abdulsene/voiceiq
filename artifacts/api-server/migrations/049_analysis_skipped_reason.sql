-- 049_analysis_skipped_reason.sql
-- Phase 4.6 — distinguish "not enough transcript to analyze" from
-- "model produced a neutral result."
--
-- Background: Phase 4.5 shipped the analyzer without a minimum-viable-
-- transcript gate. A short prompt to Haiku on ~30 characters ("AI:
-- Thank you for calling EZ RENTALS...") produces the mid-scale
-- defaults: sentiment=neutral, sentiment_score=3, dominant_emotion=
-- indifferent, satisfaction_inferred=3. These aren't wrong per-se
-- (the model has to say SOMETHING) but they're fabrications, not
-- observations, and they pollute aggregate averages.
--
-- Prod evidence (2026-08-02 audit): 15 of 25 backfilled rows returned
-- the exact default tuple. avg satisfaction_inferred was 2.72 across
-- all rows and 2.30 on substantive-only rows — the defaults inflated
-- the mean by 0.42.
--
-- Also fixed here: Phase 4.5's backfill said it was idempotent but
-- its selection predicate (sentiment IS NULL) couldn't distinguish
-- "already analyzed" from "we chose not to analyze." Both cases now
-- leave analyzed_at set, and the new predicate is analyzed_at IS NULL.
--
-- ── Columns added ────────────────────────────────────────────────────
--
--   analysis_skipped_reason TEXT     'empty' | 'too_short' | NULL
--     - NULL + analyzed_at NULL  = never processed
--     - NULL + analyzed_at SET   = model ran and produced results
--     - SET                       = analyzer intentionally skipped
--                                   (analysis fields SHOULD be NULL)
--
--   analyzed_at TIMESTAMPTZ          when the analyzer touched the row
--     - Set on BOTH successful analysis AND skip.
--     - IS NULL means "never processed" — the ONLY value the backfill
--       + live analyzer key on for idempotency going forward.
--
-- ── One-shot cleanup (same migration) ────────────────────────────────
--
-- Two data corrections applied to the current production `calls`
-- table:
--
--   (A) Rows that had analysis fields populated pre-4.6 but should
--       have been skipped — the "fabricated default" rows. Detected
--       by transcript below the gate. Fields NULL'd; analysis_
--       skipped_reason set to 'too_short'; analyzed_at set to now().
--
--   (B) Rows that had genuine analysis (transcript above the gate,
--       sentiment IS NOT NULL). Their analyzed_at is backfilled to
--       created_at so the new backfill predicate (analyzed_at IS
--       NULL) correctly SKIPS them on next run — this is the
--       idempotency fix.
--
-- ── Threshold: >= 2 caller turns ─────────────────────────────────────
--
-- Chosen from the length distribution over 33 real prod inbound calls:
--   0 caller turns: 18 rows   (18/33 = 54%) — hangups
--   1 caller turn:   3 rows                  — one utterance then hangup
--   2+ caller turns: 12 rows                 — actual conversations
--
-- >= 2 is the natural cliff. Median chars is 140 (below the greeting
-- length); requiring 2 caller turns cleanly excludes the noise. Regex
-- tolerates both known transcript formats: "Caller: ..." (ingested
-- via api.ts:788) and "[caller]: ..." (ElevenLabs streaming shape).
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   SELECT count(*) FILTER (WHERE analyzed_at IS NULL) AS never_analyzed,
--          count(*) FILTER (WHERE analysis_skipped_reason IS NOT NULL) AS skipped,
--          count(*) FILTER (WHERE analyzed_at IS NOT NULL AND analysis_skipped_reason IS NULL AND sentiment IS NOT NULL) AS analyzed,
--          avg(satisfaction_inferred)::numeric(4,2) AS avg_sat_after
--     FROM calls WHERE business_id <> 'demo-business';

BEGIN;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS analysis_skipped_reason TEXT,
  ADD COLUMN IF NOT EXISTS analyzed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'calls_analysis_skipped_reason_enum'
       AND conrelid = 'calls'::regclass
  ) THEN
    ALTER TABLE calls
      ADD CONSTRAINT calls_analysis_skipped_reason_enum
      CHECK (analysis_skipped_reason IS NULL
             OR analysis_skipped_reason IN ('empty', 'too_short'));
  END IF;
END $$;

-- ── One-shot cleanup ────────────────────────────────────────────────
--
-- Compute per-row caller-turn count and update accordingly. Uses
-- regexp_count (PG15+) to count case-insensitive matches of the two
-- known caller-line prefixes. Everything under 2 caller turns AND
-- carrying analysis fields is corrected; everything at or above 2
-- keeps its analysis and gets analyzed_at backfilled so future
-- runs can be idempotent.

-- (A) Clean fabricated rows (transcript below gate but analysis populated)
UPDATE calls
SET
  sentiment = NULL,
  sentiment_score = NULL,
  dominant_emotion = NULL,
  emotion_journey = NULL,
  urgency = NULL,
  satisfaction_inferred = NULL,
  analysis_skipped_reason = 'too_short',
  analyzed_at = now()
WHERE business_id <> 'demo-business'
  AND (call_sid IS NULL OR call_sid NOT LIKE 'SEED_%')
  AND transcript IS NOT NULL
  AND length(transcript) > 0
  AND sentiment IS NOT NULL
  AND (
    regexp_count(transcript, 'caller:', 1, 'i')
    + regexp_count(transcript, '\[caller\]:', 1, 'i')
  ) < 2;

-- (B) Backfill analyzed_at for rows with real analysis so the new
-- predicate (analyzed_at IS NULL) correctly excludes them.
UPDATE calls
SET analyzed_at = COALESCE(analyzed_at, created_at, now())
WHERE business_id <> 'demo-business'
  AND (call_sid IS NULL OR call_sid NOT LIKE 'SEED_%')
  AND sentiment IS NOT NULL
  AND analyzed_at IS NULL;

-- (C) Empty-transcript rows: mark them as skipped-empty so the
-- watchdog + backfill don't keep re-checking them.
UPDATE calls
SET
  analysis_skipped_reason = 'empty',
  analyzed_at = now()
WHERE business_id <> 'demo-business'
  AND (call_sid IS NULL OR call_sid NOT LIKE 'SEED_%')
  AND (transcript IS NULL OR length(transcript) = 0)
  AND analyzed_at IS NULL
  -- Don't overwrite call.status='no_transcript_yet' state if it
  -- exists — those rows will get transcripts later via polling
  -- sync. Only skip rows old enough that no transcript will land.
  AND created_at < now() - interval '2 hours';

COMMENT ON COLUMN calls.analysis_skipped_reason IS
  'Phase 4.6: reason the analyzer chose NOT to run on this call. Values: NULL (analyzed successfully or never processed — disambiguate via analyzed_at), "empty" (transcript was empty), "too_short" (< 2 caller turns — see lib/call-analysis.ts shouldSkipAnalysis). When set, all analysis fields (sentiment, sentiment_score, dominant_emotion, emotion_journey, urgency, satisfaction_inferred) SHOULD be NULL and the row MUST NOT be included in any aggregate report (defaults would fabricate signal). See migration 049 header.';

COMMENT ON COLUMN calls.analyzed_at IS
  'Phase 4.6: when the analyzer touched this row (successfully OR to record a skip). NULL = never processed. Idempotency key for the backfill script: WHERE analyzed_at IS NULL. Setting this on skip (not just on success) is what makes the pipeline distinguish "we haven''t looked" from "we looked and there was nothing to analyze."';

COMMIT;
