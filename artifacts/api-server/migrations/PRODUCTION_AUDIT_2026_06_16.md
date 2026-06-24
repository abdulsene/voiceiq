# Production migration audit — 2026-06-17

Run as part of the Phase 2.8 closeout. Verifies that the production
Supabase project (`zqhijauefcpwggklshoa`) reflects the migration
sequence checked into `artifacts/api-server/migrations/*.sql` up
through `034_campaign_metrics_time_series.sql`.

Run via the Supabase MCP `execute_sql` tool. Each query is independent;
results captured below verbatim.

Future audits should follow the same template: copy this file to
`PRODUCTION_AUDIT_YYYY_MM_DD.md`, re-run each query, paste the
results, and note any drift in the "Findings" section.

---

## (a) Functions present

```sql
SELECT proname
FROM pg_proc
WHERE proname IN (
  'delete_campaign_with_cancellations',
  'campaign_metrics_time_series',
  'trigger_set_updated_at'
)
ORDER BY proname;
```

**Result** — 3 rows, expected:

| proname |
| --- |
| `campaign_metrics_time_series` |
| `delete_campaign_with_cancellations` |
| `trigger_set_updated_at` |

✅ Matches expectation.

## (b) Tables present

```sql
SELECT tablename
FROM pg_tables
WHERE tablename IN (
  'outbound_campaigns',
  'outbound_campaign_leads',
  'appointments',
  'business_configs',
  'leads',
  'lead_calls'
)
ORDER BY tablename;
```

**Result** — 6 rows, expected:

| tablename |
| --- |
| `appointments` |
| `business_configs` |
| `lead_calls` |
| `leads` |
| `outbound_campaign_leads` |
| `outbound_campaigns` |

✅ Matches expectation.

## (c) CHECK constraints on `outbound_campaign_leads`

```sql
SELECT conname
FROM pg_constraint
WHERE conrelid = 'outbound_campaign_leads'::regclass
  AND contype = 'c';
```

**Result** — 1 row, expected:

| conname |
| --- |
| `outbound_campaign_leads_state_chk` |

✅ Matches expectation. The CHECK gates `state` to
`('pending', 'scheduled', 'completed', 'skipped', 'opted_out')` per
migration 032.

## (d) Indexes on `outbound_campaign_leads`

```sql
SELECT indexname
FROM pg_indexes
WHERE tablename = 'outbound_campaign_leads'
ORDER BY indexname;
```

**Result** — 4 rows, expected:

| indexname |
| --- |
| `idx_ocl_campaign_state` |
| `idx_ocl_lead_state` |
| `outbound_campaign_leads_campaign_id_lead_id_key` |
| `outbound_campaign_leads_pkey` |

✅ Matches expectation. PK + UNIQUE(campaign_id, lead_id) +
2 secondary indexes for expansion / state-filter queries.

---

## Findings

No drift detected. Production matches the in-repo migration sequence
through migration 034. Phase 2.7a's RPC + 2.6a's RPC + the existing
`trigger_set_updated_at` (from Phase 2.2 / migration 030) are all
SECURITY INVOKER and gated by route-level tenant ownership checks
in `routes/campaigns.ts`.

Next migration number: **035**.

## Notes for future auditors

- Verify each function's `prosecdef = false` (SECURITY INVOKER) if a
  function reappears in the result — drift to `true` is a privilege
  escalation risk worth flagging.
- The `appointments` table was added via additive `ALTER` in
  migration 030 (it pre-existed with a different shape — see migration
  030 header for context). If a future audit shows a missing column,
  diff against the migration body, not a CREATE TABLE skeleton.
- The `20260422_industry_templates_phase_1_5.sql` migration (datestamp
  naming) is unrelated to the campaign engine and was not in scope
  for this audit.

---

## 2026-06-24 — Phase 2.7a-fix: metrics endpoint outcome derivation

**Bug.** `handleGetCampaignMetrics` in `src/routes/campaigns.ts` was
reading `succeeded`, `failed`, `voicemail` directly from
`outbound_campaign_leads.state` — but the CHECK constraint at item (c)
above caps `state` at `{pending, scheduled, completed, skipped,
opted_out}`. Those three counters always returned 0 in production. The
034 metrics smoke passed because `FakeSupabaseClient` doesn't enforce
CHECK constraints, masking the bug.

**Where outcomes actually live.** `lead_calls.status` (text,
'completed' / 'failed'), `lead_calls.voicemail_left` (boolean), and
`lead_calls.end_reason` (text) — set by the Twilio post-call status
webhook and AMD voicemail-redirect path in
`src/routes/twilio-outbound-voice.ts`.

**Fix.** Added a 4th parallel query in `handleGetCampaignMetrics`
that JOINs `outbound_campaign_leads → lead_calls` via
`scheduled_call_id` (PostgREST embedded select) for junction rows
with `state='completed'`, then derives succeeded / failed / voicemail
in Node using the canonical mapping (`deriveOutcome`):

  1. `voicemail_left === true` → **voicemail**
  2. `status === 'failed'` → **failed**
  3. `status === 'completed'` → **succeeded**

Priority order matters — a successful voicemail leave also lands on
`status='completed'`, so `voicemail_left` is checked first.

**Test posture.** 034 metrics smoke's T1 fixture was restructured to
stage only CHECK-valid junction states (10 scheduled + 8 completed +
30 skipped + 2 pending = 50 rows) plus an embedded-JOIN response
exercising each branch (6 succeeded + 1 failed + 1 voicemail lead_call
payloads). T2 / T3 / T5 received empty stubs for the 4th query.

**No DB drift.** This is a pure code-side fix — no migration, no schema
change. Production state matches the in-repo migration sequence
unchanged; the next migration number is still 035.

**Aligned but-not-yet-fixed.** The `campaign_metrics_time_series` RPC
(migration 034) is the second consumer of the same false assumption —
it groups by junction `state` and so will never emit
`succeeded`/`failed`/`voicemail` rows. The time_series chart silently
shows 0 for those three series. Phase 2.7a-fix intentionally scopes to
the counters; the RPC fix is a separate change because it requires
either a JOIN to lead_calls inside SQL (per-day re-derivation) or a
denormalized outcome column on the junction. Tracked for a follow-up.
