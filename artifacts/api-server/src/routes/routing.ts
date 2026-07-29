/**
 * Phase 3.2a — topic-aware routing webhook.
 *
 *   POST /api/routing/route-to-topic
 *     Bearer-authenticated via ELEVENLABS_TOOL_SECRET (same shared
 *     secret as /api/leads/capture and /api/leads/record-appointment).
 *     Invoked by Alex's `route_to_topic` ElevenLabs tool mid-conversation
 *     (Phase 3.2b will register the tool via updateAgentTools()).
 *
 *   GET  /api/routing/whisper
 *     PUBLIC (no auth). Twilio hits this URL when a rung staff member
 *     answers — the TwiML we return plays a whisper to the staff only
 *     (customer hears silence) before Twilio bridges the two legs.
 *     `text` query param is the pre-composed whisper string; kept as
 *     query rather than baked at agent-config time so per-call topic
 *     context can be injected.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Request contract for /route-to-topic:
 *   {
 *     business_id:     string,   // tenant scope
 *     conversation_id: string,   // ElevenLabs conversation id, used to
 *                                // locate the calls row for logging
 *     topic_slug:      string,   // Alex's identified topic (enum built
 *                                // from business_configs.departments)
 *     reason:          string,   // Alex's short natural-language reason
 *                                // (currently logged only; may drive
 *                                //  richer prompts in 3.5)
 *   }
 *
 * Response body (JSON):
 *   {
 *     status:          'routing_topic_match'
 *                     | 'routing_any_on_duty'
 *                     | 'legacy_transfer_to_phone'
 *                     | 'after_hours_callback'
 *                     | 'graceful_hangup',
 *     message_for_llm: string,   // Verbatim line Alex should say to the
 *                                // caller before / instead of transferring
 *     twiml:           string | null,  // Non-null for dial paths; null
 *                                // for after_hours / graceful (LLM
 *                                // stays on the line via existing tools)
 *     staff_count:     number,   // Rung count (0 for legacy/callback paths)
 *     handoff_reason:  string,   // Same value written to calls.handoff_reason
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────
 * calls row update: best-effort UPDATE by (business_id, conversation_id).
 * If the row doesn't exist yet (post-call webhook hasn't inserted it),
 * we log a Sentry warning and continue — routing metadata will still
 * ship in the response, but won't be persisted. Phase 3.2b integration
 * addresses this by either adding a UNIQUE(conversation_id) upsert
 * path or writing routing metadata via a mid-call INSERT.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

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

const router = Router();

const CONVERSATION_ID_MAX = 200;
const REASON_MAX = 500;
const TOPIC_SLUG_MAX = 100;
const BUSINESS_ID_MAX = 100;

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
 * Constant-time compare of the presented Bearer token against
 * ELEVENLABS_TOOL_SECRET. Verbatim copy of the pattern in
 * routes/leads.ts:verifyToolSecret — kept local rather than exported
 * so the two auth paths are independently reviewable.
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
  return { business_id, conversation_id, topic_slug, reason };
}

// ── State-fetch helpers (pure inputs → tuple of DB reads) ───────────

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
    // Prefer Neverr-provisioned Twilio number as caller ID; fall back to
    // business_configs.phone_number (their existing DID). Downstream
    // libs (twilio-caller-id.ts) do fancier resolution but for the
    // routing leg this baseline is enough — 3.2b integration can adopt
    // the shared caller-id helper.
    callerId: row.twilio_phone_number || row.phone_number || "",
    departments,
  };
}

async function loadOnDutyForTopic(
  supabase: SupabaseClient,
  businessId: string,
  topicSlug: string,
): Promise<StaffCandidate[]> {
  // Two-step: first find on-duty user_ids assigned to the topic, then
  // fetch their callback_ring_number. supabase-js embedded joins don't
  // fluently express "AND" across two source tables + a filter clause,
  // and we already denormalize business_id onto staff_topics
  // (migration 037) precisely to make this cheap.
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
    // Most-recently-clocked-in first (Phase A lock-in: fresh employees
    // are more attentive than staff who've been on-duty for hours).
    .order("on_duty_since", { ascending: false });
  if (error) return [];
  return ((data as Array<{ user_id: string; callback_ring_number: string | null }> | null) ?? [])
    .filter((r) => r.callback_ring_number)
    .map((r) => ({ userId: r.user_id, callbackRingNumber: r.callback_ring_number as string }));
}

// ── Core handler (exported for smoke tests) ─────────────────────────

export interface RouteToTopicResult {
  status: string;
  message_for_llm: string;
  twiml: string | null;
  staff_count: number;
  handoff_reason: string;
  /** Populated for observability — smoke tests assert against this. */
  decision: RoutingDecision;
}

/**
 * Compose the line the LLM should say to the caller for a given path.
 * Kept small on purpose — the tone stays natural because the LLM will
 * paraphrase in the caller's language rather than reading verbatim.
 */
function messageForLlm(
  decision: RoutingDecision,
  topicName: string,
): string {
  switch (decision.path) {
    case "topic_match":
      return `Great — let me connect you with our ${topicName} team right now. One moment.`;
    case "any_on_duty":
      return `Let me get someone on the line for you now. One moment.`;
    case "legacy_transfer":
      return `Let me get you connected with the team right now.`;
    case "after_hours_callback":
      return `We're currently closed, but I can take a message and someone will get back to you as soon as we reopen. May I get your name and a callback number?`;
    case "graceful_hangup":
      return `I don't have anyone available to help with that right now. Would you like me to take a message and have someone reach out to you?`;
  }
}

export async function handleRouteToTopic(
  supabase: SupabaseClient,
  body: RouteToTopicBody,
  now: Date = new Date(),
): Promise<
  | { ok: true; result: RouteToTopicResult }
  | { ok: false; status: number; error: string }
> {
  const { business_id, conversation_id, topic_slug, reason } = body;

  const biz = await loadBusinessContext(supabase, business_id);
  if (!biz) return { ok: false, status: 404, error: "Business not found" };

  const topicConfigured = biz.departments.some((t) => t.slug === topic_slug);
  const topicName =
    biz.departments.find((t) => t.slug === topic_slug)?.name || topic_slug;

  // Load on-duty candidates. Both fetches run concurrently.
  const [onDutyForTopic, onDutyAny, hoursNow] = await Promise.all([
    topicConfigured
      ? loadOnDutyForTopic(supabase, business_id, topic_slug)
      : Promise.resolve([] as StaffCandidate[]),
    loadOnDutyAny(supabase, business_id),
    handleHoursNow(supabase, business_id, now),
  ]);

  // "Open" only when the hours engine says so. On error, we conservatively
  // treat as closed — that pushes callers to the callback path rather
  // than blindly dialing legacy_transfer_to_phone with no idea whether
  // the business is even open.
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
  if (decision.path === "topic_match" || decision.path === "any_on_duty" || decision.path === "legacy_transfer") {
    const whisperText = composeWhisperText({
      businessName: biz.business_name,
      topicName,
      overrideTemplate: biz.transferWarmMessage,
    });
    const whisperUrl = `${getPublicUrl()}/api/routing/whisper?text=${encodeURIComponent(whisperText)}`;
    const dialOpts: DialBuilderOptions = {
      callerId: biz.callerId,
      whisperUrl,
      // Reuse existing recording-status webhook — same handler that
      // processes lead-bridge recordings (Slice 2A).
      recordingStatusUrl: `${getPublicUrl()}/api/twilio/recording-status`,
      // Dial status callback: emitted at end of the Dial verb so we can
      // move transfer_status from "routing_*" → "answered" / "no_answer"
      // in Phase 3.2b. For 3.2a we still populate the attribute so Twilio
      // will send us the event when 3.2b lands the handler.
      dialStatusUrl: `${getPublicUrl()}/api/routing/dial-status`,
    };
    twiml = buildDialTwiml(decision, dialOpts);
  }

  // Best-effort UPDATE of the calls row for logging. If the row doesn't
  // exist yet (post-call webhook hasn't fired), log a Sentry warning
  // and continue — routing metadata still ships in the response body
  // so 3.2b can pipe it through a different mechanism.
  try {
    const { data: updated, error: updateErr } = await supabase
      .from("calls")
      .update({
        topic_slug,
        rung_user_ids: decision.staffUserIds,
        handoff_reason: decision.handoffReason,
        transfer_status: decision.transferStatus,
        transfer_reason: reason,
      })
      .eq("business_id", business_id)
      .eq("conversation_id", conversation_id)
      .select("id")
      .maybeSingle();
    if (updateErr) {
      Sentry.captureMessage("route_to_topic_calls_update_failed", {
        level: "warning",
        extra: { business_id, conversation_id, error: updateErr.message },
      });
    } else if (!updated) {
      Sentry.captureMessage("route_to_topic_calls_row_missing", {
        level: "warning",
        extra: { business_id, conversation_id, note: "calls row not yet inserted; routing metadata not persisted" },
      });
    }
  } catch (err: any) {
    Sentry.captureMessage("route_to_topic_calls_update_threw", {
      level: "warning",
      extra: { business_id, conversation_id, error: err?.message },
    });
  }

  return {
    ok: true,
    result: {
      status: decision.transferStatus,
      message_for_llm: messageForLlm(decision, topicName),
      twiml,
      staff_count: decision.staffPhones.length,
      handoff_reason: decision.handoffReason,
      decision,
    },
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
    const { decision: _drop, ...publicPayload } = result.result;
    res.json(publicPayload);
  },
);

/**
 * Staff-side whisper endpoint. Twilio fetches this URL when the rung
 * staff answers — the TwiML we return plays a `<Say>` to the staff
 * only, then Twilio bridges the two legs. No auth: (a) it's called by
 * Twilio infra, and (b) the only sensitive input is the whisper text
 * which the caller (our own routing handler) already computed.
 *
 * Length-cap defensively so a maliciously long query string can't
 * balloon the Say payload. Twilio itself will reject <Say> > 4096
 * chars; we cap at 300 to keep the whisper conversational.
 */
router.get(
  "/routing/whisper",
  (req: Request, res: Response): void => {
    const raw = typeof req.query.text === "string" ? req.query.text : "";
    const text = raw.length > 300 ? raw.slice(0, 297) + "..." : raw;
    const fallback = text || "Incoming call. Connecting now.";
    res.type("text/xml").send(buildWhisperTwiml(fallback));
  },
);

export default router;
