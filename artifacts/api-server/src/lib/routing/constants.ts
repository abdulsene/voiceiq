/**
 * Phase 3.3 — routing engine constants shared between the routing
 * candidate query (routes/routing.ts) and the softphone endpoints
 * (routes/voice.ts).
 *
 * Lives in lib/ (not a route file) so both sides can import without
 * creating a route → route dependency cycle. Phase 3.3 duplicated
 * the value in both files with a rationale comment about "avoiding
 * the cycle"; the correct fix was to put the constant in lib/, done
 * here in 3.3a.
 */

/**
 * Device presence freshness in seconds. A staff member with
 * in_app_calling_enabled = true counts as "device present" only if
 * their user_businesses.voice_device_last_seen_at is within this
 * many seconds of now. The routing candidate query drops staff whose
 * device is stale AND who lack a callback_ring_number (otherwise
 * routing would ring a dead <Client> endpoint).
 *
 * 90s is 3x the frontend's ~30s heartbeat cadence — one dropped
 * ping keeps them online; two in a row marks them unavailable.
 */
export const DEVICE_FRESHNESS_SECS = 90;
