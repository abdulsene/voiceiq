-- 036_industry_templates_default_topics.sql
-- Phase 3.1a — industry-defined topic catalogue + seeds for six pilot
-- industries.
--
-- Every industry ships with a default set of "topics" — customer intents
-- the AI receptionist can identify (e.g. car_rental → new_reservation,
-- payments, roadside_breakdown). A business inherits its industry's
-- topics as its default (copied into business_configs.departments on
-- reset), can customize, and Phase 3.2 uses the topic identified by the
-- AI to route the call to on-duty staff who handle that topic.
--
-- Topic shape per row (JSONB array of objects):
--   [
--     {
--       "slug": "payments",                             -- stable routing key (snake_case)
--       "name": "Payments & billing",                   -- display label
--       "description": "Payment questions, arrears...", -- prompt context for the AI
--       "example_utterances": [                         -- prompt few-shots for the AI
--         "I want to make a payment",
--         "when is my payment due"
--       ]
--     },
--     ...
--   ]
--
-- Slug is the routing key — it appears on staff_topics.topic_slug and
-- (Phase 3.2+) on calls.identified_topic. Renaming or removing a slug
-- after staff assignments exist is a data-migration event, not a
-- config edit — the UI's "reset to defaults" copies the industry set
-- but a business can freely add/remove/rename their own topics.
--
-- Six seed industries in this migration:
--   * car_rental          — EZ Rentals's industry (load-bearing)
--   * dental_practice     — common healthcare pilot
--   * hvac_plumbing       — home services pilot
--   * law_firm            — professional services pilot
--   * real_estate_agency  — professional services pilot
--   * restaurant          — hospitality pilot
--
-- ⚠️ Column-name note: production `industry_templates` uses `industry_id`
-- (verified via Supabase MCP during Phase A sign-off) — the row for
-- car_rental has industry_id='car_rental', name='Car Rental',
-- category='Transportation & Logistics'. Migration 003 declared
-- `industry_code` / `industry_name` / `industry_category` but
-- production drifted to shorter names. This migration uses the
-- production names.
--
-- Seed pattern: DO block per industry running an UPDATE ... WHERE
-- industry_id = '...'. If the industry row is missing, the block
-- RAISES NOTICE and the migration continues — the Phase 3.1b UI
-- will handle missing industries by importing from the code catalog
-- in src/data/comprehensive-industries.ts.
--
-- Idempotent — column ADD is IF NOT EXISTS; seeds are UPDATE (re-apply
-- overwrites default_topics with the same JSON, no-op semantically).
--
-- Apply via Supabase apply_migration MCP against project
-- zqhijauefcpwggklshoa. After apply, verify:
--
--   SELECT column_name, data_type, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'industry_templates' AND column_name = 'default_topics';
--
--   SELECT industry_id, jsonb_array_length(default_topics) AS topic_count
--     FROM industry_templates
--    WHERE industry_id IN ('car_rental','dental_practice','hvac_plumbing',
--                          'law_firm','real_estate_agency','restaurant')
--    ORDER BY industry_id;

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- (1) Column
ALTER TABLE industry_templates
  ADD COLUMN IF NOT EXISTS default_topics JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN industry_templates.default_topics IS
  'Phase 3.1: Ordered array of topic objects for this industry. Copied into business_configs.departments when a business resets to defaults. Each object: { slug (snake_case routing key), name (display), description (AI prompt context), example_utterances (AI few-shots) }.';

-- ───────────────────────────────────────────────────────────────────
-- (2) Seed — car_rental (EZ Rentals)
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "new_reservation",
         "name": "New reservations",
         "description": "New rental inquiries, quotes, availability, booking a car",
         "example_utterances": [
           "I need to rent a car",
           "do you have anything available this weekend",
           "how much for a mid-size for three days",
           "what cars do you have"
         ]
       },
       {
         "slug": "existing_reservation",
         "name": "Existing reservations",
         "description": "Modifications, extensions, cancellations, questions about a current booking",
         "example_utterances": [
           "I need to extend my rental",
           "I want to cancel my reservation",
           "can I change my pickup time",
           "I have a booking under my name"
         ]
       },
       {
         "slug": "payments",
         "name": "Payments & billing",
         "description": "Billing questions, payment plans, arrears, refunds, disputes on charges",
         "example_utterances": [
           "I want to make a payment",
           "when is my payment due",
           "there is an issue with my bill",
           "I need to set up a payment plan"
         ]
       },
       {
         "slug": "roadside_breakdown",
         "name": "Roadside & breakdown",
         "description": "Emergency roadside assistance, mechanical issues, accident reports while a rental is out",
         "example_utterances": [
           "my rental broke down",
           "I got a flat tire",
           "the check engine light came on",
           "I was in an accident"
         ]
       },
       {
         "slug": "returns_dropoff",
         "name": "Returns & drop-off",
         "description": "Return process questions, late fees, damage inspection, drop-off locations",
         "example_utterances": [
           "where do I drop the car off",
           "will I be charged a late fee",
           "there is a scratch on the car",
           "what time does the return desk close"
         ]
       },
       {
         "slug": "loyalty_membership",
         "name": "Loyalty & corporate accounts",
         "description": "Loyalty program enrollment, points, tier questions, corporate account setup or usage",
         "example_utterances": [
           "how do I sign up for your loyalty program",
           "how many points do I have",
           "I am calling on behalf of a corporate account",
           "do you have any member discounts"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'car_rental';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=car_rental not found — seed skipped (Phase 3.1b UI can import from code catalog)';
  ELSE
    RAISE NOTICE 'Migration 036: seeded default_topics for car_rental (% row)', n;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- (3) Seed — dental_practice
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "appointment_booking",
         "name": "Appointment booking",
         "description": "Schedule cleanings, exams, or treatment appointments",
         "example_utterances": [
           "I need to book a cleaning",
           "can I schedule an exam",
           "I want to make an appointment",
           "do you have anything this week"
         ]
       },
       {
         "slug": "insurance_billing",
         "name": "Insurance & billing",
         "description": "Insurance coverage, billing questions, out-of-pocket estimates",
         "example_utterances": [
           "do you take my insurance",
           "how much will this cost",
           "I got a bill I don't understand",
           "can you send my claim"
         ]
       },
       {
         "slug": "treatment_questions",
         "name": "Treatment questions",
         "description": "Questions about procedures, aftercare, medications, expected recovery",
         "example_utterances": [
           "what should I do after my extraction",
           "is this pain normal",
           "when should the numbness wear off",
           "I have questions about my crown"
         ]
       },
       {
         "slug": "dental_emergency",
         "name": "Dental emergency",
         "description": "Broken tooth, severe pain, dental trauma requiring urgent attention",
         "example_utterances": [
           "my tooth is broken",
           "I am in a lot of pain",
           "I knocked out a tooth",
           "my crown fell off"
         ]
       },
       {
         "slug": "prescription_refill",
         "name": "Prescription refill",
         "description": "Prescription refills, medication questions, pharmacy coordination",
         "example_utterances": [
           "I need a refill on my prescription",
           "can you call in my antibiotics",
           "the pharmacy needs to reach you"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'dental_practice';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=dental_practice not found — seed skipped';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- (4) Seed — hvac_plumbing
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "emergency_service",
         "name": "Emergency service",
         "description": "Water leak, no heat, no AC, gas smell, burst pipe — anything requiring same-day dispatch",
         "example_utterances": [
           "I have a water leak",
           "my heat isn't working",
           "there is water everywhere",
           "I smell gas",
           "my AC stopped working and it's really hot"
         ]
       },
       {
         "slug": "quote_request",
         "name": "Quote & estimate",
         "description": "New installation estimate, replacement pricing, project scope questions",
         "example_utterances": [
           "how much for a new furnace",
           "can I get an estimate",
           "I want to replace my water heater",
           "how much would it cost to install AC"
         ]
       },
       {
         "slug": "scheduling",
         "name": "Scheduling & routine service",
         "description": "Book non-emergency service, routine maintenance, follow-up visits",
         "example_utterances": [
           "I need to schedule a tune-up",
           "can someone come look at my sink",
           "when is your next available appointment",
           "I want to book a service call"
         ]
       },
       {
         "slug": "warranty_service",
         "name": "Warranty & follow-up",
         "description": "Warranty claims, callbacks on prior work, work-not-fixed complaints",
         "example_utterances": [
           "the work you did last week isn't holding",
           "is this under warranty",
           "I need someone to come back out"
         ]
       },
       {
         "slug": "maintenance_plan",
         "name": "Maintenance plan",
         "description": "Annual plans, seasonal tune-up subscriptions, plan renewals",
         "example_utterances": [
           "I want to sign up for your maintenance plan",
           "is my membership still active",
           "when is my seasonal tune-up due"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'hvac_plumbing';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=hvac_plumbing not found — seed skipped';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- (5) Seed — law_firm
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "new_client_intake",
         "name": "New client intake",
         "description": "Prospective clients seeking case evaluation, initial consultation, or representation",
         "example_utterances": [
           "I need a lawyer",
           "I want to discuss my case",
           "do you take clients for personal injury",
           "can I schedule a consultation"
         ]
       },
       {
         "slug": "existing_case",
         "name": "Existing case",
         "description": "Updates on an active matter, document requests, status questions from current clients",
         "example_utterances": [
           "I want an update on my case",
           "I need to send you some documents",
           "has there been a response from the other side",
           "when is my next court date"
         ]
       },
       {
         "slug": "billing",
         "name": "Billing & retainer",
         "description": "Invoice questions, retainer replenishment, payment plans, fee disputes",
         "example_utterances": [
           "I have a question about my invoice",
           "how do I pay my retainer",
           "can I set up a payment plan",
           "what does this charge on my bill mean"
         ]
       },
       {
         "slug": "appointment_scheduling",
         "name": "Appointments & meetings",
         "description": "Schedule meetings with the attorney, depositions, court appearance coordination",
         "example_utterances": [
           "I need to meet with the attorney",
           "can we reschedule my appointment",
           "when is the deposition"
         ]
       },
       {
         "slug": "general_inquiry",
         "name": "General inquiry",
         "description": "Practice area questions, referrals, other calls that don't fit the above topics",
         "example_utterances": [
           "what kinds of cases do you handle",
           "do you have someone who does immigration",
           "can you refer me to another lawyer"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'law_firm';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=law_firm not found — seed skipped';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- (6) Seed — real_estate_agency
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "property_inquiry",
         "name": "Property inquiry",
         "description": "Details on a listed property — price, features, availability, disclosures",
         "example_utterances": [
           "I'm calling about the listing on Main Street",
           "is that house still available",
           "how many bedrooms does it have",
           "what's the asking price"
         ]
       },
       {
         "slug": "showing_request",
         "name": "Showing request",
         "description": "Schedule a property showing or open-house attendance",
         "example_utterances": [
           "I'd like to see the property",
           "can we tour that house tomorrow",
           "is there an open house this weekend"
         ]
       },
       {
         "slug": "listing_inquiry",
         "name": "Listing my property",
         "description": "Sellers interested in listing, valuation, listing agreement questions",
         "example_utterances": [
           "I want to sell my house",
           "can someone give me a valuation",
           "what would my home be worth"
         ]
       },
       {
         "slug": "offers_transactions",
         "name": "Offers & transactions",
         "description": "Offer status, contract questions, inspection, closing coordination",
         "example_utterances": [
           "has there been a response to my offer",
           "I have a question about the contract",
           "when is the inspection scheduled",
           "what's the status on closing"
         ]
       },
       {
         "slug": "general_inquiry",
         "name": "General inquiry",
         "description": "Market questions, agent referrals, other calls that don't fit the above",
         "example_utterances": [
           "how is the market right now",
           "do you have an agent who works in a specific neighborhood",
           "can you refer me to someone"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'real_estate_agency';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=real_estate_agency not found — seed skipped';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- (7) Seed — restaurant
DO $$
DECLARE
  n INT;
BEGIN
  UPDATE industry_templates
     SET default_topics = $topics$[
       {
         "slug": "reservations",
         "name": "Reservations",
         "description": "Table booking, party size, timing, reservation changes and cancellations",
         "example_utterances": [
           "I'd like to make a reservation",
           "do you have a table for four tonight",
           "I need to change my reservation",
           "can I cancel my booking"
         ]
       },
       {
         "slug": "catering",
         "name": "Catering & events",
         "description": "Catering orders, private events, event menus, off-site bookings",
         "example_utterances": [
           "I want to book catering for an event",
           "do you cater",
           "can we rent out the private room",
           "how does catering pricing work"
         ]
       },
       {
         "slug": "hours_directions",
         "name": "Hours & directions",
         "description": "Business hours, holiday hours, location and parking questions",
         "example_utterances": [
           "what time do you close",
           "are you open on Sunday",
           "where are you located",
           "do you have parking"
         ]
       },
       {
         "slug": "dietary_allergies",
         "name": "Dietary & allergies",
         "description": "Allergen questions, dietary accommodations, ingredient sourcing questions",
         "example_utterances": [
           "do you have gluten-free options",
           "I have a nut allergy",
           "is there anything vegan on the menu",
           "does your kitchen handle allergies safely"
         ]
       },
       {
         "slug": "feedback",
         "name": "Feedback",
         "description": "Compliment, complaint, follow-up on a prior visit",
         "example_utterances": [
           "I want to leave feedback about my visit",
           "we had an issue with our meal last night",
           "I want to compliment your team"
         ]
       }
     ]$topics$::jsonb
   WHERE industry_id = 'restaurant';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    RAISE NOTICE 'Migration 036: industry_id=restaurant not found — seed skipped';
  END IF;
END $$;

COMMIT;
