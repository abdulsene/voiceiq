-- 010_disable_demo_accounts_qa_flagged.sql
-- Sprint 4 TC-35 — Abdul's Option A decision (DB-level is_active=false
-- toggle, in preference to DELETE or frontend filter).
--
-- Background:
--   /demo (singular) renders cards from the `demo_accounts` table via
--   GET /api/demo/industries (routes/api.ts:6653), which filters
--   `.eq("is_active", true)`. QA flagged 4 cards as still visible —
--   they were supposed to be removed by Sprint 3 BUG-11:
--     - retail_bank    → Community First Bank
--     - barber_shop    → The Classic Cut Barber
--     - gym_fitness    → Peak Performance Fitness
--     - funeral_home   → Peaceful Rest Funeral Home
--
--   Sprint 3 BUG-11 only modified the hardcoded DEMOS array in the
--   /demos (plural) page — wrong code path. None of the 4 flagged
--   names existed in that array; they live in the `demo_accounts`
--   table that powers the /demo (singular) page QA actually tested.
--
-- Why is_active=false (not DELETE):
--   Reversible. If QA changes their mind we can flip back to true
--   without re-creating each row's phone, tagline, icon, category, etc.
--   The /api/demo/industries handler already filters out is_active=false
--   rows, so this hides them from /demo immediately on next page load
--   with zero deploy / zero code change.
--
-- Idempotent — safe to re-run. The `AND is_active = true` clause means
--   re-runs report "UPDATE 0" cleanly.
--
-- Run in Supabase SQL editor.

UPDATE demo_accounts
SET is_active = false
WHERE industry_id IN (
  'retail_bank',
  'barber_shop',
  'gym_fitness',
  'funeral_home'
)
AND is_active = true;

-- Verification — uncomment and run after the UPDATE to confirm all 4
-- rows now show is_active = false:
--
-- SELECT industry_id, business_name, is_active
-- FROM demo_accounts
-- WHERE industry_id IN (
--   'retail_bank', 'barber_shop', 'gym_fitness', 'funeral_home'
-- )
-- ORDER BY industry_id;
