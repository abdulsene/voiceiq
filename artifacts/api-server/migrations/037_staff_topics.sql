-- 037_staff_topics.sql
-- Phase 3.1a — junction table mapping staff members to the customer
-- service topics they can handle.
--
-- The Phase 3.2 routing query is:
--
--   SELECT ub.user_id
--     FROM user_businesses ub
--     JOIN staff_topics st
--       ON st.user_id = ub.user_id
--      AND st.business_id = ub.business_id
--    WHERE ub.business_id = $1
--      AND ub.is_on_duty = true
--      AND st.topic_slug   = $2;
--
-- The composite FK (user_id, business_id) → user_businesses(user_id,
-- business_id) is what makes staff_topics rows automatically clean up
-- when a staff member is removed from the business (ON DELETE CASCADE)
-- and prevents dangling rows that reference nonexistent memberships.
-- Migration 035 was pre-req; user_businesses had the UNIQUE
-- (user_id, business_id) constraint already (verified via Supabase
-- MCP during Phase A sign-off).
--
-- topic_slug is denormalized (TEXT, not a FK to industry_templates.default_topics)
-- because the topic set lives in business_configs.departments jsonb —
-- businesses can add/remove/rename topics per-tenant. Route-layer
-- validation catches slug typos before insert; app-layer validation
-- catches referencing a slug the business no longer has. The trade-off
-- is that a rename in business_configs.departments won't cascade to
-- staff_topics — that's a Phase 3.5 concern (rename cascade or
-- soft-alias table). For now, editing a topic slug orphans staff
-- assignments; the UI will need to warn on rename.
--
-- Indexes:
--   * idx_staff_topics_business_topic (business_id, topic_slug) —
--     the hot path for the Phase 3.2 routing query above.
--   * UNIQUE (user_id, business_id, topic_slug) — prevents duplicate
--     assignment; also serves as a lookup for "does this staff member
--     handle this topic?" without a separate index.
--
-- RLS enabled with no policies. api-server bypasses RLS via
-- service_role and enforces tenant scoping at the route layer (WHERE
-- business_id = req.businessId in every read/write). Same posture as
-- appointments (migration 030), outbound_campaigns, etc.
--
-- Idempotent — IF NOT EXISTS on CREATE TABLE / CREATE INDEX.
--
-- Apply via Supabase apply_migration MCP against project
-- zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'staff_topics';
--
--   SELECT indexname, indexdef FROM pg_indexes
--    WHERE tablename = 'staff_topics';
--
--   SELECT relname, relrowsecurity
--     FROM pg_class WHERE relname = 'staff_topics';

BEGIN;

CREATE TABLE IF NOT EXISTS staff_topics (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  business_id  TEXT NOT NULL,
  topic_slug   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, business_id, topic_slug)
);

-- Composite FK cannot use IF NOT EXISTS (Postgres limitation) — DO block
-- for idempotent re-apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'staff_topics_user_business_fk'
       AND conrelid = 'staff_topics'::regclass
  ) THEN
    ALTER TABLE staff_topics
      ADD CONSTRAINT staff_topics_user_business_fk
      FOREIGN KEY (user_id, business_id)
      REFERENCES user_businesses (user_id, business_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_staff_topics_business_topic
  ON staff_topics (business_id, topic_slug);

ALTER TABLE staff_topics ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE staff_topics IS
  'Phase 3.1: Which staff members handle which customer service topics for a given business. Read by the Phase 3.2 routing engine to shortlist candidates for simultaneous-ring. Topic slugs are validated at the route layer against business_configs.departments (soft reference, not a DB FK — tenants can rename topics).';

COMMENT ON COLUMN staff_topics.user_id IS
  'Staff member. Composite FK with business_id references user_businesses(user_id, business_id) ON DELETE CASCADE — removing a staff member from the business cleans up their topic assignments automatically.';

COMMENT ON COLUMN staff_topics.business_id IS
  'Tenant. Same value as user_businesses.business_id for this staff member. Denormalized here (rather than derived via JOIN) so the routing query can filter by business_id + topic_slug without touching user_businesses.';

COMMENT ON COLUMN staff_topics.topic_slug IS
  'The topic this staff member handles. Snake_case, matches a slug in business_configs.departments[].slug for this business. Not a DB FK — Phase 3.1a validates existence at the route layer; a Phase 3.5 rename-cascade concern is tracked separately.';

COMMIT;
