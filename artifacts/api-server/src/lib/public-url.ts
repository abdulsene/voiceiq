/**
 * Single source of truth for the public API base URL.
 *
 * Phase 3.4 — HARD LESSON: Phase 3.2c had TWO helpers doing this. One
 * built the callback URL Twilio would hit (routes/routing.ts::
 * getPublicUrl, `PUBLIC_URL || APP_URL || "https://neverr.ai"`); the
 * other verified Twilio's signature (lib/twilio-signature.ts::
 * resolvePublicBase, `PUBLIC_API_URL || "https://voice-i-q.replit.app"`).
 * If the two envs disagreed in Replit Secrets — very common because
 * Replit auto-generates the internal `.replit.app` URL while ops
 * often set `PUBLIC_URL=https://neverr.ai` for user-facing links —
 * Twilio signed one URL, we verified against another, HMAC mismatched,
 * we returned 401. Twilio treats 401 on a mid-call <Dial action>
 * callback as a webhook failure and plays "an application error has
 * occurred" to the caller. Silent config drift → customer-audible
 * fault.
 *
 * Fix: ONE helper reads env vars in a fixed preference order and
 * yells (Sentry warning, ONCE per process) when the two are set and
 * disagree. Every callback URL AND every signature verification goes
 * through this same value.
 */

import * as Sentry from "@sentry/node";

const HARDCODED_FALLBACK_BASE = "https://voice-i-q.replit.app";

let warnedAboutMissing = false;
let warnedAboutDivergence = false;

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Returns the public HTTPS base URL Twilio (and other external
 * webhooks) should use to reach us.
 *
 * Preference order:
 *   1. PUBLIC_API_URL  — canonical, per the deploy docs. Always wins.
 *   2. PUBLIC_URL      — legacy from routing.ts::getPublicUrl. Kept
 *                        for compat; if PUBLIC_API_URL isn't set but
 *                        PUBLIC_URL is, we use it and warn.
 *   3. APP_URL         — even older legacy.
 *   4. HARDCODED_FALLBACK_BASE — dev-only. Fires a Sentry warning.
 *
 * When multiple envs are set AND disagree, we take PUBLIC_API_URL as
 * the winner but fire a one-shot Sentry warning noting the mismatch —
 * silent drift here is the exact bug this helper closes.
 */
export function getPublicApiBase(): string {
  const primary = process.env.PUBLIC_API_URL?.trim();
  const legacy1 = process.env.PUBLIC_URL?.trim();
  const legacy2 = process.env.APP_URL?.trim();

  const candidates = [primary, legacy1, legacy2].filter(
    (v): v is string => !!v && /^https?:\/\//.test(v),
  );

  // Divergence detection — if two independent envs point at different
  // hosts we WILL misalign signatures. Fire once per process.
  const distinctBases = new Set(candidates.map(stripTrailingSlash));
  if (distinctBases.size > 1 && !warnedAboutDivergence) {
    warnedAboutDivergence = true;
    Sentry.captureMessage("public_api_url_env_divergence", {
      level: "warning",
      extra: {
        PUBLIC_API_URL: primary || null,
        PUBLIC_URL: legacy1 || null,
        APP_URL: legacy2 || null,
        chosen: candidates[0],
        impact:
          "Multiple public-URL envs set with different values. Twilio callbacks will fail HMAC verification unless the URL used to BUILD the callback matches the URL used to VERIFY. Set ONE env (prefer PUBLIC_API_URL) and remove the others.",
      },
    });
    console.warn(
      "[public-url] env divergence — PUBLIC_API_URL / PUBLIC_URL / APP_URL disagree; using",
      candidates[0],
    );
  }

  if (candidates.length > 0) return stripTrailingSlash(candidates[0]);

  if (!warnedAboutMissing) {
    warnedAboutMissing = true;
    Sentry.captureMessage("public_api_url_env_missing_falling_back", {
      level: "warning",
      extra: {
        fallback: HARDCODED_FALLBACK_BASE,
        impact:
          "No PUBLIC_API_URL / PUBLIC_URL / APP_URL set. Twilio webhook signature verification will use the hardcoded fallback. Set PUBLIC_API_URL in Replit Secrets.",
      },
    });
    console.warn("[public-url] no env set — falling back to", HARDCODED_FALLBACK_BASE);
  }
  return HARDCODED_FALLBACK_BASE;
}

/**
 * Test helper — reset the one-shot warning flags so a smoke can
 * exercise the divergence path multiple times.
 */
export function _resetPublicUrlWarningsForTests(): void {
  warnedAboutMissing = false;
  warnedAboutDivergence = false;
}
