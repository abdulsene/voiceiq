/**
 * SSO routes — Sprint 5 WorkOS Phases 2 & 3.
 *
 * Phase 2 surface (admin connection management):
 *   POST   /api/sso/connection             — link a WorkOS Connection to a tenant
 *   GET    /api/sso/connection/:businessId — read the link + live WorkOS state
 *   DELETE /api/sso/connection/:businessId — clear the link
 *
 * Phase 3 surface (the actual login flow):
 *   GET    /api/sso/init?connectionId=...  — kicks off the IdP login redirect
 *   GET    /api/sso/callback               — IdP returns here, we JIT-provision
 *
 * Auth model:
 *   - Phase 2 admin endpoints are double-gated: requireAuth + requireStaffOrBootstrap.
 *   - Phase 3 endpoints (init/callback) are PRE-LOGIN and intentionally
 *     ungated — they're the entry point of the auth flow itself. CSRF
 *     protection comes from the HMAC-signed `state` parameter (see
 *     signSsoState/verifySsoState below) which is stateless: no cookie
 *     middleware required.
 *
 * JIT-provisioning policy (LOCKED with Abdul Phase 3 brief):
 *   - Default role for newly-provisioned SSO users: 'member' (NOT
 *     admin/owner). Codified as JIT_DEFAULT_ROLE below.
 *   - Tenant binding: business_configs.sso_connection_id → business_id is
 *     the canonical mapping. The IdP-returned profile.connectionId drives
 *     the lookup.
 *   - Email collision: existing Supabase user + new SSO connection → ADD
 *     them to the SSO-mapped business with the default role. Do NOT
 *     create a duplicate user. Do NOT change the existing user's
 *     password (existing email/password login keeps working alongside SSO).
 *   - Malformed/missing email from WorkOS → STOP and surface a 400. We
 *     refuse to silently substitute idpId or sub for email — that's a
 *     product decision and the operator needs visibility.
 *
 * Side-effect on import:
 *   Importing this file triggers `lib/workos.ts`'s boot-time env-var
 *   check (WORKOS_API_KEY + WORKOS_CLIENT_ID required) — by design.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireAuth } from "../middlewares/auth.js";
import { requireStaffOrBootstrap } from "../middlewares/staff-rbac.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";
import { workos, WORKOS_CLIENT_ID } from "../lib/workos.js";

const router: IRouter = Router();

// Shared Supabase client — same lazy-init pattern admin.ts uses.
let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_KEY"];
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

const MAX_ID_LEN = 256;
function isNonEmptyString(v: unknown, max = MAX_ID_LEN): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max;
}

// Locked per Abdul's Phase 3 JIT-policy brief. Pulled out as a named
// constant so an audit can grep for the literal and so future widening
// (e.g. role-mapping from IdP groups) has an obvious replacement point.
const JIT_DEFAULT_ROLE = "member" as const;

// State-token TTL. WorkOS round-trips usually complete in seconds; ten
// minutes is a generous upper bound for slow IdP login pages without
// keeping a stale auth window open all day.
const SSO_STATE_TTL_MS = 10 * 60 * 1000;

// Used both for sso_state HMAC (Phase 3) and for any other payload
// signing this file might add later. Reuse of FIELD_ENCRYPTION_KEY is
// deliberate — we already require it for general field encryption and
// not having a separate "SSO state secret" reduces the env-var surface.
function getStateSecret(): string {
  const k = process.env["FIELD_ENCRYPTION_KEY"];
  if (!k) {
    throw new Error(
      "[sso] FIELD_ENCRYPTION_KEY is required to sign SSO state tokens",
    );
  }
  return k;
}

// ---------------------------------------------------------------------------
// HMAC-signed state token. Format: base64url(`${connectionId}|${nonce}|${ts}`)
// followed by `.` and base64url(HMAC-SHA256(payload)).
//
// Stateless on purpose — we don't want to require cookie-parser middleware
// just for SSO state, and a server-side store would add a Redis dependency.
// HMAC-with-timestamp gives us CSRF protection (attacker can't forge state)
// AND replay protection (TTL window) AND binding to the connection_id the
// user originally clicked init for (callback verifies it matches the
// profile's connectionId).
// ---------------------------------------------------------------------------
export function signSsoState(connectionId: string): string {
  const nonce = randomBytes(16).toString("base64url");
  const ts = Date.now().toString();
  const payload = `${encodeURIComponent(connectionId)}|${nonce}|${ts}`;
  const sig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifySsoState(
  token: string,
): { connectionId: string; ageMs: number } | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [encodedPayload, providedSig] = token.split(".");
  if (!encodedPayload || !providedSig) return null;

  let payload: string;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expectedSig = createHmac("sha256", getStateSecret())
    .update(payload)
    .digest("base64url");

  // Timing-safe equality. Buffer length check first because timingSafeEqual
  // throws (loudly) on mismatched lengths — which would itself be a side
  // channel.
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const parts = payload.split("|");
  if (parts.length !== 3) return null;
  const [encConn, , tsStr] = parts;
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return null;
  const ageMs = Date.now() - ts;
  if (ageMs < 0 || ageMs > SSO_STATE_TTL_MS) return null;

  return { connectionId: decodeURIComponent(encConn || ""), ageMs };
}

// ---------------------------------------------------------------------------
// Build the absolute callback URL the IdP will return to. Prefers BASE_URL
// (canonical prod hostname), falls back to REPLIT_DEV_DOMAIN (dev), then
// to the request's own host header (last resort — only safe because this
// URL is shown to the IdP, not trusted to identify the user).
// ---------------------------------------------------------------------------
function buildCallbackUrl(req: Request): string {
  const base =
    process.env["BASE_URL"] ||
    (process.env["REPLIT_DEV_DOMAIN"]
      ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
      : `${req.protocol}://${req.get("host")}`);
  return `${base.replace(/\/$/, "")}/api/sso/callback`;
}

function buildPostLoginUrl(): string {
  const app = process.env["APP_URL"] || "https://neverr.ai";
  return `${app.replace(/\/$/, "")}/dashboard`;
}

// ===========================================================================
// PHASE 2 — admin connection management
// ===========================================================================

router.post(
  "/connection",
  requireAuth,
  requireStaffOrBootstrap("write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const { businessId, connectionId } = (req.body || {}) as {
      businessId?: unknown;
      connectionId?: unknown;
    };

    if (!isNonEmptyString(businessId)) {
      return res
        .status(400)
        .json({ error: "businessId is required (non-empty string)" });
    }
    if (!isNonEmptyString(connectionId)) {
      return res
        .status(400)
        .json({ error: "connectionId is required (non-empty string)" });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    let workosConnection;
    try {
      workosConnection = await workos.sso.getConnection(connectionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[sso] getConnection failed for", connectionId, "—", msg);
      return res.status(400).json({
        error: "WorkOS connection not found or unreachable",
        details: msg,
      });
    }

    const { data: existing, error: lookupErr } = await supabase
      .from("business_configs")
      .select("business_id")
      .eq("business_id", businessId)
      .maybeSingle();
    if (lookupErr) {
      console.error("[sso] business_configs lookup failed:", lookupErr);
      return res.status(500).json({ error: lookupErr.message });
    }
    if (!existing) {
      return res
        .status(404)
        .json({ error: `Business not found: ${businessId}` });
    }

    const { error: updateErr } = await supabase
      .from("business_configs")
      .update({ sso_connection_id: connectionId })
      .eq("business_id", businessId);
    if (updateErr) {
      const unique =
        /duplicate key|unique constraint/i.test(updateErr.message || "");
      console.error("[sso] business_configs update failed:", updateErr);
      return res.status(unique ? 409 : 500).json({
        error: unique
          ? "This WorkOS connection is already linked to a different business"
          : updateErr.message,
      });
    }

    await auditLog({
      userId: req.userId,
      businessId,
      action: "sso.connection.linked",
      resource: "business_configs",
      resourceId: businessId,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: {
        connectionId,
        organizationId: workosConnection.organizationId,
        connectionName: workosConnection.name,
        connectionState: workosConnection.state,
      },
    });

    return res.status(200).json({
      businessId,
      connectionId,
      connection: {
        id: workosConnection.id,
        name: workosConnection.name,
        state: workosConnection.state,
        // SDK exposes the IdP-protocol enum as `type`; renamed in our
        // response so admin UIs aren't tempted to overload `type`.
        connectionType: workosConnection.type,
        organizationId: workosConnection.organizationId,
      },
    });
  },
);

router.get(
  "/connection/:businessId",
  requireAuth,
  requireStaffOrBootstrap("read"),
  async (req: Request, res: Response) => {
    const businessId = String(req.params["businessId"] || "");
    if (!isNonEmptyString(businessId)) {
      return res.status(400).json({ error: "businessId required" });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    const { data, error } = await supabase
      .from("business_configs")
      .select("business_id, sso_connection_id")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      console.error("[sso] business_configs select failed:", error);
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res
        .status(404)
        .json({ error: `Business not found: ${businessId}` });
    }

    const connectionId =
      (data as { sso_connection_id?: string | null }).sso_connection_id ?? null;

    if (!connectionId) {
      return res
        .status(200)
        .json({ businessId, connectionId: null, connection: null });
    }

    try {
      const c = await workos.sso.getConnection(connectionId);
      return res.status(200).json({
        businessId,
        connectionId,
        connection: {
          id: c.id,
          name: c.name,
          state: c.state,
          connectionType: c.type,
          organizationId: c.organizationId,
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        "[sso] getConnection failed during GET for",
        connectionId,
        "—",
        msg,
      );
      return res.status(200).json({
        businessId,
        connectionId,
        connection: null,
        connectionError: msg,
      });
    }
  },
);

router.delete(
  "/connection/:businessId",
  requireAuth,
  requireStaffOrBootstrap("write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const businessId = String(req.params["businessId"] || "");
    if (!isNonEmptyString(businessId)) {
      return res.status(400).json({ error: "businessId required" });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    const { data: existing, error: lookupErr } = await supabase
      .from("business_configs")
      .select("business_id, sso_connection_id")
      .eq("business_id", businessId)
      .maybeSingle();
    if (lookupErr) {
      console.error("[sso] business_configs lookup failed:", lookupErr);
      return res.status(500).json({ error: lookupErr.message });
    }
    if (!existing) {
      return res
        .status(404)
        .json({ error: `Business not found: ${businessId}` });
    }

    const previousConnectionId =
      (existing as { sso_connection_id?: string | null })
        .sso_connection_id ?? null;

    if (previousConnectionId === null) {
      await auditLog({
        userId: req.userId,
        businessId,
        action: "sso.connection.unlinked",
        resource: "business_configs",
        resourceId: businessId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { previousConnectionId: null, noop: true },
      });
      return res.status(200).json({
        businessId,
        previousConnectionId: null,
        cleared: false,
        note: "no SSO connection was linked",
      });
    }

    const { error: updateErr } = await supabase
      .from("business_configs")
      .update({ sso_connection_id: null })
      .eq("business_id", businessId);
    if (updateErr) {
      console.error("[sso] business_configs unlink failed:", updateErr);
      return res.status(500).json({ error: updateErr.message });
    }

    await auditLog({
      userId: req.userId,
      businessId,
      action: "sso.connection.unlinked",
      resource: "business_configs",
      resourceId: businessId,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { previousConnectionId },
    });

    return res
      .status(200)
      .json({ businessId, previousConnectionId, cleared: true });
  },
);

// ===========================================================================
// PHASE 3 — login flow
// ===========================================================================

// ---------------------------------------------------------------------------
// JIT provisioning helper. Extracted from the callback handler so a smoke
// probe can drive the same code path with a synthetic profile (no need to
// monkey-patch the Express layer).
//
// Contract:
//   - profile must include email + connectionId. Email-missing is the
//     locked product decision: surface and stop. Returned as `error: "email_missing"`.
//   - The connection must already be linked to a business via Phase 2 —
//     otherwise we return `error: "connection_unprovisioned"`.
//   - If a Supabase user with this email already exists, we attach them
//     to the SSO-mapped business at JIT_DEFAULT_ROLE (idempotent — won't
//     create a second user_businesses row if one exists).
//   - If the user is brand new, we create them with email_confirm: true
//     and attach them at JIT_DEFAULT_ROLE.
//   - On success, returns { userId, businessId, isNewUser, attached: bool }.
//     Caller is responsible for minting a session for `userId`.
//
// All Supabase calls are made via the service-key admin client; this is
// privileged code that runs pre-login and must not depend on req.userId.
// ---------------------------------------------------------------------------
export interface JitProfile {
  email?: string | null;
  connectionId?: string | null;
  idpId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export type JitErrorReason =
  | "email_missing"
  | "connection_unprovisioned"
  | "supabase_unavailable"
  | "supabase_error";

export type JitResult =
  | {
      ok: true;
      userId: string;
      email: string;
      businessId: string;
      isNewUser: boolean;
      newMembership: boolean;
    }
  | {
      ok: false;
      error: JitErrorReason;
      details?: string;
    };

export async function provisionSsoSession(
  profile: JitProfile,
  supabase: SupabaseClient,
): Promise<JitResult> {
  const email = profile.email?.trim();
  if (!email) {
    return { ok: false, error: "email_missing" };
  }
  const connectionId = profile.connectionId?.trim();
  if (!connectionId) {
    // Not in the brief but defensively obvious: a profile with no
    // connectionId can't be mapped to a tenant. Same product-stop posture.
    return { ok: false, error: "connection_unprovisioned" };
  }

  // 1. Tenant lookup by connection.
  const { data: bizRow, error: bizErr } = await supabase
    .from("business_configs")
    .select("business_id")
    .eq("sso_connection_id", connectionId)
    .maybeSingle();
  if (bizErr) {
    return { ok: false, error: "supabase_error", details: bizErr.message };
  }
  if (!bizRow) {
    return { ok: false, error: "connection_unprovisioned" };
  }
  const businessId = (bizRow as { business_id: string }).business_id;

  // 2. Find or create Supabase user. listUsers paginates — for an MVP
  //    we ask the admin API to find by email directly (Supabase v2 does
  //    not expose getUserByEmail, so we list with a tight filter).
  let userId: string | null = null;
  let isNewUser = false;
  try {
    // listUsers does not support server-side email filtering in older
    // versions; we paginate the first page and lookup by email locally.
    // For an MVP this is acceptable; revisit if user count exceeds ~1k.
    const { data: listed, error: listErr } =
      await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (listErr) {
      return {
        ok: false,
        error: "supabase_error",
        details: listErr.message,
      };
    }
    const existing = (listed?.users || []).find(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (existing) {
      userId = existing.id;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "supabase_error", details: msg };
  }

  if (!userId) {
    const { data: created, error: createErr } =
      await supabase.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: {
          sso_provider: "workos",
          sso_connection_id: connectionId,
          sso_idp_id: profile.idpId || null,
          first_name: profile.firstName || null,
          last_name: profile.lastName || null,
        },
      });
    if (createErr || !created?.user) {
      return {
        ok: false,
        error: "supabase_error",
        details: createErr?.message || "createUser returned no user",
      };
    }
    userId = created.user.id;
    isNewUser = true;
  }

  // 3. Membership: idempotent attach. If a user_businesses row already
  //    exists for this (user, business) pair, we leave it untouched —
  //    SSO must not silently downgrade a user who is already an
  //    'admin' or 'owner' to 'member'.
  const { data: existingMembership, error: memLookupErr } = await supabase
    .from("user_businesses")
    .select("id, role")
    .eq("user_id", userId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (memLookupErr) {
    return {
      ok: false,
      error: "supabase_error",
      details: memLookupErr.message,
    };
  }

  let newMembership = false;
  if (!existingMembership) {
    const { error: insErr } = await supabase
      .from("user_businesses")
      .insert({
        user_id: userId,
        business_id: businessId,
        role: JIT_DEFAULT_ROLE,
        created_at: new Date().toISOString(),
      });
    if (insErr) {
      return {
        ok: false,
        error: "supabase_error",
        details: insErr.message,
      };
    }
    newMembership = true;
  }

  return {
    ok: true,
    userId,
    email,
    businessId,
    isNewUser,
    newMembership,
  };
}

// ---------------------------------------------------------------------------
// GET /api/sso/init
//   Query: connectionId (required)
//   Effect: builds the IdP authorization URL (with HMAC-signed state) and
//   302-redirects the browser to it. Returns the URL as JSON instead when
//   ?as=json is present (useful for admin UIs that want to surface the URL
//   for a "Sign in via SSO" button).
// ---------------------------------------------------------------------------
router.get("/init", async (req: Request, res: Response) => {
  const connectionId = String(req.query["connectionId"] || "");
  if (!isNonEmptyString(connectionId)) {
    return res
      .status(400)
      .json({ error: "connectionId query parameter is required" });
  }

  let url: string;
  try {
    url = workos.sso.getAuthorizationUrl({
      connection: connectionId,
      clientId: WORKOS_CLIENT_ID,
      redirectUri: buildCallbackUrl(req),
      state: signSsoState(connectionId),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[sso] init failed for", connectionId, "—", msg);
    return res.status(400).json({
      error: "Could not build SSO authorization URL",
      details: msg,
    });
  }

  if (req.query["as"] === "json") {
    return res.status(200).json({ url, connectionId });
  }
  return res.redirect(302, url);
});

// ---------------------------------------------------------------------------
// GET /api/sso/callback
//   Query: code (required), state (required)
//   Effect: exchanges the code for a profile, JIT-provisions / attaches
//   the user, mints a one-time magic-link via Supabase admin, then
//   302-redirects to the magic-link's action_link. Supabase verifies the
//   link and forwards the browser to APP_URL/dashboard with the session
//   tokens in the URL fragment — the same finishing state as a normal
//   email/password login.
// ---------------------------------------------------------------------------
router.get("/callback", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  const code = String(req.query["code"] || "");
  const state = String(req.query["state"] || "");
  const errorParam = String(req.query["error"] || "");
  const errorDescription = String(req.query["error_description"] || "");

  // IdP-side rejection (user cancelled, IdP refused). Surface it cleanly
  // rather than dropping into our state-validation path.
  if (errorParam) {
    await auditLog({
      action: "sso.callback.idp_error",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { error: errorParam, description: errorDescription },
    });
    return res.status(400).json({
      error: "SSO provider returned an error",
      details: errorDescription || errorParam,
    });
  }

  if (!isNonEmptyString(code) || !isNonEmptyString(state, 4096)) {
    return res
      .status(400)
      .json({ error: "code and state query parameters are required" });
  }

  const stateInfo = verifySsoState(state);
  if (!stateInfo) {
    await auditLog({
      action: "sso.callback.state_invalid",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { state_length: state.length },
    });
    return res.status(403).json({
      error: "Invalid or expired SSO state token",
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  // Exchange code for profile.
  let profile;
  try {
    const result = await workos.sso.getProfileAndToken({
      code,
      clientId: WORKOS_CLIENT_ID,
    });
    profile = result.profile;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[sso] getProfileAndToken failed —", msg);
    await auditLog({
      action: "sso.callback.exchange_failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { error: msg },
    });
    return res.status(400).json({
      error: "Could not exchange SSO code for profile",
      details: msg,
    });
  }

  // Bind state's connectionId to the profile's connectionId. This catches
  // a subtle attack: an attacker tricks user A (admin of business 1) into
  // hitting /init?connectionId=conn_business1 and then swaps in a code
  // from a session bound to conn_business2. Without this check, A would
  // get attached to business 2.
  if (profile.connectionId !== stateInfo.connectionId) {
    await auditLog({
      action: "sso.callback.connection_mismatch",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: {
        state_connection: stateInfo.connectionId,
        profile_connection: profile.connectionId,
      },
    });
    return res.status(403).json({
      error: "SSO state connection does not match profile connection",
    });
  }

  // JIT-provision. Same code path the smoke probe drives.
  const jit = await provisionSsoSession(
    {
      email: profile.email,
      connectionId: profile.connectionId,
      idpId: profile.idpId,
      firstName: profile.firstName,
      lastName: profile.lastName,
    },
    supabase,
  );

  if (!jit.ok) {
    await auditLog({
      action: "sso.callback.jit_failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: {
        reason: jit.error,
        details: jit.details,
        connectionId: profile.connectionId,
      },
    });
    const statusByReason: Record<JitErrorReason, number> = {
      email_missing: 400,
      connection_unprovisioned: 400,
      supabase_unavailable: 503,
      supabase_error: 500,
    };
    return res.status(statusByReason[jit.error] ?? 500).json({
      error: jit.error,
      details: jit.details,
    });
  }

  // Mint a magic link to bridge the JIT'd identity into a Supabase session.
  // properties.action_link is a fully-qualified URL pointing at Supabase's
  // verify endpoint; Supabase verifies and then redirects the browser to
  // `redirectTo` with the access/refresh tokens in the URL fragment —
  // matching how the dashboard already consumes email/password sessions.
  let actionLink: string;
  try {
    const { data: linkData, error: linkErr } =
      await supabase.auth.admin.generateLink({
        type: "magiclink",
        email: jit.email,
        options: { redirectTo: buildPostLoginUrl() },
      });
    if (linkErr || !linkData?.properties?.action_link) {
      throw new Error(linkErr?.message || "magic link generation returned no action_link");
    }
    actionLink = linkData.properties.action_link;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sso] magic-link generation failed —", msg);
    await auditLog({
      userId: jit.userId,
      businessId: jit.businessId,
      action: "sso.callback.session_mint_failed",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { error: msg },
    });
    return res.status(500).json({
      error: "Could not mint session for SSO user",
      details: msg,
    });
  }

  await auditLog({
    userId: jit.userId,
    businessId: jit.businessId,
    action: "sso.login.success",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: true,
    details: {
      connectionId: profile.connectionId,
      isNewUser: jit.isNewUser,
      newMembership: jit.newMembership,
      stateAgeMs: stateInfo.ageMs,
    },
  });

  return res.redirect(302, actionLink);
});

// ===========================================================================
// PHASE 4 — frontend entry points (tenant self-service + email lookup)
// ===========================================================================

// Public-mail providers we refuse to accept as SSO domains. If a tenant
// could claim "gmail.com" then ANY user with a gmail address would get
// silently redirected to that tenant's IdP — a critical wrong-tenant
// data-leak class of bug. Same logic applies to outlook/yahoo/etc.
// Maintained inline (not in the schema) so the list can grow without a
// migration. See migration 014 header for rationale.
const PUBLIC_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "gmx.com",
  "gmx.us",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "126.com",
]);

// Strict-but-pragmatic domain validator: lowercases, trims, strips a
// stray leading "@" or "." (common copy-paste artifacts), and requires
// at least one dot with non-empty labels. Rejects anything containing
// whitespace, slashes, "://" or other URL-ish junk. Returns a normalised
// string or null on rejection.
function normalizeDomain(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  if (d.startsWith("@")) d = d.slice(1);
  if (d.startsWith(".")) d = d.slice(1);
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length < 3 || d.length > 253) return null;
  // Reject any URL-shaped or scheme-prefixed input.
  if (/[\s/?#:]/.test(d)) return null;
  // Each label must be 1..63 chars, alphanumeric or hyphen, no leading/trailing hyphen.
  const labels = d.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return d;
}

// Extract the domain portion of an email. Returns null if the email is
// malformed or the domain is something we refuse to look up (public
// mail provider — see PUBLIC_EMAIL_DOMAINS).
function extractLookupDomain(email: string): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;
  const domain = trimmed.slice(atIdx + 1);
  const norm = normalizeDomain(domain);
  if (!norm) return null;
  if (PUBLIC_EMAIL_DOMAINS.has(norm)) return null;
  return norm;
}

// ---------------------------------------------------------------------------
// GET /api/sso/lookup?email=<email>
//   PUBLIC (pre-login). Used by the /signup page's "Sign in with SSO" form.
//   Returns { connectionId } if the email's domain maps to a tenant with
//   an SSO connection; 404 otherwise. Deliberately does NOT echo back
//   the businessId (would let an attacker enumerate which orgs use
//   which domains).
// ---------------------------------------------------------------------------
router.get("/lookup", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  const emailRaw = String(req.query["email"] || "");
  if (!isNonEmptyString(emailRaw)) {
    return res
      .status(400)
      .json({ error: "email query parameter is required" });
  }

  const domain = extractLookupDomain(emailRaw);
  if (!domain) {
    // Unified 404 for "malformed email" AND "public-mail domain" —
    // returning different messages would leak which addresses are
    // valid vs. blocked. UX-wise the signup page shows the same
    // "SSO not configured" message either way.
    return res.status(404).json({
      error: "no_sso_connection",
      message:
        "SSO is not configured for this email address. Try password login or contact your administrator.",
    });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ error: "Database unavailable" });
  }

  // Match any business_configs row where the domain is in sso_email_domains
  // AND a connection is actually linked. Both conditions matter — a tenant
  // might have registered domains but cleared their connection_id.
  const { data, error } = await supabase
    .from("business_configs")
    .select("sso_connection_id")
    .contains("sso_email_domains", [domain])
    .not("sso_connection_id", "is", null)
    .limit(2); // limit 2 so we can detect ambiguity (>1 match)

  if (error) {
    // If the column doesn't exist yet (migration 014 not applied), the
    // PostgREST error code is "42703". Surface as a graceful 503 rather
    // than a 500 — this lets the dashboard fall back to password login
    // until the migration lands.
    const undefinedColumn = /sso_email_domains/.test(error.message || "");
    if (undefinedColumn) {
      console.warn(
        "[sso] /lookup degraded: sso_email_domains column missing. Apply migration 014.",
      );
      return res.status(503).json({
        error: "sso_lookup_unavailable",
        message: "SSO lookup is temporarily unavailable.",
      });
    }
    console.error("[sso] /lookup query failed:", error);
    return res.status(500).json({ error: error.message });
  }

  const rows = (data || []) as Array<{ sso_connection_id: string | null }>;
  if (rows.length === 0) {
    await auditLog({
      action: "sso.lookup.miss",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { domain },
    });
    return res.status(404).json({
      error: "no_sso_connection",
      message:
        "SSO is not configured for this email address. Try password login or contact your administrator.",
    });
  }
  if (rows.length > 1) {
    // Two tenants both claim the same domain. The admin UI prevents
    // this on the write path (see /tenant-connection POST below) but
    // the partial-unique-index on sso_connection_id doesn't cover
    // domain collisions, so we defend at read-time too.
    await auditLog({
      action: "sso.lookup.ambiguous",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { domain, match_count: rows.length },
    });
    return res.status(409).json({
      error: "sso_lookup_ambiguous",
      message:
        "Multiple SSO configurations match this email domain. Contact support.",
    });
  }

  const connectionId = rows[0]!.sso_connection_id!;
  return res.status(200).json({ connectionId });
});

// ---------------------------------------------------------------------------
// GET /api/sso/tenant-connection
//   Tenant-scoped read. Returns the caller's active business's SSO
//   config (connectionId + email domains + a bookmarkable login URL).
//   No staff role required — any authenticated member of the business
//   can read this (so users can find the SSO URL to share).
// ---------------------------------------------------------------------------
router.get(
  "/tenant-connection",
  requireAuth,
  async (req: Request, res: Response) => {
    const businessId = req.businessId;
    if (!businessId) {
      return res.status(403).json({ error: "No active business in scope" });
    }
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    // Ask for both Phase 2 + Phase 4 columns. If migration 014 isn't
    // applied yet, retry without sso_email_domains so the connection
    // info still renders for the admin (they'll just see no domains).
    let row:
      | { sso_connection_id: string | null; sso_email_domains: string[] | null }
      | null = null;
    let degraded = false;

    {
      const r = await supabase
        .from("business_configs")
        .select("sso_connection_id, sso_email_domains")
        .eq("business_id", businessId)
        .maybeSingle();
      if (r.error && /sso_email_domains/.test(r.error.message || "")) {
        degraded = true;
        const r2 = await supabase
          .from("business_configs")
          .select("sso_connection_id")
          .eq("business_id", businessId)
          .maybeSingle();
        if (r2.error) {
          return res.status(500).json({ error: r2.error.message });
        }
        row = r2.data
          ? {
              sso_connection_id: (r2.data as { sso_connection_id: string | null })
                .sso_connection_id,
              sso_email_domains: null,
            }
          : null;
      } else if (r.error) {
        return res.status(500).json({ error: r.error.message });
      } else {
        row = (r.data as typeof row) ?? null;
      }
    }

    if (!row) {
      return res
        .status(404)
        .json({ error: `Business not found: ${businessId}` });
    }

    const connectionId = row.sso_connection_id ?? null;
    const emailDomains = row.sso_email_domains ?? [];

    // Build the bookmarkable login URL using the same BASE_URL/REPLIT_DEV_DOMAIN
    // logic init/callback already use, so dev and prod stay consistent.
    const base =
      process.env["BASE_URL"] ||
      (process.env["REPLIT_DEV_DOMAIN"]
        ? `https://${process.env["REPLIT_DEV_DOMAIN"]}`
        : `${req.protocol}://${req.get("host")}`);
    const loginUrl = connectionId
      ? `${base.replace(/\/$/, "")}/api/sso/init?connectionId=${encodeURIComponent(connectionId)}`
      : null;

    let connectionStatus: { name?: string; state?: string } | null = null;
    let connectionError: string | null = null;
    if (connectionId) {
      try {
        const c = await workos.sso.getConnection(connectionId);
        connectionStatus = { name: c.name, state: c.state };
      } catch (err: unknown) {
        connectionError = err instanceof Error ? err.message : String(err);
      }
    }

    return res.status(200).json({
      businessId,
      connectionId,
      emailDomains,
      loginUrl,
      connectionStatus,
      connectionError,
      schemaDegraded: degraded,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/sso/tenant-connection
//   Tenant-scoped write. Caller must be the active business's admin or
//   owner (req.isAdmin set by requireAuth). Body:
//     { connectionId?: string|null, emailDomains?: string[] }
//   Either field may be omitted to leave it untouched. Pass
//   connectionId: null to clear.
// ---------------------------------------------------------------------------
router.post(
  "/tenant-connection",
  requireAuth,
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const businessId = req.businessId;
    if (!businessId) {
      return res.status(403).json({ error: "No active business in scope" });
    }
    if (!req.isAdmin) {
      return res
        .status(403)
        .json({ error: "Only business admins or owners can configure SSO" });
    }

    const body = (req.body || {}) as {
      connectionId?: unknown;
      emailDomains?: unknown;
    };

    const updates: Record<string, unknown> = {};

    // connectionId: optional. Accept string OR null. Anything else rejected.
    if ("connectionId" in body) {
      const cid = body.connectionId;
      if (cid === null) {
        updates["sso_connection_id"] = null;
      } else if (isNonEmptyString(cid)) {
        // Verify the connection exists in WorkOS BEFORE writing it.
        // Saves the tenant from chasing "why doesn't login work" later.
        try {
          await workos.sso.getConnection(cid);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(400).json({
            error: "WorkOS connection not found or unreachable",
            details: msg,
          });
        }
        updates["sso_connection_id"] = cid;
      } else {
        return res.status(400).json({
          error: "connectionId must be a non-empty string or null",
        });
      }
    }

    // emailDomains: optional. Must be an array of strings; we normalise
    // each, drop empties, dedupe, and reject public-mail providers.
    let normalisedDomains: string[] | null = null;
    if ("emailDomains" in body) {
      if (!Array.isArray(body.emailDomains)) {
        return res
          .status(400)
          .json({ error: "emailDomains must be an array of strings" });
      }
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of body.emailDomains) {
        if (typeof raw !== "string") continue;
        const norm = normalizeDomain(raw);
        if (!norm) {
          return res.status(400).json({
            error: "invalid_domain",
            details: `Could not parse domain: ${raw}`,
          });
        }
        if (PUBLIC_EMAIL_DOMAINS.has(norm)) {
          return res.status(400).json({
            error: "public_email_domain_blocked",
            details: `Public-mail providers are not allowed as SSO domains: ${norm}`,
          });
        }
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
      // Hard cap to keep an admin from pasting a 10k-line list. 50 is
      // generous (most enterprises use <5 domains).
      if (out.length > 50) {
        return res
          .status(400)
          .json({ error: "Too many domains (max 50)" });
      }
      normalisedDomains = out;
      updates["sso_email_domains"] = out;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: "No fields to update. Send connectionId and/or emailDomains.",
      });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(503).json({ error: "Database unavailable" });
    }

    // Verify the row exists and is the caller's own business (defence-in-depth
    // — req.businessId already comes from requireAuth, but a stale cache
    // could in theory desync).
    const { data: existing, error: lookupErr } = await supabase
      .from("business_configs")
      .select("business_id")
      .eq("business_id", businessId)
      .maybeSingle();
    if (lookupErr) {
      return res.status(500).json({ error: lookupErr.message });
    }
    if (!existing) {
      return res
        .status(404)
        .json({ error: `Business not found: ${businessId}` });
    }

    // Pre-write domain-collision check. Same logic the lookup defends
    // against, but enforced here too so we fail FAST on save instead
    // of letting the data sit and surface an ambiguous-lookup later.
    if (normalisedDomains && normalisedDomains.length > 0) {
      const { data: collisions, error: collisionErr } = await supabase
        .from("business_configs")
        .select("business_id")
        .neq("business_id", businessId)
        .overlaps("sso_email_domains", normalisedDomains);
      if (collisionErr && !/sso_email_domains/.test(collisionErr.message || "")) {
        return res.status(500).json({ error: collisionErr.message });
      }
      if (collisions && collisions.length > 0) {
        return res.status(409).json({
          error: "domain_already_claimed",
          details:
            "One or more of these domains is already configured for SSO by another business.",
        });
      }
    }

    const { error: updateErr } = await supabase
      .from("business_configs")
      .update(updates)
      .eq("business_id", businessId);
    if (updateErr) {
      const unique =
        /duplicate key|unique constraint/i.test(updateErr.message || "");
      const undefinedColumn =
        /sso_email_domains/.test(updateErr.message || "");
      if (undefinedColumn) {
        return res.status(503).json({
          error: "sso_email_domains_unavailable",
          details:
            "Domain configuration requires migration 014 to be applied. Connection ID can still be saved alone.",
        });
      }
      console.error("[sso] tenant-connection update failed:", updateErr);
      return res.status(unique ? 409 : 500).json({
        error: unique
          ? "This WorkOS connection is already linked to a different business"
          : updateErr.message,
      });
    }

    await auditLog({
      userId: req.userId,
      businessId,
      action: "sso.tenant_connection.updated",
      resource: "business_configs",
      resourceId: businessId,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: {
        updatedFields: Object.keys(updates),
        emailDomainCount: normalisedDomains?.length,
      },
    });

    return res.status(200).json({
      businessId,
      ...updates,
    });
  },
);

export default router;
