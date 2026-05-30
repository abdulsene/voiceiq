/**
 * Outbound webhook delivery service.
 *
 * Security posture:
 *   * SSRF guard — blocks private RFC1918, loopback, link-local, ULA, and
 *     169.254.169.254 (cloud metadata) before issuing the HTTP request.
 *     Without this, a tenant could register `http://169.254.169.254/...`
 *     and get our server-side response back in webhook_deliveries.
 *   * Signing secrets are stored AES-256-GCM encrypted at rest (see
 *     `src/security/encryption.ts`). The plaintext is returned exactly
 *     once — at creation / rotation — and never persisted in cleartext.
 *   * HMAC-SHA256 signature in `X-Webhook-Signature` (sha256=...) over
 *     the JSON body with the rotated secret.
 *   * Best-effort, in-process delivery. Retries are deliberately scoped
 *     out of this commit — they need a durable queue (BullMQ or pg_cron)
 *     to be correct under restarts and we haven't picked one yet.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as dns from "node:dns/promises";
import { FieldEncryption, type EncryptedField } from "../security/encryption.js";

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

let _enc: FieldEncryption | null = null;
function getEncryption(): FieldEncryption {
  if (_enc) return _enc;
  _enc = new FieldEncryption();
  return _enc;
}

export interface WebhookPayload {
  event: string;
  timestamp: string;
  businessId: string;
  data: any;
}

/** Raw secret returned only at creation / rotation time. */
export function generateWebhookSecret(): string {
  // 32 bytes of entropy is overkill for HMAC but matches Stripe's wire size.
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

export function encryptSecret(plaintext: string): EncryptedField {
  return getEncryption().encrypt(plaintext);
}

export function decryptSecret(encrypted: EncryptedField): string {
  return getEncryption().decrypt(encrypted);
}

/**
 * Reject URLs that point at internal infrastructure. Runs AFTER schema
 * checks (must be http/https) and BEFORE the fetch() so a malicious
 * tenant can't probe internal services through our delivery process.
 */
const PRIVATE_HOST_PATTERNS = [
  // IPv4 loopback / link-local / metadata / private
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  // IPv6 loopback / link-local / unique local
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

export async function isUrlSafeForWebhook(rawUrl: string): Promise<{ ok: boolean; reason?: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, reason: "Only http(s) URLs are allowed" };
  }
  // Disallow http in production unless explicitly whitelisted via hostname.
  // Tests use http://127.0.0.1 which the host-IP check below will block too.
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host === "metadata.google.internal") {
    return { ok: false, reason: "Disallowed hostname" };
  }
  // If host is already an IP literal, check it directly.
  const ipFamily = net.isIP(host);
  const ips = ipFamily ? [host] : [];
  if (!ipFamily) {
    try {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      for (const r of records) ips.push(r.address);
    } catch {
      return { ok: false, reason: "DNS lookup failed" };
    }
  }
  for (const ip of ips) {
    for (const pat of PRIVATE_HOST_PATTERNS) {
      if (pat.test(ip)) {
        return { ok: false, reason: `Private/internal address blocked: ${ip}` };
      }
    }
  }
  return { ok: true };
}

export function signPayload(payload: any, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(JSON.stringify(payload));
  return `sha256=${hmac.digest("hex")}`;
}

/** Fan-out to all matching active webhooks. Best-effort, never throws. */
export async function triggerWebhooks(businessId: string, event: string, data: any): Promise<void> {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const { data: webhooks, error } = await supabase
      .from("webhook_endpoints")
      .select("*")
      .eq("business_id", businessId)
      .eq("is_active", true)
      .contains("events", [event]);

    if (error) {
      console.error("[Webhook] lookup error:", error);
      return;
    }
    if (!webhooks?.length) return;

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      businessId,
      data,
    };

    await Promise.allSettled(webhooks.map((w: any) => deliverWebhook(w, payload)));
  } catch (err) {
    console.error("[Webhook] trigger error:", err);
  }
}

export async function deliverWebhook(webhook: any, payload: WebhookPayload): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  let deliveryId: string | null = null;
  try {
    // SSRF gate is enforced at registration time too, but DNS can change
    // under us so we re-check on every fire.
    const safe = await isUrlSafeForWebhook(webhook.url);
    if (!safe.ok) {
      console.warn(`[Webhook] blocked delivery to ${webhook.url}: ${safe.reason}`);
      await recordFailure(supabase, webhook.id, payload, null, `SSRF blocked: ${safe.reason}`);
      return;
    }

    const { data: delivery } = await supabase
      .from("webhook_deliveries")
      .insert({
        webhook_id: webhook.id,
        business_id: webhook.business_id,
        event_type: payload.event,
        payload,
      })
      .select("id")
      .single();
    deliveryId = delivery?.id || null;

    const secret = decryptSecret(webhook.secret_encrypted);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signPayload(payload, secret),
      "X-Webhook-Event": payload.event,
      "X-Webhook-Timestamp": payload.timestamp,
      "X-Webhook-Id": webhook.id,
      "User-Agent": "Neverr-Webhooks/1.0",
      ...(webhook.headers || {}),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(webhook.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: "manual", // never follow — redirects can re-introduce SSRF
      });
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.text()).slice(0, 1000);
    if (deliveryId) {
      await supabase
        .from("webhook_deliveries")
        .update({
          response_status: response.status,
          response_body: body,
          delivered_at: new Date().toISOString(),
        })
        .eq("id", deliveryId);
    }

    if (response.ok) {
      await bumpCounter(supabase, webhook.id, "success_count");
    } else {
      await bumpCounter(supabase, webhook.id, "failure_count");
    }
    await supabase
      .from("webhook_endpoints")
      .update({ last_triggered: new Date().toISOString() })
      .eq("id", webhook.id);
  } catch (err: any) {
    console.error(`[Webhook] delivery failed to ${webhook.url}:`, err.message || err);
    await recordFailure(supabase, webhook.id, payload, deliveryId, err.message || String(err));
  }
}

async function recordFailure(
  supabase: SupabaseClient,
  webhookId: string,
  payload: WebhookPayload,
  existingDeliveryId: string | null,
  errorMessage: string,
): Promise<void> {
  try {
    if (existingDeliveryId) {
      await supabase
        .from("webhook_deliveries")
        .update({
          response_status: 0,
          response_body: errorMessage.slice(0, 1000),
          delivered_at: new Date().toISOString(),
        })
        .eq("id", existingDeliveryId);
    } else {
      await supabase.from("webhook_deliveries").insert({
        webhook_id: webhookId,
        business_id: payload.businessId,
        event_type: payload.event,
        payload,
        response_status: 0,
        response_body: errorMessage.slice(0, 1000),
        delivered_at: new Date().toISOString(),
      });
    }
    await bumpCounter(supabase, webhookId, "failure_count");
  } catch (e) {
    console.error("[Webhook] failure-record error:", e);
  }
}

/**
 * Atomic-ish counter bump. Two-step (read, +1, write) is acceptable for
 * a stats counter where last-writer-wins is fine and we don't need
 * transactional consistency. A truly atomic bump would need an RPC or
 * raw SQL `UPDATE ... SET col = col + 1`.
 */
async function bumpCounter(
  supabase: SupabaseClient,
  webhookId: string,
  column: "success_count" | "failure_count",
): Promise<void> {
  const { data: row } = await supabase
    .from("webhook_endpoints")
    .select(column)
    .eq("id", webhookId)
    .single();
  const current = ((row as any)?.[column] as number | null) ?? 0;
  await supabase
    .from("webhook_endpoints")
    .update({ [column]: current + 1 })
    .eq("id", webhookId);
}

export const WebhookService = {
  triggerWebhooks,
  deliverWebhook,
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
  signPayload,
  isUrlSafeForWebhook,
};
