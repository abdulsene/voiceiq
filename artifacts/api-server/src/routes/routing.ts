/**
 * Phase 3.2 — topic-aware routing webhook + call-control leg.
 *
 *   POST /api/routing/route-to-topic
 *     Bearer-authenticated via ELEVENLABS_TOOL_SECRET (same shared
 *     secret as /api/leads/capture and /api/leads/record-appointment).
 *     Invoked by Alex's `route_to_topic` ElevenLabs tool mid-conversation.
 *
 *   GET  /api/routing/whisper
 *     PUBLIC (bypass-listed in app.ts). Twilio hits this URL when a rung
 *     staff member answers — the TwiML we return plays a <Say> to the
 *     staff only (customer hears silence) before Twilio bridges the two
 *     legs. `text` query param is the pre-composed whisper string.
 *
 *   POST /api/routing/dial-status
 *     PUBLIC (bypass-listed) but Twilio-signature-verified. Called by
 *     Twilio as the <Dial action=""> callback when the simultaneous-ring
 *     leg terminates (answered / no-answer / canceled). Writes handled_*
 *     + transfer_status transition to the calls row.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Request contract for /route-to-topic (auto-injected by ElevenLabs
 * from Twilio SIP metadata via dynamic_variable references in the tool
 * schema — LLM never fills these):
 *
 *   {
 *     business_id:     string,   // constant_value baked at PATCH time
 *     conversation_id: string,   // dynamic_variable system__conversation_id
 *     topic_slug:      string,   // enum built from business_configs.departments
 *     reason:          string,   // LLM-filled short natural-language reason
 *     call_sid:        string,   // dynamic_variable system__call_sid (Twilio CallSid)
 *   }
 *
 * Response body (JSON) — INTENTIONALLY SMALL. Alex speaks the
 * acknowledgement using topic_name; the actual dial happens
 * out-of-band via Twilio REST after ROUTING_REDIRECT_DELAY_MS so the
 * caller hears the acknowledgement before the stream is torn down.
 *
 *   {
 *     status:          'connecting' | 'taking_message' | 'no_help_available',
 *     topic_name:      string,     // display name of the matched topic
 *     staff_count:     number,     // number of cells being rung (0 for
 *                                  // callback / graceful paths)
 *     handoff_reason:  string,     // conventional label; also written to
 *                                  // calls.handoff_reason for reporting
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────
 * handoff_reason vs transfer_reason: as of Phase 3.2b, `handoff_reason`
 * is the CANONICAL routing-decision column. `transfer_reason` is
 * deprecated (kept in the schema for legacy pre-Phase-3.2 rows, no new
 * writes). See migration 040 header for the enumerated values.
 *
 * calls row update: best-effort UPDATE by (business_id, conversation_id).
 * The routing webhook fires mid-call, before the post-call insertion
 * webhook that populates the calls row. If the row doesn't exist we
 * Sentry-log the miss and continue — the acknowledgement + redirect
 * still succeed; only the logging degrades.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";
import twilio from "twilio";

import {
  decideRouting,
  type RoutingDecision,
  type RoutingInputs,
  type StaffCandidate,
} from "../lib/routing/fallback-logic";
import {
  buildDialTwiml,
  buildWhisperTwiml,
  composeWhisperText,
  type DialBuilderOptions,
} from "../lib/routing/dial-builder";
import { handleHoursNow } from "./hours";
import { verifyTwilioSignature } from "../lib/twilio-signature";

const router = Router();

const CONVERSATION_ID_MAX = 200;
const REASON_MAX = 500;
const TOPIC_SLUG_MAX = 100;
const BUSINESS_ID_MAX = 100;
const CALL_SID_MAX = 200;

/**
 * Milliseconds to wait between returning the tool response and issuing
 * the Twilio REST redirect. Gives Alex time to speak the "connecting
 * you now…" acknowledgement before the media stream is torn down.
 *
 * Phase 3.2c: reduced 2500 → 800. pre_tool_speech:'force' on the
 * tool schema (agents.ts) already ensures Alex speaks the
 * acknowledgement BEFORE the tool fires — the two mechanisms were
 * stacked; only one is needed. 800ms is a safety margin for LLM
 * finish-speaking + HTTP round-trip.
 *
 * Env-tunable for further live-call tuning without redeploy.
 *
 * ⚠️ Durability limitation: this uses in-process setTimeout — if the
 * api-server restarts / redeploys inside the delay window, the
 * redirect is LOST and the call sits in dead air until Twilio times
 * out. Acceptable at pilot scale; needs a durable job (Redis queue
 * / BullMQ) before multi-tenant. Tracked in PHASE_3_TRIAGE.md.
 */
const ROUTING_REDIRECT_DELAY_MS = Number.parseInt(
  process.env.ROUTING_REDIRECT_DELAY_MS || "800",
  10,
);

// ── Client helpers ──────────────────────────────────────────────────

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function getPublicUrl(): string {
  return (
    process.env.PUBLIC_URL ||
    process.env.APP_URL ||
    "https://neverr.ai"
  ).replace(/\/$/, "");
}

/**
 * Minimal Twilio REST surface used by the routing handler. Kept as an
 * interface (not the concrete twilio client type) so smoke tests can
 * swap in a mock without pulling the whole client type surface.
 */
export interface TwilioCallControl {
  calls(sid: string): {
    update(opts: { twiml: string }): Promise<unknown>;
  };
}

let _twilioClient: TwilioCallControl | null = null;
function getTwilioClient(): TwilioCallControl | null {
  if (_twilioClient) return _twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  _twilioClient = twilio(sid, token) as unknown as TwilioCallControl;
  return _twilioClient;
}

/**
 * Constant-time compare of the presented Bearer token against
 * ELEVENLABS_TOOL_SECRET. Verbatim copy of the pattern in
 * routes/leads.ts:verifyToolSecret.
 */
function verifyToolSecret(req: Request): boolean {
  const expected = process.env.ELEVENLABS_TOOL_SECRET;
  if (!expected) return false;
  const header = (req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const presented = header.slice(7).trim();
  if (presented.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Body validation ─────────────────────────────────────────────────

export interface RouteToTopicBody {
  business_id: string;
  conversation_id: string;
  topic_slug: string;
  reason: string;
  /**
   * Twilio CallSid, auto-injected by ElevenLabs via
   * dynamic_variable: 'system__call_sid' in the tool schema.
   * Optional in the body validator so callers can still trigger the
   * routing decision + logging even without a Twilio call (e.g. a
   * dev/simulation path). Absence → skip REST redirect, log Sentry warning.
   */
  call_sid?: string;
}

export function parseRouteBody(body: unknown): RouteToTopicBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;
  const need = (k: string, max: number): string | { error: string } => {
    const v = b[k];
    if (typeof v !== "string" || !v.trim()) return { error: `${k} is required` };
    if (v.length > max) return { error: `${k} exceeds ${max} characters` };
    return v.trim();
  };
  const business_id = need("business_id", BUSINESS_ID_MAX);
  if (typeof business_id !== "string") return business_id;
  const conversation_id = need("conversation_id", CONVERSATION_ID_MAX);
  if (typeof conversation_id !== "string") return conversation_id;
  const topic_slug = need("topic_slug", TOPIC_SLUG_MAX);
  if (typeof topic_slug !== "string") return topic_slug;
  const reason = need("reason", REASON_MAX);
  if (typeof reason !== "string") return reason;

  const parsed: RouteToTopicBody = { business_id, conversation_id, topic_slug, reason };
  const raw_sid = b["call_sid"];
  if (typeof raw_sid === "string" && raw_sid.trim()) {
    if (raw_sid.length > CALL_SID_MAX) {
      return { error: `call_sid exceeds ${CALL_SID_MAX} characters` };
    }
    parsed.call_sid = raw_sid.trim();
  }
  return parsed;
}

// ── State-fetch helpers ─────────────────────────────────────────────

interface BusinessContext {
  business_name: string;
  legacyTransferToPhone: string | null;
  transferWarmMessage: string | null;
  callerId: string;
  departments: Array<{ slug: string; name: string }>;
}

async function loadBusinessContext(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessContext | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("business_name, transfer_to_phone, transfer_warm_message, twilio_phone_number, phone_number, departments")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as any;
  const departments = Array.isArray(row.departments)
    ? (row.departments as any[]).filter(
        (t) => t && typeof t === "object" && typeof t.slug === "string" && typeof t.name === "string",
      )
    : [];
  return {
    business_name: row.business_name || "our team",
    legacyTransferToPhone: row.transfer_to_phone || null,
    transferWarmMessage: row.transfer_warm_message || null,
    callerId: row.twilio_phone_number || row.phone_number || "",
    departments,
  };
}

async function loadOnDutyForTopic(
  supabase: SupabaseClient,
  businessId: string,
  topicSlug: string,
): Promise<StaffCandidate[]> {
  const { data: topicRows, error: topicErr } = await supabase
    .from("staff_topics")
    .select("user_id")
    .eq("business_id", businessId)
    .eq("topic_slug", topicSlug);
  if (topicErr) return [];
  const topicUserIds = ((topicRows as Array<{ user_id: string }> | null) ?? []).map((r) => r.user_id);
  if (topicUserIds.length === 0) return [];

  const { data: ubRows, error: ubErr } = await supabase
    .from("user_businesses")
    .select("user_id, callback_ring_number")
    .eq("business_id", businessId)
    .eq("is_on_duty", true)
    .in("user_id", topicUserIds);
  if (ubErr) return [];

  return ((ubRows as Array<{ user_id: string; callback_ring_number: string | null }> | null) ?? [])
    .filter((r) => r.callback_ring_number)
    .map((r) => ({ userId: r.user_id, callbackRingNumber: r.callback_ring_number as string }));
}

async function loadOnDutyAny(
  supabase: SupabaseClient,
  businessId: string,
): Promise<StaffCandidate[]> {
  const { data, error } = await supabase
    .from("user_businesses")
    .select("user_id, callback_ring_number, on_duty_since")
    .eq("business_id", businessId)
    .eq("is_on_duty", true)
    .order("on_duty_since", { ascending: false });
  if (error) return [];
  return ((data as Array<{ user_id: string; callback_ring_number: string | null }> | null) ?? [])
    .filter((r) => r.callback_ring_number)
    .map((r) => ({ userId: r.user_id, callbackRingNumber: r.callback_ring_number as string }));
}

// ── Handler ─────────────────────────────────────────────────────────

/**
 * Public status label for the LLM-facing response — smaller alphabet
 * than the internal transferStatus enum. The LLM only cares about the
 * shape of "what do I say next".
 */
export type PublicRoutingStatus = "connecting" | "taking_message" | "no_help_available";

export interface RouteToTopicResult {
  status: PublicRoutingStatus;
  topic_name: string;
  staff_count: number;
  handoff_reason: string;
  /** Internal — smoke tests assert against this. Not part of the wire response. */
  decision: RoutingDecision;
  /** Internal — the TwiML that will be pushed via REST after the delay. Null for non-dial paths. */
  twiml: string | null;
}

function publicStatusFor(
  decision: RoutingDecision,
  redirectWillFire: boolean,
): PublicRoutingStatus {
  switch (decision.path) {
    case "topic_match":
    case "any_on_duty":
    case "legacy_transfer":
      // Phase 3.2c safe-failure: if the routing engine picked a dial
      // path but we cannot actually redirect the call (missing
      // call_sid, no Twilio client), tell the LLM to fall back to
      // request_callback instead of promising a connection that will
      // never happen. Otherwise Alex says "connecting you now…" and
      // the caller sits in dead air.
      return redirectWillFire ? "connecting" : "taking_message";
    case "after_hours_callback":
      return "taking_message";
    case "graceful_hangup":
      return "no_help_available";
  }
}

export interface HandleRouteToTopicOptions {
  /** Injected clock for deterministic tests. */
  now?: Date;
  /**
   * When provided, the handler schedules the Twilio REST redirect on
   * this client (dial paths only). Tests pass a mock; production wires
   * `getTwilioClient()`. If null, redirect is skipped entirely (still
   * logs) — useful for smoke-level tests that don't want to assert on
   * setTimeout timing.
   */
  twilioClient?: TwilioCallControl | null;
  /**
   * Override redirect delay for tests. Production uses
   * ROUTING_REDIRECT_DELAY_MS.
   */
  redirectDelayMs?: number;
  /**
   * Test hook: called synchronously with the REST call promise so
   * smoke can await the underlying update() without relying on
   * setTimeout timing. Fired after schedule, before delay elapses.
   */
  onRedirectScheduled?: (info: { callSid: string; twiml: string; delayMs: number }) => void;
}

export async function handleRouteToTopic(
  supabase: SupabaseClient,
  body: RouteToTopicBody,
  opts: HandleRouteToTopicOptions = {},
): Promise<
  | { ok: true; result: RouteToTopicResult }
  | { ok: false; status: number; error: string }
> {
  const { business_id, conversation_id, topic_slug, reason, call_sid } = body;
  const now = opts.now ?? new Date();

  const biz = await loadBusinessContext(supabase, business_id);
  if (!biz) return { ok: false, status: 404, error: "Business not found" };

  const topicConfigured = biz.departments.some((t) => t.slug === topic_slug);
  const topicName =
    biz.departments.find((t) => t.slug === topic_slug)?.name || topic_slug;

  const [onDutyForTopic, onDutyAny, hoursNow] = await Promise.all([
    topicConfigured
      ? loadOnDutyForTopic(supabase, business_id, topic_slug)
      : Promise.resolve([] as StaffCandidate[]),
    loadOnDutyAny(supabase, business_id),
    handleHoursNow(supabase, business_id, now),
  ]);

  const businessOpen = hoursNow.ok ? hoursNow.result.is_open : false;

  const inputs: RoutingInputs = {
    onDutyForTopic,
    onDutyAny,
    businessOpen,
    legacyTransferToPhone: biz.legacyTransferToPhone,
    topicConfigured,
  };
  const decision = decideRouting(inputs);

  // Build TwiML only for the paths that actually dial.
  let twiml: string | null = null;
  const isDialPath =
    decision.path === "topic_match" ||
    decision.path === "any_on_duty" ||
    decision.path === "legacy_transfer";
  if (isDialPath) {
    const whisperText = composeWhisperText({
      businessName: biz.business_name,
      topicName,
      overrideTemplate: biz.transferWarmMessage,
    });
    const whisperUrl = `${getPublicUrl()}/api/routing/whisper?text=${encodeURIComponent(whisperText)}`;
    const dialOpts: DialBuilderOptions = {
      callerId: biz.callerId,
      whisperUrl,
      recordingStatusUrl: `${getPublicUrl()}/api/twilio/recording-status`,
      dialStatusUrl: `${getPublicUrl()}/api/routing/dial-status?business_id=${encodeURIComponent(business_id)}&conversation_id=${encodeURIComponent(conversation_id)}`,
    };
    twiml = buildDialTwiml(decision, dialOpts);
  }

  // Phase 3.2c — UPSERT (not UPDATE) keyed on call_sid. The routing
  // webhook fires mid-call, BEFORE the post-call ElevenLabs webhook
  // (routes/api.ts:490) inserts the calls row. Previously we UPDATEd
  // by conversation_id which is NULL on 100% of production rows — the
  // routing metadata never persisted. Now:
  //
  //   * Row keyed on call_sid (which historically stores the ElevenLabs
  //     conversation_id in this codebase — see migration 041 header
  //     for the naming quirk). ON CONFLICT (call_sid) DO UPDATE via
  //     supabase-js `upsert(..., { onConflict: "call_sid" })`.
  //   * If a mid-call tool row already exists (e.g. from
  //     appointment_booking), the post-call handler will find and
  //     merge (routes/api.ts:490 uses caller_number + created_at
  //     lookup; our routing row is most-recent so it wins in the
  //     rare route+book combined-tool case).
  //   * `conversation_id` column is populated too (as an attribute) so
  //     future readers migrating away from the call_sid alias have
  //     the value on the same row.
  try {
    const { error: upsertErr } = await supabase
      .from("calls")
      .upsert(
        {
          call_sid: conversation_id,
          conversation_id,
          business_id,
          topic_slug,
          rung_user_ids: decision.staffUserIds,
          handoff_reason: decision.handoffReason,
          transfer_status: decision.transferStatus,
          direction: "inbound",
        },
        { onConflict: "call_sid" },
      );
    if (upsertErr) {
      Sentry.captureMessage("route_to_topic_calls_upsert_failed", {
        level: "error",
        extra: { business_id, conversation_id, error: upsertErr.message },
      });
    }
  } catch (err: any) {
    Sentry.captureMessage("route_to_topic_calls_upsert_threw", {
      level: "error",
      extra: { business_id, conversation_id, error: err?.message },
    });
  }

  // Decide whether the REST redirect can actually fire, so we can
  // return the honest status label. If a dial path was picked but we
  // can't complete the redirect (missing call_sid OR no Twilio
  // client), we must NOT tell the LLM "connecting" — the caller
  // would sit in dead air. See publicStatusFor.
  let redirectWillFire = false;
  if (isDialPath && twiml && call_sid) {
    const twilioClient = opts.twilioClient !== undefined ? opts.twilioClient : getTwilioClient();
    const delayMs = opts.redirectDelayMs ?? ROUTING_REDIRECT_DELAY_MS;
    if (twilioClient) {
      redirectWillFire = true;
      opts.onRedirectScheduled?.({ callSid: call_sid, twiml, delayMs });
      setTimeout(() => {
        void twilioClient
          .calls(call_sid)
          .update({ twiml })
          .catch((err: any) => {
            Sentry.captureException(err, {
              extra: {
                where: "route_to_topic redirect",
                business_id,
                conversation_id,
                call_sid,
              },
            });
          });
      }, delayMs);
    } else {
      Sentry.captureMessage("route_to_topic_redirect_skipped_no_twilio", {
        level: "warning",
        extra: { business_id, conversation_id, call_sid },
      });
    }
  } else if (isDialPath && !call_sid) {
    Sentry.captureMessage("route_to_topic_redirect_skipped_no_call_sid", {
      level: "warning",
      extra: {
        business_id,
        conversation_id,
        note: "system__call_sid missing from tool body; ElevenLabs schema may need update",
      },
    });
  }

  return {
    ok: true,
    result: {
      status: publicStatusFor(decision, redirectWillFire),
      topic_name: topicName,
      staff_count: decision.staffPhones.length,
      handoff_reason: decision.handoffReason,
      decision,
      twiml,
    },
  };
}

// ── Dial-status handler ─────────────────────────────────────────────

/**
 * Map Twilio's DialCallStatus to our transfer_status transition + the
 * transfer_answered boolean. Twilio values per docs:
 *   completed  — the called party answered and was connected
 *   busy       — the called party was busy (no ring)
 *   no-answer  — the called party did not answer within timeout
 *   canceled   — the call was canceled before it was answered
 *   failed     — a network failure prevented the dial
 *
 * For simultaneous ring, `completed` on ANY of the numbers means
 * someone answered — Twilio surfaces the winning DialCallSid.
 */
export function mapDialStatus(dialCallStatus: string): {
  transferStatus: string;
  transferAnswered: boolean;
} {
  switch (dialCallStatus) {
    case "completed":
    case "answered":
      return { transferStatus: "answered", transferAnswered: true };
    case "no-answer":
      return { transferStatus: "no_answer", transferAnswered: false };
    case "busy":
      return { transferStatus: "busy", transferAnswered: false };
    case "canceled":
      return { transferStatus: "canceled", transferAnswered: false };
    case "failed":
    default:
      return { transferStatus: "failed", transferAnswered: false };
  }
}

export interface DialStatusBody {
  business_id: string;
  conversation_id: string;
  DialCallStatus: string;
  DialCallSid?: string;
  /** The E.164 that answered / was rung — Twilio populates this on Dial. */
  To?: string;
  From?: string;
}

/**
 * Normalize a phone number to its last 10 digits for comparison.
 * Handles E.164 (+14155551234) vs national (415-555-1234) vs
 * parenthesized ((415) 555-1234) vs raw digits. Non-strings and
 * empties return "". Anything shorter than 10 digits after
 * normalization returns the raw digits (partial numbers won't match
 * anyway).
 *
 * Phase 3.2c — Twilio's `To` field on Dial callbacks is E.164 but our
 * `callback_ring_number` column could be stored in various formats
 * depending on the invite path; compare-by-normalized-last-10 avoids
 * silently failing to resolve handled_by_user_id due to formatting.
 */
export function normalizePhone(input: string | undefined | null): string {
  if (typeof input !== "string") return "";
  const digits = input.replace(/\D+/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Given the answered E.164 (`To` from Twilio's Dial callback), look up
 * which auth.users.id it maps to. Uses the rung_user_ids stored on the
 * calls row from route-to-topic + a per-user callback_ring_number join.
 * Best-effort: returns null if no match (Twilio can send this callback
 * even when nobody answered).
 *
 * Phase 3.2c — re-keyed to look up the calls row by call_sid
 * (which stores the ElevenLabs conversation_id in this codebase, per
 * migration 041 header). Phone comparison is normalized (last-10-digits)
 * to survive E.164 vs national format mismatches between Twilio's
 * callback (always E.164) and whatever the tenant admin entered in
 * their team settings.
 */
async function resolveHandledByUserId(
  supabase: SupabaseClient,
  businessId: string,
  conversationId: string,
  answeredPhone: string | undefined,
): Promise<string | null> {
  if (!answeredPhone) return null;
  const targetNorm = normalizePhone(answeredPhone);
  if (!targetNorm) return null;

  const { data: callRow } = await supabase
    .from("calls")
    .select("rung_user_ids")
    .eq("business_id", businessId)
    .eq("call_sid", conversationId)
    .maybeSingle();
  const rungIds = (callRow as { rung_user_ids?: string[] } | null)?.rung_user_ids;
  if (!Array.isArray(rungIds) || rungIds.length === 0) return null;

  const { data: matches } = await supabase
    .from("user_businesses")
    .select("user_id, callback_ring_number")
    .eq("business_id", businessId)
    .in("user_id", rungIds);
  const match = ((matches as Array<{ user_id: string; callback_ring_number: string | null }> | null) ?? [])
    .find((r) => normalizePhone(r.callback_ring_number) === targetNorm);
  return match?.user_id ?? null;
}

/**
 * Promote a routing-time handoff_reason ending in "_ringing" to its
 * "_answered" counterpart. Returns null if the reason isn't in the
 * ringing family — the caller should NOT overwrite handoff_reason in
 * that case. Race flags like `topic_no_longer_configured` are preserved.
 */
export function promoteHandoffReasonOnAnswer(current: string | null | undefined): string | null {
  if (!current || typeof current !== "string") return null;
  if (current.endsWith("_ringing")) {
    return current.slice(0, -"_ringing".length) + "_answered";
  }
  return null;
}

export async function handleDialStatus(
  supabase: SupabaseClient,
  body: DialStatusBody,
  now: Date = new Date(),
): Promise<{ ok: true; transferStatus: string; handledByUserId: string | null } | { ok: false; error: string }> {
  const { business_id, conversation_id, DialCallStatus, To } = body;
  if (!business_id || !conversation_id) return { ok: false, error: "missing business_id or conversation_id" };
  if (!DialCallStatus) return { ok: false, error: "missing DialCallStatus" };

  const mapped = mapDialStatus(DialCallStatus);
  const handledByUserId = mapped.transferAnswered
    ? await resolveHandledByUserId(supabase, business_id, conversation_id, To)
    : null;

  // Phase 3.2c — separate concerns:
  //   * transfer_status   = ALWAYS updated (this is the state machine)
  //   * transfer_answered = ALWAYS updated (mirrors DialCallStatus)
  //   * handled_by_user_id + handled_at = only on answered
  //   * handoff_reason    = ONLY touched in two cases:
  //       (1) DialCallStatus=completed: promote *_ringing → *_answered
  //           (routing labelled *_ringing at tool-time; dial-completed
  //            confirms someone actually picked up).
  //       (2) DialCallStatus=no-answer: escalate to
  //           'all_staff_no_answer' (routing rang, everyone timed out).
  //       Do NOT touch handoff_reason on busy / canceled / failed:
  //       those are Twilio call-outcome details, orthogonal to which
  //       routing PATH the engine took. The routing path stays in
  //       handoff_reason; the outcome lives in transfer_status.
  const patch: Record<string, unknown> = {
    transfer_status: mapped.transferStatus,
    transfer_answered: mapped.transferAnswered,
  };
  if (handledByUserId) {
    patch.handled_by_user_id = handledByUserId;
    patch.handled_at = now.toISOString();
  }

  if (mapped.transferAnswered) {
    // Promote *_ringing → *_answered. Requires reading the current
    // handoff_reason. If we can't read it (row missing, other error),
    // leave the column alone — better to preserve than to overwrite
    // with the wrong _answered variant.
    const { data: currentRow } = await supabase
      .from("calls")
      .select("handoff_reason")
      .eq("business_id", business_id)
      .eq("call_sid", conversation_id)
      .maybeSingle();
    const current = (currentRow as { handoff_reason?: string | null } | null)?.handoff_reason;
    const promoted = promoteHandoffReasonOnAnswer(current);
    if (promoted) patch.handoff_reason = promoted;
  } else if (DialCallStatus === "no-answer") {
    // ONLY no-answer escalates — that's the "we tried, nobody picked
    // up" signal. busy / canceled / failed reflect Twilio call-outcome
    // metadata that doesn't invalidate the routing path chosen.
    patch.handoff_reason = "all_staff_no_answer";
  }

  try {
    await supabase
      .from("calls")
      .update(patch)
      .eq("business_id", business_id)
      .eq("call_sid", conversation_id);
  } catch (err: any) {
    Sentry.captureMessage("dial_status_update_failed", {
      level: "warning",
      extra: { business_id, conversation_id, error: err?.message },
    });
  }

  return { ok: true, transferStatus: mapped.transferStatus, handledByUserId };
}

// ── Express route registrations ─────────────────────────────────────

router.post(
  "/routing/route-to-topic",
  async (req: Request, res: Response): Promise<void> => {
    if (!verifyToolSecret(req)) {
      res.status(401).json({ error: "Invalid tool secret" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const parsed = parseRouteBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handleRouteToTopic(supabase, parsed);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // Strip internal-only fields before returning to ElevenLabs.
    const { decision: _drop1, twiml: _drop2, ...publicPayload } = result.result;
    res.json(publicPayload);
  },
);

router.get(
  "/routing/whisper",
  (req: Request, res: Response): void => {
    const raw = typeof req.query.text === "string" ? req.query.text : "";
    const text = raw.length > 300 ? raw.slice(0, 297) + "..." : raw;
    const fallback = text || "Incoming call. Connecting now.";
    res.type("text/xml").send(buildWhisperTwiml(fallback));
  },
);

router.post(
  "/routing/dial-status",
  async (req: Request, res: Response): Promise<void> => {
    // Signature verification: Twilio signs POSTs to our callback URLs.
    // Refuse forged requests but always respond 200 (Twilio retries
    // aggressively on non-2xx and there's nothing productive it can do
    // with the retry).
    if (!verifyTwilioSignature(req)) {
      res.status(401).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      // Nothing to log against — just 200 to end Twilio's retry loop.
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const business_id =
      (req.query.business_id as string) || (req.body?.business_id as string) || "";
    const conversation_id =
      (req.query.conversation_id as string) || (req.body?.conversation_id as string) || "";
    const body: DialStatusBody = {
      business_id,
      conversation_id,
      DialCallStatus: (req.body?.DialCallStatus as string) || "",
      DialCallSid: (req.body?.DialCallSid as string) || undefined,
      To: (req.body?.To as string) || undefined,
      From: (req.body?.From as string) || undefined,
    };
    await handleDialStatus(supabase, body);
    // Return an empty <Response> so Twilio ends the leg cleanly (the
    // Dial verb has already terminated; nothing left to do).
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

export default router;
