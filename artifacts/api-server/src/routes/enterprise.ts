import { Router, type IRouter, type Request, type Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  requireAuth,
  requirePermission,
  enterpriseIPFilter,
} from "../middlewares/auth.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";
import { contactPool } from "./api.js";
import type {
  AnalyticsAlert,
  AnalyticsMetrics,
  AnalyticsTimeRange,
  BulkLocationInput,
  BulkUserInput,
  CRMIntegration,
  CustomReport,
  EnterpriseAnalytics,
  EnterpriseBusiness,
  EnterpriseWebhook,
  LocationHierarchy,
  LocationLevel,
} from "../types/enterprise.js";
import { SalesforceConnector } from "../integrations/salesforce.js";
import { ComplianceReporter } from "../analytics/compliance.js";
import { PIIProcessor } from "../security/pii.js";
import { DataRetentionManager, type RetentionConfig } from "../security/retention.js";
import * as crypto from "crypto";

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

interface CreatedLocationRow {
  id: string;
  business_id: string;
  location_name: string;
  address: string | null;
  phone_number: string | null;
  agent_name: string | null;
  timezone: string | null;
  business_hours: unknown;
  is_primary: boolean;
  active: boolean;
  created_at: string;
  parent_id?: string | null;
  level?: string | null;
  location_code?: string | null;
}

/**
 * Insert a single location row into the local PG `locations` table. Maps
 * the rich enterprise LocationHierarchy shape onto the existing columns
 * and stashes the extra hierarchy metadata (level, parent_id, location_code,
 * managers, customizations) into `business_hours` JSON's `_enterprise` key
 * so we don't need a schema migration to start using the API.
 */
async function createLocation(input: LocationHierarchy): Promise<CreatedLocationRow> {
  const primaryPhone =
    input.phoneNumbers?.find((p) => p.type === "main")?.number ||
    input.phoneNumbers?.[0]?.number ||
    "";
  const addressString = input.address
    ? [input.address.street, input.address.city, input.address.state, input.address.zipCode, input.address.country]
        .filter(Boolean)
        .join(", ")
    : "";
  const enterpriseMeta = {
    _enterprise: {
      level: input.level,
      parentId: input.parentId,
      locationCode: input.locationCode,
      address: input.address,
      phoneNumbers: input.phoneNumbers,
      managers: input.managers,
      customizations: input.customizations,
      status: input.status,
    },
    ...(input.operatingHours || {}),
  };

  const { rows } = await contactPool.query<CreatedLocationRow>(
    `INSERT INTO locations (id, business_id, location_name, address, phone_number, agent_name, timezone, business_hours, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.id,
      input.businessId,
      input.name,
      addressString,
      primaryPhone,
      "Alex",
      "America/New_York",
      JSON.stringify(enterpriseMeta),
      input.status === "active",
    ],
  );
  return rows[0];
}

/**
 * Build a tree of locations rooted at the business. Reads from the local PG
 * `locations` table, lifts any `_enterprise` metadata stored in business_hours
 * JSON, and groups children by parentId. If no hierarchy info is present yet,
 * every active location is returned as a direct child of the business root.
 */
async function getLocationHierarchy(businessId: string) {
  const { rows } = await contactPool.query<CreatedLocationRow & { business_hours: any }>(
    `SELECT * FROM locations WHERE business_id = $1 ORDER BY created_at ASC`,
    [businessId],
  );

  const nodes = rows.map((r) => {
    const meta = (r.business_hours && typeof r.business_hours === "object" && r.business_hours._enterprise) || {};
    return {
      id: r.id,
      businessId: r.business_id,
      name: r.location_name,
      level: (meta.level as LocationLevel) || "store",
      parentId: meta.parentId || null,
      locationCode: meta.locationCode || r.id.slice(0, 8),
      status: r.active ? "active" : "inactive",
      address: meta.address || { full: r.address },
      phoneNumbers: meta.phoneNumbers || (r.phone_number ? [{ number: r.phone_number, type: "main" }] : []),
      managers: meta.managers || [],
      customizations: meta.customizations || {},
      isPrimary: r.is_primary,
      createdAt: r.created_at,
      children: [] as any[],
    };
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots: typeof nodes = [];
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId)) {
      byId.get(n.parentId)!.children.push(n);
    } else {
      roots.push(n);
    }
  }

  return {
    businessId,
    totalLocations: nodes.length,
    roots,
  };
}

interface CreatedEnterpriseUser {
  id: string;
  email: string;
  businessId: string;
  role: string;
}

/**
 * Provision a user via Supabase Auth admin and attach a membership row.
 * If the user already exists, the existing user is reused and only the
 * membership is upserted. Returns the canonical user id and role.
 */
async function createEnterpriseUser(
  supabase: SupabaseClient,
  businessId: string,
  user: BulkUserInput,
): Promise<CreatedEnterpriseUser> {
  if (!user.email) throw new Error("email is required");

  const role = user.role || "user";
  const inviteRes = await (supabase.auth.admin as any).inviteUserByEmail(user.email, {
    data: { name: user.name, businessId, role, phone: user.phone, department: user.department },
  });

  let userId: string | undefined = inviteRes?.data?.user?.id;
  const inviteErr = inviteRes?.error;
  if (inviteErr && !/already.*registered|already exists/i.test(inviteErr.message || "")) {
    throw new Error(inviteErr.message || "Failed to invite user");
  }

  if (!userId) {
    // User already existed — look them up to get the id
    const { data: existing } = await (supabase.auth.admin as any).listUsers({ page: 1, perPage: 200 });
    const found = existing?.users?.find((u: any) => u.email?.toLowerCase() === user.email.toLowerCase());
    if (!found) throw new Error("User exists but could not be located");
    userId = found.id;
  }

  await (supabase as any)
    .from("user_businesses")
    .upsert(
      { user_id: userId, business_id: businessId, role },
      { onConflict: "user_id,business_id" },
    );

  return { id: userId!, email: user.email, businessId, role };
}

/**
 * Apply an enterprise configuration patch to the `business_configs` Supabase
 * row (Sprint 5 Phase 2 — repointed from the nonexistent `businesses` table
 * to business_configs after migration 012 added the dedicated columns).
 *
 * Mapping:
 *   patch.brandingConfig          → business_configs.branding_config (JSONB)
 *   patch.securityPolicy          → business_configs.security_policy (JSONB)
 *     ↳ .mfaRequired              → business_configs.mfa_required (BOOL)
 *     ↳ .allowedIPs               → business_configs.ip_whitelist (JSONB)
 *   patch.ipWhitelist (top-level) → business_configs.ip_whitelist (JSONB)
 *   patch.mfaRequired (top-level) → business_configs.mfa_required (BOOL)
 *   patch.slaLevel                → business_configs.sla_level (TEXT, enum)
 *   patch.isolation               → business_configs.isolation_model (TEXT, enum)
 *   patch.isolationModel          → business_configs.isolation_model (TEXT, enum)
 *   patch.parentBusinessId        → business_configs.parent_business_id (TEXT)
 *   patch.ssoConfig               → business_configs.sso_config (JSONB)
 *   <anything else>               → business_configs.enterprise_config (JSONB
 *                                    — atomic merge via PG `||` operator,
 *                                    preserves prior keys)
 *
 * The CHECK constraints on sla_level + isolation_model (added in migration
 * 012) reject invalid enum values at the DB layer. We catch PG error code
 * 23514 and rethrow with statusCode=400 so the handler returns a clean 4xx
 * instead of a generic 500.
 *
 * Uses the Supabase JS client (not contactPool) because business_configs
 * lives in the Supabase project DB, not in the Replit-managed pg DB that
 * contactPool connects to (DATABASE_URL host: `helium`, SUPABASE_URL host:
 * `*.supabase.co` — verified separate). For the enterprise_config catch-all
 * merge, this means a read-then-write pair instead of an atomic PG `||`
 * concat. That race is acceptable for this admin-only endpoint where
 * concurrent writes are vanishingly rare.
 *
 * CHECK constraint violations from migration 012 (sla_level / isolation_model
 * enum guards) come back through Supabase JS as `error.code === '23514'`.
 * We rethrow with statusCode=400 so the handler returns a clean 4xx instead
 * of an opaque 500.
 */
async function updateEnterpriseConfig(
  supabase: SupabaseClient,
  businessId: string,
  patch: Partial<EnterpriseBusiness> & Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Build the dedicated-column update payload. Use `!== undefined` so
  // explicit null clears the column (PATCH semantics) but omitted keys
  // leave it alone.
  const update: Record<string, unknown> = {};

  if (patch.brandingConfig !== undefined) {
    update.branding_config = patch.brandingConfig;
  }
  if (patch.securityPolicy !== undefined) {
    update.security_policy = patch.securityPolicy;
    // Convenience side-effects when securityPolicy is a non-null object.
    if (patch.securityPolicy && typeof patch.securityPolicy === "object") {
      update.mfa_required = !!(patch.securityPolicy as any).mfaRequired;
      if ((patch.securityPolicy as any).allowedIPs !== undefined) {
        update.ip_whitelist = (patch.securityPolicy as any).allowedIPs || [];
      }
    }
  }
  // Top-level overrides win if both nested and top-level forms were sent.
  if ((patch as any).ipWhitelist !== undefined) {
    update.ip_whitelist = (patch as any).ipWhitelist;
  }
  if ((patch as any).mfaRequired !== undefined) {
    update.mfa_required = !!(patch as any).mfaRequired;
  }
  if (patch.slaLevel !== undefined) {
    update.sla_level = patch.slaLevel;
  }
  // Accept both `isolation` (legacy / EnterpriseBusiness type) and
  // `isolationModel` (new explicit name). Last-write-wins.
  if (patch.isolation !== undefined) {
    update.isolation_model = patch.isolation;
  }
  if ((patch as any).isolationModel !== undefined) {
    update.isolation_model = (patch as any).isolationModel;
  }
  if (patch.parentBusinessId !== undefined) {
    update.parent_business_id = patch.parentBusinessId;
  }
  if ((patch as any).ssoConfig !== undefined) {
    update.sso_config = (patch as any).ssoConfig;
  }

  // Catch-all: any unrecognized key gets merged into enterprise_config JSONB
  // via read-then-write (Supabase JS has no native JSONB concat helper).
  const KNOWN_KEYS = new Set([
    "brandingConfig",
    "securityPolicy",
    "ipWhitelist",
    "mfaRequired",
    "slaLevel",
    "isolation",
    "isolationModel",
    "parentBusinessId",
    "ssoConfig",
  ]);
  const catchAll: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!KNOWN_KEYS.has(k) && v !== undefined) catchAll[k] = v;
  }
  if (Object.keys(catchAll).length > 0) {
    const { data: existing, error: readErr } = await (supabase as any)
      .from("business_configs")
      .select("enterprise_config")
      .eq("business_id", businessId)
      .maybeSingle();
    if (readErr && readErr.code !== "PGRST116") {
      throw new Error(readErr.message);
    }
    const prior = (existing?.enterprise_config as Record<string, unknown>) || {};
    update.enterprise_config = { ...prior, ...catchAll };
  }

  if (Object.keys(update).length === 0) {
    // No-op patch — read current row and return it for response shape parity.
    const { data: row } = await (supabase as any)
      .from("business_configs")
      .select("*")
      .eq("business_id", businessId)
      .maybeSingle();
    return row || { business_id: businessId };
  }

  update.updated_at = new Date().toISOString();

  const { data, error } = await (supabase as any)
    .from("business_configs")
    .update(update)
    .eq("business_id", businessId)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23514") {
      // PG CHECK constraint violation — sla_level or isolation_model enum.
      // Surface as a 400 instead of bubbling up as a generic 500.
      const e: any = new Error(
        `Invalid value rejected by CHECK constraint: ${error.details || error.message}`,
      );
      e.statusCode = 400;
      throw e;
    }
    throw new Error(error.message);
  }
  return data || { business_id: businessId };
}

// ---- Routes ----

router.post(
  "/bulk/locations",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("settings", "admin"),
  async (req: Request, res: Response) => {
    const businessId = req.businessId || "";
    const locations: BulkLocationInput[] = req.body?.locations || [];
    if (!Array.isArray(locations) || locations.length === 0) {
      res.status(400).json({ error: "locations array is required" });
      return;
    }

    const meta = extractRequestMeta(req);
    const results: Array<Record<string, unknown>> = [];

    for (const loc of locations) {
      try {
        const data: LocationHierarchy = {
          id: uuidv4(),
          businessId,
          parentId: loc.parentId,
          level: loc.level || "store",
          locationCode: loc.locationCode,
          name: loc.name,
          address: loc.address || { street: "", city: "", state: "", zipCode: "", country: "US" },
          phoneNumbers: loc.phoneNumbers || [],
          operatingHours: (loc.operatingHours as any) || {
            monday: { open: "09:00", close: "17:00", closed: false },
            tuesday: { open: "09:00", close: "17:00", closed: false },
            wednesday: { open: "09:00", close: "17:00", closed: false },
            thursday: { open: "09:00", close: "17:00", closed: false },
            friday: { open: "09:00", close: "17:00", closed: false },
            saturday: { open: "09:00", close: "13:00", closed: false },
            sunday: { open: "00:00", close: "00:00", closed: true },
            holidays: [],
          },
          customizations: loc.customizations || {},
          managers: loc.managers || [],
          status: "active",
        };
        const created = await createLocation(data);
        results.push({ success: true, locationId: created.id, locationCode: loc.locationCode });
        void auditLog({
          userId: req.userId,
          businessId,
          action: "location.created.bulk",
          resource: "settings",
          resourceId: created.id,
          success: true,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          sessionId: req.sessionId,
          complianceFlags: ["DATA-CREATION"],
        });
      } catch (err: any) {
        results.push({ success: false, error: err.message, locationCode: loc.locationCode });
      }
    }

    res.json({
      results,
      total: locations.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    });
  },
);

router.post(
  "/bulk/users",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("users", "admin"),
  async (req: Request, res: Response) => {
    const businessId = req.businessId || "";
    const users: BulkUserInput[] = req.body?.users || [];
    if (!Array.isArray(users) || users.length === 0) {
      res.status(400).json({ error: "users array is required" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured" });
      return;
    }

    const meta = extractRequestMeta(req);
    const results: Array<Record<string, unknown>> = [];

    for (const user of users) {
      try {
        const created = await createEnterpriseUser(supabase, businessId, user);
        results.push({ success: true, userId: created.id, email: user.email, role: created.role });
        void auditLog({
          userId: req.userId,
          businessId,
          action: "user.created.bulk",
          resource: "users",
          resourceId: created.id,
          success: true,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          sessionId: req.sessionId,
          complianceFlags: ["USER-PROVISIONING"],
        });
      } catch (err: any) {
        results.push({ success: false, error: err.message, email: user.email });
      }
    }

    res.json({
      results,
      total: users.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    });
  },
);

router.get(
  "/hierarchy",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    try {
      const hierarchy = await getLocationHierarchy(req.businessId || "");
      res.json(hierarchy);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.put(
  "/config",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("settings", "admin"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Supabase not configured" });
      return;
    }
    try {
      const config = (req.body || {}) as Partial<EnterpriseBusiness>;
      const updated = await updateEnterpriseConfig(supabase, req.businessId || "", config);
      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId: req.businessId,
        action: "enterprise.config.updated",
        resource: "settings",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { updatedFields: Object.keys(config) },
        complianceFlags: ["CONFIG-CHANGE"],
      });
      res.json(updated);
    } catch (err: any) {
      // Phase 2: updateEnterpriseConfig sets err.statusCode = 400 on PG
      // CHECK constraint violations (sla_level / isolation_model enum
      // guards from migration 012). Honor it so the client gets a clean
      // 400 instead of an opaque 500.
      const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
      res.status(status).json({ error: err.message });
    }
  },
);

// =====================================================================
// CRM integrations + Webhook management
// =====================================================================

/**
 * Lazy-create the local PG tables that back CRM integrations and webhooks.
 * Runs once on first use; subsequent calls are cheap no-ops because of
 * IF NOT EXISTS. Credentials are stored encrypted at rest when an
 * INTEGRATION_ENC_KEY env var is provided; otherwise they fall back to
 * base64 (dev only) and a warning is logged.
 */
let _tablesReady: Promise<void> | null = null;
async function ensureCRMTables(): Promise<void> {
  if (_tablesReady) return _tablesReady;
  _tablesReady = (async () => {
    await contactPool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_crm_integrations (
        id UUID PRIMARY KEY,
        business_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        credentials_enc TEXT NOT NULL,
        sync_enabled BOOLEAN DEFAULT FALSE,
        sync_fields JSONB DEFAULT '[]'::jsonb,
        automation_rules JSONB DEFAULT '[]'::jsonb,
        last_sync TIMESTAMPTZ,
        status TEXT DEFAULT 'inactive',
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await contactPool.query(
      `CREATE INDEX IF NOT EXISTS idx_crm_biz ON enterprise_crm_integrations (business_id)`,
    );
    await contactPool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_webhooks (
        id UUID PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events JSONB DEFAULT '[]'::jsonb,
        authentication TEXT DEFAULT 'none',
        auth_config JSONB DEFAULT '{}'::jsonb,
        retry_policy JSONB DEFAULT '{}'::jsonb,
        headers JSONB DEFAULT '{}'::jsonb,
        enabled BOOLEAN DEFAULT TRUE,
        last_delivery TIMESTAMPTZ,
        failure_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await contactPool.query(
      `CREATE INDEX IF NOT EXISTS idx_webhooks_biz ON enterprise_webhooks (business_id)`,
    );
  })();
  return _tablesReady;
}

function getEncKey(): Buffer | null {
  const raw = process.env.INTEGRATION_ENC_KEY;
  if (!raw) return null;
  // Accept either a 64-char hex string or any string ≥32 chars (we'll hash it).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest();
}

function encryptCredentials(creds: unknown): string {
  const key = getEncKey();
  const json = JSON.stringify(creds);
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.warn("[CRM] INTEGRATION_ENC_KEY not set — credentials stored base64 (NOT secure)");
    }
    return `b64:${Buffer.from(json, "utf8").toString("base64")}`;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `aes:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decryptCredentials(blob: string): Record<string, unknown> {
  if (blob.startsWith("b64:")) {
    return JSON.parse(Buffer.from(blob.slice(4), "base64").toString("utf8"));
  }
  if (blob.startsWith("aes:")) {
    const key = getEncKey();
    if (!key) throw new Error("INTEGRATION_ENC_KEY missing — cannot decrypt credentials");
    const [, ivB64, tagB64, encB64] = blob.split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
    return JSON.parse(dec.toString("utf8"));
  }
  throw new Error("Unknown credential blob format");
}

function toCRMIntegration(row: any): CRMIntegration {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    credentials: decryptCredentials(row.credentials_enc),
    syncEnabled: !!row.sync_enabled,
    syncFields: row.sync_fields || [],
    automationRules: row.automation_rules || [],
    lastSync: row.last_sync ? new Date(row.last_sync).toISOString() : undefined,
    status: row.status || "inactive",
    errorMessage: row.error_message || undefined,
  };
}

async function saveCRMIntegration(integration: CRMIntegration): Promise<CRMIntegration> {
  await ensureCRMTables();
  const credEnc = encryptCredentials(integration.credentials);
  await contactPool.query(
    `INSERT INTO enterprise_crm_integrations
       (id, business_id, provider, credentials_enc, sync_enabled, sync_fields, automation_rules, status, error_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       provider = EXCLUDED.provider,
       credentials_enc = EXCLUDED.credentials_enc,
       sync_enabled = EXCLUDED.sync_enabled,
       sync_fields = EXCLUDED.sync_fields,
       automation_rules = EXCLUDED.automation_rules,
       status = EXCLUDED.status,
       error_message = EXCLUDED.error_message,
       updated_at = NOW()`,
    [
      integration.id,
      integration.businessId,
      integration.provider,
      credEnc,
      integration.syncEnabled,
      JSON.stringify(integration.syncFields || []),
      JSON.stringify(integration.automationRules || []),
      integration.status,
      integration.errorMessage || null,
    ],
  );
  // Return without secrets in the response
  return {
    ...integration,
    credentials: { instanceUrl: integration.credentials.instanceUrl, clientId: integration.credentials.clientId },
  };
}

async function getCRMIntegration(id: string, businessId: string): Promise<CRMIntegration | null> {
  await ensureCRMTables();
  const { rows } = await contactPool.query(
    `SELECT * FROM enterprise_crm_integrations WHERE id = $1 AND business_id = $2`,
    [id, businessId],
  );
  return rows[0] ? toCRMIntegration(rows[0]) : null;
}

async function saveWebhook(webhook: EnterpriseWebhook): Promise<EnterpriseWebhook> {
  await ensureCRMTables();
  await contactPool.query(
    `INSERT INTO enterprise_webhooks
       (id, business_id, name, url, events, authentication, auth_config, retry_policy, headers, enabled, failure_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      webhook.id,
      webhook.businessId,
      webhook.name,
      webhook.url,
      JSON.stringify(webhook.events || []),
      webhook.authentication || "none",
      JSON.stringify(webhook.authConfig || {}),
      JSON.stringify(webhook.retryPolicy || { maxRetries: 3, backoffStrategy: "exponential", retryDelays: [1, 5, 30], deadLetterQueue: true }),
      JSON.stringify(webhook.headers || {}),
      webhook.enabled !== false,
      webhook.failureCount || 0,
    ],
  );
  return webhook;
}

async function getCallData(callId: string, businessId: string): Promise<Record<string, unknown> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await (supabase as any)
    .from("calls")
    .select("call_sid, caller_name, caller_number, summary, sentiment, duration_seconds, business_id")
    .eq("call_sid", callId)
    .eq("business_id", businessId)
    .maybeSingle();
  return data || null;
}

// ---- CRM Routes ----

router.post(
  "/integrations/crm",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("integrations", "admin"),
  async (req: Request, res: Response) => {
    const businessId = req.businessId || "";
    const body = (req.body || {}) as Partial<CRMIntegration>;
    if (!body.provider || !body.credentials) {
      res.status(400).json({ error: "provider and credentials are required" });
      return;
    }

    const integration: CRMIntegration = {
      id: uuidv4(),
      businessId,
      provider: body.provider,
      credentials: body.credentials,
      syncEnabled: !!body.syncEnabled,
      syncFields: body.syncFields || [],
      automationRules: body.automationRules || [],
      status: "inactive",
    };

    try {
      if (integration.provider === "salesforce") {
        const connector = new SalesforceConnector(integration);
        const ok = await connector.authenticate();
        if (!ok) {
          res.status(400).json({ error: "Failed to authenticate with Salesforce" });
          return;
        }
        integration.status = "active";
      } else {
        // Other providers: persist as inactive until a provider-specific test is run.
        integration.status = "inactive";
      }

      const saved = await saveCRMIntegration(integration);
      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: "crm.integration.created",
        resource: "integrations",
        resourceId: saved.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { provider: integration.provider },
        complianceFlags: ["INTEGRATION-SETUP"],
      });
      res.json(saved);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/integrations/crm/:id/trigger",
  requireAuth,
  requirePermission("integrations", "write"),
  async (req: Request, res: Response) => {
    const businessId = req.businessId || "";
    const { id } = req.params;
    const { callId, action, contactId, assignedTo } = (req.body || {}) as {
      callId?: string;
      action?: "create_lead" | "update_contact" | "create_task";
      contactId?: string;
      assignedTo?: string;
    };

    if (!action) {
      res.status(400).json({ error: "action is required" });
      return;
    }

    // Validate UUID format before hitting the DB. Without this, malformed
    // ids cause Postgres 22P02 (invalid_text_representation) → unhandled
    // 500. We deliberately return 404 (not 400) to avoid leaking whether
    // the format was invalid vs the row doesn't exist.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(id)) {
      res.status(404).json({ error: "CRM integration not found" });
      return;
    }

    try {
      const integration = await getCRMIntegration(id, businessId);
      if (!integration) {
        res.status(404).json({ error: "CRM integration not found" });
        return;
      }
      const callData = callId ? await getCallData(callId, businessId) : null;

      let result: string | boolean | null = null;
      if (integration.provider === "salesforce") {
        const connector = new SalesforceConnector(integration);
        if (action === "create_lead") result = await connector.createLead(callData || {});
        else if (action === "update_contact" && contactId) {
          result = await connector.updateContact(contactId, callData || {});
        } else if (action === "create_task") result = await connector.createTask(callData || {}, assignedTo);
        else {
          res.status(400).json({ error: "Invalid action for salesforce" });
          return;
        }
      } else {
        res.status(400).json({ error: `Provider ${integration.provider} not yet implemented` });
        return;
      }

      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: `crm.${action}.triggered`,
        resource: "integrations",
        resourceId: id,
        success: !!result,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { callId, crmResult: result },
      });
      res.json({ success: !!result, result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/webhooks",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("integrations", "admin"),
  async (req: Request, res: Response) => {
    const businessId = req.businessId || "";
    const body = (req.body || {}) as Partial<EnterpriseWebhook>;
    if (!body.url || !body.name) {
      res.status(400).json({ error: "name and url are required" });
      return;
    }

    const webhook: EnterpriseWebhook = {
      id: uuidv4(),
      businessId,
      name: body.name,
      url: body.url,
      events: body.events || [],
      authentication: body.authentication || "none",
      authConfig: body.authConfig || {},
      retryPolicy: body.retryPolicy || {
        maxRetries: 3,
        backoffStrategy: "exponential",
        retryDelays: [1, 5, 30],
        deadLetterQueue: true,
      },
      headers: body.headers || {},
      enabled: body.enabled !== false,
      failureCount: 0,
    };

    // Reachability test with a 5s timeout
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const testResp = await fetch(webhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...webhook.headers },
        body: JSON.stringify({
          test: true,
          webhook_id: webhook.id,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!testResp.ok) {
        res.status(400).json({ error: "Webhook URL test failed", status: testResp.status });
        return;
      }
    } catch (err: any) {
      res.status(400).json({ error: `Webhook URL unreachable: ${err.message}` });
      return;
    }

    try {
      const saved = await saveWebhook(webhook);
      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: "webhook.created",
        resource: "integrations",
        resourceId: saved.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        complianceFlags: ["WEBHOOK-CONFIG"],
      });
      res.json(saved);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// =====================================================================
// Enterprise analytics + custom reporting + compliance reports
// =====================================================================

/** Parse "24h" / "7d" / "4w" / "30d" into milliseconds. Defaults to 24h. */
function parseTimeRange(range: string): number {
  const m = /^(\d+)([hdw])$/.exec(range || "");
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    case "w": return n * 7 * 86_400_000;
    default: return 24 * 60 * 60 * 1000;
  }
}

/** Convert a Supabase rows array of calls into AnalyticsMetrics. */
function rowsToMetrics(rows: any[]): AnalyticsMetrics {
  const totalCalls = rows.length;
  const answered = rows.filter((r) => (r.duration_seconds ?? 0) > 0);
  const answeredCalls = answered.length;
  const missedCalls = totalCalls - answeredCalls;
  const avgDuration = answered.length
    ? Math.round(answered.reduce((s, r) => s + (r.duration_seconds || 0), 0) / answered.length)
    : 0;
  const appointments = rows.filter(
    (r) => r.appointment_booked === true || r.call_outcome === "appointment_booked",
  ).length;
  const positiveLeads = rows.filter((r) => r.sentiment === "positive").length;
  const leadsGenerated = appointments + positiveLeads;
  // Treat sentiment as a 1-5 proxy: positive=5, neutral=3.5, negative=1.5
  const sentScore = (s: string | null) =>
    s === "positive" ? 5 : s === "negative" ? 1.5 : 3.5;
  const csat = answered.length
    ? Number(
        (answered.reduce((s, r) => s + sentScore(r.sentiment), 0) / answered.length).toFixed(2),
      )
    : 0;
  // Bucket peak by hour-of-day
  const hourBuckets: Record<string, number> = {};
  for (const r of rows) {
    if (!r.start_time) continue;
    const h = new Date(r.start_time).getUTCHours();
    hourBuckets[h] = (hourBuckets[h] || 0) + 1;
  }
  const peak = Object.values(hourBuckets).reduce((a, b) => Math.max(a, b), 0); // safe with seed 0
  const conversionRate = totalCalls
    ? Number(((appointments / totalCalls) * 100).toFixed(2))
    : 0;
  const firstCallResolution = answeredCalls
    ? Number(((answered.filter((r) => !r.follow_up_required).length / answeredCalls) * 100).toFixed(2))
    : 0;
  // Simple revenue/cost heuristics — enterprise admins can override via config
  const revenueAttribution = Number((appointments * 175).toFixed(2));
  const costPerCall = totalCalls ? Number((Math.max(0.45, avgDuration * 0.018)).toFixed(2)) : 0;

  return {
    totalCalls,
    answeredCalls,
    missedCalls,
    averageCallDuration: avgDuration,
    appointmentsBooked: appointments,
    leadsGenerated,
    customerSatisfactionScore: csat,
    revenueAttribution,
    costPerCall,
    conversionRate,
    firstCallResolution,
    peakCallVolume: peak,
    averageWaitTime: 0,
  };
}

// Schema-safe column selection. We start with the full preferred set; if
// Supabase reports a missing column we cache the trimmed set and never
// silently zero metrics on schema drift.
const PREFERRED_CALL_COLS = [
  "id",
  "business_id",
  "department_routed",
  "language_detected",
  "duration_seconds",
  "sentiment",
  "call_outcome",
  "follow_up_required",
  "start_time",
  "created_at",
];
const MINIMAL_CALL_COLS = [
  "id",
  "business_id",
  "duration_seconds",
  "sentiment",
  "call_outcome",
  "start_time",
  "created_at",
];

let _activeCallCols: string[] | null = null;

async function fetchCallRows(
  businessId: string,
  start: string,
  end: string,
): Promise<any[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const tryQuery = async (cols: string[]) => {
    return (supabase as any)
      .from("calls")
      .select(cols.join(", "))
      .eq("business_id", businessId)
      .gte("created_at", start)
      .lte("created_at", end)
      .limit(10_000);
  };
  try {
    let cols = _activeCallCols ?? PREFERRED_CALL_COLS;
    let { data, error } = await tryQuery(cols);

    // First-run schema probe: retry with minimal columns and cache the result.
    if (error && /column .* does not exist/i.test(error.message || "")) {
      console.warn(
        `[Analytics] calls schema mismatch (${error.message}); falling back to minimal columns`,
      );
      _activeCallCols = MINIMAL_CALL_COLS;
      ({ data, error } = await tryQuery(MINIMAL_CALL_COLS));
    } else if (!error && _activeCallCols === null) {
      _activeCallCols = cols; // cache success path
    }

    if (error) {
      console.error("[Analytics] calls query failed:", error.message);
      return [];
    }
    return data || [];
  } catch (err: any) {
    console.error("[Analytics] calls unavailable:", err.message);
    return [];
  }
}

function groupBy<T>(rows: T[], key: (r: T) => string | null | undefined) {
  const out: Record<string, T[]> = {};
  for (const r of rows) {
    const k = key(r) || "unknown";
    (out[k] ||= []).push(r);
  }
  return out;
}

function detectAlerts(current: AnalyticsMetrics, previous: AnalyticsMetrics): AnalyticsAlert[] {
  const alerts: AnalyticsAlert[] = [];
  const now = new Date().toISOString();
  const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);

  // Cold-start: previous period was effectively empty but current isn't.
  if (previous.totalCalls <= 1 && current.totalCalls >= 10) {
    alerts.push({
      id: uuidv4(),
      type: "spike",
      metric: "totalCalls",
      severity: current.totalCalls >= 50 ? "high" : "medium",
      message: `Call volume jumped from ${previous.totalCalls} to ${current.totalCalls} (cold start)`,
      timestamp: now,
      acknowledged: false,
    });
  } else {
    const callDelta = pct(current.totalCalls, previous.totalCalls);
    if (Math.abs(callDelta) >= 50 && previous.totalCalls > 5) {
      alerts.push({
        id: uuidv4(),
        type: callDelta > 0 ? "spike" : "drop",
        metric: "totalCalls",
        severity: Math.abs(callDelta) >= 100 ? "high" : "medium",
        message: `Call volume ${callDelta > 0 ? "spiked" : "dropped"} ${callDelta.toFixed(0)}% vs previous period`,
        timestamp: now,
        acknowledged: false,
      });
    }
  }

  const missRate = current.totalCalls ? (current.missedCalls / current.totalCalls) * 100 : 0;
  if (missRate >= 15) {
    alerts.push({
      id: uuidv4(),
      type: "threshold",
      metric: "missedCalls",
      severity: missRate >= 30 ? "critical" : "high",
      message: `Missed-call rate is ${missRate.toFixed(1)}% (threshold 15%)`,
      timestamp: now,
      acknowledged: false,
    });
  }

  if (current.customerSatisfactionScore && current.customerSatisfactionScore < 3) {
    alerts.push({
      id: uuidv4(),
      type: "threshold",
      metric: "customerSatisfactionScore",
      severity: "high",
      message: `CSAT dropped to ${current.customerSatisfactionScore} (target ≥ 3.0)`,
      timestamp: now,
      acknowledged: false,
    });
  }

  return alerts;
}

router.get(
  "/analytics/dashboard",
  requireAuth,
  requirePermission("analytics", "read"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId || "";
      const range = (req.query.range as string) || "24h";
      const timezone = (req.query.timezone as string) || "UTC";
      const periodMs = parseTimeRange(range);
      const end = new Date();
      const start = new Date(end.getTime() - periodMs);
      const prevStart = new Date(start.getTime() - periodMs);

      const [rows, prevRows] = await Promise.all([
        fetchCallRows(businessId, start.toISOString(), end.toISOString()),
        fetchCallRows(businessId, prevStart.toISOString(), start.toISOString()),
      ]);

      const metrics = rowsToMetrics(rows);
      const previousPeriod = rowsToMetrics(prevRows);

      // byLocation/byAgent require schema columns the deployed calls table
      // doesn't have; we synthesize byAgent from department_routed.
      const byAgent: Record<string, AnalyticsMetrics> = {};
      for (const [k, v] of Object.entries(groupBy(rows, (r: any) => r.department_routed))) {
        byAgent[k] = rowsToMetrics(v as any[]);
      }
      const byLanguage: Record<string, AnalyticsMetrics> = {};
      for (const [k, v] of Object.entries(groupBy(rows, (r: any) => r.language_detected))) {
        byLanguage[k] = rowsToMetrics(v as any[]);
      }
      const byTimeOfDay: Record<string, AnalyticsMetrics> = {};
      for (const [k, v] of Object.entries(
        groupBy(rows, (r: any) => {
          if (!r.start_time) return "unknown";
          const h = new Date(r.start_time).getUTCHours();
          if (h < 6) return "night";
          if (h < 12) return "morning";
          if (h < 18) return "afternoon";
          return "evening";
        }),
      )) {
        byTimeOfDay[k] = rowsToMetrics(v as any[]);
      }

      const alerts = detectAlerts(metrics, previousPeriod);

      const dashboard: EnterpriseAnalytics = {
        businessId,
        timeRange: {
          start: start.toISOString(),
          end: end.toISOString(),
          period: range.endsWith("w") ? "week" : range.endsWith("d") ? "day" : "hour",
          timezone,
        },
        metrics,
        breakdowns: { byAgent, byLanguage, byTimeOfDay },
        comparisons: { previousPeriod },
        alerts,
      };

      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: "analytics.dashboard.viewed",
        resource: "analytics",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { range, timezone, totalCalls: metrics.totalCalls },
      });

      res.json(dashboard);
    } catch (err: any) {
      console.error("[Analytics] dashboard error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---- Custom reports ----

let _reportsTableReady: Promise<void> | null = null;
async function ensureReportsTable(): Promise<void> {
  if (_reportsTableReady) return _reportsTableReady;
  _reportsTableReady = (async () => {
    await contactPool.query(`
      CREATE TABLE IF NOT EXISTS enterprise_custom_reports (
        id UUID PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        created_by TEXT,
        report_type TEXT NOT NULL,
        data_query JSONB NOT NULL,
        visualizations JSONB DEFAULT '[]'::jsonb,
        schedule JSONB,
        recipients JSONB DEFAULT '[]'::jsonb,
        format TEXT DEFAULT 'json',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_modified TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await contactPool.query(
      `CREATE INDEX IF NOT EXISTS idx_reports_biz ON enterprise_custom_reports (business_id)`,
    );
  })();
  return _reportsTableReady;
}

const ALLOWED_REPORT_TABLES = new Set(["calls", "appointments", "leads", "audit_logs", "users"]);

function validateReportQuery(q: any): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!q || typeof q !== "object") {
    return { valid: false, errors: ["dataQuery is required"] };
  }
  if (!Array.isArray(q.tables) || q.tables.length === 0) {
    errors.push("dataQuery.tables must be a non-empty array");
  } else {
    for (const t of q.tables) {
      if (!ALLOWED_REPORT_TABLES.has(t)) errors.push(`table not allowed: ${t}`);
    }
  }
  if (!Array.isArray(q.fields) || q.fields.length === 0) {
    errors.push("dataQuery.fields must be a non-empty array");
  }
  if (!q.dateRange || !q.dateRange.start || !q.dateRange.end) {
    errors.push("dataQuery.dateRange.start and end are required");
  }
  return { valid: errors.length === 0, errors };
}

router.post(
  "/reports",
  requireAuth,
  requirePermission("analytics", "admin"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId || "";
      const body = (req.body || {}) as Partial<CustomReport>;
      if (!body.name || !body.dataQuery || !body.reportType) {
        res.status(400).json({ error: "name, reportType and dataQuery are required" });
        return;
      }
      const validation = validateReportQuery(body.dataQuery);
      if (!validation.valid) {
        res.status(400).json({ error: "Invalid report query", details: validation.errors });
        return;
      }

      const now = new Date().toISOString();
      const report: CustomReport = {
        id: uuidv4(),
        name: body.name,
        description: body.description,
        businessId,
        createdBy: req.userId || "system",
        createdAt: now,
        lastModified: now,
        reportType: body.reportType,
        dataQuery: body.dataQuery,
        visualizations: body.visualizations || [],
        schedule: body.schedule,
        recipients: body.recipients || [],
        format: body.format || "json",
      };

      await ensureReportsTable();
      await contactPool.query(
        `INSERT INTO enterprise_custom_reports
           (id, business_id, name, description, created_by, report_type, data_query, visualizations, schedule, recipients, format)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          report.id,
          businessId,
          report.name,
          report.description || null,
          report.createdBy,
          report.reportType,
          JSON.stringify(report.dataQuery),
          JSON.stringify(report.visualizations),
          report.schedule ? JSON.stringify(report.schedule) : null,
          JSON.stringify(report.recipients),
          report.format,
        ],
      );

      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: "report.created",
        resource: "analytics",
        resourceId: report.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { reportName: report.name, reportType: report.reportType },
      });

      res.json(report);
    } catch (err: any) {
      console.error("[Reports] create error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ---- Compliance reports ----

router.post(
  "/compliance/reports",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("analytics", "admin"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId || "";
      const { reportType, period } = (req.body || {}) as {
        reportType?: "soc2" | "hipaa";
        period?: AnalyticsTimeRange;
      };
      if (!reportType) {
        res.status(400).json({ error: "reportType is required (soc2 | hipaa)" });
        return;
      }
      const safePeriod: AnalyticsTimeRange = period?.start && period?.end
        ? period
        : {
            start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
            end: new Date().toISOString(),
            period: "month",
            timezone: "UTC",
          };

      const reporter = new ComplianceReporter();
      let report;
      if (reportType === "soc2") report = await reporter.generateSOC2Report(businessId, safePeriod);
      else if (reportType === "hipaa") report = await reporter.generateHIPAAReport(businessId, safePeriod);
      else {
        res.status(400).json({ error: "Invalid report type" });
        return;
      }

      const meta = extractRequestMeta(req);
      void auditLog({
        userId: req.userId,
        businessId,
        action: "compliance.report.generated",
        resource: "analytics",
        resourceId: report.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { reportType, findings: report.findings.length },
        complianceFlags: ["COMPLIANCE-REPORT"],
      });

      res.json(report);
    } catch (err: any) {
      console.error("[Compliance] generate error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

// ============================================================================
// Security: PII detection / redaction + retention scheduling
// ============================================================================

const piiProcessor = new PIIProcessor();
let _retentionMgr: DataRetentionManager | null = null;
function retentionManager(): DataRetentionManager {
  if (_retentionMgr) return _retentionMgr;
  _retentionMgr = new DataRetentionManager(contactPool, piiProcessor);
  return _retentionMgr;
}

router.post(
  "/security/pii/detect",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("analytics", "read"),
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body || {};
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Text field is required" });
      }
      if (text.length > 100_000) {
        return res.status(413).json({ error: "Text exceeds 100KB limit" });
      }
      const detections = piiProcessor.detectPII(text);
      const totalFound = detections.reduce((s, d) => s + d.count, 0);
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "pii.detection.performed",
        resource: "security",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { detectionsFound: detections.length, totalFound, textLength: text.length },
        complianceFlags: ["PII-DETECTION"],
      });
      res.json({ detections, totalFound });
    } catch (err: any) {
      console.error("[PII] detect error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/security/pii/redact",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("analytics", "write"),
  async (req: Request, res: Response) => {
    try {
      const { text } = req.body || {};
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Text field is required" });
      }
      if (text.length > 100_000) {
        return res.status(413).json({ error: "Text exceeds 100KB limit" });
      }
      const result = piiProcessor.redactPII(text);
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "pii.redaction.performed",
        resource: "security",
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          originalLength: text.length,
          redactedLength: result.redacted.length,
          detectionsRedacted: result.detections.length,
        },
        complianceFlags: ["PII-REDACTION", "DATA-PRIVACY"],
      });
      res.json({
        redacted: result.redacted,
        detections: result.detections,
        encryptedElements: Object.keys(result.encrypted).length,
      });
    } catch (err: any) {
      console.error("[PII] redact error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/compliance/government/access-request",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("settings", "admin"),
  async (req: Request, res: Response) => {
    try {
      const { resourceId, justification, duration, clearanceLevel } = req.body || {};
      if (!resourceId || !justification || !clearanceLevel) {
        return res.status(400).json({
          error: "resourceId, justification, and clearanceLevel are required",
        });
      }
      const dur = Number.isFinite(duration) && duration > 0 ? Math.min(duration, 365) : 7;
      const accessRequest = {
        id: uuidv4(),
        userId: req.userId!,
        businessId: req.businessId!,
        resourceId,
        justification,
        clearanceLevel,
        requestedAt: new Date().toISOString(),
        status: "pending_approval" as const,
        duration: dur,
        expiresAt: new Date(Date.now() + dur * 86_400_000).toISOString(),
        reviewers: ["security-officer", "compliance-manager"],
      };
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "government.access.requested",
        resource: "compliance",
        resourceId,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { justification, clearanceLevel, duration: dur },
        complianceFlags: ["GOVERNMENT-ACCESS", "CLEARANCE-REQUIRED"],
        riskScore: 85,
      });
      res.json(accessRequest);
    } catch (err: any) {
      console.error("[Compliance] access-request error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/security/retention/schedule",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("settings", "admin"),
  async (req: Request, res: Response) => {
    try {
      const cfg = req.body || {};
      if (!Number.isFinite(cfg.retentionDays) || cfg.retentionDays < 1) {
        return res.status(400).json({ error: "retentionDays must be a positive number" });
      }
      const config: RetentionConfig = {
        retentionDays: Math.floor(cfg.retentionDays),
        categories: Array.isArray(cfg.categories) ? cfg.categories : ["calls"],
        archiveBeforeDelete: !!cfg.archiveBeforeDelete,
        confirmationRequired: cfg.confirmationRequired !== false,
        dryRun: cfg.dryRun !== false, // safe default: dry run
      };
      const job = await retentionManager().scheduleRetention(req.businessId!, config);
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "retention.scheduled",
        resource: "security",
        resourceId: job.id,
        success: true,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: { retentionDays: config.retentionDays, dryRun: config.dryRun },
        complianceFlags: ["DATA-RETENTION", "COMPLIANCE"],
      });
      res.json(job);
    } catch (err: any) {
      console.error("[Retention] schedule error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/security/retention/:jobId/execute",
  requireAuth,
  enterpriseIPFilter,
  requirePermission("settings", "admin"),
  async (req: Request, res: Response) => {
    try {
      const report = await retentionManager().executeRetention(
        req.businessId!,
        req.params.jobId,
      );
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId!,
        businessId: req.businessId!,
        action: "retention.executed",
        resource: "security",
        resourceId: req.params.jobId,
        success: report.errors.length === 0,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        sessionId: req.sessionId,
        details: {
          processed: report.recordsProcessed,
          deleted: report.recordsDeleted,
          archived: report.recordsArchived,
          errors: report.errors.length,
        },
        complianceFlags: ["DATA-RETENTION", "DATA-DELETION"],
        riskScore: report.recordsDeleted > 0 ? 70 : 30,
      });
      res.json(report);
    } catch (err: any) {
      console.error("[Retention] execute error:", err);
      res.status(500).json({ error: err.message });
    }
  },
);

export default router;
