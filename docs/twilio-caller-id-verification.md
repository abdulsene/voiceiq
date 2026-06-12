# Twilio Outbound Caller ID Verification

When a staff member clicks **Call customer** on a lead, the lead-bridge
flow needs a phone number to put on the customer's caller-ID display.
By default we use the customer's own business line (the number stored in
`business_configs.phone_number`) so the customer sees a branded incoming
call — not "+1 443-…" from a Neverr-provisioned Twilio number that looks
like spam.

Twilio only allows you to use a number as the **From** on an outbound
call if it's either:

1. A Twilio-owned number on the calling account, OR
2. A **verified** outbound caller ID resource on the account.

Most customers' business lines are NOT Twilio-owned — they're a landline
or VoIP from their carrier. That means we have to verify the number with
Twilio once, per account, before we can use it as the From.

## How it works

Twilio's verification flow:

1. We POST the customer's business number to
   `https://api.twilio.com/2010-04-01/Accounts/{SubAccountSid}/OutgoingCallerIds.json`
   with body `PhoneNumber={E.164}`.
2. Twilio places a **verification call** to that number. The person who
   answers hears a 6-digit code (also returned in the API response as
   `ValidationCode`) and is asked to enter it on the keypad.
3. On success, the number becomes a permanent `OutgoingCallerId` resource
   on the sub-account. Outbound calls can now use it as `From`.

Verification is **permanent** unless the resource is explicitly deleted.

## Slice 2A behavior (today)

We do NOT have a customer-facing verification UI yet. Instead the bridge
flow is **optimistic + fall-through**:

1. `resolveOutboundCallerId(businessId)` returns the business's main line
   from `business_configs.phone_number` if it's E.164-shaped.
2. The Twilio `client.calls.create` request uses it as `From`.
3. If the number isn't verified, Twilio responds with error code
   **21217** ("Phone number not verified"). Our route catches this
   specific code and **retries** the call with the Neverr-provisioned
   Twilio number from `business_configs.twilio_phone_number` as the
   From. A Sentry breadcrumb (`outbound_caller_id_not_verified_falling_back`)
   captures the fallback rate so we can see how often it fires.

The call still goes through — the customer just sees an unbranded
"+1 …" caller ID instead of the business's own number.

## Future slice — verification UI

A near-term slice will add:

- A new column `business_configs.outbound_caller_id_verified_at TIMESTAMPTZ`
  so we don't re-try the optimistic path forever for businesses we know
  haven't verified.
- A Settings UI that:
  1. Prompts the customer to verify their main line.
  2. POSTs to `OutgoingCallerIds.json` and displays the 6-digit code.
  3. Polls for verification status; on success, marks
     `outbound_caller_id_verified_at = now()`.

Until that lands, ops can run the verification manually from the Twilio
Console (Voice → Verified Caller IDs) for a customer who specifically
asks for branded caller ID.

## Implementation references

- Caller-ID resolver: `artifacts/api-server/src/lib/twilio-caller-id.ts`
- 21217 catch + fallback: `artifacts/api-server/src/routes/lead-calls.ts`
  → `handleInitiateCall`
- Twilio API ref: `https://www.twilio.com/docs/voice/api/outgoing-caller-ids`
