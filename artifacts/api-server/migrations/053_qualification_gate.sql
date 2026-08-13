-- 053_qualification_gate.sql
-- Phase 6.0 — per-topic qualification gate.
--
-- Alex now reads a per-topic qualifications recital to callers whose
-- intent matches a gated topic (e.g. new_reservation for car rental),
-- confirms the caller meets every requirement, and only then invokes
-- route_to_topic. Callers who fail become leads with a distinct
-- qualification_status so they don't pollute the workable pipeline.
--
-- The qualifications spec itself lives on business_configs.departments
-- (existing JSONB column, no schema change needed here). Each topic
-- object may carry an optional `qualification` sub-object; renderer and
-- tool-schema code read it directly. See prompt-renderer.ts and
-- agents.ts:buildRequestCallbackTool for the reader-side shape.
--
-- Three new columns:
--
--   * leads.qualification_status  — CHECK enum:
--       'qualified'              — normal callback (default when NULL)
--       'unqualified_temporary'  — caller failed a temporary requirement
--                                  (only-1-day, cannot pay by 3pm today,
--                                   no accepted payment method). Can
--                                  become a customer later — dashboard
--                                  surfaces these under "Waiting to
--                                  qualify" so the tenant can work them.
--       'unqualified_permanent'  — caller failed a permanent requirement
--                                  (no MD license, under 25, needs to
--                                   leave MD, needs DC/PA/VA). No path
--                                  to conversion by calling back. Kept
--                                  for record only.
--     NULL treated as 'qualified' for backwards compatibility — no
--     backfill needed. See routes/leads.ts:parseListQuery for the
--     default-exclude filter that keeps unqualified_* out of the
--     normal pipeline unless explicitly requested.
--
--   * leads.disqualifier_id — TEXT, no FK. IDs live in the topic JSONB
--     (business_configs.departments[n].qualification.disqualifiers[m].id).
--     A tenant CAN delete a disqualifier from that JSONB, orphaning
--     existing leads that reference it. Dashboard falls back to
--     rendering the raw id when label lookup fails so a row NEVER
--     shows a blank reason. See LeadsListPage.tsx:disqualifierLabel.
--
--   * calls.qualification_bypassed — BOOLEAN. Set to TRUE when Alex
--     invokes route_to_topic for a qualification-gated topic WITHOUT
--     passing qualification_confirmed=true. Do NOT block the routing;
--     the caller still gets connected. This column is the SQL-queryable
--     signal for "how many people did Alex transfer who shouldn't have
--     been?" — see routes/routing.ts:handleRouteToTopic for the write
--     path. NULL for calls that didn't hit route_to_topic OR for
--     topics without a qualification gate.
--
-- Partial indexes for the new "Waiting to qualify" and "Not eligible"
-- tabs on the leads dashboard. Partial because the overwhelming
-- majority of leads are qualified (NULL / 'qualified') and we don't
-- want a full-table index bloating writes on the hot path.
--
-- Idempotent — IF NOT EXISTS on every DDL. Additive, no drops. Atomic
-- BEGIN/COMMIT so a half-landing on one column doesn't leave the
-- CHECK constraint orphaned.
--
-- Apply via Supabase apply_migration MCP against project
-- zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE (table_name = 'leads'
--       AND column_name IN ('qualification_status','disqualifier_id'))
--       OR (table_name = 'calls'
--       AND column_name = 'qualification_bypassed');
--
--   SELECT conname, pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conrelid = 'leads'::regclass
--      AND conname = 'leads_qualification_status_check';
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'leads'
--      AND indexname IN ('idx_leads_qualification_temporary',
--                        'idx_leads_qualification_permanent');

BEGIN;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS qualification_status TEXT;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS disqualifier_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'leads_qualification_status_check'
       AND conrelid = 'leads'::regclass
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_qualification_status_check
      CHECK (
        qualification_status IS NULL
        OR qualification_status IN (
          'qualified',
          'unqualified_temporary',
          'unqualified_permanent'
        )
      );
  END IF;
END $$;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS qualification_bypassed BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_leads_qualification_temporary
  ON leads (business_id, created_at DESC)
  WHERE qualification_status = 'unqualified_temporary';

CREATE INDEX IF NOT EXISTS idx_leads_qualification_permanent
  ON leads (business_id, created_at DESC)
  WHERE qualification_status = 'unqualified_permanent';

CREATE INDEX IF NOT EXISTS idx_calls_qualification_bypassed
  ON calls (business_id, created_at DESC)
  WHERE qualification_bypassed = TRUE;

COMMENT ON COLUMN leads.qualification_status IS
  'Phase 6.0: caller-attribute state (orthogonal to leads.status which is workflow state). NULL treated as ''qualified'' for pre-6.0 rows — no backfill. unqualified_temporary = failed a temporary requirement (can convert on callback: 1-day-only, cannot pay by 3pm, no accepted payment method). unqualified_permanent = failed a permanent requirement (no MD license, under 25, needs to leave MD, needs DC/PA/VA). See routes/leads.ts for the derivation from disqualifier_id.';

COMMENT ON COLUMN leads.disqualifier_id IS
  'Phase 6.0: which requirement failed. Free-form TEXT, no FK — ids live in business_configs.departments[n].qualification.disqualifiers[m].id. Tenant may delete a disqualifier from JSONB, orphaning existing leads; dashboard falls back to raw id display (LeadsListPage.tsx). NULL when qualification_status IS NULL or ''qualified''.';

COMMENT ON COLUMN calls.qualification_bypassed IS
  'Phase 6.0: TRUE when Alex invoked route_to_topic for a qualification-gated topic without passing qualification_confirmed=true. Prompt tells Alex to confirm requirements before routing; this column is the SQL-queryable signal for "how often did she skip it." NULL for calls that didn''t hit route_to_topic OR for topics without a qualification gate. Does NOT block routing.';

COMMIT;
