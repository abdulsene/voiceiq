-- 003_industry_templates.sql
-- Industry template catalogue used by the public-facing landing pages
-- and demo generator. The route layer reads its data from
-- `src/data/comprehensive-industries.ts` today; these tables exist for
-- a future admin tool that lets non-engineers add or override industry
-- entries without a code deploy.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS industry_categories (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  icon         TEXT,
  sort_order   INTEGER DEFAULT 0,
  is_featured  BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS industry_templates (
  id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  industry_code            TEXT NOT NULL UNIQUE,
  industry_name            TEXT NOT NULL,
  industry_category        TEXT NOT NULL,
  naics_code               TEXT,
  description              TEXT NOT NULL,
  target_audience          TEXT[],
  pain_points              JSONB NOT NULL,
  value_propositions       JSONB NOT NULL,
  features                 JSONB NOT NULL,
  templates                JSONB NOT NULL,
  compliance_requirements  JSONB DEFAULT '{}'::jsonb,
  seasonal_patterns        JSONB DEFAULT '{}'::jsonb,
  automation_opportunities JSONB NOT NULL,
  roi_metrics              JSONB NOT NULL,
  pricing_model            JSONB NOT NULL,
  competition_analysis     JSONB DEFAULT '{}'::jsonb,
  market_size_data         JSONB DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS industry_demo_scenarios (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  industry_code       TEXT NOT NULL REFERENCES industry_templates(industry_code) ON DELETE CASCADE,
  scenario_name       TEXT NOT NULL,
  scenario_description TEXT NOT NULL,
  call_flow           JSONB NOT NULL,
  expected_outcomes   JSONB NOT NULL,
  demo_script         TEXT NOT NULL,
  estimated_duration  INTEGER DEFAULT 60,
  difficulty_level    TEXT DEFAULT 'beginner' CHECK (difficulty_level IN ('beginner','intermediate','advanced')),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_industry_templates_category ON industry_templates(industry_category);
CREATE INDEX IF NOT EXISTS idx_industry_demo_code          ON industry_demo_scenarios(industry_code);
