-- 026_outbound_voice_provider_config.sql
-- Phase 1.1 — outbound voice provider configuration on business_configs.
--
/* ------------------------------------------------------------------ *
 * FORWARD-COMPAT NOTE
 *
 * Three columns on business_configs that configure per-tenant
 * outbound voice behavior. Inert at runtime today — companion code
 * lands in:
 *   Phase 1.3 — lib/outbound-voice/place-call.ts reads
 *               outbound_provider to pick a provider + falls back to
 *               env ELEVENLABS_DEFAULT_PHONE_NUMBER_ID when
 *               elevenlabs_phone_number_id is NULL
 *   Phase 1.6 — voicemail TwiML route reads outbound_voicemail_text;
 *               NULL → <Hangup/> (agent disconnects, no voicemail
 *               left)
 *   Phase 1.7 — OutboundSettingsTab in SettingsPage.tsx surfaces
 *               edit UI for tenants/ops
 *
 * Defaults preserve existing behavior:
 *   - elevenlabs_phone_number_id is NULL on every existing tenant.
 *     The provider falls back to env at call placement time.
 *   - outbound_voicemail_text is NULL on every existing tenant.
 *     The voicemail route refuses to read out a generic default
 *     (cautious — better than off-brand).
 *   - outbound_provider gets default 'elevenlabs_hosted' for every
 *     existing tenant via the DEFAULT clause. No UPDATE pass needed.
 *
 * Ops onboarding sets elevenlabs_phone_number_id +
 * outbound_voicemail_text per tenant during the pilot rollout.
 * ------------------------------------------------------------------ */
--
-- Schema design notes:
--   - All three columns live on business_configs (not a separate
--     outbound_voice_config table). Existing per-tenant knobs
--     (twilio_phone_number, agent_id, transfer_*, sla_overrides,
--     outbound_voice_enabled, outbound_calling_hours_*, ...) already
--     live there. Splitting outbound config across two tables means
--     two reads on every call placement — net loss.
--   - outbound_provider uses a CHECK constraint because the value
--     set is small + stable (the two providers shipped in 0-B). A
--     future Vonage / Plivo provider extends the CHECK in a small
--     migration. Compare to lead_calls.answered_by which has NO
--     CHECK because Twilio's AMD enum drifts — different stability
--     posture for different concerns.
--   - elevenlabs_phone_number_id + outbound_voicemail_text are TEXT
--     with no length cap. The former is a vendor-assigned token
--     (~25 chars); the latter is read-aloud script (typically <500
--     chars but unbounded in case ops wants longer scripts).
--   - No NOT NULL on elevenlabs_phone_number_id or
--     outbound_voicemail_text. NULL is the documented
--     "not-yet-configured" signal; both consumers handle it cleanly.
--
-- Apply via Supabase SQL editor against project zqhijauefcpwggklshoa.
-- Idempotent — IF NOT EXISTS guards on every ADD; EXISTS-guarded
-- ADD CONSTRAINT for the CHECK. Atomic — wrapped in BEGIN/COMMIT so
-- a mid-file failure rolls back the partial state.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- (1) elevenlabs_phone_number_id — ElevenLabsHostedProvider phone resource

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS elevenlabs_phone_number_id TEXT;

COMMENT ON COLUMN business_configs.elevenlabs_phone_number_id IS
  'ElevenLabs agent_phone_number_id used by ElevenLabsHostedProvider. NULL on tenants without a provisioned ElevenLabs phone number; the provider falls back to env ELEVENLABS_DEFAULT_PHONE_NUMBER_ID when NULL. Ops sets this per-tenant during pilot onboarding.';

-- ───────────────────────────────────────────────────────────────────────
-- (2) outbound_voicemail_text — voicemail script for AMD-machine redirect

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_voicemail_text TEXT;

COMMENT ON COLUMN business_configs.outbound_voicemail_text IS
  'Voicemail script read via Twilio <Say> when AMD detects machine answer. NULL = no voicemail left (TwiML returns <Hangup/> after redirect, agent simply disconnects). Cautious default — better than an off-brand generic. Ops sets this per-tenant during pilot onboarding.';

-- ───────────────────────────────────────────────────────────────────────
-- (3) outbound_provider — per-tenant provider selection

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_provider TEXT NOT NULL DEFAULT 'elevenlabs_hosted';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_configs_outbound_provider_chk'
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    ALTER TABLE business_configs
      ADD CONSTRAINT business_configs_outbound_provider_chk
      CHECK (outbound_provider IN ('twilio', 'elevenlabs_hosted'));
  END IF;
END $$;

COMMENT ON COLUMN business_configs.outbound_provider IS
  'Which provider place-call.ts uses per tenant. Default elevenlabs_hosted (Path A — ElevenLabs handles dialing) for the pilot. Tenants needing custom AMD behavior, voicemail flexibility, or full Twilio observability switch to twilio (Path B). Both providers ship from Phase 0 Commit 0-B; selection is per-tenant.';

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only)

SELECT
  'business_configs new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'elevenlabs_phone_number_id') AS phone_id,
  COUNT(*) FILTER (WHERE column_name = 'outbound_voicemail_text') AS voicemail_text,
  COUNT(*) FILTER (WHERE column_name = 'outbound_provider') AS provider
FROM information_schema.columns
WHERE table_name = 'business_configs'
  AND column_name IN ('elevenlabs_phone_number_id', 'outbound_voicemail_text', 'outbound_provider');

SELECT
  'outbound_provider CHECK' AS check_name,
  pg_get_constraintdef(c.oid) AS provider_check
FROM pg_constraint c
WHERE c.conname = 'business_configs_outbound_provider_chk'
  AND c.conrelid = 'public.business_configs'::regclass;

COMMIT;
