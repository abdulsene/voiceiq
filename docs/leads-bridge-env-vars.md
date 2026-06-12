# Leads Slice 2A — Required Environment Variables

The verified-callback / lead-bridge flow introduces three new env-var
dependencies on top of what the api-server already requires. This is a
deploy-time checklist for the Replit Secrets configuration.

## New for Slice 2A

| Variable | Required at boot? | Used by | If missing |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | At first transcription | `lib/transcription.ts` | **Throws** when `transcribeRecording()` is called. Fire-and-forget Promise rejection → Sentry breadcrumb. `lead_calls.transcription_status` flips from `pending` to `failed`. |
| `PUBLIC_API_URL` | Lazy (first webhook) | `lib/twilio-signature.ts`, `routes/lead-calls.ts`, `routes/twilio-callbacks.ts` | **Sentry warning ONCE** (`public_api_url_env_missing_falling_back`), uses hardcoded `https://voice-i-q.replit.app`. Signature verification still works as long as Twilio also calls that hostname. |
| `TWILIO_AUTH_TOKEN` | Already required for SMS / provisioning | `lib/twilio-signature.ts` for webhook verification | `verifyTwilioSignature()` returns `false` → all Twilio webhooks 401. Already a hard ops requirement. |
| `TWILIO_ACCOUNT_SID` | Already required | `lib/transcription.ts` injects basic-auth into the Twilio recording URL Deepgram fetches | If missing, `transcribeRecording` throws. Already required for SMS / coaching. |

## Reused from earlier slices

| Variable | First introduced | Usage in 2A |
|---|---|---|
| `ANTHROPIC_API_KEY` | Already required (existing call analysis) | `lib/call-summary.ts` for the post-transcription 2-3 sentence summary. |
| `ELEVENLABS_API_KEY` | Already required (existing voice agent) | `lib/disclosure-tts.ts` synthesizes the recording-disclosure audio via the shared `synthesizeSpeech` helper. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Already required (every other route) | DB writes/reads for `lead_calls` + `user_businesses.callback_ring_number`. |

## Optional knobs

| Variable | Default | Purpose |
|---|---|---|
| `TWILIO_WEBHOOK_VERIFY` | unset (verification enabled) | Set to `0` for local smoke tests to bypass `verifyTwilioSignature`. **Never set in production.** Triggers a Sentry breadcrumb on every webhook so an accidental production deploy lights up. |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` (Rachel) | Used by the disclosure TTS. Customer brand consistency is best-served by leaving the default unless the customer's inbound agent uses a different voice. |

## Verification commands

After setting `DEEPGRAM_API_KEY`, confirm it works:

```bash
curl -sL -H "Authorization: Token $DEEPGRAM_API_KEY" \
  "https://api.deepgram.com/v1/projects" | head -c 200
# Expect a JSON response with project metadata.
```

After setting `PUBLIC_API_URL`, confirm Twilio signature verification is
ready by manually POSTing a signed test webhook (see
`src/tests/018-leads-callback-bridge-smoke.ts` for the signature
algorithm).

## What's NOT in Slice 2A's scope

These are flagged for future slices but DOCUMENTED here so on-call
doesn't get surprised:

- **`outbound_caller_id_verified_at`** column on `business_configs` —
  Slice 2B. Until then we optimistically use the business main line and
  catch Twilio error 21217 to fall back to the Neverr line.
- **Existing Twilio webhook signature retrofit** — `/api/twilio/inbound`,
  `/api/twilio/*` status endpoints, `/api/stripe/webhook` are STILL
  URL-obscured. Slice 2A introduces signature validation only for the
  three NEW webhooks. Hygiene commit queued out-of-band.
- **Supabase Storage for disclosure audio** — Slice 2A uses in-process
  cache. Persistence + multi-replica will need Storage; same
  cache key shape (`{business_id}-{leg}`) makes the migration drop-in.
