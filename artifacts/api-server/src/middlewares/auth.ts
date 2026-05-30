import { createClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";
import ipaddr from "ipaddr.js";
import { auditLog, extractRequestMeta } from "./audit.js";

// Per-tenant roles for users INSIDE a customer's organization. Distinct from
// `StaffRole` in staff-rbac.ts which gates Neverr's own back-office. Three
// roles added on top of the original 5 to give customers more granular team
// structures (a team_lead supervising agent_managers and analysts).
export type EnterpriseRole =
  | "owner"
  | "admin"
  | "manager"
  | "team_lead"
  | "agent_manager"
  | "analyst"
  | "user"
  | "readonly";

// `api_keys` was added so per-org API key issuance/revocation can be gated by
// permission rather than role-string-matching at the route layer.
export type PermissionResource =
  | "calls"
  | "analytics"
  | "settings"
  | "billing"
  | "users"
  | "integrations"
  | "api_keys";
export type PermissionAction = "read" | "write" | "delete" | "admin";

// Public list of every role that may be granted to a customer team member via
// the team-management endpoints. `owner` is intentionally excluded — the owner
// is established at signup and is not assignable through the invite flow.
export const ASSIGNABLE_ENTERPRISE_ROLES: readonly EnterpriseRole[] = [
  "admin",
  "manager",
  "team_lead",
  "agent_manager",
  "analyst",
  "user",
  "readonly",
];

export interface Permission {
  resource: PermissionResource;
  actions: PermissionAction[];
  businessId: string;
}

export interface EnterpriseUser {
  id: string;
  email: string;
  businessId: string;
  role: EnterpriseRole;
  permissions: Permission[];
  mfaEnabled: boolean;
  lastLogin: string;
  ipWhitelist?: string[];
}

export interface BusinessConfig {
  tier: "starter" | "essential" | "growth" | "professional" | "business" | "enterprise";
  // Phase 3: hydrated from business_configs columns added in migration 012.
  // enterpriseIPFilter reads ipWhitelist (still camelCase to match the
  // pre-existing convention). All fields use sensible defaults so middleware
  // never has to undefined-check before reading.
  enterpriseConfig?: Record<string, unknown>;
  brandingConfig?: Record<string, unknown> | null;
  securityPolicy?: Record<string, unknown> | null;
  ipWhitelist?: string[];
  mfaRequired?: boolean;
  slaLevel?: string;
  isolationModel?: string;
  ssoConfig?: Record<string, unknown> | null;
  parentBusinessId?: string | null;
}

// Loaded by `requireAuth` for the current authenticated user. Each entry is
// one row from `user_businesses` and represents tenant access. Phase 3e: a
// single user can belong to multiple tenants, so this is now an array even
// though pre-Phase-3e users typically have exactly one.
export interface MembershipRecord {
  business_id: string;
  role: string;
  created_at?: string;
}

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
      // ACTIVE business in scope for this request. Selected by the
      // `x-active-business` header when present and the caller is a member;
      // otherwise the oldest membership (matches pre-Phase-3e behavior).
      businessId?: string;
      // Phase 3e: every business_id the caller is a member of. Used by
      // /api/user/businesses to render a switcher and by audit checks that
      // need to know all tenants the caller can see.
      businessIds?: string[];
      // Phase 3e: full membership rows so callers can read role per tenant
      // without a second DB roundtrip (e.g. canAccessBusiness helper).
      memberships?: MembershipRecord[];
      isAdmin?: boolean;
      userRole?: EnterpriseRole;
      userPermissions?: Permission[];
      businessConfig?: BusinessConfig;
      sessionId?: string;
    }
  }
}

const ROLE_PERMISSIONS: Record<EnterpriseRole, Array<{ resource: PermissionResource; actions: PermissionAction[] }>> = {
  owner: [
    { resource: "calls", actions: ["read", "write", "delete", "admin"] },
    { resource: "analytics", actions: ["read", "write", "delete", "admin"] },
    { resource: "settings", actions: ["read", "write", "delete", "admin"] },
    { resource: "billing", actions: ["read", "write", "delete", "admin"] },
    { resource: "users", actions: ["read", "write", "delete", "admin"] },
    { resource: "integrations", actions: ["read", "write", "delete", "admin"] },
    { resource: "api_keys", actions: ["read", "write", "delete", "admin"] },
  ],
  admin: [
    { resource: "calls", actions: ["read", "write", "delete"] },
    { resource: "analytics", actions: ["read", "write"] },
    { resource: "settings", actions: ["read", "write"] },
    { resource: "billing", actions: ["read"] },
    { resource: "users", actions: ["read", "write"] },
    { resource: "integrations", actions: ["read", "write"] },
    { resource: "api_keys", actions: ["read"] },
  ],
  manager: [
    { resource: "calls", actions: ["read", "write"] },
    { resource: "analytics", actions: ["read", "write"] },
    { resource: "settings", actions: ["read"] },
    { resource: "users", actions: ["read", "write"] },
    { resource: "integrations", actions: ["read"] },
  ],
  // `team_lead`: leads multiple agent_managers / analysts. Can read across
  // the org and invite (users:write), but cannot delete calls or change
  // billing / integrations.
  team_lead: [
    { resource: "calls", actions: ["read", "write"] },
    { resource: "analytics", actions: ["read"] },
    { resource: "settings", actions: ["read"] },
    { resource: "users", actions: ["read", "write"] },
  ],
  // `agent_manager`: hands-on with call workflows but no team-management or
  // analytics-export rights.
  agent_manager: [
    { resource: "calls", actions: ["read", "write"] },
    { resource: "analytics", actions: ["read"] },
    { resource: "settings", actions: ["read"] },
  ],
  // `analyst`: read-only on calls, but full read/write on analytics so they
  // can build saved reports / dashboards.
  analyst: [
    { resource: "calls", actions: ["read"] },
    { resource: "analytics", actions: ["read", "write"] },
    { resource: "settings", actions: ["read"] },
  ],
  user: [
    { resource: "calls", actions: ["read", "write"] },
    { resource: "analytics", actions: ["read"] },
    { resource: "settings", actions: ["read"] },
  ],
  readonly: [
    { resource: "calls", actions: ["read"] },
    { resource: "analytics", actions: ["read"] },
    { resource: "settings", actions: ["read"] },
  ],
};

export function permissionsForRole(role: EnterpriseRole, businessId: string): Permission[] {
  return ROLE_PERMISSIONS[role].map((p) => ({ ...p, businessId }));
}

// Tenant role hierarchy used for grantability checks. Higher rank = more
// privileged. A caller may only grant roles strictly lower than their own
// (strict inequality also prevents lateral abuse — e.g. a manager cannot
// promote a peer to manager). `owner` is at the top and intentionally not
// assignable through any team-management endpoint.
const ENTERPRISE_ROLE_RANK: Record<EnterpriseRole, number> = {
  owner: 100,
  admin: 80,
  manager: 60,
  team_lead: 40,
  agent_manager: 40,
  analyst: 30,
  user: 20,
  readonly: 10,
};

/**
 * Returns true iff `callerRole` may grant `targetRole` to another tenant
 * member. Closes the privilege-escalation gap where any role with
 * `users:write` (e.g. `manager`, `team_lead`) could otherwise mint an
 * `admin`. `owner` is never grantable through this path.
 */
export function canGrantEnterpriseRole(
  callerRole: EnterpriseRole | undefined,
  targetRole: EnterpriseRole,
): boolean {
  if (!callerRole) return false;
  if (targetRole === "owner") return false;
  return ENTERPRISE_ROLE_RANK[callerRole] > ENTERPRISE_ROLE_RANK[targetRole];
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase env vars not set");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    req.userId = user.id;
    req.userEmail = user.email;

    // Phase 3e: load ALL memberships (was: .limit(1).single()). This lets the
    // request know every tenant the caller can access AND lets the caller
    // pick which one is active via the `x-active-business` header. Falling
    // back to the oldest membership preserves pre-Phase-3e single-tenant
    // behavior for clients that never send the header.
    const { data: memberships, error: memErr } = await supabase
      .from("user_businesses")
      .select("business_id, role, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true });

    if (memErr) {
      console.warn("[Auth] Membership load failed:", memErr.message);
      req.memberships = [];
      req.businessIds = [];
    } else {
      const allMemberships = (memberships || []) as MembershipRecord[];
      req.memberships = allMemberships;
      req.businessIds = allMemberships.map((m) => m.business_id);

      // Header-based active business selection. Only honor the header when
      // the caller actually has a membership for the requested tenant —
      // otherwise an attacker could trivially read another tenant's data
      // by setting the header.
      const activeBizHeader = req.headers["x-active-business"];
      const requestedBizId = Array.isArray(activeBizHeader)
        ? activeBizHeader[0]
        : activeBizHeader;

      let activeMembership: MembershipRecord | undefined;
      if (
        typeof requestedBizId === "string" &&
        requestedBizId &&
        req.businessIds.includes(requestedBizId)
      ) {
        activeMembership = allMemberships.find(
          (m) => m.business_id === requestedBizId,
        );
      }
      if (!activeMembership) {
        // Fallback to oldest membership (preserves pre-Phase-3e behavior).
        activeMembership = allMemberships[0];
      }

      if (activeMembership) {
        req.businessId = activeMembership.business_id;
        req.isAdmin =
          activeMembership.role === "owner" ||
          activeMembership.role === "admin";
        const role = (activeMembership.role as EnterpriseRole) || "user";
        req.userRole = role;
        req.userPermissions = permissionsForRole(role, activeMembership.business_id);

        try {
          // Phase 3k: read tier from business_configs.plan_id (the only table
          // that actually exists in production). Values match BusinessConfig.tier
          // enum exactly. Fallback to "essential" matches the webhook's
          // checkout.session.completed default for trial users.
          //
          // Phase 3 (Sprint 5): also hydrate the 9 enterprise columns added
          // by migration 012 so enterpriseIPFilter and other downstream
          // middleware can read them without a second roundtrip. ADD-ONLY —
          // no existing field is removed or renamed.
          const { data: biz } = await supabase
            .from("business_configs")
            .select(
              "plan_id, enterprise_config, branding_config, security_policy, ip_whitelist, mfa_required, sla_level, isolation_model, sso_config, parent_business_id",
            )
            .eq("business_id", activeMembership.business_id)
            .maybeSingle();
          if (biz) {
            const row = biz as any;
            req.businessConfig = {
              tier: (row.plan_id || "essential") as BusinessConfig["tier"],
              enterpriseConfig: row.enterprise_config || {},
              brandingConfig: row.branding_config || null,
              securityPolicy: row.security_policy || null,
              ipWhitelist: row.ip_whitelist || [],
              mfaRequired: row.mfa_required || false,
              slaLevel: row.sla_level || "standard",
              isolationModel: row.isolation_model || "shared",
              ssoConfig: row.sso_config || null,
              parentBusinessId: row.parent_business_id || null,
            };
          }
        } catch (e: any) {
          // Log but don't crash — tier gating fails closed (req.businessConfig undefined)
          console.warn("[Auth] tier-gate read failed:", e?.message || e);
        }
      }
    }
    req.sessionId = (req.headers["x-session-id"] as string) || token.slice(-16);
    next();
  } catch (err: any) {
    console.error("[Auth] Error:", err.message);
    res.status(500).json({ error: "Auth check failed" });
  }
}

export function resolveBusinessId(req: Request, _explicitId?: string): string {
  return req.businessId || "";
}

export function resolveBusinessIdPublic(req: Request, explicitId?: string): string {
  return explicitId || req.businessId || "";
}

/**
 * Express middleware that ensures the current user holds the specified
 * permission for the given resource. Returns 403 with an audit log entry
 * if the permission is not present.
 */
export function requirePermission(resource: PermissionResource, action: PermissionAction) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userPermissions = req.userPermissions || [];
    const hasPermission = userPermissions.some(
      (p) =>
        p.resource === resource &&
        p.actions.includes(action) &&
        (!req.businessId || p.businessId === req.businessId),
    );

    if (!hasPermission) {
      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: `permission.denied.${resource}.${action}`,
        resource,
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { role: req.userRole, sessionId: req.sessionId },
      });
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

/**
 * Returns true iff `clientIP` is matched by allowlist `entry`.
 *
 *  - Entries containing "/" are parsed as CIDR (IPv4 or IPv6).
 *  - Entries without "/" are treated as exact IP matches, but normalized via
 *    ipaddr.js so cosmetic differences (e.g. ::ffff:9.9.9.9 vs 9.9.9.9, or
 *    leading zeros in IPv6) compare equal.
 *  - An IPv4-mapped IPv6 client address (::ffff:1.2.3.4) is matched against
 *    an IPv4 entry by extracting the embedded v4 address — this matters
 *    because Node sockets often present v4 clients in mapped form.
 *  - Cross-family entries (v4 entry + v6 client of a different real address)
 *    return false.
 *  - All errors are swallowed and surface as `false`. Caller is responsible
 *    for warning-level logging if a malformed entry should be diagnosed.
 *
 * Designed to be called once per allowlist entry per request — no caching,
 * keep it cheap and deterministic.
 */
function ipMatchesEntry(clientIP: string, entry: string): boolean {
  if (!clientIP || !entry) return false;

  // ----- CIDR path -----
  if (entry.includes("/")) {
    try {
      const slashIdx = entry.indexOf("/");
      const rangeStr = entry.slice(0, slashIdx);
      const prefixStr = entry.slice(slashIdx + 1);
      const prefix = Number.parseInt(prefixStr, 10);
      if (!rangeStr || !prefixStr || Number.isNaN(prefix) || prefix < 0) {
        return false;
      }
      const range = ipaddr.parse(rangeStr);
      let client = ipaddr.parse(clientIP);

      // Unwrap IPv4-mapped IPv6 client when the range is IPv4 so that
      // ::ffff:1.2.3.4 matches 1.2.3.0/24.
      if (
        range.kind() === "ipv4" &&
        client.kind() === "ipv6" &&
        (client as ipaddr.IPv6).isIPv4MappedAddress()
      ) {
        client = (client as ipaddr.IPv6).toIPv4Address();
      }

      if (range.kind() !== client.kind()) return false;

      const max = range.kind() === "ipv4" ? 32 : 128;
      if (prefix > max) return false;

      return client.match(range, prefix);
    } catch {
      return false;
    }
  }

  // ----- Exact-IP path (preserves S5 behavior with normalization) -----
  try {
    let a = ipaddr.parse(clientIP);
    const b = ipaddr.parse(entry);

    if (
      a.kind() === "ipv6" &&
      b.kind() === "ipv4" &&
      (a as ipaddr.IPv6).isIPv4MappedAddress()
    ) {
      a = (a as ipaddr.IPv6).toIPv4Address();
    }

    if (a.kind() !== b.kind()) return false;
    return a.toNormalizedString() === b.toNormalizedString();
  } catch {
    // If either side fails to parse, fall back to literal string equality
    // so the middleware still does *something* sensible for legacy data.
    return clientIP === entry;
  }
}

/**
 * Restricts access to enterprise-tier businesses based on a configured
 * IP whitelist. Non-enterprise tiers and businesses without a whitelist
 * pass through unchanged.
 *
 * Whitelist entries may be either exact IPs (IPv4 or IPv6) or CIDR ranges
 * (e.g. "10.0.0.0/8"). Mixed lists like ["10.0.0.0/8", "192.168.1.5"] are
 * supported. Malformed entries are skipped with a console warning rather
 * than 500-ing the request or denying the IP outright.
 */
export function enterpriseIPFilter(req: Request, res: Response, next: NextFunction): void {
  const businessConfig = req.businessConfig;
  if (!businessConfig || businessConfig.tier !== "enterprise") {
    next();
    return;
  }
  const whitelist = businessConfig.ipWhitelist;
  if (!whitelist || whitelist.length === 0) {
    next();
    return;
  }

  const forwarded = req.headers["x-forwarded-for"];
  const forwardedFirst = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded || "").split(",")[0]?.trim();
  const clientIP = forwardedFirst || req.ip || req.socket?.remoteAddress || "";

  let allowed = false;
  if (clientIP) {
    for (const rawEntry of whitelist) {
      if (typeof rawEntry !== "string") continue;
      const entry = rawEntry.trim();
      if (!entry) continue;
      const matched = ipMatchesEntry(clientIP, entry);
      if (matched) {
        allowed = true;
        break;
      }
      // Diagnostic-only: re-detect malformed entries so ops can see why an
      // entry never matches anything. Cheap because we only do it on miss.
      if (entry.includes("/")) {
        const [r, p] = entry.split("/");
        const prefix = Number.parseInt(p ?? "", 10);
        if (!r || Number.isNaN(prefix)) {
          console.warn(
            `[enterpriseIPFilter] malformed CIDR entry '${rawEntry}' for biz=${req.businessId} — skipping`,
          );
        } else {
          try {
            ipaddr.parse(r);
          } catch {
            console.warn(
              `[enterpriseIPFilter] malformed CIDR entry '${rawEntry}' for biz=${req.businessId} — skipping`,
            );
          }
        }
      }
    }
  }

  if (!allowed) {
    const meta = extractRequestMeta(req);
    void auditLog({
      userId: req.userId,
      businessId: req.businessId,
      action: "access.denied.ip",
      resource: "settings",
      success: false,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { blockedIP: clientIP, sessionId: req.sessionId },
    });
    res.status(403).json({ error: "Access denied from this IP" });
    return;
  }
  next();
}
