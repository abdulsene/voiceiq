-- 009_consulting_industry.sql
-- Sprint 4 STEP C — Abdul A2-β decision (override of A2-α).
-- Adds a standalone "Consulting" canonical_category to industry_templates
-- so it appears as its own card on the /industries hub instead of being
-- bucketed under "Technology & Professional Services".
--
-- Idempotent — safe to re-run. Run in Supabase SQL editor.
--
-- v2 — paste-safety hardening:
--   The previous version (v1) failed during paste with
--     ERROR: 42P01: relation "your" does not exist
--   Root cause was clipboard / SQL-editor smart-quote conversion (ASCII
--   apostrophes silently replaced with U+2018 / U+2019), which broke string
--   termination and let the parser interpret "your" as an unquoted identifier.
--
--   v2 wraps every multi-word literal in PostgreSQL dollar-quoting
--   ($tag$ ... $tag$) so the paste cannot mangle string boundaries.
--   The data inserted is byte-identical to v1.
--
-- Column coverage verified against live PostgREST OpenAPI schema:
-- all 6 NOT-NULL-no-default columns (industry_id, name, category, icon,
-- system_prompt, plus auto-serial id) are populated below.

INSERT INTO industry_templates (
  industry_id,
  name,
  category,
  canonical_category,
  icon,
  description,
  system_prompt,
  pain_points,
  value_props,
  call_scripts,
  roi_snapshot
)
SELECT
  'consulting',
  $name$Consulting / Professional Services$name$,
  'Consulting',
  'Consulting',
  '💼',
  $desc$AI receptionist for consulting firms, independent advisors, and boutique professional service practices. Captures qualified leads, books discovery calls, and answers prospect questions 24/7.$desc$,
  $prompt$You are a professional receptionist for {business_name}, a consulting firm. Help prospects book discovery calls and connect existing clients with their consultant. Collect: caller name, phone, email, company, type of inquiry, and timeline. Pre-qualify prospects against ideal client criteria before booking calls.$prompt$,
  $pain$[
    "Missed calls during client meetings cost qualified leads",
    "Time wasted on unqualified discovery calls",
    "Difficulty coordinating calendars across multiple consultants",
    "No after-hours coverage when prospects are researching",
    "Cost-prohibitive to staff a full-time receptionist at small-firm scale"
  ]$pain$::jsonb,
  $value$[
    "Captures every prospect call 24/7 — never miss a lead",
    "Pre-qualifies callers against your ideal client criteria before booking",
    "Books discovery calls directly into your calendar with no back-and-forth",
    "Speaks fluently about your specialty and engagement model",
    "Costs less than a quarter of a part-time receptionist"
  ]$value$::jsonb,
  '[]'::jsonb,
  '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM industry_templates WHERE industry_id = 'consulting'
);
