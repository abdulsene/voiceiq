-- Sprint 1 BUG-17 sub-step 3c-extended-4 (H3 fix): event-id idempotency ledger.
--
-- Apply via Supabase SQL editor on the project database. Idempotent: safe
-- to re-run.
--
-- The Stripe webhook handler in artifacts/api-server/src/app.ts inserts
-- one row here per event.id at the very top of the handler (before any
-- switch on event.type). The PRIMARY KEY on stripe_event_id gives us the
-- unique-constraint enforcement: an INSERT that conflicts (Postgres SQLSTATE
-- 23505 — unique_violation) is the "we already processed this event" signal,
-- and the handler returns 200 with `{ received: true, replay: true }` body
-- without re-running the per-event-type case branches.
--
-- This is a strict belt-and-suspenders complement to the status-based
-- idempotency in checkout.session.completed (added in 3c). Status-based
-- idempotency catches "same effect, different event id" retries from
-- upstream weirdness; H3 catches "exact same event id" replays (Stripe
-- retries on a handler 5xx, mid-handler crashes, network blips, etc).
-- They're complementary — both stay.
--
-- Schema notes:
--   * stripe_event_id TEXT PRIMARY KEY — Stripe event ids are strings like
--     "evt_1Q…" (not UUIDs); TEXT matches the source-of-truth shape.
--   * business_id TEXT NULL — optional contextual link to business_configs;
--     NOT a foreign key (business_configs is also keyed by TEXT business_id
--     with no UUID surrogate, matching the rest of the codebase pattern;
--     see 004_sms_optin_consents.sql for the same TEXT-no-FK pattern).
--     The handler does NOT populate this column at insert time — it stays
--     NULL by default and is reserved for future enrichment.
--   * outcome TEXT NULL — optional 'processed' | 'noop' | 'error' tag for
--     observability. Reserved for future use; the handler does not write
--     it today.
--   * processed_at index supports retention cleanup (TRUNCATE / DELETE rows
--     older than 90 days post-launch — out of scope for this sub-step,
--     but the index is here so the cleanup query is index-backed).
--
-- DO NOT add a TTL or cleanup job. That's post-launch scope.
-- DO NOT change to ON CONFLICT DO UPDATE — strict insert with PK conflict
-- is the simpler pattern and what the handler depends on.

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  business_id     TEXT,
  outcome         TEXT
);

CREATE INDEX IF NOT EXISTS idx_processed_webhook_events_processed_at
  ON processed_webhook_events(processed_at);

-- Service-role only — no app-tenant should ever read or write this table
-- directly. RLS enabled with no policies = service role only by default.
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;
