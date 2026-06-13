-- 024_slice_3a_substrate.sql
-- Slice 3A — closed-loop first touch.
--
-- Three pillars; this migration lays the persistence for all three:
--   Pillar 1 — outcome capture per call          → lead_call_outcomes
--                                                 + leads.outcome_booked
--   Pillar 2 — customer SMS confirmation +       → sms_messages
--              pre-call alert                      + sms_opt_outs
--   Pillar 3 — customer trust portal at /r/<tk>  → lead_ratings
--                                                 + leads.trust_portal_disabled
--                                                 + leads.trust_portal_revoked_at
--                                                 + business_configs.trust_portal_disabled
--                                                 + business_configs.sla_overrides
--
-- Schema design notes:
--   - lead_call_outcomes is a SEPARATE table (not lead_calls.metadata)
--     because outcome is a staff-recorded judgment AFTER the call
--     finishes, not part of the bridge state machine. UNIQUE per
--     lead_call_id so a re-record overwrites via UPSERT (or rejects,
--     depending on route policy).
--   - leads.outcome_booked is a denormalised flag for "won deal"
--     analytics — single column index for funnel reports without
--     joining lead_call_outcomes on every query.
--   - sms_messages logs BOTH outbound and inbound. Inbound rows have
--     no template/template_locale set. twilio_sid is UNIQUE WHERE NOT
--     NULL so a stuck retry doesn't duplicate the row.
--   - sms_opt_outs is keyed on (business_id, phone) UNIQUE WHERE
--     resubscribed_at IS NULL. A customer can opt out of one tenant
--     and stay subscribed to another. A subsequent START flips
--     resubscribed_at and the partial index allows a future opt-out
--     row to coexist.
--   - lead_ratings is one per lead (UNIQUE on lead_id) — a customer
--     can't double-rate. Updates go through the route layer using
--     UPSERT on the unique index.
--   - business_configs.sla_overrides is JSONB; lib/lead-sla.ts
--     resolves it against SLA_DEFAULTS. No UI knob in Slice 3A.
--   - business_configs.trust_portal_disabled is the tenant-wide
--     kill switch; leads.trust_portal_disabled is the per-lead
--     kill switch. EITHER being true means the token returns 404.
--   - leads.trust_portal_revoked_at is documentation-only — when
--     the per-lead flag was set, who set it, and why live in
--     lead_activities. The timestamp lets analytics filter recent
--     revocations cheaply.
--
-- No CHECK constraints on lead_call_outcomes.outcome /
-- lead_activities.action by design — both columns are plain TEXT in
-- the original migrations and the route layer is the validation
-- boundary. Adding a CHECK here would couple every future outcome
-- vocab change to a migration apply, which is overkill for a
-- staff-curated enum.
--
-- Apply via Supabase SQL editor against project zqhijauefcpwggklshoa.
-- Idempotent CREATE / ADD IF NOT EXISTS so safe to re-run.

CREATE TABLE IF NOT EXISTS lead_call_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_call_id UUID NOT NULL REFERENCES lead_calls(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,                  -- resolved|booked|follow_up_needed|no_answer|wrong_number|declined|lost|other
  reason_code TEXT,                       -- price|timing|competitor|not_qualified|changed_mind|other
  reason_note TEXT,
  follow_up_at TIMESTAMPTZ,               -- required when outcome='follow_up_needed'
  recorded_by_user_id UUID REFERENCES auth.users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_call_outcomes_per_call_unique
  ON lead_call_outcomes(lead_call_id);

CREATE INDEX IF NOT EXISTS lead_call_outcomes_lead_idx
  ON lead_call_outcomes(lead_id, recorded_at DESC);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS outcome_booked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS trust_portal_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS trust_portal_revoked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_outcome_booked_idx
  ON leads(business_id, outcome_booked, created_at DESC)
  WHERE outcome_booked = true;

-- ───────────────────────────────────────────────────────────────────────
-- SMS persistence

CREATE TABLE IF NOT EXISTS sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id),
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,                -- 'outbound' | 'inbound'
  to_phone TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  template TEXT,                          -- only set on templated outbound
  template_locale TEXT,                   -- 'en' | 'es' | 'fr'
  twilio_sid TEXT,
  status TEXT,                            -- 'queued' | 'sent' | 'delivered' | 'failed' | 'opted_out'
  error_message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sms_messages_business_idx
  ON sms_messages(business_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS sms_messages_lead_idx
  ON sms_messages(lead_id, sent_at DESC) WHERE lead_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_twilio_sid_unique
  ON sms_messages(twilio_sid) WHERE twilio_sid IS NOT NULL;

-- Per-tenant opt-out registry. Partial unique index lets a customer
-- opt-out → resubscribe → opt-out again cleanly: only the currently-
-- active opt-out (resubscribed_at IS NULL) is unique.
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id),
  phone TEXT NOT NULL,
  opted_out_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,                            -- 'stop_reply' | 'staff_initiated' | 'compliance'
  resubscribed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_outs_active_unique
  ON sms_opt_outs(business_id, phone) WHERE resubscribed_at IS NULL;

CREATE INDEX IF NOT EXISTS sms_opt_outs_business_idx
  ON sms_opt_outs(business_id, opted_out_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- Trust portal — ratings + tenant knobs

CREATE TABLE IF NOT EXISTS lead_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  business_id TEXT NOT NULL REFERENCES business_configs(business_id),
  score INTEGER NOT NULL,
  comment TEXT,
  rated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_ratings_score_range CHECK (score >= 1 AND score <= 5)
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_ratings_per_lead_unique
  ON lead_ratings(lead_id);

CREATE INDEX IF NOT EXISTS lead_ratings_business_idx
  ON lead_ratings(business_id, rated_at DESC);

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS trust_portal_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sla_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only)

SELECT 'lead_call_outcomes exists' AS check_name, COUNT(*) FROM lead_call_outcomes;
SELECT 'sms_messages exists' AS check_name, COUNT(*) FROM sms_messages;
SELECT 'sms_opt_outs exists' AS check_name, COUNT(*) FROM sms_opt_outs;
SELECT 'lead_ratings exists' AS check_name, COUNT(*) FROM lead_ratings;
SELECT
  'leads new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'outcome_booked') AS outcome_booked,
  COUNT(*) FILTER (WHERE column_name = 'trust_portal_disabled') AS trust_portal_disabled,
  COUNT(*) FILTER (WHERE column_name = 'trust_portal_revoked_at') AS trust_portal_revoked_at
FROM information_schema.columns
WHERE table_name = 'leads' AND column_name IN ('outcome_booked', 'trust_portal_disabled', 'trust_portal_revoked_at');
SELECT
  'business_configs new columns' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'trust_portal_disabled') AS trust_portal_disabled,
  COUNT(*) FILTER (WHERE column_name = 'sla_overrides') AS sla_overrides
FROM information_schema.columns
WHERE table_name = 'business_configs' AND column_name IN ('trust_portal_disabled', 'sla_overrides');
