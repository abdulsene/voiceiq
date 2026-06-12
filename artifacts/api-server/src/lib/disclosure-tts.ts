/**
 * Recording-disclosure TTS generator + in-process cache.
 *
 * Per the Slice 2A consent strategy (Checkpoint 1 / Maryland two-party
 * implied consent):
 *   - Staff hears: "Recording for quality and training. Connecting you
 *     to your customer." (shared across all businesses)
 *   - Customer hears: "This is {business_name} calling. This call may
 *     be recorded for quality and training purposes." (per-business)
 *
 * Voice: ElevenLabs Sarah (or whichever the customer's agent uses) for
 *        brand consistency. synthesizeSpeech() in lib/elevenlabs-tts.ts
 *        defaults to the same voice we use for the inbound agent.
 *
 * Cache strategy for Slice 2A: in-process Map keyed by
 * `${businessId}-${leg}`. Generated lazily on first fetch (a Twilio
 * <Play> request); subsequent calls hit the cache. Process restart =
 * one re-synth (~1s latency, ~$0.001 ElevenLabs cost). Acceptable for
 * the expected traffic (handful of bridges/day at launch).
 *
 * NOT going through Supabase Storage in this slice — the project has
 * no existing buckets and adding one expands scope. When the
 * disclosure volume or multi-replica deployment makes in-process cache
 * insufficient, the migration is straightforward: same key, swap the
 * Map for a Storage signed-URL fetch.
 */
import * as Sentry from "@sentry/node";
import { synthesizeSpeech } from "./elevenlabs-tts.js";

interface CachedAudio {
  mp3: Buffer;
  generatedAt: number;
}

// Bounded map — entries are tiny (~30-50KB MP3 each), so a 500-entry
// ceiling is well under 25MB heap. LRU would be nicer but overkill for
// Slice 2A; we just clear-the-oldest when over.
const cache = new Map<string, CachedAudio>();
const MAX_CACHE_ENTRIES = 500;

export type DisclosureLeg = "staff" | "customer";

const STAFF_DISCLOSURE_TEXT =
  "Recording for quality and training. Connecting you to your customer.";

function customerDisclosureText(businessName: string): string {
  // Strip business names to a reasonable length to avoid unexpectedly
  // long TTS clips if a customer entered a 200-char string. Real
  // business names rarely exceed ~60 chars.
  const safeName = businessName.trim().slice(0, 60) || "the team";
  return `This is ${safeName} calling. This call may be recorded for quality and training purposes.`;
}

function cacheKey(businessId: string, leg: DisclosureLeg): string {
  // Staff disclosure is identical across businesses — use a shared key
  // so we generate it ONCE per process for the entire customer base.
  if (leg === "staff") return "_shared_staff";
  return `${businessId}-customer`;
}

function maybeEvictOldest() {
  if (cache.size < MAX_CACHE_ENTRIES) return;
  // Find oldest entry. Map iteration is insertion-order so the first
  // entry IS the oldest unless we re-insert (we don't). Quick eviction:
  const firstKey = cache.keys().next().value;
  if (firstKey) cache.delete(firstKey);
}

/**
 * Get or generate the disclosure audio for a (businessId, leg) pair.
 * Returns the MP3 bytes ready to stream back via the GET endpoint with
 * Content-Type: audio/mpeg. Throws on TTS failure — the caller (a
 * Twilio <Play> URL) should respond with a graceful TwiML fallback when
 * this throws so the call doesn't drop silently.
 */
export async function getOrGenerateDisclosure(
  businessId: string,
  leg: DisclosureLeg,
  businessName: string,
): Promise<Buffer> {
  const key = cacheKey(businessId, leg);
  const hit = cache.get(key);
  if (hit) return hit.mp3;

  const text = leg === "staff"
    ? STAFF_DISCLOSURE_TEXT
    : customerDisclosureText(businessName);

  const result = await synthesizeSpeech(text);
  if (!result.ok) {
    Sentry.captureMessage("disclosure_tts_synthesis_failed", {
      level: "error",
      extra: {
        businessId,
        leg,
        status: result.status,
        reason: result.reason,
      },
    });
    throw new Error(`Disclosure TTS failed: ${result.reason}`);
  }
  // synthesizeSpeech returns a streaming Response (designed for chat-tts
  // pass-through). For our cache we buffer it fully — disclosure clips
  // are short (< 10s ~ ~150KB) so the memory hit is negligible.
  const arrayBuffer = await result.response.arrayBuffer();
  const mp3 = Buffer.from(arrayBuffer);

  maybeEvictOldest();
  cache.set(key, { mp3, generatedAt: Date.now() });
  return mp3;
}

/**
 * Test seam: clear the cache. Used by the smoke test to assert that a
 * second request hits the cache (no second ElevenLabs round-trip).
 */
export function _clearDisclosureCacheForTests() {
  cache.clear();
}
