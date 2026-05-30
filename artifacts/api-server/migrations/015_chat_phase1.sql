-- 015_chat_phase1.sql
-- Sprint 5 — Alex (AI chat guide) Phase 1, text-only mode.
--
-- Two new tables that back the public-facing AI chat:
--
--   * chat_conversations: one row per conversation. Owner identity is
--     either an authenticated Supabase user (user_id) OR an anonymous
--     visitor cookie (visitor_id). Exactly one of those two MUST be
--     set — neither = orphan, both = ambiguous. Enforced by the CHECK
--     constraint below; route handlers also enforce on the write path.
--     Tracks two Alex-captured conversation signals:
--       industry      — the industry the visitor told Alex they're in
--                       (industryCode from comprehensive-industries.ts)
--       cta_signaled  — has Alex offered a CTA (signup/demo/free trial)
--                       in any reply yet?
--
--   * chat_messages: append-only log of every message in a conversation,
--     including the synthetic system row written at conversation start
--     (so future debugging can see the exact prompt Alex was given).
--     Tracks per-message Anthropic token usage (tokens_in/tokens_out)
--     for downstream cost + quota analysis.
--
-- Idempotent — safe to re-run. CREATE TABLE/INDEX IF NOT EXISTS, no
-- data is rewritten on a re-run. Same paste-safety + verification-block
-- pattern as migrations 013 + 014.
--
-- Run in Supabase SQL editor on project zqhijauefcpwggklshoa.

-- ───────────────────────────────────────────────────────────────────────
-- 1. chat_conversations
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID DEFAULT NULL,
  visitor_id      TEXT DEFAULT NULL,
  industry        TEXT DEFAULT NULL,
  cta_signaled    BOOLEAN NOT NULL DEFAULT FALSE,
  metadata        JSONB DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ DEFAULT NULL,
  -- XOR: exactly one of user_id / visitor_id MUST be set. The route
  -- handler ownership check (routes/chat.ts:checkOwnership) relies on
  -- this — without XOR a row could have both populated and the
  -- "ambiguous owner" branch in the handler would get exercised in
  -- production. Architect flagged the original `OR`-only check as a
  -- pre-shipping severity-1 issue; this is the fix.
  CONSTRAINT chat_conversations_owner_present
    CHECK ((user_id IS NULL) <> (visitor_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_visitor
  ON chat_conversations (visitor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
  ON chat_conversations (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_chat_conversations_created
  ON chat_conversations (created_at DESC);

-- ───────────────────────────────────────────────────────────────────────
-- 2. chat_messages
-- ───────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chat_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
  content         TEXT NOT NULL,
  tokens_in       INTEGER DEFAULT NULL,
  tokens_out      INTEGER DEFAULT NULL,
  model           TEXT DEFAULT NULL,
  metadata        JSONB DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation
  ON chat_messages (conversation_id, created_at ASC);

-- ───────────────────────────────────────────────────────────────────────
-- 3. Verification (run in psql / SQL editor after applying):
--
--   -- Tables exist with the expected columns
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'chat_conversations' ORDER BY ordinal_position;
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'chat_messages' ORDER BY ordinal_position;
--
--   -- Round-trip insert+delete (visitor-owned)
--   INSERT INTO chat_conversations (visitor_id) VALUES ('migration-smoke');
--   DELETE FROM chat_conversations WHERE visitor_id = 'migration-smoke';
-- ───────────────────────────────────────────────────────────────────────
