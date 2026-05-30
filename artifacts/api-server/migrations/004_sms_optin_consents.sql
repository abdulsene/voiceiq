-- Phase 3f — Twilio-compliant SMS opt-in consent storage.
--
-- Apply via Supabase SQL editor on the project database. Idempotent: safe
-- to re-run.

CREATE TABLE IF NOT EXISTS sms_optin_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  contact_first_name TEXT NOT NULL,
  contact_last_name TEXT,
  contact_phone TEXT NOT NULL,
  contact_email TEXT,
  consent_transactional BOOLEAN NOT NULL DEFAULT FALSE,
  consent_promotional BOOLEAN NOT NULL DEFAULT FALSE,
  accepted_terms BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  page_url TEXT,
  revoked_at TIMESTAMPTZ,
  revoke_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sms_optin_consents_business
  ON sms_optin_consents(business_id);

CREATE INDEX IF NOT EXISTS idx_sms_optin_consents_phone
  ON sms_optin_consents(business_id, contact_phone);

ALTER TABLE sms_optin_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_optin_consents_tenant_scoped" ON sms_optin_consents;

CREATE POLICY "sms_optin_consents_tenant_scoped"
  ON sms_optin_consents
  FOR ALL
  TO authenticated
  USING (
    business_id IN (
      SELECT user_businesses.business_id
      FROM user_businesses
      WHERE user_id = auth.uid()
    )
  );

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS sms_optin_settings JSONB DEFAULT '{}'::jsonb;
