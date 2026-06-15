-- 025_outbound_voice_substrate.sql
-- Phase 0 Commit 0-A — outbound voice product substrate.
--
/* ------------------------------------------------------------------ *
 * FORWARD-COMPAT NOTE
 *
 * This migration is Phase 0 Commit 0-A of the outbound voice epic.
 * It lays DDL only — no application code reads any of these columns
 * or tables yet. Companion code lands in:
 *   Phase 0 Commit 0-B — ICallProvider abstraction over Twilio +
 *                        ElevenLabs (lib/outbound-voice.ts)
 *   Phase 0 Commit 0-C — Compliance helpers (lib/dnc-check.ts,
 *                        lib/calling-hours.ts, lib/voice-consent.ts)
 *
 * Everything in this file is inert at runtime today. The defaults
 * preserve existing behavior:
 *   - lead_calls.direction defaults to 'inbound_bridge' so every
 *     existing Slice 2A bridge row implicitly back-fills correctly
 *     (the only existing rows have staff_user_id set; those ARE
 *     inbound bridges). No UPDATE pass needed.
 *   - leads.do_not_call defaults to FALSE so no leads are
 *     accidentally suppressed pre-launch.
 *   - business_configs.outbound_voice_enabled defaults to FALSE so
 *     no tenant gets opted-in by the column addition alone.
 *
 * Phase 1+ will turn these knobs on per-tenant during the friendly
 * pilot rollout.
 * ------------------------------------------------------------------ */
--
-- Six concerns:
--   1. lead_calls extensions      — direction, AMD result, objective,
--                                   voicemail flag, campaign linkage,
--                                   retry counters, scheduled_for
--   2. business_configs extensions — tenant-level outbound config:
--                                   enable flag, calling-hours window
--                                   (TCPA-floored 8am-9pm), recording
--                                   default, consent presumption,
--                                   caller-ID verification timestamp
--   3. leads extensions           — per-lead DNC override + attempt
--                                   bookkeeping
--   4. dnc_list                   — per-tenant phone-level suppression
--   5. voice_consent_records      — TCPA-grade consent audit trail
--   6. outbound_campaigns         — recipient batches with status +
--                                   counters; lead_calls.campaign_id
--                                   FK is created in concern (1) above
--                                   AFTER this table exists
--
-- Schema design notes:
--   - lead_calls is the UNIFIED call substrate (Slice 2A landed it as
--     bridge-only). Adding `direction` instead of forking a new
--     outbound_calls table keeps the transcription / recording /
--     status-callback / summary pipeline working for outbound with
--     zero refactor. The CHECK enumerates the three legitimate values;
--     adding a new direction in the future is a one-line CHECK swap.
--   - answered_by intentionally has NO CHECK constraint. Twilio's AMD
--     enum has evolved (e.g. machine_end_silence was added late) and
--     a future addition would cause status-callback inserts to 4xx
--     during the window before our CHECK is extended. Column comment
--     documents the current vocabulary.
--   - call_objective similarly uncheckable — campaigns will iterate.
--   - business_configs.outbound_caller_id_verified_at was promised in
--     docs/twilio-caller-id-verification.md as a future "Slice 2B"
--     column. Landing now so the existing optimistic + 21217-catch
--     pattern in routes/lead-calls.ts can graduate to an explicit
--     gate in Phase 1 without another migration.
--   - dnc_list intentionally per-tenant (business_id is part of the
--     UNIQUE). A caller opted out at vendor A is NOT auto-suppressed
--     at vendor B — same posture as sms_opt_outs (migration 024).
--     Future state DNC scrubbing (federal-dnc / state-dnc sources)
--     can write rows with source='federal_dnc' to capture compliance
--     scrubs as audit-able events.
--   - voice_consent_records mirrors the sms_optin_consents pattern
--     (migration 004) — separate row per (phone, consent_type) with
--     evidence pointers. consent_type is a free TEXT so future use
--     cases (e.g. 'survey_followup') don't require a CHECK swap.
--   - outbound_campaigns has counter columns (target_count, completed
--     _count, etc) updated by the campaign engine in Phase 1. They
--     deliberately denormalize what lead_calls aggregations could
--     compute, so the campaign-overview dashboard renders in O(1)
--     rather than scanning lead_calls per page-render.
--
-- Apply via Supabase SQL editor against project zqhijauefcpwggklshoa.
-- Idempotent — IF NOT EXISTS guards on every CREATE / ADD / INDEX.
-- Atomic — wrapped in BEGIN/COMMIT so a mid-file failure rolls back
-- the partial state instead of leaving the substrate half-applied.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- (6) outbound_campaigns FIRST — lead_calls.campaign_id below FKs to it

CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  call_objective TEXT NOT NULL,            -- appointment_reminder | lead_reactivation | no_answer_followup | survey | other
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'queued', 'active', 'paused', 'completed', 'cancelled'
  )),
  agent_id TEXT,                           -- ElevenLabs agent override; NULL = tenant default
  target_count INT NOT NULL DEFAULT 0,
  completed_count INT NOT NULL DEFAULT 0,
  succeeded_count INT NOT NULL DEFAULT 0,  -- AMD=human AND conversation completed
  failed_count INT NOT NULL DEFAULT 0,
  voicemail_count INT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_business_status
  ON outbound_campaigns (business_id, status);

-- ───────────────────────────────────────────────────────────────────────
-- (1) lead_calls extensions — direction, AMD, campaign linkage, etc.

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'inbound_bridge';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lead_calls_direction_chk'
      AND conrelid = 'public.lead_calls'::regclass
  ) THEN
    ALTER TABLE lead_calls
      ADD CONSTRAINT lead_calls_direction_chk
      CHECK (direction IN ('inbound_bridge', 'outbound_automated', 'outbound_bridge'));
  END IF;
END $$;

COMMENT ON COLUMN lead_calls.direction IS
  'Call direction: inbound_bridge (Slice 2A staff-initiated callback) | outbound_automated (Phase 0+ programmatic outbound) | outbound_bridge (future).';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS answered_by TEXT;

COMMENT ON COLUMN lead_calls.answered_by IS
  'Twilio AMD result. No CHECK — Twilio iterates the enum. Current values: human, machine_start, machine_end_beep, machine_end_silence, machine_end_other, fax, unknown.';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS call_objective TEXT;

COMMENT ON COLUMN lead_calls.call_objective IS
  'Outbound use case: appointment_reminder | lead_reactivation | no_answer_followup | survey | other. No CHECK — campaigns iterate.';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS voicemail_left BOOLEAN;

COMMENT ON COLUMN lead_calls.voicemail_left IS
  'Set TRUE when the agent leaves a voicemail after AMD detects machine_end_beep.';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES outbound_campaigns(id) ON DELETE SET NULL;

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN lead_calls.retry_count IS
  'Times this (customer, objective) pair has been attempted BEFORE this call.';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS attempt_number INT NOT NULL DEFAULT 1;

COMMENT ON COLUMN lead_calls.attempt_number IS
  'Position in the retry sequence. 1 = first attempt.';

ALTER TABLE lead_calls
  ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;

COMMENT ON COLUMN lead_calls.scheduled_for IS
  'When the campaign engine intended this call to fire. Compare to started_at for SLA audits.';

-- lead_calls has no business_id column — tenant scoping is via
-- lead_id → leads.business_id JOIN, or via campaign_id →
-- outbound_campaigns.business_id. The (direction, status) index
-- handles cross-tenant queries; existing lead_calls_lead_idx
-- (lead_id, created_at DESC) handles per-lead/per-tenant lookups;
-- idx_lead_calls_campaign_id handles campaign-scoped queries.
CREATE INDEX IF NOT EXISTS idx_lead_calls_direction_status
  ON lead_calls (direction, status);

CREATE INDEX IF NOT EXISTS idx_lead_calls_campaign_id
  ON lead_calls (campaign_id) WHERE campaign_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- (2) business_configs extensions — per-tenant outbound config

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN business_configs.outbound_voice_enabled IS
  'Master gate for outbound voice. FALSE on every tenant until pilot opt-in.';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_calling_hours_start TIME NOT NULL DEFAULT '08:00:00';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_calling_hours_end TIME NOT NULL DEFAULT '21:00:00';

COMMENT ON COLUMN business_configs.outbound_calling_hours_start IS
  'TCPA floor is 8am recipient-local. Tenants can narrow but should not widen.';

COMMENT ON COLUMN business_configs.outbound_calling_hours_end IS
  'TCPA floor is 9pm recipient-local. Tenants can narrow but should not widen.';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_calling_hours_days SMALLINT[]
    NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7]::SMALLINT[];

COMMENT ON COLUMN business_configs.outbound_calling_hours_days IS
  'ISO-8601 weekdays (Mon=1, Sun=7). Permissive default; tenants restrict to weekdays via ARRAY[1,2,3,4,5].';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS max_outbound_calls_per_day INT NOT NULL DEFAULT 100;

COMMENT ON COLUMN business_configs.max_outbound_calls_per_day IS
  'Soft per-tenant throttle. Reservation in 0-A; Phase 1 enforces at call-placement time.';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS record_outbound_calls BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN business_configs.record_outbound_calls IS
  'Phase 0 default ON with disclosure. Two-party-consent states require recording + disclosure regardless; this knob is for the optional disable case.';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS voice_consent_default BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN business_configs.voice_consent_default IS
  'Whether outbound consent is presumed valid for this tenant''s leads (e.g. industries where every lead provides express consent inbound). Cautious default FALSE.';

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS outbound_caller_id_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN business_configs.outbound_caller_id_verified_at IS
  'When the tenant''s main line passed Twilio OutgoingCallerIds verification. Promised as Slice 2B in docs/twilio-caller-id-verification.md; landing now so Phase 1 can gate on it instead of the current optimistic+21217-catch pattern.';

-- ───────────────────────────────────────────────────────────────────────
-- (3) leads extensions — per-lead DNC override + attempt counters

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN leads.do_not_call IS
  'Per-lead override of dnc_list. Either source (lead-level OR dnc_list table match) blocks the call.';

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_outbound_attempt_at TIMESTAMPTZ;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS outbound_attempt_count INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_leads_outbound_candidates
  ON leads (business_id, status, do_not_call, last_outbound_attempt_at)
  WHERE do_not_call = FALSE;

-- ───────────────────────────────────────────────────────────────────────
-- (4) dnc_list — per-tenant phone-level suppression

CREATE TABLE IF NOT EXISTS dnc_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id) ON DELETE CASCADE,
  phone TEXT NOT NULL,                     -- E.164 format
  reason TEXT,                             -- customer_request | opt_out | regulatory | manual | other
  source TEXT,                             -- voice_optout | sms_stop | manual | federal_dnc | state_dnc | internal
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_dnc_list_business_phone
  ON dnc_list (business_id, phone);

-- ───────────────────────────────────────────────────────────────────────
-- (5) voice_consent_records — TCPA-grade consent audit trail

CREATE TABLE IF NOT EXISTS voice_consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  consent_type TEXT NOT NULL,              -- appointment_reminder | callback | marketing | survey
  granted BOOLEAN NOT NULL,
  source TEXT NOT NULL,                    -- inbound_conversation | signup_form | manual | import | web_form
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  evidence_text TEXT,                      -- exact words / disclosure shown to the customer
  evidence_call_id UUID REFERENCES lead_calls(id) ON DELETE SET NULL,
  evidence_lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  ip_address INET,
  user_agent TEXT,
  recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_consent_business_phone_type
  ON voice_consent_records (business_id, phone, consent_type, granted, revoked_at);

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only)

SELECT 'outbound_campaigns exists' AS check_name, COUNT(*) FROM outbound_campaigns;
SELECT 'dnc_list exists' AS check_name, COUNT(*) FROM dnc_list;
SELECT 'voice_consent_records exists' AS check_name, COUNT(*) FROM voice_consent_records;

SELECT
  'lead_calls new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'direction') AS direction,
  COUNT(*) FILTER (WHERE column_name = 'answered_by') AS answered_by,
  COUNT(*) FILTER (WHERE column_name = 'call_objective') AS call_objective,
  COUNT(*) FILTER (WHERE column_name = 'voicemail_left') AS voicemail_left,
  COUNT(*) FILTER (WHERE column_name = 'campaign_id') AS campaign_id,
  COUNT(*) FILTER (WHERE column_name = 'retry_count') AS retry_count,
  COUNT(*) FILTER (WHERE column_name = 'attempt_number') AS attempt_number,
  COUNT(*) FILTER (WHERE column_name = 'scheduled_for') AS scheduled_for
FROM information_schema.columns
WHERE table_name = 'lead_calls'
  AND column_name IN ('direction','answered_by','call_objective','voicemail_left','campaign_id','retry_count','attempt_number','scheduled_for');

SELECT
  'business_configs new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'outbound_voice_enabled') AS outbound_voice_enabled,
  COUNT(*) FILTER (WHERE column_name = 'outbound_calling_hours_start') AS calling_hours_start,
  COUNT(*) FILTER (WHERE column_name = 'outbound_calling_hours_end') AS calling_hours_end,
  COUNT(*) FILTER (WHERE column_name = 'outbound_calling_hours_days') AS calling_hours_days,
  COUNT(*) FILTER (WHERE column_name = 'max_outbound_calls_per_day') AS max_per_day,
  COUNT(*) FILTER (WHERE column_name = 'record_outbound_calls') AS record_outbound,
  COUNT(*) FILTER (WHERE column_name = 'voice_consent_default') AS voice_consent_default,
  COUNT(*) FILTER (WHERE column_name = 'outbound_caller_id_verified_at') AS caller_id_verified_at
FROM information_schema.columns
WHERE table_name = 'business_configs'
  AND column_name IN ('outbound_voice_enabled','outbound_calling_hours_start','outbound_calling_hours_end','outbound_calling_hours_days','max_outbound_calls_per_day','record_outbound_calls','voice_consent_default','outbound_caller_id_verified_at');

SELECT
  'leads new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'do_not_call') AS do_not_call,
  COUNT(*) FILTER (WHERE column_name = 'last_outbound_attempt_at') AS last_attempt_at,
  COUNT(*) FILTER (WHERE column_name = 'outbound_attempt_count') AS attempt_count
FROM information_schema.columns
WHERE table_name = 'leads'
  AND column_name IN ('do_not_call','last_outbound_attempt_at','outbound_attempt_count');

SELECT
  'lead_calls.direction CHECK' AS check_name,
  pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
WHERE c.conname = 'lead_calls_direction_chk'
  AND c.conrelid = 'public.lead_calls'::regclass;

COMMIT;
