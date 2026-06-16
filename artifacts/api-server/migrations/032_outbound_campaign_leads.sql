-- 032_outbound_campaign_leads.sql
-- Phase 2.3 — outbound_campaign_leads junction table.
--
-- The per-(campaign, lead) state map. Phase 2.4's expansion worker
-- INSERTs into this table to materialize a campaign's segment into
-- individual scheduled rows. UNIQUE(campaign_id, lead_id) provides
-- idempotency for the worker's ON CONFLICT DO NOTHING posture —
-- re-running expansion never double-schedules the same lead.
--
-- State machine:
--   pending → scheduled  (segment + schedule resolved, lead_calls row inserted)
--   pending → skipped    (eligibility check failed — dnc/consent/calling_hours/already_in_campaign)
--   scheduled → completed (lead_call fired and reached terminal state)
--   scheduled → skipped  (worker decided to abort before placement; rare)
--
-- opted_out is reserved for a future per-campaign opt-out feature
-- (Phase 3+); no 2.3-2.5 code path triggers it.
--
-- skip_reason vocabulary: matches CampaignSkipReason in
-- lib/outbound-voice/compliance.ts — 'dnc' | 'consent' |
-- 'calling_hours' | 'already_in_campaign'. Plus 'no_matching_anchor'
-- when time_relative schedule misses (Phase 2.4 worker writes this).
-- TEXT (no CHECK) so vocabulary can grow without DDL churn.
--
-- FK cascade design:
--   campaign_id → outbound_campaigns ON DELETE CASCADE
--     Deleting a campaign removes its junction rows (campaign was the
--     source of truth for those rows).
--   lead_id → leads ON DELETE CASCADE
--     Deleting a lead removes participation (can't auto-call a deleted
--     lead).
--   scheduled_call_id → lead_calls ON DELETE SET NULL
--     Retention sweeps that prune lead_calls null this FK; junction row
--     stays as audit-bearing.
--
-- Indexes:
--   idx_ocl_campaign_state ON (campaign_id, state) — primary worker
--     query "what work is pending/scheduled for this campaign"
--   idx_ocl_lead_state partial ON (lead_id, state)
--     WHERE state IN ('pending', 'scheduled') — supports the
--     already_in_campaign eligibility check
--   Plus implicit UNIQUE index from UNIQUE(campaign_id, lead_id)
--     — serves ON CONFLICT idempotency
--
-- RLS posture: matches Phase 1 tables. Enabled, no policies; service-
-- role-only via WHERE campaign_id = (joined to business_id) in app code.
--
-- updated_at trigger via trigger_set_updated_at() from migration 030.
--
-- Atomic — BEGIN/COMMIT. Idempotent — IF NOT EXISTS guards every
-- CREATE / ADD. Re-applies cleanly.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

CREATE TABLE IF NOT EXISTS outbound_campaign_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  campaign_id UUID NOT NULL
    REFERENCES outbound_campaigns(id) ON DELETE CASCADE,

  lead_id UUID NOT NULL
    REFERENCES leads(id) ON DELETE CASCADE,

  state TEXT NOT NULL DEFAULT 'pending',

  skip_reason TEXT,

  scheduled_call_id UUID
    REFERENCES lead_calls(id) ON DELETE SET NULL,

  scheduled_for TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (campaign_id, lead_id)
);

-- State CHECK constraint — guarded for idempotent re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbound_campaign_leads_state_chk'
      AND conrelid = 'public.outbound_campaign_leads'::regclass
  ) THEN
    ALTER TABLE outbound_campaign_leads
      ADD CONSTRAINT outbound_campaign_leads_state_chk
      CHECK (state IN ('pending', 'scheduled', 'completed', 'skipped', 'opted_out'));
  END IF;
END $$;

-- Primary worker query — "what's pending/scheduled for this campaign".
CREATE INDEX IF NOT EXISTS idx_ocl_campaign_state
  ON outbound_campaign_leads (campaign_id, state);

-- already_in_campaign eligibility check — partial because we only
-- care about active states. Saves index space on terminal-state rows.
CREATE INDEX IF NOT EXISTS idx_ocl_lead_state
  ON outbound_campaign_leads (lead_id, state)
  WHERE state IN ('pending', 'scheduled');

-- updated_at auto-bump trigger via the shared function from 030.
DROP TRIGGER IF EXISTS trg_outbound_campaign_leads_updated_at ON outbound_campaign_leads;
CREATE TRIGGER trg_outbound_campaign_leads_updated_at
  BEFORE UPDATE ON outbound_campaign_leads
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- RLS — match Phase 1 tables. Enabled, no policies; service-role-only.
ALTER TABLE outbound_campaign_leads ENABLE ROW LEVEL SECURITY;

-- COMMENT ON TABLE + per-column comments

COMMENT ON TABLE outbound_campaign_leads IS
  'Junction table between outbound_campaigns and leads — captures the per-(campaign, lead) materialization state. Phase 2.4 expansion worker INSERTs here when it resolves a segment into individual scheduled calls. UNIQUE(campaign_id, lead_id) provides idempotency so re-running expansion never double-schedules.';

COMMENT ON COLUMN outbound_campaign_leads.id IS
  'Primary key. UUID v4 via gen_random_uuid().';

COMMENT ON COLUMN outbound_campaign_leads.campaign_id IS
  'FK to outbound_campaigns. ON DELETE CASCADE — deleting a campaign removes its junction rows (campaign owned them).';

COMMENT ON COLUMN outbound_campaign_leads.lead_id IS
  'FK to leads. ON DELETE CASCADE — deleting a lead removes participation (can''t auto-call a deleted lead).';

COMMENT ON COLUMN outbound_campaign_leads.state IS
  'Lifecycle: pending (just inserted, eligibility not yet evaluated) | scheduled (eligibility passed + lead_calls row inserted) | completed (lead_call reached terminal) | skipped (eligibility failed; see skip_reason). opted_out is reserved for a future per-campaign opt-out feature (Phase 3+). CHECK-constrained via outbound_campaign_leads_state_chk.';

COMMENT ON COLUMN outbound_campaign_leads.skip_reason IS
  'When state=skipped, the reason. Vocabulary matches CampaignSkipReason in lib/outbound-voice/compliance.ts — dnc | consent | calling_hours | already_in_campaign. Phase 2.4 worker may also write no_matching_anchor when time_relative schedule misses. TEXT, no CHECK, so vocabulary grows without DDL churn.';

COMMENT ON COLUMN outbound_campaign_leads.scheduled_call_id IS
  'FK to lead_calls when this junction row was successfully materialized into a scheduled call. ON DELETE SET NULL — retention sweeps that prune lead_calls null this; junction row stays as audit-bearing.';

COMMENT ON COLUMN outbound_campaign_leads.scheduled_for IS
  'When the call would fire — computed by schedule-resolver from the campaign''s schedule_definition. NULL until the worker resolves; matches the corresponding lead_calls.scheduled_for value.';

COMMENT ON COLUMN outbound_campaign_leads.completed_at IS
  'Wall-clock when the lead_call reached terminal state. Phase 2.4 status webhook updates this. NULL until terminal.';

COMMENT ON COLUMN outbound_campaign_leads.created_at IS
  'Insert timestamp. Defaults NOW().';

COMMENT ON COLUMN outbound_campaign_leads.updated_at IS
  'Last-mutation timestamp. Auto-bumped via trg_outbound_campaign_leads_updated_at.';

COMMIT;
