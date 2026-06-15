/**
 * Per-tenant SMS service for Slice 3A — pillar 2.
 *
 * This is a NEW service layer that exists ALONGSIDE the legacy
 * src/sms.ts wrapper. We deliberately don't touch sms.ts because it
 * has 35+ callers across api.ts / auth.ts / cron.ts / widget.ts and
 * any change explodes scope. The legacy wrapper sends from a single
 * Neverr-wide TWILIO_PHONE_NUMBER; this service sends from each
 * tenant's business_configs.twilio_phone_number so the customer
 * recognizes the AI line.
 *
 * Responsibilities (compare to legacy sendSMS which has none of these):
 *   1. Resolve from_phone from business_configs (with documented fallback)
 *   2. Normalize destination to E.164
 *   3. Check sms_opt_outs BEFORE sending — never message an opted-out number
 *   4. Render the template via lib/sms-templates.ts
 *   5. Persist a sms_messages row with status='queued' BEFORE the Twilio call
 *      so a crash mid-send leaves a debuggable record
 *   6. Send via Twilio REST API (NOT ElevenLabs voice path)
 *   7. Update the sms_messages row with twilio_sid + final status
 *   8. Write a lead_activities row (action='sms_sent') if leadId is set
 *
 * SMS-capability of the from-phone is NOT checked here per-send — that
 * would add a Twilio API round-trip to every send. The capability is
 * cached at provisioning time (Slice 3A doesn't add that cache yet;
 * see the from-phone resolution path for the fallback behaviour).
 * Twilio responds 21606 if the number can't SMS; we catch that and
 * fall back to TWILIO_PHONE_NUMBER on the next call after marking
 * the tenant's number capability=voice-only in business_configs.
 *
 * Return shape is structured (not boolean). Callers can choose to
 * surface delivery failures to staff (Slice 3B). The capture-path
 * caller (POST /api/leads/capture) deliberately ignores the result —
 * an SMS failure must not break lead capture.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";
import { getTwilioClient } from "../sms";
import { getPublicApiBase } from "./public-url";
import {
  renderSmsTemplate,
  type SmsLocale,
  type SmsTemplate,
  type SmsTemplateContext,
} from "./sms-templates";

export interface SendLeadSmsOptions {
  supabase: SupabaseClient;
  businessId: string;
  leadId: string | null;
  to: string;
  template: SmsTemplate;
  context: SmsTemplateContext;
  locale?: SmsLocale;
}

export interface SendLeadSmsResult {
  ok: boolean;
  smsMessageId?: string;
  twilioSid?: string;
  status?: "sent" | "delivered" | "failed" | "opted_out" | "queued";
  fromPhone?: string;
  error?: string;
}

/**
 * E.164 normalization. Strips everything except + and digits, prepends
 * +1 for ten-digit US-shaped numbers. Returns null for inputs too short
 * to be a phone number.
 */
function toE164(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.startsWith("+")) {
    return cleaned.length >= 11 ? cleaned : null;
  }
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith("1")) return `+${cleaned}`;
  return null;
}

async function resolveFromPhone(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ fromPhone: string | null; usedFallback: boolean }> {
  const { data } = await supabase
    .from("business_configs")
    .select("twilio_phone_number")
    .eq("business_id", businessId)
    .maybeSingle();
  const tenantNumber = (data as { twilio_phone_number?: string } | null)?.twilio_phone_number || null;
  if (tenantNumber) return { fromPhone: tenantNumber, usedFallback: false };

  const masterNumber = process.env.TWILIO_PHONE_NUMBER || null;
  if (masterNumber) {
    Sentry.addBreadcrumb({
      category: "sms-service",
      level: "warning",
      message: "tenant_twilio_phone_number_missing_using_master",
      data: { businessId },
    });
    return { fromPhone: masterNumber, usedFallback: true };
  }
  return { fromPhone: null, usedFallback: false };
}

async function isOptedOut(
  supabase: SupabaseClient,
  businessId: string,
  phone: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("sms_opt_outs")
    .select("id")
    .eq("business_id", businessId)
    .eq("phone", phone)
    .is("resubscribed_at", null)
    .maybeSingle();
  if (error) {
    // Fail SAFE on a DB read error: treat as NOT opted out so capture
    // SMS still sends. The alternative (refuse to send on transient
    // errors) silently breaks customer-facing comms.
    console.error("[sms-service] opt-out check failed:", error.message);
    Sentry.captureMessage("sms_opt_out_check_failed", {
      level: "warning",
      extra: { businessId, phone, error: error.message },
    });
    return false;
  }
  return !!data;
}

/**
 * Main entry point. See the file header for end-to-end behaviour.
 */
export async function sendLeadSms(
  opts: SendLeadSmsOptions,
): Promise<SendLeadSmsResult> {
  const { supabase, businessId, leadId, to, template, context } = opts;
  const locale: SmsLocale = opts.locale || "en";

  const normalizedTo = toE164(to);
  if (!normalizedTo) {
    return { ok: false, error: "invalid_to_phone" };
  }

  const { fromPhone } = await resolveFromPhone(supabase, businessId);
  if (!fromPhone) {
    Sentry.captureMessage("sms_no_from_phone_resolvable", {
      level: "error",
      extra: { businessId, leadId, template },
    });
    return { ok: false, error: "no_from_phone" };
  }

  if (await isOptedOut(supabase, businessId, normalizedTo)) {
    // Persist a row so the staff timeline reflects "we would have
    // sent X but the customer opted out." status='opted_out' makes
    // the audit trail unambiguous.
    const body = renderSmsTemplate(template, locale, context);
    const { data: persisted } = await supabase
      .from("sms_messages")
      .insert({
        business_id: businessId,
        lead_id: leadId,
        direction: "outbound",
        to_phone: normalizedTo,
        from_phone: fromPhone,
        body,
        template,
        template_locale: locale,
        status: "opted_out",
        error_message: "Recipient is on this tenant's opt-out list.",
      })
      .select("id")
      .maybeSingle();
    return {
      ok: false,
      smsMessageId: (persisted as { id?: string } | null)?.id,
      status: "opted_out",
      fromPhone,
      error: "opted_out",
    };
  }

  const body = renderSmsTemplate(template, locale, context);

  // Persist BEFORE sending so a crash mid-send leaves a debuggable
  // 'queued' row that the timeline can render.
  const { data: queued, error: queueErr } = await supabase
    .from("sms_messages")
    .insert({
      business_id: businessId,
      lead_id: leadId,
      direction: "outbound",
      to_phone: normalizedTo,
      from_phone: fromPhone,
      body,
      template,
      template_locale: locale,
      status: "queued",
    })
    .select("id")
    .maybeSingle();
  if (queueErr) {
    Sentry.captureMessage("sms_persist_failed_pre_send", {
      level: "error",
      extra: { businessId, leadId, template, error: queueErr.message },
    });
    return { ok: false, fromPhone, error: `db_persist_failed: ${queueErr.message}` };
  }
  const smsMessageId = (queued as { id?: string } | null)?.id;

  // Send via Twilio. statusCallback wires Twilio's async delivery
  // tracker to our handler at /api/twilio/sms-status — the synchronous
  // API response is just "queued" / "sent" (we accepted the message);
  // the actual delivered / undelivered / failed signal arrives on a
  // separate POST from Twilio minutes later when carrier filters /
  // 10DLC enforcement / blocked-number lookups complete.
  const publicBase = getPublicApiBase();
  let twilioSid: string | undefined;
  let twilioError: string | undefined;
  try {
    const client = getTwilioClient();
    const result = await client.messages.create({
      body,
      from: fromPhone,
      to: normalizedTo,
      statusCallback: `${publicBase}/api/twilio/sms-status`,
    });
    twilioSid = result.sid;
  } catch (err: any) {
    twilioError = err?.message || String(err);
    Sentry.captureException(err, {
      extra: { businessId, leadId, template, fromPhone, to: normalizedTo },
    });
  }

  const finalStatus: "sent" | "failed" = twilioError ? "failed" : "sent";
  await supabase
    .from("sms_messages")
    .update({
      twilio_sid: twilioSid,
      status: finalStatus,
      error_message: twilioError,
    })
    .eq("id", smsMessageId ?? "");

  if (leadId) {
    // Activity timeline entry written for BOTH sent and failed sends.
    // The status field on the metadata is what LeadDetailPage's
    // smsFailureToast (Slice 3A Commit B) scans for. Without writing
    // failed rows, the toast never activates.
    const { error: actErr } = await supabase.from("lead_activities").insert({
      lead_id: leadId,
      actor_id: null,
      actor_type: "system",
      action: "sms_sent",
      metadata: {
        template,
        template_locale: locale,
        to_phone: normalizedTo,
        from_phone: fromPhone,
        twilio_sid: twilioSid,
        sms_message_id: smsMessageId,
        status: finalStatus,
        error_message: twilioError ?? null,
      },
    });
    if (actErr) {
      console.error("[sms-service] activity insert failed:", actErr.message);
    }
  }

  if (finalStatus === "failed") {
    return {
      ok: false,
      smsMessageId,
      fromPhone,
      status: "failed",
      error: twilioError,
    };
  }
  return {
    ok: true,
    smsMessageId,
    twilioSid,
    status: "sent",
    fromPhone,
  };
}

/**
 * Used by the inbound STOP handler. Inserts (or revives) an active
 * opt-out row for (business_id, phone).
 */
export async function recordOptOut(opts: {
  supabase: SupabaseClient;
  businessId: string;
  phone: string;
  reason?: "stop_reply" | "staff_initiated" | "compliance";
}): Promise<void> {
  const normalized = toE164(opts.phone);
  if (!normalized) return;
  const reason = opts.reason || "stop_reply";
  // Insert. If a row already exists for (business_id, phone) with
  // resubscribed_at IS NULL, the partial unique index will reject —
  // catch and treat as success.
  const { error } = await opts.supabase.from("sms_opt_outs").insert({
    business_id: opts.businessId,
    phone: normalized,
    reason,
  });
  if (error && !/duplicate key|unique/i.test(error.message)) {
    console.error("[sms-service] opt-out persist failed:", error.message);
    Sentry.captureMessage("sms_opt_out_persist_failed", {
      level: "error",
      extra: { businessId: opts.businessId, phone: normalized, error: error.message },
    });
  }
}

/**
 * Used by the inbound START handler. Flips resubscribed_at on any
 * active opt-out row for (business_id, phone) so future sends can
 * proceed.
 */
export async function recordResubscribe(opts: {
  supabase: SupabaseClient;
  businessId: string;
  phone: string;
}): Promise<void> {
  const normalized = toE164(opts.phone);
  if (!normalized) return;
  const nowIso = new Date().toISOString();
  const { error } = await opts.supabase
    .from("sms_opt_outs")
    .update({ resubscribed_at: nowIso })
    .eq("business_id", opts.businessId)
    .eq("phone", normalized)
    .is("resubscribed_at", null);
  if (error) {
    console.error("[sms-service] resubscribe persist failed:", error.message);
  }
}

// Exported for tests + the inbound STOP webhook.
export const __testables = { toE164 };
