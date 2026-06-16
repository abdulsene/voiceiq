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
import { extractRequestMeta } from "../middlewares/audit";
import { sendLeadSms } from "../lib/sms-service";
import { briefReason } from "../lib/sms-templates";
import { placeCall } from "../lib/outbound-voice";

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
 * admin parallel. Phase 1.4 — thin HTTP wrapper over placeCall().
 *
 * The route owns:
 *   - Staff ring-number resolution (per-user preference).
 *   - Request meta extraction for the audit trail.
 *   - Fetching the lead's reason + contact_phone for the SMS dispatch
 *     and the documented response body shape.
 *   - HTTP status mapping.
 *   - 'callback_starting' SMS fire-and-forget.
 *   - Response body shaping (preserving the legacy fields the
 *     dashboard's LeadDetailPage and SMS receipts expect).
 *
 * placeCall() owns:
 *   - Cross-tenant lead guard, lead-row + phone validation.
 *   - Outbound caller-ID resolution.
 *   - lead_calls pre-insert + post-insert call_sid UPDATE.
 *   - Twilio dispatch (incl. 21217 retry via TwilioRestProvider).
 *   - lead_activities insert + auditLog.
 *
 * NOTE on 21217 fallback: TwilioRestProvider falls back to
 * process.env.TWILIO_PHONE_NUMBER, not business_configs.twilio_phone_number
 * as the pre-1.4 route did. This is the documented Phase 0-B shortcut
 * (see twilio-rest-provider.ts JSDoc) — Phase 2 can lift it to a
 * per-tenant lookup if needed.
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

  const ringNumber = await resolveStaffRingNumber(supabase, staffUserId, businessId, ringNumberOverride);
  if (!ringNumber) {
    res.status(400).json({
      error: "Set your callback ring number first",
      code: "ring_number_missing",
      hint: "Open Settings → Callback Number to save the phone we'll dial when you click Call customer.",
    });
    return;
  }

  // The SMS dispatch and the documented response shape need the lead's
  // reason + contact_phone. placeCall does its own cross-tenant guard
  // independently, so this SELECT is purely route-bookkeeping. One extra
  // query on the happy path is fine.
  const { data: leadData } = await supabase
    .from("leads")
    .select("contact_phone, reason")
    .eq("id", leadId)
    .eq("business_id", businessId)
    .maybeSingle();
  const leadRow = leadData as { contact_phone: string | null; reason: string | null } | null;

  const meta = extractRequestMeta(req);
  const result = await placeCall(supabase, {
    businessId,
    leadId,
    direction: "inbound_bridge",
    staffUserId,
    staffRingNumber: ringNumber,
    requestMeta: {
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
    isAdmin,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "lead_not_found":
        res.status(404).json({ error: "Lead not found" });
        return;
      case "lead_phone_invalid":
        res.status(400).json({ error: "This lead has no usable customer phone on file" });
        return;
      case "staff_ring_number_missing":
        // Defensive — we resolved ringNumber above.
        res.status(400).json({ error: "Staff ring number required for bridge" });
        return;
      case "caller_id_unresolvable":
        res.status(500).json({ error: "Could not resolve a caller ID for this business" });
        return;
      case "business_not_found":
        res.status(404).json({ error: "Business config missing" });
        return;
      case "provider_failed":
        Sentry.captureMessage("lead_bridge_provider_failed", {
          level: "error",
          extra: { businessId, leadId, twilioCode: result.twilioCode, providerError: result.providerError },
        });
        res.status(502).json({
          error: "Twilio could not place the call",
          twilio_code: result.twilioCode,
          provider_error: result.providerError,
        });
        return;
      case "db_error":
        Sentry.captureMessage("lead_bridge_db_error", {
          level: "error",
          extra: { businessId, leadId, step: result.step, error: result.error },
        });
        res.status(500).json({ error: "Database error", step: result.step });
        return;
      case "tenant_outbound_disabled":
      case "non_nanp_number_no_tz_inference":
      case "compliance_blocked":
        // Defensive — placeCall does not gate inbound_bridge on these.
        Sentry.captureMessage("place_call_unexpected_reason_for_inbound_bridge", {
          level: "error",
          extra: { reason: result.reason, businessId, leadId },
        });
        res.status(500).json({ error: "Unexpected placement error" });
        return;
      default: {
        const _exhaustive: never = result;
        void _exhaustive;
        res.status(500).json({ error: "Unknown placement error" });
        return;
      }
    }
  }

  if (result.status !== "placed") {
    // Inbound bridge never schedules — we didn't pass scheduledFor.
    Sentry.captureMessage("place_call_unexpected_status_for_inbound_bridge", {
      level: "error",
      extra: { status: result.status, businessId, leadId },
    });
    res.status(500).json({ error: "Unexpected placement status" });
    return;
  }

  // Slice 3A pillar 2: fire-and-forget callback_starting SMS. The call
  // is more important than the SMS — outer safety net swallows.
  if (leadRow?.contact_phone && result.fromCallerId) {
    const contactPhone = leadRow.contact_phone;
    const reason = leadRow.reason ?? "";
    const fromPhone = result.fromCallerId;
    const leadCallIdForSms = result.leadCallId;
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
          to: contactPhone,
          template: "callback_starting",
          context: {
            business_name: businessName,
            brief_reason: briefReason(reason),
            from_phone: fromPhone,
          },
          locale: "en",
        });
      } catch (smsErr: any) {
        Sentry.captureException(smsErr, {
          extra: { route: "lead-calls callback_starting sms", leadId, leadCallId: leadCallIdForSms },
        });
      }
    })().catch(() => { /* outer safety net */ });
  }

  res.json({
    success: true,
    call_sid: result.callSid,
    lead_call_id: result.leadCallId,
    from_caller_id: result.fromCallerId ?? null,
    customer_phone: leadRow?.contact_phone ?? null,
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
