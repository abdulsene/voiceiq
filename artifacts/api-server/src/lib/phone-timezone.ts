/**
 * Phase 1.2 — NANP area code → IANA timezone resolver.
 *
 * Consumed by lib/outbound-voice/place-call.ts (lands in 1.3) to feed
 * checkCallingHours() with the recipient's IANA timezone for TCPA
 * window enforcement.
 *
 * Strategy:
 *   - Static JSON map at lib/data/area-code-timezone.json. ~300 active
 *     NANP area codes covering US states + DC + territories + Canada
 *     + Caribbean NANP countries (Bahamas, DR, Jamaica, etc).
 *   - Lookup is O(1) hash on the 3-digit area code parsed by
 *     extractAreaCodeFromPhoneNumber() (lib/phone-utils.ts).
 *   - Returns null on non-NANP numbers (anything that isn't +1...).
 *     Caller fails-closed with reason='non_nanp_number_no_tz_inference'
 *     — refuses the call rather than guess.
 *
 * Why static JSON not API:
 *   Twilio Lookup ($0.005/call) would mean a per-call API roundtrip
 *   added to placement latency for every single outbound dial. NANPA
 *   data is public, stable, and small (~10KB JSON) — wrong tradeoff
 *   to go external. Sub-area-code accuracy (rare span-TZ edge cases
 *   like 970 in CO/UT) would matter at million-call scale; Phase 1
 *   accepts the ~1% miscalibration as a documented limitation.
 *
 * Span-TZ caveats (~1% accuracy loss, documented for future fixers):
 *   - 970 (Colorado / small Utah corner) → America/Denver (Mountain
 *     covers dominant population)
 *   - 208 (Idaho with small Pacific panhandle) → America/Denver
 *     (Mountain covers dominant population — Boise area is Mountain)
 *   - 541 (Oregon with Mountain east in Malheur County) →
 *     America/Los_Angeles (Pacific covers dominant population)
 *   - 806 (Texas Panhandle) → America/Chicago (Lubbock is Central;
 *     northern panhandle has small Mountain area)
 *   - 308 (western Nebraska) → America/Chicago (Central by
 *     population; western strip is Mountain)
 *   - 701 (North Dakota with small western Mountain) →
 *     America/Chicago (Central dominant)
 *   - 605 (South Dakota with small western Mountain) →
 *     America/Chicago (Central dominant)
 *   - 906 (Michigan UP) → America/Chicago (Central — most of UP
 *     observes Central despite the rest of Michigan being Eastern)
 *   - 867 (Yukon / NWT / Nunavut) → America/Edmonton (Yellowknife
 *     is the population-dominant city in Mountain; Whitehorse
 *     in Yukon now permanently observes Pacific without DST,
 *     and Nunavut spans Eastern + Central — picking Edmonton
 *     covers the largest single jurisdiction at acceptable error)
 *
 * DST handling: NOT our concern. We return the IANA name; the
 * downstream Intl.DateTimeFormat in lib/calling-hours.ts resolves
 * wall-clock time correctly per the current DST rules in tzdata.
 *
 * Indiana note: most of Indiana observes Eastern Time with DST
 * (since 2006). We map Indianapolis (317), South Bend (574), Fort
 * Wayne (260), Bloomington/Evansville (812, 930), Lafayette (765),
 * and the Indianapolis overlay (463) to America/New_York. Gary /
 * Northwest Indiana (219) is Central — America/Chicago.
 */

import data from "./data/area-code-timezone.json" with { type: "json" };
import { extractAreaCodeFromPhoneNumber } from "./phone-utils";

const map = data as Record<string, string>;

// Boot-time sanity check. If the JSON is partial (e.g. a merge ate
// half the file, or a build process bundled a stub), the assert
// crashes the process before the first call placement attempt. Better
// than silently returning null on every lookup and failing-closed on
// every outbound call.
const ENTRY_COUNT = Object.keys(map).length;
if (ENTRY_COUNT < 300) {
  throw new Error(
    `phone-timezone: area-code map has only ${ENTRY_COUNT} entries; expected >=300. The JSON file may be partial or corrupted.`,
  );
}

/**
 * Resolve a phone number's recipient timezone via its NANP area code.
 *
 * Returns null when:
 *   - The number is non-NANP — extractAreaCode returns null (UK, EU,
 *     anything outside +1).
 *   - The area code parses but isn't in our map. Rare; could happen
 *     for newly-activated codes we haven't catalogued yet.
 *
 * Caller (Phase 1.3's place-call.ts) treats null as a fail-closed
 * signal: refuses the call with
 * reason='non_nanp_number_no_tz_inference' rather than guess.
 *
 * @example
 *   resolveRecipientTimezone('+12025551212') → 'America/New_York'
 *   resolveRecipientTimezone('+13105551212') → 'America/Los_Angeles'
 *   resolveRecipientTimezone('+447911123456') → null   (UK)
 *   resolveRecipientTimezone('+1') → null               (degenerate)
 */
export function resolveRecipientTimezone(phoneE164: string | null | undefined): string | null {
  if (!phoneE164) return null;
  const areaCode = extractAreaCodeFromPhoneNumber(phoneE164);
  if (!areaCode) return null;
  return map[areaCode] ?? null;
}

// Exported for the smoke test only — confirms boot-time sanity check
// landed.
export const __areaCodeMapSize = ENTRY_COUNT;
