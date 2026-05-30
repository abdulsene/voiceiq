-- 002_dashboards_webhooks.sql
-- Custom dashboard builder, webhook delivery, and (scaffold) scheduled
-- reports tables. Per-tenant scoped via business_id.
--
-- Notable deviations from the rough spec:
--   * `webhook_endpoints.secret_key TEXT NOT NULL` becomes
--     `secret_encrypted JSONB NOT NULL` — we store an AES-256-GCM
--     EncryptedField (matches src/security/encryption.ts) so a DB dump
--     does not leak signing secrets in plaintext.
--   * Dropped the spec's references to nonexistent
--     `increment_webhook_success` / `increment_webhook_failure` Postgres
--     RPCs. Counters are bumped via plain UPDATE in the webhook service.
--
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS custom_dashboards (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  business_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  layout       JSONB NOT NULL DEFAULT '{}'::jsonb,
  widgets      JSONB NOT NULL DEFAULT '[]'::jsonb,
  filters      JSONB DEFAULT '{}'::jsonb,
  permissions  JSONB DEFAULT '{}'::jsonb,
  theme        JSONB DEFAULT '{}'::jsonb,
  is_public    BOOLEAN DEFAULT false,
  is_default   BOOLEAN DEFAULT false,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  business_id       TEXT NOT NULL,
  name              TEXT NOT NULL,
  url               TEXT NOT NULL,
  -- AES-256-GCM EncryptedField from src/security/encryption.ts
  secret_encrypted  JSONB NOT NULL,
  events            TEXT[] NOT NULL,
  is_active         BOOLEAN DEFAULT true,
  retry_config      JSONB DEFAULT '{"maxRetries": 3, "backoffMs": 1000}'::jsonb,
  headers           JSONB DEFAULT '{}'::jsonb,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  last_triggered    TIMESTAMPTZ,
  success_count     INTEGER DEFAULT 0,
  failure_count     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  webhook_id      TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  response_status INTEGER,
  response_body   TEXT,
  delivered_at    TIMESTAMPTZ,
  retry_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  business_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  report_type   TEXT NOT NULL,
  schedule_cron TEXT NOT NULL,
  recipients    TEXT[] NOT NULL,
  parameters    JSONB DEFAULT '{}'::jsonb,
  format        TEXT DEFAULT 'pdf' CHECK (format IN ('pdf','csv','excel')),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  last_run      TIMESTAMPTZ,
  next_run      TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_dashboards_business         ON custom_dashboards(business_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_business           ON webhook_endpoints(business_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_business_active    ON webhook_endpoints(business_id, is_active);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook  ON webhook_deliveries(webhook_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_business ON webhook_deliveries(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_business  ON scheduled_reports(business_id);
