/**
 * Staff / back-office RBAC for the /api/admin/* surface.
 *
 * This module is INTENTIONALLY SEPARATE from the per-tenant RBAC in `auth.ts`.
 *
 *   auth.ts         → who can access a *customer's* own dashboard
 *                     (roles: owner|admin|manager|user|readonly,
 *                      resources: calls|analytics|settings|billing|users|integrations)
 *
 *   staff-rbac.ts   → who at Neverr (back-office staff) can use the admin
 *                     console and what they can do there
 *                     (roles: super_admin|admin|manager|analyst|support|viewer,
 *                      resources: customers|analytics|support|users|automation|monitoring|billing)
 *
 * The two never share a permission map — we keep them apart on purpose so a
 * tenant admin can never accidentally inherit back-office privileges.
 */

import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";

/**
 * Cryptographically-strong opaque token. Replaces the previous
 * `Math.random().toString(36)` minting which was predictable and unsuitable
 * for invite tokens / synthetic user IDs.
 */
export function secureToken(prefix: string, bytes = 18): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export type StaffRole =
  | "super_admin"
  | "admin"
  | "manager"
  | "analyst"
  | "support"
  | "viewer";

export type StaffResource =
  | "customers"
  | "analytics"
  | "support"
  | "users"
  | "automation"
  | "monitoring"
  | "billing";

export type StaffAction = "read" | "write" | "delete" | "admin";

export type StaffPermissionMap = Partial<Record<StaffResource, StaffAction[]>>;

export const VALID_STAFF_ROLES: readonly StaffRole[] = [
  "super_admin",
  "admin",
  "manager",
  "analyst",
  "support",
  "viewer",
] as const;

export const VALID_STAFF_STATUSES = ["active", "inactive", "suspended"] as const;
export type StaffStatus = (typeof VALID_STAFF_STATUSES)[number];

const DEFAULT_PERMISSIONS: Record<StaffRole, StaffPermissionMap> = {
  super_admin: {
    customers:  ["read", "write", "delete", "admin"],
    analytics:  ["read", "write", "admin"],
    support:    ["read", "write", "admin"],
    users:      ["read", "write", "delete", "admin"],
    automation: ["read", "write", "admin"],
    monitoring: ["read", "write", "admin"],
    billing:    ["read", "write", "admin"],
  },
  admin: {
    customers:  ["read", "write", "delete"],
    analytics:  ["read", "write"],
    support:    ["read", "write"],
    users:      ["read", "write"],
    automation: ["read", "write"],
    monitoring: ["read", "write"],
    billing:    ["read"],
  },
  manager: {
    customers:  ["read", "write"],
    analytics:  ["read", "write"],
    support:    ["read", "write"],
    users:      ["read"],
    automation: ["read"],
    monitoring: ["read"],
    billing:    ["read"],
  },
  analyst: {
    customers:  ["read"],
    analytics:  ["read", "write"],
    support:    ["read"],
    monitoring: ["read"],
  },
  support: {
    customers:  ["read", "write"],
    support:    ["read", "write"],
    monitoring: ["read"],
  },
  viewer: {
    customers:  ["read"],
    analytics:  ["read"],
    support:    ["read"],
    monitoring: ["read"],
  },
};

export function getDefaultStaffPermissions(role: StaffRole | string): StaffPermissionMap {
  if ((VALID_STAFF_ROLES as readonly string[]).includes(role)) {
    return DEFAULT_PERMISSIONS[role as StaffRole];
  }
  return DEFAULT_PERMISSIONS.viewer;
}

/**
 * Privilege model: only super_admin may grant or modify super_admin. This
 * stops a regular `admin` from creating themselves an unconstrained peer.
 *
 * Bootstrap: if no super_admin exists in user_roles yet (`bootstrapAvailable`),
 * a tenant-owner with no staff row is allowed to grant super_admin so the
 * very first staff record can be seeded. Once any super_admin exists the
 * bootstrap path is closed permanently (callers checked via lookupStaffRole).
 */
export function canGrantRole(
  callerStaffRole: StaffRole | null,
  callerTenantRole: string | undefined,
  targetRole: StaffRole,
  bootstrapAvailable: boolean,
): boolean {
  if (targetRole === "super_admin") {
    if (callerStaffRole === "super_admin") return true;
    if (bootstrapAvailable && !callerStaffRole && callerTenantRole === "owner") return true;
    return false;
  }
  return true;
}

/**
 * Returns true iff at least one active super_admin exists in user_roles.
 * Used to lock down the bootstrap exception once staff RBAC is seeded.
 */
export async function superAdminExists(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { count } = await supabase
    .from("user_roles")
    .select("id", { count: "exact", head: true })
    .eq("role", "super_admin")
    .eq("status", "active");
  return (count ?? 0) > 0;
}

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

declare global {
  namespace Express {
    interface Request {
      staffRole?: StaffRole;
      staffPermissions?: StaffPermissionMap;
    }
  }
}

/**
 * Express middleware that requires the current authenticated user to hold a
 * specific staff permission. NAME-DISTINCT from the per-tenant
 * `requirePermission` exported from auth.ts so the two systems can never be
 * accidentally swapped at a route.
 *
 * Lookup keys, in order:
 *   1. user_roles.user_id == req.userId   (linked Supabase auth UUID)
 *   2. LOWER(user_roles.email) == LOWER(req.userEmail)
 *      — fallback for invited users whose `user_id` was minted by /users/invite
 *        before the Supabase auth account was linked. On a hit, the row is
 *        back-filled with the real auth UUID so subsequent lookups go via (1).
 */
export function requireStaffPermission(resource: StaffResource, action: StaffAction = "read") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    try {
      let { data: row } = await supabase
        .from("user_roles")
        .select("user_id, role, permissions, status, email")
        .eq("user_id", req.userId)
        .maybeSingle();

      if (!row && req.userEmail) {
        const { data: byEmail } = await supabase
          .from("user_roles")
          .select("id, user_id, role, permissions, status, email")
          .ilike("email", req.userEmail)
          .maybeSingle();
        if (byEmail) {
          row = byEmail;
          // Back-fill the linkage so next request hits the user_id index.
          if (byEmail.user_id !== req.userId) {
            await supabase
              .from("user_roles")
              .update({ user_id: req.userId, last_login: new Date().toISOString() })
              .eq("id", (byEmail as any).id);
          }
        }
      }

      if (!row) {
        res.status(403).json({ error: "User role not found" });
        return;
      }
      if (row.status !== "active") {
        res.status(403).json({ error: "User account is not active" });
        return;
      }

      const role = row.role as StaffRole;
      const stored = (row.permissions || {}) as StaffPermissionMap & {
        _invite?: unknown;
      };
      // Default permissions for the role, overlaid with any per-user grants.
      // Anything stored under `_invite` is metadata, not a resource grant.
      const merged: StaffPermissionMap = { ...getDefaultStaffPermissions(role) };
      for (const [k, v] of Object.entries(stored)) {
        if (k === "_invite") continue;
        if (Array.isArray(v)) (merged as any)[k] = v;
      }

      const allowed = (merged[resource] || []).includes(action);
      if (!allowed) {
        res.status(403).json({
          error: `Insufficient permissions for ${action} on ${resource}`,
          required: `${resource}:${action}`,
          userRole: role,
        });
        return;
      }

      req.staffRole = role;
      req.staffPermissions = merged;
      next();
    } catch (err: any) {
      console.error("[StaffRBAC] Permission check error:", err.message);
      res.status(500).json({ error: "Permission check failed" });
    }
  };
}

/**
 * Best-effort lookup of the caller's current staff role for endpoints that
 * need to make policy decisions (e.g. role-grant guards) but are gated by
 * `requireStaffOrBootstrap` rather than `requireStaffPermission`.
 * Returns null if the caller has no active staff record.
 */
export async function lookupStaffRole(
  userId: string | undefined,
  userEmail: string | undefined,
): Promise<StaffRole | null> {
  const supabase = getSupabase();
  if (!supabase || !userId) return null;
  const { data: byId } = await supabase
    .from("user_roles")
    .select("role, status")
    .eq("user_id", userId)
    .maybeSingle();
  if (byId && byId.status === "active") return byId.role as StaffRole;
  if (userEmail) {
    const { data: byEmail } = await supabase
      .from("user_roles")
      .select("role, status")
      .ilike("email", userEmail)
      .maybeSingle();
    if (byEmail && byEmail.status === "active") return byEmail.role as StaffRole;
  }
  return null;
}

/**
 * Gate for the `/api/admin/users/*` management endpoints themselves.
 *
 *   PRE-BOOTSTRAP (no super_admin exists yet):
 *     - Only authenticated tenant-`owner`s pass. This is the seat-the-first-
 *       staff-super_admin window. Any tenant `admin` (not owner) is rejected,
 *       and any non-tenant user is rejected.
 *
 *   POST-BOOTSTRAP (≥1 active super_admin exists):
 *     - Only callers with an active `user_roles` row whose `role` allows
 *       managing users pass. By default, that is `super_admin` and `admin`
 *       (admin gets read+write on `users` per DEFAULT_PERMISSIONS).
 *
 * This closes the previous Critical: per-tenant `requireAdminRole` allowed
 * any paying customer who owned their own business to mint themselves as
 * platform staff. Tenant-owner is now only honored as a one-shot bootstrap
 * before the first staff super_admin is seated; after that, only staff
 * with `users.write` may invite/modify staff.
 */
export function requireStaffOrBootstrap(action: "read" | "write" = "read") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const callerStaffRole = await lookupStaffRole(req.userId, req.userEmail);
    const bootstrapOpen = !(await superAdminExists());

    if (callerStaffRole) {
      const perms = getDefaultStaffPermissions(callerStaffRole);
      const allowed = (perms.users || []).includes(action);
      if (!allowed) {
        res.status(403).json({
          error: `Staff role '${callerStaffRole}' may not ${action} on users`,
        });
        return;
      }
      req.staffRole = callerStaffRole;
      req.staffPermissions = perms;
      next();
      return;
    }

    // No staff row → bootstrap path only. Requires no super_admin to exist
    // AND caller to be a tenant `owner`. Tenant `admin`s do NOT qualify.
    if (bootstrapOpen && req.userRole === "owner") {
      next();
      return;
    }

    res.status(403).json({
      error: bootstrapOpen
        ? "Staff bootstrap requires a tenant owner; contact a platform admin"
        : "Staff role required",
    });
  };
}
