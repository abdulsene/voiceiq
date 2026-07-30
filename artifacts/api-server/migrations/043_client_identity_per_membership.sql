-- 043_client_identity_per_membership.sql
-- Phase 3.3a — correct client_identity to be per-MEMBERSHIP, not
-- per-USER. See lib/voice/client-identity.ts header for full rationale.
--
-- Summary of the 3.3 bug this fixes:
--   Phase 3.3 (commit fd5b544, migration 042) shipped
--     client_identity = 'user_' || replace(user_id::text, '-', '')
--   Twilio addresses <Client><Identity>X</Identity></Client> globally
--   — the account has no tenant scoping. A user with memberships in
--   two businesses had ONE identity, so their browser device registers
--   ONCE and receives calls for BOTH tenants, with the OTHER tenant's
--   topic_name showing in the incoming banner (topic_name is a
--   CustomParameter sent by whichever biz initiated the dial). That's
--   a cross-tenant UI-level data leak, not just a routing miss.
--
-- Pre-flight collision check (run before this migration lands):
--   SELECT COUNT(*) AS total, COUNT(DISTINCT (
--     'user_' || replace(user_id::text, '-', '') || '__' ||
--     substr(md5(business_id), 1, 12)
--   )) AS distinct_identities FROM user_businesses;
--   -- Ran against zqhijauefcpwggklshoa on 2026-07-30:
--   --   total=40, distinct=40, collisions=0 → safe to add UNIQUE.
--
-- What this migration does:
--   1. Recompute client_identity for EVERY row using the per-membership
--      formula. Overwrite (not skip-if-non-null) — the 042 values are
--      all wrong shape and must be replaced.
--   2. Assert distinct(client_identity) = count(*) inside a DO block.
--      RAISE EXCEPTION on mismatch — aborts the whole transaction so
--      we don't half-land the change with a broken UNIQUE.
--   3. Add the UNIQUE constraint we couldn't add in 042.
--
-- Formula (MUST match lib/voice/client-identity.ts:buildClientIdentity):
--   'user_' || replace(user_id::text,'-','') || '__' ||
--     substr(md5(business_id), 1, 12)
--
-- Verification queries to run after apply:
--   SELECT COUNT(*) FROM user_businesses WHERE client_identity IS NULL;
--   -- expect 0
--
--   SELECT COUNT(*), COUNT(DISTINCT client_identity)
--     FROM user_businesses;
--   -- expect equal
--
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'user_businesses'::regclass
--      AND contype = 'u'
--      AND conname = 'user_businesses_client_identity_key';
--   -- expect one row

BEGIN;

-- Overwrite (not COALESCE) — 042 values are all in the wrong shape.
UPDATE user_businesses
   SET client_identity =
     'user_' || replace(user_id::text, '-', '') || '__' ||
     substr(md5(business_id), 1, 12);

-- Fail-loud pre-check inside the transaction. If we ever end up with
-- a collision (shouldn't given the birthday-bound analysis in the
-- helper's header, but defensive), abort so we don't add a UNIQUE
-- that the very next INSERT would violate.
DO $$
DECLARE
  total_rows INT;
  distinct_rows INT;
BEGIN
  SELECT COUNT(*), COUNT(DISTINCT client_identity)
    INTO total_rows, distinct_rows
    FROM user_businesses
   WHERE client_identity IS NOT NULL;
  IF total_rows <> distinct_rows THEN
    RAISE EXCEPTION 'client_identity collision: total=%, distinct=% — aborting migration 043 (fix collisions or shorten md5 suffix before retrying)',
      total_rows, distinct_rows;
  END IF;
  RAISE NOTICE 'Migration 043: % rows, % distinct — UNIQUE will hold', total_rows, distinct_rows;
END $$;

-- Restore the UNIQUE constraint that 042 failed to add. Now it holds
-- because each (user, biz) row has a distinct identity.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'user_businesses'::regclass
       AND conname = 'user_businesses_client_identity_key'
  ) THEN
    ALTER TABLE user_businesses
      ADD CONSTRAINT user_businesses_client_identity_key
      UNIQUE (client_identity);
  END IF;
END $$;

COMMENT ON COLUMN user_businesses.client_identity IS
  'Phase 3.3a: PER-MEMBERSHIP Twilio Client identity. Formula: user_ || replace(user_id::text, -, ) || __ || substr(md5(business_id), 1, 12). Deterministic and recomputable from (user_id, business_id) alone — see lib/voice/client-identity.ts:buildClientIdentity for the single-source-of-truth JS implementation. UNIQUE — collision would let a device register as another tenant. Migration 042 originally shipped a per-USER formula that leaked cross-tenant call banners for dual-membership users; 043 corrected it (see migration file header for the full incident context). NEVER accept an identity from a client request; always derive from the JWT.';

COMMIT;
