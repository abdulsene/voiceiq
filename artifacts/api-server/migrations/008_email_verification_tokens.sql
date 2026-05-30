-- Sprint 2 STEP 4 / BUG-18: email verification token ledger.
--
-- Apply via Supabase SQL editor on the project database (project
-- zqhijauefcpwggklshoa). Idempotent: safe to re-run.
--
-- Architecture: token-based verification mirroring the /admin/team/activate
-- pattern (admin.ts:5982-5987 + 6485). Tokens are issued lazily by the
-- Stripe checkout.session.completed handler (app.ts) the moment a business
-- transitions OUT of subscription_status='pending_payment' INTO
-- 'trialing'/'active' — NEVER from the /signup endpoint itself. Sending
-- from /signup would email people who never finish Checkout, which is a
-- Resend reputation / spam-flag risk per the BUG-18 DO-NOT list.
--
-- Schema notes:
--   * token TEXT PRIMARY KEY — 64-hex-char token from secureToken("evt", 32);
--     PK gives unique-constraint enforcement on collisions (cryptographically
--     impossible at this size, but cheap insurance).
--   * user_id UUID — references auth.users(id); ON DELETE CASCADE so when
--     an auth user is deleted the dangling tokens go with them.
--   * email TEXT — captured at issue time. Lets the verify handler match
--     even if the user changed their email between issue and click.
--   * expires_at TIMESTAMPTZ — 24-hour TTL set by the issuer.
--   * used_at TIMESTAMPTZ NULL — single-use marker. The /verify-email
--     handler sets this on successful verification AND the
--     /resend-verification handler also sets this on prior unused tokens
--     (claim-as-used so a previously-mailed link can't double-verify
--     after a fresh token has been issued).
--
-- Service-role only — RLS enabled with no policies = no app-tenant or
-- client should ever read or write this table directly. Same pattern as
-- processed_webhook_events (007_processed_webhook_events.sql).
--
-- The two ALTER TABLE statements at the bottom extend business_configs
-- with the columns the dashboard gate (DashboardLayout in
-- artifacts/voiceiq-dashboard/src/App.tsx) reads to decide whether to
-- render <EmailVerificationScreen /> instead of the normal dashboard
-- chrome. Default FALSE so all existing rows correctly start as
-- "not verified" until a user clicks their verification link. The
-- gate composes with BUG-17 sub-step 3e: payment check fires first
-- (PendingPaymentScreen), then email check (EmailVerificationScreen).
--
-- DO NOT change the PK to a surrogate id — TEXT PRIMARY KEY on the
-- token IS the lookup key; the verify handler does WHERE token = $1
-- and the unique constraint is the dedupe.
-- DO NOT add a TTL/cleanup job here. Out of scope for launch.

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token       TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_id
  ON email_verification_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_expires_at
  ON email_verification_tokens(expires_at);

-- Partial index for the hot path in
-- services/verification-email-service.ts → issueAndSendVerification:
-- the "claim prior unused tokens" sweep does
-- WHERE user_id = $1 AND used_at IS NULL. The general user_id index
-- above also matches but a partial index keeps these reads cheap as
-- the table grows (since the active subset stays small — at most one
-- live token per user).
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user_active
  ON email_verification_tokens(user_id) WHERE used_at IS NULL;

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ NULL;
