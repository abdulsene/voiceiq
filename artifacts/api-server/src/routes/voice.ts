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

export function buildOutboundDialTwiml(callerId: string, to: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial callerId="${xmlEscape(callerId)}" answerOnBridge="true">` +
    `<Number>${xmlEscape(to)}</Number>` +
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
    const to = (body.To || "").trim();
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
    if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) {
      res.status(200).type("text/xml").send(twimlHangup("Invalid destination number."));
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

    const twiml = buildOutboundDialTwiml(biz.twilioPhoneNumber, to);
    res.status(200).type("text/xml").send(twiml);
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
