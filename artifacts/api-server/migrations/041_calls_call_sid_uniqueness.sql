-- 041_calls_call_sid_uniqueness.sql
-- Phase 3.2c — codify the UNIQUE(call_sid) constraint that the routing
-- UPSERT depends on. NO-OP in the current production database:
--
-- Investigation before Phase 3.2c (verified via Supabase MCP against
-- zqhijauefcpwggklshoa, 2026-07-29):
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'calls' AND indisunique;
--     → calls_call_sid_key  UNIQUE btree (call_sid)      ← pre-existing
--     → calls_pkey          UNIQUE btree (id)
--
-- The `calls_call_sid_key` UNIQUE index has existed since before Phase 3
-- (referenced at routes/api.ts:530-536 in the post-call UPSERT — that
-- code path already keys onConflict:"call_sid" on it). It permits
-- multiple NULLs (Postgres default) so the 26 legacy pre-conversation
-- rows with NULL call_sid don't conflict.
--
-- This migration is a defensive parity guard: if a future clone /
-- staging environment somehow lacks the index, we'd fail silently on
-- routing UPSERT (23505 unique_violation would degrade to duplicate
-- rows for a call). The DO block detects the existing index and
-- skips; otherwise creates a partial UNIQUE index that matches the
-- Phase 3.2c contract exactly.
--
-- ─────────────────────────────────────────────────────────────────────
-- IMPORTANT SEMANTIC NOTE about calls.call_sid vs calls.conversation_id
-- ─────────────────────────────────────────────────────────────────────
--
-- The `call_sid` column in this codebase stores the ElevenLabs
-- CONVERSATION_ID (NOT the Twilio CallSid), per the pre-Phase-3 flow:
--   routes/api.ts:505  call_sid: conversationId
--   routes/api.ts:541  call_sid: conversationId
--   routes/api.ts:649  call_sid: toolCallSid = body.conversation_id
--   routes/api.ts:966  call_sid: conv.conversation_id
--
-- The `conversation_id` column exists but is 0/323 populated in prod.
-- Phase 3.2c does NOT rename or migrate the historical column. The
-- routing UPSERT keys on `call_sid` because that's where the
-- ElevenLabs conversation_id actually lives — consistent with the
-- post-call handler's existing UPSERT contract.
--
-- The Twilio CallSid (a *different* identifier from ElevenLabs's
-- conversation_id) is NOT stored on `calls` today. Phase 3.2b passes
-- it as the `call_sid` field in the route_to_topic tool body — where
-- it's used ONLY to call `twilioClient.calls(sid).update({twiml})`.
-- It never gets written to the DB. Terminology across ElevenLabs +
-- Twilio + this codebase is unfortunately overloaded; the schema
-- migration is not the place to unwind it.
--
-- ─────────────────────────────────────────────────────────────────────
-- Apply via Supabase apply_migration MCP. After apply, verify:
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'calls' AND indexdef ILIKE '%unique%';
--   -- expect at least one UNIQUE index on (call_sid)
--
--   SELECT COUNT(*) FROM calls WHERE call_sid IN (
--     SELECT call_sid FROM calls GROUP BY call_sid HAVING COUNT(*) > 1
--   );
--   -- expect 0 (no duplicates)

BEGIN;

DO $$
DECLARE
  n INT;
BEGIN
  -- Look for any existing UNIQUE index / constraint on calls.call_sid.
  -- Matches both the historical `calls_call_sid_key` and any partial
  -- variant a future clone might have.
  SELECT COUNT(*) INTO n
    FROM pg_indexes pi
    JOIN pg_class c ON c.relname = pi.indexname
    JOIN pg_index i ON i.indexrelid = c.oid
   WHERE pi.tablename = 'calls'
     AND i.indisunique
     AND array_position(i.indkey::int[], (
       SELECT attnum FROM pg_attribute
        WHERE attrelid = 'public.calls'::regclass
          AND attname = 'call_sid'
     )::int) IS NOT NULL;

  IF n > 0 THEN
    RAISE NOTICE 'Migration 041: existing UNIQUE index on calls.call_sid found (% index(es)) — skipping create; UPSERT contract already satisfied', n;
  ELSE
    CREATE UNIQUE INDEX calls_call_sid_unique
      ON calls (call_sid)
      WHERE call_sid IS NOT NULL;
    RAISE NOTICE 'Migration 041: created calls_call_sid_unique partial index';
  END IF;
END $$;

COMMENT ON COLUMN calls.call_sid IS
  'Historical naming quirk: this column stores the ElevenLabs CONVERSATION_ID (NOT the Twilio CallSid), per the pre-Phase-3 insert flow. Populated by the post-call ElevenLabs webhook (routes/api.ts) and by the Phase 3.2c routing UPSERT (routes/routing.ts). UNIQUE index calls_call_sid_key enforces one row per conversation. The Twilio CallSid is a distinct identifier that Phase 3.2b passes as a tool-schema field but never persists.';

COMMIT;
