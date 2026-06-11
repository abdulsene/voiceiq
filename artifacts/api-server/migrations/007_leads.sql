-- 007_leads.sql
-- Callback-first escalation flow. Captures every escalated call (AI →
-- request_callback tool) as a Lead row with an activity timeline.
-- Slice 1: data capture + read. Slices 2-4 add staff actions,
-- assignments, notifications, SLA.
--
-- All FKs point at existing tables: business_configs(business_id) and
-- calls(id) for source attribution, auth.users(id) for staff ownership.
-- ON DELETE CASCADE on lead_activities so removing a lead also cleans
-- its timeline.
--
-- Applied via Supabase apply_migration MCP. Idempotent CREATE IF NOT
-- EXISTS so safe to re-run from this file too.

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id TEXT NOT NULL REFERENCES business_configs(business_id),
  source TEXT NOT NULL,                   -- 'ai_callback' | 'manual' | 'sms' | 'web_form'
  source_call_id UUID REFERENCES calls(id),
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  preferred_channel TEXT,                 -- 'text' | 'call' | 'email' | 'voice_callback'
  reason TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'medium', -- 'low' | 'medium' | 'high' | 'emergency'
  status TEXT NOT NULL DEFAULT 'new',     -- 'new' | 'claimed' | 'in_progress' | 'resolved' | 'dismissed'
  assigned_to UUID REFERENCES auth.users(id),
  claimed_at TIMESTAMPTZ,
  first_response_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  dismissed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES auth.users(id),
  actor_type TEXT NOT NULL,               -- 'ai' | 'staff' | 'system'
  action TEXT NOT NULL,                   -- 'captured' | 'claimed' | 'note_added' | 'sms_sent' | 'email_sent' | 'resolved' | 'dismissed' | 'reopened' | 'reassigned' | 'escalated'
  metadata JSONB,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_business_status_idx
  ON leads(business_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS leads_assigned_to_idx
  ON leads(assigned_to) WHERE assigned_to IS NOT NULL;

CREATE INDEX IF NOT EXISTS lead_activities_lead_idx
  ON lead_activities(lead_id, created_at DESC);
