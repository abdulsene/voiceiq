/**
 * Twilio webhook signature validation.
 *
 * Twilio signs every webhook request with HMAC-SHA1 of (URL + sorted form
 * params) using the account's auth token as the secret. The signature
 * arrives in the X-Twilio-Signature header. Match → trust; mismatch →
 * reject as forged.
 *
 * URL reconstruction (the trap): Twilio signs the URL it CALLED. Behind
 * Replit's proxy, our Express app sees req.originalUrl with no host, and
 * req.host can be wrong (proxy internal hostname). We rebuild the full
 * URL as `${publicBase}${req.originalUrl}` using a public base URL we
 * control.
 *
 * Public-base resolution order:
 *   1. process.env.PUBLIC_API_URL (canonical; set in Replit Secrets per
 *      ops checklist)
 *   2. Hardcoded fallback https://voice-i-q.replit.app — fires a
 *      Sentry warning so the missing env var is visible.
 *
 * This is the first webhook signature validation in the codebase. The
 * existing /api/twilio/inbound and /api/twilio/* status endpoints use
 * URL-path obscurity; a hygiene commit to retrofit them is queued
 * out-of-band (per Slice 2A scope decision).
 */
import * as Sentry from "@sentry/node";
import twilio from "twilio";
import type { Request } from "express";

import { getPublicApiBase } from "./public-url";

/**
 * Phase 3.4 — enumerate every plausible base URL Twilio could have
 * signed against. Verification succeeds if ANY of them yields a
 * matching HMAC.
 *
 * Why multiple: Phase 3.2c had two separate helpers, each reading a
 * different env, and if PUBLIC_URL and PUBLIC_API_URL disagreed we'd
 * sign one URL and verify against another. Twilio would see 401 and
 * play "an application error has occurred" to the caller. lib/public-url
 * now unifies BUILDING, but for the moment of the deploy some
 * live calls may still be in flight against the OLD signed URL —
 * belt-and-braces try both PUBLIC_API_URL and (as fallbacks) the
 * legacy PUBLIC_URL/APP_URL. Plus a reconstruction from the
 * X-Forwarded-Proto/Host headers as a last resort.
 */
function candidateBaseUrls(req: Request): string[] {
  const primary = getPublicApiBase();
  const legacy1 = process.env.PUBLIC_URL?.trim();
  const legacy2 = process.env.APP_URL?.trim();
  // Header-based reconstruction — Replit terminates TLS so req.protocol
  // is unreliable; X-Forwarded-Proto is more accurate when `trust proxy`
  // is on (see app.ts:18).
  const xfProto = (req.headers["x-forwarded-proto"] as string | undefined) || req.protocol;
  const xfHost =
    (req.headers["x-forwarded-host"] as string | undefined) ||
    (req.headers["host"] as string | undefined);
  const reconstructed = xfProto && xfHost ? `${xfProto}://${xfHost}` : null;
  return Array.from(
    new Set(
      [primary, legacy1, legacy2, reconstructed]
        .filter((v): v is string => !!v && /^https?:\/\//.test(v))
        .map((u) => u.replace(/\/+$/, "")),
    ),
  );
}

/**
 * Reconstruct the canonical URL Twilio signed, given the inbound Express
 * request. Exported for testability — the smoke test rebuilds with a
 * known PUBLIC_API_URL and asserts the signature matches.
 */
export function reconstructTwilioUrl(req: Request): string {
  // For LOGGING / tests we return the primary candidate; verification
  // itself walks every candidate via verifyTwilioSignature below.
  return `${getPublicApiBase()}${req.originalUrl}`;
}

/**
 * Validate the X-Twilio-Signature header against the rebuilt URL + form
 * params. Returns true if the signature is valid OR if we're in a
 * relaxed test mode (TWILIO_WEBHOOK_VERIFY=0 in env — meant for local
 * smoke tests, NEVER set in production).
 *
 * For Twilio's default form-encoded webhooks, pass req.body as the
 * params object. For JSON webhooks (rare; we don't expect any in this
 * slice), the twilio SDK has a different helper — flag here for future
 * use.
 */
export function verifyTwilioSignature(req: Request): boolean {
  if (process.env.TWILIO_WEBHOOK_VERIFY === "0") {
    // Documented escape hatch for local smoke tests so we don't ship a
    // shared mocking layer. Sentry breadcrumb so production accidentally
    // running with this set lights up the dashboard.
    Sentry.addBreadcrumb({
      category: "twilio.signature",
      level: "warning",
      message: "twilio_signature_verification_bypassed_test_mode",
    });
    return true;
  }
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    Sentry.captureMessage("twilio_signature_verify_no_auth_token", {
      level: "error",
      extra: { path: req.originalUrl },
    });
    return false;
  }
  const signature = req.header("x-twilio-signature");
  if (!signature) return false;

  // Twilio's webhook payloads are application/x-www-form-urlencoded.
  // Express's body-parser populates req.body as a plain object that
  // validateRequest consumes directly.
  const params = (req.body || {}) as Record<string, unknown>;

  // Phase 3.4 — try every candidate base URL. If any yields a valid
  // HMAC, accept. This survives PUBLIC_URL vs PUBLIC_API_URL drift AND
  // the moment-of-deploy period where existing calls were signed with
  // the old URL. Log which candidate matched so ops can tighten config.
  const candidates = candidateBaseUrls(req);
  const attempted: Array<{ url: string; ok: boolean }> = [];
  for (const base of candidates) {
    const url = `${base}${req.originalUrl}`;
    let ok = false;
    try {
      ok = twilio.validateRequest(
        authToken,
        signature,
        url,
        params as Record<string, string>,
      );
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: {
          route: "twilio-signature.verifyTwilioSignature",
          candidate: url,
        },
      });
      ok = false;
    }
    attempted.push({ url, ok });
    if (ok) {
      // Surface which URL matched — if it wasn't the primary
      // (getPublicApiBase), that's a signal to tighten config.
      const primary = `${getPublicApiBase()}${req.originalUrl}`;
      if (url !== primary) {
        Sentry.captureMessage("twilio_signature_matched_fallback_url", {
          level: "warning",
          extra: {
            matched: url,
            primary,
            impact:
              "Signature validated against a fallback base URL, not PUBLIC_API_URL. Set PUBLIC_API_URL to the value that matched to remove the drift.",
          },
        });
      }
      return true;
    }
  }

  // Nothing matched — log the full attempt list so ops can see exactly
  // which URLs were tried without leaking secrets.
  Sentry.captureMessage("twilio_signature_verify_failed_all_candidates", {
    level: "error",
    extra: {
      path: req.originalUrl,
      attempted,
      xfProto: req.headers["x-forwarded-proto"] ?? null,
      xfHost: req.headers["x-forwarded-host"] ?? null,
      host: req.headers["host"] ?? null,
    },
  });
  return false;
}
