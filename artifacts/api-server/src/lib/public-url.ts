/**
 * Single source of truth for the public API base URL.
 *
 * The pattern `(process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app").replace(/\/+$/, "")`
 * appears inlined at 4+ call sites today (lib/sms-service.ts,
 * routes/lead-calls.ts, routes/twilio-callbacks.ts, lib/twilio-signature.ts).
 * Each site re-derives the same value, so a future host change would
 * mean a 4-place edit + risk of one being missed.
 *
 * Phase 0 Commit 0-B uses this helper for its own URL construction. A
 * follow-up polish commit refactors the legacy call sites to the same
 * helper — left out of 0-B to keep the diff focused on the
 * provider abstraction.
 */
export function getPublicApiBase(): string {
  return (process.env.PUBLIC_API_URL || "https://voice-i-q.replit.app").replace(/\/+$/, "");
}
