-- 001_user_management_rbac.sql
-- Staff / back-office user management & RBAC for the Neverr admin console.
--
-- This is INTENTIONALLY SEPARATE from the per-tenant `user_businesses` table.
-- `user_businesses` controls who has access to a customer's own dashboard.
-- The tables below control who at Neverr (employees, contractors) can use the
-- admin console (/api/admin/*) and what they're allowed to do in it.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS organizations (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  plan          TEXT DEFAULT 'professional',
  settings      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  owner_user_id TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('super_admin','admin','manager','analyst','support','viewer')),
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  permissions     JSONB DEFAULT '{}'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  last_login      TIMESTAMPTZ,
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','suspended'))
);

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_email_uniq ON user_roles (LOWER(email));
CREATE INDEX IF NOT EXISTS user_roles_user_id_idx ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS user_roles_status_idx  ON user_roles (status);

-- Granular per-resource permissions table. Currently unused by the three
-- endpoints in this commit (which read/write the consolidated JSONB blob on
-- user_roles.permissions); kept for future fine-grained ACLs without schema
-- churn.
CREATE TABLE IF NOT EXISTS user_permissions (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id    TEXT NOT NULL,
  resource   TEXT NOT NULL,
  actions    TEXT[] NOT NULL,
  scope      TEXT DEFAULT 'all',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_permissions_user_id_idx ON user_permissions (user_id);
