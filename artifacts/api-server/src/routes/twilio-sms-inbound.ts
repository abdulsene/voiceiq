/**
 * Twilio inbound SMS webhook for Slice 3A pillar 2.
 *
 *   POST /api/twilio/sms-inbound
 *
 * Handles STOP / START / HELP per CTIA + TCPA requirements:
 *   STOP        → record opt-out for (business, from_phone), respond
 *                 with an unsubscribe confirmation TwiML, never
 *                 message that number again from this tenant.
 *   START       → flip the active opt-out's resubscribed_at, confirm.
 *   HELP        → respond with a short support pointer (no opt-out
 *                 mutation).
 *   anything    → log as inbound to sms_messages with direction='inbound'
 *   else          AND no auto-reply (Slice 3A scope). Operator can
 *                 read the body off the staff timeline.
 *
 * Tenant resolution: Twilio's inbound webhook gives us the `To` (the
 * tenant's twilio_phone_number) and `From` (the customer). We look up
 * the tenant via business_configs.twilio_phone_number = To. If no
 * tenant matches (e.g. the legacy single-number Neverr master), we
 * skip persistence + still 200 with empty TwiML so Twilio doesn't
 * retry — but log to Sentry so we notice.
 *
 * Signature verification uses the same X-Twilio-Signature path as the
 * Slice 2A webhooks (lib/twilio-signature.ts). Set
 * TWILIO_WEBHOOK_VERIFY=0 locally to bypass for smoke tests.
 *
 * Slice scope: STOP / START / HELP only. Inbound conversation
 * routing, AI replies, and lead linkage are explicit follow-ups.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { recordOptOut, recordResubscribe } from "../lib/sms-service";
import { verifyTwilioSignature } from "../lib/twilio-signature";

const router = Router();

const STOP_RE = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const START_RE = /^\s*(start|unstop|yes)\s*$/i;
const HELP_RE = /^\s*help\s*$/i;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  } as Record<string, string>)[ch] ?? ch);
}

function twiml(message: string | null): string {
  if (!message) return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response/>";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`;
}

router.post("/twilio/sms-inbound", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/xml; charset=utf-8");

  if (!verifyTwilioSignature(req)) {
    res.status(401).send(twiml(null));
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const from = typeof body.From === "string" ? body.From : "";
  const to = typeof body.To === "string" ? body.To : "";
  const messageBody = typeof body.Body === "string" ? body.Body : "";
  const twilioSid = typeof body.MessageSid === "string" ? body.MessageSid : null;

  if (!from || !to) {
    res.status(200).send(twiml(null));
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    Sentry.captureMessage("twilio_sms_inbound_no_supabase", {
      level: "error",
      extra: { from, to },
    });
    res.status(200).send(twiml(null));
    return;
  }

  // Resolve tenant by the To number.
  const { data: bizRaw } = await supabase
    .from("business_configs")
    .select("business_id, business_name")
    .eq("twilio_phone_number", to)
    .maybeSingle();

  const businessId = (bizRaw as { business_id?: string } | null)?.business_id;
  const businessName = (bizRaw as { business_name?: string } | null)?.business_name ?? null;

  if (!businessId) {
    Sentry.addBreadcrumb({
      category: "twilio.sms",
      level: "warning",
      message: "inbound_sms_unmatched_tenant",
      data: { from, to },
    });
    res.status(200).send(twiml(null));
    return;
  }

  // Always log inbound — even unknown text — so the staff timeline
  // has the full conversation.
  const { error: persistErr } = await supabase.from("sms_messages").insert({
    business_id: businessId,
    lead_id: null,
    direction: "inbound",
    to_phone: to,
    from_phone: from,
    body: messageBody,
    twilio_sid: twilioSid,
    status: "delivered",
  });
  if (persistErr) {
    console.error("[twilio-sms] inbound persist failed:", persistErr.message);
  }

  // Branch on intent.
  if (STOP_RE.test(messageBody)) {
    await recordOptOut({ supabase, businessId, phone: from, reason: "stop_reply" });
    const bizLabel = businessName || "this business";
    res.status(200).send(
      twiml(
        `You've been unsubscribed from ${bizLabel} SMS notifications. Reply START to resubscribe.`,
      ),
    );
    return;
  }
  if (START_RE.test(messageBody)) {
    await recordResubscribe({ supabase, businessId, phone: from });
    const bizLabel = businessName || "this business";
    res.status(200).send(
      twiml(`You're resubscribed to ${bizLabel} SMS notifications. Reply STOP at any time to opt out.`),
    );
    return;
  }
  if (HELP_RE.test(messageBody)) {
    const bizLabel = businessName || "this business";
    res.status(200).send(
      twiml(
        `${bizLabel} SMS support: reply STOP to unsubscribe. Msg & data rates may apply.`,
      ),
    );
    return;
  }

  // Non-keyword inbound: persisted above, no auto-reply.
  res.status(200).send(twiml(null));
});

export default router;
