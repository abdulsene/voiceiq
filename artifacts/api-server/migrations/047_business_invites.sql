-- 047_business_invites.sql
-- Phase 3.17 — first-class business invites.
--
-- Replaces supabase.auth.admin.inviteUserByEmail as the invite mechanism
-- for team members. That flow was broken by Microsoft Defender Safe
-- Links (and Google's equivalent) prefetching one-time GET links from
-- corporate email, silently redeeming Supabase's magic-link token before
-- the human ever clicked. Evidence (aaliyah.louise@ezrentalsandleasing.com):
--   invited_at        2026-07-31 19:27:47
--   confirmed_at      2026-07-31 19:28:35  -- redeemed 48s after send
--   last_sign_in_at   2026-07-31 19:28:35
--   Human saw:        neverr.ai/#error=access_denied&error_code=otp_expired
-- Nearly all Neverr customers are on M365 or Workspace, so this hit
-- most corporate invites. See Phase 3.17 header comment in
-- artifacts/api-server/src/routes/team.ts for the full flow.
--
-- Design principles:
--
--   1. GET must be side-effect free. A scanner fetching /invite/:token
--      MUST NOT accept, mark as read, or otherwise mutate state.
--      Acceptance happens only on POST from the SPA form.
--
--   2. Store a HASH, never the raw token. If the DB leaks, tokens
--      cannot be replayed. Column `token_hash` is UNIQUE — lookup is
--      by hash of the URL parameter.
--
--   3. Do NOT create the auth user at invite time. Acceptance
--      atomically creates the Supabase auth user (with the password
--      the human types in), inserts the user_businesses row, and marks
--      the invite accepted. Pending vs active is then unambiguous
--      without joining auth.users.
--
--   4. 7-day expiry. `expires_at` is set at issue time; POST accept
--      rejects if now > expires_at. Revoke sets `revoked_at`; resend
--      creates a new row (new token) and revokes the previous.
--
-- Columns:
--
--   id UUID PK
--   business_id TEXT   FK -> business_configs(business_id) ON DELETE CASCADE
--                      (business_configs is the canonical tenant parent in
--                       this schema — every other tenant-scoped table
--                       references it. There is no root `businesses` table.
--                       business_id is TEXT across the whole schema, not
--                       UUID — matches user_businesses, leads, staff_topics.)
--   email TEXT         invited email address (lowercased)
--   role TEXT          enterprise role granted on acceptance
--   callback_ring_number TEXT    optional E.164; copied to user_businesses on accept
--   topics TEXT[]      optional topic slugs; copied to staff_topics on accept
--   invited_by_user_id UUID      FK -> auth.users(id) ON DELETE SET NULL
--   token_hash TEXT UNIQUE       SHA-256 hex of the URL token (32 bytes -> 64 hex chars)
--   expires_at TIMESTAMPTZ       NOT NULL; set by the issuer to now() + 7 days
--   accepted_at TIMESTAMPTZ      NULL until POST accept succeeds
--   accepted_user_id UUID        FK -> auth.users(id); set on acceptance
--   revoked_at TIMESTAMPTZ       NULL until an owner revokes / resend supersedes
--   created_at TIMESTAMPTZ       NOT NULL DEFAULT now()
--
-- Indexes:
--
--   pk on id
--   UNIQUE(token_hash)  -- the lookup index; must be unique
--   (business_id, accepted_at) WHERE accepted_at IS NULL AND revoked_at IS NULL
--     partial for the "pending invites for this business" query
--   (email, business_id) for de-dup checks + resend
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'business_invites' ORDER BY ordinal_position;
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'business_invites';

BEGIN;

CREATE TABLE IF NOT EXISTS business_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  callback_ring_number TEXT,
  topics TEXT[] NOT NULL DEFAULT '{}',
  invited_by_user_id UUID,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_user_id UUID,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'business_invites_business_fk'
       AND conrelid = 'business_invites'::regclass
  ) THEN
    ALTER TABLE business_invites
      ADD CONSTRAINT business_invites_business_fk
      FOREIGN KEY (business_id) REFERENCES business_configs(business_id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'business_invites_invited_by_fk'
       AND conrelid = 'business_invites'::regclass
  ) THEN
    ALTER TABLE business_invites
      ADD CONSTRAINT business_invites_invited_by_fk
      FOREIGN KEY (invited_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'business_invites_accepted_user_fk'
       AND conrelid = 'business_invites'::regclass
  ) THEN
    ALTER TABLE business_invites
      ADD CONSTRAINT business_invites_accepted_user_fk
      FOREIGN KEY (accepted_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Lookup by hash of the URL token. UNIQUE so a fresh issue can never
-- collide with an outstanding one and so we can safely UPSERT on
-- resend semantics if we ever want that.
CREATE UNIQUE INDEX IF NOT EXISTS idx_business_invites_token_hash
  ON business_invites (token_hash);

-- Pending invites for the Team page. Partial so accepted / revoked
-- rows don't bloat the index.
CREATE INDEX IF NOT EXISTS idx_business_invites_pending
  ON business_invites (business_id, created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- De-dup check + resend lookup. Not unique — an email may have been
-- invited, revoked, and re-invited legitimately, leaving multiple
-- historical rows. Uniqueness of ACTIVE invites is enforced at the
-- route layer.
CREATE INDEX IF NOT EXISTS idx_business_invites_email_business
  ON business_invites (email, business_id);

COMMENT ON TABLE business_invites IS
  'Phase 3.17: first-class business invites. Owner-issued, hash-stored, POST-accepted. Replaces supabase.auth.admin.inviteUserByEmail which was silently redeemed by Microsoft Defender Safe Links / Google URL scanners on corporate email domains. See migration 047 header + routes/team.ts Phase 3.17 header.';

COMMENT ON COLUMN business_invites.token_hash IS
  'SHA-256 hex of the URL token. We store the HASH so a DB leak cannot replay outstanding invites. Lookup: hash the ?token=... param, then SELECT WHERE token_hash = $1.';

COMMENT ON COLUMN business_invites.expires_at IS
  'Set by the issuer to now() + 7 days. Acceptance rejects if now > expires_at. Not a hard delete — the row stays so we can render "expired" instead of "unknown token" to the user.';

COMMENT ON COLUMN business_invites.accepted_at IS
  'Set atomically inside handleAcceptInvite when the auth.users row + user_businesses row are both created. NULL means the invite is outstanding.';

COMMENT ON COLUMN business_invites.revoked_at IS
  'Owner-set via DELETE /api/business/invites/:id, or issuer-set when a resend supersedes this row. Acceptance rejects when revoked_at IS NOT NULL.';

COMMIT;
