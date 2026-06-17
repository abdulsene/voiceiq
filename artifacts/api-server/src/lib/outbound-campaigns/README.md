# Outbound Campaigns Engine

Targeted outbound voice calls driven by a per-tenant JSON DSL.
"Campaigns" pick a segment of leads, schedule when each lead should be
called, then materialise individual `lead_calls` rows that the
existing 1.x outbound voice infrastructure fires at the right time.

Audience: an engineer landing here cold who needs to add a segment
field, debug a stuck campaign, expand the skip-reason vocabulary, or
extend the metrics surface. No prior session context required.

---

## 1. What the engine does (in two paragraphs)

A tenant creates a **campaign** (`outbound_campaigns` row) with a
`segment_definition` JSON ("which leads"), a `schedule_definition`
JSON ("when each lead's call should fire"), and a `daily_cap`. When
the campaign moves to `status='active'`, a periodic **expansion
worker** ticks every 5 minutes, resolves the segment against `leads`,
resolves the schedule against `appointments` (for `time_relative`) or
the bulk fire_at, and writes one row per (campaign, lead) into the
`outbound_campaign_leads` **junction**. Eligibility checks (DNC,
voice consent, calling hours, already-in-campaign, daily cap) gate
each junction row's eventual state — eligible leads transition to
`state='scheduled'` with a pre-inserted `lead_calls.status='scheduled'`
row pointing at them; ineligible leads transition straight to
`state='skipped'` with a `skip_reason`.

The Phase 1.5b **fire-time worker** then ticks every 60 seconds,
finds `lead_calls` rows whose `scheduled_for` has passed, and reinvokes
the Phase 1.3 `placeCall` primitive in `existingLeadCallId` mode. That
hits Twilio/ElevenLabs, the call happens, status webhooks update the
`lead_calls.status` to `completed` / `failed` / `voicemail`, and the
junction row reflects the terminal state via post-call writebacks. A
metrics endpoint (Phase 2.7a) re-aggregates the junction at query
time so the dashboard surfaces show counters that can't drift from
ground truth.

## 2. Architecture flow

```
                            ┌─────────────────────────┐
                            │  Tenant creates draft   │
                            │ POST /campaigns         │
                            └────────────┬────────────┘
                                         │ PATCH status=active
                                         ▼
                            ┌─────────────────────────┐
                            │  outbound_campaigns row │
                            │  status='active'        │
                            └────────────┬────────────┘
                                         │ (cooperative lock via
                                         │  UPDATE expansion_running=true
                                         │  WHERE expansion_running=false
                                         │  RETURNING id)
                                         ▼
        ┌──────────────────────────────────────────────────────┐
        │  Expansion worker (cron.ts, 5min cadence)            │
        │  ────────────────────────────────────────────────    │
        │  1. resolveSegment(supabase, businessId, segment)    │
        │     → leadIds                                        │
        │  2. resolveSchedule(supabase, businessId, leadIds,   │
        │     schedule) → Map<leadId, scheduledFor>            │
        │  3. For each leadId:                                 │
        │     a. UPSERT junction state='pending'               │
        │        (idempotent — R5 reorder: eligibility runs    │
        │        BEFORE this for FRESH leads, AFTER for the    │
        │        pending-resume path)                          │
        │     b. checkCampaignEligibility (DNC, consent,       │
        │        calling_hours, already_in_campaign)           │
        │        + daily_cap counter (step 5.5, in-mem cache)  │
        │     c. If eligible: placeCall(scheduledFor=Date)     │
        │        → step-7 defer-branch INSERTs                 │
        │        lead_calls(status='scheduled')                │
        │        → UPDATE junction state='scheduled',          │
        │          scheduled_call_id=<lc.id>                   │
        │     d. If not eligible: UPDATE junction              │
        │        state='skipped', skip_reason=<reason>         │
        │  4. UPDATE campaign last_expansion_at=NOW(),         │
        │     expansion_running=false                          │
        └────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────┐
                │  outbound_campaign_leads (state= │
                │  'scheduled', scheduled_call_id) │
                │  + lead_calls (status='scheduled',│
                │  scheduled_for=<future>)         │
                └────────────────┬─────────────────┘
                                 │ scheduled_for arrives
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │  Fire-time worker (cron.ts, 60s cadence)             │
        │  ────────────────────────────────────────────────    │
        │  SELECT lead_calls WHERE status='scheduled'          │
        │    AND scheduled_for <= NOW()                        │
        │  For each: placeCall(existingLeadCallId)             │
        │  → Twilio places the call                            │
        └────────────────────────┬─────────────────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────┐
                │  /api/twilio/outbound-voice/*    │
                │  AMD + TwiML + status webhooks   │
                │  → lead_calls.status = completed │
                │    / failed / voicemail          │
                └────────────────┬─────────────────┘
                                 │
                                 ▼
                ┌──────────────────────────────────┐
                │  outbound_campaign_leads state   │
                │  reflects terminal outcome       │
                └────────────────┬─────────────────┘
                                 │ GET /campaigns/:id/metrics
                                 ▼
                ┌──────────────────────────────────┐
                │  Metrics endpoint (Phase 2.7a)   │
                │  re-aggregates junction at       │
                │  query time → counters, rates,   │
                │  time-series (RPC), skip pareto  │
                └──────────────────────────────────┘
```

## 3. Segment DSL

JSON shape (validated by `segment-resolver.ts` `parseSegmentDefinition`):

```json
{
  "version": 1,
  "filters": {
    "all": [
      { "field": "leads.status", "op": "in", "value": ["new", "claimed"] },
      { "field": "leads.do_not_call", "op": "eq", "value": false }
    ],
    "any": [
      { "field": "leads.urgency", "op": "eq", "value": "high" },
      { "field": "leads.urgency", "op": "eq", "value": "emergency" }
    ]
  }
}
```

- `filters.all` is AND-joined (chained `.eq()` / `.in()` / etc. on the
  supabase-js builder).
- `filters.any` is OR-joined (single `.or("col.op.val,col.op.val")`
  call).
- The two combine as `all AND (any OR any...)`.
- Empty filters (`{}` or `{ all: [], any: [] }`) returns every
  business-scoped lead — useful paired with calling-hours + consent
  gates at fire time.

### Allowed fields

Source: `ALLOWED_FIELDS` in `segment-resolver.ts`. **Server is
authoritative**; the dashboard mirrors this manually
(`components/SegmentBuilder/types.ts` `FIELD_DISPLAY_INFO`).

| Field key                          | Postgres column                   | Type        |
| ---------------------------------- | --------------------------------- | ----------- |
| `leads.status`                     | `status`                          | `text`      |
| `leads.urgency`                    | `urgency`                         | `text`      |
| `leads.source`                     | `source`                          | `text`      |
| `leads.preferred_channel`          | `preferred_channel`               | `text`      |
| `leads.do_not_call`                | `do_not_call`                     | `boolean`   |
| `leads.outcome_booked`             | `outcome_booked`                  | `boolean`   |
| `leads.outbound_attempt_count`     | `outbound_attempt_count`          | `integer`   |
| `leads.last_outbound_attempt_at`   | `last_outbound_attempt_at`        | `timestamp` |
| `leads.first_response_at`          | `first_response_at`               | `timestamp` |
| `leads.created_at`                 | `created_at`                      | `timestamp` |
| `leads.resolved_at`                | `resolved_at`                     | `timestamp` |

### Allowed operators (per type)

| Type        | Allowed `op` values                                                    |
| ----------- | ---------------------------------------------------------------------- |
| `text`      | `eq`, `neq`, `in`, `not_in`, `exists`, `not_exists`                    |
| `boolean`   | `eq`, `neq`                                                            |
| `integer`   | `eq`, `neq`, `lt`, `lte`, `gt`, `gte`                                  |
| `timestamp` | `lt`, `lte`, `gt`, `gte`, `older_than`, `newer_than`, `exists`, `not_exists` |

`older_than` / `newer_than` take a **duration string**:
`(N)(s|m|h|d|w)`. E.g. `"30d"` = 30 days, `"2h"` = 2 hours.

### SQL injection guard

supabase-js's `.or()` builder takes a PostgREST URL-format string like
`"col.op.val,col.op.val"`. Values are **string-concatenated** into
that URL — a value containing comma, paren, double-quote, or backslash
mis-parses and could be exploited.

`parseSegmentDefinition` **rejects** any string value containing one
of those four characters. Phase 2 segment vocabulary (status names,
urgency levels, source labels) never legitimately contains those
chars. If a future use case needs them, lift to a Postgres RPC
function (Phase 3+) for clean Postgres-side escaping.

This is documented inline in `segment-resolver.ts` and pinned by a
regression smoke (T12 in `tests/032-campaign-resolvers-smoke.ts`) so a
future maintainer who relaxes the validator trips the guard
immediately.

### Example: EZ Rentals — tomorrow's reminders

```json
{
  "version": 1,
  "filters": {
    "all": [
      { "field": "leads.outcome_booked", "op": "eq", "value": true },
      { "field": "leads.do_not_call", "op": "eq", "value": false }
    ]
  }
}
```

Pair with a `time_relative` schedule, 24h offset, anchor =
`appointments(status='confirmed')` to call every customer with a
confirmed booking 24h before their appointment.

### Example: dormant lead reactivation

```json
{
  "version": 1,
  "filters": {
    "all": [
      { "field": "leads.status", "op": "in", "value": ["new", "claimed"] },
      { "field": "leads.last_outbound_attempt_at", "op": "older_than", "value": "30d" },
      { "field": "leads.do_not_call", "op": "eq", "value": false }
    ]
  }
}
```

Pair with a `bulk` schedule for a one-shot reactivation push.

## 4. Schedule DSL

Two strategies (matches `outbound_campaigns.schedule_strategy` CHECK):

### `bulk`

```json
{
  "version": 1,
  "strategy": "bulk",
  "fire_at": "2026-06-20T14:00:00Z"
}
```

Every targeted lead's `scheduledFor` = `fire_at`. The schedule resolver
returns an error if `fire_at` is in the past — caller surfaces as a
warning, leads aren't scheduled.

### `time_relative`

```json
{
  "version": 1,
  "strategy": "time_relative",
  "anchor": {
    "table": "appointments",
    "field": "appointment_datetime",
    "lead_join": "lead_id",
    "filter": { "status": "confirmed" }
  },
  "offset_minutes": -1440
}
```

Each lead's `scheduledFor` = `appointment.appointment_datetime + offset_minutes`. Negative offset = "before"; `-1440` = 24h before.

**Anchor allowlist (Phase 2.3 pilot)**: `appointments` table only,
`appointment_datetime` field only, `lead_join` = `lead_id` only.
Future migrations can expand — the resolver validates against the
allowlist so an unknown anchor is rejected before any DB call.

**Anchor filter allowlist (Phase 2.3 pilot)**: `status` field only,
text type. Same growth path.

### Earliest-wins for multi-appointment leads

If a lead has two confirmed appointments, the resolver picks the
**earliest** (`ORDER BY appointment_datetime ASC` + first-wins
dedupe). Alternative one-call-per-appointment semantic would require
dropping `UNIQUE(campaign_id, lead_id)` on the junction — different
feature, Phase 3+ (see deferred items).

The earliest-wins behaviour is pinned by T13 in
`tests/032-campaign-resolvers-smoke.ts` as a regression guard.

### Past-time filtering

If a computed `scheduledFor` lands before `now` (default `new Date()`,
overridable for deterministic tests), the lead is **omitted** from the
result map. Past appointments can't be reminded. The expansion worker
sees the missing entry and writes the junction row with
`state='skipped'`, `skip_reason='no_matching_anchor'`.

## 5. State machine

`outbound_campaign_leads.state` is `CHECK`-constrained to the
following values (migration 032):

```
pending | scheduled | completed | skipped | opted_out
```

### Transition rules

```
            ┌──────────┐
   (UPSERT) │ pending  │  expansion worker just inserted; eligibility
            └────┬─────┘  not yet evaluated
                 │
        eligibility check
                 │
       ┌─────────┼─────────┐
       │                   │
       ▼                   ▼
 ┌───────────┐       ┌───────────┐
 │ scheduled │       │  skipped  │ + skip_reason
 └─────┬─────┘       └───────────┘ (terminal)
       │
       │ lead_call status webhook
       ▼
 ┌───────────┐
 │ completed │ (terminal)
 └───────────┘
```

- `pending` is transient. The worker holds it for the time between
  the UPSERT and the eligibility/placeCall step. Any junction row
  stuck in `pending` for >>5 minutes (one tick) indicates a worker
  crash mid-iteration.
- `scheduled` means there's a `lead_calls` row referenced by
  `scheduled_call_id`. The 1.5b fire-time worker is responsible for
  it from here on.
- `completed` covers the success and the failure cases (the
  distinction lives on `lead_calls.status`); the junction marks the
  row as no longer "in flight".
- `skipped` is terminal. Has a `skip_reason` indicating why. The
  worker doesn't retry; campaign re-activation would create a fresh
  campaign or a manual SQL reset is required.
- `opted_out` is **reserved** for a future per-campaign opt-out
  feature (Phase 3+). No code path currently writes it. The CHECK
  includes it for future-proofing.

### The R5 reorder

`expandOneCampaign` (in `cron.ts`) runs eligibility checks BEFORE the
junction UPSERT for **fresh leads** (not yet seen). This avoids a
chicken-and-egg with the `already_in_campaign` check, which is
specifically `state IN ('pending', 'scheduled')` — if we UPSERTed
first, every lead would short-circuit as already-in-campaign on
re-entry.

For the **pending-resume path** (worker crashed last tick, junction
row exists in `pending`), the eligibility check is **skipped** —
we've already done it, just resume the placeCall step. The smoke
033 T-cases pin this ordering.

## 6. Skip-reason vocabulary

`outbound_campaign_leads.skip_reason` is `TEXT` (no CHECK). Vocabulary
grows without DDL churn. Current values, with the layer that emits
them:

| Value                  | Emitted by                          | Meaning |
| ---------------------- | ----------------------------------- | ------- |
| `dnc`                  | `compliance.ts:checkCampaignEligibility` | Lead is on the Do-Not-Call list |
| `consent`              | `compliance.ts:checkCampaignEligibility` | Required voice-consent record missing |
| `calling_hours`        | `compliance.ts:checkCampaignEligibility` | `scheduledFor` falls outside tenant calling hours |
| `already_in_campaign`  | `compliance.ts:checkCampaignEligibility` | Junction row exists in `pending` / `scheduled` for this (campaign, lead) |
| `no_matching_anchor`   | `cron.ts:expandOneCampaign`         | `time_relative` schedule didn't resolve a `scheduledFor` (no matching appointment OR past) |
| `lead_phone_invalid`   | `cron.ts:expandOneCampaign`         | `leads.contact_phone` is NULL or unparseable |
| `non_nanp_phone`       | `cron.ts:expandOneCampaign`         | Phone is parseable but not in NANP range (Phase 2 is US/Canada-only) |
| `campaign_daily_cap`   | `cron.ts:expandOneCampaign`         | Per-campaign daily cap would be exceeded by this expansion |
| `placement_threw`      | `cron.ts:expandOneCampaign`         | `placeCall` raised; logged via Sentry; this is the catch-all |

The dashboard's `campaigns.skipReason.*` i18n namespace mirrors this
vocabulary. Adding a new value? Add the i18n key in
`i18n/{en,es,fr}.json` so the activity table + pareto chart render a
readable label.

The metrics endpoint's `skip_reasons` pareto returns the top 10 by
count (descending, alphabetical tiebreak for determinism). Values
beyond the top 10 fold into a long tail that the audit table can
still surface via filtering.

## 7. RPC inventory

All functions are `SECURITY INVOKER`. The api-server runs as
`service_role` so it has full access; the route handler gates tenant
ownership (`SELECT id FROM outbound_campaigns WHERE id=$1 AND
business_id=$2`) **before** invoking, so the function never needs to
handle tenant identity itself.

### `delete_campaign_with_cancellations(p_campaign_id UUID, p_business_id TEXT) → TABLE(canceled_call_count INT, deleted_junction_count INT)`

Migration **033** (Phase 2.6a). Atomic campaign delete:

1. `SELECT ... FOR UPDATE` row-locks the campaign row.
2. `UPDATE lead_calls SET status='canceled', end_reason='campaign_deleted', ended_at=NOW()` for every `scheduled_call_id` in the campaign's junction.
3. `COUNT(*)` junction rows about to cascade.
4. `DELETE FROM outbound_campaigns` — `ON DELETE CASCADE` wipes the junction.
5. Returns the two counts.

Empty result set if the campaign doesn't exist OR belongs to a
different tenant — caller maps to 404 (not 403; no existence leak).

### `campaign_metrics_time_series(p_campaign_id UUID) → TABLE(day DATE, state TEXT, count BIGINT)`

Migration **034** (Phase 2.7a). 30-day daily-by-state aggregation:

```sql
SELECT date_trunc('day', scheduled_for)::date AS day,
       state, COUNT(*) AS count
FROM outbound_campaign_leads
WHERE campaign_id = p_campaign_id
  AND scheduled_for IS NOT NULL
  AND scheduled_for > NOW() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1 ASC, 2 ASC;
```

Required because supabase-js's PostgREST builder can't express
`date_trunc`. NULL `scheduled_for` rows (pre-expansion `pending`
leads) are excluded — they count in totals but don't belong to any
calendar day.

### `trigger_set_updated_at()`

Migration **030** (Phase 2.2). Generic `BEFORE UPDATE` trigger that
sets `NEW.updated_at = NOW()`. Used by `appointments` and
`outbound_campaign_leads`.

## 8. Worker cadences + invariants

| Worker              | File                | Cadence | First-run delay | Concurrency control |
| ------------------- | ------------------- | ------- | --------------- | -------------------- |
| Campaign expansion  | `cron.ts`           | 5 min   | 60 s            | Per-campaign cooperative lock via `UPDATE expansion_running=true WHERE expansion_running=false RETURNING id` |
| Fire-time           | `cron.ts`           | 60 s    | 30 s            | Per-row state transition (`status='scheduled'` → `status='processing'`) |

### Invariants worth pinning

- **`daily_cap = 0` is a kill-switch, NOT "no cap".** A campaign with
  `daily_cap = 0` will never expand any leads — every lead skips with
  `campaign_daily_cap`. To remove the cap entirely, set
  `daily_cap = NULL`. This was a Phase 2.1 R6 decision; documented
  inline in `cron.ts` and pinned by smoke 033.
- **`appointment_datetime` is the canonical timestamp column** on
  `appointments`. Migration 030 added it via additive ALTER on a
  pre-existing table — older code paths referenced
  `appointment_datetime` correctly; never refactor to
  `appointment_at` or similar.
- **AI booking writes `status='confirmed'` at INSERT.** The
  `record_appointment` AI tool (Phase 2.2.5) defaults `status` to
  `confirmed` so the standard `time_relative` schedule's
  `filter: { status: "confirmed" }` matches without manual
  intervention.
- **Daily-cap counter is in-memory, per-day, per-campaign.** The
  Phase 2.1.1 fix-forward reordered the cap check AFTER idempotency
  so an idempotent re-submit doesn't double-count. Reset semantics
  are wall-clock-UTC midnight (Phase 3 issue to move to
  tenant-local — see deferred items).
- **Stuck-row recovery is deferred to Phase 3.** If the expansion
  worker crashes mid-tick, `outbound_campaigns.expansion_running`
  stays `TRUE` forever. Manual SQL reset:

  ```sql
  UPDATE outbound_campaigns
  SET expansion_running = false
  WHERE id = '<uuid>' AND expansion_running = true;
  ```

  Phase 3 will add a sweep at worker start that resets rows with
  `last_expansion_at < NOW() - INTERVAL '10 minutes'` AND
  `expansion_running = true`. See deferred items.

## 9. Cross-references

### Smoke tests

| Test                                                      | Phase  | Covers |
| --------------------------------------------------------- | ------ | ------ |
| `tests/026-place-call-smoke.ts`                           | 1.3+   | `placeCall` primitive — 29 cases |
| `tests/027-scheduled-call-worker-smoke.ts`                | 1.5b   | Fire-time worker — 11 cases |
| `tests/028-schedule-call-route-smoke.ts`                  | 1.7a   | POST /leads/:id/schedule-call — 8 cases |
| `tests/028b-business-configs-outbound-fields-smoke.ts`    | 1.7b   | Settings tab — 3 cases |
| `tests/031-record-appointment-route-smoke.ts`             | 2.2.5  | record_appointment AI tool — 12 cases |
| `tests/032-campaign-resolvers-smoke.ts`                   | 2.3    | Segment + schedule resolver — 13 cases |
| `tests/033-campaign-expansion-worker-smoke.ts`            | 2.4    | Expansion worker — 13 cases |
| `tests/034-campaigns-routes-smoke.ts`                     | 2.6a   | Campaigns CRUD + preview + leads — 10 cases |
| `tests/034-campaign-metrics-smoke.ts`                     | 2.7a   | Metrics endpoint — 5 cases |

(Two smokes share the `034-` prefix; the migration sequence and test
sequence are independent.)

### Routes

| Route                                                        | File                                |
| ------------------------------------------------------------ | ----------------------------------- |
| `GET /api/business/campaigns`                                | `routes/campaigns.ts`               |
| `GET /api/business/campaigns/:id`                            | `routes/campaigns.ts`               |
| `POST /api/business/campaigns`                               | `routes/campaigns.ts`               |
| `PATCH /api/business/campaigns/:id`                          | `routes/campaigns.ts`               |
| `DELETE /api/business/campaigns/:id`                         | `routes/campaigns.ts` (→ RPC 033)   |
| `POST /api/business/campaigns/preview`                       | `routes/campaigns.ts`               |
| `GET /api/business/campaigns/:id/leads`                      | `routes/campaigns.ts`               |
| `GET /api/business/campaigns/:id/metrics`                    | `routes/campaigns.ts` (→ RPC 034)   |
| `POST /api/twilio/outbound-voice/*` (AMD + TwiML + status)   | `routes/twilio-outbound-voice.ts`   |
| `POST /api/business/leads/:id/schedule-call`                 | `routes/lead-calls.ts`              |

### Libraries

| Path                                              | Purpose |
| ------------------------------------------------- | ------- |
| `lib/outbound-campaigns/segment-resolver.ts`      | JSON segment DSL parser + supabase-js query builder |
| `lib/outbound-campaigns/schedule-resolver.ts`     | JSON schedule DSL parser + per-lead `scheduledFor` resolver |
| `lib/outbound-voice/compliance.ts`                | `checkCampaignEligibility` (DNC + consent + calling_hours + already_in_campaign) |
| `lib/outbound-voice/place-call.ts`                | `placeCall` primitive (Phase 1.3) — direct + scheduled-defer + existingLeadCallId modes |
| `lib/outbound-voice/voicemail-text-resolver.ts`   | Per-call voicemail text resolution (per-campaign override → tenant default) |
| `cron.ts`                                         | Both workers (expansion + fire-time) |
