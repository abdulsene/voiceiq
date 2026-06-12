/**
 * Twilio-facing webhooks for the lead-bridge flow. PUBLIC (bypass-listed
 * in app.ts AUTH_BYPASS_PATTERNS). X-Twilio-Signature is the credential.
 *
 *   POST /api/twilio/voice/lead-bridge?lead_call_id=...
 *     The TwiML endpoint Twilio hits after dialing the staff. Responds
 *     with TwiML that plays the staff disclosure, then <Dial>s the
 *     customer with the customer disclosure played via <Play> on the
 *     connecting leg.
 *
 *   POST /api/twilio/recording-status
 *     Twilio's recording-completion callback. Updates lead_calls with
 *     recording_url + recording_duration_secs, kicks off fire-and-
 *     forget Deepgram + Claude (transcription_status starts at
 *     'pending', flips to 'completed' or 'failed' when the async work
 *     lands), inserts the call_completed activity timeline row.
 *
 *   POST /api/twilio/call-status?lead_call_id=...
 *     Twilio's voice-call status webhook (initiated|ringing|answered|
 *     completed). Updates lead_calls.status + customer_answered +
 *     end_reason. On 'completed' without a recording (rare — busy /
 *     no-answer), inserts the call_failed activity row so the
 *     timeline reflects the attempt.
 *
 *   GET /api/business/disclosure-audio/:businessId/:leg
 *     PUBLIC. No Twilio signature (Twilio fetches this via <Play>
 *     without signing it). Returns the cached MP3 disclosure for the
 *     business + leg. business_id collision risk is mitigated by
 *     fetching the business_name fresh per request so an attacker
 *     hitting random IDs just generates a noisy 404; rate-limited via
 *     the global generalLimiter.
 *
 * fire-and-forget pattern: per Checkpoint 1, the recording-status
 * handler responds 200 to Twilio immediately after writing the
 * recording metadata. Deepgram + Claude run in a Promise that updates
 * the DB row when ready. If the Promise rejects, Sentry.captureException
 * fires; the row stays at transcription_status='pending' so the
 * future retry-job slice can sweep it via the partial index.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { verifyTwilioSignature } from "../lib/twilio-signature";
import { transcribeRecording } from "../lib/transcription";
import { summarizeCallTranscript } from "../lib/call-summary";
import { getOrGenerateDisclosure, type DisclosureLeg } from "../lib/disclosure-tts";

const router = Router();

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function publicBase(): string {
  return (process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app").replace(/\/+$/, "");
}

/**
 * Escape XML special chars so a business name with an ampersand
 * doesn't break the TwiML response.
 */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// ── POST /api/twilio/voice/lead-bridge ─────────────────────────────────
//
// Twilio calls this URL after dialing the staff's ring number. We respond
// with TwiML that:
//   1. <Play> the pre-rendered staff disclosure ("Recording for quality
//      and training. Connecting you to your customer.")
//   2. <Dial> the customer with answerOnBridge so the customer's leg
//      isn't connected until the bridge is ready. The customer hears
//      the disclosure via a nested <Play> before being bridged.
//
// `answerOnBridge="true"` on Dial holds the staff leg open (no media)
// until the customer answers — staff doesn't hear silence, they hear
// the ringing.

router.post("/twilio/voice/lead-bridge", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(401).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>We hit an internal error. Please try again later.</Say><Hangup/></Response>');
    return;
  }
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;
  if (!leadCallId) {
    res.status(400).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    return;
  }

  try {
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, customer_phone, from_caller_id, lead_id")
      .eq("id", leadCallId)
      .maybeSingle();
    const row = callRow as { id: string; customer_phone: string; from_caller_id: string | null; lead_id: string } | null;
    if (!row) {
      res.status(404).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Call not found.</Say><Hangup/></Response>');
      return;
    }

    // Look up business_id via the lead. We need it for the disclosure
    // audio URLs (business-scoped customer disclosure).
    const { data: lead } = await supabase
      .from("leads")
      .select("business_id")
      .eq("id", row.lead_id)
      .maybeSingle();
    const businessId = (lead as { business_id?: string } | null)?.business_id;
    if (!businessId) {
      res.status(404).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
      return;
    }

    const recordingStatusUrl = `${publicBase()}/api/twilio/recording-status`;
    const staffDisclosureUrl = `${publicBase()}/api/business/disclosure-audio/${encodeURIComponent(businessId)}/staff`;
    const customerDisclosureUrl = `${publicBase()}/api/business/disclosure-audio/${encodeURIComponent(businessId)}/customer`;

    // Mark the call in_progress so the dashboard polling reflects the
    // bridge phase before the bridge actually connects.
    await supabase.from("lead_calls").update({ status: "in_progress" }).eq("id", leadCallId);

    const callerId = row.from_caller_id || "";
    const customerPhone = row.customer_phone;
    // The customer disclosure is played via Dial's nested <Play> verb so
    // it fires AFTER the customer's leg answers but before the bridge
    // joins. Combined with answerOnBridge=true, the staff hears Twilio's
    // ringing tone during the customer's pre-bridge phase.
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(staffDisclosureUrl)}</Play>
  <Dial answerOnBridge="true" callerId="${xmlEscape(callerId)}" record="record-from-ringing-dual" recordingStatusCallback="${xmlEscape(recordingStatusUrl)}" recordingStatusCallbackEvent="completed" recordingStatusCallbackMethod="POST">
    <Number url="${xmlEscape(customerDisclosureUrl)}">${xmlEscape(customerPhone)}</Number>
  </Dial>
</Response>`;
    res.type("text/xml").send(twiml);
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "/api/twilio/voice/lead-bridge", leadCallId } });
    res.status(500).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>An internal error occurred.</Say><Hangup/></Response>');
  }
});

// ── POST /api/twilio/recording-status ──────────────────────────────────

router.post("/twilio/recording-status", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database not configured" });
    return;
  }

  // Twilio's recording webhook payload comes as form-encoded data.
  const body = req.body || {};
  const recordingSid = String(body.RecordingSid || "");
  const recordingUrl = String(body.RecordingUrl || "");
  const recordingStatus = String(body.RecordingStatus || "");
  const recordingDurationSecs = parseInt(String(body.RecordingDuration || "0"), 10) || null;
  const recordingChannels = parseInt(String(body.RecordingChannels || "0"), 10) || null;
  const callSid = String(body.CallSid || "");

  if (recordingStatus !== "completed") {
    // We only register for 'completed' events but defensive — anything
    // else just ack.
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }
  if (!callSid || !recordingUrl) {
    res.status(400).json({ error: "Missing CallSid or RecordingUrl" });
    return;
  }

  try {
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, lead_id")
      .eq("call_sid", callSid)
      .maybeSingle();
    const row = callRow as { id: string; lead_id: string } | null;
    if (!row) {
      // Possible race — Twilio retries before the lead_calls UPDATE
      // landed our CallSid. Twilio retries automatically; ack 200 so it
      // backs off (waiting for the same row to exist won't help on this
      // attempt) and Sentry breadcrumb so we can see the rate.
      Sentry.addBreadcrumb({
        category: "twilio.recording-status",
        level: "info",
        message: "no_lead_call_row_for_callsid_yet",
        data: { callSid, recordingSid },
      });
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const leadCallId = row.id;
    const leadId = row.lead_id;

    await supabase
      .from("lead_calls")
      .update({
        recording_sid: recordingSid,
        recording_url: recordingUrl,
        recording_duration_secs: recordingDurationSecs,
        recording_channels: recordingChannels,
        // transcription_status stays 'pending' until the async work
        // completes; the partial index keeps a future retry job efficient.
      })
      .eq("id", leadCallId);

    // Insert the call_completed timeline row immediately so the UI shows
    // the call as completed even before the transcript lands. The UI
    // polls / subscribes for the transcript_status flip.
    await supabase.from("lead_activities").insert({
      lead_id: leadId,
      actor_type: "system",
      action: "call_completed",
      metadata: {
        lead_call_id: leadCallId,
        recording_available: true,
        recording_duration_secs: recordingDurationSecs,
        transcript_pending: true,
      },
    });

    // ACK Twilio FIRST, then kick off transcription. Twilio's webhook
    // timeout is 15s; Deepgram + Claude can occasionally exceed it on
    // long calls.
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');

    // Fire-and-forget transcription + summarization. Rejection here
    // does NOT fail the Twilio webhook (it's already responded) — but
    // we DO want the failure signal so the future retry-job slice can
    // sweep it. Sentry.captureException + leave transcription_status
    // at 'pending'.
    (async () => {
      try {
        const transcript = await transcribeRecording(recordingUrl);
        const summary = await summarizeCallTranscript(transcript.transcript_text);
        await supabase
          .from("lead_calls")
          .update({
            transcription_status: "completed",
            transcript_text: transcript.transcript_text,
            transcript_segments: transcript.segments,
            transcript_confidence: transcript.confidence,
            summary_text: summary.summary,
            summary_model: summary.model,
            updated_at: new Date().toISOString(),
          })
          .eq("id", leadCallId);
      } catch (err: any) {
        // Mark failed so the UI can render "transcription failed" and
        // the partial index still surfaces 'pending' rows for retry.
        // Use 'failed' here (not 'pending') so the retry sweep doesn't
        // immediately re-process — operator decides.
        await supabase
          .from("lead_calls")
          .update({ transcription_status: "failed", updated_at: new Date().toISOString() })
          .eq("id", leadCallId);
        Sentry.captureException(err, {
          extra: {
            route: "fire-and-forget transcription",
            leadCallId,
            recordingSid,
            recordingDurationSecs,
          },
        });
      }
    })().catch((unhandled) => {
      Sentry.captureException(unhandled, {
        extra: { route: "fire-and-forget transcription (outer catch)", leadCallId },
      });
    });
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "/api/twilio/recording-status", callSid, recordingSid } });
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/twilio/call-status ───────────────────────────────────────

router.post("/twilio/call-status", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database not configured" });
    return;
  }
  const body = req.body || {};
  const callSid = String(body.CallSid || "");
  const callStatus = String(body.CallStatus || ""); // initiated|ringing|in-progress|completed|failed|busy|no-answer|canceled
  const callDuration = parseInt(String(body.CallDuration || "0"), 10) || null;
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;

  if (!callSid && !leadCallId) {
    res.status(400).json({ error: "Missing identifier" });
    return;
  }

  try {
    const lookup = leadCallId
      ? supabase.from("lead_calls").select("id, lead_id, status").eq("id", leadCallId).maybeSingle()
      : supabase.from("lead_calls").select("id, lead_id, status").eq("call_sid", callSid).maybeSingle();
    const { data: rowData } = await lookup;
    const row = rowData as { id: string; lead_id: string; status: string } | null;
    if (!row) {
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }

    // Map Twilio status → our enum + populate end_reason for terminal states.
    const updates: any = { updated_at: new Date().toISOString() };
    if (callStatus === "ringing") updates.status = "ringing";
    else if (callStatus === "in-progress") updates.status = "in_progress";
    else if (callStatus === "completed") {
      updates.status = "completed";
      updates.customer_answered = true;
      updates.end_reason = "completed";
      updates.duration_secs = callDuration;
      updates.ended_at = new Date().toISOString();
    } else if (callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed" || callStatus === "canceled") {
      updates.status = "failed";
      updates.customer_answered = false;
      updates.end_reason = callStatus;
      updates.ended_at = new Date().toISOString();
    }

    await supabase.from("lead_calls").update(updates).eq("id", row.id);

    // On a terminal failure (no answer/busy/failed) WITHOUT a recording,
    // insert call_failed activity so the timeline reflects the attempt.
    // The call_completed row is inserted by the recording-status webhook
    // when a recording exists.
    if (updates.status === "failed") {
      await supabase.from("lead_activities").insert({
        lead_id: row.lead_id,
        actor_type: "system",
        action: "call_failed",
        metadata: {
          lead_call_id: row.id,
          end_reason: updates.end_reason,
        },
      });
    }

    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "/api/twilio/call-status", callSid, leadCallId } });
    res.status(500).json({ error: "internal" });
  }
});

// ── GET /api/business/disclosure-audio/:businessId/:leg ───────────────
//
// Public — Twilio's <Play> fetches without auth. business_id is in the
// URL; we re-fetch business_name per request (which throws 404 on an
// invalid id, so random-id scraping just gets 404s).
// Rate-limited via the global generalLimiter mounted in app.ts.

router.get("/business/disclosure-audio/:businessId/:leg", async (req: Request, res: Response) => {
  const businessId = String(req.params.businessId);
  const leg = String(req.params.leg) as DisclosureLeg;
  if (leg !== "staff" && leg !== "customer") {
    res.status(400).json({ error: "leg must be 'staff' or 'customer'" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database not configured" });
    return;
  }
  try {
    const { data: biz } = await supabase
      .from("business_configs")
      .select("business_name")
      .eq("business_id", businessId)
      .maybeSingle();
    if (!biz) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const businessName = (biz as { business_name?: string | null }).business_name || "your contact";
    const mp3 = await getOrGenerateDisclosure(businessId, leg, businessName);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", String(mp3.length));
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(mp3);
  } catch (err: any) {
    Sentry.captureException(err, { extra: { route: "/api/business/disclosure-audio", businessId, leg } });
    // Send a TwiML-friendly silent response so the Twilio <Play>
    // doesn't error out the call — the disclosure is missed but the
    // bridge still happens. Sentry alert tells us to investigate.
    res.status(500).json({ error: "TTS failed" });
  }
});

export default router;
