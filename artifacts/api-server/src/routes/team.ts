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
}

interface UserBusinessRow {
  user_id: string;
  role: string;
  is_on_duty: boolean | null;
  on_duty_since: string | null;
  callback_ring_number: string | null;
  created_at: string | null;
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
      .select("user_id, role, is_on_duty, on_duty_since, callback_ring_number, created_at")
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

    const members: TeamMemberRow[] = ubRows.map((r) => {
      const u = userMap.get(r.user_id);
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
      };
    });
    return { ok: true, members };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleInviteMember(
  supabase: SupabaseClient,
  businessId: string,
  callerUserId: string,
  callerRole: EnterpriseRole | undefined,
  body: ParsedInviteBody,
): Promise<
  | { ok: true; user_id: string; email: string; invited: boolean }
  | { ok: false; status: number; error: string }
> {
  // Privilege check.
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

  // Invite via Supabase Auth admin. Same pattern as enterprise.ts:
  // if the user already exists, inviteUserByEmail returns an error; fall
  // back to listUsers to locate them.
  const admin = (supabase.auth as any).admin;
  let userId: string | undefined;
  let invited = false;

  try {
    const inviteRes = await admin.inviteUserByEmail(body.email, {
      data: { full_name: body.full_name, businessId, role: body.role },
    });
    userId = inviteRes?.data?.user?.id;
    if (userId) {
      invited = true;
    }
    if (!userId) {
      const inviteErr = inviteRes?.error;
      if (inviteErr && !/already.*registered|already exists/i.test(inviteErr.message || "")) {
        Sentry.captureMessage("team_invite_failed", {
          level: "error",
          extra: { businessId, email: body.email, error: inviteErr.message },
        });
        return { ok: false, status: 500, error: inviteErr.message || "Invite failed" };
      }
      // Already exists → find them.
      const { data } = await admin.listUsers({ page: 1, perPage: 200 });
      const found = data?.users?.find(
        (u: any) => u.email?.toLowerCase() === body.email,
      );
      if (!found) {
        return { ok: false, status: 500, error: "User exists but could not be located" };
      }
      userId = found.id;
    }
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Invite failed" };
  }

  if (!userId) return { ok: false, status: 500, error: "Could not resolve user id" };

  // Upsert membership.
  const { error: upsertErr } = await supabase
    .from("user_businesses")
    .upsert(
      {
        user_id: userId,
        business_id: businessId,
        role: body.role,
        callback_ring_number: body.callback_ring_number,
      },
      { onConflict: "user_id,business_id" },
    );
  if (upsertErr) {
    Sentry.captureMessage("team_invite_ub_upsert_failed", {
      level: "error",
      extra: { businessId, userId, error: upsertErr.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }

  // Insert initial topics. Ignore duplicates via ON CONFLICT-safe pattern:
  // DELETE existing rows for this user+business first, then INSERT the new set.
  if (body.initial_topics.length > 0) {
    await supabase
      .from("staff_topics")
      .delete()
      .eq("user_id", userId)
      .eq("business_id", businessId);
    const rows = body.initial_topics.map((slug) => ({
      user_id: userId,
      business_id: businessId,
      topic_slug: slug,
    }));
    const { error: topicsErr } = await supabase.from("staff_topics").insert(rows);
    if (topicsErr) {
      Sentry.captureMessage("team_invite_topics_insert_failed", {
        level: "error",
        extra: { businessId, userId, error: topicsErr.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
  }

  return { ok: true, user_id: userId, email: body.email, invited };
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
      .select("user_id, role, is_on_duty, on_duty_since, callback_ring_number, created_at")
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
    const members: TeamMemberRow[] = ubRows.map((r) => {
      const u = userMap.get(r.user_id);
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
    res.status(201).json({ user_id: result.user_id, email: result.email, invited: result.invited });
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

export default router;
