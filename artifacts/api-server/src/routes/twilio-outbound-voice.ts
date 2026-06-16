/**
 * Phase 0 Commit 0-D — outbound voice Twilio webhook routes.
 * Phase 1.6 — voicemail leave-behind + AMD-machine redirect.
 *
 *   POST /api/twilio/outbound-voice/twiml?lead_call_id=...
 *     Twilio's voice URL for outbound_automated calls. Verifies
 *     signature, resolves agent_id (campaign → tenant default),
 *     fetches a signed ElevenLabs conversation URL, returns
 *     <Connect><Stream> TwiML. Any failure → <Hangup/>. NEVER 5xx
 *     to Twilio (failure paths return 2xx with hangup so Twilio
 *     doesn't retry).
 *
 *   POST /api/twilio/outbound-voice/amd?lead_call_id=...
 *     Async AMD callback. Idempotent UPDATE of
 *     lead_calls.answered_by + voicemail_left=FALSE, only when
 *     answered_by IS NULL.
 *
 *     Phase 1.6: when AnsweredBy starts with "machine" AND the
 *     tenant has business_configs.outbound_voicemail_text
 *     configured, redirect the in-flight Twilio call to the
 *     /voicemail route via client.calls(sid).update({url:...}).
 *     On successful redirect, UPDATE voicemail_left=TRUE.
 *
 *     CRITICAL PATH-A NOTE: This redirect mechanic only works for
 *     Path B (outbound_provider='twilio') where Twilio is the call
 *     orchestrator and our /twiml URL is the active resource. For
 *     Path A (elevenlabs_hosted), ElevenLabs hosts the call media
 *     end-to-end via their own TwiML — our /amd webhook may never
 *     fire (depending on ElevenLabs config), and even if it does,
 *     client.calls(sid).update() targets a CallSid Twilio controls,
 *     not ElevenLabs's leg. Path A voicemail is configured on the
 *     ElevenLabs side as a separate ops concern. Phase 1.6 ships
 *     only Path B voicemail.
 *
 *   POST /api/twilio/outbound-voice/voicemail?lead_call_id=...   (Phase 1.6)
 *     Returns the voicemail leave-behind TwiML for the redirected
 *     call. <Say voice="alice">{outbound_voicemail_text}</Say>
 *     <Hangup/>, or bare <Hangup/> if the tenant didn't configure
 *     voicemail text. Always 2xx (200 + TwiML); even DB lookup
 *     failure returns <Hangup/> rather than 5xx (same 2xx-always
 *     posture as the other outbound-voice routes).
 *
 *   POST /api/twilio/outbound-voice/status?lead_call_id=...
 *     Voice call status callback. Idempotent state transitions:
 *     UPDATE ... WHERE status != 'completed' so a Twilio retry
 *     doesn't double-increment counters. On terminal completion +
 *     campaign_id present: bump outbound_campaigns counters via
 *     read-then-write (acceptable under Phase 0 low-concurrency;
 *     Phase 1 swaps to Postgres RPC if load grows). On
 *     no-answer/busy/failed: bump leads.outbound_attempt_count.
 *
 * Twilio behavior gotcha: webhooks 5xx trigger up to ~10 retries over
 * 24h. Every handler in this file returns 2xx on application errors
 * (logged to Sentry); the only non-2xx path is signature verify
 * failure → 403. That's the "don't auto-retry; this request was
 * tampered with" signal.
 *
 * AMD vs status ordering race: AMD callback can arrive AFTER the
 * status callback for very short calls. We document the race and
 * design counter increments around it — the AMD handler increments
 * succeeded_count/voicemail_count when it lands; the status handler
 * increments only completed_count + failed_count. See the campaign-
 * counters helper for the breakdown.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { verifyTwilioSignature } from "../lib/twilio-signature";
import { getSignedConversationUrl } from "../lib/outbound-voice/elevenlabs-signed-url";
import {
  buildEmptyResponseTwiml,
  buildHangupTwiml,
  buildOutboundAutomatedTwiml,
  buildVoicemailTwiml,
} from "../lib/outbound-voice/twiml-builder";
import { getPublicApiBase } from "../lib/public-url";
import { getTwilioClient } from "../sms";

// Minimal Twilio client shape we need for the AMD voicemail redirect.
// Matches twilio-rest-provider's TwilioClient — narrow surface so test
// stubs are tiny.
interface TwilioClientLike {
  calls(sid: string): { update(opts: { url: string }): Promise<unknown> };
}

const router = Router();

// Test injection point — Node 24 ESM freezes namespace exports so the
// 020-style monkey-patch doesn't work for createClient. The route's
// own module exposes a setter that overrides the cached client.
// Production code never touches this; tests call
// __setSupabaseForTesting(fakeClient) before each case.
let _supabaseOverride: SupabaseClient | null = null;
export function __setSupabaseForTesting(client: SupabaseClient | null): void {
  _supabaseOverride = client;
}

function getSupabase(): SupabaseClient | null {
  if (_supabaseOverride) return _supabaseOverride;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Phase 1.6 — Twilio client seam. Same DI pattern as the supabase
// seam above. Tests inject a fake client so we can assert on
// client.calls(sid).update({url}) calls without hitting Twilio.
let _twilioClientOverride: TwilioClientLike | null = null;
export function __setTwilioClientForTesting(client: TwilioClientLike | null): void {
  _twilioClientOverride = client;
}

function getTwilio(): TwilioClientLike {
  if (_twilioClientOverride) return _twilioClientOverride;
  return getTwilioClient() as unknown as TwilioClientLike;
}

function sendTwiml(res: Response, body: string, status = 200): void {
  res.status(status).type("text/xml").send(body);
}

// ── POST /api/twilio/outbound-voice/twiml ─────────────────────────────

router.post("/twilio/outbound-voice/twiml", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).type("text/xml").send(buildHangupTwiml());
    return;
  }
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;
  if (!leadCallId) {
    sendTwiml(res, buildHangupTwiml());
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    Sentry.captureMessage("outbound_twiml_no_supabase", { level: "error" });
    sendTwiml(res, buildHangupTwiml());
    return;
  }

  try {
    // Load the call row + JOIN campaign for the agent_id override path.
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, lead_id, direction, call_objective, campaign_id")
      .eq("id", leadCallId)
      .maybeSingle();
    const call = callRow as {
      id: string;
      lead_id: string;
      direction: string | null;
      call_objective: string | null;
      campaign_id: string | null;
    } | null;
    if (!call) {
      Sentry.addBreadcrumb({
        category: "outbound-voice.twiml",
        level: "info",
        message: "lead_call_not_found",
        data: { leadCallId },
      });
      sendTwiml(res, buildHangupTwiml());
      return;
    }
    if (call.direction !== "outbound_automated") {
      Sentry.addBreadcrumb({
        category: "outbound-voice.twiml",
        level: "warning",
        message: "cross_direction_twiml_request_blocked",
        data: { leadCallId, direction: call.direction },
      });
      sendTwiml(res, buildHangupTwiml());
      return;
    }

    // Resolve agent_id. Priority: campaign override → lead's business
    // default (via leads → business_configs).
    let agentId: string | null = null;
    if (call.campaign_id) {
      const { data: campRow } = await supabase
        .from("outbound_campaigns")
        .select("agent_id, business_id")
        .eq("id", call.campaign_id)
        .maybeSingle();
      const c = campRow as { agent_id: string | null; business_id: string } | null;
      if (c?.agent_id) agentId = c.agent_id;
    }
    let businessId: string | null = null;
    if (!agentId) {
      // Fall back to the tenant default via leads.business_id → business_configs.agent_id.
      const { data: leadRow } = await supabase
        .from("leads")
        .select("business_id")
        .eq("id", call.lead_id)
        .maybeSingle();
      businessId = (leadRow as { business_id?: string } | null)?.business_id ?? null;
      if (businessId) {
        const { data: bizRow } = await supabase
          .from("business_configs")
          .select("agent_id")
          .eq("business_id", businessId)
          .maybeSingle();
        agentId = (bizRow as { agent_id?: string } | null)?.agent_id ?? null;
      }
    } else if (call.campaign_id) {
      // We already loaded the campaign; pull business_id from it without a re-fetch.
      const { data: campBiz } = await supabase
        .from("outbound_campaigns")
        .select("business_id")
        .eq("id", call.campaign_id)
        .maybeSingle();
      businessId = (campBiz as { business_id?: string } | null)?.business_id ?? null;
    }

    if (!agentId || !businessId) {
      Sentry.captureMessage("outbound_twiml_agent_resolve_failed", {
        level: "error",
        extra: { leadCallId, hasAgentId: !!agentId, hasBusinessId: !!businessId },
      });
      sendTwiml(res, buildHangupTwiml());
      return;
    }

    const signed = await getSignedConversationUrl(agentId);
    if (!signed) {
      Sentry.captureMessage("outbound_twiml_signed_url_failed", {
        level: "error",
        extra: { leadCallId, agentId },
      });
      sendTwiml(res, buildHangupTwiml());
      return;
    }

    const twiml = buildOutboundAutomatedTwiml({
      signedStreamUrl: signed.url,
      businessId,
      leadCallId,
      callObjective: call.call_objective || "other",
    });
    sendTwiml(res, twiml);
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/twilio/outbound-voice/twiml", leadCallId },
    });
    // 2xx + hangup so Twilio doesn't retry. The error is captured.
    sendTwiml(res, buildHangupTwiml());
  }
});

// ── POST /api/twilio/outbound-voice/amd ───────────────────────────────

router.post("/twilio/outbound-voice/amd", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).type("text/xml").send(buildEmptyResponseTwiml());
    return;
  }
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;
  if (!leadCallId) {
    sendTwiml(res, buildEmptyResponseTwiml());
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    sendTwiml(res, buildEmptyResponseTwiml());
    return;
  }
  const body = (req.body || {}) as Record<string, unknown>;
  const answeredBy = typeof body.AnsweredBy === "string" ? body.AnsweredBy : null;
  if (!answeredBy) {
    sendTwiml(res, buildEmptyResponseTwiml());
    return;
  }

  try {
    // Idempotent: only set answered_by when it's still NULL. A retry of
    // the AMD callback finds a non-null answered_by and no-ops.
    // The is(answered_by, null) guard also gives us "fire exactly once
    // per call" — the voicemail redirect logic below benefits from
    // that (no risk of double-redirecting on AMD retries).
    const { data: updated } = await supabase
      .from("lead_calls")
      .update({ answered_by: answeredBy, voicemail_left: false })
      .eq("id", leadCallId)
      .is("answered_by", null)
      .select("id, call_sid, campaign_id, status");
    const rows = (updated as Array<{ id: string; call_sid: string | null; campaign_id: string | null; status: string | null }>) || [];
    if (rows.length === 0) {
      // Already set OR row doesn't exist. Either way no-op.
      sendTwiml(res, buildEmptyResponseTwiml());
      return;
    }

    const row = rows[0];

    // If the call has already completed by the time AMD lands (race),
    // increment the campaign counter slice that the status handler
    // intentionally deferred. See campaign-counters helper.
    if (row.campaign_id && row.status === "completed") {
      await incrementCampaignTerminalCounter(supabase, row.campaign_id, answeredBy);
    }

    // Phase 1.6 — voicemail redirect on machine detection.
    // Only Path B (TwilioRestProvider) reaches this branch; Path A
    // (elevenlabs_hosted) routes media through ElevenLabs and our
    // client.calls(sid).update would target a CallSid Twilio doesn't
    // own. See file-level JSDoc.
    if (answeredBy.startsWith("machine") && row.call_sid) {
      await tryRedirectToVoicemail(supabase, row.id, row.call_sid, leadCallId);
    }

    sendTwiml(res, buildEmptyResponseTwiml());
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/twilio/outbound-voice/amd", leadCallId },
    });
    sendTwiml(res, buildEmptyResponseTwiml());
  }
});

async function tryRedirectToVoicemail(
  supabase: SupabaseClient,
  leadCallRowId: string,
  callSid: string,
  leadCallIdQueryParam: string,
): Promise<void> {
  try {
    // Load business_id via leads JOIN — lead_calls has no business_id.
    const { data: rowWithLead } = await supabase
      .from("lead_calls")
      .select("lead_id")
      .eq("id", leadCallRowId)
      .maybeSingle();
    const leadId = (rowWithLead as { lead_id?: string } | null)?.lead_id;
    if (!leadId) return;
    const { data: leadRow } = await supabase
      .from("leads")
      .select("business_id")
      .eq("id", leadId)
      .maybeSingle();
    const businessId = (leadRow as { business_id?: string } | null)?.business_id;
    if (!businessId) return;
    const { data: bizRow } = await supabase
      .from("business_configs")
      .select("outbound_voicemail_text")
      .eq("business_id", businessId)
      .maybeSingle();
    const voicemailText = (bizRow as { outbound_voicemail_text?: string | null } | null)?.outbound_voicemail_text;
    if (!voicemailText || voicemailText.trim().length === 0) {
      // Tenant didn't configure voicemail. Agent disconnects gracefully
      // when the line drops; voicemail_left stays FALSE.
      return;
    }

    const voicemailUrl =
      `${getPublicApiBase()}/api/twilio/outbound-voice/voicemail` +
      `?lead_call_id=${encodeURIComponent(leadCallIdQueryParam)}`;
    try {
      await getTwilio().calls(callSid).update({ url: voicemailUrl });
    } catch (twilioErr: any) {
      Sentry.captureException(twilioErr, {
        extra: { route: "/api/twilio/outbound-voice/amd.voicemailRedirect", leadCallRowId, callSid },
      });
      return;
    }
    try {
      await supabase
        .from("lead_calls")
        .update({ voicemail_left: true })
        .eq("id", leadCallRowId);
    } catch (e: any) {
      Sentry.captureMessage("amd_voicemail_left_update_failed", {
        level: "warning",
        extra: { leadCallRowId, error: e?.message },
      });
    }
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/twilio/outbound-voice/amd.tryRedirectToVoicemail", leadCallRowId },
    });
  }
}

// ── POST /api/twilio/outbound-voice/voicemail ─────────────────────────
// Phase 1.6. Reached when the AMD handler redirects an in-flight call
// here because AnsweredBy was machine_* AND the tenant has voicemail
// text configured. Returns <Say> + <Hangup/> TwiML, or bare <Hangup/>
// if the lookup chain fails. Always 2xx (same posture as other
// outbound-voice routes — never 5xx to Twilio).

router.post("/twilio/outbound-voice/voicemail", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).type("text/xml").send(buildHangupTwiml());
    return;
  }
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;
  if (!leadCallId) {
    sendTwiml(res, buildVoicemailTwiml(null));
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    Sentry.captureMessage("voicemail_twiml_no_supabase", { level: "error" });
    sendTwiml(res, buildVoicemailTwiml(null));
    return;
  }

  try {
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("lead_id")
      .eq("id", leadCallId)
      .maybeSingle();
    const leadId = (callRow as { lead_id?: string } | null)?.lead_id;
    if (!leadId) {
      sendTwiml(res, buildVoicemailTwiml(null));
      return;
    }
    const { data: leadRow } = await supabase
      .from("leads")
      .select("business_id")
      .eq("id", leadId)
      .maybeSingle();
    const businessId = (leadRow as { business_id?: string } | null)?.business_id;
    if (!businessId) {
      sendTwiml(res, buildVoicemailTwiml(null));
      return;
    }
    const { data: bizRow } = await supabase
      .from("business_configs")
      .select("outbound_voicemail_text")
      .eq("business_id", businessId)
      .maybeSingle();
    const voicemailText = (bizRow as { outbound_voicemail_text?: string | null } | null)?.outbound_voicemail_text ?? null;
    sendTwiml(res, buildVoicemailTwiml(voicemailText));
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/twilio/outbound-voice/voicemail", leadCallId },
    });
    // 2xx + Hangup so Twilio doesn't retry.
    sendTwiml(res, buildVoicemailTwiml(null));
  }
});

// ── POST /api/twilio/outbound-voice/status ────────────────────────────

router.post("/twilio/outbound-voice/status", async (req: Request, res: Response) => {
  if (!verifyTwilioSignature(req)) {
    res.status(403).type("text/xml").send(buildEmptyResponseTwiml());
    return;
  }
  const leadCallId = typeof req.query.lead_call_id === "string" ? req.query.lead_call_id : null;
  if (!leadCallId) {
    sendTwiml(res, buildEmptyResponseTwiml());
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    sendTwiml(res, buildEmptyResponseTwiml());
    return;
  }

  const body = (req.body || {}) as Record<string, unknown>;
  const callStatus = typeof body.CallStatus === "string" ? body.CallStatus : "";
  const callDuration = parseInt(String(body.CallDuration || "0"), 10) || null;

  try {
    // Load minimal call row to decide branch behavior.
    const { data: callRow } = await supabase
      .from("lead_calls")
      .select("id, lead_id, direction, status, campaign_id, answered_by")
      .eq("id", leadCallId)
      .maybeSingle();
    const call = callRow as {
      id: string;
      lead_id: string;
      direction: string | null;
      status: string | null;
      campaign_id: string | null;
      answered_by: string | null;
    } | null;
    if (!call) {
      sendTwiml(res, buildEmptyResponseTwiml());
      return;
    }
    if (call.direction !== "outbound_automated") {
      // Cross-direction defense: outbound-bridge status flows through
      // the existing /api/twilio/call-status handler, not here. Quiet
      // breadcrumb so a misconfigured campaign is visible.
      Sentry.addBreadcrumb({
        category: "outbound-voice.status",
        level: "warning",
        message: "wrong_direction_for_outbound_status",
        data: { leadCallId, direction: call.direction },
      });
      sendTwiml(res, buildEmptyResponseTwiml());
      return;
    }

    if (callStatus === "ringing" || callStatus === "in-progress") {
      // Forward-only transitions; cheap UPDATE, no idempotency concern.
      const next = callStatus === "ringing" ? "ringing" : "in_progress";
      await supabase.from("lead_calls").update({ status: next }).eq("id", leadCallId);
      sendTwiml(res, buildEmptyResponseTwiml());
      return;
    }

    if (callStatus === "completed") {
      // Idempotent: only transition out of non-completed state. A retry
      // finds status='completed' and no-ops the counter logic below.
      const nowIso = new Date().toISOString();
      const { data: updated } = await supabase
        .from("lead_calls")
        .update({
          status: "completed",
          customer_answered: true,
          end_reason: "completed",
          duration_secs: callDuration,
          ended_at: nowIso,
        })
        .eq("id", leadCallId)
        .neq("status", "completed")
        .select("id");
      const rows = (updated as Array<{ id: string }>) || [];
      if (rows.length === 0) {
        sendTwiml(res, buildEmptyResponseTwiml());
        return;
      }
      if (call.campaign_id) {
        await incrementCampaignCompletedCounter(supabase, call.campaign_id);
        // If AMD already populated answered_by, do the terminal slice now.
        // Otherwise the AMD handler does it when it lands.
        if (call.answered_by) {
          await incrementCampaignTerminalCounter(supabase, call.campaign_id, call.answered_by);
        }
      }
      sendTwiml(res, buildEmptyResponseTwiml());
      return;
    }

    if (
      callStatus === "no-answer" ||
      callStatus === "busy" ||
      callStatus === "failed" ||
      callStatus === "canceled"
    ) {
      // Idempotent: only transition out of non-terminal state.
      const nowIso = new Date().toISOString();
      const { data: updated } = await supabase
        .from("lead_calls")
        .update({
          status: "failed",
          customer_answered: false,
          end_reason: callStatus,
          ended_at: nowIso,
        })
        .eq("id", leadCallId)
        .not("status", "in", "(completed,failed)")
        .select("id, lead_id");
      const rows = (updated as Array<{ id: string; lead_id: string }>) || [];
      if (rows.length === 0) {
        sendTwiml(res, buildEmptyResponseTwiml());
        return;
      }

      // Bump leads.outbound_attempt_count + last_outbound_attempt_at on
      // first transition only. Read-then-write race acknowledged
      // (Phase 0 low concurrency); Phase 1 RPC if needed.
      const { data: leadRow } = await supabase
        .from("leads")
        .select("outbound_attempt_count")
        .eq("id", call.lead_id)
        .maybeSingle();
      const currentCount =
        ((leadRow as { outbound_attempt_count?: number } | null)?.outbound_attempt_count) ?? 0;
      await supabase
        .from("leads")
        .update({
          outbound_attempt_count: currentCount + 1,
          last_outbound_attempt_at: nowIso,
        })
        .eq("id", call.lead_id);

      if (call.campaign_id) {
        await incrementCampaignFailedCounter(supabase, call.campaign_id);
      }
    }
    sendTwiml(res, buildEmptyResponseTwiml());
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/twilio/outbound-voice/status", leadCallId },
    });
    sendTwiml(res, buildEmptyResponseTwiml());
  }
});

// ── Counter helpers ──────────────────────────────────────────────────
// Read-then-write under Phase 0's low-concurrency assumption. Two
// independent counter slices so the AMD / status race doesn't double-
// count:
//
//   incrementCampaignCompletedCounter — bumps completed_count.
//     Run by the status handler on the FIRST 'completed' transition.
//
//   incrementCampaignTerminalCounter — bumps succeeded_count OR
//     voicemail_count based on answered_by. Run by whichever of
//     (AMD handler, status handler) lands SECOND: if status sees
//     answered_by already set, it runs the terminal counter inline;
//     otherwise the AMD handler runs it once status=='completed' by
//     the time AMD lands.
//
//   incrementCampaignFailedCounter — bumps failed_count + completed_count
//     in one go. Used only on no-answer/busy/failed/canceled.

async function incrementCampaignCompletedCounter(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const { data } = await supabase
    .from("outbound_campaigns")
    .select("completed_count")
    .eq("id", campaignId)
    .maybeSingle();
  const current = ((data as { completed_count?: number } | null)?.completed_count) ?? 0;
  await supabase
    .from("outbound_campaigns")
    .update({ completed_count: current + 1, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
}

async function incrementCampaignTerminalCounter(
  supabase: SupabaseClient,
  campaignId: string,
  answeredBy: string,
): Promise<void> {
  const isHuman = answeredBy === "human";
  const isMachine = answeredBy.startsWith("machine") || answeredBy === "fax";
  if (!isHuman && !isMachine) return;

  const column = isHuman ? "succeeded_count" : "voicemail_count";
  const { data } = await supabase
    .from("outbound_campaigns")
    .select(column)
    .eq("id", campaignId)
    .maybeSingle();
  const current = ((data as Record<string, number | undefined> | null)?.[column]) ?? 0;
  await supabase
    .from("outbound_campaigns")
    .update({ [column]: current + 1, updated_at: new Date().toISOString() })
    .eq("id", campaignId);
}

async function incrementCampaignFailedCounter(
  supabase: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const { data } = await supabase
    .from("outbound_campaigns")
    .select("completed_count, failed_count")
    .eq("id", campaignId)
    .maybeSingle();
  const row = (data as { completed_count?: number; failed_count?: number } | null) ?? {};
  const completed = row.completed_count ?? 0;
  const failed = row.failed_count ?? 0;
  await supabase
    .from("outbound_campaigns")
    .update({
      completed_count: completed + 1,
      failed_count: failed + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);
}

export default router;
