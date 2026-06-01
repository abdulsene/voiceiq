-- Sprint 2 / migration 018
--
-- State machine integrity for the Twilio provisioning columns added
-- by migration 017.
--
-- Defense in depth for audit risk #7 (state machine integrity). The
-- application code in artifacts/api-server/src/lib/twilio-provisioning.ts
-- already orders its UPDATEs so these invariants hold, but a future
-- code change, manual DB edit, or partial-failure path could land the
-- row in an inconsistent state — these CHECK constraints make those
-- invalid states unrepresentable at the DB layer.
--
-- Two CHECK constraints:
--
--   1. business_configs_provisioned_completeness_check
--      A row in provisioning_status = 'provisioned' must have all three
--      "I have a working Twilio number" columns populated:
--        - twilio_phone_number      (the E.164 DID)
--        - twilio_phone_sid         (Twilio's PNxxx handle — needed to
--                                    release the DID if we ever have to)
--        - provisioning_completed_at
--      Rationale: without any one of these, the row claims success but
--      is operationally useless. The application atomically writes all
--      four fields in markProvisioned() — this CHECK enforces the same
--      invariant at the DB layer.
--
--   2. business_configs_started_at_consistency_check
--      Any row not in 'pending' must have provisioning_started_at set.
--      Rationale: catches the BASE_URL-precondition path that flips
--      status to 'failed_webhook' before markStarted runs. The
--      application-level fix in Batch A (sanitize + started_at
--      backfill in markFailure) already enforces this; the CHECK is
--      belt-and-braces.
--
-- Pre-apply data check (the verification SELECT at the bottom) reports
-- 0 violations against the 48 current rows — they're all
-- provisioning_status = 'pending' from the 017 default, which satisfies
-- both constraints vacuously.
--
-- Idempotent — DO $$ guards scoped via conrelid (same pattern as
-- migrations 016 and 017). Constraint names are not globally unique in
-- Postgres, hence the conrelid pin.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

-- ── Constraint 1: 'provisioned' rows must have all DID columns set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_configs_provisioned_completeness_check'
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    ALTER TABLE business_configs
      ADD CONSTRAINT business_configs_provisioned_completeness_check
      CHECK (
        provisioning_status != 'provisioned' OR (
          twilio_phone_number IS NOT NULL
          AND twilio_phone_sid IS NOT NULL
          AND provisioning_completed_at IS NOT NULL
        )
      );
  END IF;
END $$;

-- ── Constraint 2: any non-'pending' row must have started_at set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_configs_started_at_consistency_check'
      AND conrelid = 'public.business_configs'::regclass
  ) THEN
    ALTER TABLE business_configs
      ADD CONSTRAINT business_configs_started_at_consistency_check
      CHECK (
        provisioning_status = 'pending' OR provisioning_started_at IS NOT NULL
      );
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only). Counts rows by status, plus the number of
-- rows that WOULD violate each constraint. Both violation columns must
-- report 0 against current data — if either is non-zero on apply, the
-- ALTER TABLE statements above will have raised; this SELECT is for
-- post-apply confirmation and for diagnosing future repairs.

SELECT
  COALESCE(provisioning_status, '(null)') AS provisioning_status,
  count(*) AS rows,
  count(*) FILTER (
    WHERE provisioning_status = 'provisioned'
      AND (
        twilio_phone_number IS NULL
        OR twilio_phone_sid IS NULL
        OR provisioning_completed_at IS NULL
      )
  ) AS provisioned_completeness_violations,
  count(*) FILTER (
    WHERE provisioning_status IS DISTINCT FROM 'pending'
      AND provisioning_started_at IS NULL
  ) AS started_at_consistency_violations
FROM business_configs
GROUP BY provisioning_status
ORDER BY provisioning_status;

-- Tell PostgREST to reload its schema cache so the new constraints
-- show up in introspection output without waiting for the periodic
-- reload.
NOTIFY pgrst, 'reload schema';
