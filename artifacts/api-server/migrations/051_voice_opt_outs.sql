-- 051_voice_opt_outs.sql
-- Phase 5.1 — voice-side opt-out registry.
--
-- Parallel to sms_opt_outs, INTENTIONALLY a separate table. TCPA is
-- channel-specific — a customer who consented to marketing texts has
-- not consented to AI voice calls to their mobile (47 CFR §64.1200
-- distinguishes SMS/MMS from voice). Two tables makes it structurally
-- impossible for a voice-side query to accidentally read an SMS opt-out
-- (which could either false-block a legitimate voice consent OR, worse,
-- false-allow a voice call when SMS opt-out was actually there).
--
-- Retention: MINIMUM 5 years per TCPA §64.1200(d)(6) (internal DNC list
-- retention). EXCLUDE this table from the general retention purge job.
--
-- ── Columns ──────────────────────────────────────────────────────────
--
-- Mirrors sms_opt_outs (id, business_id, phone, opted_out_at, reason,
-- resubscribed_at) so ops surfaces are operationally symmetric across
-- channels. Adds voice-specific columns because voice opt-outs have
-- richer sources than SMS:
--
--   source TEXT
--     enum (app-layer, no CHECK so future values don't need migrations):
--       'mid_call_verbal'     — Alex's record_opt_out tool triggered
--                                during a call (§record_opt_out below)
--       'inbound_call'        — caller asked during a regular call
--       'web_form'            — self-service opt-out page
--       'manual'              — staff added via dashboard
--       'federal_dnc_scrub'   — periodic scrub matched federal registry
--       'internal_dnc_sync'   — synced from leads.do_not_call flip
--
--   evidence_call_id UUID  → calls(id) ON DELETE SET NULL
--     For 'mid_call_verbal' and 'inbound_call'. Points at the call where
--     the opt-out was uttered so a compliance review can hear the
--     recording (once Phase 4.2 Item 2 recording ships).
--
--   captured_by_user_id UUID  → auth.users(id) ON DELETE SET NULL
--     For 'manual' entries. NULL for automated sources.
--
--   notes TEXT
--     Free-form context. For 'mid_call_verbal', we store the caller's
--     verbatim words (PII-redacted via pii-redact-transcript.ts) so
--     staff can review WHAT was said, not just that opt-out was
--     requested.
--
-- resubscribed_at TIMESTAMPTZ (mirrors sms_opt_outs)
--   Semantically: "this opt-out was superseded by new opt-in consent."
--   TCPA §64.1200(d)(6) requires 5-year internal DNC retention, so we
--   NEVER delete rows even on resubscribe — the resubscribed_at column
--   marks that a new voice_consent_records row grants going forward.
--
-- ── Uniqueness ───────────────────────────────────────────────────────
--
-- UNIQUE (business_id, phone) WHERE resubscribed_at IS NULL — at most
-- one active opt-out per (tenant, phone). Second opt-out from the same
-- number is idempotent no-op at the record_opt_out tool. When
-- resubscribed_at gets set, that row is no longer "active" and a fresh
-- opt-out can be recorded.
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   \d voice_opt_outs
--   SELECT indexdef FROM pg_indexes WHERE tablename = 'voice_opt_outs';

BEGIN;

CREATE TABLE IF NOT EXISTS voice_opt_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  source TEXT,
  evidence_call_id UUID,
  captured_by_user_id UUID,
  notes TEXT,
  resubscribed_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_opt_outs_business_fk'
       AND conrelid = 'voice_opt_outs'::regclass
  ) THEN
    ALTER TABLE voice_opt_outs
      ADD CONSTRAINT voice_opt_outs_business_fk
      FOREIGN KEY (business_id) REFERENCES business_configs(business_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_opt_outs_evidence_call_fk'
       AND conrelid = 'voice_opt_outs'::regclass
  ) THEN
    ALTER TABLE voice_opt_outs
      ADD CONSTRAINT voice_opt_outs_evidence_call_fk
      FOREIGN KEY (evidence_call_id) REFERENCES calls(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'voice_opt_outs_captured_by_fk'
       AND conrelid = 'voice_opt_outs'::regclass
  ) THEN
    ALTER TABLE voice_opt_outs
      ADD CONSTRAINT voice_opt_outs_captured_by_fk
      FOREIGN KEY (captured_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Uniqueness: one active opt-out per (tenant, phone). Partial index so
-- resubscribed rows don't block a subsequent fresh opt-out.
CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_opt_outs_active
  ON voice_opt_outs (business_id, phone)
  WHERE resubscribed_at IS NULL;

-- Lookup index for the compliance gate. Same shape checkVoiceOptOut
-- uses (business_id + phone). Non-unique to allow historical rows.
CREATE INDEX IF NOT EXISTS idx_voice_opt_outs_lookup
  ON voice_opt_outs (business_id, phone, opted_out_at DESC);

COMMENT ON TABLE voice_opt_outs IS
  'Phase 5.1: TCPA §64.1200(d) internal DNC list for voice calls. Separate from sms_opt_outs — a customer who opted out of SMS has not opted out of voice (and vice versa). Retention: MINIMUM 5 years per §64.1200(d)(6); exclude from the general retention purge job. Populated by the record_opt_out ElevenLabs tool (mid_call_verbal), the web opt-out page (web_form), staff manual entries (manual), and the federal DNC scrub (federal_dnc_scrub). See migration 051 header + lib/voice-opt-out.ts.';

COMMENT ON COLUMN voice_opt_outs.source IS
  'Phase 5.1: how the opt-out was captured. App-layer enum (no CHECK constraint) so future sources like ''carrier_notice'' can be added without a migration. Documented values: mid_call_verbal | inbound_call | web_form | manual | federal_dnc_scrub | internal_dnc_sync.';

COMMENT ON COLUMN voice_opt_outs.evidence_call_id IS
  'Phase 5.1: for mid_call_verbal and inbound_call sources — the call.id where the opt-out was uttered. Enables compliance review of the recording (once Phase 4.2 Item 2 recording lands). NULL for other sources.';

COMMENT ON COLUMN voice_opt_outs.resubscribed_at IS
  'Phase 5.1: mirrors sms_opt_outs.resubscribed_at. Set when a new voice_consent_records row grants consent AFTER this opt-out. The row is NEVER deleted (5-year §64.1200(d)(6) retention); resubscribed_at moves it out of the active-opt-out set for the UNIQUE partial index.';

COMMIT;
