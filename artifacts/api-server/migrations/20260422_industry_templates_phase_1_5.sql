-- Phase 1.5: industry_templates normalization
-- Non-destructive: adds columns, no drops. Run in Supabase SQL editor.

ALTER TABLE industry_templates
  ADD COLUMN IF NOT EXISTS pain_points JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS value_props JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS call_scripts JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS roi_snapshot JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS dedup_aliases JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS canonical_category TEXT;

CREATE INDEX IF NOT EXISTS idx_industry_templates_canonical_category
  ON industry_templates(canonical_category);

-- Backfill canonical_category from existing category strings later via the normalize endpoint.
