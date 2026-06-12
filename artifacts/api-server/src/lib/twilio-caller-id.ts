/**
 * Twilio outbound caller ID resolver.
 *
 * Slice 2A: For the lead-bridge feature, the caller ID the CUSTOMER sees
 * should be the business's own verified phone number — not the Neverr
 * Twilio number, which would look like spam. Twilio requires the From
 * value to be either a Twilio-owned number on the account OR a number
 * verified via the OutgoingCallerIds API.
 *
 * Behavior in this slice:
 *   1. Look up business_configs.verified_outbound_caller_id (NEW
 *      column? — no, we don't have one yet; using business_configs.
 *      phone_number as the "their main business line" pointer and
 *      cross-referencing OutgoingCallerIds at runtime is too chatty).
 *
 *      Pragmatic Slice 2A choice: read business_configs.phone_number
 *      as the customer-side caller ID candidate. If verification status
 *      isn't tracked anywhere, we OPTIMISTICALLY try it; Twilio will
 *      reject the outbound call with error 21217 if the number isn't
 *      verified, which the route handler catches and falls back to the
 *      Neverr Twilio number with a Sentry warning so the customer sees
 *      "verify your number for branded caller ID" can land in a future
 *      slice.
 *
 *   2. Fallback: business_configs.twilio_phone_number (the Neverr line).
 *      Always valid as From because Twilio owns it.
 *
 * When the future "verify your number" UI lands, we'll add a
 * business_configs.outbound_caller_id_verified BOOLEAN column and gate
 * the optimistic branch on it. Slice 2A flags this in the route's
 * Sentry breadcrumb so we can see the fallback rate in production.
 */
import * as Sentry from "@sentry/node";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ResolvedCallerId {
  from: string;                         // E.164 to send to Twilio as From
  source: "business_main_line" | "twilio_neverr_line";
  fallback_reason?: string;             // when source = twilio_neverr_line
}

export async function resolveOutboundCallerId(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ResolvedCallerId | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("business_id, phone_number, twilio_phone_number")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    Sentry.captureMessage("resolve_outbound_caller_id_db_read_failed", {
      level: "error",
      extra: { businessId, error: error.message },
    });
    return null;
  }
  if (!data) return null;
  const row = data as {
    business_id: string;
    phone_number: string | null;
    twilio_phone_number: string | null;
  };

  const businessLine = (row.phone_number || "").trim();
  const twilioLine = (row.twilio_phone_number || "").trim();

  // Prefer the business's main line for branded caller ID. The Twilio
  // call create will fail with error 21217 ("Phone number not verified")
  // if the customer hasn't completed verification — the route handler
  // catches that and re-issues with the Twilio Neverr line.
  if (businessLine && /^\+?[1-9]\d{6,14}$/.test(businessLine)) {
    return { from: businessLine, source: "business_main_line" };
  }

  if (twilioLine && /^\+?[1-9]\d{6,14}$/.test(twilioLine)) {
    return {
      from: twilioLine,
      source: "twilio_neverr_line",
      fallback_reason: "business_main_line_missing_or_invalid",
    };
  }

  Sentry.captureMessage("resolve_outbound_caller_id_no_valid_number", {
    level: "error",
    extra: { businessId, phone_number: businessLine, twilio_phone_number: twilioLine },
  });
  return null;
}
