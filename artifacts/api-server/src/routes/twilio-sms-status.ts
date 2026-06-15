/**
 * Twilio SMS delivery-status webhook for Slice 3A pillar 2.
 *
 *   POST /api/twilio/sms-status
 *
 * Twilio's API for messages.create() is two-phase:
 *   Phase 1 — synchronous: returns 'queued' / 'sent' the moment Twilio
 *             accepts our payload. This is the status lib/sms-service.ts
 *             writes to sms_messages at send time.
 *   Phase 2 — asynchronous: Twilio POSTs every subsequent state
 *             transition to this endpoint (queued → sending → sent →
 *             delivered, OR queued → sent → undelivered, OR queued →
 *             failed). The actual carrier outcome arrives here, often
 *             minutes after the synchronous response.
 *
 * Without this handler, sms_messages.status stays at 'sent' even when
 * the carrier (A2P 10DLC enforcement, blocked-number lookup, message
 * filtering) ultimately undelivers. The LeadDetailPage failure-toast
 * (Slice 3A Commit B) scans for lead_activities rows with
 * action='sms_sent' AND metadata.status='failed' — without this
 * handler writing those rows on undelivered/failed, staff never sees
 * the warning. Confirmed in production 2026-06-15: test SID
 * SMa65f8160f2a12c7fd3b4851c424d1e33 → status=undelivered (error 30034)
 * in Twilio, status=sent in our DB. Two systems out of sync.
 *
 * Wiring: the statusCallback URL is set per-send in lib/sms-service.ts
 * (NOT per-number in Twilio Console — this is an API parameter
 * passed on each messages.create call). So no ops setup beyond the
 * existing inbound webhook URL.
 *
 * Audit posture: we INSERT a new lead_activities row on undelivered
 * /failed instead of UPDATING the existing 'sent' activity. The send
 * genuinely happened — we handed the bytes to Twilio and Twilio
 * accepted them — so erasing the original record would be revisionist.
 * The failure is a separate event in the timeline.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { verifyTwilioSignature } from "../lib/twilio-signature";

const router = Router();

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

// Statuses that should fire a failure activity row for staff visibility.
// 'failed' and 'undelivered' are both terminal-not-OK in Twilio's lifecycle.
const FAILURE_STATUSES = new Set(["failed", "undelivered"]);

router.post("/twilio/sms-status", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/xml; charset=utf-8");

  if (!verifyTwilioSignature(req)) {
    res.status(401).send(EMPTY_TWIML);
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    Sentry.captureMessage("twilio_sms_status_no_supabase", { level: "error" });
    res.status(200).send(EMPTY_TWIML);
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const messageSid = typeof body.MessageSid === "string" ? body.MessageSid : null;
  const messageStatus = typeof body.MessageStatus === "string" ? body.MessageStatus : null;
  const errorCode = typeof body.ErrorCode === "string" && body.ErrorCode.length > 0 ? body.ErrorCode : null;

  if (!messageSid || !messageStatus) {
    // Malformed callback — ack so Twilio doesn't retry, log breadcrumb.
    Sentry.addBreadcrumb({
      category: "twilio.sms-status",
      level: "warning",
      message: "missing_required_field",
      data: { hasMessageSid: !!messageSid, hasMessageStatus: !!messageStatus },
    });
    res.status(200).send(EMPTY_TWIML);
    return;
  }

  // Load the existing row so we can carry to_phone + template into the
  // failure-activity metadata (LeadDetailPage's toast reads to_phone for
  // the "we couldn't text {{phone}}" copy).
  const { data: smsRow } = await supabase
    .from("sms_messages")
    .select("id, lead_id, to_phone, template")
    .eq("twilio_sid", messageSid)
    .maybeSingle();

  if (!smsRow) {
    // Possible race: status callback arrives before our update from the
    // sync send-path landed. Ack so Twilio backs off; Sentry breadcrumb
    // so we can see the rate. Twilio retries failed status callbacks
    // automatically, so a subsequent attempt should find the row.
    Sentry.addBreadcrumb({
      category: "twilio.sms-status",
      level: "info",
      message: "no_sms_message_row_for_sid",
      data: { messageSid, messageStatus },
    });
    res.status(200).send(EMPTY_TWIML);
    return;
  }
  const row = smsRow as {
    id: string;
    lead_id: string | null;
    to_phone: string | null;
    template: string | null;
  };

  // Update the canonical row. status reflects carrier outcome going
  // forward; error_message holds Twilio's numeric ErrorCode (e.g. "30034")
  // when present.
  const { error: updErr } = await supabase
    .from("sms_messages")
    .update({
      status: messageStatus,
      error_message: errorCode,
      // delivered_at is a useful breadcrumb for analytics on terminal-OK.
      ...(messageStatus === "delivered" ? { delivered_at: new Date().toISOString() } : {}),
    })
    .eq("id", row.id);
  if (updErr) {
    Sentry.captureMessage("twilio_sms_status_update_failed", {
      level: "error",
      extra: { messageSid, messageStatus, error: updErr.message },
    });
  }

  // Emit a failure activity row on terminal-not-OK. We do NOT touch the
  // original 'sent' activity row — that was a genuine event (we shipped
  // bytes to Twilio successfully). The undelivered/failed is a SEPARATE
  // event in the timeline.
  if (FAILURE_STATUSES.has(messageStatus) && row.lead_id) {
    const { error: actErr } = await supabase.from("lead_activities").insert({
      lead_id: row.lead_id,
      actor_id: null,
      actor_type: "system",
      action: "sms_sent",
      metadata: {
        status: "failed",
        error_message: errorCode,
        to_phone: row.to_phone,
        twilio_sid: messageSid,
        template: row.template,
        carrier_status: messageStatus,
      },
    });
    if (actErr) {
      console.error("[twilio-sms-status] failure activity insert failed:", actErr.message);
      Sentry.captureMessage("twilio_sms_status_activity_insert_failed", {
        level: "error",
        extra: { messageSid, leadId: row.lead_id, error: actErr.message },
      });
    }
  }

  res.status(200).send(EMPTY_TWIML);
});

export default router;
