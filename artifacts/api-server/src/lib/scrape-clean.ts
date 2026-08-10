/**
 * Phase 5.3 — shared cleaner for website-scrape text.
 *
 * Kept as a standalone module so prompt-renderer.ts can call it
 * without importing scraping.ts (which pulls cheerio + rate-limiter
 * transitively — undesirable for a pure renderer used in unit tests).
 * scraping.ts and lib/prompt-renderer.ts both import from here.
 *
 * The cleaner is a no-op on already-clean text; safe to call twice.
 *
 * Behavior (see also the EZ Rentals defect that motivated this):
 *   1. Split into segments on newlines and sentence terminators.
 *   2. Drop pure-nav / carousel labels (1-2 word ALL-CAPS tokens,
 *      one-word nav keywords like "Home"/"About"/"FAQ").
 *   3. Dedup case-insensitively so nav+footer repeats across pages
 *      collapse to a single occurrence.
 *   4. Trim mid-word truncation: if the last segment is unpunctuated
 *      and multi-word, drop it — it's almost always a hard-slice
 *      remnant from an upstream char cap.
 *   5. Preserve any "=== url ===" page-header annotations verbatim so
 *      downstream code retains provenance.
 */

// Kept conservative so short-but-real facts (address lines, price
// rows, hours snippets) don't get pruned as nav noise.
const MIN_SEGMENT_CHARS = 12;

export function cleanScrapedText(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  const rawSegments: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("=== ") && trimmed.endsWith(" ===")) {
      rawSegments.push(trimmed);
      continue;
    }
    // Split on sentence terminators so a body-text run (Cheerio
    // collapses whitespace to one line per page) can be deduped at
    // sentence granularity.
    for (const s of trimmed.split(/(?<=[.!?])\s+(?=[A-Z0-9])/)) {
      const seg = s.trim();
      if (seg) rawSegments.push(seg);
    }
  }

  const looksLikeNav = (s: string): boolean => {
    // 1-2 word ALL-CAPS button/nav labels: "HOME", "BOOK NOW".
    if (/^[A-Z0-9 ]{2,20}$/.test(s) && s.split(/\s+/).length <= 2) return true;
    if (
      /^(Home|About|Contact|Menu|Login|Sign\s*in|Sign\s*up|Search|More|FAQ|FAQs|Cart|Shop|Book|Blog)$/i.test(
        s,
      )
    ) {
      return true;
    }
    return false;
  };

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const seg of rawSegments) {
    if (seg.length < MIN_SEGMENT_CHARS && !seg.startsWith("=== ")) {
      if (looksLikeNav(seg)) continue;
    }
    const key = seg.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(seg);
  }

  let out = kept.join("\n");

  const finalNl = out.lastIndexOf("\n");
  const lastSeg = finalNl >= 0 ? out.slice(finalNl + 1) : out;
  if (
    lastSeg &&
    !/[.!?]"?$/.test(lastSeg) &&
    lastSeg.split(/\s+/).length > 1 &&
    !lastSeg.startsWith("=== ")
  ) {
    out = finalNl >= 0 ? out.slice(0, finalNl) : "";
  }

  return out.trim();
}
