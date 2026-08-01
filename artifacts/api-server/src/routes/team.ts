/**
 * Phase 3.1a — team management endpoints.
 *
 *   GET    /api/business/team                     — list members + topics + duty state
 *   POST   /api/business/team/invite              — invite by email (Supabase invite)
 *   PATCH  /api/business/team/:userId             — role, callback_ring_number, topics
 *   DELETE /api/business/team/:userId             — remove from business (403 on self)
 *
 *   POST   /api/business/team/me/on-duty          — clock in
 *   POST   /api/business/team/me/off-duty         — clock out
 *   GET    /api/business/team/on-duty             — snapshot of currently-on-duty members
 *
 * All routes are tenant-scoped via req.businessId (set by requireAuth
 * from the caller's active membership). Cross-tenant access returns 404
 * (not 403 — we don't leak existence).
 *
 * Role changes are gated by canGrantEnterpriseRole so a manager can't
 * mint themselves a peer admin. Owners are never grantable through the
 * invite/patch flow (established at signup, changed only by direct DB
 * intervention).
 *
 * Topic assignments: PATCH replaces the caller's full set of topics for
 * this user (bulk replace) via DELETE + INSERT staff_topics rows. Not
 * differential — the UI sends the full list, we mirror it. Slug
 * validation checks each slug against business_configs.departments so
 * we never persist a reference to a topic the business doesn't have.
 *
 * Handlers are exported as pure functions taking (supabase, businessId,
 * [callerUserId], body) so the 035 smoke can invoke them directly with
 * a FakeSupabaseClient — same pattern as routes/campaigns.ts.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import {
  requireAuth,
  requirePermission,
  canGrantEnterpriseRole,
  ASSIGNABLE_ENTERPRISE_ROLES,
  type EnterpriseRole,
} from "../middlewares/auth";
// Phase 3.15 — shared with routing.ts + reachability so all three
// surfaces (routing engine, /voice/reachability, team page) apply the
// same freshness threshold. Widened 90→300s to tolerate throttled
// background tabs; see the constant's own JSDoc.
import { DEVICE_FRESHNESS_SECS } from "../lib/routing/constants";
// Phase 3.17 — first-class business invites. We own the token, store
// only its hash, and expose a POST-only acceptance route. Rebuilds
// the invite flow from scratch after M365 Safe Links prefetched the
// old one-time Supabase magic links out of production.
import {
  issueInviteToken,
  hashInviteToken,
  inviteExpiryFromNow,
} from "../lib/invite-token";
import { sendTeamInviteEmail } from "../email";

const router = Router();

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Types ────────────────────────────────────────────────────────────

export interface TeamMemberRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_on_duty: boolean;
  on_duty_since: string | null;
  callback_ring_number: string | null;
  assigned_topics: string[];
  created_at: string | null;
  // Phase 3.15 — device presence so the Team page can flag rows
  // that are on duty + in-app calling but with a stale/never-seen
  // heartbeat AND no callback number (operational risk owner
  // should see, per phase brief #5). We do NOT auto-clock out.
  in_app_calling_enabled: boolean;
  voice_device_last_seen_at: string | null;
  device_heartbeat_fresh: boolean;
}

interface UserBusinessRow {
  user_id: string;
  role: string;
  is_on_duty: boolean | null;
  on_duty_since: string | null;
  callback_ring_number: string | null;
  created_at: string | null;
  // Phase 3.15 — see TeamMemberRow.
  in_app_calling_enabled: boolean | null;
  voice_device_last_seen_at: string | null;
}

interface StaffTopicRow {
  user_id: string;
  topic_slug: string;
}

// ── Body validation ──────────────────────────────────────────────────

export interface ParsedInviteBody {
  email: string;
  role: EnterpriseRole;
  initial_topics: string[];
  callback_ring_number: string | null;
  full_name: string | null;
}

export function parseInviteBody(body: unknown): ParsedInviteBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;

  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email)) return { error: "email is required (valid format)" };

  const role = typeof b.role === "string" ? (b.role as EnterpriseRole) : "user";
  if (!ASSIGNABLE_ENTERPRISE_ROLES.includes(role)) {
    return { error: `role must be one of ${ASSIGNABLE_ENTERPRISE_ROLES.join(", ")}` };
  }

  let initial_topics: string[] = [];
  if (Array.isArray(b.initial_topics)) {
    initial_topics = b.initial_topics
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim());
    for (const slug of initial_topics) {
      if (!SLUG_RE.test(slug)) return { error: `invalid topic slug "${slug}" (expected snake_case)` };
    }
  }

  let callback_ring_number: string | null = null;
  if (b.callback_ring_number !== undefined && b.callback_ring_number !== null) {
    if (typeof b.callback_ring_number !== "string" || !E164_RE.test(b.callback_ring_number.trim())) {
      return { error: "callback_ring_number must be an E.164 phone number" };
    }
    callback_ring_number = b.callback_ring_number.trim();
  }

  const full_name = typeof b.full_name === "string" && b.full_name.trim() ? b.full_name.trim() : null;

  return { email, role, initial_topics, callback_ring_number, full_name };
}

export interface ParsedPatchBody {
  role?: EnterpriseRole;
  callback_ring_number?: string | null;
  topics?: string[];
}

export function parseMemberPatchBody(body: unknown): ParsedPatchBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;
  const out: ParsedPatchBody = {};

  if ("role" in b) {
    const role = b.role;
    if (typeof role !== "string" || !ASSIGNABLE_ENTERPRISE_ROLES.includes(role as EnterpriseRole)) {
      return { error: `role must be one of ${ASSIGNABLE_ENTERPRISE_ROLES.join(", ")}` };
    }
    out.role = role as EnterpriseRole;
  }

  if ("callback_ring_number" in b) {
    const v = b.callback_ring_number;
    if (v === null || v === "") {
      out.callback_ring_number = null;
    } else if (typeof v === "string" && E164_RE.test(v.trim())) {
      out.callback_ring_number = v.trim();
    } else {
      return { error: "callback_ring_number must be an E.164 phone number or null" };
    }
  }

  if ("topics" in b) {
    if (!Array.isArray(b.topics)) return { error: "topics must be an array of slug strings" };
    const topics = b.topics
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim());
    for (const slug of topics) {
      if (!SLUG_RE.test(slug)) return { error: `invalid topic slug "${slug}" (expected snake_case)` };
    }
    out.topics = topics;
  }

  if (Object.keys(out).length === 0) return { error: "No fields to update" };
  return out;
}

// ── Helper: fetch email/name for a set of user_ids in parallel ───────

async function hydrateUsers(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, { email: string | null; full_name: string | null }>> {
  const map = new Map<string, { email: string | null; full_name: string | null }>();
  if (userIds.length === 0) return map;
  const admin = (supabase.auth as any).admin;
  if (!admin?.getUserById) return map;

  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await admin.getUserById(uid);
        const u = data?.user;
        if (u) {
          map.set(uid, {
            email: u.email || null,
            full_name: u.user_metadata?.full_name || u.user_metadata?.name || null,
          });
        } else {
          map.set(uid, { email: null, full_name: null });
        }
      } catch {
        map.set(uid, { email: null, full_name: null });
      }
    }),
  );
  return map;
}

// ── Helper: validate slugs against business_configs.departments ──────

async function loadBusinessTopicSlugs(
  supabase: SupabaseClient,
  businessId: string,
): Promise<Set<string> | { error: string }> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("departments")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) return { error: error.message };
  const departments = (data as { departments?: unknown } | null)?.departments;
  const slugs = new Set<string>();
  if (Array.isArray(departments)) {
    for (const t of departments as any[]) {
      if (t && typeof t === "object" && typeof t.slug === "string") slugs.add(t.slug);
    }
  }
  return slugs;
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function handleListTeam(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ ok: true; members: TeamMemberRow[] } | { ok: false; status: number; error: string }> {
  try {
    const ubResp = await supabase
      .from("user_businesses")
      .select(
        "user_id, role, is_on_duty, on_duty_since, callback_ring_number, created_at, in_app_calling_enabled, voice_device_last_seen_at",
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });
    if (ubResp.error) {
      Sentry.captureMessage("team_list_ub_failed", {
        level: "error",
        extra: { businessId, error: ubResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const ubRows = (ubResp.data as UserBusinessRow[] | null) ?? [];
    const userIds = ubRows.map((r) => r.user_id);

    const [topicsResp, userMap] = await Promise.all([
      supabase
        .from("staff_topics")
        .select("user_id, topic_slug")
        .eq("business_id", businessId),
      hydrateUsers(supabase, userIds),
    ]);
    if (topicsResp.error) {
      Sentry.captureMessage("team_list_topics_failed", {
        level: "error",
        extra: { businessId, error: topicsResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const topicsByUser = new Map<string, string[]>();
    for (const row of (topicsResp.data as StaffTopicRow[] | null) ?? []) {
      const arr = topicsByUser.get(row.user_id) ?? [];
      arr.push(row.topic_slug);
      topicsByUser.set(row.user_id, arr);
    }

    const nowMs = Date.now();
    const members: TeamMemberRow[] = ubRows.map((r) => {
      const u = userMap.get(r.user_id);
      const lastMs = r.voice_device_last_seen_at
        ? Date.parse(r.voice_device_last_seen_at)
        : NaN;
      const heartbeatFresh =
        !Number.isNaN(lastMs) && nowMs - lastMs <= DEVICE_FRESHNESS_SECS * 1000;
      return {
        user_id: r.user_id,
        email: u?.email ?? null,
        full_name: u?.full_name ?? null,
        role: r.role,
        is_on_duty: r.is_on_duty === true,
        on_duty_since: r.on_duty_since,
        callback_ring_number: r.callback_ring_number,
        assigned_topics: (topicsByUser.get(r.user_id) ?? []).sort(),
        created_at: r.created_at,
        in_app_calling_enabled: r.in_app_calling_enabled === true,
        voice_device_last_seen_at: r.voice_device_last_seen_at,
        device_heartbeat_fresh: heartbeatFresh,
      };
    });
    return { ok: true, members };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

/**
 * Phase 3.17 — invite lifecycle rebuilt from the ground up.
 *
 * OLD FLOW (removed): supabase.auth.admin.inviteUserByEmail sent a
 * Supabase magic link. Microsoft Defender Safe Links / Google URL
 * scanners prefetched the one-time GET on corporate M365/Workspace
 * mailboxes, silently redeeming the token before the human clicked.
 * Live evidence: aaliyah.louise@ezrentalsandleasing.com,
 * invited_at 19:27:47 / confirmed_at 19:28:35 (48s later) —
 * confirmed with no password, no real sign-in.
 *
 * NEW FLOW:
 *   1. Owner POSTs /business/team/invite → we write a
 *      business_invites row with a hashed token + 7-day expiry.
 *      NO auth.users row is created.
 *   2. Branded email is sent via Resend containing
 *      https://neverr.ai/invite/<raw-token>.
 *   3. Scanners GET /invite/:token → they hit our SPA HTML (static)
 *      and the API's GET /invites/lookup/:token (side-effect free).
 *   4. Human clicks, fills the form, POSTs
 *      /invites/accept — that is when the Supabase user is created
 *      with the human's password + user_businesses is inserted.
 *
 * Because acceptance is POST-only, scanner GET traffic cannot
 * consume the invite. Because the DB stores only the hash, a leak
 * cannot replay outstanding invites.
 */
export async function handleInviteMember(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
  callerRole: EnterpriseRole | undefined,
  body: ParsedInviteBody,
): Promise<
  | { ok: true; invite_id: string; email: string; expires_at: string; resent_previous: boolean }
  | { ok: false; status: number; error: string }
> {
  // Privilege check — reject before any DB write.
  if (!canGrantEnterpriseRole(callerRole, body.role)) {
    return {
      ok: false,
      status: 403,
      error: `Your role does not permit granting "${body.role}"`,
    };
  }

  // Validate topic slugs against the business's departments.
  if (body.initial_topics.length > 0) {
    const slugsOrErr = await loadBusinessTopicSlugs(supabase, businessId);
    if ("error" in slugsOrErr) {
      return { ok: false, status: 500, error: "Database error" };
    }
    const unknown = body.initial_topics.filter((s) => !slugsOrErr.has(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Unknown topic slug(s) for this business: ${unknown.join(", ")}`,
      };
    }
  }

  // Reject if this email is ALREADY a member of this business.
  // Requires a small userMap lookup via listUsers — cheaper than a
  // full auth admin round-trip for every invite because we scope to
  // this business's memberships.
  const existingMember = await findExistingMemberByEmail(
    supabase,
    businessId,
    body.email,
  );
  if (existingMember.error) {
    return { ok: false, status: 500, error: existingMember.error };
  }
  if (existingMember.userId) {
    return {
      ok: false,
      status: 409,
      error: "This email is already a member of this business",
    };
  }

  // Supersede any outstanding invite for the same (business, email).
  // A resend without an explicit /resend call is common — the owner
  // just clicks Invite again. Revoke old rows so the earlier email
  // can no longer be accepted; then issue a fresh token.
  const now = new Date();
  const supersedeResp = await supabase
    .from("business_invites")
    .update({ revoked_at: now.toISOString() })
    .eq("business_id", businessId)
    .eq("email", body.email)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  const resentPrevious = Array.isArray(supersedeResp.data)
    && supersedeResp.data.length > 0;

  // Mint a token — raw for the email URL, hash for the DB.
  const { raw, hash } = issueInviteToken();
  const expiresAt = inviteExpiryFromNow(now);

  const insertResp = await supabase
    .from("business_invites")
    .insert({
      business_id: businessId,
      email: body.email,
      role: body.role,
      callback_ring_number: body.callback_ring_number,
      topics: body.initial_topics,
      invited_by_user_id: callerUserId,
      token_hash: hash,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insertResp.error) {
    Sentry.captureMessage("team_invite_insert_failed", {
      level: "error",
      extra: { businessId, email: body.email, error: insertResp.error.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }
  const inviteId = (insertResp.data as { id: string }).id;

  // Fire the branded email. Failure to send is non-fatal — the row
  // exists and the owner can resend via the UI. We do log it though
  // so we notice email delivery breakage before customers do.
  const inviter = await lookupInviterMeta(supabase, callerUserId, businessId);
  try {
    await sendTeamInviteEmail({
      to: body.email,
      inviteToken: raw,
      businessName: inviter.businessName,
      inviterName: inviter.name,
      role: body.role,
      fullName: body.full_name,
      expiresAt,
    });
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { where: "sendTeamInviteEmail", inviteId },
    });
  }

  return {
    ok: true,
    invite_id: inviteId,
    email: body.email,
    expires_at: expiresAt,
    resent_previous: resentPrevious,
  };
}

/**
 * Phase 3.17 helper — look up whether `email` already has an active
 * (accepted or otherwise persisted) user_businesses row for
 * `businessId`. Uses the Supabase admin listUsers scoped by the small
 * membership list to avoid a full auth-user scan for every invite.
 * Returns { userId } if found, otherwise { userId: null }.
 */
async function findExistingMemberByEmail(
  supabase: SupabaseClient,
  businessId: string,
  email: string,
): Promise<{ userId: string | null; error?: string }> {
  try {
    const admin = (supabase.auth as any).admin;
    // listUsers is paged; page 1 with 200 users is enough for the
    // sizes we care about at this stage. Revisit if a tenant crosses
    // 200 members.
    const { data } = await admin.listUsers({ page: 1, perPage: 200 });
    const found = data?.users?.find(
      (u: any) => u.email?.toLowerCase() === email,
    );
    if (!found) return { userId: null };
    const ubResp = await supabase
      .from("user_businesses")
      .select("user_id")
      .eq("user_id", found.id)
      .eq("business_id", businessId)
      .maybeSingle();
    if (ubResp.error) return { userId: null, error: ubResp.error.message };
    return { userId: ubResp.data ? found.id : null };
  } catch (err: any) {
    return { userId: null, error: err?.message || "listUsers failed" };
  }
}

/**
 * Phase 3.17 helper — hydrate the inviter's display name + business
 * name for the branded email. Never fatal — we fall back to
 * generic labels if either lookup fails so the invite still lands.
 */
async function lookupInviterMeta(
  supabase: SupabaseClient,
  inviterUserId: string,
  businessId: string,
): Promise<{ name: string; businessName: string }> {
  let name = "Your teammate";
  let businessName = "the team";
  try {
    const admin = (supabase.auth as any).admin;
    const userRes = await admin.getUserById(inviterUserId);
    const meta = userRes?.data?.user?.user_metadata || {};
    const raw = meta.full_name || meta.name || userRes?.data?.user?.email;
    if (typeof raw === "string" && raw.trim()) name = raw.trim();
  } catch {
    // fall through to default
  }
  try {
    const bizResp = await supabase
      .from("business_configs")
      .select("business_name")
      .eq("business_id", businessId)
      .maybeSingle();
    const bn = (bizResp.data as { business_name?: string } | null)?.business_name;
    if (typeof bn === "string" && bn.trim()) businessName = bn.trim();
  } catch {
    // fall through
  }
  return { name, businessName };
}

// ── Phase 3.17: pending invites, GET-by-token, accept, resend, revoke ─

export interface PendingInviteRow {
  id: string;
  email: string;
  role: string;
  callback_ring_number: string | null;
  topics: string[];
  invited_by_user_id: string | null;
  expires_at: string;
  created_at: string;
}

/**
 * List pending (not accepted, not revoked, not expired) invites for
 * this business. Owner-visible list on the Team page. Sorted newest
 * first.
 */
export async function handleListPendingInvites(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; invites: PendingInviteRow[] }
  | { ok: false; status: number; error: string }
> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("business_invites")
    .select("id, email, role, callback_ring_number, topics, invited_by_user_id, expires_at, created_at")
    .eq("business_id", businessId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false });
  if (error) return { ok: false, status: 500, error: "Database error" };
  return { ok: true, invites: (data as PendingInviteRow[] | null) ?? [] };
}

/**
 * GET the state of an invite by raw token. Side-effect free — this is
 * the endpoint the /invite/:token SPA page calls to populate its
 * form. A scanner hitting this on prefetch does NOT change any DB
 * state (that's the whole point of Phase 3.17).
 *
 * Returned discriminated union lets the client render distinct
 * copy for each failure mode. Statuses are chosen so the SPA can
 * key on them:
 *   - "not_found"        (unknown token, 404)
 *   - "expired"          (expiry timestamp passed, 410 Gone)
 *   - "revoked"          (owner revoked or resend superseded, 410)
 *   - "already_accepted" (someone already POSTed accept, 410)
 *   - "ok"               (form should render)
 */
export type InviteLookupState =
  | "not_found"
  | "expired"
  | "revoked"
  | "already_accepted"
  | "ok";

export async function handleGetInviteByToken(
  supabase: SupabaseClient,
  rawToken: string,
): Promise<
  | { ok: true; state: InviteLookupState;
      invite?: {
        email: string;
        role: string;
        callback_ring_number: string | null;
        topics: string[];
        business_name: string;
        inviter_name: string | null;
        expires_at: string;
      };
    }
  | { ok: false; status: number; error: string }
> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 200) {
    // Length bounds match what generateInviteToken produces (~43 chars
    // base64url). Anything wildly off is definitely bogus; 404 without
    // hitting the DB.
    return { ok: true, state: "not_found" };
  }
  const hash = hashInviteToken(rawToken);
  const { data, error } = await supabase
    .from("business_invites")
    .select(
      "id, business_id, email, role, callback_ring_number, topics, invited_by_user_id, expires_at, accepted_at, revoked_at",
    )
    .eq("token_hash", hash)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Database error" };
  if (!data) return { ok: true, state: "not_found" };

  const row = data as {
    id: string;
    business_id: string;
    email: string;
    role: string;
    callback_ring_number: string | null;
    topics: string[] | null;
    invited_by_user_id: string | null;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  };

  if (row.accepted_at) return { ok: true, state: "already_accepted" };
  if (row.revoked_at) return { ok: true, state: "revoked" };
  if (Date.parse(row.expires_at) < Date.now()) return { ok: true, state: "expired" };

  // For the "ok" state we hydrate a few display fields (business
  // name, inviter name) so the SPA can render "Alex invited you to
  // Acme" without a second round-trip. We do NOT expose the id or
  // token_hash — the SPA doesn't need either.
  const inviter =
    row.invited_by_user_id !== null
      ? await lookupInviterName(supabase, row.invited_by_user_id)
      : null;
  const businessName = await lookupBusinessName(supabase, row.business_id);

  return {
    ok: true,
    state: "ok",
    invite: {
      email: row.email,
      role: row.role,
      callback_ring_number: row.callback_ring_number,
      topics: row.topics ?? [],
      business_name: businessName,
      inviter_name: inviter,
      expires_at: row.expires_at,
    },
  };
}

async function lookupInviterName(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const admin = (supabase.auth as any).admin;
    const userRes = await admin.getUserById(userId);
    const meta = userRes?.data?.user?.user_metadata || {};
    const raw = meta.full_name || meta.name || userRes?.data?.user?.email;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

async function lookupBusinessName(
  supabase: SupabaseClient,
  businessId: string,
): Promise<string> {
  try {
    const resp = await supabase
      .from("business_configs")
      .select("business_name")
      .eq("business_id", businessId)
      .maybeSingle();
    const bn = (resp.data as { business_name?: string } | null)?.business_name;
    return typeof bn === "string" && bn.trim() ? bn.trim() : "the team";
  } catch {
    return "the team";
  }
}

/**
 * POST accept an invite. This is where the auth user is created (or
 * looked up if they already had a Supabase account) and the
 * user_businesses row is inserted. Atomic-ish: on Supabase auth
 * failure, no membership row is written; on membership insert
 * failure, we delete the newly-created auth user to avoid orphaning.
 *
 * Password requirements match the existing auth signup schema (≥ 8
 * chars). The email is taken from the invite row — we do NOT trust
 * the client to send it. Same for role and business_id.
 */
export interface AcceptInviteInput {
  rawToken: string;
  password: string;
  fullName: string | null;
}

export async function handleAcceptInvite(
  supabase: SupabaseClient,
  input: AcceptInviteInput,
): Promise<
  | { ok: true; user_id: string; business_id: string; email: string }
  | { ok: false; status: number; error: string; state?: InviteLookupState }
> {
  if (!input.rawToken || typeof input.rawToken !== "string") {
    return { ok: false, status: 400, error: "token required" };
  }
  if (!input.password || typeof input.password !== "string" || input.password.length < 8) {
    return { ok: false, status: 400, error: "Password must be at least 8 characters" };
  }
  const hash = hashInviteToken(input.rawToken);

  // Re-check the invite state atomically with the accept. We SELECT
  // first to get the id + row for the accept UPDATE's WHERE clause;
  // the UPDATE uses `accepted_at IS NULL AND revoked_at IS NULL AND
  // expires_at > now()` so a concurrent second POST can't double-
  // accept the same invite.
  const lookup = await handleGetInviteByToken(supabase, input.rawToken);
  if (!lookup.ok) return { ok: false, status: lookup.status, error: lookup.error };
  if (lookup.state !== "ok") {
    const msg =
      lookup.state === "expired" ? "This invite has expired" :
      lookup.state === "revoked" ? "This invite was revoked" :
      lookup.state === "already_accepted" ? "This invite has already been accepted" :
      "This invite link is not valid";
    return { ok: false, status: 410, error: msg, state: lookup.state };
  }
  const invite = lookup.invite!;

  // Create the Supabase auth user with the human's password. We use
  // admin.createUser (NOT inviteUserByEmail) so no magic link goes
  // out and no confirmation email is sent — the human's presence at
  // this POST is proof enough of email ownership (they had to open
  // our email + click our SPA link to get here).
  const admin = (supabase.auth as any).admin;
  let userId: string | undefined;
  try {
    const createRes = await admin.createUser({
      email: invite.email,
      password: input.password,
      email_confirm: true,
      user_metadata: { full_name: input.fullName ?? undefined },
    });
    userId = createRes?.data?.user?.id;
    const createErr = createRes?.error;
    if (!userId && createErr) {
      // If the auth user already existed (rare — someone signed up
      // between invite issuance and acceptance), locate them by email
      // and update the password. Skip the password update if we can't
      // locate them cleanly; require the user to reset via /forgot.
      if (/already.*registered|already exists/i.test(createErr.message || "")) {
        const listRes = await admin.listUsers({ page: 1, perPage: 200 });
        const found = listRes?.data?.users?.find(
          (u: any) => u.email?.toLowerCase() === invite.email,
        );
        if (!found) {
          return { ok: false, status: 500, error: "Account exists but could not be located" };
        }
        userId = found.id;
        // Set the new password so the accept form is actually useful.
        try {
          await admin.updateUserById(userId, {
            password: input.password,
            email_confirm: true,
          });
        } catch {
          // Non-fatal — they can /forgot-password.
        }
      } else {
        Sentry.captureMessage("invite_accept_create_user_failed", {
          level: "error",
          extra: { error: createErr.message },
        });
        return { ok: false, status: 500, error: createErr.message || "Could not create account" };
      }
    }
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Could not create account" };
  }
  if (!userId) return { ok: false, status: 500, error: "Could not resolve user id" };

  // Hydrate business_id once — everything below writes to the same
  // (user, business) scope. Fail closed if the invite row disappeared
  // between the lookup and now (extremely unlikely but not free to
  // ignore).
  const businessId = await hydrateBusinessIdForInvite(supabase, hash);
  if (!businessId) {
    return { ok: false, status: 500, error: "Invite state changed during acceptance" };
  }

  // Insert the user_businesses row. If this fails, delete the auth
  // user we just created (unless it pre-existed) to avoid the orphan
  // case the Phase 3.16 audit called out.
  const { error: upsertErr } = await supabase
    .from("user_businesses")
    .upsert(
      {
        user_id: userId,
        business_id: businessId,
        role: invite.role,
        callback_ring_number: invite.callback_ring_number,
      },
      { onConflict: "user_id,business_id" },
    );
  if (upsertErr) {
    Sentry.captureMessage("invite_accept_ub_upsert_failed", {
      level: "error",
      extra: { userId, error: upsertErr.message },
    });
    // Best-effort orphan cleanup. If deleteUser also fails, we've
    // still logged the situation for follow-up.
    try {
      await admin.deleteUser(userId);
    } catch (delErr: any) {
      Sentry.captureException(delErr, {
        extra: { where: "invite_accept_orphan_cleanup", userId },
      });
    }
    return { ok: false, status: 500, error: "Database error" };
  }

  // Insert initial topics (best-effort — a failure here doesn't undo
  // the acceptance; the owner can set them later on the Team page).
  if (invite.topics.length > 0) {
    await supabase
      .from("staff_topics")
      .delete()
      .eq("user_id", userId)
      .eq("business_id", businessId);
    const rows = invite.topics.map((slug) => ({
      user_id: userId,
      business_id: businessId,
      topic_slug: slug,
    }));
    const { error: topicsErr } = await supabase.from("staff_topics").insert(rows);
    if (topicsErr) {
      Sentry.captureMessage("invite_accept_topics_insert_failed", {
        level: "warning",
        extra: { userId, error: topicsErr.message },
      });
    }
  }

  // Mark the invite accepted LAST — so if any earlier step failed we
  // don't burn the token. Concurrent-double-accept protection via the
  // WHERE clause: only mark accepted if it's still pending.
  const acceptResp = await supabase
    .from("business_invites")
    .update({
      accepted_at: new Date().toISOString(),
      accepted_user_id: userId,
    })
    .eq("token_hash", hash)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id");
  if (acceptResp.error || !acceptResp.data || acceptResp.data.length === 0) {
    // A concurrent request already accepted this invite. The auth
    // user + membership are in place; treat as success but log for
    // observability.
    Sentry.captureMessage("invite_accept_race_or_stale", {
      level: "warning",
      extra: { userId, err: acceptResp.error?.message },
    });
  }

  return { ok: true, user_id: userId, business_id: businessId, email: invite.email };
}

/**
 * Small helper — resolve the business_id for an invite by its
 * hash. Called inside handleAcceptInvite where we don't want to
 * trust anything client-supplied.
 */
async function hydrateBusinessIdForInvite(
  supabase: SupabaseClient,
  tokenHash: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("business_invites")
    .select("business_id")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  return (data as { business_id?: string } | null)?.business_id ?? null;
}

/**
 * Owner-only. Resend an outstanding invite. Semantics: mint a fresh
 * token (invalidating the old email link), keep everything else
 * (role, topics, callback), refresh expires_at. Same email fires.
 *
 * The old invite row is REVOKED rather than deleted so we retain
 * audit history. A new row is INSERTed with the new hash.
 */
export async function handleResendInvite(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
  inviteId: string,
): Promise<
  | { ok: true; invite_id: string; email: string; expires_at: string }
  | { ok: false; status: number; error: string }
> {
  const existing = await supabase
    .from("business_invites")
    .select("id, business_id, email, role, callback_ring_number, topics, invited_by_user_id, accepted_at, revoked_at")
    .eq("id", inviteId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (existing.error) return { ok: false, status: 500, error: "Database error" };
  if (!existing.data) return { ok: false, status: 404, error: "Invite not found" };
  const row = existing.data as {
    id: string;
    business_id: string;
    email: string;
    role: string;
    callback_ring_number: string | null;
    topics: string[] | null;
    invited_by_user_id: string | null;
    accepted_at: string | null;
    revoked_at: string | null;
  };
  if (row.accepted_at) {
    return { ok: false, status: 409, error: "This invite has already been accepted" };
  }

  // Revoke the old row.
  await supabase
    .from("business_invites")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", row.id);

  // Insert a new row with a fresh token.
  const { raw, hash } = issueInviteToken();
  const expiresAt = inviteExpiryFromNow();
  const insertResp = await supabase
    .from("business_invites")
    .insert({
      business_id: row.business_id,
      email: row.email,
      role: row.role,
      callback_ring_number: row.callback_ring_number,
      topics: row.topics ?? [],
      invited_by_user_id: callerUserId,
      token_hash: hash,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insertResp.error) {
    Sentry.captureMessage("invite_resend_insert_failed", {
      level: "error",
      extra: { businessId, email: row.email, error: insertResp.error.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }
  const newId = (insertResp.data as { id: string }).id;

  const inviter = await lookupInviterMeta(supabase, callerUserId, businessId);
  try {
    await sendTeamInviteEmail({
      to: row.email,
      inviteToken: raw,
      businessName: inviter.businessName,
      inviterName: inviter.name,
      role: row.role,
      fullName: null,
      expiresAt,
    });
  } catch (err: any) {
    Sentry.captureException(err, { extra: { where: "resendTeamInviteEmail", inviteId: newId } });
  }

  return { ok: true, invite_id: newId, email: row.email, expires_at: expiresAt };
}

/**
 * Owner-only. Mark the invite revoked. Idempotent — revoking twice
 * returns success. Never deletes the row (history matters).
 */
export async function handleRevokeInvite(
  supabase: SupabaseClient,
  businessId: string,
  inviteId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("business_invites")
    .update({ revoked_at: now })
    .eq("id", inviteId)
    .eq("business_id", businessId)
    .is("accepted_at", null)
    .select("id");
  if (error) return { ok: false, status: 500, error: "Database error" };
  if (!data || data.length === 0) {
    return { ok: false, status: 404, error: "Invite not found or already accepted" };
  }
  return { ok: true };
}

export async function handlePatchMember(
  supabase: SupabaseClient,
  businessId: string,
  targetUserId: string,
  callerRole: EnterpriseRole | undefined,
  body: ParsedPatchBody,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  // Confirm target belongs to this tenant.
  const ownerCheck = await supabase
    .from("user_businesses")
    .select("user_id, role")
    .eq("user_id", targetUserId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (ownerCheck.error) return { ok: false, status: 500, error: "Database error" };
  if (!ownerCheck.data) return { ok: false, status: 404, error: "Member not found" };

  // Role change → privilege check.
  if (body.role && !canGrantEnterpriseRole(callerRole, body.role)) {
    return { ok: false, status: 403, error: `Your role does not permit granting "${body.role}"` };
  }

  // Topic validation.
  if (body.topics) {
    const slugsOrErr = await loadBusinessTopicSlugs(supabase, businessId);
    if ("error" in slugsOrErr) {
      return { ok: false, status: 500, error: "Database error" };
    }
    const unknown = body.topics.filter((s) => !slugsOrErr.has(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `Unknown topic slug(s) for this business: ${unknown.join(", ")}`,
      };
    }
  }

  // UPDATE user_businesses fields.
  const ubPatch: Record<string, unknown> = {};
  if (body.role !== undefined) ubPatch.role = body.role;
  if (body.callback_ring_number !== undefined) ubPatch.callback_ring_number = body.callback_ring_number;
  if (Object.keys(ubPatch).length > 0) {
    const { error } = await supabase
      .from("user_businesses")
      .update(ubPatch)
      .eq("user_id", targetUserId)
      .eq("business_id", businessId);
    if (error) {
      Sentry.captureMessage("team_patch_ub_failed", {
        level: "error",
        extra: { businessId, targetUserId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
  }

  // Bulk-replace staff_topics for this user.
  if (body.topics) {
    await supabase
      .from("staff_topics")
      .delete()
      .eq("user_id", targetUserId)
      .eq("business_id", businessId);
    if (body.topics.length > 0) {
      const rows = body.topics.map((slug) => ({
        user_id: targetUserId,
        business_id: businessId,
        topic_slug: slug,
      }));
      const { error } = await supabase.from("staff_topics").insert(rows);
      if (error) {
        Sentry.captureMessage("team_patch_topics_insert_failed", {
          level: "error",
          extra: { businessId, targetUserId, error: error.message },
        });
        return { ok: false, status: 500, error: "Database error" };
      }
    }
  }

  return { ok: true };
}

export async function handleDeleteMember(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (callerUserId === targetUserId) {
    return { ok: false, status: 403, error: "You cannot remove yourself from the business" };
  }
  const { data, error } = await supabase
    .from("user_businesses")
    .delete()
    .eq("user_id", targetUserId)
    .eq("business_id", businessId)
    .select("user_id")
    .maybeSingle();
  if (error) {
    Sentry.captureMessage("team_delete_failed", {
      level: "error",
      extra: { businessId, targetUserId, error: error.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }
  if (!data) return { ok: false, status: 404, error: "Member not found" };
  // staff_topics rows cascade via FK ON DELETE CASCADE (migration 037).
  return { ok: true };
}

export async function handleOnDuty(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
): Promise<
  | { ok: true; is_on_duty: true; on_duty_since: string }
  | { ok: false; status: number; error: string }
> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("user_businesses")
    .update({ is_on_duty: true, on_duty_since: now })
    .eq("user_id", callerUserId)
    .eq("business_id", businessId)
    .select("on_duty_since")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Database error" };
  if (!data) return { ok: false, status: 404, error: "Membership not found" };
  return { ok: true, is_on_duty: true, on_duty_since: (data as any).on_duty_since || now };
}

export async function handleOffDuty(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
): Promise<{ ok: true; is_on_duty: false } | { ok: false; status: number; error: string }> {
  const { data, error } = await supabase
    .from("user_businesses")
    .update({ is_on_duty: false, on_duty_since: null })
    .eq("user_id", callerUserId)
    .eq("business_id", businessId)
    .select("user_id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Database error" };
  if (!data) return { ok: false, status: 404, error: "Membership not found" };
  return { ok: true, is_on_duty: false };
}

export async function handleListOnDuty(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ ok: true; members: TeamMemberRow[] } | { ok: false; status: number; error: string }> {
  try {
    const ubResp = await supabase
      .from("user_businesses")
      .select(
        "user_id, role, is_on_duty, on_duty_since, callback_ring_number, created_at, in_app_calling_enabled, voice_device_last_seen_at",
      )
      .eq("business_id", businessId)
      .eq("is_on_duty", true);
    if (ubResp.error) return { ok: false, status: 500, error: "Database error" };
    const ubRows = (ubResp.data as UserBusinessRow[] | null) ?? [];
    const userIds = ubRows.map((r) => r.user_id);
    const [topicsResp, userMap] = await Promise.all([
      supabase.from("staff_topics").select("user_id, topic_slug").eq("business_id", businessId),
      hydrateUsers(supabase, userIds),
    ]);
    if (topicsResp.error) return { ok: false, status: 500, error: "Database error" };
    const topicsByUser = new Map<string, string[]>();
    for (const row of (topicsResp.data as StaffTopicRow[] | null) ?? []) {
      const arr = topicsByUser.get(row.user_id) ?? [];
      arr.push(row.topic_slug);
      topicsByUser.set(row.user_id, arr);
    }
    const nowMs = Date.now();
    const members: TeamMemberRow[] = ubRows.map((r) => {
      const u = userMap.get(r.user_id);
      const lastMs = r.voice_device_last_seen_at
        ? Date.parse(r.voice_device_last_seen_at)
        : NaN;
      const heartbeatFresh =
        !Number.isNaN(lastMs) && nowMs - lastMs <= DEVICE_FRESHNESS_SECS * 1000;
      return {
        user_id: r.user_id,
        email: u?.email ?? null,
        full_name: u?.full_name ?? null,
        role: r.role,
        is_on_duty: true,
        on_duty_since: r.on_duty_since,
        callback_ring_number: r.callback_ring_number,
        assigned_topics: (topicsByUser.get(r.user_id) ?? []).sort(),
        created_at: r.created_at,
        in_app_calling_enabled: r.in_app_calling_enabled === true,
        voice_device_last_seen_at: r.voice_device_last_seen_at,
        device_heartbeat_fresh: heartbeatFresh,
      };
    });
    return { ok: true, members };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

// ── Route registrations ─────────────────────────────────────────────
//
// Path ordering: specific paths BEFORE :userId so "invite", "me",
// "on-duty" aren't captured by the :userId param.

router.get(
  "/business/team",
  requireAuth,
  requirePermission("users", "read"),
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
    const result = await handleListTeam(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ members: result.members });
  },
);

router.post(
  "/business/team/invite",
  requireAuth,
  requirePermission("users", "write"),
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
    const callerUserId = req.userId;
    if (!callerUserId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = parseInviteBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handleInviteMember(supabase, businessId, callerUserId, req.userRole, parsed);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    // Phase 3.17 — new response shape. No user_id (auth user isn't
    // created until acceptance). invite_id is what the UI keys off
    // for resend/revoke buttons; resent_previous tells the UI
    // whether to show "invite re-sent" vs "invite sent."
    res.status(201).json({
      invite_id: result.invite_id,
      email: result.email,
      expires_at: result.expires_at,
      resent_previous: result.resent_previous,
    });
  },
);

router.post(
  "/business/team/me/on-duty",
  requireAuth,
  requirePermission("calls", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const callerUserId = req.userId;
    if (!businessId || !callerUserId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleOnDuty(supabase, businessId, callerUserId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ is_on_duty: true, on_duty_since: result.on_duty_since });
  },
);

router.post(
  "/business/team/me/off-duty",
  requireAuth,
  requirePermission("calls", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const callerUserId = req.userId;
    if (!businessId || !callerUserId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleOffDuty(supabase, businessId, callerUserId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ is_on_duty: false });
  },
);

router.get(
  "/business/team/on-duty",
  requireAuth,
  requirePermission("users", "read"),
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
    const result = await handleListOnDuty(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ members: result.members });
  },
);

router.patch(
  "/business/team/:userId",
  requireAuth,
  requirePermission("users", "write"),
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
    const targetUserId = String(req.params.userId);
    const parsed = parseMemberPatchBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handlePatchMember(supabase, businessId, targetUserId, req.userRole, parsed);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  },
);

router.delete(
  "/business/team/:userId",
  requireAuth,
  requirePermission("users", "delete"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const callerUserId = req.userId;
    if (!businessId || !callerUserId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const targetUserId = String(req.params.userId);
    const result = await handleDeleteMember(supabase, businessId, callerUserId, targetUserId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  },
);

// ─── Phase 3.17 — first-class invites ─────────────────────────────────

/**
 * Public — no auth. The invite token IS the credential. GET is
 * side-effect free: hitting it a hundred times (as a scanner will)
 * does not accept, mark-as-read, or otherwise mutate DB state.
 * That's the entire point of Phase 3.17. See handleGetInviteByToken.
 *
 * Whitelisted in AUTH_BYPASS_PATTERNS in app.ts.
 */
router.get(
  "/invites/lookup/:token",
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const rawToken = String(req.params.token || "");
    const result = await handleGetInviteByToken(supabase, rawToken);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ state: result.state, invite: result.invite ?? null });
  },
);

/**
 * Public — no auth. Body: { token, password, full_name? }.
 * Creates the Supabase auth user + user_businesses row and marks
 * the invite accepted. THIS is the mutation. Scanners cannot
 * trigger it because they don't POST.
 *
 * Whitelisted in AUTH_BYPASS_PATTERNS in app.ts.
 */
router.post(
  "/invites/accept",
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const rawToken = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    const fullName =
      typeof body.full_name === "string" && body.full_name.trim()
        ? body.full_name.trim()
        : null;

    const result = await handleAcceptInvite(supabase, {
      rawToken,
      password,
      fullName,
    });
    if (!result.ok) {
      res.status(result.status).json({
        error: result.error,
        // Include state so the SPA can render a specific message
        // (expired / revoked / already_accepted) rather than a
        // generic "invite failed."
        state: result.state ?? null,
      });
      return;
    }
    res.status(201).json({
      user_id: result.user_id,
      business_id: result.business_id,
      email: result.email,
    });
  },
);

/**
 * Owner-only. Lists outstanding invites for the current business.
 */
router.get(
  "/business/invites",
  requireAuth,
  requirePermission("users", "read"),
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
    const result = await handleListPendingInvites(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ invites: result.invites });
  },
);

/**
 * Owner-only. Resend an outstanding invite (mints a new token, sends
 * a fresh email, revokes the previous row).
 */
router.post(
  "/business/invites/:id/resend",
  requireAuth,
  requirePermission("users", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    const callerUserId = req.userId;
    if (!businessId || !callerUserId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const inviteId = String(req.params.id || "");
    const result = await handleResendInvite(supabase, businessId, callerUserId, inviteId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      invite_id: result.invite_id,
      email: result.email,
      expires_at: result.expires_at,
    });
  },
);

/**
 * Owner-only. Revoke an outstanding invite. Idempotent — sets
 * revoked_at but never deletes the row (audit history).
 */
router.delete(
  "/business/invites/:id",
  requireAuth,
  requirePermission("users", "write"),
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
    const inviteId = String(req.params.id || "");
    const result = await handleRevokeInvite(supabase, businessId, inviteId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  },
);

export default router;
