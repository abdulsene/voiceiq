/**
 * Phase 3.3 — in-app calling (Twilio Voice WebRTC softphone).
 *
 *   POST /api/voice/token
 *     requireAuth-guarded. Mints a Twilio AccessToken with a VoiceGrant
 *     so the browser SDK can register as a Client and both receive
 *     incoming <Client> dials AND place outbound calls (via the TwiML
 *     App below).
 *
 *     SECURITY MODEL — identity is resolved SERVER-SIDE from the JWT.
 *     The route NEVER accepts an identity from the request. Anything
 *     the client sends is ignored. Compromising a browser session
 *     therefore only lets an attacker impersonate that user (which
 *     they already can), never another tenant.
 *
 *   POST /api/voice/outbound
 *     TwiML App webhook. Twilio POSTs when the browser's `device.connect()`
 *     initiates an outbound call. Bypass-listed in app.ts;
 *     Twilio-signature-verified inside the handler.
 *
 *     Resolves the calling business from `From = client:<identity>` and
 *     enforces callerId MATCHES that business's twilio_phone_number.
 *     Cross-tenant caller ID spoofing is the failure mode this closes:
 *     without the callerId check, a compromised client could dial from
 *     ANY provisioned business number.
 *
 *   POST /api/voice/heartbeat
 *     requireAuth-guarded. Bumps user_businesses.voice_device_last_seen_at
 *     for the calling user's active business. Called on register + every
 *     ~30s from the browser. Powers the "unregistered = unavailable"
 *     rule in the Phase 3.2 routing candidate query — without a fresh
 *     heartbeat AND no callback_ring_number, the staff member is
 *     dropped from the dial candidate list so routing doesn't ring a
 *     dead <Client> endpoint.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";
import twilio from "twilio";

import { requireAuth } from "../middlewares/auth";
import { verifyTwilioSignature } from "../lib/twilio-signature";
import { buildClientIdentity } from "../lib/voice/client-identity";
// Phase 3.8 — outbound status callback URL. Same single-source-of-
// truth helper used by the whisper + dial-status URLs so a PUBLIC_URL
// vs PUBLIC_API_URL drift can't recreate the Phase 3.4 sev-1.
import { getPublicApiBase } from "../lib/public-url";
// Phase 3.3a — shared with routes/routing.ts (lives in lib/ to avoid
// route → route imports). Previously duplicated as
// DEVICE_FRESHNESS_SECS_ROUTING; that duplicate is gone. Imported for
// local use in the reachability handler AND re-exported so downstream
// consumers keep the routes/voice.ts import path they had.
import { DEVICE_FRESHNESS_SECS } from "../lib/routing/constants";
export { DEVICE_FRESHNESS_SECS };

const router = Router();

const ACCESS_TOKEN_TTL_SECS = 3600;

// Prereq guard. If any of the three Voice-SDK envs are missing at boot,
// crash loudly. The whole in-app-calling feature is broken without them
// — silent 500s at request time would look like generic backend flakiness.
// Called from app.ts on boot (see wire-up at end of file).
export function assertVoiceEnvOrThrow(): void {
  const missing: string[] = [];
  if (!process.env.TWILIO_API_KEY_SID) missing.push("TWILIO_API_KEY_SID");
  if (!process.env.TWILIO_API_KEY_SECRET) missing.push("TWILIO_API_KEY_SECRET");
  if (!process.env.TWILIO_TWIML_APP_SID) missing.push("TWILIO_TWIML_APP_SID");
  if (!process.env.TWILIO_ACCOUNT_SID) missing.push("TWILIO_ACCOUNT_SID");
  if (missing.length > 0) {
    throw new Error(
      `[Phase 3.3] Missing required Twilio Voice env vars: ${missing.join(", ")}. ` +
        `In-app calling (WebRTC softphone) cannot boot. Set in Replit Secrets and restart.`,
    );
  }
}

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Token ───────────────────────────────────────────────────────────

export interface TokenResponse {
  token: string;
  identity: string;
  expires_at: string;
}

/**
 * Discriminated result for resolveClientIdentityForUser. The token
 * route maps status → HTTP status; every failure path carries an
 * explicit reason so we never silently substitute a different tenant.
 *
 * Phase 3.3b — the previous shape was `string | null`, which forced
 * the route to guess between "no memberships" and "requested business
 * not a member" and "multi-membership without x-active-business" —
 * all rendered as null. The prior code path even fell back to ANY
 * membership when the requested business row was missing, which
 * reintroduced the exact cross-tenant condition migration 043 closed
 * (a user could receive a token minted for a tenant they didn't ask
 * for). Removed.
 */
export type IdentityResolution =
  | { ok: true; identity: string; businessId: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Resolve a user's Twilio Client identity for the given active
 * business.
 *
 * Phase 3.3a — the identity is derived from the (user_id, business_id)
 * pair via buildClientIdentity(). We round-trip through the DB to
 * VERIFY the caller actually has a membership for the requested
 * business — an attacker could otherwise forge an x-active-business
 * header for a tenant they don't belong to.
 *
 * Phase 3.3b — three distinct failure modes, each with an explicit
 * HTTP code:
 *   - businessId absent + user has 0 memberships → 403 (nothing to
 *     scope a token to)
 *   - businessId absent + user has N>1 memberships → 400 (caller MUST
 *     pick one via the x-active-business header; we will not guess)
 *   - businessId provided + no matching membership → 403 (not a member
 *     of the requested tenant; NEVER substitute)
 * Success returns the derived identity + resolved businessId.
 */
export async function resolveClientIdentityForUser(
  supabase: SupabaseClient,
  userId: string,
  businessId: string | undefined,
): Promise<IdentityResolution> {
  if (businessId) {
    // Scoped lookup — (user_id, business_id) is unique so at most one row.
    const { data, error } = await supabase
      .from("user_businesses")
      .select("business_id")
      .eq("user_id", userId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      return { ok: false, status: 403, error: "Membership lookup failed" };
    }
    const row = data as { business_id?: string } | null;
    if (!row?.business_id) {
      return {
        ok: false,
        status: 403,
        error: "Not a member of the requested business",
      };
    }
    return {
      ok: true,
      identity: buildClientIdentity(userId, row.business_id),
      businessId: row.business_id,
    };
  }

  // No active-business hint — allowed only when the user has exactly
  // one membership. Multi-membership users MUST pick a tenant via
  // x-active-business; we surface that as an explicit 400 rather than
  // silently picking one for them.
  const { data, error } = await supabase
    .from("user_businesses")
    .select("business_id")
    .eq("user_id", userId);
  if (error) {
    return { ok: false, status: 403, error: "Membership lookup failed" };
  }
  const list = (data as Array<{ business_id: string }> | null) ?? [];
  if (list.length === 0) {
    return { ok: false, status: 403, error: "No memberships found for this user" };
  }
  if (list.length > 1) {
    return {
      ok: false,
      status: 400,
      error:
        "active business required — user has multiple memberships; send x-active-business header",
    };
  }
  const bizId = list[0].business_id;
  return {
    ok: true,
    identity: buildClientIdentity(userId, bizId),
    businessId: bizId,
  };
}

/**
 * Build a Twilio AccessToken with a VoiceGrant. Split out from the
 * route handler so the smoke test can assert on the identity without
 * booting the whole Express stack.
 */
export function mintVoiceAccessToken(identity: string): { jwt: string; expiresAt: Date } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID as string;
  const keySid = process.env.TWILIO_API_KEY_SID as string;
  const secret = process.env.TWILIO_API_KEY_SECRET as string;
  const appSid = process.env.TWILIO_TWIML_APP_SID as string;

  const AccessToken = (twilio.jwt as any).AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(accountSid, keySid, secret, {
    identity,
    ttl: ACCESS_TOKEN_TTL_SECS,
  });
  const grant = new VoiceGrant({
    outgoingApplicationSid: appSid,
    incomingAllow: true,
  });
  token.addGrant(grant);

  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECS * 1000);
  return { jwt: token.toJwt(), expiresAt };
}

// ── Caller ID (softphone outbound) ──────────────────────────────────

/**
 * Phase 3.7 — dedicated caller-ID endpoint for the softphone.
 *
 * Softphone previously read this via /api/business/configure which
 * returns { success, config: { ...business_configs row } }. The
 * frontend was reading response.twilio_phone_number at the top level
 * instead of response.config.twilio_phone_number, so callerId was
 * always null despite the row being correctly populated. That's a
 * frontend shape-mismatch bug against a large, nested response.
 *
 * This dedicated endpoint returns a small, flat shape scoped to the
 * caller's active business — no nesting to get wrong, no chance for
 * a future field addition on /business/configure to accidentally
 * shadow the Softphone contract. Also gives us a testable
 * route-layer HTTP target without booting the giant api.ts router.
 *
 * Auth: requireAuth (uses req.businessId which the auth middleware
 * has already scoped against memberships).
 */
export interface CallerIdResponse {
  /**
   * true when we know the business has no provisioned number.
   * Distinct from a fetch failure — see status codes.
   */
  provisioned: boolean;
  twilio_phone_number: string | null;
  twilio_phone_sid: string | null;
  business_id: string;
}

export async function getCallerIdForCaller(
  supabase: SupabaseClient,
  callerBusinessId: string,
): Promise<
  | { ok: true; body: CallerIdResponse }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("twilio_phone_number, twilio_phone_sid, phone_number")
    .eq("business_id", callerBusinessId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  const row = (data || null) as
    | { twilio_phone_number?: string | null; twilio_phone_sid?: string | null; phone_number?: string | null }
    | null;
  if (!row) {
    return { ok: false, status: 404, error: "Business config not found" };
  }
  // Prefer the provisioned Twilio number; fall back to the legacy
  // `phone_number` column that some older tenants still use. The
  // outbound webhook (POST /voice/outbound) already applies the same
  // precedence, so the softphone dials from the same number the
  // webhook allows.
  const num = row.twilio_phone_number || row.phone_number || null;
  return {
    ok: true,
    body: {
      provisioned: !!num,
      twilio_phone_number: num,
      twilio_phone_sid: row.twilio_phone_sid || null,
      business_id: callerBusinessId,
    },
  };
}

router.get(
  "/voice/caller-id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const businessId = req.businessId;
    if (!businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const result = await getCallerIdForCaller(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.body);
  },
);

router.post(
  "/voice/token",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }

    // Identity is derived SERVER-SIDE. We deliberately do not read
    // req.body — any client-supplied identity is dropped on the floor.
    // This is the whole security model of the feature.
    const resolved = await resolveClientIdentityForUser(
      supabase,
      userId,
      req.businessId,
    );
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }

    try {
      const { jwt, expiresAt } = mintVoiceAccessToken(resolved.identity);
      const body: TokenResponse = {
        token: jwt,
        identity: resolved.identity,
        expires_at: expiresAt.toISOString(),
      };
      res.json(body);
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { where: "voice.token.mint", userId },
      });
      res.status(500).json({ error: "Failed to mint access token" });
    }
  },
);

// ── Outbound TwiML App ──────────────────────────────────────────────

/**
 * Parse `client:<identity>` from a Twilio `From` field. Returns null
 * for PSTN From, empty From, or any non-client shape.
 */
export function parseClientFrom(from: string | undefined | null): string | null {
  if (typeof from !== "string") return null;
  const m = from.match(/^client:(.+)$/);
  return m ? m[1].trim() : null;
}

/**
 * Look up the business that owns the given client identity. Because
 * client_identity is deterministic from user_id and the same user can
 * have multiple memberships (Phase 3e), we resolve to the one currently
 * ACTIVE for outbound purposes. If the caller sends an `x-active-business`
 * hint via TwiML app custom parameters, honour it; otherwise pick the
 * oldest membership (deterministic tiebreak).
 */
export async function resolveBusinessForClient(
  supabase: SupabaseClient,
  clientIdentity: string,
  preferredBusinessId?: string,
): Promise<{ businessId: string; twilioPhoneNumber: string } | null> {
  const { data: rows } = await supabase
    .from("user_businesses")
    .select("business_id, created_at")
    .eq("client_identity", clientIdentity)
    .order("created_at", { ascending: true });
  const list = (rows as Array<{ business_id: string }> | null) ?? [];
  if (list.length === 0) return null;

  const chosenId =
    (preferredBusinessId && list.find((r) => r.business_id === preferredBusinessId)?.business_id) ||
    list[0].business_id;

  const { data: biz } = await supabase
    .from("business_configs")
    .select("twilio_phone_number, phone_number")
    .eq("business_id", chosenId)
    .maybeSingle();
  const phone =
    (biz as { twilio_phone_number?: string; phone_number?: string } | null)
      ?.twilio_phone_number ||
    (biz as { twilio_phone_number?: string; phone_number?: string } | null)?.phone_number ||
    "";
  if (!phone) return null;
  return { businessId: chosenId, twilioPhoneNumber: phone };
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
export function xmlEscape(input: string): string {
  return input.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function twimlHangup(reason: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(reason)}</Say><Hangup/></Response>`;
}

export interface BuildOutboundDialTwimlOptions {
  /**
   * Phase 3.8 — optional <Dial action> URL. When provided, Twilio
   * POSTs to it (default POST, we set method="POST" explicitly to
   * document the contract) when the child leg terminates, carrying
   * DialCallStatus + DialCallDuration + DialCallSid + AnsweredBy
   * (when machineDetection is enabled). Feeds handleOutboundStatus.
   */
  statusCallbackUrl?: string | null;
  /**
   * Phase 3.9 — AMD mode. Valid Twilio values on the <Number> verb:
   *   'Enable'           — ~3-6s delay, ~65-85% accuracy
   *   'DetectMessageEnd' — waits for greeting to end, 15-30s delay
   *   null               — disabled
   *
   * Defaults to 'Enable' via NEVERR_OUTBOUND_AMD_MODE env
   * (set env='false' or override here with null to disable).
   * Chose Enable over DetectMessageEnd because the whole point of
   * the softphone is fast staff-driven outbound; a 20s delay per
   * human answer is unacceptable UX. Voicemail misclassification is
   * annoying but recoverable via redial.
   */
  amdMode?: "Enable" | "DetectMessageEnd" | null;
  /**
   * Phase 3.9 — ringback tone for the CALLER. answerOnBridge="true"
   * without ringTone means the caller hears silence until the child
   * answers. Same class as the inbound caller-silence bug fixed in
   * 3.4. Defaults to 'us'; pass null to opt out.
   */
  ringTone?: string | null;
  /**
   * Phase 3.10 — URL Twilio POSTs the AMD result to. REQUIRED when
   * amdMode is set; without it, Twilio runs machineDetection and
   * silently drops the result (verified live 2026-07-31: TwiML
   * emitted machineDetection="Enable" but no amdStatusCallback, so
   * every voicemail was misclassified as answered_human because
   * AnsweredBy never arrived anywhere). The <Dial action> callback
   * does NOT carry AnsweredBy — that was the Phase 3.9 assumption
   * that turned out to be wrong.
   */
  amdStatusCallbackUrl?: string | null;
}

export function buildOutboundDialTwiml(
  callerId: string,
  to: string,
  opts: BuildOutboundDialTwimlOptions = {},
): string {
  const actionAttrs = opts.statusCallbackUrl
    ? ` action="${xmlEscape(opts.statusCallbackUrl)}" method="POST"`
    : "";
  // Phase 3.9 — ringTone defaults to 'us'; explicit null suppresses.
  const ringTone = opts.ringTone === undefined ? "us" : opts.ringTone;
  const ringToneAttr = ringTone ? ` ringTone="${xmlEscape(ringTone)}"` : "";
  // Phase 3.9 — machineDetection on the <Number> child.
  // Phase 3.10 — CORRECTION to the 3.9 comment: AnsweredBy does NOT
  // fold into the <Dial action> callback. Twilio POSTs it to the
  // amdStatusCallback URL only. Without amdStatusCallback the AMD
  // result is silently discarded. Emit BOTH: the attribute that
  // triggers detection, and the URL that receives the result.
  const amdMode = opts.amdMode === undefined ? "Enable" : opts.amdMode;
  const amdAttr = amdMode ? ` machineDetection="${xmlEscape(amdMode)}"` : "";
  // amdStatusCallback only makes sense when detection is enabled.
  // If a caller passes the URL without a mode, we still emit the URL
  // — Twilio will just never call it. If a caller passes the mode
  // without a URL, we log a warning-adjacent shape (the callback
  // never fires). Neither is common in practice.
  const amdCallbackAttrs =
    amdMode && opts.amdStatusCallbackUrl
      ? ` amdStatusCallback="${xmlEscape(opts.amdStatusCallbackUrl)}" amdStatusCallbackMethod="POST"`
      : "";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true"${ringToneAttr}${actionAttrs}>` +
    `<Number${amdAttr}${amdCallbackAttrs}>${xmlEscape(to)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

/**
 * The TwiML App webhook. Twilio POSTs form-encoded params:
 *   From:      "client:<identity>" (populated automatically when the SDK
 *              initiates the call — trusted, comes from Twilio, not the
 *              browser)
 *   To:        the destination E.164 (populated from the browser's
 *              device.connect({params:{To}}))
 *   callerId:  the presented caller ID the browser requested (via the
 *              same params). MUST match the business's provisioned
 *              twilio_phone_number.
 *
 * Bypass-listed in app.ts. Signature-verified below.
 */
router.post(
  "/voice/outbound",
  async (req: Request, res: Response): Promise<void> => {
    if (!verifyTwilioSignature(req)) {
      // Phase 3.4 — mid-call TwiML. Non-2xx here makes Twilio play an
      // error to the answerer. Return 200 with a benign hangup so the
      // caller hears silence, not an error message; Sentry catches
      // the drift.
      Sentry.captureMessage("voice_outbound_signature_rejected", {
        level: "error",
        extra: { path: req.originalUrl },
      });
      res.status(200).type("text/xml").send(twimlHangup("Sorry, we couldn't connect that call."));
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(200).type("text/xml").send(twimlHangup("Service unavailable."));
      return;
    }
    const body = (req.body || {}) as Record<string, string>;
    const from = body.From || "";
    // Phase 3.9 — normalize the destination number server-side. The
    // browser now normalizes too, but we NEVER trust the client to
    // have done it right. Accepts 10-digit US, 11-digit US (leading
    // 1), and full +E.164; rejects everything else with an audible
    // hangup message that names the failure mode.
    const rawTo = (body.To || "").trim();
    const to = normalizeUsPhoneToE164(rawTo);
    const requestedCallerId = (body.callerId || "").trim();

    const identity = parseClientFrom(from);
    if (!identity) {
      Sentry.captureMessage("voice_outbound_non_client_from", {
        level: "warning",
        extra: { from },
      });
      res.status(200).type("text/xml").send(twimlHangup("Outbound calls must originate from a registered client."));
      return;
    }
    if (!to) {
      Sentry.captureMessage("voice_outbound_invalid_destination", {
        level: "warning",
        extra: { rawTo },
      });
      res.status(200).type("text/xml").send(twimlHangup("Invalid destination number — enter a 10-digit US phone number."));
      return;
    }

    const biz = await resolveBusinessForClient(supabase, identity, body.businessId);
    if (!biz) {
      Sentry.captureMessage("voice_outbound_unknown_identity", {
        level: "warning",
        extra: { identity },
      });
      res.status(200).type("text/xml").send(twimlHangup("No business is configured for this device."));
      return;
    }

    // The critical anti-spoofing check. If the browser tries to present a
    // callerId that doesn't match its own tenant's provisioned number,
    // reject. Otherwise anyone with a valid AccessToken could dial from
    // ANY business's caller ID.
    if (requestedCallerId && requestedCallerId !== biz.twilioPhoneNumber) {
      Sentry.captureMessage("voice_outbound_caller_id_mismatch", {
        level: "warning",
        extra: {
          identity,
          business_id: biz.businessId,
          requested: requestedCallerId,
          allowed: biz.twilioPhoneNumber,
        },
      });
      res.status(200).type("text/xml").send(twimlHangup("Caller ID not permitted for this account."));
      return;
    }

    // Phase 3.8 — log the outbound call. Insert a `calls` row keyed
    // on Twilio's parent CallSid so the <Dial action> status callback
    // can find + update it. Business is scoped SERVER-SIDE from the
    // resolved client identity — never from body.businessId (the
    // browser could try to forge it, and even honest attempts would
    // hit the cross-tenant spoof guard above).
    //
    // Parent CallSid comes from Twilio in the outbound TwiML app body
    // as `CallSid`. That's the browser leg's SID; the child leg's SID
    // (`DialCallSid`) arrives later on the status callback. We key on
    // the parent so both this insert and the callback update touch
    // the same row.
    const parentCallSid = body.CallSid || null;
    const staffUserId = await resolveStaffUserIdForClient(supabase, identity);
    const outboundCallRowId = await insertOutboundCallRow(supabase, {
      businessId: biz.businessId,
      twilioCallSid: parentCallSid,
      customerNumber: to,
      staffUserId,
    });
    // Fire-and-forget: link to a matching lead if one exists for
    // this business. Best-effort — never blocks the TwiML response.
    if (staffUserId && outboundCallRowId) {
      void linkOutboundCallToLeadIfMatch(supabase, {
        businessId: biz.businessId,
        customerPhone: to,
        callsRowId: outboundCallRowId,
        twilioCallSid: parentCallSid,
        staffUserId,
      }).catch((err) => {
        Sentry.captureException(err, {
          extra: { where: "voice.outbound.linkLead", businessId: biz.businessId },
        });
      });
    }

    const statusCallbackUrl = `${getPublicApiBase()}/api/voice/outbound-status`;
    // Phase 3.10 — dedicated AMD result URL. Twilio POSTs AnsweredBy
    // here after machineDetection completes; without it the AMD
    // analysis silently discards the result.
    const amdStatusCallbackUrl = `${getPublicApiBase()}/api/voice/amd-status`;
    // Phase 3.9 — NEVERR_OUTBOUND_AMD_MODE env override. Accepts
    // 'Enable' (default, ~4s AMD delay), 'DetectMessageEnd' (slower,
    // more accurate), or 'false'/'off' to disable AMD entirely.
    // Any other value falls back to the built-in default.
    const twiml = buildOutboundDialTwiml(biz.twilioPhoneNumber, to, {
      statusCallbackUrl,
      amdMode: resolveOutboundAmdMode(),
      amdStatusCallbackUrl,
    });
    res.status(200).type("text/xml").send(twiml);
  },
);

/**
 * Phase 3.9 — resolve the AMD mode from env. Isolated so tests can
 * stub the env cleanly.
 */
export function resolveOutboundAmdMode(): "Enable" | "DetectMessageEnd" | null {
  const raw = (process.env.NEVERR_OUTBOUND_AMD_MODE || "").trim();
  if (raw === "DetectMessageEnd") return "DetectMessageEnd";
  if (raw === "false" || raw === "off" || raw === "0") return null;
  return "Enable"; // includes empty/unset — sane default for the softphone
}

/**
 * Phase 3.9 — normalize a US phone number to E.164.
 *   "4434490863"       → "+14434490863"
 *   "14434490863"      → "+14434490863"
 *   "+14434490863"     → "+14434490863"
 *   "(443) 449-0863"   → "+14434490863"
 *   "not a phone"      → null
 *   "+44 20 1234 5678" → null   (non-US rejected for now — US-only)
 *
 * Returns null when the input cannot be normalized to a US +1 E.164
 * number, so the caller can render an inline error rather than firing
 * a doomed dial. Kept US-only by design — international dialing needs
 * per-tenant permission + rate/cost guardrails not built yet.
 */
export function normalizeUsPhoneToE164(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Reject anything explicitly non-US: +country other than 1.
  if (/^\+/.test(trimmed) && !/^\+1/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// ── Outbound call logging + outcome callback ────────────────────────

/**
 * Phase 3.8 — resolve staff user_id from the calling client identity.
 * The identity encodes (user_id, business_id) per Phase 3.3a so we
 * pull the user_id straight from the DB row. If we can't (edge case:
 * identity not on file), returns null and the calls row is inserted
 * without staff attribution — better than dropping the row entirely.
 */
export async function resolveStaffUserIdForClient(
  supabase: SupabaseClient,
  clientIdentity: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("user_businesses")
      .select("user_id")
      .eq("client_identity", clientIdentity)
      .limit(1)
      .maybeSingle();
    return (data as { user_id?: string } | null)?.user_id ?? null;
  } catch {
    return null;
  }
}

export interface InsertOutboundCallInput {
  businessId: string;
  twilioCallSid: string | null;
  customerNumber: string;
  staffUserId: string | null;
}

/**
 * Insert a `calls` row at dial-time. Returns the row's UUID so the
 * caller can pass it to lead-linkage. Failure is logged but does not
 * throw — the TwiML response must not depend on this.
 */
export async function insertOutboundCallRow(
  supabase: SupabaseClient,
  input: InsertOutboundCallInput,
): Promise<string | null> {
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    business_id: input.businessId,
    caller_number: input.customerNumber, // "the other party" — same shape as inbound
    direction: "outbound",
    // Softphone origin: answered_via distinguishes from PSTN transfers.
    answered_via: "browser",
    handled_by_user_id: input.staffUserId,
    handled_at: now, // outbound: "who initiated" doubles as "when placed"
    status: "initiated",
    start_time: now,
    created_at: now,
  };
  if (input.twilioCallSid) payload.twilio_call_sid = input.twilioCallSid;
  try {
    const { data, error } = await supabase
      .from("calls")
      .insert(payload)
      .select("id")
      .single();
    if (error) {
      Sentry.captureMessage("voice_outbound_insert_failed", {
        level: "error",
        extra: { businessId: input.businessId, error: error.message },
      });
      return null;
    }
    return (data as { id?: string } | null)?.id ?? null;
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "insertOutboundCallRow" } });
    return null;
  }
}

/**
 * Best-effort lead linkage. If the dialed number matches a lead in
 * the SAME business, insert a `lead_activities` timeline row so the
 * outbound call shows on the customer's timeline instead of floating
 * unattached.
 *
 * MUST scope by business_id — no cross-tenant matching allowed
 * (dialing a number that happens to belong to another tenant's lead
 * must not populate their timeline).
 */
export async function linkOutboundCallToLeadIfMatch(
  supabase: SupabaseClient,
  input: {
    businessId: string;
    customerPhone: string;
    callsRowId: string;
    twilioCallSid: string | null;
    staffUserId: string;
  },
): Promise<{ leadId: string | null }> {
  // Normalise for match: last 10 digits, same rule the routing engine
  // uses in normalizePhone (routing.ts). Compare in JS so we don't
  // need an index-hostile LIKE query.
  const digits = String(input.customerPhone).replace(/\D+/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!last10) return { leadId: null };

  const { data: candidates } = await supabase
    .from("leads")
    .select("id, contact_phone")
    .eq("business_id", input.businessId)
    .limit(200);
  const list = (candidates as Array<{ id: string; contact_phone: string | null }> | null) ?? [];
  const match = list.find((l) => {
    const ld = String(l.contact_phone ?? "").replace(/\D+/g, "");
    return ld.length >= 10 && ld.slice(-10) === last10;
  });
  if (!match) return { leadId: null };

  try {
    await supabase.from("lead_activities").insert({
      lead_id: match.id,
      actor_id: input.staffUserId,
      actor_type: "staff",
      action: "outbound_call_placed",
      metadata: {
        source: "softphone",
        calls_row_id: input.callsRowId,
        twilio_call_sid: input.twilioCallSid,
        customer_phone: input.customerPhone,
      },
    });
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { where: "linkOutboundCallToLeadIfMatch", leadId: match.id },
    });
  }
  return { leadId: match.id };
}

/**
 * Phase 3.8 — <Dial action> callback for outbound softphone calls.
 * Twilio POSTs when the child leg terminates carrying DialCallStatus
 * + DialCallDuration + DialCallSid. We update the `calls` row that
 * was inserted at /voice/outbound time (keyed on parent Twilio SID).
 *
 * MUST return 200 under every failure mode — mid-call TwiML callback
 * discipline from Phase 3.4. Signature verified inside, 401 downgraded
 * to Sentry-logged 200.
 */
export interface OutboundStatusBody {
  CallSid?: string; // parent — the browser leg's SID (our row key)
  DialCallSid?: string; // child — the customer-leg SID
  DialCallStatus?: string; // completed|no-answer|busy|failed|canceled
  DialCallDuration?: string; // seconds, string on the wire
  AnsweredBy?: string; // Phase 3.9 — Twilio AMD result when
                       // machineDetection is on the <Number>
}

export interface OutboundStatusResult {
  ok: boolean;
  updatedCallsRow: boolean;
  matchedByParentSid: boolean;
  outcome: OutboundOutcome | null;
}

/**
 * Phase 3.9 — outcome taxonomy. Live 2026-07-31: voicemail was
 * recorded as call_outcome='answered' because Twilio reports
 * DialCallStatus=completed when the voicemail machine picks up. Every
 * conversion metric built on call_outcome would misread voicemails
 * as human answers. Fix: map (DialCallStatus, AnsweredBy) together.
 *
 * The distinct outcomes downstream reporting can rely on:
 *
 *   answered_human               — completed + AnsweredBy=human (or
 *                                   AMD disabled but connected: legacy
 *                                   fallback)
 *   voicemail                    — completed + AnsweredBy=machine_*
 *                                   or fax
 *   no_answer                    — no-answer
 *   busy                         — busy
 *   failed                       — failed
 *   canceled                     — canceled with any duration
 *   caller_hung_up_during_ring   — canceled AND duration=0 AND no
 *                                   answer signal (the staff hung up
 *                                   before the callee could answer)
 */
export type OutboundOutcome =
  | "answered_human"
  | "voicemail"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled"
  | "caller_hung_up_during_ring";

/**
 * Pure mapping table. Exported for the smoke matrix — the full
 * DialCallStatus × AnsweredBy grid is asserted directly against
 * this function.
 */
export function mapDialOutcome(
  dialCallStatus: string | null | undefined,
  answeredBy: string | null | undefined,
  durationSecs: number | null | undefined,
): OutboundOutcome {
  const status = String(dialCallStatus || "").toLowerCase();
  const answer = String(answeredBy || "").toLowerCase();
  const duration = typeof durationSecs === "number" && Number.isFinite(durationSecs)
    ? durationSecs
    : null;

  // Phase 3.10 — AMD verdict is authoritative for voicemail
  // classification. Check it BEFORE dial status so the AMD-first
  // ordering (row has no status yet) still yields the correct
  // 'voicemail' outcome. Only machine_* / fax route here — human /
  // unknown fall through to the status-based mapping below since
  // those don't OVERRIDE what the call disposition says.
  if (answer.startsWith("machine") || answer === "fax") {
    return "voicemail";
  }

  if (status === "completed" || status === "answered") {
    // AMD says human — or AMD off / result unknown, which we treat
    // conservatively as human so we don't mis-mark real answers as
    // voicemail when machineDetection is disabled per-tenant.
    return "answered_human";
  }
  if (status === "no-answer") return "no_answer";
  if (status === "busy") return "busy";
  if (status === "failed") return "failed";
  if (status === "canceled") {
    // Twilio 'canceled' spans two very different cases:
    //   - Staff hung up while it was still ringing (duration=0, no
    //     answer signal) — this is caller_hung_up_during_ring.
    //   - The child leg was terminated after any kind of pickup
    //     (rare in the softphone flow, but keep the fallback path
    //     for it distinct).
    const noPickup = !answer && (duration === null || duration === 0);
    return noPickup ? "caller_hung_up_during_ring" : "canceled";
  }
  // Twilio's undocumented / future values → fall to failed. Never
  // silently drop into 'answered'.
  return "failed";
}

export async function handleOutboundStatus(
  supabase: SupabaseClient,
  body: OutboundStatusBody,
  now: Date = new Date(),
): Promise<OutboundStatusResult> {
  const parentSid = typeof body.CallSid === "string" ? body.CallSid : "";
  if (!parentSid) {
    return { ok: true, updatedCallsRow: false, matchedByParentSid: false, outcome: null };
  }
  const rawStatus = typeof body.DialCallStatus === "string" ? body.DialCallStatus : "";
  const rawAnsweredBy = typeof body.AnsweredBy === "string" ? body.AnsweredBy : null;
  const duration = Number.parseInt(String(body.DialCallDuration ?? ""), 10);
  const durationSecs = Number.isFinite(duration) && duration >= 0 ? duration : null;

  // Phase 3.10 — merge with any AMD result that arrived first. The
  // AMD callback and this Dial-action callback are INDEPENDENT and
  // can arrive in either order. If AMD landed first it wrote
  // answered_by='machine_*' and set call_outcome='voicemail'. We
  // must preserve that classification — DialCallStatus=completed
  // without body.AnsweredBy would otherwise remap to
  // answered_human and clobber the AMD result. Read the row first;
  // prefer body.AnsweredBy when present, else use whatever the row
  // already has.
  let existingAnsweredBy: string | null = null;
  let existingOutcome: string | null = null;
  try {
    const { data } = await supabase
      .from("calls")
      .select("answered_by, call_outcome")
      .eq("twilio_call_sid", parentSid)
      .maybeSingle();
    const row = data as { answered_by?: string | null; call_outcome?: string | null } | null;
    existingAnsweredBy = row?.answered_by ?? null;
    existingOutcome = row?.call_outcome ?? null;
  } catch (err: any) {
    // Row read failure isn't fatal — proceed with body-only mapping
    // and Sentry-log. Loses AMD-first merging but doesn't 500.
    Sentry.captureMessage("voice_outbound_status_row_read_failed", {
      level: "warning",
      extra: { parentSid, error: err?.message },
    });
  }
  const mergedAnsweredBy = rawAnsweredBy || existingAnsweredBy;

  const outcome = mapDialOutcome(rawStatus, mergedAnsweredBy, durationSecs);

  // Phase 3.10 downgrade guard: if AMD ran first and stamped
  // 'voicemail', don't let a later Dial-action arriving without
  // AnsweredBy remap back to answered_human. mapDialOutcome above
  // already handles this by using mergedAnsweredBy, but keep an
  // explicit guard for the case where existingOutcome is voicemail
  // and the merge would produce answered_human (shouldn't happen but
  // defensive).
  const finalOutcome =
    existingOutcome === "voicemail" && outcome === "answered_human"
      ? "voicemail"
      : outcome;

  const patch: Record<string, unknown> = {
    // Phase 3.9 — `status` stores the RAW Twilio DialCallStatus for
    // diagnosability; `call_outcome` stores our mapped taxonomy.
    status: rawStatus || "completed",
    call_outcome: finalOutcome,
    end_time: now.toISOString(),
  };
  if (durationSecs !== null) patch.duration_seconds = durationSecs;
  // Only overwrite answered_by if THIS callback carries a fresh
  // value. AMD-first path already wrote it; don't null it out.
  if (rawAnsweredBy) patch.answered_by = rawAnsweredBy;

  try {
    const { data, error } = await supabase
      .from("calls")
      .update(patch)
      .eq("twilio_call_sid", parentSid)
      .select("id")
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("voice_outbound_status_update_failed", {
        level: "warning",
        extra: { parentSid, error: error.message },
      });
      return { ok: true, updatedCallsRow: false, matchedByParentSid: false, outcome: finalOutcome };
    }
    return {
      ok: true,
      updatedCallsRow: !!data,
      matchedByParentSid: !!data,
      outcome: finalOutcome,
    };
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { where: "handleOutboundStatus", parentSid },
    });
    return { ok: true, updatedCallsRow: false, matchedByParentSid: false, outcome: finalOutcome };
  }
}

router.post(
  "/voice/outbound-status",
  async (req: Request, res: Response): Promise<void> => {
    // Same 200-always discipline as dial-status: mid-call TwiML
    // callbacks must never surface non-2xx to Twilio, or the answerer
    // (already in-call) hears "an application error has occurred."
    if (!verifyTwilioSignature(req)) {
      Sentry.captureMessage("voice_outbound_status_signature_rejected", {
        level: "error",
        extra: { path: req.originalUrl },
      });
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    await handleOutboundStatus(supabase, (req.body || {}) as OutboundStatusBody);
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

// ── AMD status callback (Phase 3.10) ────────────────────────────────

/**
 * Twilio POST body for the amdStatusCallback URL declared on
 * <Number>. Twilio's docs list these fields; we type only the ones
 * we actually consume so unrelated fields (MachineDetectionDuration,
 * account SIDs, etc.) can pass through untouched.
 */
export interface AmdStatusBody {
  /** Parent leg CallSid — same value our row is keyed on. */
  CallSid?: string;
  /**
   * Twilio's AMD verdict. Values: human, machine_start,
   * machine_end_beep, machine_end_silence, machine_end_other, fax,
   * unknown.
   */
  AnsweredBy?: string;
}

export interface AmdStatusResult {
  ok: boolean;
  updatedCallsRow: boolean;
  outcome: OutboundOutcome | null;
  /** True when we skipped the outcome overwrite because the row's
   *  current outcome is a terminal non-answered value (no_answer /
   *  busy / failed). Raw AnsweredBy is still stored for forensics. */
  preservedTerminalOutcome: boolean;
}

/**
 * Terminal outcomes that dial-action can produce and that AMD MUST
 * NOT downgrade. If Twilio's dial-action landed first and reported
 * no-answer / busy / failed, any subsequent AMD signal about the
 * same call is meaningless (the call never actually connected to a
 * machine). AMD-first + then no-answer never happens in practice —
 * AMD needs a media stream to analyze.
 */
const TERMINAL_NON_ANSWERED_OUTCOMES: ReadonlySet<string> = new Set([
  "no_answer",
  "busy",
  "failed",
]);

/**
 * Phase 3.10 — the AMD result handler.
 *
 * Two arrival orderings to handle correctly:
 *
 *   1. AMD arrives FIRST (typical when the callee is a voicemail
 *      system — Twilio detects the greeting and fires this callback
 *      before the child leg terminates). Row has no status yet or is
 *      still 'initiated'. We store answered_by and re-map call_outcome
 *      using whatever the row already has for status + duration
 *      (usually still empty at this point — mapDialOutcome will fall
 *      back to 'failed' for empty status; we compensate by ONLY
 *      writing call_outcome when we can make a meaningful call).
 *
 *      Simpler: if AMD says machine_*, write call_outcome='voicemail'
 *      directly — no status needed because AMD IS the classification.
 *
 *   2. AMD arrives SECOND (typical when the callee is a human — the
 *      Dial-action fires when they hang up, AMD fires when analysis
 *      completes if it was running). Row already has status +
 *      call_outcome. We upgrade answered_human → voicemail; but
 *      preserve no_answer / busy / failed as-is.
 *
 * Always returns 200 valid TwiML (Phase 3.4 discipline).
 */
export async function handleAmdStatus(
  supabase: SupabaseClient,
  body: AmdStatusBody,
): Promise<AmdStatusResult> {
  const parentSid = typeof body.CallSid === "string" ? body.CallSid : "";
  const answeredBy = typeof body.AnsweredBy === "string" ? body.AnsweredBy : "";
  if (!parentSid || !answeredBy) {
    return { ok: true, updatedCallsRow: false, outcome: null, preservedTerminalOutcome: false };
  }

  let existingOutcome: string | null = null;
  let existingStatus: string | null = null;
  let existingDuration: number | null = null;
  try {
    const { data } = await supabase
      .from("calls")
      .select("call_outcome, status, duration_seconds")
      .eq("twilio_call_sid", parentSid)
      .maybeSingle();
    const row = data as
      | { call_outcome?: string | null; status?: string | null; duration_seconds?: number | null }
      | null;
    if (!row) {
      // Row not found. This can happen if the AMD callback races the
      // /voice/outbound insert (very short-lived race — insert runs
      // synchronously before we return the TwiML that starts the
      // dial). Log and 200 — nothing to do.
      Sentry.captureMessage("voice_amd_status_row_not_found", {
        level: "warning",
        extra: { parentSid, answeredBy },
      });
      return { ok: true, updatedCallsRow: false, outcome: null, preservedTerminalOutcome: false };
    }
    existingOutcome = row.call_outcome ?? null;
    existingStatus = row.status ?? null;
    existingDuration = typeof row.duration_seconds === "number" ? row.duration_seconds : null;
  } catch (err: any) {
    Sentry.captureMessage("voice_amd_status_row_read_failed", {
      level: "warning",
      extra: { parentSid, error: err?.message },
    });
  }

  // Terminal-outcome guard. If Dial-action already stamped no-answer
  // / busy / failed, an AMD signal here is spurious — store raw
  // answered_by for forensics but leave call_outcome alone.
  if (existingOutcome && TERMINAL_NON_ANSWERED_OUTCOMES.has(existingOutcome)) {
    try {
      await supabase
        .from("calls")
        .update({ answered_by: answeredBy })
        .eq("twilio_call_sid", parentSid);
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { where: "handleAmdStatus.preserveTerminal", parentSid },
      });
    }
    return {
      ok: true,
      updatedCallsRow: true,
      outcome: (existingOutcome as OutboundOutcome),
      preservedTerminalOutcome: true,
    };
  }

  // Compute the new outcome. mapDialOutcome checks AMD verdict FIRST
  // (Phase 3.10), so machine_* / fax always yield 'voicemail' even
  // when the row has no status yet (AMD-first ordering). For AMD
  // saying 'human' / 'unknown', mapDialOutcome falls through to
  // status-based mapping — which is 'answered_human' when status is
  // completed and 'failed' when status is empty. The empty-status
  // case only matters if AMD returns human before any Dial-action;
  // in practice AMD returning 'human' means media was flowing so
  // Dial-action is imminent and will overwrite.
  const newOutcome = mapDialOutcome(
    existingStatus ?? "",
    answeredBy,
    existingDuration,
  );

  // Only skip the outcome overwrite when AMD is inconclusive AND
  // there's no Dial-action status yet — otherwise a spurious
  // 'unknown' AMD verdict would stamp 'failed' on a call still in
  // progress. Voicemail / answered_human always overwrite.
  const isMeaningful =
    newOutcome === "voicemail" ||
    newOutcome === "answered_human" ||
    existingStatus !== null;

  const patch: Record<string, unknown> = { answered_by: answeredBy };
  if (isMeaningful) patch.call_outcome = newOutcome;

  try {
    const { data, error } = await supabase
      .from("calls")
      .update(patch)
      .eq("twilio_call_sid", parentSid)
      .select("id")
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("voice_amd_status_update_failed", {
        level: "warning",
        extra: { parentSid, error: error.message },
      });
      return { ok: true, updatedCallsRow: false, outcome: newOutcome, preservedTerminalOutcome: false };
    }
    return {
      ok: true,
      updatedCallsRow: !!data,
      outcome: isMeaningful ? newOutcome : (existingOutcome as OutboundOutcome | null),
      preservedTerminalOutcome: false,
    };
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "handleAmdStatus", parentSid } });
    return { ok: true, updatedCallsRow: false, outcome: newOutcome, preservedTerminalOutcome: false };
  }
}

router.post(
  "/voice/amd-status",
  async (req: Request, res: Response): Promise<void> => {
    // Same 200-always discipline as /outbound-status. The whole
    // pipeline is designed so no path here can surface non-2xx.
    if (!verifyTwilioSignature(req)) {
      Sentry.captureMessage("voice_amd_status_signature_rejected", {
        level: "error",
        extra: { path: req.originalUrl },
      });
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    try {
      await handleAmdStatus(supabase, (req.body || {}) as AmdStatusBody);
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: "voice.amd-status.handler" } });
    }
    res.status(200).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  },
);

// ── Recent in-app calls (Phone page panel) ──────────────────────────

export interface RecentCallRow {
  id: string;
  twilio_call_sid: string | null;
  direction: string | null;
  caller_number: string | null;
  answered_via: string | null;
  status: string | null;
  call_outcome: string | null;
  duration_seconds: number | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string | null;
}

export interface RecentCallsResponse {
  calls: RecentCallRow[];
}

export async function listRecentInAppCallsForUser(
  supabase: SupabaseClient,
  userId: string,
  businessId: string,
  limit: number = 20,
): Promise<
  | { ok: true; body: RecentCallsResponse }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("calls")
    .select(
      "id, twilio_call_sid, direction, caller_number, answered_via, status, call_outcome, duration_seconds, start_time, end_time, created_at",
    )
    .eq("business_id", businessId)
    .eq("handled_by_user_id", userId)
    .eq("answered_via", "browser")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, body: { calls: (data as RecentCallRow[] | null) ?? [] } };
}

router.get(
  "/voice/recent-calls",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    const businessId = req.businessId;
    if (!userId || !businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const parsedLimit = Number.parseInt(String(req.query.limit || "20"), 10);
    const result = await listRecentInAppCallsForUser(
      supabase,
      userId,
      businessId,
      Number.isFinite(parsedLimit) ? parsedLimit : 20,
    );
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.body);
  },
);

// ── Reachability ────────────────────────────────────────────────────

/**
 * Phase 3.3c — server-side view of "can routing reach this staff
 * member?". Same predicate the Phase 3.2 routing candidate query
 * uses: has_callback_number OR (in_app_calling_enabled AND fresh
 * heartbeat). Feeds the OnDutyToggle's reachability guard so a user
 * can't clock in and go silently unreachable.
 */
export interface ReachabilityState {
  in_app_calling_enabled: boolean;
  has_callback_ring_number: boolean;
  device_heartbeat_fresh: boolean;
  /**
   * True iff routing would actually ring this user. This is the SAME
   * predicate the routing engine uses; drift here is the exact bug
   * this endpoint exists to prevent.
   */
  reachable: boolean;
  /** Age of last heartbeat in seconds, or null if never seen. */
  device_heartbeat_age_secs: number | null;
}

export async function getReachabilityForCaller(
  supabase: SupabaseClient,
  callerUserId: string,
  callerBusinessId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true; state: ReachabilityState }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("user_businesses")
    .select("callback_ring_number, in_app_calling_enabled, voice_device_last_seen_at")
    .eq("user_id", callerUserId)
    .eq("business_id", callerBusinessId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Membership not found" };
  const row = data as {
    callback_ring_number: string | null;
    in_app_calling_enabled: boolean | null;
    voice_device_last_seen_at: string | null;
  };
  const hasCallback = !!row.callback_ring_number;
  const enabled = !!row.in_app_calling_enabled;
  const lastMs = row.voice_device_last_seen_at
    ? Date.parse(row.voice_device_last_seen_at)
    : NaN;
  const ageSecs = Number.isNaN(lastMs)
    ? null
    : Math.max(0, Math.floor((now.getTime() - lastMs) / 1000));
  const fresh = ageSecs !== null && ageSecs <= DEVICE_FRESHNESS_SECS;
  const reachable = hasCallback || (enabled && fresh);
  return {
    ok: true,
    state: {
      in_app_calling_enabled: enabled,
      has_callback_ring_number: hasCallback,
      device_heartbeat_fresh: fresh,
      reachable,
      device_heartbeat_age_secs: ageSecs,
    },
  };
}

router.get(
  "/voice/reachability",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    const businessId = req.businessId;
    if (!userId || !businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const result = await getReachabilityForCaller(supabase, userId, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.state);
  },
);

// ── Preferences ─────────────────────────────────────────────────────

/**
 * Phase 3.3a — the softphone dock's opt-in was previously localStorage-
 * only, while routing gates on user_businesses.in_app_calling_enabled.
 * A user could see a green "registered" pill in the UI and be
 * permanently unreachable to routing.
 *
 * These endpoints make the server the authority: dock reads initial
 * state via GET, writes via PATCH. localStorage may still cache but is
 * no longer the source of truth.
 *
 * Auth model: requireAuth. PATCH writes are scoped to the caller's own
 * (user_id, business_id) row — the endpoint does NOT accept a
 * user_id argument, so an attacker cannot toggle another user's
 * preference by forging a body.
 */

export interface VoicePreferences {
  in_app_calling_enabled: boolean;
}

/**
 * Phase 3.3b — single implementation for GET /voice/preferences.
 * Route handler delegates here; T51-style tests call it directly so
 * we're not covering a copy. Returns 404 when the caller has no row
 * for the requested business (requireAuth should have prevented this,
 * but defensive).
 */
export async function getPreferenceForCaller(
  supabase: SupabaseClient,
  callerUserId: string,
  callerBusinessId: string,
): Promise<
  | { ok: true; preferences: VoicePreferences }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await supabase
    .from("user_businesses")
    .select("in_app_calling_enabled")
    .eq("user_id", callerUserId)
    .eq("business_id", callerBusinessId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Membership not found" };
  return {
    ok: true,
    preferences: {
      in_app_calling_enabled: !!(data as { in_app_calling_enabled?: boolean })
        .in_app_calling_enabled,
    },
  };
}

/**
 * Phase 3.3b — single implementation for PATCH /voice/preferences.
 * The route handler now delegates to this helper so T51 exercises the
 * ACTUAL request path, not a parallel copy that could drift silently.
 *
 * Scoped to caller's OWN (user_id, business_id). Any user_id /
 * business_id supplied in the request body is dropped on the floor —
 * the parameters here are the caller's credentials from requireAuth,
 * period.
 */
export async function updatePreferenceForCaller(
  supabase: SupabaseClient,
  callerUserId: string,
  callerBusinessId: string,
  body: unknown,
): Promise<
  | { ok: true; preferences: VoicePreferences }
  | { ok: false; status: number; error: string }
> {
  const b = (body || {}) as Record<string, unknown>;
  if (typeof b.in_app_calling_enabled !== "boolean") {
    return { ok: false, status: 400, error: "in_app_calling_enabled must be boolean" };
  }
  const { data, error } = await supabase
    .from("user_businesses")
    .update({ in_app_calling_enabled: b.in_app_calling_enabled })
    .eq("user_id", callerUserId)
    .eq("business_id", callerBusinessId)
    .select("in_app_calling_enabled")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data) return { ok: false, status: 404, error: "Membership not found" };
  return {
    ok: true,
    preferences: {
      in_app_calling_enabled: !!(data as { in_app_calling_enabled?: boolean })
        .in_app_calling_enabled,
    },
  };
}

router.get(
  "/voice/preferences",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    const businessId = req.businessId;
    if (!userId || !businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const result = await getPreferenceForCaller(supabase, userId, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.preferences);
  },
);

router.patch(
  "/voice/preferences",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    const businessId = req.businessId;
    if (!userId || !businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    try {
      const result = await updatePreferenceForCaller(supabase, userId, businessId, req.body);
      if (!result.ok) {
        if (result.status >= 500) {
          Sentry.captureMessage("voice_preferences_patch_helper_error", {
            level: "error",
            extra: { userId, businessId, error: result.error },
          });
        }
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result.preferences);
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: "voice.preferences.patch.throw", userId } });
      res.status(500).json({ error: "Failed to update preference" });
    }
  },
);

// ── Heartbeat ───────────────────────────────────────────────────────

router.post(
  "/voice/heartbeat",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId;
    const businessId = req.businessId;
    if (!userId || !businessId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    try {
      await supabase
        .from("user_businesses")
        .update({ voice_device_last_seen_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("business_id", businessId);
      res.status(204).end();
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: "voice.heartbeat", userId } });
      res.status(500).json({ error: "Heartbeat failed" });
    }
  },
);

export default router;
