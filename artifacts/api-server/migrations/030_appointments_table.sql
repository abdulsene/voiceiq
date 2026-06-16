-- 030_appointments_table.sql
-- Phase 2.2 — appointments table augmentation for the Phase 2 campaign engine.
--
-- IMPORTANT: This is an ADDITIVE ALTER migration, not a CREATE TABLE.
--
-- The `appointments` table already exists in the production schema (created
-- out-of-band, probably via the Supabase SQL editor or by the on-demand
-- CREATE TABLE IF NOT EXISTS shim at routes/api.ts:6772ish for the
-- appointment_reminders sibling). It's actively written by the inbound
-- booking flow:
--   routes/api.ts:1290, 1322 — Google Calendar booking handler
--   routes/api.ts:1688, 1709 — Outlook booking handler
--   routes/api.ts:6534       — demo stats endpoint (read)
--   routes/api.ts:9547       — sequence enrollment "stop on appointment"
--   voiceiq-dashboard/src/pages/Appointments.tsx:164 — dashboard create
--
-- Existing shape (15 columns, untouched here):
--   id INTEGER, business_id TEXT, caller_name, caller_phone,
--   appointment_datetime TIMESTAMPTZ, reason, calendar_provider, event_id,
--   status, reminder_sent, created_at, confirmed, confirmed_at, no_show,
--   reschedule_requested
--
-- Phase 2.2 augments with 5 new columns (all nullable except updated_at):
--   lead_id UUID FK leads(id) ON DELETE SET NULL
--   duration_minutes INT
--   source TEXT                     — provenance (ai_receptionist, staff_manual, etc.)
--   notes TEXT                      — free-form context for AI/staff (separate from `reason`)
--   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
--
-- Plus: trigger_set_updated_at() function (new), trg_appointments_updated_at
-- trigger, two indexes for Phase 2 segment queries, RLS enable (already TRUE
-- pre-apply per the standing check; this line is no-op but explicit).
--
-- Phase 2 design notes:
--   * appointment_datetime is the canonical timestamp column going forward.
--     The Phase A design draft used "scheduled_at" but the production column
--     name is appointment_datetime; Phase 2.3+ segment definitions reference
--     appointment_datetime.
--   * id stays INTEGER. Cross-table joins from outbound_campaign_leads use
--     INTEGER → INTEGER appointment.id matching, and Phase 2 code reads it
--     as a number. UUID rename is deferred — atomic across 6+ callers.
--   * No status CHECK constraint. Existing booking flow writes values we
--     haven't audited ('booked', 'pending', etc.); adding a CHECK could
--     break new bookings. The confirmed/no_show/reschedule_requested
--     BOOLEAN columns are the de facto lifecycle source. CHECK on status
--     deferred to a later migration after a callers audit.
--   * Lead-id backfill for existing rows is out of scope — production
--     row count was 0 at apply time. If rows accumulate before a
--     backfill, a separate migration can join caller_phone →
--     leads.contact_phone to populate lead_id retroactively.
--
-- RLS posture: matches Phase 1 tables. Enabled (already was), no policies;
-- service-role-only via WHERE business_id = req.businessId in app code.
--
-- Atomic — BEGIN/COMMIT. Idempotent — IF NOT EXISTS / DROP+CREATE for
-- the trigger. Re-applies cleanly.
--
-- Apply via Supabase SQL editor (or MCP apply_migration) against
-- project zqhijauefcpwggklshoa.

BEGIN;

-- ───────────────────────────────────────────────────────────────────────
-- trigger_set_updated_at() — generic BEFORE UPDATE trigger function.
--
-- Confirmed not present in any prior migration (grep across
-- artifacts/api-server/migrations/) and not in pg_proc at apply time.
-- Created here so future migrations that need an updated_at auto-bump
-- can reference the same function rather than defining a per-table copy.
--
-- CREATE OR REPLACE so re-applying this migration after a manual drop
-- is safe.

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION trigger_set_updated_at() IS
  'Generic BEFORE UPDATE trigger that auto-bumps updated_at to NOW(). Attach via CREATE TRIGGER ... BEFORE UPDATE ... FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at(). Introduced in migration 030; future tables that need updated_at auto-bumps should reference this function rather than defining a per-table copy.';

-- ───────────────────────────────────────────────────────────────────────
-- Phase 2.2 additive ALTERs

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS lead_id UUID
    REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS duration_minutes INT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS source TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ───────────────────────────────────────────────────────────────────────
-- updated_at trigger

DROP TRIGGER IF EXISTS trg_appointments_updated_at ON appointments;
CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ───────────────────────────────────────────────────────────────────────
-- Indexes for Phase 2 segment + lead lookups.
--
-- Naming convention: idx_appointments_business_appointment_datetime
-- (not "scheduled_at") to match the canonical column name in this
-- table going forward.

-- Primary tenant query: "show me this business's appointments by date."
-- Used by dashboard list views + Phase 2.3 reminders segment.
CREATE INDEX IF NOT EXISTS idx_appointments_business_appointment_datetime
  ON appointments (business_id, appointment_datetime);

-- Lead-anchored query: "show me this lead's upcoming appointments."
-- Partial because lead_id is nullable; saves index space on rows where
-- lead_id IS NULL (external bookings, plus pre-2.2 rows that pre-date
-- the lead_id column).
CREATE INDEX IF NOT EXISTS idx_appointments_lead
  ON appointments (lead_id, appointment_datetime)
  WHERE lead_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────────
-- RLS — already enabled on appointments per pre-apply check
-- (relrowsecurity = true). This line is a no-op in practice but stays
-- in the migration for explicitness + idempotent reproducibility.

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

-- ───────────────────────────────────────────────────────────────────────
-- COMMENT ON COLUMN for the 5 new columns. (Existing columns keep
-- whatever comments — if any — they had before; we don't touch them.)

COMMENT ON COLUMN appointments.lead_id IS
  'Optional link to a Neverr lead row. Phase 2 reminders campaign filters WHERE lead_id IS NOT NULL — appointments without a linked lead can''t be auto-reminded (no contact_phone to call). Populated by Phase 2.2.5 record_appointment AI tool + Phase 2.6 dashboard staff entry. Pre-2.2 rows have NULL; a future migration can backfill via caller_phone → leads.contact_phone if needed.';

COMMENT ON COLUMN appointments.duration_minutes IS
  'Optional appointment duration in minutes. NULL is acceptable — many bookings only carry a start time. Phase 2 dashboard reads this for the list-view rendering.';

COMMENT ON COLUMN appointments.source IS
  'Provenance — analytics + auditability. Free-form TEXT (no CHECK) so future integrations can define their own values without schema churn. Conventional values: ai_receptionist (Phase 2.2.5 record_appointment tool), staff_manual (dashboard), web_form (external booking), google_calendar_sync (calendar sync, future). Pre-2.2 rows leave NULL.';

COMMENT ON COLUMN appointments.notes IS
  'Free-form notes for context. Distinct from the existing `reason` column — `reason` answers "what is this appointment for" (purpose); `notes` answers "what additional context should staff or the AI agent know" (e.g. service-type details, accommodations, preferred timing windows). Both columns coexist.';

COMMENT ON COLUMN appointments.updated_at IS
  'Last-mutation timestamp. Auto-bumped on every UPDATE via trg_appointments_updated_at. Pre-2.2 rows backfilled to NOW() at column-add time (DEFAULT NOW() applies to existing rows).';

COMMIT;
