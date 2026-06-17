# Phase 3 issue triage

Closeout artifact from the Phase 2 session (commits `3d747ed` ↦
`c457d57`, June 2026). Deferred items captured here so they don't
decay into session memory.

**Filing target:** `abdulsene/voiceiq` GitHub issues.

The `gh` CLI is not installed on the Windows dev environment used to
write this triage, so issues were not auto-created. Paste each block
below into the GitHub web UI's "New issue" form. Labels listed at the
bottom of each block — create them once via the repo's label settings
or `gh label create` if you switch to a Linux host.

### Suggested labels

Create these once (any color is fine):

- `phase-3` — anything deferred from the Phase 2 closeout
- `security`
- `performance`
- `resilience`
- `reporting`
- `feature`
- `polish`
- `cleanup`
- `dx`
- `unrelated`
- `marketing`
- `pre-existing-bug`
- `optimization`

---

## SECURITY (HIGH)

### Rotate Twilio Auth Token (leaked across sessions)

**Body:**

The Twilio Auth Token `2fc6f46910200d05b266cbfe1d0874a6` leaked across
prior sessions and should be rotated. Use Twilio's "Promote
Secondary" pattern so there's no auth outage:

1. Twilio Console → Account → API keys & tokens → generate a new
   secondary auth token.
2. Update `TWILIO_AUTH_TOKEN` in Replit Secrets to the new token.
3. Redeploy the api-server.
4. Verify outbound calls + status webhooks still work end-to-end.
5. Promote the secondary to primary in Twilio Console.
6. Delete the old primary.

**Labels:** `security`, `phase-3`

---

### Rotate Supabase service_role key (leaked once)

**Body:**

The Supabase `service_role` key for project `zqhijauefcpwggklshoa`
was exposed in a prior session and should be rotated.

1. Supabase dashboard → Project Settings → API → click "Reset" on the
   `service_role` key.
2. Update `SUPABASE_SERVICE_KEY` in Replit Secrets.
3. Also update the Sentry environment if it references the key
   directly (it shouldn't, but check).
4. Redeploy the api-server.
5. Verify campaign endpoints + audit-log writes still work.

Note: `service_role` bypasses RLS entirely. Anyone with the leaked
key had full DB access for the leak window.

**Labels:** `security`, `phase-3`

---

## RESILIENCE (MEDIUM)

### Auto-recovery for stuck `expansion_running` rows

**Body:**

If the campaign expansion worker crashes mid-tick,
`outbound_campaigns.expansion_running` stays `TRUE` forever — the
campaign never expands again until manual SQL intervention. The
expansion-worker docs (`lib/outbound-campaigns/README.md` §8) show
the manual reset query.

Phase 3 should add an auto-sweep at worker start:

```sql
UPDATE outbound_campaigns
SET expansion_running = false
WHERE last_expansion_at < NOW() - INTERVAL '10 minutes'
  AND expansion_running = true;
```

Matches the policy Phase 1.5b's fire-time worker will adopt for its
`status='processing'` stuck rows when that lands.

Threshold (`10 minutes`) is generous — the cooperative lock only
gates concurrent expansions, so a stale lock just delays the next
tick, not data integrity.

**Labels:** `resilience`, `phase-3`

---

### Tenant-local cap day boundaries (currently UTC)

**Body:**

Per Phase 2.1 R5 TODO. The campaign `daily_cap` counter rolls over at
UTC midnight; tenants in PST experience cap reset at 4pm local. This
is surprising for an EZ Rentals-style operator who thinks of "daily"
in their own timezone.

Move to per-tenant timezone day boundaries:

- Read tenant timezone from `business_configs.timezone` (already
  populated for compliance calling-hours logic).
- Convert `now()` to tenant TZ, derive `YYYY-MM-DD` in that TZ.
- Cache key becomes `${campaign_id}:${tenantLocalDate}`.

Don't touch the cap counter scaffold; just swap the date-key
derivation in `cron.ts`.

**Labels:** `feature`, `phase-3`

---

## PERFORMANCE (MEDIUM, scale-trigger)

### Batch eligibility for campaign expansion (>1000 leads)

**Body:**

`expandOneCampaign` runs `checkCampaignEligibility` **per-lead
sequentially** — N async round-trips for N leads. At pilot scale
(1 campaign × ~200 leads) this is fine. When any tenant exceeds 1000
leads per campaign, latency becomes a problem.

Phase 3 should batch:

- One query each for the 4 eligibility checks
  (`dnc_list`, `voice_consent_records`, calling-hours config,
  `outbound_campaign_leads(state IN ('pending','scheduled'))`)
- Build per-lead `eligibility` map in memory
- Iterate leads at O(1) lookup instead of O(round-trip)

Documented inline in `cron.ts` near `checkCampaignEligibility` call
site so the next maintainer notices the pattern.

**Labels:** `performance`, `phase-3`

---

## FEATURE (MEDIUM)

### One-call-per-appointment semantic in `time_relative` campaigns

**Body:**

`outbound_campaign_leads` has `UNIQUE(campaign_id, lead_id)` — a lead
with N appointments gets one call (against the earliest, per the
schedule resolver's earliest-wins dedupe). Customers with multiple
weekly appointments will be confused: "why didn't my Wednesday
appointment get a reminder?"

Phase 3 design sketch:

- Drop `UNIQUE(campaign_id, lead_id)` constraint
- Add `appointment_id UUID NULL` column to `outbound_campaign_leads`
- Add **partial unique index**:
  ```sql
  CREATE UNIQUE INDEX ocl_one_per_appt
  ON outbound_campaign_leads (campaign_id, lead_id, appointment_id)
  WHERE appointment_id IS NOT NULL;
  ```
- Schedule resolver emits one row per matching appointment (not just
  the earliest)
- Bulk strategy still produces appointment_id = NULL → uniqueness
  collapses to (campaign, lead) for non-appointment campaigns

Tests: extend `032-campaign-resolvers-smoke.ts` T13 with a
multi-appointment fixture asserting N rows now (instead of 1).

**Labels:** `feature`, `phase-3`

---

### Cross-campaign reporting rollup dashboard

**Body:**

Phase 2.7 ships per-campaign metrics. Multi-campaign rollup ("how are
ALL my campaigns doing?") was deferred until two conditions hold:

1. At least one tenant runs 2+ campaigns in production.
2. Ops feedback clarifies which KPIs matter across campaigns
   (conversion vs ROI vs cost vs volume — different stakeholder
   asks).

Phase 3 design needs the ops feedback first. Premature design would
ship the wrong rollup.

Plumbing notes:

- Route shape: `GET /api/business/campaigns/metrics/rollup?since=...`
- Likely a new RPC (date_trunc grouping across campaigns).
- Dashboard route: `/campaigns/reporting` (sibling of
  `/campaigns/:id?tab=reporting`).

**Labels:** `reporting`, `phase-3`

---

## REPORTING / OBSERVABILITY (LOW)

### Cohort charts: scheduled hour, weekday

**Body:**

Cohort analysis for campaign timing optimization. E.g., "calls
scheduled 9am EST have 23% higher connect rate than 6pm EST" /
"Tuesday morning beats Friday afternoon."

Defer until ops asks **and** ≥30 days of real pilot data exist.
Without data, the chart axes are speculative; the right cohort
dimensions need to be picked from actual outcomes, not pre-imagined.

**Labels:** `reporting`, `phase-3`

---

### Connect-rate-over-time line chart

**Body:**

Trend line of daily connect rate over the campaign's lifetime. Useful
for spotting degradation (e.g., DNC list adoption gradually eroding
the connect rate).

Defer until ≥30 days of campaign data exist per tenant — a 5-point
line is meaningless visual noise.

When it lands: extends the Phase 2.7a `/metrics` endpoint with a
`connect_rate_time_series` array (daily rate + day key), rendered as
a recharts LineChart in `components/Reporting/`. The metrics
endpoint already computes the underlying counts; the rate
computation is in Node so adding it is purely additive.

**Labels:** `reporting`, `phase-3`

---

### `lead_call` status/duration columns in CSV export

**Body:**

Phase 2.7b's CSV export (`components/Reporting/CsvExportButton.tsx`)
contains junction-level fields only:

```
campaign_id, junction_id, lead_id, contact_name, contact_phone,
state, skip_reason, scheduled_for, scheduled_call_id,
created_at, updated_at
```

Phase 3 should extend with `lead_call.*` columns via a JOIN on
`outbound_campaign_leads.scheduled_call_id`:

- `lead_call_status` (completed / failed / voicemail / etc.)
- `lead_call_duration_seconds`
- `lead_call_voicemail_left` (boolean)
- `lead_call_end_reason`
- `lead_call_started_at`
- `lead_call_ended_at`

Requires extending the `GET /:id/leads` route to JOIN `lead_calls`
and pass the columns through. Optional `include_lead_call=true`
query param to keep the default response small.

**Labels:** `reporting`, `phase-3`

---

### Server-side CSV streaming (lift auth-header constraint)

**Body:**

Phase 2.7b uses client-side Blob + paginated fetch because
`window.location.href = '/api/.../leads.csv'` browser navigation
cannot carry the `Authorization: Bearer` header the backend requires
— see the Phase 2.7-A investigation in the session log.

Phase 3 alternative: short-lived signed download tokens appended as
a query param, validated server-side.

- Issue a JWT-style token tied to (user, business, campaign,
  resource='leads.csv', exp=+5min) via
  `POST /api/business/campaigns/:id/leads/exports/sign`.
- Browser then navigates to
  `/api/business/campaigns/:id/leads.csv?token=<...>` — header-free,
  validated by middleware that mirrors `requireAuth`.
- True streaming via `res.write` chunks for 10K+ row exports without
  the 2000-row Blob cap.

**Labels:** `optimization`, `phase-3`

---

## POLISH (MEDIUM)

### Native-speaker i18n review (ES + FR)

**Body:**

Phase 1.7b, Phase 2.6b, and Phase 2.7b shipped large new i18n
namespaces best-effort-translated by Claude:

- `leads.*` (Phase 1.7b)
- `voicemail.*` (Phase 1.7b)
- `campaigns.list.*`, `campaigns.detail.*`, `campaigns.builder.*`
  (Phase 2.6b)
- `campaigns.reporting.*` (Phase 2.7b)

A native ES + FR speaker should review and polish. Particular care
around:

- The segment DSL operator labels (`ops.older_than`, `ops.exists`)
- The schedule "before each lead's next confirmed appointment" copy
- Rate tooltip formulas (special characters: `÷`, `−`)

EN is authoritative; ES + FR are subject to change.

**Labels:** `polish`, `phase-3`

---

### QA audit overrides — pricing page mistakes

**Body:**

From a prior session: the pricing page claims feature support that
wasn't confirmed:

- HubSpot integration (Growth tier)
- Microsoft 365 / Outlook integration (Starter+)
- Salesforce via webhook (wording suggests native)
- EU data placement (Enterprise)

Audit each claim against the actual feature surface. If a claim
ships unverified and a customer signs up expecting it, that's a
refund risk + a reputation hit.

Output: either fix the marketing copy, ship the missing integrations,
or both.

**Labels:** `pre-existing-bug`, `phase-3`

---

## DX / CLEANUP (LOW)

### Windows dev environment unblock

**Body:**

`pnpm-workspace.yaml` intentionally excludes the
`lightningcss-win32-x64-msvc` and `@tailwindcss/oxide` Win32 binaries
(see the `>...: '-'` overrides). Vite build/dev fail on Windows for
the `voiceiq-dashboard` artifact because the native CSS engine can't
load.

This blocked Phase 2.6b and Phase 2.7b visual QA from the Windows
host — both shipped with QA deferred to Linux/Replit.

Two paths:

1. **Document** the Linux-first dev environment requirement in the
   root `CLAUDE.md` so contributors know up-front.
2. **Re-add** the Win32 binaries to the workspace overrides if the
   bundle-size / install-time cost is acceptable.

Either path closes the issue.

**Labels:** `dx`, `phase-3`

---

### Remove unused `chart.js` + `react-chartjs-2` deps

**Body:**

`voiceiq-dashboard/package.json` lists:

- `chart.js ^4.5.1`
- `react-chartjs-2 ^5.3.1`

Neither is imported anywhere in `src/`. `recharts ^2.15.2` is the
only chart library actually used (Analytics, Benchmarks, and the
Phase 2.7b Reporting tab).

Removing both should save ~250 KB from the production bundle.

```bash
pnpm --filter @neverr/dashboard remove chart.js react-chartjs-2
```

Run typecheck + build after to confirm no straggler imports.

**Labels:** `cleanup`, `phase-3`

---

## UNRELATED PILE

(Lifted off the deferred pile so it doesn't decay further.)

### WorkOS SAML SSO browser flow failure (Auth0 #02893098)

**Body:**

Open Auth0 support ticket #02893098. The browser-based SAML SSO flow
fails; the M2M flow works correctly. Tracker for resolution from
Auth0's side.

No action required from us until Auth0 responds; this issue exists so
the ticket doesn't get lost.

**Labels:** `unrelated`, `phase-3`

---

### Wave 3 Push 2 industry pages

**Body:**

Marketing site content pending for these verticals:

- Garage door repair
- Orthodontics
- Senior care placement
- Water / fire / mold restoration

Not engine work. Industry templates + landing pages.

**Labels:** `marketing`, `phase-3`

---

### Print-ready CMYK business card PDFs

**Body:**

Marketing collateral — print-ready CMYK PDFs for business cards.
Pending design + handoff to print vendor.

**Labels:** `marketing`, `phase-3`

---

### Blog infrastructure + Soro.ai SEO content tool ($39/mo)

**Body:**

Two related items:

1. Blog infrastructure deployment (route, listing page, post layout)
   — required before any SEO content can ship.
2. Soro.ai integration ($39/mo SEO content tool) — pending the blog
   build.

Marketing dev, not engine work.

**Labels:** `marketing`, `phase-3`
