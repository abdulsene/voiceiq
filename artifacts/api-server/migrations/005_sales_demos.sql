-- Phase 3g: Sales-created persistent demo accounts.
--
-- Reuses the existing `preview_demos` table from Phase 3d (self-serve
-- /try-your-agent demos) and adds fields for persistent demos created by
-- platform admins for sales outreach. Persistent demos:
--   * are exempt from the 30-min auto-cleanup cron
--   * can be revoked manually (sets revoked_at + tears down ElevenLabs agent)
--   * have a configurable expiry (7-90 days vs. 30 minutes for self-serve)
--   * carry an internal `demo_label` and `share_notes` for sales tracking
--
-- All new columns are nullable / defaulted so existing self-serve demo rows
-- remain valid (is_persistent defaults false → unchanged behavior).

ALTER TABLE preview_demos
  ADD COLUMN IF NOT EXISTS demo_label TEXT,
  ADD COLUMN IF NOT EXISTS is_persistent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason TEXT,
  ADD COLUMN IF NOT EXISTS share_notes TEXT;

-- Index supports the admin list query (filter by is_persistent + recent first).
CREATE INDEX IF NOT EXISTS idx_preview_demos_persistent_created
  ON preview_demos (is_persistent, created_at DESC)
  WHERE is_persistent = TRUE;
