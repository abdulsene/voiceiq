-- Sprint 3 Stage 3 / migration 022
--
-- Drop system_prompt_fr and system_prompt_es columns added in
-- migration 020. We decided after Stage 2 investigation to keep
-- the existing one-polyglot-prompt architecture (Model X): the
-- single system_prompt column already contains the EN prompt body
-- plus appended LANGUAGE_BLOCKS for any other enabled languages.
-- Per-language separate prompts via ElevenLabs language_presets
-- (Model Y) is not the path we're taking.
--
-- The system_prompt_fr / system_prompt_es columns were never
-- written to — migration 020 added them as nullable TEXT and the
-- backfill script only ever populated system_prompt. Dropping them
-- is data-loss-free.
--
-- elevenlabs-agent.ts keeps its multi-language code paths intact
-- as future-proofing. Callers always pass 'en'.
--
-- Idempotent — IF EXISTS guards.
--
-- Run via Supabase MCP apply_migration on project zqhijauefcpwggklshoa.

ALTER TABLE business_configs DROP COLUMN IF EXISTS system_prompt_fr;
ALTER TABLE business_configs DROP COLUMN IF EXISTS system_prompt_es;

-- Tell PostgREST to reload its schema cache so the dropped columns
-- disappear from the auto-generated REST API immediately.
NOTIFY pgrst, 'reload schema';
