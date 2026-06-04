-- Sprint 3 Stage 1 / migration 020
--
-- Add prompt storage + sync-state columns to business_configs for the
-- customer prompt-editing feature.
--
-- Before this migration the AI receptionist prompt lived only inside
-- ElevenLabs (agent.prompt.prompt on the agent record). There was no
-- DB-side source of truth and no code path syncing DB → ElevenLabs.
-- This migration introduces the columns needed for the Model C design:
-- helpers + raw stored independently with an explicit "Regenerate from
-- helpers" button, plus per-language prompts edited separately.
--
-- Columns:
--   system_prompt              the raw English prompt (source of truth
--                              for the English agent)
--   system_prompt_fr / _es     French / Spanish raw prompts (used when
--                              language_presets.fr / .es is configured)
--   prompt_helpers_dirty_at    set when a helper changes; cleared when
--                              raw is regenerated. Powers the "Helpers
--                              have changed since you last regenerated"
--                              hint in the dashboard.
--   prompt_updated_at          last successful raw-prompt save
--   prompt_updated_by          users.id of the editor; NULL for
--                              backfill / system writes
--   prompt_last_synced_at      last successful ElevenLabs PATCH
--   prompt_sync_error          last sync failure message, or NULL if
--                              the last sync succeeded
--
-- All columns are nullable / additive. No existing code path is
-- altered by this migration.
--
-- Idempotent — every ADD COLUMN is IF NOT EXISTS.
--
-- Run via Supabase MCP apply_migration on project zqhijauefcpwggklshoa.

ALTER TABLE business_configs
  ADD COLUMN IF NOT EXISTS system_prompt              TEXT,
  ADD COLUMN IF NOT EXISTS system_prompt_fr           TEXT,
  ADD COLUMN IF NOT EXISTS system_prompt_es           TEXT,
  ADD COLUMN IF NOT EXISTS prompt_helpers_dirty_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prompt_updated_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prompt_updated_by          UUID,
  ADD COLUMN IF NOT EXISTS prompt_last_synced_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS prompt_sync_error          TEXT;

-- ───────────────────────────────────────────────────────────────────────
-- Verification (read-only).

SELECT 'prompt columns added' AS status,
       count(*)                                            AS total_rows,
       count(*) FILTER (WHERE system_prompt IS NOT NULL)   AS rows_with_en_prompt,
       count(*) FILTER (WHERE system_prompt_fr IS NOT NULL) AS rows_with_fr_prompt,
       count(*) FILTER (WHERE system_prompt_es IS NOT NULL) AS rows_with_es_prompt
FROM business_configs;

-- Tell PostgREST to reload its schema cache so the new columns are
-- queryable via the auto-generated REST API immediately.
NOTIFY pgrst, 'reload schema';
