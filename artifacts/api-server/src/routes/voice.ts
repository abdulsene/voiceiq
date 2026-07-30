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

const router = Router();

const ACCESS_TOKEN_TTL_SECS = 3600;

// Heartbeat freshness window. A staff member with in_app_calling_enabled=true
// counts as "device present" only if their last heartbeat is within this
// many seconds. 90s is 3x the frontend's ~30s ping cadence — one dropped
// ping keeps them online; two in a row marks them unavailable.
export const DEVICE_FRESHNESS_SECS = 90;

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
 * Resolve a user's Twilio Client identity from user_businesses. Prefers
 * the row for the caller's ACTIVE business (already selected by
 * requireAuth via x-active-business header). Falls back to the first
 * membership. Returns null if the user has no memberships or the row
 * lacks a backfilled client_identity (should not happen post-migration
 * 042 — but the code stays defensive).
 */
export async function resolveClientIdentityForUser(
  supabase: SupabaseClient,
  userId: string,
  businessId: string | undefined,
): Promise<string | null> {
  let query = supabase
    .from("user_businesses")
    .select("client_identity, business_id")
    .eq("user_id", userId);
  if (businessId) query = query.eq("business_id", businessId);
  const { data, error } = await query.maybeSingle();
  if (error || !data) {
    if (!businessId) return null;
    // Fallback: caller has an active biz but the row lookup failed. Try
    // ANY membership so token issuance doesn't 500 for an edge-case row.
    const { data: any } = await supabase
      .from("user_businesses")
      .select("client_identity")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    return (any as { client_identity?: string } | null)?.client_identity || null;
  }
  return (data as { client_identity?: string }).client_identity || null;
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
    const identity = await resolveClientIdentityForUser(
      supabase,
      userId,
      req.businessId,
    );
    if (!identity) {
      res
        .status(403)
        .json({ error: "No client_identity on file for this user — no memberships found" });
      return;
    }

    try {
      const { jwt, expiresAt } = mintVoiceAccessToken(identity);
      const body: TokenResponse = {
        token: jwt,
        identity,
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
      res.status(401).type("text/xml").send(twimlHangup("Unauthorized."));
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
