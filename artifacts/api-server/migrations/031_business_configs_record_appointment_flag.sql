-- 031_business_configs_record_appointment_flag.sql
-- Phase 2.2.5 — feature flag for the record_appointment AI tool.
--
-- The Phase 2.2.5 slice adds a `record_appointment` webhook tool to the
-- ElevenLabs AI receptionist's tool kit. When the caller wants to book an
-- appointment, the AI invokes the tool which POSTs to
-- /api/leads/record-appointment and lands a row in the appointments
-- table (with lead_id set + source='ai_receptionist').
--
-- Tool registration updates the LIVE agent for every tenant, so a bug
-- would surface across all tenants simultaneously. The feature flag
-- gates per-tenant registration. Default FALSE = cautious rollout:
--   1. Phase 2.2.5 ships; no tenant gets the tool yet.
--   2. Ops flips the flag to TRUE for EZ Rentals.
--   3. Ops runs updateAgentTools(supabase, 'biz_1779288494109_z4z979')
--      to re-register tools (now including record_appointment) with
--      EZ Rentals's ElevenLabs agent.
--   4. After ~1 week of stable production usage, flip TRUE broadly.
--
-- Mirrors the transfer_enabled precedent (migration 006_operator_transfer.sql).
-- Once stable in production, a future migration can flip the default
-- TRUE and ops can run updateAgentTools for every tenant.
--
-- Atomic — BEGIN/COMMIT. Idempotent — IF NOT EXISTS guards the ADD.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS record_appointment_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN business_configs.record_appointment_enabled IS
  'Feature flag for the Phase 2.2.5 record_appointment AI tool. When TRUE, the tenant''s ElevenLabs agent gets the tool registered; when FALSE, the tool is omitted. Default FALSE for cautious rollout. Toggle per-tenant by ops; flipping triggers a fresh updateAgentTools(supabase, businessId) run.';

COMMIT;
