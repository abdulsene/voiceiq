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

const HARDCODED_FALLBACK_BASE = "https://voice-i-q.replit.app";

/**
 * Resolve the public base URL Twilio used when it signed this request.
 * Logs a Sentry warning ONCE per process when falling back to the
 * hardcoded constant — chatty logs are unhelpful, but a startup-time
 * signal lets ops fix the env without a redeploy.
 */
let warnedAboutMissingPublicBase = false;
function resolvePublicBase(): string {
  const env = process.env.PUBLIC_API_URL;
  if (env && env.startsWith("http")) {
    return env.replace(/\/+$/, "");
  }
  if (!warnedAboutMissingPublicBase) {
    warnedAboutMissingPublicBase = true;
    Sentry.captureMessage("public_api_url_env_missing_falling_back", {
      level: "warning",
      extra: {
        fallback: HARDCODED_FALLBACK_BASE,
        impact: "Twilio webhook signature URL reconstruction uses hardcoded constant. Set PUBLIC_API_URL in Replit Secrets.",
      },
    });
    console.warn("[twilio-signature] PUBLIC_API_URL not set — falling back to", HARDCODED_FALLBACK_BASE);
  }
  return HARDCODED_FALLBACK_BASE;
}

/**
 * Reconstruct the canonical URL Twilio signed, given the inbound Express
 * request. Exported for testability — the smoke test rebuilds with a
 * known PUBLIC_API_URL and asserts the signature matches.
 */
export function reconstructTwilioUrl(req: Request): string {
  const base = resolvePublicBase();
  // req.originalUrl includes the path + querystring as Twilio sent it.
  return `${base}${req.originalUrl}`;
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
  const url = reconstructTwilioUrl(req);
  // Twilio's webhook payloads are application/x-www-form-urlencoded.
  // Express's body-parser populates req.body as a plain object that
  // validateRequest consumes directly.
  const params = (req.body || {}) as Record<string, unknown>;
  try {
    // The SDK's validator handles parameter sorting + HMAC under the
    // hood. Returns boolean.
    return twilio.validateRequest(authToken, signature, url, params as Record<string, string>);
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "twilio-signature.verifyTwilioSignature", path: req.originalUrl },
    });
    return false;
  }
}
