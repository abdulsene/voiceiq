-- Phase 3j: Marketing site early-access opt-in.
--
-- Public-facing opt-in capture for Neverr's own marketing list. Two surfaces:
--   * Landing-page "Early access" section (email + phone + business name + 2x SMS consent)
--   * Footer compact widget (email-only, no SMS consent)
--
-- Twilio-compliant: separate transactional vs. marketing SMS consent flags
-- captured per submission, with IP / UA / page URL / UTM provenance for audit.
--
-- Submissions upsert by email so re-submissions update the latest consent
-- state rather than creating duplicates.
--
-- RLS is enabled with no policies so only the service role (backend) can
-- read/write. No anon or authenticated user can touch this table directly.

CREATE TABLE IF NOT EXISTS marketing_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  phone TEXT,
  business_name TEXT,
  consent_transactional BOOLEAN NOT NULL DEFAULT FALSE,
  consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  page_url TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  sendgrid_synced_at TIMESTAMPTZ,
  sendgrid_contact_id TEXT,
  unsubscribed_at TIMESTAMPTZ,
  unsubscribe_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness on email — supports the upsert-by-email pattern. The submit
-- route lowercases email before insert, so a plain unique index on the bare
-- column is enough (and is what Postgres's ON CONFLICT (email) needs to match;
-- a functional LOWER(email) index would not satisfy that inference).
DROP INDEX IF EXISTS idx_marketing_subscribers_email;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_subscribers_email_key
  ON marketing_subscribers(email);

CREATE INDEX IF NOT EXISTS idx_marketing_subscribers_created
  ON marketing_subscribers(created_at DESC);

-- Partial index supports the "active marketing-consented subscribers" list
-- (e.g. for outbound email/SMS broadcasts).
CREATE INDEX IF NOT EXISTS idx_marketing_subscribers_active_marketing
  ON marketing_subscribers(email)
  WHERE consent_marketing = TRUE AND unsubscribed_at IS NULL;

ALTER TABLE marketing_subscribers ENABLE ROW LEVEL SECURITY;
-- (No CREATE POLICY: locked down by default — service role only.)
