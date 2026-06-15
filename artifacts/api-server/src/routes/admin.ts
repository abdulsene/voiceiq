/**
 * Admin (super-user) dashboard endpoints. Scoped to platform operators
 * who have role=owner or role=admin on at least one business — gated by
 * `req.isAdmin` already populated by `requireAuth`.
 *
 * Note: This is intentionally separate from the per-tenant `enterprise`
 * routes. Admin endpoints aggregate across all tenants and must never
 * leak data outside an admin's reach.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  requireAuth,
  requirePermission,
  permissionsForRole,
  ASSIGNABLE_ENTERPRISE_ROLES,
  canGrantEnterpriseRole,
  type EnterpriseRole,
} from "../middlewares/auth.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";
import {
  VALID_STAFF_ROLES,
  VALID_STAFF_STATUSES,
  getDefaultStaffPermissions,
  canGrantRole,
  lookupStaffRole,
  superAdminExists,
  requireStaffOrBootstrap,
  requireStaffPermission,
  secureToken,
  type StaffRole,
  type StaffStatus,
} from "../middlewares/staff-rbac.js";
import getStripe, { getCurrentPeriodEnd, mapStripeStatus } from "../stripe.js";
import { getUncachableSendGridClient } from "../integrations/sendgrid.js";
import { renderFirstMessage } from "../lib/first-message-renderer.js";
import { sendInvitationEmail } from "../services/invitation-email-service.js";
import { timingSafeEqual } from "node:crypto";
import { fetchIndustryTemplate, buildSystemPrompt } from "./api.js";
import { createAgentForBusiness, deleteAgent } from "../agents.js";
import { scrapeWebsite } from "../scraping.js";

const router: IRouter = Router();

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

// Security hotfix: the previous `requireAdminRole(req)` helper only
// checked `req.isAdmin`, which is set in auth.ts when the caller is the
// owner/admin of any business they belong to — a per-tenant role, NOT a
// staff role. Every admin endpoint now uses `requireStaffPermission`
// from staff-rbac.ts, which reads the user_roles table and verifies
// the caller holds the specific (resource, action) pair. Strict-string
// match — no implicit hierarchy (admin does NOT imply write/read).

// MRR pricing — sourced from the same plan IDs Stripe uses.
const PLAN_PRICING: Record<string, number> = {
  essential: 149,
  starter: 349,
  professional: 749,
  growth: 999,
  business: 1499,
  enterprise: 3499,
};

function priceFor(planId?: string | null): number {
  if (!planId) return 0;
  return PLAN_PRICING[planId.toLowerCase()] ?? 0;
}

// ---------------------------------------------------------------------------
// GET /api/admin/customers
// ---------------------------------------------------------------------------
router.get(
  "/customers",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(503).json({ error: "Database unavailable" });
      }

      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.min(
        500,
        Math.max(1, parseInt(String(req.query.limit ?? "50"), 10) || 50),
      );
      const offset = (page - 1) * limit;
      const status = req.query.status ? String(req.query.status) : null;
      const tier = req.query.tier ? String(req.query.tier) : null;
      const search = req.query.search ? String(req.query.search).trim() : null;

      let query = (supabase as any)
        .from("business_configs")
        .select(
          "business_id, business_name, plan_id, subscription_status, stripe_customer_id, stripe_subscription_id, customer_intelligence, created_at, updated_at",
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (status && status !== "all") query = query.eq("subscription_status", status);
      if (tier && tier !== "all") query = query.eq("plan_id", tier);
      if (search) query = query.ilike("business_name", `%${search}%`);

      const { data: customers, error, count } = await query;
      if (error) throw new Error(error.message);

      // Enrich with primary contact (owner) email from business_users.
      const businessIds = (customers || []).map((c: any) => c.business_id);
      const ownerByBiz: Record<string, { email: string; full_name: string | null }> = {};
      if (businessIds.length > 0) {
        const { data: owners } = await (supabase as any)
          .from("business_users")
          .select("business_id, email, full_name, role")
          .in("business_id", businessIds)
          .in("role", ["owner", "admin"]);
        for (const row of owners || []) {
          if (!ownerByBiz[row.business_id]) {
            ownerByBiz[row.business_id] = {
              email: row.email,
              full_name: row.full_name,
            };
          }
        }

        // Fallback: scan auth.users metadata for any business still missing an
        // owner email. Single paged scan, capped at 1000 users.
        const missing = businessIds.filter((bid: string) => !ownerByBiz[bid]);
        if (missing.length > 0) {
          try {
            const { data: list } = await (supabase as any).auth.admin.listUsers({
              page: 1,
              perPage: 1000,
            });
            for (const u of list?.users || []) {
              const bid =
                u.user_metadata?.business_id || u.app_metadata?.business_id;
              if (bid && missing.includes(bid) && !ownerByBiz[bid]) {
                ownerByBiz[bid] = {
                  email: u.email ?? null,
                  full_name:
                    u.user_metadata?.full_name ||
                    u.user_metadata?.name ||
                    null,
                };
              }
            }
          } catch (e) {
            console.warn("[Admin] auth.listUsers fallback failed:", (e as Error).message);
          }
        }
      }

      const enriched = (customers || []).map((c: any) => {
        const owner = ownerByBiz[c.business_id];
        const planId = c.plan_id || "essential";
        return {
          id: c.business_id,
          businessName: c.business_name || "Unknown Business",
          email: owner?.email ?? null,
          fullName: owner?.full_name ?? null,
          plan: planId,
          status: c.subscription_status || "inactive",
          tier: c.subscription_tier || planId,
          mrr: c.subscription_status === "active" ? priceFor(planId) : 0,
          createdAt: c.created_at,
          lastUpdated: c.updated_at,
          stripeCustomerId: c.stripe_customer_id,
          subscriptionId: c.stripe_subscription_id,
          industry: c.customer_intelligence?.industry ?? null,
          city: c.customer_intelligence?.location?.city ?? null,
          state: c.customer_intelligence?.location?.state ?? null,
          businessSize: c.customer_intelligence?.business?.size ?? null,
          acquisitionSource: c.customer_intelligence?.acquisition?.source ?? null,
          salesPerson: c.customer_intelligence?.acquisition?.salesPerson ?? null,
          intelligence: c.customer_intelligence ?? null,
        };
      });

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.customers.listed",
        resource: "admin",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { page, limit, status, tier, search, returned: enriched.length },
      });

      res.json({
        customers: enriched,
        total: count ?? enriched.length,
        page,
        pages: Math.ceil((count ?? enriched.length) / limit),
      });
    } catch (err: any) {
      console.error("[Admin] customers error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/overview
// ---------------------------------------------------------------------------
router.get(
  "/analytics/overview",
  requireAuth,
  requireStaffPermission("analytics", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(503).json({ error: "Database unavailable" });
      }

      const { data: customers, error: cErr } = await (supabase as any)
        .from("business_configs")
        .select("plan_id, subscription_status, created_at");
      if (cErr) throw new Error(cErr.message);

      const totalCustomers = customers?.length ?? 0;
      const activeCustomers =
        customers?.filter((c: any) => c.subscription_status === "active").length ?? 0;
      const totalMRR =
        customers?.reduce((sum: number, c: any) => {
          return c.subscription_status === "active"
            ? sum + priceFor(c.plan_id)
            : sum;
        }, 0) ?? 0;

      const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
      const sixtyDaysAgo = Date.now() - 60 * 86_400_000;

      const newCustomers30d =
        customers?.filter(
          (c: any) => c.created_at && new Date(c.created_at).getTime() >= thirtyDaysAgo,
        ).length ?? 0;
      const newCustomersPrior30d =
        customers?.filter((c: any) => {
          if (!c.created_at) return false;
          const t = new Date(c.created_at).getTime();
          return t >= sixtyDaysAgo && t < thirtyDaysAgo;
        }).length ?? 0;

      const growthRate =
        newCustomersPrior30d === 0
          ? newCustomers30d > 0
            ? 100
            : 0
          : ((newCustomers30d - newCustomersPrior30d) / newCustomersPrior30d) * 100;

      // Real call metrics over last 30 days, all tenants.
      let callsProcessed = 0;
      let successRate = 0;
      try {
        const sinceIso = new Date(thirtyDaysAgo).toISOString();
        const { data: calls, error: callsErr } = await (supabase as any)
          .from("calls")
          .select("id, call_outcome", { count: "exact" })
          .gte("created_at", sinceIso)
          .limit(50_000);
        if (!callsErr && calls) {
          callsProcessed = calls.length;
          const success = calls.filter((c: any) =>
            ["resolved", "appointment_booked", "lead_captured", "answered"].includes(
              c.call_outcome,
            ),
          ).length;
          successRate = callsProcessed > 0 ? (success / callsProcessed) * 100 : 0;
        }
      } catch (e) {
        // Soft-fail on calls table issues — overview should still render.
        console.warn("[Admin] call metrics unavailable:", (e as Error).message);
      }

      const alerts: Array<{ type: string; message: string; timestamp: string }> = [];
      if (totalCustomers === 0) {
        alerts.push({
          type: "warning",
          message: "No customer records found",
          timestamp: new Date().toISOString(),
        });
      }
      if (activeCustomers > 0 && totalMRR === 0) {
        alerts.push({
          type: "warning",
          message: "Active customers found but MRR is $0 — check plan_id mappings",
          timestamp: new Date().toISOString(),
        });
      }

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.overview.viewed",
        resource: "admin",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { totalCustomers, activeCustomers, totalMRR },
      });

      res.json({
        metrics: {
          totalCustomers,
          activeCustomers,
          totalMRR,
          avgRevenuePerCustomer:
            activeCustomers > 0 ? Math.round((totalMRR / activeCustomers) * 100) / 100 : 0,
          callsProcessed,
          successRate: Math.round(successRate * 100) / 100,
        },
        growth: {
          newCustomers: newCustomers30d,
          previousPeriodNewCustomers: newCustomersPrior30d,
          growthRate: Math.round(growthRate * 100) / 100,
        },
        alerts,
      });
    } catch (err: any) {
      console.error("[Admin] overview error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/customers/:customerId
// ---------------------------------------------------------------------------
router.get(
  "/customers/:customerId",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });
      const { customerId } = req.params;

      const { data: customer, error } = await (supabase as any)
        .from("business_configs")
        .select("*")
        .eq("business_id", customerId)
        .single();
      if (error || !customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // Owner email lookup — try business_users first (cheap), fall back to
      // auth.admin.listUsers (paged scan, only when needed).
      let ownerEmail: string | null = null;
      let ownerName: string | null = null;
      try {
        const { data: bu } = await (supabase as any)
          .from("business_users")
          .select("email, full_name, role")
          .eq("business_id", customerId)
          .in("role", ["owner", "admin"])
          .limit(1);
        if (bu && bu.length > 0) {
          ownerEmail = bu[0].email;
          ownerName = bu[0].full_name;
        }
      } catch {
        /* table may not exist for older tenants */
      }
      if (!ownerEmail) {
        try {
          const { data: list } = await (supabase as any).auth.admin.listUsers({
            page: 1,
            perPage: 200,
          });
          const match = list?.users?.find(
            (u: any) => u.user_metadata?.business_id === customerId,
          );
          if (match) {
            ownerEmail = match.email ?? null;
            ownerName = match.user_metadata?.full_name ?? null;
          }
        } catch {
          /* auth.admin may not be reachable */
        }
      }

      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      let callStats = { total: 0, answered: 0, missed: 0, avgDuration: 0 };
      try {
        const { data: calls } = await (supabase as any)
          .from("calls")
          .select("id, call_outcome, duration_seconds")
          .eq("business_id", customerId)
          .gte("created_at", since)
          .limit(10_000);
        const rows = calls || [];
        const answered = rows.filter((c: any) =>
          ["answered", "resolved", "appointment_booked", "lead_captured"].includes(
            c.call_outcome,
          ),
        ).length;
        const missed = rows.filter((c: any) => c.call_outcome === "missed").length;
        const totalDur = rows.reduce(
          (s: number, c: any) => s + (c.duration_seconds || 0),
          0,
        );
        callStats = {
          total: rows.length,
          answered,
          missed,
          avgDuration: rows.length > 0 ? Math.round(totalDur / rows.length) : 0,
        };
      } catch (e) {
        console.warn("[Admin] call stats unavailable:", (e as Error).message);
      }

      const planId = customer.plan_id || "essential";
      const isActive = customer.subscription_status === "active";

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.customer.viewed",
        resource: "admin",
        resourceId: customerId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { customerName: customer.business_name },
      });

      res.json({
        customer: {
          id: customer.business_id,
          businessName: customer.business_name,
          email: ownerEmail,
          fullName: ownerName,
          plan: planId,
          status: customer.subscription_status,
          mrr: isActive ? priceFor(planId) : 0,
          createdAt: customer.created_at,
          updatedAt: customer.updated_at,
          stripeCustomerId: customer.stripe_customer_id,
          subscriptionId: customer.stripe_subscription_id,
        },
        calls: callStats,
        usage: {
          callsThisMonth: callStats.total,
          successRate:
            callStats.total > 0
              ? Math.round((callStats.answered / callStats.total) * 10_000) / 100
              : 0,
        },
      });
    } catch (err: any) {
      console.error("[Admin] customer detail error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/admin/customers/:customerId/plan
// ---------------------------------------------------------------------------
const VALID_PLANS = Object.keys(PLAN_PRICING);

router.put(
  "/customers/:customerId/plan",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const { newPlan, reason } = req.body || {};
      if (!newPlan || !reason) {
        return res
          .status(400)
          .json({ error: "newPlan and reason are required" });
      }
      if (!VALID_PLANS.includes(String(newPlan).toLowerCase())) {
        return res.status(400).json({
          error: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
        });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: customer, error: fetchErr } = await (supabase as any)
        .from("business_configs")
        .select("plan_id, stripe_subscription_id, business_name")
        .eq("business_id", customerId)
        .single();
      if (fetchErr || !customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const { error: updErr } = await (supabase as any)
        .from("business_configs")
        .update({ plan_id: newPlan, updated_at: new Date().toISOString() })
        .eq("business_id", customerId);
      if (updErr) throw new Error(updErr.message);

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: customerId,
        action: "admin.plan.changed",
        resource: "billing",
        resourceId: customerId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          oldPlan: customer.plan_id,
          newPlan,
          reason,
          adminUser: req.userEmail,
          customerName: customer.business_name,
          stripeSubscriptionId: customer.stripe_subscription_id,
        },
        complianceFlags: ["ADMIN-ACTION", "BILLING-CHANGE"],
        riskScore: 50,
      });

      res.json({
        success: true,
        customerId,
        oldPlan: customer.plan_id,
        newPlan,
        message: `Plan changed from ${customer.plan_id} to ${newPlan}`,
        warning: customer.stripe_subscription_id
          ? "Database updated only — Stripe subscription not modified. Use Stripe-aware billing flow for paying customers."
          : undefined,
      });
    } catch (err: any) {
      console.error("[Admin] plan update error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/admin/customers/:customerId/status
// ---------------------------------------------------------------------------
// Sprint 1 BUG-17 sub-step 3c-extended-3 (M5 fix): VALID_STATUSES now
// covers every value the webhook bundle (3c + 3c-extended + 3c-extended-2 +
// 3c-extended-3) can write into business_configs.subscription_status, plus
// the legacy admin-only "suspended" state. "trial" was the legacy
// placeholder; the canonical value is "trialing" (matches Stripe verbatim).
// "incomplete", "incomplete_expired", and "unpaid" pass through verbatim
// from mapStripeStatus when Stripe sends one of them.
const VALID_STATUSES = [
  "active",
  "suspended",
  "cancelled",
  "trialing",
  "past_due",
  "pending_payment",
  "paused",
  "incomplete",
  "incomplete_expired",
  "unpaid",
];

router.put(
  "/customers/:customerId/status",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const { status, reason } = req.body || {};
      if (!status || !reason) {
        return res.status(400).json({ error: "status and reason are required" });
      }
      if (!VALID_STATUSES.includes(status)) {
        return res
          .status(400)
          .json({ error: `Invalid status. Must be: ${VALID_STATUSES.join(", ")}` });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: customer, error: fetchErr } = await (supabase as any)
        .from("business_configs")
        .select("subscription_status, business_name")
        .eq("business_id", customerId)
        .single();
      if (fetchErr || !customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const { error: updErr } = await (supabase as any)
        .from("business_configs")
        .update({
          subscription_status: status,
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", customerId);
      if (updErr) throw new Error(updErr.message);

      const riskScore =
        status === "cancelled" ? 85 : status === "suspended" ? 75 : 25;

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: customerId,
        action: `admin.account.${status}`,
        resource: "account",
        resourceId: customerId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          oldStatus: customer.subscription_status,
          newStatus: status,
          reason,
          adminUser: req.userEmail,
          customerName: customer.business_name,
        },
        complianceFlags: ["ADMIN-ACTION", "ACCOUNT-CHANGE"],
        riskScore,
      });

      res.json({
        success: true,
        customerId,
        oldStatus: customer.subscription_status,
        newStatus: status,
        message: `Account ${
          status === "suspended"
            ? "suspended"
            : status === "active"
              ? "reactivated"
              : status === "cancelled"
                ? "cancelled"
                : "updated"
        }`,
      });
    } catch (err: any) {
      console.error("[Admin] status update error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/customers/:customerId/reset-usage
// ---------------------------------------------------------------------------
router.post(
  "/customers/:customerId/reset-usage",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const { reason } = req.body || {};
      if (!reason) {
        return res.status(400).json({ error: "reason is required" });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: customer, error: fetchErr } = await (supabase as any)
        .from("business_configs")
        .select("business_name")
        .eq("business_id", customerId)
        .single();
      if (fetchErr || !customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      // Try the full update; if usage columns aren't present yet, retry with
      // just `usage_reset_at`. This keeps the endpoint useful before the
      // usage-tracking migration ships, without silently doing nothing.
      const fullReset = {
        call_minutes_used: 0,
        sms_count_used: 0,
        usage_reset_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      let resetApplied = "full";
      let { error: updErr } = await (supabase as any)
        .from("business_configs")
        .update(fullReset)
        .eq("business_id", customerId);
      if (
        updErr &&
        (/column .* does not exist/i.test(updErr.message) ||
          /could not find the .* column/i.test(updErr.message))
      ) {
        resetApplied = "marker_only";
        const fallback = { updated_at: new Date().toISOString() };
        const retry = await (supabase as any)
          .from("business_configs")
          .update(fallback)
          .eq("business_id", customerId);
        updErr = retry.error;
      }
      if (updErr) throw new Error(updErr.message);

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: customerId,
        action: "admin.usage.reset",
        resource: "usage",
        resourceId: customerId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          reason,
          adminUser: req.userEmail,
          customerName: customer.business_name,
          resetApplied,
        },
        complianceFlags: ["ADMIN-ACTION", "USAGE-RESET"],
        riskScore: 40,
      });

      res.json({
        success: true,
        customerId,
        resetApplied,
        message:
          resetApplied === "full"
            ? "Usage limits reset successfully"
            : "Reset acknowledged — usage tracking columns not yet present in business_configs",
      });
    } catch (err: any) {
      console.error("[Admin] usage reset error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/customers/:customerId/intelligence
// PUT  the structured CRM/segmentation profile for a single customer.
// ---------------------------------------------------------------------------
const VALID_BUSINESS_SIZES = ["small", "medium", "large", "enterprise"];
const VALID_ACQ_SOURCES = [
  "organic", "paid_ads", "referral", "sales", "social",
  "content", "event", "partner", "outbound", "unknown",
];

function buildIntelligence(body: any, prior?: any) {
  const ts = new Date().toISOString();
  return {
    industry: body.industry ?? prior?.industry ?? null,
    location: {
      city: body.city ?? prior?.location?.city ?? null,
      state: body.state ?? prior?.location?.state ?? null,
      country: body.country ?? prior?.location?.country ?? "US",
    },
    business: {
      size: body.businessSize ?? prior?.business?.size ?? null,
      employeeCount:
        body.employeeCount !== undefined
          ? Number(body.employeeCount) || null
          : prior?.business?.employeeCount ?? null,
      revenue: body.revenue ?? prior?.business?.revenue ?? null,
    },
    acquisition: {
      source: body.acquisitionSource ?? prior?.acquisition?.source ?? "unknown",
      campaign: body.campaignId ?? prior?.acquisition?.campaign ?? null,
      salesPerson: body.salesPerson ?? prior?.acquisition?.salesPerson ?? null,
      referredBy: body.referralSource ?? prior?.acquisition?.referredBy ?? null,
      acquisitionDate: prior?.acquisition?.acquisitionDate ?? ts,
    },
    notes: body.notes ?? prior?.notes ?? null,
    lastUpdated: ts,
  };
}

router.post(
  "/customers/:customerId/intelligence",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const { customerId } = req.params;
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      // Validate enums (loose — accept null/undefined, reject garbage strings)
      if (
        req.body.businessSize &&
        !VALID_BUSINESS_SIZES.includes(req.body.businessSize)
      ) {
        return res.status(400).json({
          error: `Invalid businessSize. Must be one of: ${VALID_BUSINESS_SIZES.join(", ")}`,
        });
      }
      if (
        req.body.acquisitionSource &&
        !VALID_ACQ_SOURCES.includes(req.body.acquisitionSource)
      ) {
        return res.status(400).json({
          error: `Invalid acquisitionSource. Must be one of: ${VALID_ACQ_SOURCES.join(", ")}`,
        });
      }

      const { data: existing, error: fErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, customer_intelligence")
        .eq("business_id", customerId)
        .maybeSingle();
      if (fErr) throw new Error(fErr.message);
      if (!existing) return res.status(404).json({ error: "Customer not found" });

      const intelligence = buildIntelligence(req.body, existing.customer_intelligence);

      const { error: uErr } = await (supabase as any)
        .from("business_configs")
        .update({
          customer_intelligence: intelligence,
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", customerId);
      if (uErr) throw new Error(uErr.message);

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: customerId,
        action: "admin.customer.intelligence.updated",
        resource: "customers",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { adminUser: req.userEmail, intelligence },
        complianceFlags: ["ADMIN-ACTION", "CUSTOMER-DATA"],
        riskScore: 30,
      });

      res.json({ success: true, customerId, intelligence });
    } catch (err: any) {
      console.error("[Admin] intelligence update error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/analytics/segmentation
// Aggregates by industry / city / business-size / acquisition source.
// ---------------------------------------------------------------------------
router.get(
  "/analytics/segmentation",
  requireAuth,
  requireStaffPermission("analytics", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: customers, error } = await (supabase as any)
        .from("business_configs")
        .select(
          "business_id, business_name, plan_id, subscription_status, customer_intelligence, created_at",
        );
      if (error) throw new Error(error.message);

      type Bucket = {
        count: number;
        activeCount: number;
        activeMRR: number;
        potentialMRR: number;
        salesPeople?: Set<string>;
        state?: string | null;
      };
      const mk = (): Bucket => ({
        count: 0,
        activeCount: 0,
        activeMRR: 0,
        potentialMRR: 0,
      });

      const byIndustry: Record<string, Bucket> = {};
      const byLocation: Record<string, Bucket> = {};
      const bySize: Record<string, Bucket> = {};
      const byAcquisition: Record<string, Bucket> = {};

      let unenriched = 0;

      for (const c of customers || []) {
        const intel = c.customer_intelligence || {};
        if (!c.customer_intelligence) unenriched++;
        const isActive = c.subscription_status === "active";
        const planPrice = priceFor(c.plan_id);
        const mrr = isActive ? planPrice : 0;

        const industry = intel.industry || "unknown";
        (byIndustry[industry] ||= mk());
        byIndustry[industry].count++;
        byIndustry[industry].potentialMRR += planPrice;
        if (isActive) {
          byIndustry[industry].activeCount++;
          byIndustry[industry].activeMRR += mrr;
        }

        const city = intel.location?.city || "unknown";
        (byLocation[city] ||= mk());
        byLocation[city].count++;
        byLocation[city].state = intel.location?.state ?? null;
        if (isActive) {
          byLocation[city].activeCount++;
          byLocation[city].activeMRR += mrr;
        }

        const size = intel.business?.size || "unknown";
        (bySize[size] ||= mk());
        bySize[size].count++;
        if (isActive) {
          bySize[size].activeCount++;
          bySize[size].activeMRR += mrr;
        }

        const source = intel.acquisition?.source || "unknown";
        (byAcquisition[source] ||= { ...mk(), salesPeople: new Set() });
        byAcquisition[source].count++;
        if (isActive) {
          byAcquisition[source].activeCount++;
          byAcquisition[source].activeMRR += mrr;
        }
        if (intel.acquisition?.salesPerson) {
          byAcquisition[source].salesPeople!.add(intel.acquisition.salesPerson);
        }
      }

      // Set → array
      const acqOut: Record<string, any> = {};
      for (const [k, v] of Object.entries(byAcquisition)) {
        acqOut[k] = { ...v, salesPeople: Array.from(v.salesPeople || []) };
      }

      const rank = (m: Record<string, Bucket>) =>
        Object.entries(m)
          .sort(([, a], [, b]) => b.activeMRR - a.activeMRR)
          .slice(0, 10);

      res.json({
        totalCustomers: customers?.length ?? 0,
        enrichedCustomers: (customers?.length ?? 0) - unenriched,
        unenrichedCustomers: unenriched,
        segmentation: {
          byIndustry,
          byLocation,
          bySize,
          byAcquisition: acqOut,
        },
        insights: {
          topIndustries: rank(byIndustry).map(([industry, d]) => ({ industry, ...d })),
          topCities: rank(byLocation).map(([city, d]) => ({ city, ...d })),
          acquisitionPerformance: rank(byAcquisition).map(([source, d]) => ({
            source,
            ...d,
            salesPeople: Array.from(
              (byAcquisition[source].salesPeople as Set<string>) || [],
            ),
          })),
        },
      });
    } catch (err: any) {
      console.error("[Admin] segmentation error:", err);
      // Surface missing-column errors helpfully.
      if (
        /customer_intelligence/.test(err.message || "") &&
        /does not exist|could not find/i.test(err.message || "")
      ) {
        return res.status(503).json({
          error: "customer_intelligence column not present on business_configs",
          remedy: "ALTER TABLE business_configs ADD COLUMN customer_intelligence JSONB;",
        });
      }
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/customers/bulk-intelligence
// ---------------------------------------------------------------------------
router.post(
  "/customers/bulk-intelligence",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const list: any[] = Array.isArray(req.body?.customers) ? req.body.customers : [];
      if (list.length === 0) {
        return res.status(400).json({ error: "Body must include a non-empty 'customers' array" });
      }
      if (list.length > 500) {
        return res.status(400).json({ error: "Bulk import capped at 500 rows per call" });
      }

      const results: any[] = [];

      for (const row of list) {
        try {
          const { businessId, businessName } = row;
          let customer: any = null;
          if (businessId) {
            const { data } = await (supabase as any)
              .from("business_configs")
              .select("business_id, business_name, customer_intelligence")
              .eq("business_id", businessId)
              .maybeSingle();
            customer = data;
          } else if (businessName) {
            const { data } = await (supabase as any)
              .from("business_configs")
              .select("business_id, business_name, customer_intelligence")
              .ilike("business_name", `%${businessName}%`)
              .limit(2);
            if (data && data.length === 1) customer = data[0];
            else if (data && data.length > 1) {
              results.push({
                businessId,
                businessName,
                status: "ambiguous",
                error: `Matched ${data.length} businesses by name; specify businessId`,
              });
              continue;
            }
          }

          if (!customer) {
            results.push({
              businessId: businessId || "unknown",
              businessName: businessName || "unknown",
              status: "not_found",
            });
            continue;
          }

          if (
            row.businessSize &&
            !VALID_BUSINESS_SIZES.includes(row.businessSize)
          ) {
            results.push({ businessId: customer.business_id, status: "invalid", error: "businessSize" });
            continue;
          }
          if (
            row.acquisitionSource &&
            !VALID_ACQ_SOURCES.includes(row.acquisitionSource)
          ) {
            results.push({ businessId: customer.business_id, status: "invalid", error: "acquisitionSource" });
            continue;
          }

          const intelligence = buildIntelligence(row, customer.customer_intelligence);
          const { error: uErr } = await (supabase as any)
            .from("business_configs")
            .update({
              customer_intelligence: intelligence,
              updated_at: new Date().toISOString(),
            })
            .eq("business_id", customer.business_id);
          if (uErr) throw new Error(uErr.message);

          results.push({
            businessId: customer.business_id,
            businessName: customer.business_name,
            status: "success",
          });
        } catch (e: any) {
          results.push({
            businessId: row.businessId || "unknown",
            status: "error",
            error: e.message,
          });
        }
      }

      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.customers.bulk.intelligence.import",
        resource: "customers",
        success: (counts.success ?? 0) > 0,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          adminUser: req.userEmail,
          totalProcessed: results.length,
          counts,
        },
        complianceFlags: ["ADMIN-ACTION", "BULK-OPERATION", "CUSTOMER-DATA"],
        riskScore: 50,
      });

      res.json({ success: true, processed: results.length, counts, results });
    } catch (err: any) {
      console.error("[Admin] bulk intelligence error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/customers/:customerId/health
// ---------------------------------------------------------------------------
router.get(
  "/customers/:customerId/health",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { customerId } = req.params;

      const { data: customer, error: cErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, business_name, subscription_status, plan_id, created_at")
        .eq("business_id", customerId)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      if (!customer) return res.status(404).json({ error: "Customer not found" });

      const now = Date.now();
      const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      const sixtyDaysAgo = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

      const ANSWERED = new Set([
        "answered",
        "resolved",
        "appointment_booked",
        "booked",
        "completed",
      ]);

      let { data: calls, error: callsErr } = await (supabase as any)
        .from("calls")
        .select("call_outcome, status, duration_seconds, created_at, caller_satisfaction")
        .eq("business_id", customerId)
        .gte("created_at", thirtyDaysAgo);
      if (callsErr) {
        const { data: fallback } = await (supabase as any)
          .from("calls")
          .select("call_outcome, status, duration_seconds, created_at")
          .eq("business_id", customerId)
          .gte("created_at", thirtyDaysAgo);
        calls = fallback;
      }

      const { data: previousCalls } = await (supabase as any)
        .from("calls")
        .select("id")
        .eq("business_id", customerId)
        .gte("created_at", sixtyDaysAgo)
        .lt("created_at", thirtyDaysAgo);

      const recent: any[] = calls || [];
      const totalCalls = recent.length;
      const answeredCalls = recent.filter((c) =>
        ANSWERED.has(String(c.call_outcome || c.status || "").toLowerCase()),
      ).length;
      const callSuccessRate = totalCalls > 0 ? (answeredCalls / totalCalls) * 100 : 0;
      const totalMinutes =
        recent.reduce((sum, c) => sum + (Number(c.duration_seconds) || 0), 0) / 60;

      const previousTotal = (previousCalls || []).length;
      const usageTrend =
        previousTotal > 0
          ? ((totalCalls - previousTotal) / previousTotal) * 100
          : totalCalls > 0
            ? 100
            : 0;

      let avgSatisfaction: number | null = null;
      let satisfactionCount = 0;
      const satisfactionScores = recent
        .filter((c) => c.caller_satisfaction !== null && c.caller_satisfaction !== undefined)
        .map((c) => parseFloat(c.caller_satisfaction))
        .filter((s) => !isNaN(s) && s >= 1 && s <= 5);
      if (satisfactionScores.length > 0) {
        avgSatisfaction =
          satisfactionScores.reduce((sum, s) => sum + s, 0) / satisfactionScores.length;
        satisfactionCount = satisfactionScores.length;
      }

      const daysActive = customer.created_at
        ? Math.floor((now - new Date(customer.created_at).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      const subscriptionHealth = {
        status: customer.subscription_status,
        daysActive,
        planTier: customer.plan_id,
        isTrialExpiringSoon:
          customer.subscription_status === "trialing" && daysActive > 7,
        hasPaymentIssues: customer.subscription_status === "past_due",
      };

      const recommendations: string[] = [];
      const scoreBreakdown: Record<string, number> = { base: 50 };
      let healthScore = 50;

      // Call volume (-25 to +20)
      let volumeDelta = 0;
      if (totalCalls >= 100) volumeDelta = 20;
      else if (totalCalls >= 50) volumeDelta = 15;
      else if (totalCalls >= 20) volumeDelta = 10;
      else if (totalCalls >= 5) volumeDelta = 5;
      else if (totalCalls === 0) volumeDelta = -25;
      healthScore += volumeDelta;
      scoreBreakdown.volume = volumeDelta;

      // Success rate (-35 to +25) — dominant signal
      let successDelta = 0;
      if (totalCalls > 0) {
        if (callSuccessRate >= 95) successDelta = 25;
        else if (callSuccessRate >= 85) successDelta = 20;
        else if (callSuccessRate >= 75) successDelta = 15;
        else if (callSuccessRate >= 65) successDelta = 10;
        else if (callSuccessRate >= 50) successDelta = 5;
        else if (callSuccessRate >= 30) successDelta = -15;
        else if (callSuccessRate >= 10) successDelta = -25;
        else successDelta = -35;
      }
      healthScore += successDelta;
      scoreBreakdown.successRate = successDelta;

      // Usage trend (-15 to +15)
      let trendDelta = 0;
      if (usageTrend > 100) trendDelta = 15;
      else if (usageTrend > 50) trendDelta = 10;
      else if (usageTrend > 10) trendDelta = 5;
      else if (usageTrend < -50) trendDelta = -15;
      else if (usageTrend < -20) trendDelta = -10;
      healthScore += trendDelta;
      scoreBreakdown.trend = trendDelta;

      // Subscription (-25 to +10)
      let subDelta = 0;
      if (customer.subscription_status === "active") {
        const planBonuses: Record<string, number> = {
          essential: 5,
          starter: 6,
          professional: 8,
          growth: 9,
          business: 10,
          enterprise: 10,
        };
        subDelta = planBonuses[customer.plan_id] ?? 5;
      } else if (customer.subscription_status === "trialing") {
        if (daysActive > 14) subDelta = -10;
        else if (daysActive > 7) subDelta = -5;
      } else if (customer.subscription_status === "past_due") subDelta = -20;
      else if (customer.subscription_status === "cancelled") subDelta = -25;
      healthScore += subDelta;
      scoreBreakdown.subscription = subDelta;

      // Engagement recency (-10 to +5)
      let daysSinceLastCall: number | null = null;
      let engDelta = 0;
      if (recent.length > 0) {
        const lastCallTs = Math.max(...recent.map((c) => new Date(c.created_at).getTime()));
        daysSinceLastCall = (now - lastCallTs) / (24 * 60 * 60 * 1000);
        if (daysSinceLastCall <= 1) engDelta = 5;
        else if (daysSinceLastCall <= 3) engDelta = 2;
        else if (daysSinceLastCall > 14) engDelta = -10;
        else if (daysSinceLastCall > 7) engDelta = -5;
      }
      healthScore += engDelta;
      scoreBreakdown.engagement = engDelta;

      // Satisfaction (-20 to +15) — only when data exists
      let satDelta = 0;
      if (avgSatisfaction !== null) {
        if (avgSatisfaction >= 4.5) satDelta = 15;
        else if (avgSatisfaction >= 4.0) satDelta = 10;
        else if (avgSatisfaction >= 3.5) satDelta = 5;
        else if (avgSatisfaction >= 3.0) satDelta = -5;
        else if (avgSatisfaction >= 2.0) satDelta = -15;
        else satDelta = -20;

        if (avgSatisfaction < 3.0)
          recommendations.push("Poor customer satisfaction scores - investigate immediately");
        else if (avgSatisfaction < 4.0)
          recommendations.push("Customer satisfaction below target - review service quality");
      }
      healthScore += satDelta;
      scoreBreakdown.satisfaction = satDelta;

      const calculatedScore = Object.values(scoreBreakdown).reduce((a, b) => a + b, 0);
      healthScore = Math.max(0, Math.min(100, healthScore));

      let healthCategory: string;
      let riskLevel: string;

      if (healthScore >= 85) {
        healthCategory = "excellent";
        riskLevel = "low";
        recommendations.push("High-value customer - consider account expansion");
        if (totalCalls > 200) recommendations.push("Enterprise upgrade candidate");
        if (usageTrend > 50) recommendations.push("Usage growing rapidly - monitor capacity");
      } else if (healthScore >= 70) {
        healthCategory = "good";
        riskLevel = "low";
        if (totalCalls > 0 && callSuccessRate < 85)
          recommendations.push("Success rate could be improved");
        if (usageTrend < 0) recommendations.push("Monitor for usage decline");
      } else if (healthScore >= 50) {
        healthCategory = "fair";
        riskLevel = "medium";
        recommendations.push("Schedule customer success check-in");
        if (totalCalls > 0 && callSuccessRate < 70)
          recommendations.push("Technical review needed - call quality issues");
        if (customer.subscription_status === "trialing" && daysActive > 10)
          recommendations.push("Trial conversion at risk - sales intervention needed");
      } else if (healthScore >= 25) {
        healthCategory = "at_risk";
        riskLevel = "high";
        recommendations.push("Immediate customer success intervention required");
        if (totalCalls > 0 && callSuccessRate < 50)
          recommendations.push("URGENT: Major technical issues affecting customer");
        if (totalCalls === 0 && daysActive > 3)
          recommendations.push("Customer has not started using service");
      } else {
        healthCategory = "critical";
        riskLevel = "critical";
        recommendations.push("ESCALATE: Customer at immediate churn risk");
        if (totalCalls === 0) recommendations.push("Emergency onboarding support needed");
        if (customer.subscription_status === "past_due")
          recommendations.push("Payment failure + poor health = high churn risk");
      }

      res.json({
        customerId,
        businessName: customer.business_name,
        healthScore,
        calculatedScore,
        scoreBreakdown,
        healthCategory,
        riskLevel,
        metrics: {
          callVolume: { current: totalCalls, previous: previousTotal, trend: usageTrend },
          performance: {
            successRate: callSuccessRate,
            avgSatisfaction,
            satisfactionCount,
            totalMinutes,
          },
          subscription: subscriptionHealth,
          engagement: {
            daysSinceLastCall,
            callsPerWeek: totalCalls / 4.3,
            isActiveUser: totalCalls > 5 && callSuccessRate > 20,
          },
        },
        recommendations,
        lastCalculated: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Admin] customer health error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/customers/:customerId/tickets
// ---------------------------------------------------------------------------
const VALID_TICKET_PRIORITIES = ["low", "medium", "high", "urgent"];
const VALID_TICKET_CATEGORIES = [
  "technical",
  "billing",
  "general",
  "feature_request",
  "onboarding",
];

router.post(
  "/customers/:customerId/tickets",
  requireAuth,
  requireStaffPermission("support", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { customerId } = req.params;
      const { title, description, priority, category, assignedTo, tags } = req.body || {};

      if (!title || !description) {
        return res.status(400).json({ error: "title and description are required" });
      }
      const prio = priority || "medium";
      const cat = category || "general";
      if (!VALID_TICKET_PRIORITIES.includes(prio)) {
        return res.status(400).json({
          error: "Invalid priority",
          allowed: VALID_TICKET_PRIORITIES,
        });
      }
      if (!VALID_TICKET_CATEGORIES.includes(cat)) {
        return res.status(400).json({
          error: "Invalid category",
          allowed: VALID_TICKET_CATEGORIES,
        });
      }

      const { data: customer, error: cErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, business_name")
        .eq("business_id", customerId)
        .maybeSingle();
      if (cErr) throw new Error(cErr.message);
      if (!customer) return res.status(404).json({ error: "Customer not found" });

      const ticketRow = {
        id: `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        customer_id: customerId,
        title,
        description,
        priority: prio,
        category: cat,
        status: "open",
        assigned_to: assignedTo || null,
        created_by: req.userEmail || "system",
        customer_business_name: customer.business_name,
        tags: Array.isArray(tags) ? tags : [],
      };

      const { data: inserted, error: iErr } = await (supabase as any)
        .from("support_tickets")
        .insert(ticketRow)
        .select()
        .single();
      if (iErr) throw new Error(iErr.message);

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: customerId,
        action: "admin.support.ticket.created",
        resource: "support",
        resourceId: ticketRow.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          adminUser: req.userEmail,
          title,
          priority: prio,
          category: cat,
          assignedTo: assignedTo || null,
        },
        complianceFlags: ["ADMIN-ACTION", "SUPPORT-TICKET"],
        riskScore: 20,
      });

      res.json({ success: true, ticket: inserted });
    } catch (err: any) {
      console.error("[Admin] create ticket error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/support/dashboard
// ---------------------------------------------------------------------------
router.get(
  "/support/dashboard",
  requireAuth,
  requireStaffPermission("support", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: tickets, error } = await (supabase as any)
        .from("support_tickets")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);

      const list: any[] = tickets || [];
      const totalTickets = list.length;
      const openTickets = list.filter((t) =>
        ["open", "in_progress"].includes(t.status),
      ).length;
      const urgentTickets = list.filter((t) => t.priority === "urgent").length;
      const resolvedTickets = list.filter((t) =>
        ["resolved", "closed"].includes(t.status),
      ).length;

      const byCategory: Record<string, { count: number; open: number }> = {};
      const byAssignee: Record<string, { count: number; open: number }> = {};
      const byStatus: Record<string, { count: number }> = {};

      list.forEach((t) => {
        const isOpen = ["open", "in_progress"].includes(t.status);

        const catKey = t.category || "general";
        if (!byCategory[catKey]) byCategory[catKey] = { count: 0, open: 0 };
        byCategory[catKey].count++;
        if (isOpen) byCategory[catKey].open++;

        const assignee = t.assigned_to || "unassigned";
        if (!byAssignee[assignee]) byAssignee[assignee] = { count: 0, open: 0 };
        byAssignee[assignee].count++;
        if (isOpen) byAssignee[assignee].open++;

        const statusKey = t.status || "unknown";
        if (!byStatus[statusKey]) byStatus[statusKey] = { count: 0 };
        byStatus[statusKey].count++;
      });

      res.json({
        summary: {
          totalTickets,
          openTickets,
          urgentTickets,
          resolvedTickets,
          resolutionRate:
            totalTickets > 0 ? (resolvedTickets / totalTickets) * 100 : 0,
        },
        breakdown: { byCategory, byAssignee, byStatus },
        recentTickets: list.slice(0, 20),
      });
    } catch (err: any) {
      console.error("[Admin] support dashboard error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/migrate-jsonb-tickets — copy any tickets still living in
// business_configs.customer_intelligence.support_tickets into the dedicated
// support_tickets table, then strip them from the JSONB blob. Idempotent.
// ---------------------------------------------------------------------------
router.post(
  "/migrate-jsonb-tickets",
  requireAuth,
  requireStaffPermission("support", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const { data: customers, error: lErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, business_name, customer_intelligence")
        .not("customer_intelligence", "is", null);
      if (lErr) throw new Error(lErr.message);

      const migratedTickets: any[] = [];
      const failures: any[] = [];
      let customersTouched = 0;

      for (const customer of customers || []) {
        const intel = customer.customer_intelligence || {};
        const tickets = Array.isArray(intel.support_tickets) ? intel.support_tickets : [];
        if (tickets.length === 0) continue;

        for (const t of tickets) {
          const row = {
            id: t.id,
            customer_id: customer.business_id,
            title: t.title,
            description: t.description,
            priority: t.priority || "medium",
            category: t.category || "general",
            status: t.status || "open",
            assigned_to: t.assignedTo ?? t.assigned_to ?? null,
            created_by: t.createdBy ?? t.created_by ?? "migration",
            created_at: t.createdAt ?? t.created_at ?? new Date().toISOString(),
            updated_at: t.updatedAt ?? t.updated_at ?? new Date().toISOString(),
            resolved_at: t.resolvedAt ?? t.resolved_at ?? null,
            resolution: t.resolution ?? null,
            customer_business_name: customer.business_name,
            tags: Array.isArray(t.tags) ? t.tags : [],
          };

          const { data, error } = await (supabase as any)
            .from("support_tickets")
            .upsert(row, { onConflict: "id" })
            .select()
            .single();

          if (error) failures.push({ id: t.id, error: error.message });
          else migratedTickets.push(data);
        }

        const updatedIntel = { ...intel };
        delete updatedIntel.support_tickets;
        delete updatedIntel.support_summary;

        await (supabase as any)
          .from("business_configs")
          .update({
            customer_intelligence: updatedIntel,
            updated_at: new Date().toISOString(),
          })
          .eq("business_id", customer.business_id);
        customersTouched++;
      }

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.support.tickets.migrate_jsonb",
        resource: "support",
        success: failures.length === 0,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          adminUser: req.userEmail,
          customersTouched,
          migrated: migratedTickets.length,
          failed: failures.length,
        },
        complianceFlags: ["ADMIN-ACTION", "MIGRATION", "SUPPORT-TICKET"],
        riskScore: 30,
      });

      res.json({
        success: failures.length === 0,
        customersTouched,
        migrated: migratedTickets.length,
        failed: failures.length,
        failures,
        tickets: migratedTickets,
      });
    } catch (err: any) {
      console.error("[Admin] migrate-jsonb-tickets error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/create-tickets-table — probe whether the dedicated
// support_tickets table exists; if not, return the SQL to create it.
// ---------------------------------------------------------------------------
router.post(
  "/create-tickets-table",
  requireAuth,
  requireStaffPermission("support", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const probeId = `ticket_probe_${Date.now()}`;
      const probeRow = {
        id: probeId,
        customer_id: "demo-business",
        title: "schema probe",
        description: "schema probe",
        priority: "low",
        category: "technical",
        status: "closed",
        assigned_to: "system",
        created_by: req.userEmail || "system",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
        resolution: "probe",
        customer_business_name: "probe",
        tags: ["system"],
      };

      const { error } = await (supabase as any).from("support_tickets").insert(probeRow);

      if (error) {
        return res.json({
          tableExists: false,
          message:
            "Run the SQL below in the Supabase SQL Editor to create the support_tickets table.",
          sqlNeeded: `CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  category TEXT NOT NULL CHECK (category IN ('technical','billing','general','feature_request','onboarding')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  assigned_to TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  customer_business_name TEXT,
  tags TEXT[],
  FOREIGN KEY (customer_id) REFERENCES business_configs(business_id)
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer ON support_tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status   ON support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON support_tickets(priority);
CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned ON support_tickets(assigned_to);`,
          probeError: error.message,
        });
      }

      await (supabase as any).from("support_tickets").delete().eq("id", probeId);
      return res.json({
        tableExists: true,
        message: "support_tickets table exists and accepts inserts.",
      });
    } catch (err: any) {
      console.error("[Admin] create-tickets-table probe error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/backfill-users — link existing auth.users to business_configs
// rows in the new business_users join table. Best-effort matching; designed to
// be re-runnable thanks to the (user_id, business_id) UNIQUE constraint.
// ---------------------------------------------------------------------------
router.post(
  "/backfill-users",
  requireAuth,
  requireStaffPermission("users", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const dryRun = req.body?.dryRun === true;

      const { data: list, error: aErr } = await (supabase as any).auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (aErr) throw new Error(aErr.message);
      const authUsers = list?.users || [];

      const { data: businesses, error: bErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, business_name, created_at, stripe_customer_id");
      if (bErr) throw new Error(bErr.message);

      // Pre-load existing rows so we can report duplicates accurately.
      const { data: existing } = await (supabase as any)
        .from("business_users")
        .select("user_id, business_id");
      const existingPairs = new Set<string>(
        (existing || []).map((r: any) => `${r.user_id}::${r.business_id}`),
      );

      const usedBusinessIds = new Set<string>(
        (existing || []).map((r: any) => r.business_id),
      );
      const norm = (s: string | null | undefined) =>
        (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

      const results: any[] = [];

      for (const user of authUsers) {
        const userCreated = new Date(user.created_at).getTime();
        const emailLocal = user.email?.split("@")[0]?.toLowerCase() || "";
        let matched: any = null;
        let strategy = "";

        // Strategy 1: timestamp proximity (±5 min) — only if exactly one match
        const fiveMin = 5 * 60_000;
        const timeMatches = (businesses || []).filter((b: any) => {
          if (!b.created_at) return false;
          return Math.abs(new Date(b.created_at).getTime() - userCreated) < fiveMin;
        });
        if (timeMatches.length === 1) {
          matched = timeMatches[0];
          strategy = "time_proximity";
        }

        // Strategy 2: business_name matches email local-part
        if (!matched && emailLocal) {
          const cand = (businesses || []).find((b: any) => {
            const bname = norm(b.business_name);
            return (
              bname &&
              (bname.includes(norm(emailLocal)) ||
                norm(emailLocal).includes(bname))
            );
          });
          if (cand) {
            matched = cand;
            strategy = "name_email_heuristic";
          }
        }

        // Known aliases between auth-email vertical and business_id suffix.
        // Drives the demo strategy below.
        const DEMO_ALIASES: Record<string, string> = {
          supermarket: "grocery",
          personal_injury: "pi-law",
          city_municipal: "government",
          real_estate: "realestate",
          law_firm_general: "legal",
          medical_general: "medical",
          restaurant_general: "restaurant",
          mental_health_therapy: "therapy",
          dmv_office: "dmv",
          veterinary: "vet",
          hvac: "hvac",
          dental: "dental",
        };

        // Strategy 3: demo accounts → matching demo business by vertical.
        // emails look like "demo-<vertical>@voiceiq.ai"; map to business_id
        // "demo-<vertical>" exactly. Falls back to fuzzy-vertical match.
        if (!matched && user.email?.toLowerCase().startsWith("demo-")) {
          const vertical = emailLocal.replace(/^demo-/, "");
          const aliased = DEMO_ALIASES[vertical] || vertical;
          const candidates = [
            `demo-${aliased}`,
            `demo-${vertical}`,
            `demo-${vertical.replace(/_/g, "")}`,
            `demo-${vertical.replace(/_/g, "-")}`,
          ];
          const exact = (businesses || []).find((b: any) =>
            candidates.includes((b.business_id || "").toLowerCase()),
          );
          if (exact) {
            matched = exact;
            strategy = aliased !== vertical ? "demo_alias" : "demo_exact";
          } else {
            const fuzzy = (businesses || []).find((b: any) => {
              const bid = (b.business_id || "").toLowerCase();
              return (
                bid.startsWith("demo-") &&
                (bid.includes(vertical) || vertical.includes(bid.replace("demo-", "")))
              );
            });
            if (fuzzy) {
              matched = fuzzy;
              strategy = "demo_fuzzy";
            }
          }
        }

        // Strategy 4: stripe_customer_id email match (pull from Stripe)
        // Skipped to avoid live-mode/test-mode mismatches; safer to leave
        // unmatched users for human review.

        if (!matched) {
          results.push({
            userId: user.id,
            email: user.email,
            status: "no_match",
          });
          continue;
        }

        const pairKey = `${user.id}::${matched.business_id}`;
        if (existingPairs.has(pairKey)) {
          results.push({
            userId: user.id,
            email: user.email,
            businessId: matched.business_id,
            status: "already_linked",
          });
          continue;
        }

        if (dryRun) {
          results.push({
            userId: user.id,
            email: user.email,
            businessId: matched.business_id,
            businessName: matched.business_name,
            status: "would_insert",
            strategy,
          });
          continue;
        }

        const { error: insErr } = await (supabase as any)
          .from("business_users")
          .upsert(
            {
              user_id: user.id,
              business_id: matched.business_id,
              email: user.email,
              full_name:
                user.user_metadata?.full_name ||
                user.user_metadata?.name ||
                emailLocal ||
                null,
              role: "owner",
              created_at: user.created_at,
            },
            { onConflict: "user_id,business_id" },
          );

        if (insErr) {
          results.push({
            userId: user.id,
            email: user.email,
            businessId: matched.business_id,
            status: "error",
            error: insErr.message,
          });
        } else {
          existingPairs.add(pairKey);
          usedBusinessIds.add(matched.business_id);
          results.push({
            userId: user.id,
            email: user.email,
            businessId: matched.business_id,
            businessName: matched.business_name,
            status: "linked",
            strategy,
          });
        }
      }

      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] || 0) + 1;
        return acc;
      }, {});

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.users.backfilled",
        resource: "users",
        success: (counts.linked ?? 0) > 0 || dryRun,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          dryRun,
          adminUser: req.userEmail,
          totalProcessed: results.length,
          counts,
          firstResults: results.slice(0, 10),
        },
        complianceFlags: ["ADMIN-ACTION", "DATA-BACKFILL"],
        riskScore: 30,
      });

      res.json({
        success: true,
        dryRun,
        processed: results.length,
        counts,
        results,
      });
    } catch (err: any) {
      console.error("[Admin] backfill-users error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/fix-stripe-data — backfill subscription_status from Stripe
// for customers whose webhook updates were missed.
// ---------------------------------------------------------------------------
router.post(
  "/fix-stripe-data",
  requireAuth,
  requireStaffPermission("billing", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(503).json({ error: "Database unavailable" });

      const dryRun = req.body?.dryRun !== false; // default true for safety
      const stripe = getStripe();

      // Candidates: have a Stripe customer ID but no subscription ID, OR are
      // still flagged trial/inactive despite having a customer ID.
      const { data: candidates, error: cErr } = await (supabase as any)
        .from("business_configs")
        .select("business_id, business_name, stripe_customer_id, stripe_subscription_id, subscription_status, plan_id")
        .not("stripe_customer_id", "is", null);
      if (cErr) throw new Error(cErr.message);

      const fixes: any[] = [];
      const skipped: any[] = [];
      const errors: any[] = [];

      for (const c of candidates || []) {
        try {
          const subs = await stripe.subscriptions.list({
            customer: c.stripe_customer_id,
            status: "all",
            limit: 3,
          });
          // Prefer active/trialing/past_due over cancelled.
          const ranked = (subs.data || []).slice().sort((a: any, b: any) => {
            const score = (s: any) =>
              s.status === "active" ? 0 :
              s.status === "trialing" ? 1 :
              s.status === "past_due" ? 2 :
              s.status === "unpaid" ? 3 : 4;
            return score(a) - score(b);
          });
          const sub = ranked[0];
          if (!sub) {
            skipped.push({ businessId: c.business_id, reason: "no Stripe subscription" });
            continue;
          }

          // Sprint 1 BUG-17 sub-step 3c-extended-4 (admin backfill bypass
          // fix): route Stripe-reported status through mapStripeStatus so
          // 'canceled' (one L from Stripe) writes as 'cancelled' (two L's
          // — the canonical value used everywhere else in the codebase).
          // Without this, an admin running the backfill would silently
          // re-introduce the spelling drift X7 fixed in the live webhook
          // handler. Also surface unexpected Stripe statuses (anything
          // outside the canonical set) as a Sentry warn with the
          // admin-flow tag, mirroring the live webhook behavior.
          const mapped = mapStripeStatus(sub.status);
          const newStatus = mapped.status;
          if (mapped.isUnexpected) {
            try {
              Sentry.captureMessage("admin_backfill_unexpected_status", {
                level: "warning",
                extra: {
                  business_id: c.business_id,
                  stripe_status: sub.status,
                  stripe_subscription_id: sub.id,
                  stripe_customer_id: c.stripe_customer_id,
                  source: "POST /api/admin/fix-stripe-data",
                },
              });
            } catch {}
          }
          const newSubId = sub.id;
          const newPlanId = (sub.metadata as any)?.plan || c.plan_id;
          const newCycle = (sub.metadata as any)?.billing_cycle || "monthly";
          // Sprint 1 BUG-17 sub-step 3c-extended-2: read current_period_end
          // through the helper so we work under both pre-2025-10-29 (top-level)
          // and 2025-10-29.clover+ (items[0]) Stripe API versions.
          const cpeUnix = getCurrentPeriodEnd(sub);
          const cpe = cpeUnix != null ? new Date(cpeUnix * 1000).toISOString() : null;

          const drift =
            c.stripe_subscription_id !== newSubId ||
            c.subscription_status !== newStatus;

          if (!drift) {
            skipped.push({ businessId: c.business_id, reason: "already in sync", status: newStatus });
            continue;
          }

          if (!dryRun) {
            const update: Record<string, any> = {
              stripe_subscription_id: newSubId,
              subscription_status: newStatus,
              plan_id: newPlanId,
              billing_cycle: newCycle,
              updated_at: new Date().toISOString(),
            };
            if (cpe) update.current_period_end = cpe;

            const { error: uErr } = await (supabase as any)
              .from("business_configs")
              .update(update)
              .eq("business_id", c.business_id);
            if (uErr) {
              errors.push({ businessId: c.business_id, error: uErr.message });
              continue;
            }
          }

          fixes.push({
            businessId: c.business_id,
            businessName: c.business_name,
            from: { status: c.subscription_status, sub: c.stripe_subscription_id, plan: c.plan_id },
            to: { status: newStatus, sub: newSubId, plan: newPlanId },
          });
        } catch (e: any) {
          errors.push({ businessId: c.business_id, error: e.message });
        }
      }

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.stripe.data.backfill",
        resource: "billing",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          dryRun,
          adminUser: req.userEmail,
          processed: candidates?.length ?? 0,
          fixed: fixes.length,
          skipped: skipped.length,
          errors: errors.length,
          firstFixes: fixes.slice(0, 10),
        },
        complianceFlags: ["ADMIN-ACTION", "DATA-BACKFILL"],
        riskScore: 60,
      });

      res.json({
        success: true,
        dryRun,
        processed: candidates?.length ?? 0,
        fixed: fixes.length,
        skipped: skipped.length,
        errorCount: errors.length,
        fixes,
        errors: errors.slice(0, 20),
      });
    } catch (err: any) {
      console.error("[Admin] fix-stripe-data error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ============================================================================
// MONITORING & OBSERVABILITY
// ============================================================================

const SUCCESS_OUTCOMES = ["answered", "resolved", "appointment_booked", "completed", "booked", "success"];
const FAILURE_OUTCOMES = ["failed", "error", "timeout", "no_answer"];

const TIME_WINDOWS_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

function callIs(call: any, set: string[]): boolean {
  const status = String(call.status || "").toLowerCase();
  const outcome = String(call.call_outcome || "").toLowerCase();
  return set.includes(status) || set.includes(outcome);
}

async function computeSystemHealth(supabase: any, timeRange: string, businessId?: string) {
  const windowMs = TIME_WINDOWS_MS[timeRange] ?? TIME_WINDOWS_MS["1h"];
  const startTime = new Date(Date.now() - windowMs).toISOString();

  let query = supabase
    .from("calls")
    .select("status, call_outcome, created_at, duration_seconds, business_id")
    .gte("created_at", startTime);
  if (businessId) query = query.eq("business_id", businessId);
  const { data: calls, error } = await query;

  if (error) throw error;

  const list = calls || [];
  const totalCalls = list.length;
  const successfulCalls = list.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length;
  const failedCalls = list.filter((c: any) => callIs(c, FAILURE_OUTCOMES)).length;
  const missedCalls = list.filter((c: any) => callIs(c, ["missed"])).length;

  const successRate = totalCalls > 0 ? (successfulCalls / totalCalls) * 100 : 0;
  const failureRate = totalCalls > 0 ? (failedCalls / totalCalls) * 100 : 0;

  const avgDuration =
    totalCalls > 0
      ? list.reduce((sum: number, c: any) => sum + (Number(c.duration_seconds) || 0), 0) / totalCalls
      : 0;

  const hoursInWindow = windowMs / (60 * 60 * 1000);
  const callsPerHour = totalCalls / hoursInWindow;

  const affectedCustomers = new Set<string>();
  const customerMetrics: Record<string, { total: number; successful: number; failed: number }> = {};

  for (const call of list) {
    const cid = call.business_id;
    if (!cid) continue;
    if (!customerMetrics[cid]) customerMetrics[cid] = { total: 0, successful: 0, failed: 0 };
    customerMetrics[cid].total++;
    if (callIs(call, SUCCESS_OUTCOMES)) customerMetrics[cid].successful++;
    if (callIs(call, FAILURE_OUTCOMES)) {
      customerMetrics[cid].failed++;
      affectedCustomers.add(cid);
    }
  }

  const customerIssues = Object.entries(customerMetrics)
    .map(([customerId, m]) => ({
      customerId,
      total: m.total,
      successful: m.successful,
      failed: m.failed,
      failureRate: m.total > 0 ? (m.failed / m.total) * 100 : 0,
    }))
    .filter((c) => c.failureRate > 50 && c.total >= 3)
    .sort((a, b) => b.failureRate - a.failureRate);

  let systemStatus: "healthy" | "warning" | "degraded" | "critical" = "healthy";
  let alertLevel: "none" | "info" | "warning" | "critical" = "none";
  const alerts: any[] = [];
  const ts = new Date().toISOString();

  if (totalCalls === 0) {
    systemStatus = "healthy";
    alertLevel = "info";
  } else if (successRate < 50) {
    systemStatus = "critical";
    alertLevel = "critical";
    alerts.push({
      type: "system_failure",
      severity: "critical",
      message: `System success rate critically low: ${successRate.toFixed(1)}%`,
      affectedCustomers: affectedCustomers.size,
      timestamp: ts,
    });
  } else if (successRate < 70) {
    systemStatus = "degraded";
    alertLevel = "warning";
    alerts.push({
      type: "performance_degraded",
      severity: "warning",
      message: `System performance degraded: ${successRate.toFixed(1)}% success rate`,
      affectedCustomers: affectedCustomers.size,
      timestamp: ts,
    });
  } else if (successRate < 85) {
    systemStatus = "warning";
    alertLevel = "info";
  }

  if (customerIssues.length > 0) {
    alerts.push({
      type: "customer_impact",
      severity: "warning",
      message: `${customerIssues.length} customers experiencing high failure rates`,
      customers: customerIssues.slice(0, 5).map((c) => ({
        id: c.customerId,
        failureRate: Math.round(c.failureRate * 100) / 100,
        totalCalls: c.total,
      })),
      timestamp: ts,
    });
  }

  if (timeRange === "1h" && totalCalls < 5) {
    alerts.push({
      type: "low_volume",
      severity: "info",
      message: `Unusually low call volume: ${totalCalls} calls in last hour`,
      timestamp: ts,
    });
  }

  return {
    timeRange,
    systemStatus,
    alertLevel,
    metrics: {
      calls: {
        total: totalCalls,
        successful: successfulCalls,
        failed: failedCalls,
        missed: missedCalls,
        successRate: Math.round(successRate * 100) / 100,
        failureRate: Math.round(failureRate * 100) / 100,
        callsPerHour: Math.round(callsPerHour * 100) / 100,
      },
      performance: {
        avgDuration: Math.round(avgDuration * 100) / 100,
        totalCustomersActive: Object.keys(customerMetrics).length,
        customersWithIssues: customerIssues.length,
      },
    },
    alerts,
    customerImpact: {
      totalAffected: affectedCustomers.size,
      highFailureRateCustomers: customerIssues.slice(0, 10),
    },
    timestamp: ts,
  };
}

router.get("/monitoring/health", requireAuth, requirePermission("analytics", "read"), async (req: any, res: any) => {
  try {
    const timeRange = String(req.query.timeRange || "1h");
    if (!TIME_WINDOWS_MS[timeRange]) {
      return res.status(400).json({ error: `Invalid timeRange. Must be one of: ${Object.keys(TIME_WINDOWS_MS).join(", ")}` });
    }
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });
    const supabase = getSupabase();
    const result = await computeSystemHealth(supabase, timeRange, req.businessId);
    res.json(result);
  } catch (err: any) {
    console.error("[Monitoring] health error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/monitoring/customers/:customerId/impact", requireAuth, requirePermission("analytics", "read"), async (req: any, res: any) => {
  try {
    const { customerId } = req.params;
    // Tenant isolation: a tenant can only inspect its own business. Without
    // this gate, any authenticated user could enumerate sibling tenants by
    // guessing their business_id.
    if (customerId !== req.businessId) {
      return res.status(403).json({ error: "Access denied to customer data" });
    }
    const timeRange = String(req.query.timeRange || "24h");
    if (!TIME_WINDOWS_MS[timeRange]) {
      return res.status(400).json({ error: `Invalid timeRange. Must be one of: ${Object.keys(TIME_WINDOWS_MS).join(", ")}` });
    }
    const windowMs = TIME_WINDOWS_MS[timeRange];
    const startTime = new Date(Date.now() - windowMs).toISOString();
    const supabase = getSupabase();

    const [{ data: calls, error: callsErr }, { data: customer }] = await Promise.all([
      supabase
        .from("calls")
        .select("id, status, call_outcome, created_at, duration_seconds, business_id")
        .eq("business_id", customerId)
        .gte("created_at", startTime)
        .order("created_at", { ascending: false }),
      supabase
        .from("business_configs")
        .select("business_name, plan_id, subscription_status")
        .eq("business_id", customerId)
        .maybeSingle(),
    ]);

    if (callsErr) throw callsErr;

    const list = calls || [];
    const totalCalls = list.length;
    const successfulCalls = list.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length;
    const recentFailures = list.filter((c: any) => callIs(c, FAILURE_OUTCOMES)).slice(0, 10);

    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const recentCalls = list.filter((c: any) => c.created_at >= sixHoursAgo);
    const earlierCalls = list.filter((c: any) => c.created_at < sixHoursAgo);

    const recentSuccessRate =
      recentCalls.length > 0
        ? (recentCalls.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length / recentCalls.length) * 100
        : 0;
    const earlierSuccessRate =
      earlierCalls.length > 0
        ? (earlierCalls.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length / earlierCalls.length) * 100
        : 0;
    const successRateTrend = recentSuccessRate - earlierSuccessRate;

    let impactLevel: "none" | "medium" | "high" | "critical" = "none";
    let impactScore = 0;
    const issues: string[] = [];

    if (recentCalls.length > 0 && recentSuccessRate < 30) {
      impactLevel = "critical";
      impactScore = 90;
      issues.push("Critical: Success rate below 30% in last 6 hours");
    } else if (recentCalls.length > 0 && recentSuccessRate < 60) {
      impactLevel = "high";
      impactScore = 70;
      issues.push("High: Success rate below 60% in last 6 hours");
    } else if (earlierCalls.length > 0 && successRateTrend < -20) {
      impactLevel = impactLevel === "none" ? "medium" : impactLevel;
      impactScore = Math.max(impactScore, 50);
      issues.push("Medium: Success rate dropped by >20% recently");
    }

    if (recentFailures.length > 5) {
      issues.push(`${recentFailures.length} recent failures detected`);
      impactScore = Math.max(impactScore, 60);
      if (impactLevel === "none") impactLevel = "medium";
    }

    if (recentCalls.length === 0 && totalCalls > 0) {
      issues.push("No recent call activity (potential service issue)");
      impactScore = Math.max(impactScore, 40);
      if (impactLevel === "none") impactLevel = "medium";
    }

    const recommendation =
      impactLevel === "critical"
        ? "Immediate intervention required"
        : impactLevel === "high"
          ? "Contact customer within 2 hours"
          : impactLevel === "medium"
            ? "Monitor closely and consider proactive outreach"
            : "No action needed";

    res.json({
      customerId,
      customerName: customer?.business_name || "Unknown",
      planId: customer?.plan_id || null,
      subscriptionStatus: customer?.subscription_status || null,
      timeRange,
      impactLevel,
      impactScore,
      metrics: {
        totalCalls,
        successfulCalls,
        overallSuccessRate: totalCalls > 0 ? Math.round((successfulCalls / totalCalls) * 10000) / 100 : 0,
        recentSuccessRate: Math.round(recentSuccessRate * 100) / 100,
        earlierSuccessRate: Math.round(earlierSuccessRate * 100) / 100,
        successRateTrend: Math.round(successRateTrend * 100) / 100,
        recentFailures: recentFailures.length,
        recentCallVolume: recentCalls.length,
      },
      issues,
      recentFailureDetails: recentFailures.map((call: any) => ({
        id: call.id,
        status: call.status,
        callOutcome: call.call_outcome,
        timestamp: call.created_at,
        duration: call.duration_seconds,
      })),
      recommendation,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Monitoring] customer impact error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/monitoring/dashboard", requireAuth, requirePermission("analytics", "read"), async (req: any, res: any) => {
  try {
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });
    const supabase = getSupabase();

    const [oneHour, day, week, activeCustomersResult] = await Promise.all([
      computeSystemHealth(supabase, "1h", req.businessId),
      computeSystemHealth(supabase, "24h", req.businessId),
      computeSystemHealth(supabase, "7d", req.businessId),
      supabase
        .from("business_configs")
        .select("business_id", { count: "exact", head: true })
        .eq("business_id", req.businessId)
        .eq("subscription_status", "active"),
    ]);

    const allAlerts = [
      ...oneHour.alerts.map((a: any) => ({ ...a, timeRange: "1h" })),
      ...day.alerts.map((a: any) => ({ ...a, timeRange: "24h" })),
      ...week.alerts.map((a: any) => ({ ...a, timeRange: "7d" })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      overview: {
        systemStatus: oneHour.systemStatus,
        alertLevel: oneHour.alertLevel,
        activeCustomers: activeCustomersResult.count || 0,
        totalActiveAlerts: allAlerts.filter((a: any) => a.severity === "critical" || a.severity === "warning").length,
      },
      timeRanges: {
        lastHour: oneHour.metrics,
        last24Hours: day.metrics,
        lastWeek: week.metrics,
      },
      alerts: allAlerts.slice(0, 20),
      customerImpact: {
        oneHour: oneHour.customerImpact,
        twentyFourHours: day.customerImpact,
        week: week.customerImpact,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Monitoring] dashboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// CUSTOMER SUCCESS AUTOMATION
// ============================================================================

router.post("/automation/evaluate-triggers", requireAuth, requireStaffPermission("automation", "write"), async (req: any, res: any) => {
  try {
    const supabase = getSupabase();
    const triggeredWorkflows: any[] = [];

    const { data: customers, error } = await supabase
      .from("business_configs")
      .select("business_id, business_name, subscription_status, plan_id, created_at, customer_intelligence");

    if (error) throw error;

    // System health check — avoid creating noise tickets during a real outage
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: recentCalls } = await supabase
      .from("calls")
      .select("status, call_outcome")
      .gte("created_at", oneHourAgo);

    const recentList = recentCalls || [];
    const systemHealthy =
      recentList.length === 0 ||
      recentList.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length / recentList.length > 0.7;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    for (const customer of customers || []) {
      const customerId = customer.business_id;
      if (!customerId) continue;

      const daysActive = customer.created_at
        ? Math.floor((Date.now() - new Date(customer.created_at).getTime()) / (24 * 60 * 60 * 1000))
        : 0;

      const { data: customerCalls } = await supabase
        .from("calls")
        .select("status, call_outcome, created_at")
        .eq("business_id", customerId)
        .gte("created_at", sevenDaysAgo);

      const list = customerCalls || [];
      const totalCalls = list.length;
      const successfulCalls = list.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length;
      const successRate = totalCalls > 0 ? successfulCalls / totalCalls : 0;

      // TRIGGER 1: Trial customer with zero usage after 3+ days
      if (
        customer.subscription_status === "trialing" &&
        daysActive >= 3 &&
        totalCalls === 0 &&
        systemHealthy
      ) {
        triggeredWorkflows.push({
          type: "trial_zero_usage_onboarding",
          customerId,
          customerName: customer.business_name,
          priority: daysActive > 7 ? "high" : "medium",
          trigger: {
            condition: "Trial customer with zero calls after 3+ days",
            daysActive,
            totalCalls,
            systemHealthy,
          },
          action: {
            createTicket: true,
            ticketData: {
              title: `Onboarding Support Needed - ${customer.business_name}`,
              description: `Trial customer (${daysActive} days) has not made any calls yet. May need onboarding assistance or configuration help.`,
              priority: daysActive > 7 ? "high" : "medium",
              category: "onboarding",
              assignedTo: "Customer Success Team",
            },
            sendEmail: true,
            emailType: "onboarding_help",
          },
          urgency: daysActive > 10 ? "urgent" : "normal",
        });
      }

      // TRIGGER 2: Active paying customer with declining success rate
      if (
        customer.subscription_status === "active" &&
        totalCalls >= 10 &&
        successRate < 0.5 &&
        systemHealthy
      ) {
        triggeredWorkflows.push({
          type: "active_customer_quality_issues",
          customerId,
          customerName: customer.business_name,
          priority: "high",
          trigger: {
            condition: "Active customer with <50% call success rate",
            totalCalls,
            successRate: Math.round(successRate * 10000) / 100,
            systemHealthy,
          },
          action: {
            createTicket: true,
            ticketData: {
              title: `Technical Review Required - ${customer.business_name}`,
              description: `Active customer showing poor call performance: ${successfulCalls}/${totalCalls} calls successful (${Math.round(successRate * 100)}%). Requires technical investigation.`,
              priority: "high",
              category: "technical",
              assignedTo: "Technical Support Team",
            },
            escalate: true,
          },
          urgency: "high",
        });
      }

      // TRIGGER 3: Trial expiring soon with low usage
      if (
        customer.subscription_status === "trialing" &&
        daysActive >= 12 &&
        daysActive <= 14 &&
        totalCalls < 5
      ) {
        triggeredWorkflows.push({
          type: "trial_expiring_low_usage",
          customerId,
          customerName: customer.business_name,
          priority: "high",
          trigger: {
            condition: "Trial expiring in 2-0 days with minimal usage",
            daysActive,
            totalCalls,
            daysRemaining: 14 - daysActive,
          },
          action: {
            createTicket: true,
            ticketData: {
              title: `Trial Conversion Risk - ${customer.business_name}`,
              description: `Trial expires in ${14 - daysActive} days with only ${totalCalls} calls made. Needs immediate conversion outreach.`,
              priority: "urgent",
              category: "general",
              assignedTo: "Sales Team",
            },
            sendEmail: true,
            emailType: "trial_expiring_soon",
          },
          urgency: "urgent",
        });
      }

      // TRIGGER 4: High-value customer with low recent activity
      const intelligence = customer.customer_intelligence || {};
      const businessSize = intelligence?.business?.size;
      const isHighValue =
        ["business", "enterprise"].includes(String(customer.plan_id || "").toLowerCase()) ||
        businessSize === "large";

      if (
        customer.subscription_status === "active" &&
        isHighValue &&
        totalCalls < 3 &&
        daysActive > 7
      ) {
        triggeredWorkflows.push({
          type: "high_value_customer_low_activity",
          customerId,
          customerName: customer.business_name,
          priority: "high",
          trigger: {
            condition: "High-value customer with low recent activity",
            planTier: customer.plan_id,
            businessSize,
            totalCalls,
            isHighValue,
          },
          action: {
            createTicket: true,
            ticketData: {
              title: `High-Value Customer Check-in - ${customer.business_name}`,
              description: `${customer.plan_id} plan customer with minimal usage (${totalCalls} calls in 7 days). Requires proactive outreach to ensure satisfaction.`,
              priority: "high",
              category: "general",
              assignedTo: "Account Manager",
            },
          },
          urgency: "high",
        });
      }
    }

    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId!,
      businessId: req.businessId!,
      action: "admin.automation.triggers.evaluated",
      resource: "automation",
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      sessionId: req.sessionId,
      details: {
        customersEvaluated: customers?.length || 0,
        workflowsTriggered: triggeredWorkflows.length,
        systemHealthy,
        adminUser: req.userEmail,
      },
      complianceFlags: ["ADMIN-ACTION", "AUTOMATION"],
    });

    res.json({
      success: true,
      systemHealthy,
      customersEvaluated: customers?.length || 0,
      workflowsTriggered: triggeredWorkflows.length,
      workflows: triggeredWorkflows,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Automation] evaluate-triggers error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/automation/execute-workflows", requireAuth, requireStaffPermission("automation", "write"), async (req: any, res: any) => {
  try {
    const { workflows, dryRun = false } = req.body || {};

    if (!workflows || !Array.isArray(workflows)) {
      return res.status(400).json({ error: "workflows array is required" });
    }

    const supabase = getSupabase();
    const executionResults: any[] = [];

    for (const workflow of workflows) {
      const result: any = {
        workflowId: `${workflow.type}_${workflow.customerId}`,
        type: workflow.type,
        customerId: workflow.customerId,
        customerName: workflow.customerName,
        executed: false,
        actions: [],
      };

      try {
        if (workflow.action?.createTicket) {
          const td = workflow.action.ticketData || {};

          // Idempotency guard — skip if an open automated ticket of the same
          // workflow type already exists for this customer in the last 7 days.
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: existing, error: dupErr } = await supabase
            .from("support_tickets")
            .select("id, created_at")
            .eq("customer_id", workflow.customerId)
            .eq("created_by", "automation_system")
            .in("status", ["open", "in_progress"])
            .contains("tags", [workflow.type])
            .gte("created_at", sevenDaysAgo)
            .limit(1);
          if (dupErr) throw dupErr;

          if (existing && existing.length > 0) {
            result.actions.push({
              type: "ticket_skipped",
              success: true,
              reason: "duplicate_open_ticket_within_7d",
              existingTicketId: existing[0].id,
              existingCreatedAt: existing[0].created_at,
              dryRun,
            });
          } else {
            const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;

            if (!dryRun) {
              const { error: ticketError } = await supabase.from("support_tickets").insert({
                id: ticketId,
                customer_id: workflow.customerId,
                customer_business_name: workflow.customerName,
                title: td.title,
                description: td.description,
                priority: td.priority || "medium",
                category: td.category || "general",
                status: "open",
                assigned_to: td.assignedTo || null,
                created_by: "automation_system",
                tags: ["automated", workflow.type],
              });
              if (ticketError) throw ticketError;
            }

            result.actions.push({
              type: "ticket_created",
              success: true,
              ticketId,
              assignedTo: td.assignedTo,
              dryRun,
            });
          }
        }

        if (workflow.action?.sendEmail) {
          result.actions.push({
            type: "email_sent",
            success: true,
            emailType: workflow.action.emailType,
            note: "Email integration placeholder - would send actual email",
            dryRun,
          });
        }

        if (workflow.action?.escalate) {
          result.actions.push({
            type: "escalated",
            success: true,
            escalatedTo: "management",
            note: "High-priority customer issue flagged for immediate attention",
            dryRun,
          });
        }

        result.executed = !dryRun;
      } catch (workflowError: any) {
        result.error = workflowError.message;
        result.executed = false;
      }

      executionResults.push(result);
    }

    if (!dryRun) {
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.automation.workflows.executed",
        resource: "automation",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          workflowsExecuted: executionResults.filter((r) => r.executed).length,
          workflowTypes: workflows.map((w: any) => w.type),
          dryRun,
          adminUser: req.userEmail,
        },
        complianceFlags: ["ADMIN-ACTION", "AUTOMATION", "WORKFLOW-EXECUTION"],
      });
    }

    res.json({
      success: true,
      dryRun,
      workflowsProcessed: workflows.length,
      executionResults,
      summary: {
        successful: executionResults.filter((r) => r.executed && !r.error).length,
        failed: executionResults.filter((r) => r.error).length,
        ticketsCreated: executionResults.reduce(
          (count, r) => count + r.actions.filter((a: any) => a.type === "ticket_created" && a.success).length,
          0,
        ),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Automation] execute-workflows error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/automation/dashboard", requireAuth, requireStaffPermission("automation", "read"), async (_req: any, res: any) => {
  try {
    const supabase = getSupabase();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: automatedTickets, error } = await supabase
      .from("support_tickets")
      .select("*")
      .eq("created_by", "automation_system")
      .gte("created_at", thirtyDaysAgo)
      .order("created_at", { ascending: false });

    if (error) throw error;

    const tickets = automatedTickets || [];
    const ticketsByType: Record<string, { count: number; resolved: number }> = {};
    const ticketsByStatus: Record<string, number> = {};

    const extractWorkflowType = (tags: any): string => {
      if (!Array.isArray(tags)) return "unknown";
      // Skip the generic "automated" tag and pick the workflow-specific tag
      return tags.find((t) => typeof t === "string" && t !== "automated" && t.includes("_")) || "unknown";
    };

    for (const ticket of tickets) {
      const workflowType = extractWorkflowType(ticket.tags);
      if (!ticketsByType[workflowType]) ticketsByType[workflowType] = { count: 0, resolved: 0 };
      ticketsByType[workflowType].count++;
      if (["resolved", "closed"].includes(ticket.status)) ticketsByType[workflowType].resolved++;

      ticketsByStatus[ticket.status] = (ticketsByStatus[ticket.status] || 0) + 1;
    }

    res.json({
      summary: {
        totalAutomatedTickets: tickets.length,
        activeAutomatedTickets: tickets.filter((t) => ["open", "in_progress"].includes(t.status)).length,
        resolvedAutomatedTickets: tickets.filter((t) => ["resolved", "closed"].includes(t.status)).length,
      },
      analytics: {
        ticketsByWorkflowType: ticketsByType,
        ticketsByStatus,
        automationEffectiveness: Object.entries(ticketsByType).map(([type, data]) => ({
          workflowType: type,
          totalTriggered: data.count,
          resolved: data.resolved,
          resolutionRate: data.count > 0 ? Math.round((data.resolved / data.count) * 10000) / 100 : 0,
        })),
      },
      recentActivity: tickets.slice(0, 10).map((ticket) => ({
        id: ticket.id,
        workflowType: extractWorkflowType(ticket.tags),
        customerName: ticket.customer_business_name,
        title: ticket.title,
        priority: ticket.priority,
        status: ticket.status,
        createdAt: ticket.created_at,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Automation] dashboard error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// TEST DATA CLEANUP
// ============================================================================

const TEST_DATA_PATTERNS = [
  "demo-",
  "biz_",
  "test",
  "example",
  "bright smile",
  "riverside medical",
  "golden fork",
  "premier hvac",
  "metro auto",
];

const PROTECTED_BUSINESS_IDS = new Set(["demo-business"]);

function isProtectedBusiness(b: { business_id?: string; subscription_status?: string }): { protected: boolean; reason?: string } {
  if (b.business_id && PROTECTED_BUSINESS_IDS.has(b.business_id)) {
    return { protected: true, reason: "Active demo customer" };
  }
  if (b.subscription_status === "active") {
    return { protected: true, reason: "Active subscription" };
  }
  return { protected: false };
}

function findTestBusinesses(
  rows: Array<{ business_id?: string; business_name?: string; subscription_status?: string }>,
) {
  return rows.filter((b) => {
    const guard = isProtectedBusiness(b);
    if (guard.protected) {
      console.log(`[Cleanup] Preserving ${b.business_id} (${guard.reason})`);
      return false;
    }
    const name = (b.business_name || "").toLowerCase();
    const id = (b.business_id || "").toLowerCase();
    return TEST_DATA_PATTERNS.some((p) => {
      const pat = p.toLowerCase();
      return name.includes(pat) || id.includes(pat);
    });
  });
}

function computePreservedCustomers(
  rows: Array<{ business_id?: string; business_name?: string; subscription_status?: string }>,
) {
  return rows
    .map((b) => {
      const guard = isProtectedBusiness(b);
      if (!guard.protected) return null;
      return {
        id: b.business_id,
        name: b.business_name,
        status: b.subscription_status,
        reason: guard.reason,
      };
    })
    .filter(Boolean);
}

router.get("/cleanup/preview-test-data", requireAuth, requireStaffPermission("customers", "read"), async (req: any, res: any) => {
  try {
    const supabase = getSupabase();
    const excludeRaw = req.query.excludeBusinessIds;
    const excludeSet = new Set(
      (Array.isArray(excludeRaw) ? excludeRaw : excludeRaw ? String(excludeRaw).split(",") : [])
        .map((s: any) => String(s).trim())
        .filter(Boolean),
    );

    const { data: allBusinesses, error } = await supabase
      .from("business_configs")
      .select("business_id, business_name, subscription_status, plan_id, created_at");
    if (error) throw error;

    const testBusinesses = findTestBusinesses(allBusinesses || []).filter(
      (b: any) => !excludeSet.has(b.business_id),
    );
    const testBusinessIds = testBusinesses.map((b: any) => b.business_id);

    let supportTickets = 0;
    let businessUsers = 0;
    let calls = 0;
    let auditLogs = 0;

    if (testBusinessIds.length > 0) {
      const [t, u, c, a] = await Promise.all([
        supabase.from("support_tickets").select("id", { count: "exact", head: true }).in("customer_id", testBusinessIds),
        supabase.from("business_users").select("id", { count: "exact", head: true }).in("business_id", testBusinessIds),
        supabase.from("calls").select("id", { count: "exact", head: true }).in("business_id", testBusinessIds),
        supabase.from("audit_logs").select("id", { count: "exact", head: true }).in("business_id", testBusinessIds),
      ]);
      supportTickets = t.count || 0;
      businessUsers = u.count || 0;
      calls = c.count || 0;
      auditLogs = a.count || 0;
    }

    // Also count automated tickets globally (the executor would also wipe these)
    const { count: automatedTicketsCount } = await supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("created_by", "automation_system");

    const preservedCustomers = computePreservedCustomers(allBusinesses || []);

    res.json({
      testBusinesses,
      testBusinessIds,
      patterns: TEST_DATA_PATTERNS,
      impactSummary: {
        businessConfigs: testBusinesses.length,
        supportTickets,
        automatedTicketsGlobal: automatedTicketsCount || 0,
        businessUsers,
        calls,
        auditLogs,
      },
      preservedCustomers,
      warning: "This data will be permanently deleted if cleanup is executed",
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Cleanup] preview error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/cleanup/remove-test-data", requireAuth, requireStaffPermission("customers", "delete"), async (req: any, res: any) => {
  try {
    const { confirmCleanup = false, excludeBusinessIds = [] } = req.body || {};
    const excludeSet = new Set((Array.isArray(excludeBusinessIds) ? excludeBusinessIds : []).map(String));

    if (!confirmCleanup) {
      return res.status(400).json({
        error: "Must set confirmCleanup: true to proceed",
        warning: "This will permanently delete test data",
      });
    }

    const supabase = getSupabase();
    const deletionResults = {
      businessConfigs: 0,
      supportTickets: 0,
      businessUsers: 0,
      calls: 0,
      auditLogs: 0,
    };

    const { data: allBusinesses, error: fetchError } = await supabase
      .from("business_configs")
      .select("business_id, business_name, subscription_status");
    if (fetchError) throw fetchError;

    const preservedCustomers = computePreservedCustomers(allBusinesses || []);
    const testBusinessIds = findTestBusinesses(allBusinesses || [])
      .map((b: any) => b.business_id)
      .filter((id: string) => !excludeSet.has(id));
    console.log(
      "[Cleanup] Identified test businesses:",
      testBusinessIds,
      "| caller-excluded:",
      [...excludeSet],
      "| protected:",
      preservedCustomers.map((p: any) => p.id),
    );

    if (testBusinessIds.length === 0) {
      return res.json({
        success: true,
        message: "No test data found to clean up",
        deletionResults,
      });
    }

    // 1. support_tickets for test customers
    const { error: ticketsError, count: ticketsCount } = await supabase
      .from("support_tickets")
      .delete({ count: "exact" })
      .in("customer_id", testBusinessIds);
    if (!ticketsError) deletionResults.supportTickets = ticketsCount || 0;
    else console.warn("[Cleanup] tickets delete error:", ticketsError.message);

    // 2. automated tickets globally (any leftover automation_system tickets)
    const { error: autoErr, count: autoCount } = await supabase
      .from("support_tickets")
      .delete({ count: "exact" })
      .eq("created_by", "automation_system");
    if (!autoErr) deletionResults.supportTickets += autoCount || 0;
    else console.warn("[Cleanup] auto tickets delete error:", autoErr.message);

    // 3. business_users
    const { error: usersError, count: usersCount } = await supabase
      .from("business_users")
      .delete({ count: "exact" })
      .in("business_id", testBusinessIds);
    if (!usersError) deletionResults.businessUsers = usersCount || 0;
    else console.warn("[Cleanup] users delete error:", usersError.message);

    // 4. calls
    const { error: callsError, count: callsCount } = await supabase
      .from("calls")
      .delete({ count: "exact" })
      .in("business_id", testBusinessIds);
    if (!callsError) deletionResults.calls = callsCount || 0;
    else console.warn("[Cleanup] calls delete error:", callsError.message);

    // 5. audit_logs (best-effort — may not have business_id column on all installs)
    const { error: auditError, count: auditCount } = await supabase
      .from("audit_logs")
      .delete({ count: "exact" })
      .in("business_id", testBusinessIds);
    if (!auditError) deletionResults.auditLogs = auditCount || 0;
    else console.warn("[Cleanup] audit logs delete error:", auditError.message);

    // 6. business_configs LAST (parent table)
    const { error: configsError, count: configsCount } = await supabase
      .from("business_configs")
      .delete({ count: "exact" })
      .in("business_id", testBusinessIds);
    if (!configsError) deletionResults.businessConfigs = configsCount || 0;
    else console.warn("[Cleanup] configs delete error:", configsError.message);

    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId!,
      businessId: req.businessId!,
      action: "admin.cleanup.test.data.removed",
      resource: "cleanup",
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      sessionId: req.sessionId,
      details: {
        testBusinessIds,
        deletionResults,
        adminUser: req.userEmail,
      },
      complianceFlags: ["ADMIN-ACTION", "DATA-CLEANUP"],
      riskScore: 80,
    });

    res.json({
      success: true,
      message: `Successfully cleaned up test data for ${testBusinessIds.length} test businesses`,
      testBusinessIds,
      deletionResults,
      preservedCustomers,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Cleanup] remove-test-data error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Email subsystem (SendGrid via Replit connector)
// ---------------------------------------------------------------------------

const APP_URL = process.env.APP_URL || "https://neverr.ai";

type EmailTemplateName =
  | "welcome"
  | "trial_expiring"
  | "onboarding_help"
  | "payment_failed"
  | "technical_review";

interface EmailTemplate {
  subject: string | ((data: Record<string, any>) => string);
  description: string;
  html: (data: Record<string, any>) => string;
}

const emailTemplates: Record<EmailTemplateName, EmailTemplate> = {
  welcome: {
    subject: "Welcome to Neverr — Your AI Voice Assistant is Ready",
    description: "Sent to new customers after signup to guide initial setup",
    html: (data) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#2563eb;">Welcome to Neverr, ${escapeHtml(data.customerName)}!</h2>
        <p>Your AI voice assistant is now active and ready to handle calls for your business.</p>
        <div style="background:#f8fafc;padding:20px;border-radius:8px;margin:20px 0;">
          <h3 style="margin-top:0;">Your Account Details</h3>
          <p><strong>Business:</strong> ${escapeHtml(data.businessName)}</p>
          <p><strong>Plan:</strong> ${escapeHtml(data.planName)}</p>
          <p><strong>Phone Number:</strong> ${escapeHtml(data.phoneNumber || "Setup in progress")}</p>
        </div>
        <h3>Quick Start Guide</h3>
        <ol>
          <li>Configure your business hours and availability</li>
          <li>Customize your AI assistant's responses</li>
          <li>Test your first call</li>
          <li>Monitor performance in your dashboard</li>
        </ol>
        <p style="text-align:center;margin:30px 0;">
          <a href="${APP_URL}/dashboard" style="background:#2563eb;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Access Your Dashboard</a>
        </p>
        <p>Need help? Reply to this email or visit our <a href="${APP_URL}/support">support center</a>.</p>
        <p>— The Neverr Team</p>
      </div>`,
  },
  trial_expiring: {
    subject: (data) => `Your Neverr Trial Expires in ${data.daysRemaining ?? "a few"} Days`,
    description: "Sent 1–3 days before trial expiration to encourage upgrade",
    html: (data) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#dc2626;">Your Trial Expires in ${escapeHtml(String(data.daysRemaining ?? "a few"))} Days</h2>
        <p>Hi ${escapeHtml(data.customerName)},</p>
        <p>Don't lose the calls your AI has been handling for ${escapeHtml(data.businessName)}.</p>
        ${
          data.callStats
            ? `<div style="background:#fef3c7;padding:20px;border-radius:8px;margin:20px 0;">
                <h3 style="margin-top:0;">Your Trial Results</h3>
                <p><strong>Calls Handled:</strong> ${escapeHtml(String(data.callStats.total ?? 0))}</p>
                <p><strong>Success Rate:</strong> ${escapeHtml(String(data.callStats.successRate ?? 0))}%</p>
                <p><strong>Estimated Revenue Protected:</strong> $${escapeHtml(String(data.callStats.estimatedValue ?? 0))}</p>
              </div>`
            : ""
        }
        <ul>
          <li>Unlimited call handling</li>
          <li>Advanced AI customization</li>
          <li>Detailed analytics and reporting</li>
          <li>Priority support</li>
        </ul>
        <p style="text-align:center;margin:30px 0;">
          <a href="${APP_URL}/upgrade" style="background:#dc2626;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Upgrade Now</a>
        </p>
        <p>— The Neverr Team</p>
      </div>`,
  },
  onboarding_help: {
    subject: "Let's Get Your Neverr AI Assistant Working — Free Setup Help",
    description: "Sent to trial customers with zero usage after 3+ days",
    html: (data) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#059669;">Need Help Getting Started?</h2>
        <p>Hi ${escapeHtml(data.customerName)},</p>
        <p>We noticed you haven't made any calls with your Neverr AI assistant yet. We're here to help.</p>
        <div style="background:#ecfdf5;padding:20px;border-radius:8px;margin:20px 0;">
          <h3 style="margin-top:0;">Free Setup Assistance</h3>
          <ul>
            <li>Configure your AI for your specific business</li>
            <li>Set up call routing and business hours</li>
            <li>Test your first calls together</li>
            <li>Optimize settings for your industry</li>
          </ul>
        </div>
        <p style="text-align:center;margin:30px 0;">
          <a href="${APP_URL}/schedule-setup" style="background:#059669;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Schedule Free 15-Minute Setup Call</a>
        </p>
        <p>Or try our <a href="${APP_URL}/quick-setup">5-minute quick setup guide</a>.</p>
        <p>— Customer Success at Neverr</p>
      </div>`,
  },
  payment_failed: {
    subject: "Action Required: Update Your Neverr Payment Method",
    description: "Sent when payment processing fails, with grace period info",
    html: (data) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#dc2626;">Payment Method Needs Updating</h2>
        <p>Hi ${escapeHtml(data.customerName)},</p>
        <p>We couldn't process your payment for ${escapeHtml(data.businessName)}. Your AI voice assistant will keep working for the next ${escapeHtml(String(data.gracePeriodDays ?? 7))} days while you update your payment method.</p>
        <div style="background:#fef2f2;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #dc2626;">
          <h3 style="margin-top:0;color:#dc2626;">Invoice Details</h3>
          <p><strong>Amount:</strong> $${escapeHtml(String(data.amount ?? "—"))}</p>
          <p><strong>Invoice Date:</strong> ${escapeHtml(String(data.invoiceDate ?? "—"))}</p>
          <p><strong>Plan:</strong> ${escapeHtml(data.planName)}</p>
        </div>
        <p style="text-align:center;margin:30px 0;">
          <a href="${APP_URL}/billing/update" style="background:#dc2626;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Update Payment Method</a>
        </p>
        <p>— The Neverr Team</p>
      </div>`,
  },
  technical_review: {
    subject: "We're Investigating Your Call Quality — Update from Neverr",
    description: "Sent when a customer experiences poor call quality",
    html: (data) => `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#059669;">We're Looking Into Your Call Performance</h2>
        <p>Hi ${escapeHtml(data.customerName)},</p>
        <p>We've detected some call quality issues for ${escapeHtml(data.businessName)} and wanted to reach out immediately.</p>
        <div style="background:#fefce8;padding:20px;border-radius:8px;margin:20px 0;">
          <h3 style="margin-top:0;">What We Found</h3>
          <p><strong>Recent Calls:</strong> ${escapeHtml(String(data.recentCalls ?? 0))} in last 7 days</p>
          <p><strong>Success Rate:</strong> ${escapeHtml(String(data.successRate ?? 0))}% (below our 85% standard)</p>
        </div>
        <ul>
          <li>Technical team notified and investigating</li>
          <li>Reviewing your call logs and configurations</li>
          <li>Testing improvements to your AI assistant</li>
        </ul>
        ${
          data.ticketId
            ? `<p style="text-align:center;margin:30px 0;">
                <a href="${APP_URL}/support/ticket/${encodeURIComponent(String(data.ticketId))}" style="background:#059669;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Track Investigation Progress</a>
              </p>`
            : ""
        }
        <p>Reply to this email and it goes straight to our technical team.</p>
        <p>— Technical Team at Neverr</p>
      </div>`,
  },
};

function escapeHtml(s: any): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveSubject(t: EmailTemplate, data: Record<string, any>): string {
  return typeof t.subject === "function" ? t.subject(data) : t.subject;
}

async function resolveCustomerEmail(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ email: string | null; businessName: string | null; planName: string | null }> {
  const { data: biz } = await supabase
    .from("business_configs")
    .select("business_name, plan_id, email, notification_email, owner_name")
    .eq("business_id", customerId)
    .maybeSingle();
  if (!biz) return { email: null, businessName: null, planName: null };
  const email = (biz.email as string | null) || (biz.notification_email as string | null) || null;
  return {
    email,
    businessName: (biz.business_name as string | null) ?? null,
    planName: (biz.plan_id as string | null) ?? null,
  };
}

async function sendTemplatedEmail(
  to: string,
  template: EmailTemplateName,
  data: Record<string, any>,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const tmpl = emailTemplates[template];
  if (!tmpl) return { success: false, error: `Unknown template: ${template}` };
  try {
    const { client, fromEmail } = await getUncachableSendGridClient();
    const [resp] = await client.send({
      to,
      from: { email: fromEmail, name: "Neverr" },
      subject: resolveSubject(tmpl, data),
      html: tmpl.html(data),
    });
    const messageId =
      (resp?.headers as any)?.["x-message-id"] ||
      (resp?.headers as any)?.["X-Message-Id"] ||
      undefined;
    console.log("[Email] Sent", { to, template, messageId, status: resp?.statusCode });
    return { success: true, messageId };
  } catch (err: any) {
    const detail = err?.response?.body?.errors || err?.message;
    console.error("[Email] Send failed", { to, template, detail });
    return { success: false, error: typeof detail === "string" ? detail : JSON.stringify(detail) };
  }
}

router.get("/emails/templates", requireAuth, requireStaffPermission("support", "read"), async (_req: any, res: any) => {
  try {
    const templates = (Object.keys(emailTemplates) as EmailTemplateName[]).map((name) => ({
      name,
      subject: typeof emailTemplates[name].subject === "function" ? "(dynamic)" : emailTemplates[name].subject,
      description: emailTemplates[name].description,
    }));
    res.json({ templates, timestamp: new Date().toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/emails/preview", requireAuth, requireStaffPermission("support", "write"), async (req: any, res: any) => {
  try {
    const { template, data } = req.body || {};
    const tmpl = emailTemplates[template as EmailTemplateName];
    if (!tmpl) return res.status(400).json({ error: `Unknown template: ${template}` });
    const merged = {
      customerName: "Sample Customer",
      businessName: "Sample Business",
      planName: "Essential",
      ...(data || {}),
    };
    res.json({
      template,
      subject: resolveSubject(tmpl, merged),
      html: tmpl.html(merged),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/emails/send", requireAuth, requireStaffPermission("support", "write"), async (req: any, res: any) => {
  try {
    const { customerId, template, data, toOverride } = req.body || {};
    if (!customerId || !template) {
      return res.status(400).json({ error: "customerId and template are required" });
    }
    if (!emailTemplates[template as EmailTemplateName]) {
      return res.status(400).json({ error: `Unknown template: ${template}` });
    }
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database unavailable" });

    const { email, businessName, planName } = await resolveCustomerEmail(supabase, customerId);
    const recipient = (toOverride as string | undefined) || email;
    if (!recipient) {
      return res.status(404).json({ error: "Customer email not found", customerId });
    }

    const emailData = {
      customerName: (recipient.split("@")[0] || "there"),
      businessName: businessName || "Your Business",
      planName: planName || "Essential",
      ...(data || {}),
    };

    const result = await sendTemplatedEmail(recipient, template as EmailTemplateName, emailData);
    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId!,
      businessId: customerId,
      action: "admin.email.sent",
      resource: "email",
      success: result.success,
      details: {
        template,
        to: recipient,
        messageId: result.messageId,
        error: result.error,
        adminUser: req.userEmail,
      },
      complianceFlags: ["ADMIN-ACTION", "EMAIL-COMMUNICATION"],
      ...meta,
    });

    res.status(result.success ? 200 : 502).json({
      success: result.success,
      template,
      recipient,
      messageId: result.messageId || null,
      error: result.error || null,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Email] /send error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Revenue / cohort / churn analytics
// ---------------------------------------------------------------------------
//
// Data-quality notes (returned in `dataLimitations` on each response):
//   - We do not yet persist a subscription event log, so historical MRR is
//     approximated by treating *currently-active* subscriptions as having been
//     active throughout their lifetime. This overstates retention and
//     understates churn for any period before "now". The current period is
//     accurate.
//   - Cohort retention is computed against cohort age (period 0 = signup
//     period, period 1 = following period, …), not calendar time.
//   - Churn risk uses `callIs()` so both `status` and `call_outcome` columns
//     are considered when classifying a call as successful.

const REVENUE_TIME_WINDOWS_MS: Record<string, number> = {
  "3m": 3 * 30 * 24 * 60 * 60 * 1000,
  "6m": 6 * 30 * 24 * 60 * 60 * 1000,
  "12m": 12 * 30 * 24 * 60 * 60 * 1000,
  "24m": 24 * 30 * 24 * 60 * 60 * 1000,
};

function safePctChange(current: number, previous: number): number | null {
  if (!previous) return null; // honest: can't compute when prior was zero
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

router.get("/analytics/revenue", requireAuth, requireStaffPermission("analytics", "read"), async (req: any, res: any) => {
  try {
    const timeRange = String(req.query.timeRange || "12m");
    const granularity = req.query.granularity === "week" ? "week" : "month";
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database unavailable" });

    const windowMs = REVENUE_TIME_WINDOWS_MS[timeRange] ?? REVENUE_TIME_WINDOWS_MS["12m"];

    // Pull ALL customers (no created_at filter) — pre-window customers still
    // contribute MRR within the window.
    const { data: customers, error } = await supabase
      .from("business_configs")
      .select("business_id, business_name, plan_id, subscription_status, created_at");
    if (error) throw error;

    const periodMs = granularity === "month" ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const periods = Math.max(1, Math.round(windowMs / periodMs));
    const now = Date.now();

    const timeSeries = [];
    for (let i = periods - 1; i >= 0; i--) {
      const periodEnd = new Date(now - i * periodMs);
      const periodStart = new Date(now - (i + 1) * periodMs);

      const existedByEnd = (customers || []).filter(
        (c) => new Date(c.created_at).getTime() <= periodEnd.getTime(),
      );
      const activeByEnd = existedByEnd.filter((c) => c.subscription_status === "active");
      const newInPeriod = (customers || []).filter((c) => {
        const t = new Date(c.created_at).getTime();
        return t >= periodStart.getTime() && t < periodEnd.getTime();
      });

      const mrr = activeByEnd.reduce((sum, c) => sum + priceFor(c.plan_id), 0);
      const arpa = activeByEnd.length ? mrr / activeByEnd.length : 0;

      timeSeries.push({
        period: periodEnd.toISOString().split("T")[0],
        periodLabel:
          granularity === "month"
            ? periodEnd.toLocaleDateString("en-US", { month: "short", year: "numeric" })
            : `Week of ${periodEnd.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
        metrics: {
          totalCustomers: existedByEnd.length,
          activeCustomers: activeByEnd.length,
          newCustomers: newInPeriod.length,
          churnedCustomers: 0, // requires subscription event log to compute accurately
          mrr: Math.round(mrr),
          arr: Math.round(mrr * 12),
          averageRevenuePerAccount: Math.round(arpa * 100) / 100,
          netRevenueRetention: null,
          grossRevenueRetention: null,
        },
      });
    }

    const current = timeSeries[timeSeries.length - 1];
    const previous = timeSeries[timeSeries.length - 2];

    res.json({
      timeRange,
      granularity,
      summary: {
        currentMRR: current.metrics.mrr,
        currentARR: current.metrics.arr,
        totalCustomers: current.metrics.totalCustomers,
        activeCustomers: current.metrics.activeCustomers,
        averageRevenuePerAccount: current.metrics.averageRevenuePerAccount,
        mrrGrowthRate: previous ? safePctChange(current.metrics.mrr, previous.metrics.mrr) : null,
        customerGrowthRate: previous
          ? safePctChange(current.metrics.totalCustomers, previous.metrics.totalCustomers)
          : null,
      },
      timeSeries,
      dataLimitations: [
        "Historical MRR uses current subscription_status as a proxy; pre-`now` periods may be over- or under-counted until a subscription event log exists.",
        "churnedCustomers and NRR/GRR are returned as 0/null until a subscription event log is added.",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Analytics] revenue error:", err);
    res.status(500).json({ error: err.message });
  }
});

function monthDiff(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}

router.get("/analytics/cohorts", requireAuth, requireStaffPermission("analytics", "read"), async (req: any, res: any) => {
  try {
    const cohortType = req.query.cohortType === "weekly" ? "weekly" : "monthly";
    const periodsBack = Math.max(1, Math.min(36, parseInt(String(req.query.periodsBack || "12"), 10) || 12));
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database unavailable" });

    const periodMs = cohortType === "monthly" ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const startDate = new Date(Date.now() - periodsBack * periodMs);

    const { data: customers, error } = await supabase
      .from("business_configs")
      .select("business_id, business_name, plan_id, subscription_status, created_at")
      .gte("created_at", startDate.toISOString())
      .order("created_at");
    if (error) throw error;

    type Cohort = {
      cohortKey: string;
      cohortLabel: string;
      cohortStart: Date;
      cohortSize: number;
      members: any[];
    };
    const cohorts = new Map<string, Cohort>();

    const cohortKeyFor = (d: Date): { key: string; label: string; start: Date } => {
      if (cohortType === "monthly") {
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
        const label = start.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
        return { key, label, start };
      }
      // weekly: bucket by 7-day intervals from the unix epoch (Monday-aligned-ish)
      const dayMs = 24 * 60 * 60 * 1000;
      const week = Math.floor(d.getTime() / (7 * dayMs));
      const start = new Date(week * 7 * dayMs);
      const key = `W${week}`;
      const label = `Week of ${start.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
      return { key, label, start };
    };

    for (const c of customers || []) {
      const created = new Date(c.created_at);
      const { key, label, start } = cohortKeyFor(created);
      let cohort = cohorts.get(key);
      if (!cohort) {
        cohort = { cohortKey: key, cohortLabel: label, cohortStart: start, cohortSize: 0, members: [] };
        cohorts.set(key, cohort);
      }
      cohort.cohortSize += 1;
      cohort.members.push(c);
    }

    const now = Date.now();
    const cohortAnalysis = Array.from(cohorts.values()).map((cohort) => {
      const ageInPeriods =
        cohortType === "monthly"
          ? Math.max(0, monthDiff(cohort.cohortStart, new Date(now)))
          : Math.floor((now - cohort.cohortStart.getTime()) / periodMs);

      const maxAge = Math.min(ageInPeriods, periodsBack - 1);
      const retentionByPeriod = [];
      let totalRevenueAcrossPeriods = 0;

      for (let age = 0; age <= maxAge; age++) {
        // Approximation: a member is "retained at age N" if they were created
        // by then AND their current subscription_status is active. See
        // dataLimitations.
        const retained = cohort.members.filter((m) => m.subscription_status === "active");
        const periodRevenue = retained.reduce((sum, m) => sum + priceFor(m.plan_id), 0);
        totalRevenueAcrossPeriods += periodRevenue;
        retentionByPeriod.push({
          period: age,
          retentionRate: cohort.cohortSize ? Math.round((retained.length / cohort.cohortSize) * 10000) / 100 : 0,
          activeCustomers: retained.length,
          revenue: Math.round(periodRevenue),
        });
      }

      return {
        cohort: cohort.cohortKey,
        cohortLabel: cohort.cohortLabel,
        cohortSize: cohort.cohortSize,
        ageInPeriods,
        retentionByPeriod,
        lifetimeValue: cohort.cohortSize ? Math.round(totalRevenueAcrossPeriods / cohort.cohortSize) : 0,
        currentRetention: retentionByPeriod[retentionByPeriod.length - 1]?.retentionRate ?? 0,
      };
    });

    cohortAnalysis.sort((a, b) => (a.cohort < b.cohort ? 1 : -1)); // most recent first

    const month1Samples = cohortAnalysis
      .map((c) => c.retentionByPeriod[1]?.retentionRate)
      .filter((v): v is number => typeof v === "number");

    res.json({
      cohortType,
      periodsAnalyzed: periodsBack,
      cohorts: cohortAnalysis,
      summary: {
        averageRetentionMonth1: month1Samples.length
          ? Math.round((month1Samples.reduce((a, b) => a + b, 0) / month1Samples.length) * 100) / 100
          : null,
        averageLifetimeValue: cohortAnalysis.length
          ? Math.round(cohortAnalysis.reduce((sum, c) => sum + c.lifetimeValue, 0) / cohortAnalysis.length)
          : 0,
      },
      dataLimitations: [
        "Retention at age N uses current subscription_status as a proxy; will be replaced once a subscription event log exists.",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Analytics] cohorts error:", err);
    res.status(500).json({ error: err.message });
  }
});

function generateChurnRecommendations(riskLevel: string, riskFactors: string[]): string[] {
  const recs: string[] = [];
  if (riskLevel === "critical") {
    recs.push("Immediate customer success intervention required");
    recs.push("Schedule executive check-in call within 24 hours");
  }
  if (riskLevel === "high" || riskLevel === "critical") {
    recs.push("Offer personalized onboarding session");
    recs.push("Consider usage-based incentives or discounts");
  }
  for (const f of riskFactors) {
    if (f.includes("Low usage") || f.includes("Below average usage")) recs.push("Provide technical setup assistance");
    if (f.includes("call success rate")) recs.push("Technical review of call configuration required");
    if (f.includes("New customer")) recs.push("Proactive onboarding outreach recommended");
  }
  if (!recs.length) recs.push("Continue monitoring, no immediate action needed");
  return [...new Set(recs)];
}

router.get("/analytics/churn-risk", requireAuth, requireStaffPermission("analytics", "read"), async (_req: any, res: any) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database unavailable" });

    const { data: customers, error } = await supabase
      .from("business_configs")
      .select("business_id, business_name, plan_id, subscription_status, industry, created_at, customer_intelligence");
    if (error) throw error;

    const active = (customers || []).filter((c) => c.subscription_status === "active");
    const businessIds = active.map((c) => c.business_id);

    // Single batched query instead of N+1.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    let recentCalls: any[] = [];
    if (businessIds.length) {
      const { data: callRows, error: callsErr } = await supabase
        .from("calls")
        .select("business_id, status, call_outcome, created_at")
        .in("business_id", businessIds)
        .gte("created_at", thirtyDaysAgo);
      if (callsErr) throw callsErr;
      recentCalls = callRows || [];
    }

    const callsByBiz = new Map<string, any[]>();
    for (const call of recentCalls) {
      const list = callsByBiz.get(call.business_id) || [];
      list.push(call);
      callsByBiz.set(call.business_id, list);
    }

    const SUCCESS_OUTCOMES = ["answered", "resolved", "appointment_booked", "booked"];
    const HIGH_RISK_INDUSTRIES = new Set(["retail", "restaurant", "general"]);

    const riskAnalysis = active.map((customer) => {
      const calls = callsByBiz.get(customer.business_id) || [];
      const callVolume = calls.length;
      const successCount = calls.filter((c) => callIs(c, SUCCESS_OUTCOMES)).length;
      const successRate = callVolume ? (successCount / callVolume) * 100 : 0;

      const daysActive = Math.floor((Date.now() - new Date(customer.created_at).getTime()) / (24 * 60 * 60 * 1000));
      const intelligence = (customer.customer_intelligence as any) || {};
      const industry = (customer.industry as string | null) || intelligence.industry || "unknown";

      let churnScore = 0;
      const riskFactors: string[] = [];

      if (callVolume < 5) {
        churnScore += 30;
        riskFactors.push(`Low usage (${callVolume} calls in 30 days)`);
      } else if (callVolume < 20) {
        churnScore += 15;
        riskFactors.push(`Below average usage (${callVolume} calls)`);
      }

      if (callVolume > 0) {
        if (successRate < 50) {
          churnScore += 25;
          riskFactors.push(`Poor call success rate (${successRate.toFixed(1)}%)`);
        } else if (successRate < 70) {
          churnScore += 10;
          riskFactors.push(`Below target call success rate (${successRate.toFixed(1)}%)`);
        }
      }

      if (daysActive < 30) {
        churnScore += 20;
        riskFactors.push("New customer (higher churn risk)");
      }

      if (industry && HIGH_RISK_INDUSTRIES.has(String(industry).toLowerCase())) {
        churnScore += 10;
        riskFactors.push(`High-churn industry (${industry})`);
      }

      if (customer.plan_id === "essential") {
        churnScore += 15;
        riskFactors.push("Essential plan (higher churn rate)");
      }

      let riskLevel: "low" | "medium" | "high" | "critical" = "low";
      if (churnScore >= 70) riskLevel = "critical";
      else if (churnScore >= 50) riskLevel = "high";
      else if (churnScore >= 30) riskLevel = "medium";

      return {
        customerId: customer.business_id,
        customerName: customer.business_name,
        plan: customer.plan_id,
        daysActive,
        churnScore: Math.min(100, churnScore),
        riskLevel,
        riskFactors,
        metrics: {
          callVolume,
          successRate: Math.round(successRate * 100) / 100,
          industry,
        },
        recommendations: generateChurnRecommendations(riskLevel, riskFactors),
      };
    });

    riskAnalysis.sort((a, b) => b.churnScore - a.churnScore);

    const riskDistribution = {
      critical: riskAnalysis.filter((c) => c.riskLevel === "critical").length,
      high: riskAnalysis.filter((c) => c.riskLevel === "high").length,
      medium: riskAnalysis.filter((c) => c.riskLevel === "medium").length,
      low: riskAnalysis.filter((c) => c.riskLevel === "low").length,
    };

    res.json({
      summary: {
        totalAnalyzed: riskAnalysis.length,
        averageChurnScore: riskAnalysis.length
          ? Math.round(riskAnalysis.reduce((sum, c) => sum + c.churnScore, 0) / riskAnalysis.length)
          : 0,
        riskDistribution,
        highRiskCustomers: riskDistribution.critical + riskDistribution.high,
      },
      customers: riskAnalysis,
      dataLimitations: [
        "Risk score weights are heuristics, not learned from historical churn outcomes.",
        "30-day call lookback uses calls.created_at; backfilled or imported calls may skew the window.",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Analytics] churn-risk error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Predictive churn scoring (heuristic ensemble)
// ---------------------------------------------------------------------------
//
// IMPORTANT: this is NOT a trained ML model. The "logisticRegression",
// "randomForest" and "gradientBoosting" functions below are hand-coded
// heuristics with the structure of those models — they let the product
// surface a calibrated-looking score and rationale without requiring a
// trained pipeline. The `_exampleModelPerformance` block returned in the
// response is illustrative only and must not be treated as validation
// metrics for these heuristics.

const PREDICTION_SUCCESS_OUTCOMES = [
  "answered",
  "resolved",
  "appointment_booked",
  "booked",
  "transferred",
];

function calculateLogisticChurnScore(f: any): number {
  const weights: Record<string, number> = {
    accountAge: -0.002,
    callVolume30d: -0.025,
    successRate30d: -1.8,
    usageTrend: -0.4,
    planTierScore: -0.15,
    avgSatisfaction: -0.3,
    industryRiskScore: 0.12,
    callConsistency: -0.8,
  };
  let logit = 0.1;
  for (const [k, w] of Object.entries(weights)) {
    logit += w * (Number(f[k]) || 0);
  }
  return Math.max(0, Math.min(1, 1 / (1 + Math.exp(-logit))));
}

function calculateRandomForestScore(f: any): number {
  const trees: Array<() => number> = [
    () => {
      if (f.callVolume30d < 5) return 0.85;
      if (f.successRate30d < 0.3) return 0.72;
      if (f.usageTrend < -0.5) return 0.58;
      return 0.15;
    },
    () => {
      if (f.callConsistency < 0.1) return 0.79;
      if (f.avgSatisfaction > 0 && f.avgSatisfaction < 2.5) return 0.68;
      if (f.daysWithCalls30d < 3) return 0.61;
      return 0.22;
    },
    () => {
      if (f.accountAge < 14) return 0.74;
      if (f.planTierScore <= 2 && f.callVolume30d < 10) return 0.66;
      if (f.industryRiskScore >= 4) return 0.52;
      return 0.18;
    },
  ];
  const preds = trees.map((t) => t());
  return preds.reduce((s, p) => s + p, 0) / preds.length;
}

function calculateGradientBoostingScore(f: any): number {
  let p = 0.35;
  if (f.callVolume30d < 3) p += 0.25;
  else if (f.callVolume30d > 50) p -= 0.15;
  if (f.successRate30d < 0.2) p += 0.22;
  else if (f.successRate30d > 0.8) p -= 0.12;
  if (f.usageTrend < -0.3) p += 0.18;
  else if (f.usageTrend > 0.3) p -= 0.08;
  if (f.planTierScore <= 1 && f.callVolume30d < 10) p += 0.15;
  if (f.accountAge < 7) p += 0.12;
  return Math.max(0, Math.min(1, p));
}

function generateMLRecommendations(prob: number, f: any, riskLevel: string): string[] {
  const recs: string[] = [];
  if (prob >= 0.8) {
    recs.push("URGENT: Executive escalation required within 24 hours");
    recs.push("Offer immediate 1-on-1 success consultation");
  } else if (prob >= 0.6) {
    recs.push("Schedule customer success intervention within 48 hours");
    recs.push("Consider retention incentives or plan adjustments");
  }
  if (f.successRate30d < 0.5 && f.callVolume30d > 5)
    recs.push("TECHNICAL: Call quality review needed — high volume but poor success rate");
  if (f.callVolume30d < 5 && f.accountAge > 14)
    recs.push("ADOPTION: Low usage despite account maturity — onboarding review needed");
  if (f.usageTrend < -0.3)
    recs.push("ENGAGEMENT: Declining usage pattern detected — proactive outreach recommended");
  if (f.callConsistency < 0.2)
    recs.push("USAGE: Inconsistent usage pattern — setup/training assistance may help");
  if (f.planTierScore <= 2 && f.callVolume30d > 20)
    recs.push("EXPANSION: High usage on low-tier plan — upgrade conversation opportunity");
  if (f.avgSatisfaction > 0 && f.avgSatisfaction < 3)
    recs.push("SATISFACTION: Poor satisfaction scores — immediate service recovery needed");
  if (f.accountAge < 30 && prob > 0.5)
    recs.push("ONBOARDING: New account at risk — enhanced onboarding program needed");
  if (!recs.length && riskLevel === "low")
    recs.push("Continue monitoring — consider expansion opportunities");
  return [...new Set(recs)].slice(0, 4);
}

const PLAN_TIER_SCORE: Record<string, number> = {
  essential: 1, starter: 2, professional: 3, growth: 4, business: 5, enterprise: 6,
};
const INDUSTRY_RISK_SCORE: Record<string, number> = {
  healthcare: 1, legal: 1, financial: 1, professional_services: 2,
  home_services: 3, retail: 4, restaurant: 5, general: 5,
};
const BUSINESS_SIZE_SCORE: Record<string, number> = { large: 1, medium: 2, small: 3, unknown: 3 };
const ACQUISITION_RISK_SCORE: Record<string, number> = {
  sales: 1, referral: 2, organic: 2, content: 2,
  social: 3, paid_ads: 4, outbound: 4, unknown: 3,
};

const VALID_MODEL_TYPES = ["ensemble", "logisticRegression", "randomForest", "gradientBoosting"] as const;
type ModelType = (typeof VALID_MODEL_TYPES)[number];

router.get("/analytics/churn-prediction", requireAuth, requireStaffPermission("analytics", "read"), async (req: any, res: any) => {
  try {
    const modelType = String(req.query.modelType || "ensemble") as ModelType;
    if (!VALID_MODEL_TYPES.includes(modelType)) {
      return res.status(400).json({
        error: `Invalid modelType. Must be one of: ${VALID_MODEL_TYPES.join(", ")}`,
      });
    }
    const includeFeatures = String(req.query.includeFeatures || "false") === "true";
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database unavailable" });

    const { data: customers, error: cErr } = await supabase
      .from("business_configs")
      .select("business_id, business_name, plan_id, subscription_status, industry, created_at, updated_at, customer_intelligence");
    if (cErr) throw cErr;

    const customerIds = (customers || []).map((c) => c.business_id);
    let allCalls: any[] = [];
    if (customerIds.length) {
      const { data: callRows, error: callsErr } = await supabase
        .from("calls")
        .select("business_id, status, call_outcome, created_at, duration_seconds, satisfaction_rating")
        .in("business_id", customerIds);
      if (callsErr) throw callsErr;
      allCalls = callRows || [];
    }

    // Bucket calls per customer once.
    const callsByBiz = new Map<string, any[]>();
    for (const call of allCalls) {
      const list = callsByBiz.get(call.business_id) || [];
      list.push(call);
      callsByBiz.set(call.business_id, list);
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    const customerFeatures = (customers || [])
      .filter((c) => c.subscription_status !== "cancelled" && c.subscription_status !== "canceled")
      .map((customer) => {
        const calls = callsByBiz.get(customer.business_id) || [];
        const intelligence = (customer.customer_intelligence as any) || {};
        const industry =
          (customer.industry as string | null) || intelligence.industry || "unknown";

        const accountAge = Math.floor((now - new Date(customer.created_at).getTime()) / DAY);
        const daysSinceLastUpdate = Math.floor(
          (now - new Date(customer.updated_at).getTime()) / DAY,
        );

        const within = (days: number) =>
          calls.filter((c) => now - new Date(c.created_at).getTime() <= days * DAY);
        const calls7d = within(7);
        const calls30d = within(30);
        const calls90d = within(90);

        const success7d = calls7d.filter((c) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length;
        const success30d = calls30d.filter((c) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length;
        const success90d = calls90d.filter((c) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length;

        const successRate7d = calls7d.length ? success7d / calls7d.length : 0;
        const successRate30d = calls30d.length ? success30d / calls30d.length : 0;
        const successRate90d = calls90d.length ? success90d / calls90d.length : 0;

        const callsPerWeekRecent = calls30d.length / 4.3;
        const callsPerWeekHistorical = Math.max(calls90d.length / 12.9, 0.1);
        const usageTrend = (callsPerWeekRecent - callsPerWeekHistorical) / callsPerWeekHistorical;

        const avgCallDuration = calls.length
          ? calls.reduce((s, c) => s + (Number(c.duration_seconds) || 0), 0) / calls.length
          : 0;

        const satScores = calls
          .map((c) => Number(c.satisfaction_rating))
          .filter((n) => Number.isFinite(n) && n > 0);
        const avgSatisfaction = satScores.length
          ? satScores.reduce((s, n) => s + n, 0) / satScores.length
          : 0;

        const distinctDays30d = new Set(
          calls30d.map((c) => String(c.created_at).split("T")[0]),
        ).size;

        const planTierScore = PLAN_TIER_SCORE[String(customer.plan_id || "").toLowerCase()] || 1;
        const industryRiskScore = INDUSTRY_RISK_SCORE[String(industry).toLowerCase()] || 3;
        const businessSizeScore =
          BUSINESS_SIZE_SCORE[String(intelligence.business?.size || "unknown").toLowerCase()] || 3;
        const acquisitionRiskScore =
          ACQUISITION_RISK_SCORE[String(intelligence.acquisition?.source || "unknown").toLowerCase()] || 3;

        const features = {
          accountAge,
          daysSinceLastUpdate,
          planTierScore,
          industryRiskScore,
          businessSizeScore,
          acquisitionRiskScore,
          callVolume7d: calls7d.length,
          callVolume30d: calls30d.length,
          callVolume90d: calls90d.length,
          callsPerWeekTrend: usageTrend,
          usageTrend,
          successRate7d,
          successRate30d,
          successRate90d,
          avgCallDuration,
          avgSatisfaction,
          daysWithCalls30d: distinctDays30d,
          callConsistency: calls30d.length ? distinctDays30d / 30 : 0,
        };

        const predictions = {
          logisticRegression: calculateLogisticChurnScore(features),
          randomForest: calculateRandomForestScore(features),
          gradientBoosting: calculateGradientBoostingScore(features),
        };

        const ensembleScore =
          Math.round(
            (predictions.logisticRegression * 0.3 +
              predictions.randomForest * 0.4 +
              predictions.gradientBoosting * 0.3) *
              10000,
          ) / 10000;

        const selected = modelType === "ensemble" ? ensembleScore : predictions[modelType];

        let riskLevel: "low" | "medium" | "high" | "critical" = "low";
        if (selected >= 0.8) riskLevel = "critical";
        else if (selected >= 0.6) riskLevel = "high";
        else if (selected >= 0.4) riskLevel = "medium";

        return {
          customerId: customer.business_id,
          customerName: customer.business_name,
          plan: customer.plan_id,
          churnProbability: Math.round(selected * 10000) / 10000,
          riskLevel,
          features: includeFeatures ? features : undefined,
          modelPredictions: {
            logisticRegression: Math.round(predictions.logisticRegression * 10000) / 10000,
            randomForest: Math.round(predictions.randomForest * 10000) / 10000,
            gradientBoosting: Math.round(predictions.gradientBoosting * 10000) / 10000,
            ensemble: ensembleScore,
          },
          lastUpdated: new Date().toISOString(),
          recommendations: generateMLRecommendations(selected, features, riskLevel),
        };
      });

    customerFeatures.sort((a, b) => b.churnProbability - a.churnProbability);

    const riskDistribution = {
      critical: customerFeatures.filter((c) => c.riskLevel === "critical").length,
      high: customerFeatures.filter((c) => c.riskLevel === "high").length,
      medium: customerFeatures.filter((c) => c.riskLevel === "medium").length,
      low: customerFeatures.filter((c) => c.riskLevel === "low").length,
    };

    const avgProb = customerFeatures.length
      ? customerFeatures.reduce((s, c) => s + c.churnProbability, 0) / customerFeatures.length
      : 0;

    res.json({
      modelType,
      customersAnalyzed: customerFeatures.length,
      predictions: customerFeatures,
      summary: {
        averageChurnProbability: Math.round(avgProb * 10000) / 10000,
        riskDistribution,
        highRiskCustomers: customerFeatures.filter((c) =>
          ["critical", "high"].includes(c.riskLevel),
        ),
      },
      _exampleModelPerformance: {
        _note:
          "ILLUSTRATIVE ONLY — not derived from validation. The scoring functions are hand-coded heuristics, not trained models. Replace once a real model + holdout set exist.",
        accuracy: 0.847,
        precision: 0.793,
        recall: 0.712,
        f1Score: 0.751,
        auc: 0.886,
        featureImportance: {
          successRate30d: 0.24,
          callVolume30d: 0.19,
          usageTrend: 0.15,
          accountAge: 0.12,
          planTierScore: 0.1,
          avgSatisfaction: 0.08,
          industryRiskScore: 0.07,
          callConsistency: 0.05,
        },
      },
      dataLimitations: [
        "Scoring functions are heuristics shaped like ML models, not trained models. Treat probabilities as ordinal risk ranking, not calibrated likelihoods.",
        "Success classification uses callIs() against status + call_outcome columns.",
        "Customers with subscription_status of cancelled/canceled are excluded from scoring.",
      ],
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Analytics] churn-prediction error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /system/health-check — quick connectivity probe across the data
// surfaces the dashboards depend on. Each check uses a HEAD count instead of
// .single() (the spec used .single() on a count which throws on multi-row /
// empty results) and degrades gracefully so an empty table doesn't fail the
// probe.
// ---------------------------------------------------------------------------
router.get(
  "/system/health-check",
  requireAuth,
  requireStaffPermission("monitoring", "read"),
  async (_req: any, res: any) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({
          status: "critical",
          error: "Database client unavailable",
          timestamp: new Date().toISOString(),
        });
      }

      const probe = async (
        table: string,
        opts?: { requireRows?: boolean; filter?: (q: any) => any },
      ): Promise<{ ok: boolean; rowCount: number | null; error?: string }> => {
        try {
          let q: any = supabase.from(table).select("*", { count: "exact", head: true });
          if (opts?.filter) q = opts.filter(q);
          const { error, count } = await q;
          if (error) return { ok: false, rowCount: null, error: error.message };
          if (opts?.requireRows && (count || 0) === 0) {
            return { ok: false, rowCount: 0, error: "table reachable but empty" };
          }
          return { ok: true, rowCount: count ?? 0 };
        } catch (e: any) {
          return { ok: false, rowCount: null, error: e.message };
        }
      };

      const [database, customers, calls, tickets, intelligence] = await Promise.all([
        probe("business_configs"),
        probe("business_configs", { requireRows: true }),
        probe("calls"),
        probe("support_tickets"),
        probe("business_configs", {
          requireRows: true,
          filter: (q) => q.not("customer_intelligence", "is", null),
        }),
      ]);

      const checks = {
        database: { ok: database.ok, rowCount: database.rowCount, error: database.error },
        customers: { ok: customers.ok, rowCount: customers.rowCount, error: customers.error },
        calls: { ok: calls.ok, rowCount: calls.rowCount, error: calls.error },
        tickets: { ok: tickets.ok, rowCount: tickets.rowCount, error: tickets.error },
        intelligence: {
          ok: intelligence.ok,
          rowCount: intelligence.rowCount,
          error: intelligence.error,
        },
      };

      const okCount = Object.values(checks).filter((c) => c.ok).length;
      const overallHealth = okCount / Object.keys(checks).length;
      const status =
        overallHealth >= 0.8 ? "healthy" : overallHealth >= 0.6 ? "degraded" : "critical";

      res.json({
        status,
        overallHealth: Math.round(overallHealth * 100),
        checks,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Health] /system/health-check error:", err);
      res.status(500).json({
        status: "critical",
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Intelligent customer-success automation
// ---------------------------------------------------------------------------
//
// Three endpoints:
//   POST /automation/intelligent-workflows  → evaluate (read-only)
//   POST /automation/execute-intelligent    → execute proposed workflows
//                                             (honours dryRun)
//   GET  /automation/intelligent-dashboard  → effectiveness analytics
//
// We deliberately call the churn-prediction logic in-process via a helper
// instead of round-tripping through HTTP — avoids re-auth, proxy header
// fragility, and double-counting of audit events.

const INTELLIGENT_TICKET_CHANNEL = "intelligent_automation";

const WORKFLOW_TYPE_TO_REVENUE_BUCKET: Record<string, "expansion" | "retention" | "recovery"> = {
  expansion_opportunity: "expansion",
  predictive_intervention: "retention",
  usage_acceleration: "retention",
  payment_recovery: "recovery",
};

const WORKFLOW_REVENUE_BENCHMARK: Record<"expansion" | "retention" | "recovery", number> = {
  expansion: 400,
  retention: 750,
  recovery: 300,
};

const EXPANSION_DELTA_BY_PLAN: Record<string, number> = {
  essential: 600,
  starter: 350,
  professional: 250,
};

// Heuristic mid-point used as a fallback when the churn predictor itself
// returns nothing for a customer (e.g. cancelled accounts excluded upstream).
const FALLBACK_CHURN = { probability: 0.3, riskLevel: "unknown" as const };

async function computeChurnRiskMap(
  supabase: any,
): Promise<Record<string, { probability: number; riskLevel: string }>> {
  const map: Record<string, { probability: number; riskLevel: string }> = {};
  try {
    const { data: customers } = await supabase
      .from("business_configs")
      .select("business_id, plan_id, subscription_status, industry, created_at, updated_at, customer_intelligence");
    const ids = (customers || []).map((c: any) => c.business_id);
    if (!ids.length) return map;

    const { data: callRows } = await supabase
      .from("calls")
      .select("business_id, status, call_outcome, created_at, duration_seconds, satisfaction_rating")
      .in("business_id", ids);

    const callsByBiz = new Map<string, any[]>();
    for (const c of callRows || []) {
      const list = callsByBiz.get(c.business_id) || [];
      list.push(c);
      callsByBiz.set(c.business_id, list);
    }

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    for (const customer of customers || []) {
      if (["cancelled", "canceled"].includes(String(customer.subscription_status))) continue;
      const calls = callsByBiz.get(customer.business_id) || [];
      const intel = customer.customer_intelligence || {};
      const within = (days: number) =>
        calls.filter((c) => now - new Date(c.created_at).getTime() <= days * DAY);
      const c30 = within(30);
      const c90 = within(90);
      const success30 = c30.filter((c) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length;
      const successRate30d = c30.length ? success30 / c30.length : 0;
      const callsPerWeekRecent = c30.length / 4.3;
      const callsPerWeekHistorical = Math.max(c90.length / 12.9, 0.1);
      const usageTrend = (callsPerWeekRecent - callsPerWeekHistorical) / callsPerWeekHistorical;
      const distinctDays30d = new Set(c30.map((c) => String(c.created_at).split("T")[0])).size;
      const satScores = calls
        .map((c) => Number(c.satisfaction_rating))
        .filter((n) => Number.isFinite(n) && n > 0);
      const features = {
        accountAge: Math.floor((now - new Date(customer.created_at).getTime()) / DAY),
        callVolume30d: c30.length,
        successRate30d,
        usageTrend,
        planTierScore: PLAN_TIER_SCORE[String(customer.plan_id || "").toLowerCase()] || 1,
        avgSatisfaction: satScores.length ? satScores.reduce((s, n) => s + n, 0) / satScores.length : 0,
        industryRiskScore:
          INDUSTRY_RISK_SCORE[String(customer.industry || intel.industry || "").toLowerCase()] || 3,
        callConsistency: c30.length ? distinctDays30d / 30 : 0,
        daysWithCalls30d: distinctDays30d,
      };
      const probability =
        Math.round(
          (calculateLogisticChurnScore(features) * 0.3 +
            calculateRandomForestScore(features) * 0.4 +
            calculateGradientBoostingScore(features) * 0.3) *
            10000,
        ) / 10000;
      let riskLevel: "low" | "medium" | "high" | "critical" = "low";
      if (probability >= 0.8) riskLevel = "critical";
      else if (probability >= 0.6) riskLevel = "high";
      else if (probability >= 0.4) riskLevel = "medium";
      map[customer.business_id] = { probability, riskLevel };
    }
  } catch (err) {
    console.warn("[Automation] computeChurnRiskMap failed:", (err as Error).message);
  }
  return map;
}

router.post(
  "/automation/intelligent-workflows",
  requireAuth,
  requireStaffPermission("automation", "write"),
  async (req: any, res: any) => {
    try {
      const { dryRun = false } = req.body || {};
      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database unavailable" });

      const { data: customers, error } = await supabase
        .from("business_configs")
        .select(
          "business_id, business_name, plan_id, subscription_status, created_at, customer_intelligence",
        );
      if (error) throw error;

      // System-health gate — if we just had a global incident in the last
      // hour, suppress predictive interventions (avoid spamming churn tickets
      // when the platform itself is the cause).
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data: systemCalls } = await supabase
        .from("calls")
        .select("status, call_outcome")
        .gte("created_at", oneHourAgo);
      const sampleSize = systemCalls?.length || 0;
      const systemHealthy =
        sampleSize === 0 ||
        systemCalls!.filter((c: any) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length / sampleSize >
          0.7;

      const churnPredictions = await computeChurnRiskMap(supabase);

      // Batched per-customer call rollups (replaces N+1 in the spec).
      const customerIds = (customers || []).map((c) => c.business_id);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      let callsAll: any[] = [];
      if (customerIds.length) {
        const { data: callRows, error: callsErr } = await supabase
          .from("calls")
          .select("business_id, status, call_outcome, created_at, duration_seconds")
          .in("business_id", customerIds)
          .gte("created_at", thirtyDaysAgo);
        if (callsErr) throw callsErr;
        callsAll = callRows || [];
      }
      const month = new Map<string, any[]>();
      const week = new Map<string, any[]>();
      for (const c of callsAll) {
        const m = month.get(c.business_id) || [];
        m.push(c);
        month.set(c.business_id, m);
        if (c.created_at >= sevenDaysAgo) {
          const w = week.get(c.business_id) || [];
          w.push(c);
          week.set(c.business_id, w);
        }
      }

      const triggeredWorkflows: any[] = [];

      for (const customer of customers || []) {
        const customerId = customer.business_id;
        const churn = churnPredictions[customerId] || FALLBACK_CHURN;
        const intelligence: any = customer.customer_intelligence || {};
        const monthCalls = month.get(customerId) || [];
        const recentCalls = week.get(customerId) || [];
        const monthCallCount = monthCalls.length;
        const recentCallCount = recentCalls.length;
        const successRate = monthCallCount
          ? (monthCalls.filter((c) => callIs(c, PREDICTION_SUCCESS_OUTCOMES)).length /
              monthCallCount) *
            100
          : 0;
        const daysActive = Math.floor(
          (Date.now() - new Date(customer.created_at).getTime()) / (24 * 60 * 60 * 1000),
        );
        const planId = String(customer.plan_id || "").toLowerCase();

        // Workflow 1 — Expansion opportunity
        if (
          customer.subscription_status === "active" &&
          monthCallCount > 100 &&
          ["essential", "starter", "professional"].includes(planId) &&
          successRate > 70 &&
          churn.probability < 0.3
        ) {
          const potentialRevenue = EXPANSION_DELTA_BY_PLAN[planId] || 0;
          triggeredWorkflows.push({
            type: "expansion_opportunity",
            customerId,
            customerName: customer.business_name,
            priority: "high",
            churnRisk: churn.probability,
            trigger: {
              condition: "High usage on lower-tier plan with strong performance",
              monthlyUsage: monthCallCount,
              currentPlan: planId,
              successRate,
              churnProbability: churn.probability,
            },
            action: {
              createTicket: true,
              ticketData: {
                title: `Expansion Opportunity — ${customer.business_name}`,
                description: `Customer running ${monthCallCount} calls/mo at ${successRate.toFixed(1)}% success on ${planId}. Estimated upgrade lift: +$${potentialRevenue}/mo.`,
                priority: "high",
                category: "general",
                assignedTo: "Sales Team",
                tags: ["expansion", "high-usage", "upsell"],
              },
              sendEmail: true,
              emailTemplate: "expansion_opportunity",
              emailData: {
                currentPlan: planId,
                usage: monthCallCount,
                successRate: successRate.toFixed(1),
                potentialRevenue,
              },
            },
            expectedRevenue: potentialRevenue,
            confidence: 0.85,
          });
        }

        // Workflow 2 — Predictive intervention (only when system is healthy)
        if (
          customer.subscription_status === "active" &&
          churn.probability > 0.6 &&
          systemHealthy
        ) {
          const urgency = churn.probability > 0.8 ? "critical" : "high";
          const timeframe = churn.probability > 0.8 ? "24 hours" : "48 hours";
          triggeredWorkflows.push({
            type: "predictive_intervention",
            customerId,
            customerName: customer.business_name,
            priority: urgency,
            churnRisk: churn.probability,
            trigger: {
              condition: "Churn model predicts elevated risk",
              churnProbability: churn.probability,
              riskLevel: churn.riskLevel,
              mlModel: "ensemble",
            },
            action: {
              createTicket: true,
              ticketData: {
                title: `CHURN RISK: Predictive Intervention — ${customer.business_name}`,
                description: `Ensemble churn score ${(churn.probability * 100).toFixed(1)}%. CS intervention required within ${timeframe}.`,
                priority: urgency,
                category: "general",
                assignedTo: "Customer Success Team",
                tags: ["churn-risk", "ml-prediction", "intervention"],
              },
              escalate: churn.probability > 0.8,
              sendEmail: true,
              emailTemplate: "retention_intervention",
            },
            mlPrediction: {
              probability: churn.probability,
              model: "ensemble",
              note: "Heuristic ensemble — see /analytics/churn-prediction dataLimitations",
            },
          });
        }

        // Workflow 3 — Usage acceleration
        if (
          customer.subscription_status === "active" &&
          daysActive > 14 &&
          daysActive < 90 &&
          monthCallCount < 20 &&
          churn.probability > 0.4
        ) {
          triggeredWorkflows.push({
            type: "usage_acceleration",
            customerId,
            customerName: customer.business_name,
            priority: "medium",
            churnRisk: churn.probability,
            trigger: {
              condition: "Established account with low usage and rising churn risk",
              daysActive,
              monthlyUsage: monthCallCount,
              churnProbability: churn.probability,
            },
            action: {
              createTicket: true,
              ticketData: {
                title: `Usage Acceleration — ${customer.business_name}`,
                description: `Account ${daysActive}d old with only ${monthCallCount} calls/mo and ${(churn.probability * 100).toFixed(1)}% churn risk. Recommend acceleration program.`,
                priority: "medium",
                category: "onboarding",
                assignedTo: "Customer Success Team",
                tags: ["low-usage", "acceleration", "onboarding"],
              },
              sendEmail: true,
              emailTemplate: "usage_acceleration",
              emailData: { daysActive, currentUsage: monthCallCount, industryBenchmark: 50 },
            },
            program: "usage_acceleration",
            targetUsage: 50,
          });
        }

        // Workflow 4 — Success story
        if (
          customer.subscription_status === "active" &&
          monthCallCount > 200 &&
          successRate > 85 &&
          daysActive > 90 &&
          churn.probability < 0.2
        ) {
          triggeredWorkflows.push({
            type: "success_story",
            customerId,
            customerName: customer.business_name,
            priority: "low",
            churnRisk: churn.probability,
            trigger: {
              condition: "High-performing long-tenured customer",
              monthlyUsage: monthCallCount,
              successRate,
              daysActive,
              churnProbability: churn.probability,
            },
            action: {
              createTicket: true,
              ticketData: {
                title: `Success Story Candidate — ${customer.business_name}`,
                description: `${monthCallCount} calls/mo @ ${successRate.toFixed(1)}% success, ${daysActive}d tenure. Consider for case study.`,
                priority: "low",
                category: "general",
                assignedTo: "Marketing Team",
                tags: ["success-story", "case-study", "testimonial"],
              },
            },
            marketingValue: "high",
            referralPotential: intelligence.acquisition?.source === "referral" ? "high" : "medium",
          });
        }

        // Workflow 5 — Payment recovery
        if (
          customer.subscription_status === "past_due" &&
          monthCallCount > 10 &&
          churn.probability < 0.7
        ) {
          triggeredWorkflows.push({
            type: "payment_recovery",
            customerId,
            customerName: customer.business_name,
            priority: "high",
            churnRisk: churn.probability,
            trigger: {
              condition: "Past-due account with active usage",
              paymentStatus: customer.subscription_status,
              recentUsage: monthCallCount,
              churnProbability: churn.probability,
            },
            action: {
              createTicket: true,
              ticketData: {
                title: `Payment Recovery — ${customer.business_name}`,
                description: `Past-due but actively using (${monthCallCount} calls/mo). Prioritise billing assistance.`,
                priority: "high",
                category: "billing",
                assignedTo: "Billing Support Team",
                tags: ["payment-recovery", "active-user", "billing"],
              },
              sendEmail: true,
              emailTemplate: "payment_assistance",
            },
            recoveryProbability: 0.78,
          });
        }
      }

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "admin.automation.intelligent.workflows.evaluated",
        resource: "automation",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          customersEvaluated: customers?.length || 0,
          workflowsTriggered: triggeredWorkflows.length,
          systemHealthy,
          systemHealthSampleSize: sampleSize,
          churnPredictionsAvailable: Object.keys(churnPredictions).length,
          dryRun,
          adminUser: req.userEmail,
        },
        complianceFlags: ["ADMIN-ACTION", "INTELLIGENT-AUTOMATION"],
      });

      res.json({
        success: true,
        systemHealthy,
        systemHealthSampleSize: sampleSize,
        customersEvaluated: customers?.length || 0,
        workflowsTriggered: triggeredWorkflows.length,
        workflows: triggeredWorkflows,
        summary: {
          expansionOpportunities: triggeredWorkflows.filter((w) => w.type === "expansion_opportunity").length,
          churnInterventions: triggeredWorkflows.filter((w) => w.type === "predictive_intervention").length,
          usageAcceleration: triggeredWorkflows.filter((w) => w.type === "usage_acceleration").length,
          successStories: triggeredWorkflows.filter((w) => w.type === "success_story").length,
          paymentRecovery: triggeredWorkflows.filter((w) => w.type === "payment_recovery").length,
          projectedRevenue: triggeredWorkflows
            .filter((w) => w.expectedRevenue)
            .reduce((sum, w) => sum + w.expectedRevenue, 0),
        },
        dryRun,
        dataLimitations: [
          "Evaluation is read-only; dryRun is informational here. The execute endpoint is the only writer.",
          "Churn signal comes from the heuristic ensemble in /analytics/churn-prediction (not a trained model).",
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Automation] intelligent-workflows error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/automation/execute-intelligent",
  requireAuth,
  requireStaffPermission("automation", "write"),
  async (req: any, res: any) => {
    try {
      const { workflows, dryRun = false } = req.body || {};
      if (!workflows || !Array.isArray(workflows)) {
        return res.status(400).json({ error: "workflows array is required" });
      }
      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database unavailable" });

      const knownTemplates = new Set(Object.keys(emailTemplates));
      const executionResults: any[] = [];

      for (const workflow of workflows) {
        const result: any = {
          workflowId: `${workflow.type}_${workflow.customerId}`,
          type: workflow.type,
          customerId: workflow.customerId,
          customerName: workflow.customerName,
          executed: false,
          actions: [],
          revenue: workflow.expectedRevenue || 0,
        };

        try {
          // Idempotency — skip if an open intelligent ticket of the same
          // workflow type already exists for this customer in the last 7 days.
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: existing, error: dupErr } = await supabase
            .from("support_tickets")
            .select("id, created_at")
            .eq("customer_id", workflow.customerId)
            .eq("created_by", INTELLIGENT_TICKET_CHANNEL)
            .in("status", ["open", "in_progress"])
            .contains("tags", [workflow.type])
            .gte("created_at", sevenDaysAgo)
            .limit(1);
          if (dupErr) throw dupErr;

          if (existing && existing.length > 0) {
            result.actions.push({
              type: "ticket_skipped",
              success: true,
              reason: "duplicate_open_ticket_within_7d",
              existingTicketId: existing[0].id,
              dryRun,
            });
          } else if (workflow.action?.createTicket) {
            const td = workflow.action.ticketData || {};
            const ticketId = `ticket_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
            // DB CHECK constraint allows only low|medium|high|urgent. Map any
            // upstream "critical" to "urgent" so high-churn workflows insert.
            const PRIORITY_ALIAS: Record<string, string> = { critical: "urgent" };
            const rawPriority = String(td.priority || "medium").toLowerCase();
            const priority = PRIORITY_ALIAS[rawPriority] || rawPriority;
            if (!dryRun) {
              const { error: ticketError } = await supabase.from("support_tickets").insert({
                id: ticketId,
                customer_id: workflow.customerId,
                customer_business_name: workflow.customerName,
                title: td.title,
                description: td.description,
                priority,
                category: td.category || "general",
                status: "open",
                assigned_to: td.assignedTo || null,
                created_by: INTELLIGENT_TICKET_CHANNEL,
                tags: Array.from(new Set([...(td.tags || []), workflow.type])),
              });
              if (ticketError) throw ticketError;
            }
            result.actions.push({
              type: "intelligent_ticket_created",
              success: true,
              ticketId,
              workflowType: workflow.type,
              priority: td.priority,
              assignedTo: td.assignedTo,
              churnRisk: workflow.churnRisk,
              dryRun,
            });
          }

          if (workflow.action?.sendEmail) {
            const tmpl = workflow.action.emailTemplate;
            if (!tmpl || !knownTemplates.has(tmpl)) {
              result.actions.push({
                type: "email_skipped",
                success: true,
                emailTemplate: tmpl || null,
                reason: "template_not_registered",
                hint: `Add '${tmpl}' to emailTemplates registry to enable real sending.`,
                dryRun,
              });
            } else {
              // Real sends happen via /emails/send; we note the intent here so
              // the execution log stays honest about what was/wasn't dispatched.
              result.actions.push({
                type: "email_queued",
                success: true,
                emailTemplate: tmpl,
                note: "Template is registered; trigger via POST /emails/send when ready.",
                dryRun,
              });
            }
          }

          if (workflow.action?.escalate && workflow.churnRisk > 0.8) {
            result.actions.push({
              type: "executive_escalated",
              success: true,
              escalatedTo: "executive_team",
              churnRisk: workflow.churnRisk,
              urgency: "critical",
              dryRun,
            });
          }

          result.executed = !dryRun;
        } catch (workflowError: any) {
          result.error = workflowError.message;
          result.executed = false;
        }

        executionResults.push(result);
      }

      const successful = executionResults.filter((r) => r.executed).length;
      const totalProjectedRevenue = executionResults
        .filter((r) => r.executed && r.revenue > 0)
        .reduce((sum, r) => sum + r.revenue, 0);

      if (!dryRun) {
        const meta = extractRequestMeta(req);
        await auditLog({
          userId: req.userId!,
          businessId: req.businessId!,
          action: "admin.automation.intelligent.workflows.executed",
          resource: "automation",
          success: successful > 0,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          sessionId: req.sessionId,
          details: {
            workflowsExecuted: successful,
            totalProjectedRevenue,
            workflowTypes: workflows.map((w: any) => w.type),
            adminUser: req.userEmail,
          },
          complianceFlags: ["ADMIN-ACTION", "INTELLIGENT-AUTOMATION", "REVENUE-IMPACT"],
        });
      }

      res.json({
        success: true,
        dryRun,
        workflowsProcessed: workflows.length,
        executionResults,
        summary: {
          successful,
          failed: executionResults.length - successful,
          ticketsCreated: executionResults.reduce(
            (count, r) =>
              count + r.actions.filter((a: any) => a.type === "intelligent_ticket_created").length,
            0,
          ),
          emailsQueued: executionResults.reduce(
            (count, r) => count + r.actions.filter((a: any) => a.type === "email_queued").length,
            0,
          ),
          emailsSkipped: executionResults.reduce(
            (count, r) => count + r.actions.filter((a: any) => a.type === "email_skipped").length,
            0,
          ),
          escalationsCreated: executionResults.reduce(
            (count, r) =>
              count + r.actions.filter((a: any) => a.type === "executive_escalated").length,
            0,
          ),
          projectedRevenueImpact: totalProjectedRevenue,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Automation] execute-intelligent error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.get(
  "/automation/intelligent-dashboard",
  requireAuth,
  requireStaffPermission("automation", "read"),
  async (_req: any, res: any) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database unavailable" });

      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data: tickets, error } = await supabase
        .from("support_tickets")
        .select("*")
        .eq("created_by", INTELLIGENT_TICKET_CHANNEL)
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: false });
      if (error) throw error;

      const workflowsByType: Record<string, { count: number; resolved: number }> = {};
      const revenueImpact = { expansion: 0, retention: 0, recovery: 0 };
      const knownWorkflowTypes = Object.keys(WORKFLOW_TYPE_TO_REVENUE_BUCKET).concat([
        "success_story",
      ]);

      for (const t of tickets || []) {
        const tags: string[] = Array.isArray(t.tags) ? t.tags : [];
        const wfType = tags.find((tag) => knownWorkflowTypes.includes(tag)) || "unknown";
        if (!workflowsByType[wfType]) workflowsByType[wfType] = { count: 0, resolved: 0 };
        workflowsByType[wfType].count++;
        if (["resolved", "closed"].includes(t.status)) {
          workflowsByType[wfType].resolved++;
          const bucket = WORKFLOW_TYPE_TO_REVENUE_BUCKET[wfType];
          if (bucket) revenueImpact[bucket] += WORKFLOW_REVENUE_BENCHMARK[bucket];
        }
      }

      const automationEffectiveness = Object.entries(workflowsByType).map(([type, data]) => {
        const bucket = WORKFLOW_TYPE_TO_REVENUE_BUCKET[type];
        return {
          workflowType: type,
          totalTriggered: data.count,
          resolved: data.resolved,
          effectivenessRate: data.count > 0 ? (data.resolved / data.count) * 100 : 0,
          averageValue: bucket ? WORKFLOW_REVENUE_BENCHMARK[bucket] : 0,
        };
      });

      res.json({
        summary: {
          totalIntelligentTickets: tickets?.length || 0,
          activeIntelligentTickets:
            tickets?.filter((t) => ["open", "in_progress"].includes(t.status)).length || 0,
          resolvedIntelligentTickets:
            tickets?.filter((t) => ["resolved", "closed"].includes(t.status)).length || 0,
          projectedRevenueImpact: revenueImpact.expansion + revenueImpact.retention + revenueImpact.recovery,
        },
        analytics: { workflowsByType, revenueImpact, automationEffectiveness },
        recentActivity: (tickets || []).slice(0, 10).map((t) => {
          const tags: string[] = Array.isArray(t.tags) ? t.tags : [];
          const wfType = tags.find((tag) => knownWorkflowTypes.includes(tag)) || "unknown";
          const bucket = WORKFLOW_TYPE_TO_REVENUE_BUCKET[wfType];
          return {
            id: t.id,
            workflowType: wfType,
            customerName: t.customer_business_name,
            title: t.title,
            priority: t.priority,
            status: t.status,
            createdAt: t.created_at,
            projectedValue: bucket ? WORKFLOW_REVENUE_BENCHMARK[bucket] : 0,
          };
        }),
        dataLimitations: [
          "Revenue impact uses fixed per-bucket benchmarks (expansion=$400, retention=$750, recovery=$300) — not per-customer measured ARR.",
          "Resolution counts depend on tickets being moved to resolved/closed in support_tickets.",
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Automation] intelligent-dashboard error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ===========================================================================
// Staff user management & RBAC
// ---------------------------------------------------------------------------
// Gate: `requireStaffOrBootstrap`. Day-zero (no super_admin in user_roles),
// only authenticated tenant `owner`s pass — this is the seat-the-first-admin
// window. Once any super_admin exists, the bootstrap path closes and only
// staff with `users.<action>` permission may invite/list/modify staff.
// ===========================================================================

// POST /api/admin/users/invite -----------------------------------------------
router.post(
  "/users/invite",
  requireAuth,
  requireStaffOrBootstrap("write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const { email, role, permissions = {}, organizationId } = (req.body || {}) as {
        email?: string;
        role?: string;
        permissions?: Record<string, unknown>;
        organizationId?: string | null;
      };

      if (!email || typeof email !== "string" || !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      if (!role || !(VALID_STAFF_ROLES as readonly string[]).includes(role)) {
        return res.status(400).json({
          error: "Invalid role specified",
          validRoles: VALID_STAFF_ROLES,
        });
      }

      // Privilege guard: only super_admin (or tenant-owner during the
      // pre-bootstrap window) may grant super_admin. Stops a regular admin
      // from minting a peer.
      const callerStaffRole = await lookupStaffRole(req.userId, req.userEmail);
      const bootstrapOpen = !(await superAdminExists());
      if (!canGrantRole(callerStaffRole, req.userRole, role as StaffRole, bootstrapOpen)) {
        await auditLog({
          userId: req.userId,
          businessId: req.businessId,
          action: "admin.users.invite.denied",
          resource: "users",
          success: false,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: {
            reason: "role_grant_not_permitted",
            requestedRole: role,
            callerStaffRole,
          },
        });
        return res.status(403).json({
          error: `You may not grant role '${role}'`,
          callerStaffRole,
        });
      }

      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      const { data: existingUser } = await supabase
        .from("user_roles")
        .select("id, email, status")
        .ilike("email", email)
        .maybeSingle();

      if (existingUser) {
        return res.status(409).json({
          error: "User already exists",
          existingUser: { email: existingUser.email, status: existingUser.status },
        });
      }

      const userId = secureToken("user", 12);
      const inviteToken = secureToken("invite", 24);
      const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      // Default role permissions, overlaid with caller-supplied per-resource
      // grants. Invite metadata lives under `_invite` so it can never collide
      // with a resource permission key and the perm merger can skip it cleanly.
      const finalPermissions = {
        ...getDefaultStaffPermissions(role),
        ...permissions,
        _invite: { token: inviteToken, expiresAt: inviteExpiry },
      };

      const { data: newUser, error } = await supabase
        .from("user_roles")
        .insert({
          id: userId,
          user_id: userId,
          email,
          role,
          organization_id: organizationId || null,
          permissions: finalPermissions,
          created_by: req.userId,
          status: "inactive",
        })
        .select()
        .single();

      if (error) {
        // Race condition between the maybeSingle() check above and the insert
        // is prevented at the DB level by the case-insensitive unique index
        // on user_roles(LOWER(email)). Surface that as a clean 409 instead of
        // a generic 500 if a concurrent insert won the race.
        const code = (error as any).code || "";
        const msg = (error.message || "").toLowerCase();
        if (code === "23505" || msg.includes("duplicate key") || msg.includes("user_roles_email_uniq")) {
          return res.status(409).json({
            error: "User already exists",
            existingUser: { email, status: "unknown" },
          });
        }
        throw error;
      }

      // Deliver the invite via SendGrid. The token is ALSO returned in the
      // response so the inviter can fall back to manual delivery if email
      // fails (e.g. recipient bounces, SendGrid outage, sandbox without
      // connector). Email failure must NOT fail the invitation itself —
      // the row is already persisted and the inviter has the token.
      const inviterEmail = req.userEmail || "team@neverr.ai";
      const emailResult = await sendInvitationEmail({
        recipientEmail: email,
        inviteeName: email.split("@")[0],
        inviterName: inviterEmail.split("@")[0],
        inviterEmail,
        role,
        permissions: finalPermissions as Record<string, string[] | string>,
        inviteToken,
        expiresAt: new Date(inviteExpiry).toISOString(),
        organizationName: "Neverr Platform",
      });

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "admin.users.invited",
        resource: "users",
        resourceId: userId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          invitedEmail: email,
          role,
          organizationId: organizationId || null,
          inviteTokenPrefix: inviteToken.slice(0, 12) + "...",
          emailDelivered: emailResult.success,
          emailError: emailResult.success ? undefined : emailResult.error,
        },
      });

      return res.json({
        success: true,
        user: {
          id: newUser.id,
          userId,
          email,
          role,
          status: "invited",
          inviteToken,
          inviteExpiresAt: inviteExpiry,
          emailDelivered: emailResult.success,
        },
        message: emailResult.success
          ? "Invitation sent via email"
          : "Invitation created (email delivery failed — share token manually)",
        ...(emailResult.success ? {} : { emailError: emailResult.error }),
      });
    } catch (err: any) {
      console.error("[Admin] Error inviting user:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/admin/users/activate ---------------------------------------------
// Public endpoint — the invite token IS the credential. NO auth middleware.
// Flow:
//   1. Validate {token, email, password}
//   2. Find inactive user_roles row by case-insensitive email
//   3. Constant-time compare token; verify not expired
//   4. Mint Supabase Auth user (this is what enables future logins; the
//      synthetic `user_xxx` ID we created at invite time gets replaced with
//      the real Supabase auth UID in user_roles.user_id)
//   5. Activate the row, strip _invite metadata
//   6. Sign the user in and return a session JWT
router.post("/users/activate", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  try {
    const { token, email, password } = (req.body || {}) as {
      token?: string;
      email?: string;
      password?: string;
    };

    if (!token || !email || !password) {
      return res.status(400).json({ error: "token, email, and password are required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (typeof email !== "string" || !/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "Database not configured" });
    }

    const { data: user, error: lookupErr } = await supabase
      .from("user_roles")
      .select("*")
      .ilike("email", email)
      .eq("status", "inactive")
      .maybeSingle();

    if (lookupErr) throw lookupErr;
    if (!user) {
      // Generic message — don't disclose whether the email exists or has a
      // different status.
      return res.status(404).json({ error: "Invalid invitation" });
    }

    const invite = (user.permissions || {})._invite as
      | { token?: string; expiresAt?: string }
      | undefined;
    if (!invite?.token || !invite?.expiresAt) {
      return res.status(401).json({ error: "Invalid invitation" });
    }

    // Constant-time token compare (prevents timing oracles on the hex token).
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(invite.token, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await auditLog({
        action: "admin.users.activate.denied",
        resource: "users",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { email, reason: "token_mismatch" },
      });
      return res.status(401).json({ error: "Invalid invitation" });
    }

    if (Date.now() > new Date(invite.expiresAt).getTime()) {
      // Generic 404 (matches no-row-found) so attackers can't distinguish
      // "expired but valid" from "never existed". Audit the expiry server-side
      // so support can still answer "did my invite expire?" via the audit log.
      await auditLog({
        action: "admin.users.activate.denied",
        resource: "users",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { email, reason: "expired", expiredAt: invite.expiresAt },
      });
      return res.status(404).json({ error: "Invalid invitation" });
    }

    // Audit the activation attempt before mutating external state, so a
    // crash between createUser and the user_roles update is still traceable.
    await auditLog({
      action: "admin.users.activate.started",
      resource: "users",
      resourceId: user.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { email, role: user.role },
    });

    // Mint the Supabase Auth user. `email_confirm: true` skips the
    // verification email since the invite link itself proves email ownership.
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (authErr || !authData.user) {
      // If the auth user already exists (e.g. retried activation), surface a
      // dedicated 409 so the client can prompt for password reset instead of
      // looping the user.
      const msg = (authErr?.message || "").toLowerCase();
      if (msg.includes("already") && msg.includes("registered")) {
        return res.status(409).json({
          error: "An account with this email already exists. Please log in or reset your password.",
        });
      }
      console.error("[Activate] createUser failed:", authErr);
      return res.status(500).json({ error: authErr?.message || "Failed to create account" });
    }

    // Strip invite metadata; flip status to active; bind to real auth UID.
    const cleanedPermissions = { ...(user.permissions || {}) };
    delete (cleanedPermissions as any)._invite;

    const { error: updateErr } = await supabase
      .from("user_roles")
      .update({
        user_id: authData.user.id,
        status: "active",
        permissions: cleanedPermissions,
        last_login: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateErr) {
      console.error("[Activate] user_roles update failed:", updateErr);
      // Compensating action: roll back the freshly-created auth user so the
      // invitee isn't stranded in a half-provisioned state where the auth
      // user exists but the RBAC row is still inactive (every retry would
      // hit the 409 "already registered" branch and the user could never
      // activate). Best-effort: if the rollback itself fails we log it so
      // staff can clean up manually, but we still return 500 to the caller.
      try {
        const { error: delErr } = await supabase.auth.admin.deleteUser(
          authData.user.id,
        );
        if (delErr) {
          console.error(
            "[Activate] CRITICAL: rollback deleteUser failed; orphaned auth user:",
            { userId: authData.user.id, email, error: delErr.message },
          );
          await auditLog({
            action: "admin.users.activate.rollback_failed",
            resource: "users",
            resourceId: user.id,
            success: false,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            details: {
              email,
              authUserId: authData.user.id,
              updateError: updateErr.message,
              rollbackError: delErr.message,
            },
          });
        }
      } catch (rollbackErr: any) {
        console.error(
          "[Activate] CRITICAL: rollback threw; orphaned auth user:",
          { userId: authData.user.id, email, error: rollbackErr?.message },
        );
      }
      return res.status(500).json({
        error: "Activation failed; please try again. If the problem persists, contact support.",
      });
    }

    // Sign in to return a session JWT — gives the new user immediate access
    // without a separate login round-trip. Use a TRANSIENT client so the
    // resulting user session doesn't replace the cached service-role JWT
    // on the module-scoped `supabase` client (which would silently
    // downgrade every subsequent insert in this process to the new user's
    // privileges and trip RLS — symptom: "new row violates row-level
    // security policy" appearing only after the first activation).
    const signInClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data: session } = await signInClient.auth.signInWithPassword({ email, password });

    await auditLog({
      userId: authData.user.id,
      action: "admin.users.activated",
      resource: "users",
      resourceId: user.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { email, role: user.role },
    });

    return res.json({
      success: true,
      user: {
        id: user.id,
        userId: authData.user.id,
        email,
        role: user.role,
        status: "active",
      },
      session: session?.session ?? null,
      message: "Account activated",
    });
  } catch (err: any) {
    console.error("[Admin] Error activating user:", err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users/list --------------------------------------------------
router.get(
  "/users/list",
  requireAuth,
  requireStaffOrBootstrap("read"),
  async (req: Request, res: Response) => {
    try {
      const { role, status, organizationId } = req.query as {
        role?: string;
        status?: string;
        organizationId?: string;
      };
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      let query = supabase
        .from("user_roles")
        .select(
          "id, user_id, email, role, organization_id, status, created_at, updated_at, last_login, created_by",
        );

      if (role) query = query.eq("role", role);
      if (status) query = query.eq("status", status);
      if (organizationId) query = query.eq("organization_id", organizationId);

      const { data: users, error } = await query.order("created_at", { ascending: false });
      if (error) throw error;

      const list = users || [];
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

      const stats = {
        total: list.length,
        byRole: {} as Record<string, number>,
        byStatus: {} as Record<string, number>,
        recentLogins: list.filter(
          (u: any) => u.last_login && new Date(u.last_login).getTime() > sevenDaysAgo,
        ).length,
      };
      for (const u of list as any[]) {
        stats.byRole[u.role] = (stats.byRole[u.role] || 0) + 1;
        stats.byStatus[u.status] = (stats.byStatus[u.status] || 0) + 1;
      }

      return res.json({
        users: list,
        statistics: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Admin] Error listing users:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// PUT /api/admin/users/:userId/permissions -----------------------------------
router.put(
  "/users/:userId/permissions",
  requireAuth,
  requireStaffOrBootstrap("write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const { userId } = req.params;
      const { role, permissions, status } = (req.body || {}) as {
        role?: string;
        permissions?: Record<string, unknown>;
        status?: string;
      };
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      // Load target row first so we can run policy checks before mutating.
      const { data: target, error: loadErr } = await supabase
        .from("user_roles")
        .select("id, user_id, email, role, status, permissions")
        .eq("user_id", userId)
        .maybeSingle();
      if (loadErr) throw loadErr;
      if (!target) {
        return res.status(404).json({ error: "User not found" });
      }

      // Self-modification guard: callers can't change their own role/status
      // (prevents accidental self-demotion / self-suspension lockouts).
      const isSelf = target.user_id === req.userId
        || (req.userEmail && (target.email || "").toLowerCase() === req.userEmail.toLowerCase());
      if (isSelf && (role !== undefined || status !== undefined)) {
        return res.status(400).json({
          error: "You cannot change your own role or status",
        });
      }

      const callerStaffRole = await lookupStaffRole(req.userId, req.userEmail);
      const bootstrapOpen = !(await superAdminExists());

      // Privilege guard: only super_admin may *touch* a super_admin row, and
      // only super_admin may grant super_admin (bootstrap-owner not allowed
      // here — modifications to existing rows are post-seed operations).
      if (target.role === "super_admin" && callerStaffRole !== "super_admin") {
        return res.status(403).json({ error: "Only super_admin may modify a super_admin user" });
      }
      if (role && !canGrantRole(callerStaffRole, req.userRole, role as StaffRole, bootstrapOpen)) {
        return res.status(403).json({
          error: `You may not grant role '${role}'`,
          callerStaffRole,
        });
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      const existing = (target.permissions || {}) as Record<string, unknown>;
      const invite = existing._invite;

      // Decide the *base* permissions to write. Three precedence rules:
      //   1. If `permissions` is supplied, it replaces the resource-key map
      //      wholesale (caller-supplied perms win).
      //   2. Else, if `role` changed, reset resource keys to the new role's
      //      defaults — this prevents elevated grants from a previous role
      //      lingering after a downgrade.
      //   3. Else, leave the existing permissions untouched.
      // The `_invite` metadata is always preserved so an invitation isn't
      // wiped by an unrelated permissions update.
      let nextPerms: Record<string, unknown> | null = null;

      if (role !== undefined) {
        if (!(VALID_STAFF_ROLES as readonly string[]).includes(role)) {
          return res.status(400).json({
            error: "Invalid role specified",
            validRoles: VALID_STAFF_ROLES,
          });
        }
        updates.role = role;
        if (role !== target.role) {
          // Role downgrade/upgrade: reset resource permissions to the new
          // role's defaults so JSONB-stored elevated grants don't survive.
          nextPerms = { ...getDefaultStaffPermissions(role as StaffRole) };
        }
      }

      if (permissions !== undefined) {
        if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
          return res.status(400).json({ error: "permissions must be an object" });
        }
        // Caller-supplied permissions: trust the caller for resource keys but
        // strip any attempt to inject `_invite` (that's ours).
        const sanitized: Record<string, unknown> = { ...(permissions as Record<string, unknown>) };
        delete sanitized._invite;
        nextPerms = nextPerms ? { ...nextPerms, ...sanitized } : sanitized;
      }

      if (nextPerms) {
        if (invite !== undefined) nextPerms._invite = invite;
        updates.permissions = nextPerms;
      }

      if (status !== undefined) {
        if (!(VALID_STAFF_STATUSES as readonly string[]).includes(status)) {
          return res.status(400).json({
            error: "Invalid status specified",
            validStatuses: VALID_STAFF_STATUSES,
          });
        }
        updates.status = status as StaffStatus;
      }

      const { data: updatedUser, error } = await supabase
        .from("user_roles")
        .update(updates)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throw error;

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "admin.users.permissions.updated",
        resource: "users",
        resourceId: userId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          targetUser: updatedUser.email,
          changedFields: Object.keys(updates).filter((k) => k !== "updated_at"),
          callerStaffRole,
        },
      });

      return res.json({
        success: true,
        user: updatedUser,
        message: "User permissions updated successfully",
      });
    } catch (err: any) {
      console.error("[Admin] Error updating user permissions:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// ===========================================================================
// TENANT TEAM MANAGEMENT (per-customer organization)
// ===========================================================================
// Distinct from the staff invite/activate endpoints above (those gate Neverr's
// internal back-office). The endpoints below let a customer's owner/admin
// invite their own team members into their `business_configs` workspace,
// using the same Supabase Auth identity provider but a separate role table
// (`user_businesses`).
// ---------------------------------------------------------------------------

const PLAN_USER_LIMITS: Record<string, number> = {
  essential: 5,
  starter: 10,
  professional: 25,
  growth: 50,
  business: 100,
  enterprise: 500,
};

const PLAN_API_LIMITS: Record<string, number> = {
  essential: 5_000,
  starter: 10_000,
  professional: 25_000,
  growth: 50_000,
  business: 50_000,
  enterprise: 100_000,
};

/**
 * Convert the Permission[] shape used by `requirePermission` into the
 * `Record<resource, action[]>` shape expected by the invitation email
 * template + the API response payload. The two shapes exist for different
 * reasons: the array form is what the runtime check needs (one record per
 * (resource, action, businessId) triple); the map form is what humans read.
 */
function permissionsAsMap(role: EnterpriseRole): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of permissionsForRole(role, "")) {
    out[p.resource] = [...p.actions];
  }
  return out;
}

// POST /api/admin/organization/setup -----------------------------------------
// One-time setup: enables team-management features on the caller's
// `business_configs` row, generates the per-org API key (returned ONCE in
// plaintext — only the SHA-256 hash is persisted), and seeds plan-derived
// caps (max users, daily API request limit, feature flags). Idempotent-by-
// 409: re-calling on a configured org returns 409 rather than re-issuing the
// API key (which would silently invalidate the previous one).
router.post(
  "/organization/setup",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const { organizationName, maxUsers, enableApiAccess = true } =
        (req.body || {}) as {
          organizationName?: string;
          maxUsers?: number;
          enableApiAccess?: boolean;
        };

      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database not configured" });
      if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

      const { data: business, error: businessError } = await supabase
        .from("business_configs")
        .select("business_id, business_name, plan_id, organization_settings")
        .eq("business_id", req.businessId)
        .single();

      if (businessError || !business) {
        return res.status(404).json({ error: "Business configuration not found" });
      }

      const currentSettings = (business.organization_settings || {}) as {
        organizationName?: string;
      };
      if (currentSettings.organizationName) {
        return res.status(409).json({
          error: "Organization features already enabled",
          currentOrganization: currentSettings.organizationName,
        });
      }

      const planId = (business.plan_id || "starter").toLowerCase();
      const planCap = PLAN_USER_LIMITS[planId] ?? 10;
      const requestedMax = typeof maxUsers === "number" && maxUsers > 0 ? maxUsers : planCap;
      const actualMaxUsers = Math.min(requestedMax, planCap);

      // Generate API key. The plaintext value lives ONLY in the response —
      // the row stores the SHA-256 hash and an 8-char prefix for log-tracing.
      // Declared at the outer scope so the response builder below can see it
      // without depending on the conditional's lexical scope.
      let apiKeyPlaintext: string | null = null;
      let apiKeyPrefix: string | null = null;
      const updates: Record<string, unknown> = {};

      if (enableApiAccess) {
        const apiKey = secureToken("napi", 32);
        const crypto = await import("node:crypto");
        const apiKeyHash = crypto.createHash("sha256").update(apiKey).digest("hex");
        apiKeyPlaintext = apiKey;
        apiKeyPrefix = apiKey.slice(0, 8);
        updates.api_key_hash = apiKeyHash;
        updates.api_key_prefix = apiKeyPrefix;
      }

      const organizationSettings = {
        organizationName: organizationName || business.business_name,
        maxUsers: actualMaxUsers,
        enabledAt: new Date().toISOString(),
        enabledBy: req.userId,
        features: {
          teamManagement: true,
          roleBasedAccess: true,
          apiAccess: enableApiAccess,
          advancedAnalytics: ["professional", "growth", "business", "enterprise"].includes(planId),
          customBranding: ["business", "enterprise"].includes(planId),
          ssoIntegration: planId === "enterprise",
        },
        limits: {
          maxUsers: actualMaxUsers,
          maxApiRequestsPerDay: PLAN_API_LIMITS[planId] ?? 10_000,
        },
      };

      updates.organization_settings = organizationSettings;

      const { error: updateError } = await supabase
        .from("business_configs")
        .update(updates)
        .eq("business_id", business.business_id);

      if (updateError) throw updateError;

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "organization.features.enabled",
        resource: "settings",
        resourceId: business.business_id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          organizationName: organizationSettings.organizationName,
          maxUsers: actualMaxUsers,
          apiAccess: enableApiAccess,
          plan: planId,
          apiKeyPrefix: apiKeyPrefix || undefined,
        },
      });

      return res.json({
        success: true,
        organization: {
          name: organizationSettings.organizationName,
          maxUsers: actualMaxUsers,
          features: organizationSettings.features,
          limits: organizationSettings.limits,
        },
        ...(apiKeyPlaintext
          ? {
              apiKey: {
                key: apiKeyPlaintext,
                prefix: apiKeyPrefix,
                note: "Store this securely — it will not be shown again",
              },
            }
          : {}),
        message: "Organization features enabled successfully",
      });
    } catch (err: any) {
      console.error("[Organization] Setup error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/admin/team/invite ------------------------------------------------
// Invite a new team member into the caller's tenant. Reuses Supabase Auth as
// the identity provider (so MFA / password reset / session JWTs all work
// out of the box) and the same SendGrid invitation template as the staff
// invite flow. The `user_businesses` row is created up front against the
// real Supabase auth UID so that, after activation, `requireAuth`'s
// membership lookup picks the user up immediately.
router.post(
  "/team/invite",
  requireAuth,
  requirePermission("users", "write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const { email, role } = (req.body || {}) as { email?: string; role?: string };

      if (!email || typeof email !== "string" || !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      if (!role || !ASSIGNABLE_ENTERPRISE_ROLES.includes(role as EnterpriseRole)) {
        return res.status(400).json({
          error: "Invalid role for team member",
          validRoles: ASSIGNABLE_ENTERPRISE_ROLES,
        });
      }

      // Grantability check: closes the privilege-escalation gap where any
      // role with `users:write` (manager / team_lead) could otherwise mint
      // an `admin`. Caller must outrank the target role strictly.
      if (!canGrantEnterpriseRole(req.userRole, role as EnterpriseRole)) {
        return res.status(403).json({
          error: "You do not have permission to grant this role",
          callerRole: req.userRole,
          targetRole: role,
        });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database not configured" });
      if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

      // Org must have run /organization/setup first — that's where maxUsers
      // and the org name come from. Without it, we have nothing to enforce
      // limits against and nothing to put in the invite email's "team" field.
      const { data: business } = await supabase
        .from("business_configs")
        .select("business_id, business_name, organization_settings")
        .eq("business_id", req.businessId)
        .single();

      let orgSettings = (business?.organization_settings || {}) as {
        organizationName?: string;
        maxUsers?: number;
        enabledFeatures?: string[];
        setupAt?: string;
        setupBy?: string;
      };

      // Auto-setup: first invite on a tenant whose org_settings hasn't been
      // initialized used to return 400 ("Organization features not enabled.
      // Call /api/admin/organization/setup first.") — that 400 ate the
      // happy path for every newly-signed-up business and forced an extra
      // round-trip nobody understood. Now we transparently seed
      // organization_settings on first use, using the business's own
      // business_name as the default organizationName. Failure here is
      // fatal because the rest of this handler depends on orgSettings being
      // populated (maxUsers cap, invite email body, audit details).
      if (!orgSettings.organizationName) {
        const orgName = business?.business_name || "My Organization";
        const defaultOrgSettings = {
          organizationName: orgName,
          maxUsers: 25,
          enabledFeatures: ["team_management", "invitations"],
          setupAt: new Date().toISOString(),
          setupBy: req.userId,
        };

        const { error: orgUpdateErr } = await supabase
          .from("business_configs")
          .update({ organization_settings: defaultOrgSettings })
          .eq("business_id", req.businessId);

        if (orgUpdateErr) {
          console.error("[TeamInvite] Org auto-setup failed:", orgUpdateErr.message);
          return res.status(500).json({
            error:
              "Could not initialize team management. Try again or contact support.",
          });
        }

        orgSettings = defaultOrgSettings;

        await auditLog({
          userId: req.userId,
          businessId: req.businessId,
          action: "business.organization.auto_setup",
          resource: "business_configs",
          resourceId: req.businessId,
          success: true,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: {
            organizationName: orgName,
            trigger: "first_team_invite",
          },
        });
      }

      // NOTE: maxUsers enforcement here is a non-atomic preflight check —
      // two concurrent invites at the cap can each pass this gate before
      // either insert lands. The DB-level unique constraint on
      // (business_id, user_id) on user_businesses prevents duplicate
      // *memberships*, but does NOT cap the total. A serializable
      // transaction or RPC would be needed for hard enforcement; for now
      // the soft cap is acceptable because per-tenant invite throughput is
      // very low and slight overshoots can be reconciled out-of-band.
      const maxUsers = orgSettings.maxUsers || 10;
      const { count: currentMembers } = await supabase
        .from("user_businesses")
        .select("*", { count: "exact", head: true })
        .eq("business_id", req.businessId);

      if ((currentMembers || 0) >= maxUsers) {
        return res.status(403).json({
          error: `Team member limit reached (${maxUsers}). Upgrade your plan for more members.`,
          currentMembers,
          maxUsers,
        });
      }

      // Duplicate-membership guard. Email match is case-insensitive because
      // Supabase Auth normalizes to lowercase but historical rows in
      // business_users may be mixed-case.
      const { data: existingMember } = await supabase
        .from("business_users")
        .select("user_id, email")
        .eq("business_id", req.businessId)
        .ilike("email", email)
        .maybeSingle();

      if (existingMember) {
        return res.status(409).json({
          error: "User already exists in this organization",
          existingMember: { email: existingMember.email },
        });
      }

      const inviteToken = secureToken("tinv", 24);
      const inviteExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      // Create the Supabase Auth user with email_confirm:false. The invite
      // metadata travels in user_metadata so the activation endpoint can find
      // it without needing a separate invite-tokens table.
      const { data: created, error: authErr } = await supabase.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: {
          invitation_token: inviteToken,
          invitation_expires_at: inviteExpiry.toISOString(),
          invitation_scope: "tenant",
          invited_to_business_id: req.businessId,
          invited_role: role,
          invited_by: req.userEmail || req.userId,
        },
      });

      if (authErr || !created.user) {
        const msg = (authErr?.message || "").toLowerCase();
        if (msg.includes("already") && msg.includes("registered")) {
          return res.status(409).json({
            error: "An account with this email already exists. Ask them to log in instead.",
          });
        }
        console.error("[TeamInvite] createUser failed:", authErr);
        return res.status(500).json({ error: authErr?.message || "Failed to create invitee" });
      }

      // Insert business_users + user_businesses against the REAL auth UID.
      // If either insert fails we roll the auth user back so we don't leave
      // an orphaned identity (mirrors the staff activation rollback).
      const authUserId = created.user.id;
      const { error: buErr } = await supabase.from("business_users").insert({
        user_id: authUserId,
        email,
        business_id: req.businessId,
      });

      let membershipErr: any = null;
      if (!buErr) {
        const { error: mErr } = await supabase.from("user_businesses").insert({
          user_id: authUserId,
          business_id: req.businessId,
          role,
        });
        membershipErr = mErr;
      }

      if (buErr || membershipErr) {
        const seedErr = buErr || membershipErr;
        console.error("[TeamInvite] membership seed failed; rolling back auth user:", seedErr);
        try {
          await supabase.auth.admin.deleteUser(authUserId);
        } catch (rbErr: any) {
          console.error("[TeamInvite] CRITICAL: rollback failed; orphaned auth user:", {
            authUserId,
            email,
            error: rbErr?.message,
          });
        }
        // Best-effort cleanup of the partial business_users row when the
        // failure was on the membership insert (the BU row succeeded).
        if (!buErr && membershipErr) {
          await supabase.from("business_users").delete().eq("user_id", authUserId);
        }
        // Postgres unique-violation on user_businesses_user_id_business_id_key
        // means a concurrent request raced us to the insert — surface as 409
        // so callers don't see a confusing 500.
        if ((seedErr as any).code === "23505") {
          return res.status(409).json({
            error: "User already exists in this organization",
          });
        }
        return res.status(500).json({ error: seedErr.message });
      }

      const inviterEmail = req.userEmail || "team@neverr.ai";
      const emailResult = await sendInvitationEmail({
        recipientEmail: email,
        inviteeName: email.split("@")[0],
        inviterName: inviterEmail.split("@")[0],
        inviterEmail,
        organizationName: orgSettings.organizationName,
        role,
        permissions: permissionsAsMap(role as EnterpriseRole),
        inviteToken,
        expiresAt: inviteExpiry.toISOString(),
      });

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "team.member.invited",
        resource: "users",
        resourceId: authUserId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          invitedEmail: email,
          role,
          organizationName: orgSettings.organizationName,
          inviteTokenPrefix: inviteToken.slice(0, 12) + "...",
          emailDelivered: emailResult.success,
          emailError: emailResult.success ? undefined : emailResult.error,
        },
      });

      return res.json({
        success: true,
        user: {
          id: authUserId,
          email,
          role,
          status: "invited",
          inviteExpiresAt: inviteExpiry.toISOString(),
          emailDelivered: emailResult.success,
        },
        message: emailResult.success
          ? "Team member invitation sent successfully"
          : "Team member created (email delivery failed — share token manually)",
        ...(emailResult.success ? {} : { emailError: emailResult.error, inviteToken }),
      });
    } catch (err: any) {
      console.error("[Team] Invitation error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// GET /api/admin/team/members ------------------------------------------------
router.get(
  "/team/members",
  requireAuth,
  requirePermission("users", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database not configured" });
      if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

      // Two queries instead of an embedded join: business_users and
      // user_businesses don't have a declared FK in PostgREST's schema cache,
      // so a `business_users!inner(...)` select would return PGRST200. Two
      // round-trips on a small per-tenant member list is fine.
      const { data: memberships, error: mErr } = await supabase
        .from("user_businesses")
        .select("user_id, role, created_at")
        .eq("business_id", req.businessId)
        .order("created_at", { ascending: false });
      if (mErr) throw mErr;

      const userIds = (memberships || []).map((m) => m.user_id);
      let emailByUserId: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: bUsers, error: bErr } = await supabase
          .from("business_users")
          .select("user_id, email")
          .eq("business_id", req.businessId)
          .in("user_id", userIds);
        if (bErr) throw bErr;
        for (const bu of bUsers || []) {
          emailByUserId[bu.user_id] = bu.email;
        }
      }

      // Owners (and potentially other historical members) don't always have a
      // `business_users` row — that table is populated by the invite flow,
      // and the bootstrap owner skips it. Fall back to auth.admin.getUserById
      // for any membership that's still missing an email so the team list is
      // never blank for the owner. Per-user lookup is fine: tenant member
      // counts are small and this is a rarely-hit list endpoint.
      //
      // Slice 3: extend the same per-user lookup to ALL userIds (not just
      // missing-email rows) so we can pull first_name + last_name out of
      // user_metadata for the TeamTab display.
      const firstNameByUserId: Record<string, string> = {};
      const lastNameByUserId: Record<string, string> = {};
      for (const uid of userIds) {
        try {
          const { data: u } = await supabase.auth.admin.getUserById(uid);
          if (!u?.user) continue;
          if (!emailByUserId[uid] && u.user.email) emailByUserId[uid] = u.user.email;
          const meta = (u.user.user_metadata || {}) as Record<string, unknown>;
          if (typeof meta.first_name === "string" && meta.first_name.trim()) {
            firstNameByUserId[uid] = meta.first_name.trim();
          }
          if (typeof meta.last_name === "string" && meta.last_name.trim()) {
            lastNameByUserId[uid] = meta.last_name.trim();
          }
        } catch (e) {
          console.warn("[Team] auth lookup failed for", uid, e);
        }
      }

      const { data: business } = await supabase
        .from("business_configs")
        .select("organization_settings")
        .eq("business_id", req.businessId)
        .single();

      const orgSettings = (business?.organization_settings || {}) as {
        organizationName?: string;
        maxUsers?: number;
      };

      const members = (memberships || []).map((m) => ({
        userId: m.user_id,
        email: emailByUserId[m.user_id] || null,
        firstName: firstNameByUserId[m.user_id] || null,
        lastName: lastNameByUserId[m.user_id] || null,
        role: m.role,
        joinedAt: m.created_at,
        permissions: permissionsAsMap(m.role as EnterpriseRole),
      }));

      const byRole: Record<string, number> = {};
      for (const m of members) byRole[m.role] = (byRole[m.role] || 0) + 1;

      return res.json({
        members,
        organization: {
          name: orgSettings.organizationName || null,
          maxUsers: orgSettings.maxUsers || 10,
          currentUsers: members.length,
        },
        summary: { total: members.length, byRole },
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("[Team] List error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// PUT /api/admin/team/members/:userId/role -----------------------------------
// Rules:
//   * `owner` is immutable — can't be granted or revoked through this route
//     (owner transfer is a separate operation that needs a billing/tax
//     workflow we haven't built yet).
//   * Caller can't change their own role (prevents self-lockout).
//   * Target must already be a member of the caller's business.
router.put(
  "/team/members/:userId/role",
  requireAuth,
  requirePermission("users", "write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const { userId } = req.params;
      const { role } = (req.body || {}) as { role?: string };

      if (!role || !ASSIGNABLE_ENTERPRISE_ROLES.includes(role as EnterpriseRole)) {
        return res.status(400).json({
          error: "Invalid role",
          validRoles: ASSIGNABLE_ENTERPRISE_ROLES,
        });
      }

      // Grantability check (mirrors /team/invite). Without this a `manager`
      // could promote anyone to `admin` because both endpoints are gated
      // only on `users:write`.
      if (!canGrantEnterpriseRole(req.userRole, role as EnterpriseRole)) {
        return res.status(403).json({
          error: "You do not have permission to grant this role",
          callerRole: req.userRole,
          targetRole: role,
        });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database not configured" });
      if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

      if (userId === req.userId) {
        return res.status(400).json({ error: "You cannot change your own role" });
      }

      const { data: current, error: loadErr } = await supabase
        .from("user_businesses")
        .select("user_id, role")
        .eq("user_id", userId)
        .eq("business_id", req.businessId)
        .maybeSingle();

      if (loadErr) throw loadErr;
      if (!current) return res.status(404).json({ error: "Team member not found" });

      if (current.role === "owner") {
        return res.status(403).json({ error: "Cannot modify owner role" });
      }

      // Caller must also outrank the target's CURRENT role, not just the
      // proposed new one. Without this, a manager could *demote* an admin
      // (admin→user) — not an escalation, but still an authorization gap
      // on a sensitive role mutation. Mirrors the upstream grantability
      // check on the proposed `role`.
      if (!canGrantEnterpriseRole(req.userRole, current.role as EnterpriseRole)) {
        return res.status(403).json({
          error: "You do not have permission to modify a member with this role",
          callerRole: req.userRole,
          currentTargetRole: current.role,
        });
      }

      const { data: updated, error } = await supabase
        .from("user_businesses")
        .update({ role })
        .eq("user_id", userId)
        .eq("business_id", req.businessId)
        .select("user_id, role")
        .single();
      if (error) throw error;

      const { data: bu } = await supabase
        .from("business_users")
        .select("email")
        .eq("user_id", userId)
        .eq("business_id", req.businessId)
        .maybeSingle();

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "team.member.role.updated",
        resource: "users",
        resourceId: userId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { targetEmail: bu?.email, oldRole: current.role, newRole: role },
      });

      return res.json({
        success: true,
        member: {
          userId: updated.user_id,
          email: bu?.email || null,
          role: updated.role,
          permissions: permissionsAsMap(updated.role as EnterpriseRole),
        },
        message: "Team member role updated successfully",
      });
    } catch (err: any) {
      console.error("[Team] Role update error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// DELETE /api/admin/team/members/:userId -------------------------------------
// Single endpoint for both "remove an active member" and "revoke a pending
// invitation" — they're operationally the same delete on (business_users +
// user_businesses), the only difference is whether we also need to clean up
// the unconfirmed Supabase auth user so the same email can be re-invited.
//
// Authorization mirrors PUT /team/members/:userId/role:
//   * Self-removal blocked (prevents self-lockout — another admin must do it)
//   * `owner` is immutable
//   * Caller must outrank the target's current role (no manager-removes-admin)
//
// The frontend can show "Remove Member" vs "Revoke Invitation" labels using
// the activated/invited signal already returned by GET /team/members.
router.delete(
  "/team/members/:userId",
  requireAuth,
  requirePermission("users", "write"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const targetUserId = req.params.userId;
      if (!targetUserId) {
        return res.status(400).json({ error: "userId required" });
      }

      if (targetUserId === req.userId) {
        return res.status(400).json({
          error: "Cannot remove yourself. Have another admin remove you.",
        });
      }

      const supabase = getSupabase();
      if (!supabase) return res.status(500).json({ error: "Database not configured" });
      if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

      // Role lives in user_businesses (NOT business_users — that table only
      // has user_id, email, business_id). Look up the target's membership
      // for this tenant; absence is a 404 and also covers the cross-tenant
      // case where caller's active business doesn't contain the target.
      const { data: membership, error: mLoadErr } = await supabase
        .from("user_businesses")
        .select("user_id, role")
        .eq("user_id", targetUserId)
        .eq("business_id", req.businessId)
        .maybeSingle();

      if (mLoadErr) throw mLoadErr;
      if (!membership) {
        return res.status(404).json({ error: "Member not found in this business" });
      }

      if (membership.role === "owner") {
        return res.status(403).json({ error: "Cannot remove an owner" });
      }

      if (!canGrantEnterpriseRole(req.userRole, membership.role as EnterpriseRole)) {
        return res.status(403).json({
          error: `Cannot remove a ${membership.role} (you are ${req.userRole})`,
          callerRole: req.userRole,
          targetRole: membership.role,
        });
      }

      // Pull email + invited/activated signal from auth.users. email lookup
      // also falls back to business_users for old rows, but auth is the
      // source of truth for `email_confirmed_at` which tells us whether
      // the auth identity needs cleanup.
      let targetEmail: string | null = null;
      let wasInvited = false;
      try {
        const { data: u } = await supabase.auth.admin.getUserById(targetUserId);
        if (u?.user) {
          targetEmail = u.user.email || null;
          // No email_confirmed_at means they never set their password via
          // /team/activate — this row is a pending invite, not an active
          // member. We need to clean up the auth user too so the same
          // email can be re-invited (createUser would otherwise 409).
          wasInvited = !u.user.email_confirmed_at;
        }
      } catch (e: any) {
        console.warn("[TeamRemove] auth lookup failed (non-fatal):", e?.message);
      }

      if (!targetEmail) {
        const { data: bu } = await supabase
          .from("business_users")
          .select("email")
          .eq("user_id", targetUserId)
          .eq("business_id", req.businessId)
          .maybeSingle();
        targetEmail = bu?.email || null;
      }

      // Delete business_users first; if this fails we haven't touched
      // user_businesses yet so state is consistent.
      const { error: delBuErr } = await supabase
        .from("business_users")
        .delete()
        .eq("user_id", targetUserId)
        .eq("business_id", req.businessId);

      if (delBuErr) {
        console.error("[TeamRemove] business_users delete failed:", delBuErr.message);
        return res.status(500).json({ error: "Removal failed" });
      }

      // user_businesses (the multi-tenant membership table the Phase 3e
      // switcher reads) — ignored on best-effort because the canonical
      // tenant-scoped rejection now happens via business_users absence.
      const { error: delUbErr } = await supabase
        .from("user_businesses")
        .delete()
        .eq("user_id", targetUserId)
        .eq("business_id", req.businessId);

      if (delUbErr) {
        console.warn(
          "[TeamRemove] user_businesses delete failed (non-fatal):",
          delUbErr.message,
        );
      }

      // Pending invite → also drop the unconfirmed auth user. We can call
      // admin.deleteUser on the cached service-role client without the
      // session-mutation problem that forced /team/activate to spin up a
      // transient client (signInWithPassword mutates session; admin.* calls
      // don't). Failure is non-fatal — the tenant membership is already gone.
      if (wasInvited) {
        try {
          await supabase.auth.admin.deleteUser(targetUserId);
        } catch (e: any) {
          console.warn(
            "[TeamRemove] auth user cleanup failed (non-fatal — re-invite of same email may 409):",
            e?.message,
          );
        }
      }

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "business.member.removed",
        resource: "business_users",
        resourceId: targetUserId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          removed_user_id: targetUserId,
          removed_email: targetEmail,
          removed_role: membership.role,
          was_invited_only: wasInvited,
        },
      });

      return res.json({
        success: true,
        message: wasInvited
          ? "Pending invitation revoked"
          : "Team member removed successfully",
      });
    } catch (err: any) {
      console.error("[TeamRemove] Error:", err);
      return res.status(500).json({ error: err.message });
    }
  },
);

// POST /api/admin/team/activate ----------------------------------------------
// Public endpoint — invite token is the credential. Mirrors the staff
// `/users/activate` flow but operates on Supabase Auth user_metadata
// (where `/team/invite` stashed the token) rather than the staff-only
// `user_roles` table. Bypasses requireAuth via the AUTH_BYPASS_PATTERNS list
// in app.ts and is rate-limited via authLimiter to throttle token brute-force.
router.post("/team/activate", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  try {
    const { token, email, password, first_name, last_name } = (req.body || {}) as {
      token?: string;
      email?: string;
      password?: string;
      first_name?: string;
      last_name?: string;
    };

    if (!token || !email || !password) {
      return res.status(400).json({ error: "token, email, and password are required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (typeof email !== "string" || !/.+@.+\..+/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    // Slice 3: invitees must provide their name. Mirrors the signup
    // validation in middlewares/validate.ts so /auth/signup and
    // /team/activate produce the same user_metadata shape regardless of
    // which path created the auth user.
    const PERSON_NAME_RE = /^[\p{L}'\-\s]+$/u;
    if (typeof first_name !== "string" || first_name.trim().length < 1 || first_name.length > 50 || !PERSON_NAME_RE.test(first_name)) {
      return res.status(400).json({ error: "first_name is required (letters, hyphens, apostrophes, spaces; max 50 chars)" });
    }
    if (typeof last_name !== "string" || last_name.trim().length < 1 || last_name.length > 50 || !PERSON_NAME_RE.test(last_name)) {
      return res.status(400).json({ error: "last_name is required (letters, hyphens, apostrophes, spaces; max 50 chars)" });
    }

    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Database not configured" });

    // Deterministic auth-user lookup. Earlier we used `listUsers({page:1,
    // perPage:200})` and linear-scanned for the email — that silently
    // breaks past 200 auth users. Instead, look up the auth UID via our
    // own `business_users` table (populated at invite time with the real
    // auth UID) and then fetch the auth user by ID. Works regardless of
    // total Supabase user count.
    const { data: bu, error: buErr } = await supabase
      .from("business_users")
      .select("user_id, business_id")
      .ilike("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (buErr) {
      console.error("[TeamActivate] business_users lookup failed:", buErr);
      throw buErr;
    }
    if (!bu) {
      // Generic 404 — don't disclose whether the email exists at all.
      return res.status(404).json({ error: "Invalid invitation" });
    }

    const { data: gotUser, error: getErr } = await supabase.auth.admin.getUserById(bu.user_id);
    if (getErr || !gotUser?.user) {
      // Auth user was deleted out from under us — treat as no invitation.
      return res.status(404).json({ error: "Invalid invitation" });
    }
    const target = gotUser.user;

    const meta_user = (target.user_metadata || {}) as Record<string, any>;
    const storedToken = meta_user.invitation_token;
    const storedExpiry = meta_user.invitation_expires_at;
    const scope = meta_user.invitation_scope;

    // Defense-in-depth one-shot gate. If the user is already email-confirmed
    // they've been activated before — refuse re-activation regardless of
    // metadata state. (Belt-and-braces with the metadata strip below; either
    // alone is sufficient but together they survive a partial update.)
    if (target.email_confirmed_at) {
      return res.status(404).json({ error: "Invalid invitation" });
    }

    if (scope !== "tenant" || !storedToken || !storedExpiry) {
      return res.status(404).json({ error: "Invalid invitation" });
    }

    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(String(storedToken), "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await auditLog({
        action: "team.users.activate.denied",
        resource: "users",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { email, reason: "token_mismatch" },
      });
      return res.status(401).json({ error: "Invalid invitation" });
    }

    if (Date.now() > new Date(storedExpiry).getTime()) {
      await auditLog({
        action: "team.users.activate.denied",
        resource: "users",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { email, reason: "expired" },
      });
      return res.status(404).json({ error: "Invalid invitation" });
    }

    await auditLog({
      action: "team.users.activate.started",
      resource: "users",
      resourceId: target.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { email, role: meta_user.invited_role },
    });

    // Set password, confirm email, and strip invitation metadata in one call.
    // The user_businesses row was already inserted at invite time, so once
    // this succeeds the user can log in and `requireAuth` will pick up their
    // membership immediately.
    //
    // CRITICAL: Supabase Auth MERGES user_metadata on update — omitting a key
    // doesn't delete it server-side. To actually drop the invitation token
    // (so a replay can't re-activate) we must explicitly set it to `null`.
    // The other invitation fields are nulled the same way; `invited_role`
    // and `invited_to_business_id` are kept as audit breadcrumbs.
    const metadataPatch = {
      ...meta_user,
      invitation_token: null,
      invitation_expires_at: null,
      invitation_scope: null,
      // Slice 3: persist name into user_metadata so the trust portal can
      // attribute callbacks to "Jamie" instead of "Your team".
      first_name,
      last_name,
      full_name: `${first_name} ${last_name}`,
    };

    const { error: updErr } = await supabase.auth.admin.updateUserById(target.id, {
      password,
      email_confirm: true,
      user_metadata: metadataPatch,
    });
    if (updErr) {
      console.error("[TeamActivate] updateUserById failed:", updErr);
      return res.status(500).json({ error: updErr.message });
    }

    // Defensive membership upsert. The user_businesses row was inserted at
    // invite time, but if it was lost to a partial failure / manual cleanup
    // / data drift, the activated user would log in with no tenant scope
    // and `requireAuth` would reject every subsequent call. Upsert against
    // the unique (user_id, business_id) constraint to make activation
    // self-healing without overwriting an existing row's role.
    if (meta_user.invited_to_business_id && meta_user.invited_role) {
      const { error: upErr } = await supabase
        .from("user_businesses")
        .upsert(
          {
            user_id: target.id,
            business_id: meta_user.invited_to_business_id,
            role: meta_user.invited_role,
          },
          { onConflict: "user_id,business_id", ignoreDuplicates: true },
        );
      if (upErr) {
        console.error("[TeamActivate] membership upsert failed (non-fatal):", upErr);
      }
    }

    // Sign the user in so the response includes a session JWT (parity with
    // the staff activation flow — the dashboard can drop them straight into
    // the app without a second login round-trip). Transient client: see
    // long-form note in /staff/users/activate above. Calling
    // signInWithPassword on the module-cached client mutates its session
    // and breaks every subsequent service-role write in the process.
    const signInClient = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
      { auth: { persistSession: false } },
    );
    const { data: signIn } = await signInClient.auth.signInWithPassword({ email, password });

    return res.json({
      success: true,
      user: {
        id: target.id,
        email,
        role: meta_user.invited_role,
        businessId: meta_user.invited_to_business_id,
      },
      session: signIn?.session
        ? {
            access_token: signIn.session.access_token,
            refresh_token: signIn.session.refresh_token,
            expires_at: signIn.session.expires_at,
          }
        : null,
      message: "Account activated successfully",
    });
  } catch (err: any) {
    console.error("[TeamActivate] Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 3g: Sales-created persistent demos
//
// These reuse the `preview_demos` table (Phase 3d) but flip the
// `is_persistent` flag so they bypass the 30-min self-serve cleanup. Each
// demo provisions its own ElevenLabs agent (so revoke can tear it down
// without touching paying customers' agents). Public-facing reads continue
// to flow through GET /api/preview/:id, which already honors `revoked_at`.
// ---------------------------------------------------------------------------

const SALES_DEMO_MIN_DAYS = 1;
const SALES_DEMO_MAX_DAYS = 90;
const SALES_DEMO_DEFAULT_DAYS = 30;

function publicBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "https://neverr.ai";
}

router.get("/demos", requireAuth, requireStaffPermission("customers", "read"), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ error: "Database unavailable" });
  }

  try {
    const { data, error } = await supabase
      .from("preview_demos")
      .select(
        "id, demo_business_id, demo_agent_id, demo_label, business_name, industry, " +
          "website, expires_at, created_at, revoked_at, revoke_reason, share_notes, " +
          "call_count, deleted_at, created_by_user_id",
      )
      .eq("is_persistent", true)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error("[AdminDemos] List failed:", error.message);
      return res.status(500).json({ error: "Failed to load demos" });
    }

    const now = Date.now();
    const demos = (data || []).map((row: any) => {
      const expiresMs = new Date(row.expires_at).getTime();
      let status: "active" | "expired" | "revoked" | "deleted";
      if (row.deleted_at) status = "deleted";
      else if (row.revoked_at) status = "revoked";
      else if (expiresMs < now) status = "expired";
      else status = "active";

      return {
        id: row.id,
        demo_business_id: row.demo_business_id,
        demo_agent_id: row.demo_agent_id,
        demo_label: row.demo_label,
        business_name: row.business_name,
        industry: row.industry,
        website: row.website,
        expires_at: row.expires_at,
        created_at: row.created_at,
        revoked_at: row.revoked_at,
        revoke_reason: row.revoke_reason,
        share_notes: row.share_notes,
        call_count: row.call_count || 0,
        share_url: `${publicBaseUrl()}/demo/${row.demo_business_id}`,
        status,
      };
    });

    return res.json({ success: true, demos });
  } catch (e: any) {
    console.error("[AdminDemos] List error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post("/demos", requireAuth, requireStaffPermission("customers", "write"), async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(500).json({ error: "Database unavailable" });
  }

  const body = req.body || {};
  const demo_label = typeof body.demo_label === "string" ? body.demo_label.trim().slice(0, 200) : "";
  const business_name =
    typeof body.business_name === "string" ? body.business_name.trim().slice(0, 120) : "";
  const industry = typeof body.industry === "string" ? body.industry.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim().slice(0, 500) : "";
  const tone = typeof body.tone === "string" ? body.tone.trim().slice(0, 500) : "";
  const share_notes =
    typeof body.share_notes === "string" ? body.share_notes.trim().slice(0, 2000) : "";

  let expires_in_days = Number(body.expires_in_days);
  if (!Number.isFinite(expires_in_days) || expires_in_days <= 0) {
    expires_in_days = SALES_DEMO_DEFAULT_DAYS;
  }
  expires_in_days = Math.max(SALES_DEMO_MIN_DAYS, Math.min(SALES_DEMO_MAX_DAYS, Math.floor(expires_in_days)));

  if (!demo_label || !business_name || !industry) {
    return res
      .status(400)
      .json({ error: "demo_label, business_name, and industry are required" });
  }

  try {
    const industryTemplate = await fetchIndustryTemplate(industry);
    if (!industryTemplate) {
      return res.status(400).json({ error: `Unknown industry: ${industry}` });
    }

    let websiteContext: string | null = null;
    if (website) {
      try {
        const scraped = await scrapeWebsite(website);
        if (scraped.success && scraped.context_text) {
          websiteContext = scraped.context_text;
        }
      } catch (e: any) {
        console.warn("[AdminDemos] Scrape failed, continuing without:", e.message);
      }
    }

    const systemPrompt = buildSystemPrompt({
      business_name,
      industry,
      business_hours: "Monday-Friday 9AM-6PM",
      timezone: "America/New_York",
      industryTemplate,
      websiteContext,
      tonePreference: tone || null,
    });

    const demoBusinessId = `salesdemo_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);

    // Sales demos write to preview_demos, NOT business_configs, so
    // updateAgentTools (which reads from business_configs) is NOT
    // wired here. The salesdemo agent intentionally has no
    // request_callback registered — there are no staff to follow up
    // on captures and the webhook would dead-letter on the
    // salesdemo_ prefix.
    const agentResult = await createAgentForBusiness({
      businessId: demoBusinessId,
      businessName: `[SALES DEMO] ${business_name}`,
      systemPrompt,
      firstMessage: renderFirstMessage({ business_name }),
    });

    const { data: inserted, error: insertErr } = await supabase
      .from("preview_demos")
      .insert({
        demo_business_id: demoBusinessId,
        demo_agent_id: agentResult.success ? agentResult.agentId : null,
        industry,
        business_name,
        website: website || null,
        system_prompt: systemPrompt,
        ip_address: null,
        user_agent: "admin:sales_demo",
        expires_at: expiresAt.toISOString(),
        is_persistent: true,
        demo_label,
        share_notes: share_notes || null,
        created_by_user_id: req.userId,
      })
      .select()
      .single();

    if (insertErr) {
      console.error("[AdminDemos] Insert failed:", insertErr.message);
      if (agentResult.success && agentResult.agentId) {
        await deleteAgent(agentResult.agentId).catch(() => {});
      }
      return res.status(500).json({ error: "Failed to create demo" });
    }

    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId,
      action: "admin.demo.create",
      resourceType: "preview_demo",
      resourceId: demoBusinessId,
      metadata: { demo_label, business_name, industry, expires_in_days },
      ...meta,
    });

    console.log(
      "[AdminDemos] Created sales demo:",
      demoBusinessId,
      "agent:",
      agentResult.agentId,
      "by:",
      req.userId,
    );

    return res.json({
      success: true,
      demo: {
        id: inserted.id,
        demo_business_id: demoBusinessId,
        demo_agent_id: agentResult.success ? agentResult.agentId : null,
        agent_ready: agentResult.success,
        demo_label,
        business_name,
        industry,
        website: website || null,
        expires_at: expiresAt.toISOString(),
        share_url: `${publicBaseUrl()}/demo/${demoBusinessId}`,
        share_notes: share_notes || null,
        status: "active" as const,
      },
    });
  } catch (e: any) {
    console.error("[AdminDemos] Create error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
});

router.post(
  "/demos/:id/revoke",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      return res.status(500).json({ error: "Database unavailable" });
    }

    const demoBusinessId = req.params.id;
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : "";

    try {
      const { data: demo, error: fetchErr } = await supabase
        .from("preview_demos")
        .select("id, demo_business_id, demo_agent_id, is_persistent, revoked_at")
        .eq("demo_business_id", demoBusinessId)
        .maybeSingle();

      if (fetchErr || !demo) {
        return res.status(404).json({ error: "Demo not found" });
      }
      if (!demo.is_persistent) {
        return res
          .status(400)
          .json({ error: "Only persistent sales demos can be revoked here" });
      }
      if (demo.revoked_at) {
        return res.status(400).json({ error: "Demo already revoked" });
      }

      // Atomically claim the revoke by conditionally setting revoked_at only
      // if it's still NULL. This serializes concurrent revoke requests so
      // exactly one wins, and ensures the public /preview endpoint stops
      // serving the demo before we attempt agent teardown (so even if the
      // ElevenLabs delete fails, the demo is already gated off).
      const revokedAt = new Date().toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("preview_demos")
        .update({
          revoked_at: revokedAt,
          revoke_reason: reason || null,
        })
        .eq("id", demo.id)
        .is("revoked_at", null)
        .select("id")
        .maybeSingle();

      if (claimErr) {
        console.error("[AdminDemos] Revoke claim failed:", claimErr.message);
        return res.status(500).json({ error: "Failed to revoke demo" });
      }
      if (!claimed) {
        // Another request claimed it first.
        return res.status(409).json({ error: "Demo already revoked" });
      }

      // Now tear down the ElevenLabs agent. If this fails the demo is still
      // safely revoked in DB; we surface a warning so ops can manually
      // reconcile the orphan agent.
      let agentTorndown = true;
      let agentError: string | null = null;
      if (demo.demo_agent_id) {
        try {
          await deleteAgent(demo.demo_agent_id);
        } catch (e: any) {
          agentTorndown = false;
          agentError = e?.message || "unknown";
          console.warn(
            "[AdminDemos] Agent delete failed for",
            demo.demo_agent_id,
            "(demo is still revoked in DB):",
            agentError,
          );
        }
      }

      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId,
        action: "admin.demo.revoke",
        resourceType: "preview_demo",
        resourceId: demoBusinessId,
        metadata: {
          reason: reason || null,
          agent_torndown: agentTorndown,
          agent_error: agentError,
        },
        ...meta,
      });

      console.log(
        "[AdminDemos] Revoked sales demo:",
        demoBusinessId,
        "by:",
        req.userId,
        "agent_torndown=",
        agentTorndown,
      );

      return res.json({ success: true, agent_torndown: agentTorndown });
    } catch (e: any) {
      console.error("[AdminDemos] Revoke error:", e.message);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/admin/audit-logs
//
// Sprint 5 — Read-only viewer over the existing audit_logs table. The
// auditLog() middleware in middlewares/audit.ts is the sole writer; this
// endpoint never inserts/updates/deletes. It exists so procurement and
// compliance teams can review the trail without raw SQL.
//
// Filters (all optional):
//   business_id : exact match on the tenant
//   action      : exact match on action key (e.g. 'auth.login', 'config.update')
//   from / to   : ISO timestamps for created_at range
//   limit       : default 100, max 500
//   offset      : pagination offset
//
// Response: { logs, total, limit, offset }. Columns are SELECT *, so any
// columns added by future migrations surface automatically without code
// changes here. Frontend treats unknown columns as opaque metadata.
// ---------------------------------------------------------------------------
router.get(
  "/audit-logs",
  requireAuth,
  // Gate on Neverr back-office staff RBAC (or pre-bootstrap tenant-owner).
  // Historically the rest of the /admin/* surface used a thin
  // `requireAdminRole` helper that only checked `req.isAdmin` (per-tenant
  // owner/admin role) and was deleted in the security hotfix that landed
  // alongside this comment. /audit-logs was always on
  // `requireStaffOrBootstrap` because the per-tenant check would have let
  // any paying customer (tenant owner/admin) read every other tenant's
  // audit trail. Same gate the staff-management endpoints
  // (e.g. /admin/users/*) use.
  requireStaffOrBootstrap("read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(503).json({ error: "Database unavailable" });
      }

      const limit = Math.min(
        500,
        Math.max(1, parseInt(String(req.query.limit ?? "100"), 10) || 100),
      );
      const offset = Math.max(
        0,
        parseInt(String(req.query.offset ?? "0"), 10) || 0,
      );
      const businessId = req.query.business_id
        ? String(req.query.business_id)
        : null;
      const action = req.query.action ? String(req.query.action) : null;
      const fromRaw = req.query.from ? String(req.query.from) : null;
      const toRaw = req.query.to ? String(req.query.to) : null;

      // Validate from/to as parseable timestamps — otherwise Postgres throws
      // a parse error and we'd surface a 500 with the raw DB message.
      function parseDate(label: string, raw: string): string {
        const d = new Date(raw);
        if (isNaN(d.getTime())) {
          const err: any = new Error(
            `Invalid ${label} timestamp; use ISO 8601 (e.g. 2026-01-01T00:00:00Z)`,
          );
          err.statusCode = 400;
          throw err;
        }
        return d.toISOString();
      }
      const fromDate = fromRaw ? parseDate("from", fromRaw) : null;
      const toDate = toRaw ? parseDate("to", toRaw) : null;

      // Production audit_logs uses `timestamp` (not `created_at`) as the
      // event-time column. Verified empirically against a row sample —
      // the auditLog() middleware writes no timestamp itself and relies
      // on the DB default. Sorting/filtering both reference `timestamp`.
      let query = (supabase as any)
        .from("audit_logs")
        .select("*", { count: "exact" })
        .order("timestamp", { ascending: false })
        .range(offset, offset + limit - 1);

      if (businessId) query = query.eq("business_id", businessId);
      if (action) query = query.eq("action", action);
      if (fromDate) query = query.gte("timestamp", fromDate);
      if (toDate) query = query.lte("timestamp", toDate);

      const { data, error, count } = await query;
      if (error) throw new Error(error.message);

      return res.json({
        logs: data || [],
        total: typeof count === "number" ? count : data?.length || 0,
        limit,
        offset,
      });
    } catch (e: any) {
      const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
      // Log the raw cause server-side; never leak a DB error string to the
      // client (info-disclosure). Only echo the message on 4xx where it's
      // a validation hint we deliberately surface.
      console.error("[AdminAuditLogs] List error:", e.message);
      return res
        .status(status)
        .json(status >= 500 ? { error: "server_error" } : { error: e.message });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/reconcile-twilio
// ---------------------------------------------------------------------------
// Manual trigger for the Twilio number reconciliation that otherwise
// runs nightly via the cron in src/index.ts (Sprint 2 / Batch C —
// audit risk #3, orphan / ghost DIDs).
//
// Accepts optional body:
//   { dryRun?: boolean;             // default false — skip writes/releases/email
//     autoRelease?: boolean;        // default true  — release orphans past threshold
//     autoReleaseMinAgeHours?: number } // default 24    — minimum orphan age
//
// dryRun lets an admin preview "what would happen" before triggering a
// live run that releases DIDs. The returned report shape is the same
// either way.
//
// Auth: requireAuth + requireStaffPermission("customers", "admin").
// Strongest action tier — touches external paid services (Twilio
// number provisioning + release), can spend money, irrecoverable
// side effects. Strict-match: caller must have "admin" explicitly
// in user_roles.permissions.customers (super_admin has it by default;
// regular admin role does NOT).
router.post(
  "/reconcile-twilio",
  requireAuth,
  requireStaffPermission("customers", "admin"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    try {
      const body = (req.body || {}) as {
        dryRun?: unknown;
        autoRelease?: unknown;
        autoReleaseMinAgeHours?: unknown;
      };

      const opts = {
        dryRun: typeof body.dryRun === "boolean" ? body.dryRun : false,
        autoRelease:
          typeof body.autoRelease === "boolean" ? body.autoRelease : true,
        autoReleaseMinAgeHours:
          typeof body.autoReleaseMinAgeHours === "number" &&
          body.autoReleaseMinAgeHours >= 0
            ? body.autoReleaseMinAgeHours
            : 24,
      };

      // Dynamic import to keep this admin route file lean of imports
      // (most admin endpoints don't touch reconciliation).
      const { runReconciliation } = await import(
        "../lib/twilio-reconciliation.js"
      );
      const report = await runReconciliation(opts);

      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: opts.dryRun
          ? "admin.reconcile_twilio.dry_run"
          : "admin.reconcile_twilio.run",
        resource: "twilio_provisioning",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          opts,
          twilioNumbersCount: report.twilioNumbersCount,
          dbNumbersCount: report.dbNumbersCount,
          orphansCount: report.orphans.length,
          ghostsCount: report.ghosts.length,
          orphansAutoReleasedCount: report.orphansAutoReleasedCount,
          stageErrorsCount: report.errors.length,
        },
      });

      return res.json(report);
    } catch (e: any) {
      console.error("[AdminReconcileTwilio] Run failed:", e?.message ?? e);
      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "admin.reconcile_twilio.run",
        resource: "twilio_provisioning",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: { error: String(e?.message ?? e) },
      });
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/provision/:businessId
// ---------------------------------------------------------------------------
// Manual Twilio DID provisioning for an existing business — primarily for
// pre-Sprint-2 businesses (e.g. EZ Rentals biz_1779288494109_z4z979) whose
// row exists but never went through the auto-provision-on-signup path, and
// for re-attempts after a soft-fail at signup.
//
// Body: { areaCode?: string } — optional 3-digit override. If omitted, the
// area code is extracted from the business's existing phone_number (the
// scraped landline). Falls back to "443" if both extraction and the body
// override are absent / invalid.
//
// The underlying provisionTwilioNumberForBusiness is idempotent: if the
// business already has a twilio_phone_number, the existing value is
// returned without re-purchasing. See twilio-provisioning.ts JSDoc.
// Auth: requireAuth + requireStaffPermission("customers", "admin").
// Strongest action tier — provisions/purchases Twilio DIDs (real
// money). Strict-match: see /reconcile-twilio above for rationale.
router.post(
  "/provision/:businessId",
  requireAuth,
  requireStaffPermission("customers", "admin"),
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    // Express's typing for this codebase widens `req.params.X` to
    // string|string[]; the existing admin endpoints rely on positional
    // params being strings at runtime. Explicit String() coerce so the
    // value is type-safe to pass downstream.
    const targetBusinessId = String(req.params.businessId);

    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(503).json({ error: "Database unavailable" });
      }
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res.status(400).json({ error: "businessId path param required" });
      }

      // Look up the business to verify it exists and to grab phone_number
      // for area-code extraction. Cheap defensive read.
      const { data: biz, error: lookupErr } = await supabase
        .from("business_configs")
        .select("business_id, business_name, phone_number")
        .eq("business_id", targetBusinessId)
        .maybeSingle();

      if (lookupErr) {
        console.error("[AdminProvision] Lookup error:", lookupErr.message);
        return res.status(500).json({ error: "server_error" });
      }
      if (!biz) {
        return res.status(404).json({ error: "business_not_found" });
      }

      // Determine area code: explicit body override → extract from
      // phone_number → '443' default. The body override is validated as
      // a 3-digit string; anything else falls through to extraction.
      const body = (req.body || {}) as { areaCode?: unknown };
      const { extractAreaCodeFromPhoneNumber } = await import(
        "../lib/phone-utils.js"
      );
      let areaCode: string;
      if (typeof body.areaCode === "string" && /^\d{3}$/.test(body.areaCode)) {
        areaCode = body.areaCode;
      } else {
        const extracted = extractAreaCodeFromPhoneNumber(biz.phone_number);
        areaCode = extracted ?? "443";
      }

      const { provisionTwilioNumberForBusiness, TwilioProvisioningError } =
        await import("../lib/twilio-provisioning.js");

      try {
        const result = await provisionTwilioNumberForBusiness(
          targetBusinessId,
          areaCode,
        );
        await auditLog({
          userId: req.userId,
          businessId: req.businessId,
          action: "admin.provision.run",
          resource: "twilio_provisioning",
          success: true,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          details: {
            targetBusinessId,
            requestedAreaCode: areaCode,
            fulfilledAreaCode: result.areaCode,
            phoneNumber: result.phoneNumber,
            twilioSid: result.twilioSid,
          },
        });
        return res.json({ success: true, ...result });
      } catch (err) {
        if (err instanceof TwilioProvisioningError) {
          await auditLog({
            userId: req.userId,
            businessId: req.businessId,
            action: "admin.provision.failed",
            resource: "twilio_provisioning",
            success: false,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
            details: {
              targetBusinessId,
              requestedAreaCode: areaCode,
              subcode: err.subcode,
              message: err.message,
            },
          });
          return res.status(500).json({
            success: false,
            subcode: err.subcode,
            message: err.message,
          });
        }
        throw err;
      }
    } catch (e: any) {
      console.error("[AdminProvision] Run failed:", e?.message ?? e);
      await auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "admin.provision.failed",
        resource: "twilio_provisioning",
        success: false,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        details: {
          targetBusinessId,
          error: String(e?.message ?? e),
        },
      });
      return res
        .status(500)
        .json({ success: false, message: "server_error" });
    }
  },
);

export default router;
