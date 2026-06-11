-- 006_operator_transfer.sql
-- Operator transfer ("warm handoff") feature. Backs the new
-- /api/business/transfer + /api/admin/business/:id/transfer endpoints and
-- the dashboard's TransferTab. All columns nullable / defaulted — safe
-- additive change. No backfill needed; existing customers default to
-- transfer_enabled=false until they configure via the UI.
--
-- Field semantics:
--   transfer_enabled        — master switch. When false, the route helper
--                             (updateAgentTransferConfig in agents.ts)
--                             ensures the transfer_to_number system tool
--                             is REMOVED from the ElevenLabs agent.
--   transfer_to_phone       — destination phone in E.164 (e.g. +14105551234).
--                             Loop guard rejects equality with
--                             twilio_phone_number on the same row.
--   transfer_conditions     — natural-language description of WHEN the
--                             agent should transfer. Sent as the `condition`
--                             field on the PhoneNumberTransfer rule.
--   transfer_wait_message   — template the LLM uses as `client_message` at
--                             runtime (what the caller hears during handoff).
--   transfer_warm_message   — template the LLM uses as `agent_message` at
--                             runtime (what the operator hears before the
--                             caller is bridged in). Server-side
--                             `{business_name}` interpolation happens at
--                             PATCH time in the route handler.
--
-- Idempotent — safe to re-run.

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS transfer_enabled       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transfer_to_phone      TEXT,
  ADD COLUMN IF NOT EXISTS transfer_conditions    TEXT,
  ADD COLUMN IF NOT EXISTS transfer_wait_message  TEXT,
  ADD COLUMN IF NOT EXISTS transfer_warm_message  TEXT;
