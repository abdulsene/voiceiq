/**
 * Phase 3.2 — topic-aware routing webhook + call-control leg.
 *
 *   POST /api/routing/route-to-topic
 *     Bearer-authenticated via ELEVENLABS_TOOL_SECRET (same shared
 *     secret as /api/leads/capture and /api/leads/record-appointment).
 *     Invoked by Alex's `route_to_topic` ElevenLabs tool mid-conversation.
 *
 *   GET  /api/routing/whisper
 *   POST /api/routing/whisper
 *     PUBLIC (bypass-listed in app.ts). Twilio hits this URL when a rung
 *     staff member answers — the TwiML we return plays a <Say> to the
 *     staff only (customer hears silence) before Twilio bridges the two
 *     legs. `text` query param is the pre-composed whisper string.
 *
 *     Phase 3.6: registered for BOTH verbs. Twilio's `<Number url=...>`
 *     and `<Client url=...>` default to method="POST"; the pre-3.6
 *     GET-only registration 404'd every whisper in production since 3.2a
 *     (Twilio error 11200, confirmed via Request Inspector 2026-07-30).
 *     dial-builder now also emits an explicit method="GET" on the url
 *     attribute so the contract is stated rather than inherited, but
 *     accepting POST is the belt-and-braces guarantee against the same
 *     latent bug recurring anywhere else that ever hits this route.
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
 *     staff_count:     number,     // Phase 3.7: number of CANDIDATES
 *                                  // being rung (each candidate may
 *                                  // contribute a <Client> browser leg,
 *                                  // a <Number> cell leg, or both).
 *                                  // Pre-3.7 this counted only cells
 *                                  // via decision.staffPhones, which
 *                                  // reported 0 for in-app-only staff
 *                                  // — misleading the LLM about
 *                                  // availability. 0 for callback /
 *                                  // graceful / after-hours paths.
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
// Phase 3.3a — moved to lib/ so both this router and routes/voice.ts
// can import the same value (was previously duplicated locally as
// DEVICE_FRESHNESS_SECS_ROUTING).
import { DEVICE_FRESHNESS_SECS } from "../lib/routing/constants";
// Phase 3.4 — see lib/public-url.ts header. Single source of truth
// for the base URL Twilio callbacks use AND that we verify against.
import { getPublicApiBase } from "../lib/public-url";

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

// Phase 3.4 — delegate to the single-source-of-truth helper. The
// local `PUBLIC_URL || APP_URL || "https://neverr.ai"` implementation
// caused the sev-1 dial-status failure: the URL we told Twilio to
// call back on didn't match the URL twilio-signature.ts reconstructed
// for HMAC verification. See lib/public-url.ts header for the full
// incident context.
function getPublicUrl(): string {
  return getPublicApiBase();
}

/**
 * Minimal Twilio REST surface used by the routing handler. Kept as an
 * interface (not the concrete twilio client type) so smoke tests can
 * swap in a mock without pulling the whole client type surface.
 *
 * Phase 3.5 — added .fetch() so handleDialStatus can look up the
 * child leg's actual `to` field. Twilio's <Dial action> callback body
 * only carries the ORIGINAL inbound call parameters (To = business's
 * inbound number), NEVER the child leg's To. The reliable way to
 * learn "did a browser or a cell win the race" from the action
 * callback is to REST-fetch DialCallSid.
 */
export interface TwilioCallControl {
  calls(sid: string): {
    update(opts: { twiml: string }): Promise<unknown>;
    fetch(): Promise<{ to?: string | null } & Record<string, unknown>>;
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
  /**
   * Phase 3.4 — caller-facing "connecting you now" message played
   * BEFORE the ring starts. Distinct from transferWarmMessage which
   * is played to the STAFF (the whisper) on answer.
   */
  transferWaitMessage: string | null;
  callerId: string;
  departments: Array<{ slug: string; name: string }>;
}

async function loadBusinessContext(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessContext | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("business_name, transfer_to_phone, transfer_warm_message, transfer_wait_message, twilio_phone_number, phone_number, departments")
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
    transferWaitMessage: row.transfer_wait_message || null,
    callerId: row.twilio_phone_number || row.phone_number || "",
    departments,
  };
}

interface UserBusinessRow {
  user_id: string;
  callback_ring_number: string | null;
  client_identity?: string | null;
  in_app_calling_enabled?: boolean | null;
  voice_device_last_seen_at?: string | null;
}

/**
 * Phase 3.3 — decide whether a user_businesses row contributes a live
 * <Client> leg. Returns the client_identity iff in-app calling is
 * enabled AND the device has been seen within DEVICE_FRESHNESS_SECS.
 * Otherwise null → the dial-builder emits no <Client> for this user.
 */
function liveClientIdentity(row: UserBusinessRow, now: Date = new Date()): string | null {
  if (!row.in_app_calling_enabled) return null;
  if (!row.client_identity) return null;
  const last = row.voice_device_last_seen_at ? Date.parse(row.voice_device_last_seen_at) : NaN;
  if (Number.isNaN(last)) return null;
  const ageMs = now.getTime() - last;
  if (ageMs > DEVICE_FRESHNESS_SECS * 1000) return null;
  return row.client_identity;
}

/**
 * Phase 3.3 — a candidate is dialable iff EITHER a callback_ring_number
 * is set OR their device is live (returns a client identity). Anyone
 * who matches neither is dropped from the ring list so we don't emit
 * an empty <Client>-less <Number>-less TwiML fragment.
 */
function toCandidateOrNull(row: UserBusinessRow, now: Date = new Date()): StaffCandidate | null {
  const client = liveClientIdentity(row, now);
  if (!row.callback_ring_number && !client) return null;
  return {
    userId: row.user_id,
    callbackRingNumber: row.callback_ring_number,
    clientIdentity: client,
  };
}

async function loadOnDutyForTopic(
  supabase: SupabaseClient,
  businessId: string,
  topicSlug: string,
  now: Date = new Date(),
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
    .select("user_id, callback_ring_number, client_identity, in_app_calling_enabled, voice_device_last_seen_at")
    .eq("business_id", businessId)
    .eq("is_on_duty", true)
    .in("user_id", topicUserIds);
  if (ubErr) return [];

  return ((ubRows as UserBusinessRow[] | null) ?? [])
    .map((r) => toCandidateOrNull(r, now))
    .filter((c): c is StaffCandidate => c !== null);
}

async function loadOnDutyAny(
  supabase: SupabaseClient,
  businessId: string,
  now: Date = new Date(),
): Promise<StaffCandidate[]> {
  const { data, error } = await supabase
    .from("user_businesses")
    .select("user_id, callback_ring_number, client_identity, in_app_calling_enabled, voice_device_last_seen_at, on_duty_since")
    .eq("business_id", businessId)
    .eq("is_on_duty", true)
    .order("on_duty_since", { ascending: false });
  if (error) return [];
  return ((data as UserBusinessRow[] | null) ?? [])
    .map((r) => toCandidateOrNull(r, now))
    .filter((c): c is StaffCandidate => c !== null);
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
      ? loadOnDutyForTopic(supabase, business_id, topic_slug, now)
      : Promise.resolve([] as StaffCandidate[]),
    loadOnDutyAny(supabase, business_id, now),
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
    // Phase 3.5 — whisperUrl carries the shared params (text, business_id,
    // conversation_id). dial-builder appends per-candidate user_id + leg
    // so the whisper handler can attribute the answerer correctly. The
    // handler was previously blind to which candidate answered because
    // Twilio's <Dial action> callback carries the ORIGINAL inbound call
    // parameters (To = business's own inbound number), not the child
    // leg's — verified live 2026-07-30 22:58 (answered_via='pstn' on a
    // browser-answered call).
    const whisperUrl =
      `${getPublicUrl()}/api/routing/whisper` +
      `?text=${encodeURIComponent(whisperText)}` +
      `&business_id=${encodeURIComponent(business_id)}` +
      `&conversation_id=${encodeURIComponent(conversation_id)}`;
    const dialOpts: DialBuilderOptions = {
      callerId: biz.callerId,
      whisperUrl,
      recordingStatusUrl: `${getPublicUrl()}/api/twilio/recording-status`,
      dialStatusUrl: `${getPublicUrl()}/api/routing/dial-status?business_id=${encodeURIComponent(business_id)}&conversation_id=${encodeURIComponent(conversation_id)}`,
      // Phase 3.3 — pass the human-readable topic through as a
      // <Client> CustomParameter so the softphone UI can render
      // context ("Roadside & breakdown — incoming").
      topicName,
      // Phase 3.4 — caller-facing wait line + ringback so the customer
      // hears "Connecting you now…" followed by a US double-ring
      // during the up-to-30s browser ring window. Without both the
      // caller sat in dead silence — verified live 2026-07-30.
      waitMessage:
        biz.transferWaitMessage?.trim() ||
        "Connecting you now, one moment please.",
      // ringTone defaults to "us" inside the builder; explicit here
      // makes the intent visible at the call site.
      ringTone: "us",
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
    const upsertPayload: Record<string, unknown> = {
      call_sid: conversation_id,
      conversation_id,
      business_id,
      topic_slug,
      rung_user_ids: decision.staffUserIds,
      handoff_reason: decision.handoffReason,
      transfer_status: decision.transferStatus,
      direction: "inbound",
    };
    // Phase 3.3 — persist the real Twilio CallSid so failed-redirect
    // forensics don't require Sentry↔Twilio-console correlation. Only
    // written when present in the tool body (system__call_sid);
    // omitting keeps a fresh row NULL rather than overwriting a
    // legitimate value on re-run.
    if (call_sid) upsertPayload.twilio_call_sid = call_sid;

    const { error: upsertErr } = await supabase
      .from("calls")
      .upsert(upsertPayload, { onConflict: "call_sid" });
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
      // Phase 3.7 — count ALL candidates, not just those with a
      // callback_ring_number. Pre-3.7 used decision.staffPhones which
      // omits in-app-only staff (live browser, no cell). Live prod
      // confirmed the miss: handoff_reason='topic_match_ringing' with
      // staff_count=0 and one entry in rung_user_ids. That 0 goes to
      // the LLM as availability context — the AI would say "nobody's
      // available" while routing was actively ringing a browser.
      staff_count: decision.staffCandidates.length,
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
 * Parse a Twilio `To` field of shape `client:<identity>`. Returns the
 * identity string, or null for any other shape (E.164, sip:, empty,
 * non-string). Exported for tests.
 */
export function parseClientTo(to: string | undefined | null): string | null {
  if (typeof to !== "string") return null;
  const trimmed = to.trim();
  if (!trimmed.toLowerCase().startsWith("client:")) return null;
  const identity = trimmed.slice("client:".length).trim();
  return identity || null;
}

/**
 * Given the answered `To` from Twilio's Dial callback, look up which
 * auth.users.id it maps to AND how they answered (browser vs pstn).
 *
 * Phase 3.3 — the `To` can now be `client:<identity>` (browser Client
 * leg won the ring) or an E.164 (cell won the ring). We MUST branch
 * on shape first — pre-3.3 code ran the raw string through
 * normalizePhone(), which strips non-digits, meaning
 * "client:user_abc123def456" would collapse to "123456" and false-match
 * ANY staff whose cell ends in those digits. That's WRONG ATTRIBUTION,
 * not just a miss.
 *
 * Returns { userId, answeredVia } — answeredVia goes into
 * calls.answered_via for downstream reporting.
 */
async function resolveHandledByUserId(
  supabase: SupabaseClient,
  businessId: string,
  conversationId: string,
  answeredTo: string | undefined,
): Promise<{ userId: string | null; answeredVia: "browser" | "pstn" | null }> {
  if (!answeredTo) return { userId: null, answeredVia: null };

  // Branch FIRST on client: — bypass normalizePhone entirely so a UUID
  // can never accidentally match a cell number.
  const clientIdentity = parseClientTo(answeredTo);
  if (clientIdentity) {
    const { data } = await supabase
      .from("user_businesses")
      .select("user_id")
      .eq("business_id", businessId)
      .eq("client_identity", clientIdentity)
      .maybeSingle();
    const userId = (data as { user_id?: string } | null)?.user_id ?? null;
    return { userId, answeredVia: "browser" };
  }

  // PSTN path — same as Phase 3.2c: last-10-digits comparison against
  // rung_user_ids' callback_ring_number.
  const targetNorm = normalizePhone(answeredTo);
  if (!targetNorm) return { userId: null, answeredVia: null };

  const { data: callRow } = await supabase
    .from("calls")
    .select("rung_user_ids")
    .eq("business_id", businessId)
    .eq("call_sid", conversationId)
    .maybeSingle();
  const rungIds = (callRow as { rung_user_ids?: string[] } | null)?.rung_user_ids;
  if (!Array.isArray(rungIds) || rungIds.length === 0) {
    return { userId: null, answeredVia: "pstn" };
  }

  const { data: matches } = await supabase
    .from("user_businesses")
    .select("user_id, callback_ring_number")
    .eq("business_id", businessId)
    .in("user_id", rungIds);
  const match = ((matches as Array<{ user_id: string; callback_ring_number: string | null }> | null) ?? [])
    .find((r) => normalizePhone(r.callback_ring_number) === targetNorm);
  return { userId: match?.user_id ?? null, answeredVia: "pstn" };
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

/**
 * Phase 3.5 — Twilio-REST fallback. When the whisper handler couldn't
 * write attribution (legacy_transfer path with no user_id on the URL,
 * or whisper hit an error), we can still learn "which leg answered"
 * by fetching the child call via DialCallSid — Twilio populates the
 * child's `.to` with the actual dial target (`client:<identity>` for
 * browser, E.164 for cell).
 *
 * Returns null on any failure — the caller must treat null as "give
 * up, don't overwrite what's already in the row."
 */
async function fetchChildLegTo(
  twilioClient: TwilioCallControl | null,
  dialCallSid: string | undefined,
): Promise<string | null> {
  if (!twilioClient || !dialCallSid) return null;
  try {
    const call = await twilioClient.calls(dialCallSid).fetch();
    return typeof call?.to === "string" ? call.to : null;
  } catch (err: any) {
    Sentry.captureMessage("dial_status_child_leg_fetch_failed", {
      level: "warning",
      extra: { dialCallSid, error: err?.message },
    });
    return null;
  }
}

export interface HandleDialStatusOptions {
  /**
   * Injected Twilio client for the child-leg fallback. If null, the
   * REST lookup is skipped and attribution falls back to whatever
   * the whisper wrote (if anything).
   */
  twilioClient?: TwilioCallControl | null;
}

export async function handleDialStatus(
  supabase: SupabaseClient,
  body: DialStatusBody,
  now: Date = new Date(),
  opts: HandleDialStatusOptions = {},
): Promise<{ ok: true; transferStatus: string; handledByUserId: string | null } | { ok: false; error: string }> {
  const { business_id, conversation_id, DialCallStatus, To, DialCallSid } = body;
  if (!business_id || !conversation_id) return { ok: false, error: "missing business_id or conversation_id" };
  if (!DialCallStatus) return { ok: false, error: "missing DialCallStatus" };

  const mapped = mapDialStatus(DialCallStatus);

  // Phase 3.5 — read the current row FIRST. We need three things:
  //   1. handoff_reason: for *_ringing → *_answered promotion.
  //   2. handled_by_user_id: if the whisper already wrote it, DON'T
  //      overwrite. Whisper is authoritative because it fires on the
  //      leg that actually answered; the <Dial action> callback we're
  //      in right now carries the ORIGINAL inbound call's params, not
  //      the child leg's.
  //   3. answered_via: same — if whisper already wrote 'browser' or
  //      'pstn', preserve it.
  let currentHandoff: string | null | undefined;
  let existingHandledBy: string | null | undefined;
  let existingAnsweredVia: string | null | undefined;
  try {
    const { data: currentRow } = await supabase
      .from("calls")
      .select("handoff_reason, handled_by_user_id, answered_via, rung_user_ids")
      .eq("business_id", business_id)
      .eq("call_sid", conversation_id)
      .maybeSingle();
    const row = currentRow as
      | {
          handoff_reason?: string | null;
          handled_by_user_id?: string | null;
          answered_via?: string | null;
          rung_user_ids?: string[];
        }
      | null;
    currentHandoff = row?.handoff_reason;
    existingHandledBy = row?.handled_by_user_id;
    existingAnsweredVia = row?.answered_via;
  } catch (err: any) {
    // If we can't even read the row we still need to write the
    // status transition. Log and continue.
    Sentry.captureMessage("dial_status_row_read_failed", {
      level: "warning",
      extra: { business_id, conversation_id, error: err?.message },
    });
  }

  // Resolve attribution ONLY when we don't already have it AND the
  // call was answered. Order of preference:
  //   1. Value already in the row (whisper wrote it — authoritative).
  //   2. `To` field on this callback (mostly unreliable — carries the
  //      inbound number — but if it IS a client: uri, use it).
  //   3. REST-fetched child leg from DialCallSid — the reliable
  //      fallback for legacy_transfer where whisper had no user_id.
  let resolvedUserId: string | null = existingHandledBy || null;
  let resolvedAnsweredVia: "browser" | "pstn" | null =
    existingAnsweredVia === "browser" || existingAnsweredVia === "pstn"
      ? existingAnsweredVia
      : null;

  if (mapped.transferAnswered && (!resolvedUserId || !resolvedAnsweredVia)) {
    // The callback's own `To` is USELESS for attribution — it always
    // carries the ORIGINAL inbound call's To (the business's inbound
    // number), NEVER the child leg's target. Documented in
    // TwilioCallControl.fetch's header. Always REST-fetch the child
    // leg via DialCallSid to learn what actually answered.
    const attrTo = await fetchChildLegTo(opts.twilioClient ?? getTwilioClient(), DialCallSid);
    if (attrTo) {
      const resolved = await resolveHandledByUserId(supabase, business_id, conversation_id, attrTo);
      if (!resolvedUserId && resolved.userId) resolvedUserId = resolved.userId;
      if (!resolvedAnsweredVia && resolved.answeredVia) resolvedAnsweredVia = resolved.answeredVia;
    } else if (To) {
      // Last-ditch: if REST fails / no DialCallSid, try the callback
      // To anyway. This will almost never yield useful attribution,
      // but if a hypothetical caller shape ever DID pass the child
      // leg's To, we'd honour it. Logged so we can see when it fires.
      Sentry.captureMessage("dial_status_attribution_using_callback_to_fallback", {
        level: "warning",
        extra: { business_id, conversation_id, To, DialCallSid },
      });
      const resolved = await resolveHandledByUserId(supabase, business_id, conversation_id, To);
      if (!resolvedUserId && resolved.userId) resolvedUserId = resolved.userId;
      if (!resolvedAnsweredVia && resolved.answeredVia) resolvedAnsweredVia = resolved.answeredVia;
    }
  }

  const patch: Record<string, unknown> = {
    transfer_status: mapped.transferStatus,
    transfer_answered: mapped.transferAnswered,
  };

  // Only write handled_by_user_id / handled_at if we HAVE a user AND
  // the whisper hasn't already written it. Same for answered_via.
  if (mapped.transferAnswered) {
    if (resolvedUserId && !existingHandledBy) {
      patch.handled_by_user_id = resolvedUserId;
      patch.handled_at = now.toISOString();
    }
    if (resolvedAnsweredVia && !existingAnsweredVia) {
      patch.answered_via = resolvedAnsweredVia;
    }
    // handoff_reason promotion — same rule as before, but now uses
    // the currentHandoff we read at the top.
    const promoted = promoteHandoffReasonOnAnswer(currentHandoff ?? null);
    if (promoted) patch.handoff_reason = promoted;
  } else if (DialCallStatus === "no-answer") {
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

  return {
    ok: true,
    transferStatus: mapped.transferStatus,
    handledByUserId: resolvedUserId,
  };
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

/**
 * Phase 3.5 — the whisper handler now doubles as our attribution
 * writer. Twilio fetches the whisper URL from the leg that ANSWERED,
 * before bridging, so this handler by construction knows which
 * candidate won the race. That's the correct source of truth for
 * handled_by_user_id / answered_via — much more reliable than
 * inspecting the <Dial action> callback, which carries the ORIGINAL
 * inbound call's parameters, not the answering child leg's.
 *
 * Contract:
 *   - MUST always return 200 with valid TwiML. Twilio plays "an
 *     application error has occurred" AUDIBLY to the answerer if
 *     this handler ever returns non-2xx or malformed XML. Every
 *     failure mode (missing text, DB down, exception thrown) falls
 *     through to an empty <Response/>.
 *   - Attribution writes are best-effort. A failed write logs to
 *     Sentry; the TwiML still plays. handleDialStatus's Twilio-REST
 *     fallback covers the miss.
 */
export interface WhisperHandlerContext {
  text: string;
  business_id: string | null;
  conversation_id: string | null;
  user_id: string | null;
  leg: "client" | "number" | null;
}

export function parseWhisperQuery(query: Record<string, unknown>): WhisperHandlerContext {
  const s = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const raw = typeof query.text === "string" ? query.text : "";
  const trimmedText = raw.length > 300 ? raw.slice(0, 297) + "..." : raw;
  const legRaw = s(query.leg);
  const leg = legRaw === "client" || legRaw === "number" ? legRaw : null;
  return {
    text: trimmedText,
    business_id: s(query.business_id),
    conversation_id: s(query.conversation_id),
    user_id: s(query.user_id),
    leg,
  };
}

/**
 * Do the attribution write. Exported for the smoke — asserts we
 * write only when we have the (biz, conv, user, leg) tuple, and that
 * every failure is swallowed rather than surfaced.
 */
export async function writeWhisperAttribution(
  supabase: SupabaseClient,
  ctx: WhisperHandlerContext,
  now: Date = new Date(),
): Promise<{ wrote: boolean; skippedReason?: string }> {
  if (!ctx.business_id || !ctx.conversation_id) {
    return { wrote: false, skippedReason: "missing business_id or conversation_id" };
  }
  if (!ctx.user_id || !ctx.leg) {
    // Legacy_transfer path — no user_id on the URL. Attribution here
    // is deferred to handleDialStatus's Twilio-REST fallback.
    return { wrote: false, skippedReason: "no user_id/leg on whisper url" };
  }
  const patch = {
    handled_by_user_id: ctx.user_id,
    handled_at: now.toISOString(),
    answered_via: ctx.leg === "client" ? "browser" : "pstn",
  };
  try {
    const { error } = await supabase
      .from("calls")
      .update(patch)
      .eq("business_id", ctx.business_id)
      .eq("call_sid", ctx.conversation_id);
    if (error) {
      Sentry.captureMessage("whisper_attribution_write_failed", {
        level: "warning",
        extra: { business_id: ctx.business_id, conversation_id: ctx.conversation_id, error: error.message },
      });
      return { wrote: false, skippedReason: error.message };
    }
    return { wrote: true };
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: {
        where: "writeWhisperAttribution",
        business_id: ctx.business_id,
        conversation_id: ctx.conversation_id,
      },
    });
    return { wrote: false, skippedReason: err?.message || "threw" };
  }
}

/**
 * Phase 3.6 — extracted so both GET and POST registrations share ONE
 * implementation. Twilio POSTs the whisper URL by default (see
 * <Number url> / <Client url> attribute docs); pre-3.6 we only
 * registered GET and every whisper 404'd for months.
 */
async function whisperHandler(req: Request, res: Response): Promise<void> {
  // Compose the response FIRST — every path below must send 200
  // valid TwiML no matter what fails. Attribution write is fire-
  // and-forget after the response.
  let ctx: WhisperHandlerContext;
  try {
    ctx = parseWhisperQuery(req.query as Record<string, unknown>);
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "whisper.parseQuery" } });
    res
      .status(200)
      .type("text/xml")
      .send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }

  const speak = ctx.text || "Incoming call. Connecting now.";
  let twimlOut: string;
  try {
    twimlOut = buildWhisperTwiml(speak);
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "whisper.buildTwiml" } });
    twimlOut = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }
  res.status(200).type("text/xml").send(twimlOut);

  // Attribution write — after the TwiML response so a slow DB
  // never delays Twilio's bridge. Errors are captured to Sentry
  // and swallowed.
  const supabase = getSupabase();
  if (supabase) {
    void writeWhisperAttribution(supabase, ctx).catch((err) => {
      Sentry.captureException(err, { extra: { where: "whisper.writeAttribution.reject" } });
    });
  }
}

// Phase 3.6 — accept BOTH GET and POST. Twilio's <Number url> /
// <Client url> default to POST; historical registration was GET-only,
// causing 11200 404 on every whisper. router.route(...).get().post()
// binds the same handler to both verbs; query params arrive on both.
router.route("/routing/whisper").get(whisperHandler).post(whisperHandler);

router.post(
  "/routing/dial-status",
  async (req: Request, res: Response): Promise<void> => {
    // Phase 3.4 — ALWAYS return 200 to Twilio, even on signature
    // failure. A mid-call <Dial action> callback that returns non-2xx
    // makes Twilio play "an application error has occurred" AUDIBLY
    // to the customer (verified live: two calls on 2026-07-30 rang
    // the browser, our verify failed (URL-drift bug), and both
    // callers heard the error message). Any auth failure here is our
    // internal problem; the caller must never learn about it.
    //
    // Signature failures still get logged to Sentry with the full
    // attempt list (twilio-signature.ts:twilio_signature_verify_failed_all_candidates)
    // so ops can chase config drift without a customer-audible signal.
    if (!verifyTwilioSignature(req)) {
      Sentry.captureMessage("dial_status_signature_rejected", {
        level: "error",
        extra: {
          path: req.originalUrl,
          note: "Returning 200 anyway — a non-2xx here plays an error to the caller. See twilio_signature_verify_failed_all_candidates for URL attempt details.",
        },
      });
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
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
    // Phase 3.5 — pass the Twilio client so handleDialStatus can
    // REST-fetch the child leg's `to` field when the whisper didn't
    // write attribution (legacy_transfer path, etc.). Without this
    // the dial-status callback has no reliable way to learn which
    // leg answered — the `To` on this callback carries the ORIGINAL
    // inbound number, not the child leg.
    await handleDialStatus(supabase, body, new Date(), { twilioClient: getTwilioClient() });
    // Return an empty <Response> so Twilio ends the leg cleanly (the
    // Dial verb has already terminated; nothing left to do).
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

export default router;
