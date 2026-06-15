/**
 * Lead-bridge initiation + status endpoints. Customer + admin parity.
 *
 *   POST /api/business/leads/:id/call
 *   GET  /api/business/leads/:id/calls/:callSid/status
 *
 *   POST /api/admin/business/:businessId/leads/:id/call           (Stage 6)
 *   GET  /api/admin/business/:businessId/leads/:id/calls/:callSid/status
 *
 * Recording-status + voice TwiML + call-status webhooks live in
 * routes/twilio-callbacks.ts so the public Twilio-facing endpoints are
 * grouped separately from the customer-authenticated ones.
 *
 * Flow:
 *   1. Customer clicks "Call customer" in /leads/:id.
 *   2. POST /api/business/leads/:id/call resolves staff ring number
 *      (from user_businesses.callback_ring_number or override),
 *      resolves outbound caller ID (business main line or fallback to
 *      Neverr Twilio line), creates a Twilio outbound call to the
 *      staff with answerOnBridge so the customer leg isn't dialed
 *      until staff picks up, dual-channel recording enabled,
 *      RecordingStatusCallback set.
 *   3. The call's TwiML URL points at /api/twilio/voice/lead-bridge
 *      which plays the staff disclosure then <Dial>s the customer.
 *   4. Twilio's recording-status webhook hits
 *      /api/twilio/recording-status when the recording completes.
 *      We fire-and-forget Deepgram + Claude in a Promise; the webhook
 *      returns 200 immediately. transcription_status moves pending →
 *      completed when the async work lands.
 *   5. The lead-detail UI polls
 *      /api/business/leads/:id/calls/:callSid/status to render live
 *      status; the activity timeline picks up the call_completed row
 *      via the existing /leads/:id detail endpoint.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";
import { auditLog, extractRequestMeta } from "../middlewares/audit";
import { getTwilioClient } from "../sms";
import { resolveOutboundCallerId } from "../lib/twilio-caller-id";
import { sendLeadSms } from "../lib/sms-service";
import { briefReason } from "../lib/sms-templates";

const router = Router();

const E164_RE = /^\+[1-9]\d{6,14}$/;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Pick the staff's ring number for this business. Priority:
 *   1. Explicit override in the request body (rare — UI usually passes
 *      undefined and lets us pull the saved preference).
 *   2. user_businesses.callback_ring_number for (userId, businessId).
 *
 * Returns null if neither is present — the route 400s with an actionable
 * error pointing the user at the settings page.
 */
async function resolveStaffRingNumber(
  supabase: SupabaseClient,
  userId: string,
  businessId: string,
  override: string | undefined,
): Promise<string | null> {
  if (override) {
    const trimmed = override.trim();
    if (!E164_RE.test(trimmed)) return null;
    return trimmed;
  }
  const { data } = await supabase
    .from("user_businesses")
    .select("callback_ring_number")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .maybeSingle();
  const saved = (data as { callback_ring_number?: string | null } | null)?.callback_ring_number;
  if (saved && E164_RE.test(saved.trim())) return saved.trim();
  return null;
}

/**
 * Shared handler used by both /api/business/leads/:id/call and the
 * admin parallel. The admin route resolves businessId from the URL
 * param; the customer route uses req.businessId.
 */
async function handleInitiateCall(opts: {
  req: Request;
  res: Response;
  supabase: SupabaseClient;
  businessId: string;
  leadId: string;
  staffUserId: string;
  ringNumberOverride?: string;
  isAdmin: boolean;
}): Promise<void> {
  const { req, res, supabase, businessId, leadId, staffUserId, ringNumberOverride, isAdmin } = opts;

  // Validate the lead belongs to this business — cross-tenant guard.
  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, business_id, contact_name, contact_phone, reason")
    .eq("id", leadId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (leadErr) {
    Sentry.captureMessage("lead_call_lead_lookup_failed", {
      level: "error",
      extra: { businessId, leadId, error: leadErr.message },
    });
    res.status(500).json({ error: "Database error" });
    return;
  }
  const leadRow = lead as {
    id: string;
    business_id: string;
    contact_name: string | null;
    contact_phone: string | null;
    reason: string;
  } | null;
  if (!leadRow) {
    res.status(404).json({ error: "Lead not found" });
    return;
  }
  if (!leadRow.contact_phone || !E164_RE.test(leadRow.contact_phone)) {
    res.status(400).json({ error: "This lead has no usable customer phone on file" });
    return;
  }

  const ringNumber = await resolveStaffRingNumber(supabase, staffUserId, businessId, ringNumberOverride);
  if (!ringNumber) {
    res.status(400).json({
      error: "Set your callback ring number first",
      code: "ring_number_missing",
      hint: "Open Settings → Callback Number to save the phone we'll dial when you click Call customer.",
    });
    return;
  }

  const callerId = await resolveOutboundCallerId(supabase, businessId);
  if (!callerId) {
    res.status(500).json({ error: "Could not resolve a caller ID for this business" });
    return;
  }

  // Pre-insert the lead_calls row so a Twilio failure has somewhere to
  // attach the failure status. The Twilio CallSid lands in a follow-up
  // UPDATE after the create call succeeds.
  const { data: callRowInsert, error: insertErr } = await supabase
    .from("lead_calls")
    .insert({
      lead_id: leadId,
      staff_user_id: staffUserId,
      staff_ring_number: ringNumber,
      customer_phone: leadRow.contact_phone,
      from_caller_id: callerId.from,
      status: "initiated",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !callRowInsert) {
    Sentry.captureMessage("lead_call_row_insert_failed", {
      level: "error",
      extra: { businessId, leadId, error: insertErr?.message },
    });
    res.status(500).json({ error: "Failed to record call attempt" });
    return;
  }
  const leadCallId = (callRowInsert as { id: string }).id;

  // Build the absolute URL Twilio will hit for the bridge TwiML +
  // status callbacks. Same env resolution as the signature verifier
  // (PUBLIC_API_URL with documented fallback) — must match the URL
  // Twilio sees so our signature verify can rebuild.
  const publicBase = (process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app").replace(/\/+$/, "");
  const bridgeTwimlUrl = `${publicBase}/api/twilio/voice/lead-bridge?lead_call_id=${encodeURIComponent(leadCallId)}`;
  const recordingStatusUrl = `${publicBase}/api/twilio/recording-status`;
  const callStatusUrl = `${publicBase}/api/twilio/call-status?lead_call_id=${encodeURIComponent(leadCallId)}`;

  const client = getTwilioClient();
  let callSid: string;
  try {
    const created = await client.calls.create({
      to: ringNumber,
      from: callerId.from,
      url: bridgeTwimlUrl,
      record: true,
      recordingChannels: "dual",
      recordingStatusCallback: recordingStatusUrl,
      recordingStatusCallbackEvent: ["completed"],
      recordingStatusCallbackMethod: "POST",
      statusCallback: callStatusUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
    });
    callSid = created.sid;
  } catch (err: any) {
    // Twilio error 21217 = "Phone number not verified". If we hit it
    // when using the business main line, swap to the Neverr Twilio
    // line and retry. Future slice will surface a verification UI.
    const code = (err && (err.code || err?.responseDetails?.code)) || null;
    if (code === 21217 && callerId.source === "business_main_line") {
      Sentry.addBreadcrumb({
        category: "lead-bridge",
        level: "warning",
        message: "outbound_caller_id_not_verified_falling_back",
        data: { businessId, attempted: callerId.from },
      });
      // Re-resolve forcing the Neverr line by reading business_configs
      // directly — quick fallback to keep the call alive.
      const { data: biz } = await supabase
        .from("business_configs")
        .select("twilio_phone_number")
        .eq("business_id", businessId)
        .maybeSingle();
      const fallback = (biz as { twilio_phone_number?: string } | null)?.twilio_phone_number;
      if (!fallback || !E164_RE.test(fallback)) {
        Sentry.captureException(err, { extra: { route: "lead-bridge.initiate", businessId } });
        await supabase.from("lead_calls").update({ status: "failed", end_reason: "no_caller_id" }).eq("id", leadCallId);
        res.status(500).json({ error: "Could not initiate call — caller ID setup incomplete" });
        return;
      }
      try {
        const retried = await client.calls.create({
          to: ringNumber,
          from: fallback,
          url: bridgeTwimlUrl,
          record: true,
          recordingChannels: "dual",
          recordingStatusCallback: recordingStatusUrl,
          recordingStatusCallbackEvent: ["completed"],
          recordingStatusCallbackMethod: "POST",
          statusCallback: callStatusUrl,
          statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
          statusCallbackMethod: "POST",
        });
        callSid = retried.sid;
        await supabase.from("lead_calls").update({ from_caller_id: fallback }).eq("id", leadCallId);
      } catch (retryErr: any) {
        Sentry.captureException(retryErr, { extra: { route: "lead-bridge.initiate.retry", businessId } });
        await supabase.from("lead_calls").update({ status: "failed", end_reason: "twilio_create_failed" }).eq("id", leadCallId);
        res.status(500).json({ error: "Twilio could not place the call" });
        return;
      }
    } else {
      Sentry.captureException(err, { extra: { route: "lead-bridge.initiate", businessId, code } });
      await supabase.from("lead_calls").update({ status: "failed", end_reason: "twilio_create_failed" }).eq("id", leadCallId);
      res.status(500).json({ error: "Twilio could not place the call" });
      return;
    }
  }

  // Attach the CallSid to the lead_calls row + insert the activity
  // timeline entry. Activity carries lead_call_id so the UI can
  // dereference to the rich row.
  await supabase.from("lead_calls").update({ call_sid: callSid }).eq("id", leadCallId);
  await supabase.from("lead_activities").insert({
    lead_id: leadId,
    actor_id: staffUserId,
    actor_type: "staff",
    action: "call_initiated",
    metadata: {
      lead_call_id: leadCallId,
      call_sid: callSid,
      staff_user_id: staffUserId,
      ring_number: ringNumber,
      customer_phone: leadRow.contact_phone,
      from_caller_id: callerId.from,
    },
  });

  // Slice 3A pillar 2: fire the callback_starting SMS. Twilio just
  // accepted the call; the customer's phone will ring in ~5–15s
  // (staff has to answer first + recording disclosure plays). Sending
  // now gives a heads-up close enough to "30 sec before bridge" to be
  // useful. Fire-and-forget so an SMS failure doesn't break the
  // bridge — the call is more important than the SMS.
  (async () => {
    try {
      const { data: bizRow } = await supabase
        .from("business_configs")
        .select("business_name")
        .eq("business_id", businessId)
        .maybeSingle();
      const businessName = (bizRow as { business_name?: string } | null)?.business_name || "the team";
      await sendLeadSms({
        supabase,
        businessId,
        leadId,
        to: leadRow.contact_phone || "",
        template: "callback_starting",
        context: {
          business_name: businessName,
          brief_reason: briefReason(leadRow.reason),
          from_phone: callerId.from,
        },
        locale: "en",
      });
    } catch (smsErr: any) {
      Sentry.captureException(smsErr, {
        extra: { route: "lead-calls callback_starting sms", leadId, leadCallId },
      });
    }
  })().catch(() => { /* outer safety net */ });

  const meta = extractRequestMeta(req);
  await auditLog({
    userId: staffUserId,
    businessId,
    action: "leads.call.initiated",
    ...meta,
    details: {
      lead_id: leadId,
      lead_call_id: leadCallId,
      call_sid: callSid,
      source: isAdmin ? "admin_raw" : "customer",
    },
  });

  res.json({
    success: true,
    call_sid: callSid,
    lead_call_id: leadCallId,
    from_caller_id: callerId.from,
    customer_phone: leadRow.contact_phone,
  });
}

// ── GET / PUT /api/business/me/callback-preference ────────────────────
//
// Per-(user, business) ring number preference. Stored on user_businesses.
// The lead-bridge POST reads this when no override is passed; the
// settings page reads it to pre-fill the input and writes it on save.
// No staff RBAC — this is the caller's OWN preference within their
// CURRENT business; permission gate is just authentication.

router.get(
  "/business/me/callback-preference",
  requireAuth,
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const userId = req.userId;
    if (!businessId || !userId) {
      res.status(400).json({ error: "No active business or user" });
      return;
    }
    const { data } = await supabase
      .from("user_businesses")
      .select("callback_ring_number")
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .maybeSingle();
    res.json({
      callback_ring_number: (data as { callback_ring_number?: string | null } | null)?.callback_ring_number ?? null,
    });
  },
);

router.put(
  "/business/me/callback-preference",
  requireAuth,
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const userId = req.userId;
    if (!businessId || !userId) {
      res.status(400).json({ error: "No active business or user" });
      return;
    }
    const raw = req.body?.callback_ring_number;
    // Allow clearing by passing null/empty string.
    if (raw === null || raw === "") {
      await supabase
        .from("user_businesses")
        .update({ callback_ring_number: null })
        .eq("user_id", userId)
        .eq("business_id", businessId);
      res.json({ success: true, callback_ring_number: null });
      return;
    }
    if (typeof raw !== "string" || !E164_RE.test(raw.trim())) {
      res.status(400).json({ error: "callback_ring_number must be in E.164 format (e.g. +14105551234)" });
      return;
    }
    const trimmed = raw.trim();
    const { error: updateErr } = await supabase
      .from("user_businesses")
      .update({ callback_ring_number: trimmed })
      .eq("user_id", userId)
      .eq("business_id", businessId);
    if (updateErr) {
      Sentry.captureMessage("callback_pref_update_failed", {
        level: "error",
        extra: { userId, businessId, error: updateErr.message },
      });
      res.status(500).json({ error: "Failed to save preference" });
      return;
    }
    res.json({ success: true, callback_ring_number: trimmed });
  },
);

// ── POST /api/business/leads/:id/call ─────────────────────────────────

router.post(
  "/business/leads/:id/call",
  requireAuth,
  // Customer-side RBAC: 'calls:write' is held by owner / admin / manager /
  // team_lead / agent_manager / user — anyone hands-on with calls in the
  // business. Excludes 'analyst' and 'readonly' which are intentionally
  // view-only. NOT 'settings:write' (semantically wrong; that excludes
  // manager+ roles who should be able to initiate callbacks).
  requirePermission("calls", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const leadId = String(req.params.id);
    const ringOverride = typeof req.body?.staff_ring_number === "string" ? req.body.staff_ring_number : undefined;

    await handleInitiateCall({
      req, res, supabase, businessId, leadId,
      staffUserId: userId,
      ringNumberOverride: ringOverride,
      isAdmin: false,
    });
  },
);

// ── GET /api/business/leads/:id/calls/:callSid/status ─────────────────

router.get(
  "/business/leads/:id/calls/:callSid/status",
  requireAuth,
  requirePermission("calls", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const leadId = String(req.params.id);
    const callSid = String(req.params.callSid);

    // Cross-tenant guard via the lead_id → leads.business_id join.
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("id", leadId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, call_sid, status, customer_answered, end_reason, duration_secs, started_at, ended_at, transcription_status, summary_text, recording_sid, transcript_text")
      .eq("call_sid", callSid)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (!callRow) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(callRow);
  },
);

// ── POST /api/admin/business/:businessId/leads/:id/call ───────────────

router.post(
  "/admin/business/:businessId/leads/:id/call",
  requireAuth,
  requireStaffPermission("leads", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const leadId = String(req.params.id);
    const ringOverride = typeof req.body?.staff_ring_number === "string" ? req.body.staff_ring_number : undefined;
    await handleInitiateCall({
      req, res, supabase, businessId, leadId,
      staffUserId: userId,
      ringNumberOverride: ringOverride,
      isAdmin: true,
    });
  },
);

// ── GET /api/admin/business/:businessId/leads/:id/calls/:callSid/status

router.get(
  "/admin/business/:businessId/leads/:id/calls/:callSid/status",
  requireAuth,
  requireStaffPermission("leads", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    const leadId = String(req.params.id);
    const callSid = String(req.params.callSid);
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("id", leadId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, call_sid, status, customer_answered, end_reason, duration_secs, started_at, ended_at, transcription_status, summary_text, recording_sid, transcript_text")
      .eq("call_sid", callSid)
      .eq("lead_id", leadId)
      .maybeSingle();
    if (!callRow) {
      res.status(404).json({ error: "Call not found" });
      return;
    }
    res.json(callRow);
  },
);

// ── GET /api/business/leads/:id/call-recording/:sid ───────────────────
//
// Recording playback proxy. Twilio's recording URLs require HTTP Basic
// auth (AccountSid:AuthToken), which we don't want to expose to the
// browser. Two patterns were considered (per Slice 2A spec):
//   - Time-bound signed URL via Supabase Storage. Adds an upload step
//     to the fire-and-forget pipeline + a new Storage bucket.
//   - Proxy. Browser hits our endpoint with the user's JWT; we fetch
//     Twilio's URL with basic auth and stream the bytes back.
//
// Chose the proxy: zero new infrastructure, simpler ops, recording
// access stays fully gated by our auth. Downside: every playback hits
// our server. At expected scale (~tens of playbacks per day per
// business) this is well below any concern threshold.
//
// Cross-tenant guard: lead_id must belong to req.businessId. Permission:
// calls:read (same as the status endpoint).

router.get(
  "/business/leads/:id/call-recording/:sid",
  requireAuth,
  requirePermission("calls", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const leadId = String(req.params.id);
    const recordingSid = String(req.params.sid);

    // Cross-tenant guard via lead → business + recording → call_sid join.
    const { data: lead } = await supabase
      .from("leads")
      .select("id")
      .eq("id", leadId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!lead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("recording_url, recording_sid")
      .eq("lead_id", leadId)
      .eq("recording_sid", recordingSid)
      .maybeSingle();
    const row = callRow as { recording_url: string | null; recording_sid: string | null } | null;
    if (!row || !row.recording_url) {
      res.status(404).json({ error: "Recording not found" });
      return;
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      res.status(500).json({ error: "Twilio credentials not configured" });
      return;
    }
    const auth = Buffer.from(`${sid}:${token}`).toString("base64");
    try {
      const upstream = await fetch(row.recording_url + ".mp3", {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!upstream.ok || !upstream.body) {
        Sentry.captureMessage("recording_proxy_upstream_failed", {
          level: "error",
          extra: { businessId, leadId, recordingSid, status: upstream.status },
        });
        res.status(502).json({ error: "Could not fetch recording from upstream" });
        return;
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      // Browser caches per-playback at most 5 minutes; staff scrolling
      // through old calls re-fetches each time. Acceptable.
      res.setHeader("Cache-Control", "private, max-age=300");
      // Stream upstream → response.
      const reader = upstream.body.getReader();
      let chunk = await reader.read();
      while (!chunk.done) {
        res.write(chunk.value);
        chunk = await reader.read();
      }
      res.end();
    } catch (err: any) {
      Sentry.captureException(err, { extra: { route: "/api/business/leads/:id/call-recording/:sid", leadId, recordingSid } });
      if (!res.headersSent) res.status(500).json({ error: "Recording playback failed" });
    }
  },
);

export default router;
