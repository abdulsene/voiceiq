-- Sprint 2 / migration 017
--
-- Twilio DID provisioning state for business_configs.
--
-- Sprint 2 introduces auto-wired Twilio number provisioning at signup
-- (and a one-off admin backfill endpoint). The provisioning service
-- needs durable state on business_configs so the workflow can:
--
--   1. Record the purchased DID + Twilio's SID for that number.
--   2. Track where each business is in the provisioning lifecycle.
--   3. Distinguish failure modes so the backfill / retry path knows
--      whether the issue was inventory, purchase, persistence, or
--      webhook configuration.
--   4. Remember the area code the workflow was asked to source from
--      (e.g. '443' for the first target, EZ Rentals).
--
-- API translation note: existing api-server handlers that return
-- `neverr_phone` in JSON responses will read from `twilio_phone_number`
-- at the boundary and continue emitting `neverr_phone` so the dashboard
-- contract is unchanged. The existing `phone_number` column stays as
-- the customer's display / landline number (e.g. EZ Rentals' scraped
-- "443 708 7894") — we do NOT overwrite it with the DID.
--
-- provisioning_status allowed values:
--   'pending'              — row exists, no provisioning attempt yet
--                            (default for backfill candidates)
--   'provisioning'         — workflow in flight (DID claimed, not yet
--                            persisted + webhook-configured)
--   'provisioned'          — DID purchased, persisted to row, webhook
--                            configured on Twilio side; ready to take calls
--   'failed_no_inventory'  — Twilio AvailablePhoneNumbers search returned
--                            zero results for the requested area code
--   'failed_purchase'      — IncomingPhoneNumbers create call failed
--   'failed_persistence'   — DID purchased on Twilio but DB write failed
--                            (orphan risk — reconciliation needed)
--   'failed_webhook'       — DID purchased + persisted but webhook
--                            configuration failed (will not route calls)
--
-- Idempotent — safe to re-run. Every DDL guarded by IF NOT EXISTS or
-- pg_constraint / pg_indexes lookup. Constraint name lookups are scoped
-- to public.business_configs via conrelid (constraint names are not
-- globally unique in Postgres — same caveat as migration 016).
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS twilio_phone_number       TEXT,
  ADD COLUMN IF NOT EXISTS twilio_phone_sid          TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_status       TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS provisioning_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provisioning_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provisioning_error        TEXT,
  ADD COLUMN IF NOT EXISTS provisioning_area_code    TEXT;

-- CHECK constraint on provisioning_status. Idempotency guard scoped to
-- public.business_configs via conrelid (same pattern as migration 016).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_configs_provisioning_status_check'
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    ALTER TABLE business_configs
      ADD CONSTRAINT business_configs_provisioning_status_check
      CHECK (provisioning_status IN (
        'pending',
        'provisioning',
        'provisioned',
        'failed_no_inventory',
        'failed_purchase',
        'failed_persistence',
        'failed_webhook'
      ));
  END IF;
END $$;

-- Partial unique index on twilio_phone_number — same shape as
-- uq_business_configs_sso_connection_id. Multiple rows are allowed
-- to have NULL (un-provisioned) but every non-NULL DID must be unique.
CREATE UNIQUE INDEX IF NOT EXISTS uq_business_configs_twilio_phone_number
  ON public.business_configs (twilio_phone_number)
  WHERE twilio_phone_number IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only, prints once after migration runs)

SELECT 'twilio provisioning columns added' AS status,
       count(*)                                                AS total_rows,
       count(*) FILTER (WHERE provisioning_status = 'pending') AS pending_rows,
       count(*) FILTER (WHERE twilio_phone_number IS NOT NULL) AS rows_with_did
FROM business_configs;

-- Tell PostgREST to reload its schema cache so the new columns are
-- queryable through PostgREST / Supabase auto-generated REST API
-- without waiting for the periodic reload.
NOTIFY pgrst, 'reload schema';
