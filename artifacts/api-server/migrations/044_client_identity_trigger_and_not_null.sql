-- 044_client_identity_trigger_and_not_null.sql
-- Phase 3.3b — safety net for user_businesses.client_identity.
--
-- Migration 043 defined the formula in exactly one JS helper
-- (lib/voice/client-identity.ts:buildClientIdentity) and 3.3a wired
-- five INSERT sites to call it. But nothing prevents a SIXTH call
-- site (added in a future PR that forgets the helper) from silently
-- creating a row with NULL client_identity — a user who can never
-- register a WebRTC device with no constraint to catch the omission.
--
-- Two overlapping guards:
--
--   1. BEFORE INSERT trigger — if a row is inserted without a
--      client_identity, compute it from NEW.user_id + NEW.business_id
--      using the exact 043 formula. Safety net: even if a caller
--      forgets buildClientIdentity, the DB fixes it up.
--
--   2. NOT NULL constraint — belt-and-braces. If the trigger ever
--      breaks or is disabled, we still fail loudly at INSERT time
--      rather than silently producing an unusable row. All 40
--      production rows are populated per migration 043's backfill,
--      so this can land without a data change.
--
-- The five buildClientIdentity call sites in auth.ts, admin.ts, and
-- api.ts stay in place. Redundant with the trigger, and that's the
-- point — belt-and-braces. If either the trigger OR the call sites
-- get removed independently, the other is still keeping the invariant.
--
-- MUST stay in sync with lib/voice/client-identity.ts. Two smoke tests
-- assert (a) buildClientIdentity matches this formula, (b) an INSERT
-- without client_identity gets populated by the trigger.
--
-- Verification queries (run after apply):
--
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'user_businesses' AND column_name = 'client_identity';
--   -- expect is_nullable = 'NO'
--
--   SELECT tgname, tgtype FROM pg_trigger
--    WHERE tgrelid = 'user_businesses'::regclass
--      AND tgname = 'user_businesses_client_identity_trg';
--   -- expect one row
--
--   -- Trigger round-trip (uses a savepoint to leave the DB unchanged):
--   BEGIN;
--   SAVEPOINT probe;
--   INSERT INTO user_businesses (user_id, business_id, role)
--     VALUES ('00000000-0000-0000-0000-000000000001', 'probe-biz', 'user')
--     RETURNING client_identity;
--   -- expect: user_00000000000000000000000000000001__<12hex(md5('probe-biz'))>
--   ROLLBACK TO SAVEPOINT probe;
--   ROLLBACK;

BEGIN;

CREATE OR REPLACE FUNCTION user_businesses_populate_client_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.client_identity IS NULL THEN
    NEW.client_identity :=
      'user_' || replace(NEW.user_id::text, '-', '') || '__' ||
      substr(md5(NEW.business_id), 1, 12);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION user_businesses_populate_client_identity() IS
  'Phase 3.3b: fills user_businesses.client_identity from (user_id, business_id) when the INSERT omits it. Formula MUST stay in sync with lib/voice/client-identity.ts:buildClientIdentity. Migration 043 established the formula; 044 wraps it in a trigger so future INSERT paths cannot silently produce a NULL identity.';

DROP TRIGGER IF EXISTS user_businesses_client_identity_trg ON user_businesses;
CREATE TRIGGER user_businesses_client_identity_trg
  BEFORE INSERT ON user_businesses
  FOR EACH ROW
  EXECUTE FUNCTION user_businesses_populate_client_identity();

-- All 40 production rows are populated per migration 043's backfill —
-- verified before writing this migration. NOT NULL will hold.
ALTER TABLE user_businesses
  ALTER COLUMN client_identity SET NOT NULL;

COMMIT;
