# Leads Capture Flow — `request_callback` wiring end-to-end

This doc traces the path of a captured lead from the moment the AI
decides to invoke `request_callback` during a live call to the row that
appears in the customer's `/leads` UI. It also lists the failure modes
and the acceptance criteria for an agent to be considered
"leads-capable."

The original Slice 1 of the leads epic was non-functional in production
because two of the wires below were broken (registration only ran on
Transfer-tab saves; rendered system prompt named a tool that didn't
exist). This doc exists so the next person who edits
`prompt-renderer.ts` doesn't ship a Slice 1.5 with the same gap.

## Pipeline overview

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Tool spec defined                                            │
│    artifacts/api-server/src/agents.ts                           │
│      buildRequestCallbackTool() — webhook tool, baked business_id│
│      Bearer ELEVENLABS_TOOL_SECRET in Authorization             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Registration on the agent                                    │
│    agents.ts updateAgentTools(supabase, businessId)             │
│      GETs the agent, replaces our managed tools, PATCHes back   │
│      Called from:                                               │
│        - routes/api.ts:1857     (onboard signup)                │
│        - routes/auth.ts:673     (signup-from-pricing)           │
│        - routes/transfer.ts:247 (Transfer-tab save)             │
│        - routes/prompt.ts performSaveAndSync (every prompt edit)│
│      NOT called from preview/sales demos — they write to        │
│      preview_demos, not business_configs, so updateAgentTools   │
│      would no-op with business_not_found.                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. System prompt tells the AI when to invoke                    │
│    artifacts/api-server/src/lib/prompt-renderer.ts              │
│      CAPTURING CALLBACK REQUESTS section — names                │
│      request_callback by name, lists trigger conditions and the │
│      five caller-facing confirmation items (contact_name,       │
│      contact_phone, reason, urgency, preferred_channel).        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ during the call
┌─────────────────────────────────────────────────────────────────┐
│ 4. AI invokes the tool                                          │
│    ElevenLabs sends:                                            │
│      POST https://voice-i-q.replit.app/api/leads/capture        │
│      Authorization: Bearer <ELEVENLABS_TOOL_SECRET>             │
│      Body: { business_id (baked), conversation_id, contact_name,│
│              contact_phone, contact_email?, reason, urgency,    │
│              preferred_channel }                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Capture endpoint                                             │
│    routes/leads.ts POST /api/leads/capture                      │
│      Auths the bearer against process.env.ELEVENLABS_TOOL_SECRET│
│      Inserts a row into leads + lead_activities                 │
│      Returns 200 to ElevenLabs so the AI closes the loop verbally│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Visibility                                                   │
│    leads table → GET /api/business/leads → /leads UI            │
│    LeadsListPage fetches all-tab counts on mount and picks the  │
│    smart-default tab (My open → Unassigned → All) so a newly    │
│    captured lead is never invisible behind the wrong tab.       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. Slice 2A bridge (optional follow-up)                         │
│    Staff clicks "Call customer" on the lead → Twilio dial-out → │
│    dual-channel recording → Deepgram transcript → Claude Haiku  │
│    summary → all logged in lead_activities.                     │
│    See artifacts/api-server/src/routes/lead-calls.ts.           │
└─────────────────────────────────────────────────────────────────┘
```

## Failure modes

### (a) `ELEVENLABS_TOOL_SECRET` is missing in the api-server env
- `updateAgentTools` returns `{ success: false, error: 'tool_secret_missing' }`
  and does NOT issue a PATCH. Sentry exception fires.
- Signup/onboard/prompt-save routes log the error and continue (they
  don't roll back the agent), but the agent will not have
  `request_callback` registered until the secret is set and the route
  is retriggered.
- Fix: set `ELEVENLABS_TOOL_SECRET` in Replit Secrets on the api-server
  workflow, restart, then run
  `src/scripts/backfill-agent-prompts.ts --dry-run` to confirm what
  needs re-syncing.

### (b) ElevenLabs PATCH fails during registration
- 4xx: returned as `agent_patch_http_XXX`; Sentry captured. The agent
  state stays in whatever the previous PATCH set. Re-run
  `src/scripts/resync-agent-prompt.ts <business_id>` after fixing
  whatever caused the 4xx (usually a stale agent_id).
- 5xx / 429: same return shape, no automatic retry inside
  `updateAgentTools`. The signup-flow retry path is: customer touches
  any settings → `performSaveAndSync` runs → `updateAgentTools` retries.
- Hot fix: `resync-agent-prompt.ts` is idempotent — run it as many
  times as needed.

### (c) Tool returns non-200 mid-call
- Capture endpoint returns 401: bearer didn't match → AI hears
  "summarized" error and follows the prompt's instruction to take the
  info verbally. Caller experience degrades but call doesn't drop.
- Capture endpoint returns 5xx: same as 401 (summarized error). The
  call still completes. Lead is NOT in the DB — ops can search
  audit_logs / Sentry for the conversation_id and capture manually.
- Validation failure (missing required field): the tool's
  `request_body_schema` enforces these client-side at ElevenLabs, so
  this should only happen if the LLM hallucinates. Returns 400 →
  summarized error → AI retries or escalates verbally.

### (d) ElevenLabs rate-limits during signup
- `createAgentForBusiness` is the typical hot path; 429 there means
  the agent doesn't get created and the customer sees a non-fatal
  "agent creation failed" message in the signup response.
- `updateAgentTools` 429: handled in the backfill script with one 5s
  retry. The signup-flow path doesn't retry — the customer can
  re-trigger by touching any settings.
- Mitigation: ElevenLabs has not historically rate-limited us during
  signup volumes. If it starts, add jitter + retry in
  `updateAgentTools` (3 attempts with exponential backoff).

## Acceptance criteria — "leads-capable" agent

An agent for a business is considered leads-capable when ALL of the
following are true:

1. **Tool registered.** `GET /v1/convai/agents/<agent_id>` returns
   `conversation_config.agent.prompt.tools[]` containing an entry whose
   `name === 'request_callback'`.
2. **Prompt names the tool.** The agent's system_prompt contains the
   string `request_callback`. Mention of `save_lead` MUST be absent —
   that was the Slice 1 phantom-tool bug.
3. **Capture endpoint reachable.** A signed POST to
   `https://voice-i-q.replit.app/api/leads/capture` (with the bearer
   secret and a valid body) returns 200 and inserts a row into
   `leads` for the target `business_id`.
4. **End-to-end check.** A test call to the business's Twilio number
   in which the caller explicitly asks for a callback produces a row
   in `/leads` within seconds.

The fastest way to validate (1) and (2) for a specific business:

```bash
curl -s -H "xi-api-key: $ELEVENLABS_API_KEY" \
  https://api.elevenlabs.io/v1/convai/agents/<agent_id> \
| python3 -c "import json,sys; d=json.load(sys.stdin); t=d.get('conversation_config',{}).get('agent',{}).get('prompt',{}); \
print('tools:', [x.get('name') for x in (t.get('tools') or [])]); \
print('mentions_request_callback:', 'request_callback' in (t.get('prompt') or '')); \
print('mentions_save_lead:', 'save_lead' in (t.get('prompt') or ''))"
```

Expected output:
```
tools: ['request_callback', 'transfer_to_number']   # or just ['request_callback']
mentions_request_callback: True
mentions_save_lead: False
```

## Repair scripts

- **Single business resync** —
  `pnpm --filter @workspace/api-server exec tsx src/scripts/resync-agent-prompt.ts <business_id>`
- **Fleet backfill (dry-run)** —
  `pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-agent-prompts.ts --dry-run`
- **Fleet backfill (live)** —
  `pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-agent-prompts.ts`

Both depend on migration
`artifacts/api-server/migrations/023_extend_prompt_audit_log_source.sql`
being applied first (extends `prompt_audit_log.source` CHECK to include
`leads_capture_repair` and `leads_capture_backfill`).

## Guardrails for future changes

If you're editing `prompt-renderer.ts`, the only tool name that should
appear by string match in the rendered output is `request_callback`.
The renderer used to reference `save_lead` and `check_availability` —
those were phantoms. If you add a new tool to the agent (e.g. a real
`check_availability` someday), update **both**:

1. The agent registration path in `agents.ts` so the tool is actually
   wired into `prompt.tools[]`.
2. The system prompt in `prompt-renderer.ts` so the LLM knows when to
   call it.

Either alone is the failure that took out Slice 1.

A smoke test (`src/tests/019-leads-capture-tools-smoke.ts`) locks in
the request_callback wiring against the signup chain — extend that
test (don't replace it) when you add new tools.

## Slice 3A — SMS pipeline operations

Slice 3A activates outbound SMS at three points in the lead lifecycle
(POST `/api/leads/capture` → `lead_captured`; lead-bridge initiate →
`callback_starting`; outcome capture `resolved` / `booked` →
`callback_resolved`) and consumes inbound STOP / START / HELP via
`routes/twilio-sms-inbound.ts`.

### Required environment (Replit Secrets)

| Variable | Used by | If missing |
|---|---|---|
| `TRUST_PORTAL_SIGNING_SECRET` | `lib/trust-portal-token.ts` | All 3 SMS sends skip token mint; the `lead_captured` / `callback_resolved` interpolations log to Sentry and the SMS still ships **without** a `portal_url` block. Set to ≥32 chars: `openssl rand -hex 32`. |
| `TWILIO_PHONE_NUMBER` (master) | `lib/sms-service.ts` fallback | Sends from per-tenant `business_configs.twilio_phone_number` when set; falls back to this with a Sentry warning. |
| `PUBLIC_API_URL` | `lib/sms-templates.ts:portalUrlFromToken` | Falls back to the canonical Replit host. |

### Twilio Console: inbound webhook URL (per-tenant)

Each tenant's `business_configs.twilio_phone_number` must have its
inbound-SMS webhook pointed at the api-server so STOP / START / HELP
are processed. There is no provisioning script — set this manually on
provisioning OR document for the customer:

1. Twilio Console → Phone Numbers → Manage → Active numbers
2. Click the tenant's number
3. Under **Messaging Configuration → A MESSAGE COMES IN**:
   - Webhook: `https://voice-i-q.replit.app/api/twilio/sms-inbound`
   - HTTP method: `POST`
4. Save.

Without this, STOP replies hit Twilio's default behavior (suppress
future messages from the same number tenant-side, but our
`sms_opt_outs` table stays empty → our pre-send opt-out check still
allows sends → Twilio rejects them with error 21610 and customer
hears nothing). The route at `/api/twilio/sms-inbound` writes the
opt-out and returns a TwiML confirmation per CTIA requirements.

### Failure modes for SMS sends

The 3 integration sites all fire-and-forget — SMS failure must not
break lead capture, bridge initiation, or outcome saves. Failures
land in two places:

1. `sms_messages.status = 'failed'` with `error_message`
2. `lead_activities` row with `action='sms_sent'` AND
   `metadata.status='failed'` — picked up by LeadDetailPage's
   `smsFailureToast` so staff sees the warning inline.

The `opted_out` short-circuit is its own status value — Twilio is
never called, `sms_messages.status='opted_out'`, and no activity row
is written (staff seeing "we suppressed an SMS the customer asked
not to receive" would be noise).

### Twilio delivery-status callback — closes the async loop

Twilio's `messages.create()` API is two-phase. The synchronous
response we get at call time is just "queued" / "sent" — Twilio
accepted the bytes. The real carrier outcome (delivered /
undelivered / failed) lands asynchronously when carrier filters /
A2P 10DLC enforcement / blocked-number lookups complete, typically
seconds to minutes later.

Without the second phase wired up, `sms_messages.status` stayed
stuck at 'sent' even when the carrier ultimately rejected. Confirmed
in production 2026-06-15: test SID `SMa65f8160f2a12c7fd3b4851c424d1e33`
returned status `undelivered` (error 30034 — A2P 10DLC compliance)
in the Twilio Console while our DB still showed `sent`.

**Handler URL:** `https://voice-i-q.replit.app/api/twilio/sms-status`

**Configuration:** API-driven. `lib/sms-service.ts` passes
`statusCallback` as a parameter on every `messages.create()` call —
**NOT** a per-number Twilio Console config. So no additional ops
setup beyond the existing inbound-webhook URL config in
[Twilio Console: inbound webhook URL](#twilio-console-inbound-webhook-url-per-tenant).
A single deploy of this handler covers all future sends.

**What it does on receipt:**

1. Verifies `X-Twilio-Signature` (same handler chain as other webhooks).
2. Reads `MessageSid`, `MessageStatus`, optional `ErrorCode`.
3. `UPDATE sms_messages SET status = MessageStatus, error_message = ErrorCode WHERE twilio_sid = MessageSid`. Adds `delivered_at` when the new status is `delivered`.
4. If `MessageStatus IN ('failed', 'undelivered')`: INSERT a NEW
   `lead_activities` row (`action='sms_sent'`,
   `metadata.status='failed'`, `metadata.to_phone`,
   `metadata.template`, `metadata.error_message`,
   `metadata.carrier_status`). The original `sent` activity row stays
   intact — the send genuinely happened; the failure is a separate
   event in the timeline.

`sms_messages.status` is now the source of truth for carrier
delivery, not just Twilio's synchronous API response. The
LeadDetailPage failure-toast (Commit B) activates when the new
activity row lands.
