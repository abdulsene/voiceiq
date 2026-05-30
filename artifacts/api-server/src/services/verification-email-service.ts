/**
 * Sprint 2 STEP 4 / BUG-18: email-verification issuance + send.
 *
 * Single shared helper used by:
 *   1. The Stripe webhook (app.ts checkout.session.completed) the moment
 *      a business transitions out of pending_payment into trialing/active.
 *      This is the PRIMARY trigger — see the BUG-18 DO-NOT list explaining
 *      why /signup itself does NOT call this (we'd email people who
 *      never finish Checkout, hurting Resend reputation).
 *   2. The /api/auth/resend-verification route (auth.ts) for users whose
 *      original token expired or whose email was lost.
 *
 * The send is fire-and-forget on the Resend leg: a failed email gets
 * logged to console + Sentry but does NOT throw to the caller. Webhook
 * handlers and signup flows must NEVER fail on email-send issues.
 *
 * The token write IS strict: if the INSERT fails, this throws so the
 * caller can decide whether to retry or surface to the user.
 */

import { Resend } from "resend";
import * as Sentry from "@sentry/node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { secureToken } from "../middlewares/staff-rbac";
import { generateVerificationEmail } from "../email-templates/email-verification";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = "evt";
const TOKEN_BYTES = 32;

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

function buildVerifyUrl(token: string): string {
  // Honor an explicit override (set in env) for environments where the
  // dashboard isn't on neverr.ai. Falls back to the production URL the
  // brief specified.
  const base =
    process.env.NEVERR_PUBLIC_URL?.replace(/\/+$/, "") || "https://neverr.ai";
  return `${base}/verify-email?token=${encodeURIComponent(token)}`;
}

export interface IssueAndSendResult {
  /** True if the token was inserted; false on DB-write failure. */
  tokenIssued: boolean;
  /** True if Resend accepted the send (or skipped because no API key). */
  emailSent: boolean;
  /** The token string (for tests). Do NOT log or surface to clients. */
  token?: string;
  /** Error message on failure path, for Sentry / structured logging. */
  error?: string;
}

/**
 * Issue a fresh verification token for `userId`/`email` and email the
 * verify-link to `email`. Marks ANY prior unused tokens for this user
 * as used so a previously-mailed link can't double-verify after a
 * resend.
 */
export async function issueAndSendVerification(
  supabase: SupabaseClient,
  userId: string,
  email: string,
): Promise<IssueAndSendResult> {
  if (!userId || !email) {
    return { tokenIssued: false, emailSent: false, error: "userId and email are required" };
  }

  // Claim-as-used on prior unused tokens for this user. Ignore the error
  // if no rows match — that's the common path (first-time issuance).
  try {
    await supabase
      .from("email_verification_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("used_at", null);
  } catch (e: any) {
    // Non-fatal: worst case a stale prior token also remains valid for
    // 24h. Log but continue.
    console.warn("[VerificationEmail] Could not invalidate prior tokens:", e?.message ?? String(e));
  }

  const token = secureToken(TOKEN_PREFIX, TOKEN_BYTES);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const { error: insertErr } = await supabase
    .from("email_verification_tokens")
    .insert({ token, user_id: userId, email, expires_at: expiresAt });

  if (insertErr) {
    console.error("[VerificationEmail] Token insert failed:", insertErr.message);
    Sentry.captureMessage("verification_token_insert_failed", {
      level: "error",
      extra: { user_id: userId, email, error: insertErr.message },
    });
    return { tokenIssued: false, emailSent: false, error: insertErr.message };
  }

  const verifyUrl = buildVerifyUrl(token);
  const tpl = generateVerificationEmail({
    email,
    verifyUrl,
    expiresIn: "in 24 hours",
  });

  const resend = getResend();
  if (!resend) {
    console.log("[VerificationEmail] Skipping send — RESEND_API_KEY not set. Token issued.");
    return { tokenIssued: true, emailSent: false, token };
  }

  try {
    await resend.emails.send({
      from: "Neverr <verify@neverr.ai>",
      to: email,
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    console.log("[VerificationEmail] Sent to:", email);
    return { tokenIssued: true, emailSent: true, token };
  } catch (e: any) {
    // Per brief: do NOT throw. Token is issued; the user can hit Resend
    // from the EmailVerificationScreen if the email never lands.
    console.error("[VerificationEmail] Resend send failed:", e?.message ?? String(e));
    Sentry.captureException(e, {
      extra: { route: "verification-email-service", user_id: userId, email },
    });
    return { tokenIssued: true, emailSent: false, token, error: e?.message ?? String(e) };
  }
}

/**
 * Webhook-side helper used by app.ts. Looks up the business owner's user
 * id + email and fires the verification flow ONLY on the genuine
 * `pending_payment` → `trialing`/`active` transition.
 *
 * Why the transition gate matters: Stripe sends multiple events for a
 * single signup (checkout.session.completed AND customer.subscription.created
 * back-to-back; later customer.subscription.updated for trial-end, payment
 * success, payment failure, plan changes, etc). Without the gate we'd
 * either spam users with duplicate emails on every webhook, or — if we
 * gate solely on `email_verified=false` — keep emailing the same user
 * every time their card gets charged. The pending_payment → real-status
 * flip happens exactly once per signup, which is exactly when we want
 * one email.
 *
 * Errors are caught and logged at the call site — this helper itself
 * swallows nothing, so callers can wrap in their own try/catch with
 * webhook-source-specific Sentry context.
 */
export async function dispatchVerificationOnStatusFlip(
  supabase: SupabaseClient,
  args: {
    businessId: string;
    newStatus: string;
    previousStatus: string | null | undefined;
    stripeEventId: string;
    source: string;
  },
): Promise<{ dispatched: boolean; reason?: string }> {
  const { businessId, newStatus, previousStatus, stripeEventId, source } = args;

  if (newStatus !== "trialing" && newStatus !== "active") {
    return { dispatched: false, reason: "new_status_not_good" };
  }
  // Only fire on the genuine flip OUT of pending_payment (or null/undefined,
  // which represents a legacy row from before signup INSERT was added in
  // BUG-17 sub-step 3b). Already in trialing/active/past_due/cancelled →
  // skip (we already emailed, or this isn't a fresh signup).
  if (
    previousStatus !== "pending_payment" &&
    previousStatus !== null &&
    previousStatus !== undefined
  ) {
    return { dispatched: false, reason: `prev_was_${previousStatus}` };
  }

  const { data: ownerRow } = await supabase
    .from("user_businesses")
    .select("user_id")
    .eq("business_id", businessId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const ownerUserId = ownerRow?.user_id as string | undefined;
  if (!ownerUserId) {
    return { dispatched: false, reason: "owner_not_found" };
  }

  const { data: cfgRow } = await supabase
    .from("business_configs")
    .select("email_verified")
    .eq("business_id", businessId)
    .maybeSingle();
  if (cfgRow?.email_verified === true) {
    return { dispatched: false, reason: "already_verified" };
  }

  const { data: userResult } = await supabase.auth.admin.getUserById(ownerUserId);
  const ownerEmail = userResult?.user?.email;
  if (!ownerEmail) {
    return { dispatched: false, reason: "owner_email_missing" };
  }

  const r = await issueAndSendVerification(supabase, ownerUserId, ownerEmail);
  console.log(
    "[VerificationEmail] Dispatched on status flip:",
    JSON.stringify({
      event: "verification_email_dispatched",
      source,
      business_id: businessId,
      user_id: ownerUserId,
      previous_status: previousStatus ?? null,
      new_status: newStatus,
      token_issued: r.tokenIssued,
      email_sent: r.emailSent,
      error: r.error || null,
      stripe_event_id: stripeEventId,
    }),
  );
  return { dispatched: true };
}
