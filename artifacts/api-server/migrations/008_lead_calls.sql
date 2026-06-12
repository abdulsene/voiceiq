-- 008_lead_calls.sql
-- Slice 2A — verified-callback accountability. Staff clicks "Call
-- customer" → Twilio bridges them with the business's caller ID →
-- dual-channel recording → Deepgram transcript → Claude summary → all
-- logged with audit trail.
--
-- Schema choice rationale (per Checkpoint 1): separate lead_calls
-- table rather than packing into lead_activities.metadata. Recording
-- + transcript + summary form a 3-step state machine on the same
-- logical record; queries for analytics (Slice 3-4) need columnar
-- access to duration/staff/status; transcripts are too big for
-- activity metadata.
--
-- lead_activities still gets entries (call_initiated, call_completed,
-- call_failed) — they're the timeline markers. Each carries
-- lead_call_id in metadata so the UI dereferences to fetch the rich
-- row.
--
-- Applied via Supabase apply_migration MCP. Idempotent CREATE IF NOT
-- EXISTS so safe to re-run from this file too.

CREATE TABLE IF NOT EXISTS lead_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  call_sid TEXT,                            -- Twilio CallSid (staff leg)
  staff_user_id UUID REFERENCES auth.users(id),
  staff_ring_number TEXT,
  customer_phone TEXT NOT NULL,
  from_caller_id TEXT,                      -- what the customer saw
  status TEXT NOT NULL DEFAULT 'initiated', -- initiated|ringing|in_progress|completed|failed
  customer_answered BOOLEAN,
  end_reason TEXT,                          -- completed|busy|no-answer|failed|canceled
  duration_secs INTEGER,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  recording_sid TEXT,
  recording_url TEXT,                       -- Twilio media URL; HTTP Basic auth to fetch
  recording_duration_secs INTEGER,
  recording_channels INTEGER,
  -- transcription_status distinguishes 'transcribing now' from 'failed'
  -- without relying on NULL on transcript_text. Partial index below
  -- supports a future retry-job slice that sweeps stuck 'pending' rows.
  transcription_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'completed' | 'failed'
  transcript_text TEXT,
  transcript_segments JSONB,                -- per-channel speaker-labeled segments from Deepgram
  transcript_confidence NUMERIC,
  summary_text TEXT,
  summary_model TEXT,                       -- 'claude-haiku-4-5' etc
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_calls_call_sid_unique
  ON lead_calls(call_sid) WHERE call_sid IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_calls_lead_idx
  ON lead_calls(lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lead_calls_staff_idx
  ON lead_calls(staff_user_id, created_at DESC) WHERE staff_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_calls_pending_transcription
  ON lead_calls(created_at) WHERE transcription_status = 'pending';

-- Staff's "ring me at" preference. Per-business (not per-user) because
-- staff often belong to multiple businesses and may want different
-- callback lines per company. Nullable; the POST /api/business/leads/:id/call
-- handler 400s with an actionable error when this is null.
ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS callback_ring_number TEXT;
