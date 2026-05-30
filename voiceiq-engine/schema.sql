-- business_configs — primary tenant settings table.
-- Includes Stripe billing columns and organization settings added via
-- direct Supabase ALTER (production was source of truth from Apr 2025
-- onward). Backfilled into schema April 27, 2026 (Phase 3k).
CREATE TABLE IF NOT EXISTS business_configs (
  -- Core identity
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id text UNIQUE NOT NULL,
  business_name text NOT NULL,

  -- AI agent config
  ai_name text DEFAULT 'Alex',
  industry text,
  tone text,
  greeting text,
  voice_id text DEFAULT 'alloy',
  business_hours text,
  location text,
  personality_instructions text,
  departments jsonb DEFAULT '[]',
  knowledge_base text,
  agent_id text,

  -- Phase 3b: website scraping
  website text,
  website_scraped_at timestamptz,
  website_scraped_data jsonb,
  website_context_text text,

  -- Phase 3c: customization layer
  custom_faqs jsonb DEFAULT '[]',
  objection_handling jsonb DEFAULT '[]',
  tone_preference text,
  never_say_list jsonb DEFAULT '[]',
  customization_updated_at timestamptz,

  -- Phase 3e: organization settings (auto-set on first team invite)
  organization_settings jsonb DEFAULT '{}',

  -- Phase 3f: SMS opt-in compliance
  sms_optin_settings jsonb DEFAULT '{}',

  -- Phase 3k: Stripe billing columns
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_status text,             -- 'trial' | 'active' | 'past_due' | 'cancelled'
  plan_id text,                         -- 'essential' | 'starter' | 'professional' | 'growth' | 'business' | 'enterprise'
  billing_cycle text,                   -- 'monthly' | 'annual'
  current_period_end timestamptz,
  trial_ends_at timestamptz,

  -- Operational metadata
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for Stripe lookups
CREATE INDEX IF NOT EXISTS idx_business_configs_stripe_customer
  ON business_configs(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_configs_subscription_status
  ON business_configs(subscription_status);

-- user_businesses — multi-tenancy membership table (Phase 3e).
-- Joins users to businesses with a role. Backfilled into schema April 27, 2026.
CREATE TABLE IF NOT EXISTS user_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  business_id text NOT NULL REFERENCES business_configs(business_id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',  -- 'owner' | 'admin' | 'manager' | 'member' | 'user' | 'readonly'
  created_at timestamptz DEFAULT now(),

  UNIQUE(user_id, business_id)
);

CREATE INDEX IF NOT EXISTS idx_user_businesses_user ON user_businesses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_businesses_business ON user_businesses(business_id);

CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid text UNIQUE,
  business_id text NOT NULL,
  caller_number text,
  caller_name text,
  caller_intent text,
  status text DEFAULT 'active',
  call_outcome text,
  sentiment text,
  transcript text,
  summary text,
  follow_up_required boolean DEFAULT false,
  duration_seconds integer,
  recording_url text,
  department_routed text,
  start_time timestamptz DEFAULT now(),
  end_time timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  task text NOT NULL,
  priority text DEFAULT 'medium',
  assign_to text,
  status text DEFAULT 'open',
  due_date date,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_business_id ON calls(business_id);
CREATE INDEX IF NOT EXISTS idx_calls_start_time ON calls(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS idx_action_items_call_id ON action_items(call_id);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);

INSERT INTO business_configs (
  business_id,
  business_name,
  ai_name,
  industry,
  tone,
  greeting,
  voice_id,
  business_hours,
  location,
  personality_instructions,
  departments,
  knowledge_base
) VALUES (
  'demo-business',
  'Acme Solutions',
  'Alex',
  'SaaS',
  'Professional and friendly',
  'Thank you for calling Acme Solutions. How can I help you today?',
  'alloy',
  'Monday to Friday, 9am to 5pm',
  'San Francisco, CA',
  'Be warm, helpful, and efficient. Use the caller''s name once learned. Keep responses under 30 words.',
  '[
    {"name": "Sales", "description": "New purchases, pricing, and product inquiries", "extension": "101"},
    {"name": "Support", "description": "Technical help, troubleshooting, and service issues", "extension": "102"},
    {"name": "Billing", "description": "Invoices, payments, and account questions", "extension": "103"}
  ]',
  'Acme Solutions is a SaaS company providing cloud-based business tools. Products include project management, CRM, and analytics dashboards. Free trial available for 14 days.'
) ON CONFLICT DO NOTHING;
