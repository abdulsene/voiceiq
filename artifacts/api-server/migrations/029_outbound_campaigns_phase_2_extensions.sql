-- 029_outbound_campaigns_phase_2_extensions.sql
-- Phase 2.1 — outbound_campaigns extensions for the Phase 2 campaign engine.
--
-- Phase 1 used the lean outbound_campaigns shape from migration 025 — it's
-- enough to attach individual placeCall invocations to a campaign and bump
-- counters at terminal state. Phase 2 introduces campaign-level orchestration
-- (segment resolution, scheduled expansion, per-campaign voicemail copy,
-- per-campaign daily caps) which needs richer state on each campaign row.
--
-- All seven new columns are ADDITIVE — existing rows from Phase 0 / Phase 1
-- continue working untouched. No backfill required: NULL/default values for
-- the new fields are intentionally meaningful:
--   segment_definition NULL  → "no leads in segment" (defensive — campaign
--                              cannot be expanded until ops populates it)
--   schedule_definition NULL → same (schedule_strategy default is 'bulk' but
--                              that just picks the JSON shape, not the values)
--   daily_cap NULL           → no campaign-level cap; tenant cap still binds
--   voicemail_text_override NULL → inherit business_configs.outbound_voicemail_text
--   schedule_strategy 'bulk' → default to bulk-style scheduling
--   expansion_running FALSE  → cooperative lock for the 2.4 expansion worker
--   last_expansion_at NULL   → never expanded yet
--
-- segment_definition / schedule_definition JSON shapes are documented in
-- lib/outbound-campaigns/ (lands in 2.3). 2.1 lays DDL only.
--
-- Atomic — wrapped in BEGIN/COMMIT so a mid-file failure rolls back the
-- partial state. Idempotent — IF NOT EXISTS / DO blocks guard every ADD.
--
-- Apply via Supabase SQL editor against project zqhijauefcpwggklshoa.

BEGIN;

-- segment_definition: WHO is in the campaign. JSON DSL with {version, filters:
-- {all: [], any: []}}. See lib/outbound-campaigns/segment-resolver.ts (2.3).
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS segment_definition JSONB;

COMMENT ON COLUMN outbound_campaigns.segment_definition IS
  'JSON DSL describing the lead segment. {version, filters: {all, any}}. NULL = empty segment (campaign cannot expand). See lib/outbound-campaigns/segment-resolver.ts.';

-- schedule_definition: WHEN each lead gets called. Strategy-specific shape;
-- the schedule_strategy column below tells the worker which shape to expect.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS schedule_definition JSONB;

COMMENT ON COLUMN outbound_campaigns.schedule_definition IS
  'JSON DSL describing when each lead in the segment gets called. Shape depends on schedule_strategy. NULL = no schedule yet (campaign cannot expand). See lib/outbound-campaigns/schedule-resolver.ts (Phase 2.3).';

-- daily_cap: per-campaign daily cap. NULL means no campaign-level cap; tenant
-- cap (business_configs.max_outbound_calls_per_day) is the only ceiling.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS daily_cap INT;

COMMENT ON COLUMN outbound_campaigns.daily_cap IS
  'Max outbound_automated calls placed PER DAY from THIS campaign. NULL = no campaign-level cap. The tenant cap (business_configs.max_outbound_calls_per_day) is always also enforced. The smaller of (daily_cap, tenant_cap - other_campaigns_count) is the effective limit on each tick.';

-- voicemail_text_override: per-campaign voicemail copy. NULL means inherit
-- business_configs.outbound_voicemail_text. Wired into the Phase 1.6
-- voicemail TwiML route + AMD redirect resolution in Phase 2.5.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS voicemail_text_override TEXT;

COMMENT ON COLUMN outbound_campaigns.voicemail_text_override IS
  'Per-campaign voicemail message. NULL = inherit business_configs.outbound_voicemail_text. Wired into the Phase 1.6 AMD redirect + voicemail TwiML route in Phase 2.5.';

-- schedule_strategy: which JSON shape lives in schedule_definition. drip is
-- deferred — adding it later is a one-line CHECK swap.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS schedule_strategy TEXT NOT NULL DEFAULT 'bulk';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbound_campaigns_schedule_strategy_chk'
      AND conrelid = 'public.outbound_campaigns'::regclass
  ) THEN
    ALTER TABLE outbound_campaigns
      ADD CONSTRAINT outbound_campaigns_schedule_strategy_chk
      CHECK (schedule_strategy IN ('bulk', 'time_relative'));
  END IF;
END $$;

COMMENT ON COLUMN outbound_campaigns.schedule_strategy IS
  'bulk = single segment evaluation, spread N calls over a window. time_relative = continuous expansion keyed to a per-lead timestamp (e.g. appointment_at - 24h). drip deferred to a future migration when a use case emerges.';

-- expansion_running: cooperative lock for the Phase 2.4 expansion worker.
-- UPDATE outbound_campaigns SET expansion_running = TRUE WHERE id=$1 AND
-- expansion_running = FALSE RETURNING id is atomic at the row level. Worker
-- clears it at end of tick. Stuck-row recovery (auto-clear on rows older
-- than ~10 min) deferred to Phase 3 — same posture as 1.5b's 'processing'
-- stuck-row policy.
ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS expansion_running BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN outbound_campaigns.expansion_running IS
  'Cooperative lock for the Phase 2.4 expansion worker. UPDATE-RETURNING grants exclusive expansion rights for this campaign. Worker clears on tick end. Manual reset if a worker crashes mid-tick (stuck-row recovery deferred to Phase 3).';

ALTER TABLE outbound_campaigns
  ADD COLUMN IF NOT EXISTS last_expansion_at TIMESTAMPTZ;

COMMENT ON COLUMN outbound_campaigns.last_expansion_at IS
  'Wall-clock of the last successful expansion tick. Observability + used by some segment strategies to compute incremental deltas.';

-- Verification reads
SELECT
  'outbound_campaigns Phase 2 extensions' AS check_name,
  COUNT(*) FILTER (WHERE column_name = 'segment_definition') AS segment_definition,
  COUNT(*) FILTER (WHERE column_name = 'schedule_definition') AS schedule_definition,
  COUNT(*) FILTER (WHERE column_name = 'daily_cap') AS daily_cap,
  COUNT(*) FILTER (WHERE column_name = 'voicemail_text_override') AS voicemail_text_override,
  COUNT(*) FILTER (WHERE column_name = 'schedule_strategy') AS schedule_strategy,
  COUNT(*) FILTER (WHERE column_name = 'expansion_running') AS expansion_running,
  COUNT(*) FILTER (WHERE column_name = 'last_expansion_at') AS last_expansion_at
FROM information_schema.columns
WHERE table_name = 'outbound_campaigns'
  AND column_name IN ('segment_definition','schedule_definition','daily_cap','voicemail_text_override','schedule_strategy','expansion_running','last_expansion_at');

SELECT
  'outbound_campaigns.schedule_strategy CHECK' AS check_name,
  pg_get_constraintdef(c.oid) AS constraint_def
FROM pg_constraint c
WHERE c.conname = 'outbound_campaigns_schedule_strategy_chk'
  AND c.conrelid = 'public.outbound_campaigns'::regclass;

COMMIT;
