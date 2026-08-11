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

/**
 * Phase 5.4 — collapse immediate substring repeats within one line.
 *
 * scraping.ts:scrapeCheerio does `$("body").text().replace(/\s+/g, " ")`,
 * which concatenates ALL descendant text nodes with no inter-element
 * separator. When a nav-menu or hero-carousel component renders the
 * same text N times inside one DOM subtree (common on template sites
 * with sticky headers, skip-nav a11y duplicates, or slick/swiper
 * carousels), the output is one line like:
 *
 *   "EZ Rentals and LeasingEZ Rentals and LeasingEZ Rentals and Leasing"
 *
 * Phase 5.3's cleaner only dedupped after splitting on newlines and
 * sentence terminators — for a defect that lives INSIDE one segment
 * with no delimiters, nothing got dedupped. This step catches those
 * before segmentation.
 *
 * Regex mechanics:
 *   /(.{8,200}?)\1+/g
 *     - `.{8,200}?`  lazy so we find the SHORTEST repeating unit
 *                    (8-char floor rejects noise like "  " or "..";
 *                    200-char ceiling caps engine backtracking).
 *     - `\1+`        greedy so we collapse ALL consecutive repeats
 *                    of that unit in one shot.
 *     - No `s` flag  so `.` does NOT cross `\n` — repeats are found
 *                    within a single line, not across page-header
 *                    boundaries.
 *
 * Not catastrophic: both the repeating-unit length and the
 * body-length are bounded (input capped at MAX_CONTEXT_CHARS in
 * scraping.ts). Idempotent — collapsing "AAAA" to "A" leaves "A"
 * which has no immediate repeat.
 */
function collapseImmediateRepeats(raw: string): string {
  return raw.replace(/(.{8,200}?)\1+/g, "$1");
}

/**
 * Phase 5.4 — cross-segment phrase dedup.
 *
 * After collapseImmediateRepeats catches within-line repeats, we're
 * left with the pattern seen in production: hero + tagline boilerplate
 * repeats ACROSS pages (once per page) because pages are separated by
 * URL headers and different trailing facts, so segment-level dedup and
 * immediate-repeat both miss it.
 *
 * Approach:
 *   1. Count all 20-char substrings in the input; retain those with
 *      count >= 2 as recurring "seeds" (20 chars is long enough to
 *      exclude common English trigrams; short enough to fit a hero
 *      phrase like "EZ Rentals and Leasing").
 *   2. For each seed, extend the match right (and left) as far as the
 *      matches still align → identifies the maximal common substring.
 *   3. Keep the FIRST occurrence, remove subsequent ones. First-seen
 *      wins because it typically appears in the homepage's hero
 *      block, which is the most authoritative phrasing.
 *
 * Bounded complexity: seed enumeration is O(n), extension is O(n×k)
 * for k seeds. With n <= 15000 (post-cap) and k typically < 20, this
 * completes in <1ms. Not a suffix-array optimum, but plenty fast.
 *
 * URL-header lines ("=== url ===") are excluded from seed
 * consideration by prefixing a sentinel that breaks the 20-char match
 * (we skip them explicitly during seed extraction).
 */
const PHRASE_SEED_LEN = 20;
const PHRASE_MIN_KEEP_LEN = 15;

function dedupRecurringPhrases(text: string): string {
  if (text.length < PHRASE_SEED_LEN * 2) return text;

  // Build seed counts — but skip any 20-char window that spans or
  // starts inside a URL-header line, since those are per-page markers
  // we WANT to preserve.
  const urlHeaderRanges: Array<[number, number]> = [];
  const urlRe = /^=== .+ ===$/gm;
  for (const m of text.matchAll(urlRe)) {
    if (m.index != null) {
      urlHeaderRanges.push([m.index, m.index + m[0].length]);
    }
  }
  const inUrlHeader = (pos: number): boolean =>
    urlHeaderRanges.some(([s, e]) => pos >= s && pos < e);
  // Reject a seed range if ANY position in [i, i+PHRASE_SEED_LEN)
  // sits inside a URL header — not just the start. Otherwise a seed
  // beginning at "\n=== https://exampl…" (start outside header, tail
  // reaching into the URL header) recurs across pages and my dedup
  // eats the URL headers themselves. Verified against the multi-page
  // fixture in Phase 5.4.
  const overlapsUrlHeader = (start: number, len: number): boolean => {
    for (const [s, e] of urlHeaderRanges) {
      if (start < e && start + len > s) return true;
    }
    return false;
  };

  const counts = new Map<string, number>();
  for (let i = 0; i <= text.length - PHRASE_SEED_LEN; i++) {
    if (overlapsUrlHeader(i, PHRASE_SEED_LEN)) continue;
    const s = text.slice(i, i + PHRASE_SEED_LEN);
    counts.set(s, (counts.get(s) || 0) + 1);
  }

  // Sort recurring seeds by seed-length descending (all same length
  // here, so this is a no-op) and process — remove longer matches
  // first so we don't accidentally split a longer common phrase.
  const recurring = [...counts.entries()].filter(([, c]) => c >= 2).map(([s]) => s);

  let out = text;
  const processed = new Set<string>();
  for (const seed of recurring) {
    if (processed.has(seed)) continue;
    const firstIdx = out.indexOf(seed);
    if (firstIdx < 0) continue;

    // Find all occurrence positions.
    const positions: number[] = [];
    let searchFrom = 0;
    while (true) {
      const idx = out.indexOf(seed, searchFrom);
      if (idx < 0) break;
      positions.push(idx);
      searchFrom = idx + 1;
    }
    if (positions.length < 2) continue;

    // Extend right: grow the seed as long as the char after matches
    // at every position (skipping the first, which is the anchor).
    // Stop if extension would enter a URL header range at ANY of the
    // occurrence positions — URL headers must not be consumed by
    // phrase merges, or we'd delete per-page provenance markers.
    let extendedLen = PHRASE_SEED_LEN;
    while (positions[0] + extendedLen < out.length) {
      const nextPositions = positions.map((p) => p + extendedLen);
      if (nextPositions.some(inUrlHeader)) break;
      const anchorChar = out[positions[0] + extendedLen];
      const allMatch = positions
        .slice(1)
        .every(
          (p) =>
            p + extendedLen < out.length &&
            out[p + extendedLen] === anchorChar,
        );
      if (!allMatch) break;
      extendedLen++;
      if (extendedLen > 500) break; // safety cap
    }
    // Extend left similarly.
    let leftShift = 0;
    while (positions[0] - leftShift - 1 >= 0) {
      const prevPositions = positions.map((p) => p - leftShift - 1);
      if (prevPositions.some((p) => p >= 0 && inUrlHeader(p))) break;
      const anchorChar = out[positions[0] - leftShift - 1];
      const allMatch = positions
        .slice(1)
        .every(
          (p) =>
            p - leftShift - 1 >= 0 && out[p - leftShift - 1] === anchorChar,
        );
      if (!allMatch) break;
      leftShift++;
      if (leftShift > 500) break;
    }

    const phraseLen = extendedLen + leftShift;
    if (phraseLen < PHRASE_MIN_KEEP_LEN) continue;
    const startFromFirst = positions[0] - leftShift;
    const phrase = out.slice(startFromFirst, startFromFirst + phraseLen);
    processed.add(phrase);

    // Remove second and later occurrences (walk right-to-left so
    // indices stay stable during splicing).
    const removalStarts = positions
      .slice(1)
      .map((p) => p - leftShift)
      .filter((p) => p >= 0)
      .sort((a, b) => b - a);
    for (const start of removalStarts) {
      if (out.slice(start, start + phraseLen) === phrase) {
        out = out.slice(0, start) + out.slice(start + phraseLen);
      }
    }
  }

  return out;
}

export function cleanScrapedText(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  // Phase 5.4 — two-stage collapse. First catches within-line
  // immediate repeats ("XYZXYZXYZ" → "XYZ"), which fixes nav/hero
  // components rendered multiple times inside one DOM subtree.
  // Second catches recurring long phrases (>= 15 chars) that appear
  // in multiple pages — hero+tagline boilerplate that repeats once
  // per page after in-line collapse. First-seen wins so the
  // homepage's phrasing survives.
  const collapsed = dedupRecurringPhrases(collapseImmediateRepeats(raw));

  const rawSegments: string[] = [];
  for (const line of collapsed.split(/\r?\n/)) {
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

  // Mid-word truncation trim: if the LAST segment ends without
  // sentence-terminal punctuation AND has more than one word, it's
  // almost certainly a hard-slice remnant from an upstream char cap.
  // Only fires when there are multiple segments (finalNl >= 0) —
  // otherwise "dropping the last segment" would delete ALL content
  // (this was the Phase 5.4 test regression: an entire cleaned blob
  // that happens to be a single unpunctuated segment got zeroed out).
  const finalNl = out.lastIndexOf("\n");
  if (finalNl >= 0) {
    const lastSeg = out.slice(finalNl + 1);
    if (
      lastSeg &&
      !/[.!?]"?$/.test(lastSeg) &&
      lastSeg.split(/\s+/).length > 1 &&
      !lastSeg.startsWith("=== ")
    ) {
      out = out.slice(0, finalNl);
    }
  }

  return out.trim();
}
