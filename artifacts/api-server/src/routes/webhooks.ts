/**
 * Webhook endpoint management API.
 *
 * Notable deviations from the rough spec:
 *   * Adds full CRUD (the spec only described a service for triggering
 *     deliveries, not how tenants would register/list/update endpoints).
 *   * Plaintext signing secret is auto-generated server-side and
 *     returned EXACTLY ONCE — at create or rotate. After that the row
 *     stores only the AES-256-GCM ciphertext (`secret_encrypted`). UI
 *     code must capture the secret on the create response.
 *   * Pre-registration SSRF check rejects URLs that resolve to private,
 *     loopback, or cloud-metadata ranges.
 *   * `secret_encrypted` is NEVER serialized in any response.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, requirePermission } from "../middlewares/auth.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";
import {
  WebhookService,
  generateWebhookSecret,
  encryptSecret,
  isUrlSafeForWebhook,
  signPayload,
  decryptSecret,
} from "../services/webhook-service.js";

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

// Whitelist of event names tenants can subscribe to. New events must be
// added here intentionally so we don't accidentally start blasting our
// internal lifecycle events to outside listeners.
const SUPPORTED_EVENTS = new Set<string>([
  "call.completed",
  "call.failed",
  "call.missed",
  "call.appointment_booked",
  "lead.created",
  "subscription.updated",
  "test.ping",
]);

function publicRow(row: any) {
  if (!row) return row;
  // Strip the encrypted secret blob from every response — it should
  // never leave the server even in encrypted form.
  const { secret_encrypted: _drop, ...rest } = row;
  return rest;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
router.get("/webhooks", requireAuth, requirePermission("integrations", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("webhook_endpoints")
      .select("id, business_id, name, url, events, is_active, retry_config, headers, created_by, created_at, last_triggered, success_count, failure_count")
      .eq("business_id", req.businessId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return res.json({ webhooks: data || [], count: (data || []).length });
  } catch (err: any) {
    console.error("[Webhooks] list error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post("/webhooks", requireAuth, requirePermission("integrations", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId || !req.userId) return res.status(400).json({ error: "No business in scope" });

    const { name, url, events, headers, retryConfig, isActive = true } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (!url || typeof url !== "string") return res.status(400).json({ error: "url is required" });
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: "events must be a non-empty array" });
    }
    const invalidEvents = events.filter((e: any) => typeof e !== "string" || !SUPPORTED_EVENTS.has(e));
    if (invalidEvents.length) {
      return res.status(400).json({
        error: `Unsupported events: ${invalidEvents.join(", ")}`,
        supported: Array.from(SUPPORTED_EVENTS),
      });
    }
    const safe = await isUrlSafeForWebhook(url);
    if (!safe.ok) return res.status(400).json({ error: `Webhook URL rejected: ${safe.reason}` });

    const plaintext = generateWebhookSecret();
    const secret_encrypted = encryptSecret(plaintext);

    const { data, error } = await supabase
      .from("webhook_endpoints")
      .insert({
        business_id: req.businessId,
        name,
        url,
        secret_encrypted,
        events,
        is_active: !!isActive,
        retry_config: retryConfig || { maxRetries: 3, backoffMs: 1000 },
        headers: headers || {},
        created_by: req.userId,
      })
      .select()
      .single();
    if (error) throw error;

    const meta = extractRequestMeta(req);
    void auditLog({
      userId: req.userId,
      businessId: req.businessId,
      action: "webhook.created",
      resource: "webhook_endpoints",
      resourceId: data.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { name, url, events },
    });

    // Returning the plaintext secret EXACTLY ONCE. The UI must surface
    // it to the user and instruct them to store it — there is no API to
    // recover it after this response.
    return res.status(201).json({
      success: true,
      webhook: publicRow(data),
      secret: plaintext,
      message: "Save this signing secret — it will not be shown again",
    });
  } catch (err: any) {
    console.error("[Webhooks] create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------
router.get("/webhooks/:id", requireAuth, requirePermission("integrations", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("webhook_endpoints")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ webhook: publicRow(data) });
  } catch (err: any) {
    console.error("[Webhooks] get error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.put("/webhooks/:id", requireAuth, requirePermission("integrations", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const allowed: Record<string, any> = {};
    const { name, url, events, headers, retryConfig, isActive } = req.body || {};
    if (typeof name === "string") allowed.name = name;
    if (typeof isActive === "boolean") allowed.is_active = isActive;
    if (headers && typeof headers === "object") allowed.headers = headers;
    if (retryConfig && typeof retryConfig === "object") allowed.retry_config = retryConfig;
    if (typeof url === "string") {
      const safe = await isUrlSafeForWebhook(url);
      if (!safe.ok) return res.status(400).json({ error: `Webhook URL rejected: ${safe.reason}` });
      allowed.url = url;
    }
    if (Array.isArray(events)) {
      if (events.length === 0) return res.status(400).json({ error: "events must be non-empty" });
      const invalid = events.filter((e: any) => typeof e !== "string" || !SUPPORTED_EVENTS.has(e));
      if (invalid.length) {
        return res.status(400).json({ error: `Unsupported events: ${invalid.join(", ")}`, supported: Array.from(SUPPORTED_EVENTS) });
      }
      allowed.events = events;
    }
    if (Object.keys(allowed).length === 0) return res.status(400).json({ error: "No valid fields to update" });

    const { data, error } = await supabase
      .from("webhook_endpoints")
      .update(allowed)
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ success: true, webhook: publicRow(data) });
  } catch (err: any) {
    console.error("[Webhooks] update error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Rotate signing secret
// ---------------------------------------------------------------------------
router.post("/webhooks/:id/rotate-secret", requireAuth, requirePermission("integrations", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const plaintext = generateWebhookSecret();
    const { data, error } = await supabase
      .from("webhook_endpoints")
      .update({ secret_encrypted: encryptSecret(plaintext) })
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Webhook not found" });

    const meta = extractRequestMeta(req);
    void auditLog({
      userId: req.userId,
      businessId: req.businessId,
      action: "webhook.secret_rotated",
      resource: "webhook_endpoints",
      resourceId: data.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return res.json({ success: true, secret: plaintext, message: "Save this signing secret — it will not be shown again" });
  } catch (err: any) {
    console.error("[Webhooks] rotate error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
router.delete("/webhooks/:id", requireAuth, requirePermission("integrations", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("webhook_endpoints")
      .delete()
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Webhook not found" });
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[Webhooks] delete error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Recent deliveries
// ---------------------------------------------------------------------------
router.get("/webhooks/:id/deliveries", requireAuth, requirePermission("integrations", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    // Verify ownership before listing deliveries.
    const { data: hook } = await supabase
      .from("webhook_endpoints")
      .select("id")
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (!hook) return res.status(404).json({ error: "Webhook not found" });

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const { data, error } = await supabase
      .from("webhook_deliveries")
      .select("id, event_type, response_status, delivered_at, retry_count, created_at")
      .eq("webhook_id", req.params.id)
      .eq("business_id", req.businessId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return res.json({ deliveries: data || [], count: (data || []).length });
  } catch (err: any) {
    console.error("[Webhooks] deliveries error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Test fire — synchronously deliver a test.ping payload
// ---------------------------------------------------------------------------
router.post("/webhooks/:id/test", requireAuth, requirePermission("integrations", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data: hook } = await supabase
      .from("webhook_endpoints")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (!hook) return res.status(404).json({ error: "Webhook not found" });

    await WebhookService.deliverWebhook(hook, {
      event: "test.ping",
      timestamp: new Date().toISOString(),
      businessId: req.businessId,
      data: { message: "Test delivery from Neverr" },
    });

    return res.json({ success: true, message: "Test delivery dispatched" });
  } catch (err: any) {
    console.error("[Webhooks] test error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Internal helper used by tests to verify HMAC behaviour without firing
// HTTP. Not mounted under requireAuth — this is a convenience for the
// signing utility consumers, not a tenant-facing endpoint.
export function _signForTesting(payload: any, secret: string): string {
  return signPayload(payload, secret);
}

export function _decryptForTesting(enc: any): string {
  return decryptSecret(enc);
}

export default router;
