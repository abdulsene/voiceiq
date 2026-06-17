# `artifacts/api-server/migrations/`

SQL migration files for the production Postgres database hosted on
Supabase project `zqhijauefcpwggklshoa`. These files are the **source
of truth** for production schema — `lib/db` (Drizzle) is wired up but
not authoritative (see root `CLAUDE.md`).

## Application process

Migrations are applied **manually** via either:

1. **Supabase MCP** `apply_migration` tool (preferred for Claude
   Code sessions). Caveat: the tool only returns the **last**
   statement's result, so multi-statement migrations need separate
   `execute_sql` calls to verify each piece landed. The current
   convention is one logical change per migration to keep this clean.
2. **Supabase SQL editor** (web UI) — used historically; still fine
   for one-off corrections.

After applying, **always verify with 3+ separate `execute_sql` calls**:

- Function exists in `pg_proc` (or table exists in `pg_tables`)
- Signature / column shape matches (`pg_get_function_arguments`,
  `information_schema.columns`)
- Security posture (`prosecdef`) / RLS posture / CHECK constraints
  match the file

Then **restart the api-server workflow** so any code path that reads
fresh schema picks it up.

## File naming

- Numeric prefix, three digits, monotonically increasing: `034_*.sql`
- Descriptive snake_case name after the prefix
- Date-stamped exceptions exist (`20260422_*.sql`) — these were
  applied out-of-band and live in this directory for completeness, but
  the numeric sequence is the canonical order

**Next migration number: 035.**

A handful of historical numbers were used twice (e.g. `006`, `007`,
`008` each appear twice) — these were independent landing branches
that both hit prod and got back-renamed to share a slot. Don't repeat
the practice; the dual-prefix migrations are kept for audit-trail
reasons. New work uses a fresh number.

## Canonical template

Every new migration should follow this shape:

```sql
-- NNN_descriptive_snake_case.sql
-- Phase X.Y — one-sentence purpose.
--
-- Multi-paragraph design rationale: what problem it solves, what
-- alternatives were considered, why this approach won. Future
-- maintainers read the header before they read the SQL.
--
-- Behavior:
--   1. ...
--   2. ...
--
-- SECURITY INVOKER (NOT DEFINER): why caller's RLS posture applies.
-- (Or: "RLS enabled — policies below" for tables.)
--
-- Atomic — wrapped in BEGIN/COMMIT around the CREATE / ALTER.
-- Idempotent — IF NOT EXISTS guards on DDL; DO $$ blocks on CHECKs;
--   CREATE OR REPLACE on functions; re-apply-safe.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

-- (1) CREATE TABLE / ALTER TABLE / CREATE FUNCTION etc.
--     IF NOT EXISTS / CREATE OR REPLACE on every DDL statement.

-- (2) Indexes (CREATE INDEX IF NOT EXISTS).

-- (3) RLS — for tables: ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
--     then per-policy CREATE POLICY ... USING (...) WITH CHECK (...).

-- (4) Comments — COMMENT ON TABLE / COMMENT ON COLUMN /
--     COMMENT ON FUNCTION. These show up in pg_description and are
--     queryable by future audits.

COMMIT;
```

Key invariants:

- **`BEGIN; ... COMMIT;`** around the whole file. If any statement
  fails, none should land.
- **`IF NOT EXISTS`** on `CREATE TABLE` / `CREATE INDEX`.
- **`CREATE OR REPLACE`** on `FUNCTION` / `VIEW`.
- **`DO $$ ... $$`** blocks for `ALTER TABLE ... ADD CONSTRAINT` —
  Postgres doesn't support `IF NOT EXISTS` on constraints, so wrap
  with a defensive lookup against `pg_constraint`.
- **`SECURITY INVOKER`** is the default and the right choice for any
  function the api-server calls via supabase-js's `.rpc()`. The
  api-server runs as `service_role` so it has full access; gating
  tenant ownership in the route handler before invoking keeps the
  function unaware of tenant identity.
- **RLS** on every tenant-scoped table. The api-server bypasses RLS
  via `service_role`, but the policies still need to exist for
  defense in depth and future RLS-constrained callers.

## Inventory

| #   | File                                                    | Phase / purpose |
| --- | ------------------------------------------------------- | --------------- |
| 001 | `user_management_rbac.sql`                              | Back-office user management + RBAC for the admin console |
| 002 | `dashboards_webhooks.sql`                               | Custom dashboard builder + webhook delivery tables |
| 003 | `industry_templates.sql`                                | Industry template catalogue for landing pages + demo generator |
| 004 | `sms_optin_consents.sql`                                | SMS opt-in consent capture |
| 005 | `sales_demos.sql`                                       | Sales-created demo tenants (reuses `preview_demos`) |
| 006 | `marketing_subscribers.sql`                             | Public marketing newsletter opt-in |
| 006 | `operator_transfer.sql`                                 | Warm-handoff transfer to a human operator (dual-prefix; see naming note) |
| 007 | `leads.sql`                                             | Callback-first escalation flow (leads + lead_activities) |
| 007 | `processed_webhook_events.sql`                          | Webhook delivery idempotency table (dual-prefix) |
| 008 | `email_verification_tokens.sql`                         | Email-verification tokens for signup flow |
| 008 | `lead_calls.sql`                                        | Slice 2A verified-callback accountability (dual-prefix) |
| 009 | `consulting_industry.sql`                               | Adds `Consulting` canonical category to industry_templates |
| 010 | `disable_demo_accounts_qa_flagged.sql`                  | Per-tenant `is_active=false` kill-switch |
| 011 | `enterprise_locations.sql`                              | Multi-location enterprise tenancy |
| 012 | `enterprise_business_config_columns.sql`                | 9 new columns on `business_configs` for enterprise handlers |
| 013 | `workos_sso.sql`                                        | Link WorkOS Connection to tenant |
| 014 | `sso_email_domains.sql`                                 | SSO domain → connection mapping |
| 015 | `chat_phase1.sql`                                       | Alex AI chat guide — text-only mode |
| 016 | `business_configs_pii_handling.sql`                     | Per-business PII redaction mode override |
| 017 | `twilio_provisioning_columns.sql`                       | Twilio DID provisioning state on `business_configs` |
| 018 | `provisioning_state_integrity.sql`                      | State-machine CHECK guards for the Twilio provisioning columns |
| 019 | `reconciliation_reports.sql`                            | Reconciliation-report storage |
| 020 | `add_prompt_columns_to_business_configs.sql`            | Prompt storage + sync-state columns |
| 021 | `create_prompt_audit_log.sql`                           | Prompt-edit audit log |
| 022 | `drop_unused_multilingual_columns.sql`                  | Drops `system_prompt_fr`/`system_prompt_es` |
| 023 | `extend_prompt_audit_log_source.sql`                    | Adds source values to prompt_audit_log |
| 024 | `slice_3a_substrate.sql`                                | Slice 3A — closed-loop first touch substrate |
| 025 | `outbound_voice_substrate.sql`                          | Phase 0 commit 0-A — outbound voice product substrate |
| 026 | `outbound_voice_provider_config.sql`                    | Phase 1.1 — outbound voice provider configuration |
| 029 | `outbound_campaigns_phase_2_extensions.sql`             | **Phase 2.1** — outbound_campaigns column extensions (segment_definition, schedule_definition, daily_cap, voicemail_text_override, schedule_strategy CHECK, expansion_running, last_expansion_at) |
| 030 | `appointments_table.sql`                                | **Phase 2.2** — additive ALTER on existing `appointments` (added `lead_id`, `duration_minutes`, `source`, `notes`, `updated_at`) + `trigger_set_updated_at` + indexes + RLS |
| 031 | `business_configs_record_appointment_flag.sql`          | **Phase 2.2.5** — feature flag for the `record_appointment` AI tool |
| 032 | `outbound_campaign_leads.sql`                           | **Phase 2.3** — junction table; state CHECK; indexes for expansion + state filters |
| 033 | `delete_campaign_with_cancellations.sql`                | **Phase 2.6a** — RPC: atomic campaign delete with `lead_calls` cancellation (SELECT FOR UPDATE row-lock) |
| 034 | `campaign_metrics_time_series.sql`                      | **Phase 2.7a** — RPC: 30-day daily-by-state aggregation for campaign metrics endpoint |

Date-stamped (out-of-band):

| Filename                                          | Purpose |
| ------------------------------------------------- | ------- |
| `20260422_industry_templates_phase_1_5.sql`       | Non-destructive industry_templates column adds; applied out-of-band |

Gaps in the numeric sequence (`027`, `028`) reflect numbers that were
allocated and abandoned during planning — no production state lives
there. Treat them as reserved-but-unused and move forward.

## Audit logs

Every documented audit lives at `PRODUCTION_AUDIT_YYYY_MM_DD.md` in
this directory. Append, don't overwrite — drift caught later is
useful diagnostic data.

Most recent: `PRODUCTION_AUDIT_2026_06_16.md` (Phase 2.8 closeout).
