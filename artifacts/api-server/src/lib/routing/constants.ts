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
 * in_app_calling_enabled = true counts as "fresh" when
 * user_businesses.voice_device_last_seen_at is within this many
 * seconds of now.
 *
 * Phase 3.15 — widened from 90s to 300s (5 min). Rationale: Chromium
 * (and Firefox to a lesser extent) throttles main-thread setInterval
 * in hidden tabs. Documented behaviour: after a tab has been hidden
 * for ~5 minutes, setInterval is clamped to firing at most once per
 * minute per timer (see Chromium's IntensiveWakeUpThrottling and
 * background-tab throttling design docs). A 30s ping under
 * throttling becomes ≥60s in practice, which blew straight through
 * the old 90s window and produced the exact prod incident this
 * phase fixes (owner on-duty 49h, no callback, silently unreachable).
 *
 * 300s tolerates ~4 consecutive throttled ticks. Combined with the
 * new visibility/focus/online triggers, recovery on tab-return is
 * instant (immediate ping) rather than waiting for the next interval.
 *
 * IMPORTANT: this constant controls the "fresh" *flag* only. Since
 * Phase 3.15 the routing engine INCLUDES stale-heartbeat candidates
 * as dial targets — a dead <Client> leg fails fast and Twilio's
 * simultaneous ring handles it. So a stale device no longer means
 * "silently dropped from routing"; it means "included, may not
 * answer, freshness surfaced to the user via reachability + banner."
 */
export const DEVICE_FRESHNESS_SECS = 300;

/**
 * Phase 3.15 — when EVERY candidate has a stale heartbeat AND no
 * callback number, shorten the Dial timeout so the caller doesn't
 * ring out for the full 30s before we fall through to legacy
 * transfer / after-hours. Twilio's default is 30; we use 15s in the
 * all-stale case as a compromise between "give the browser a chance
 * to actually answer if it's alive" and "don't burn dead air."
 *
 * Applies to the dial-builder when decision.staffCandidates is
 * non-empty AND every candidate has deviceStale=true AND no
 * callbackRingNumber. The mixed case (some fresh, some stale) keeps
 * the normal 30s timeout — the fresh ones might reasonably take the
 * whole window to answer.
 */
export const ALL_STALE_DIAL_TIMEOUT_SECS = 15;
