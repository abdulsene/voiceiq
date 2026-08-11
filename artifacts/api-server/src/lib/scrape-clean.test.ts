/**
 * Phase 5.3 / 5.4 — unit tests for the scrape cleaner used by both
 * src/scraping.ts (on ingest) and src/lib/prompt-renderer.ts (as a
 * safety net for legacy dirty rows).
 *
 * Phase 5.4 note on fixtures:
 *   The original 5.3 fixtures (dedup-nav-line, EZ-Rentals-8x-nav)
 *   put nav items and hero copy on SEPARATE LINES. Real scrapeCheerio
 *   output does NOT — `$("body").text().replace(/\s+/g, " ")` collapses
 *   each page to a single line with all descendant text concatenated
 *   without inter-element separators. Verified in production: the
 *   post-5.3 EZ Rentals prompt still contained "EZ Rentals and
 *   Leasing" 23 times because the cleaner had no delimiters to split
 *   on. New tests (below the historical ones) hit that real shape.
 */

import { describe, test, expect } from "vitest";

import { cleanScrapedText } from "./scrape-clean";

describe("cleanScrapedText", () => {
  test("empty / non-string input returns empty string", () => {
    expect(cleanScrapedText("")).toBe("");
    expect(cleanScrapedText(undefined as unknown as string)).toBe("");
    expect(cleanScrapedText(null as unknown as string)).toBe("");
  });

  test("dedups repeated nav-line segments", () => {
    const raw = [
      "=== https://example.com ===",
      "About us. Contact. FAQ.",
      "=== https://example.com/about ===",
      "About us. Contact. FAQ.",
      "=== https://example.com/contact ===",
      "About us. Contact. FAQ.",
    ].join("\n");
    const out = cleanScrapedText(raw);
    // Three page headers preserved.
    expect(out.match(/=== /g)?.length).toBe(3);
    // "About us." should appear once, not three times.
    expect(out.match(/About us\./g)?.length).toBe(1);
  });

  test("drops ALL-CAPS nav labels but keeps address-like short facts", () => {
    const raw = [
      "HOME",
      "BOOK NOW",
      "CONTACT",
      "Serving Baltimore, MD.",
      "Open Mon-Fri.",
    ].join("\n");
    const out = cleanScrapedText(raw);
    expect(out).not.toContain("HOME");
    expect(out).not.toContain("BOOK NOW");
    expect(out).toContain("Serving Baltimore, MD.");
    expect(out).toContain("Open Mon-Fri.");
  });

  test("trims mid-word truncation off the last segment", () => {
    const raw =
      "Fleet includes economy sedans and SUVs.\nOur locations are Baltimore and Wash";
    const out = cleanScrapedText(raw);
    expect(out).toContain("Fleet includes economy sedans and SUVs.");
    expect(out).not.toContain("Wash");
  });

  test("preserves legit multi-sentence prose intact", () => {
    const raw =
      "We serve gig workers and rideshare drivers in the Baltimore metro area. " +
      "Weekly rentals start at $299. No luxury vehicles — commuter fleet only.";
    const out = cleanScrapedText(raw);
    expect(out).toContain("We serve gig workers and rideshare drivers in the Baltimore metro area.");
    expect(out).toContain("Weekly rentals start at $299.");
    expect(out).toContain("No luxury vehicles — commuter fleet only.");
  });

  test("idempotent on already-clean text", () => {
    const raw =
      "We serve gig workers. Rentals start at $299. Baltimore metro only.";
    const first = cleanScrapedText(raw);
    const second = cleanScrapedText(first);
    expect(second).toBe(first);
  });

  test("handles the EZ Rentals defect pattern (nav 8x, hero 6x)", () => {
    // NOTE: this fixture predates Phase 5.4 and puts nav / hero on
    // separate lines. Real scrapeCheerio output does NOT — see the
    // "real scrapeCheerio shape" describe block below for the fixture
    // that matches production. Kept for the newline-delimited case
    // (which does happen when scrapeCheerio is fed pre-cleaned
    // markdown from the Firecrawl tier).
    const nav = "Home About Contact FAQ Book Now";
    const hero = "EZ Rentals — flexible weekly rentals for rideshare drivers.";
    const fact = "Locations: Baltimore, MD. Fleet: economy and midsize only. From $299/week.";
    const raw = [
      "=== https://ezrentalsandleasing.com ===",
      nav, nav, nav, nav, nav, nav, nav, nav,
      hero, hero, hero, hero, hero, hero,
      fact,
    ].join("\n");
    const out = cleanScrapedText(raw);
    // Hero repeated 6x → collapses to 1.
    const heroCount = (out.match(/EZ Rentals — flexible weekly rentals/g) || []).length;
    expect(heroCount).toBe(1);
    // Fact preserved.
    expect(out).toContain("Locations: Baltimore, MD.");
    expect(out).toContain("From $299/week.");
    // Output should be dramatically shorter than input.
    expect(out.length).toBeLessThan(raw.length / 3);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 5.4 — REAL scrapeCheerio shape.
//
// Verified in production against EZ Rentals: the live post-5.3 prompt
// contained "EZ Rentals and Leasing" 23 times inside a single 15,281-
// char blob. Trace of scraping.ts:scrapeCheerio (pre-Phase-5.4):
//   `$("body").text()`                — DOM depth-first concat, no seps
//   `.replace(/\s+/g, " ").trim()`    — collapses ALL whitespace to spaces
//   push `=== url ===\n<one line>`    — one URL header + one body line
//   allText.join("\n\n")              — pages joined by blank lines
//
// So the shape is: 1 URL header line + 1 concatenated body line per
// page, no in-body delimiters. When nav/hero components render N
// times inside one DOM subtree (sticky-nav a11y duplicates,
// slick/swiper carousels), the body line contains "XYZXYZXYZ" with
// no delimiter to split on.

describe("cleanScrapedText — real scrapeCheerio shape (Phase 5.4)", () => {
  test("collapses immediate substring repeats inside one single-line segment", () => {
    // The literal defect: hero repeated N times, concatenated with no
    // delimiter. No newlines, no periods. This is what Phase 5.3
    // couldn't handle.
    const heroCopy = "EZ Rentals and Leasing";
    const raw = heroCopy.repeat(23);
    const out = cleanScrapedText(raw);
    const count = (out.match(/EZ Rentals and Leasing/g) || []).length;
    expect(count).toBe(1);
  });

  test("collapses nav-menu concatenation with no delimiters", () => {
    const nav = "HomeAboutFleetContactBookNow";
    // A sticky nav that renders twice (mobile + desktop) is a common
    // template pattern.
    const raw = nav + nav + nav;
    const out = cleanScrapedText(raw);
    // Immediate-repeat collapse leaves one copy.
    expect((out.match(/HomeAboutFleet/g) || []).length).toBe(1);
  });

  test("real EZ Rentals-shape blob: single URL header + one long concatenated body", () => {
    const url = "=== https://ezrentalsandleasing.com ===";
    const nav = "HomeAboutFleetContactBookNow";
    const hero = "EZ Rentals and Leasing";
    const tagline = "Flexible weekly rentals for rideshare drivers";
    const facts =
      "Serving Baltimore MD. Fleet is economy and midsize only. No luxury vehicles. " +
      "Weekly rentals from $299. Insurance and roadside assistance included.";
    // Concatenated the same way scrapeCheerio produces: nav renders
    // 3x (mobile + desktop + skip-nav a11y), hero 6x (carousel), then
    // real body. All ONE line.
    const bodyLine = nav.repeat(3) + hero.repeat(6) + tagline.repeat(4) + " " + facts;
    const raw = `${url}\n${bodyLine}`;

    const out = cleanScrapedText(raw);

    // URL header preserved.
    expect(out).toContain("=== https://ezrentalsandleasing.com ===");
    // Immediate-repeat collapse: each unit appears once in the cleaned
    // body-text segment.
    expect((out.match(/EZ Rentals and Leasing/g) || []).length).toBe(1);
    expect((out.match(/HomeAboutFleetContact/g) || []).length).toBe(1);
    expect((out.match(/Flexible weekly rentals for rideshare drivers/g) || []).length).toBe(1);
    // Real facts preserved verbatim.
    expect(out).toContain("Serving Baltimore MD.");
    expect(out).toContain("Weekly rentals from $299.");
    expect(out).toContain("Insurance and roadside assistance included.");
    // Output is materially shorter than the raw defect blob. Not
    // 3x — real defect blobs are ~50% boilerplate, not 66%+.
    expect(out.length).toBeLessThan(raw.length * 0.6);
  });

  test("multi-page real shape: each page is one line, repeats within each collapse", () => {
    // What scrapeCheerio produces after allText.join("\n\n") — three
    // pages, each ONE line, blank lines between.
    const hero = "EZ Rentals and Leasing";
    const raw = [
      "=== https://ezrentalsandleasing.com ===",
      hero.repeat(6) + "Weekly rentals from $299.",
      "",
      "=== https://ezrentalsandleasing.com/about ===",
      hero.repeat(4) + "Serving the Baltimore metro since 2019.",
      "",
      "=== https://ezrentalsandleasing.com/contact ===",
      hero.repeat(3) + "Call 443-708-7894 to reach the team.",
    ].join("\n");

    const out = cleanScrapedText(raw);

    // In the collapsed body of each page, hero appears once. Across
    // 3 pages that's 3 total occurrences before cross-page dedup
    // fires. Cross-page dedup at segment granularity should reduce
    // it to 1 (the 3 body-line segments are IDENTICAL after the
    // in-line collapse — wait, they're not, they end with different
    // facts). So the collapsed body lines differ, dedup doesn't
    // merge them, and hero appears 3 times (once per page line).
    //
    // Verify: at most 3 occurrences (one per page), NOT 6+4+3 = 13.
    const heroCount = (out.match(/EZ Rentals and Leasing/g) || []).length;
    expect(heroCount).toBeLessThanOrEqual(3);
    // Facts preserved.
    expect(out).toContain("Weekly rentals from $299.");
    expect(out).toContain("Serving the Baltimore metro since 2019.");
    expect(out).toContain("Call 443-708-7894 to reach the team.");
  });

  test("does not collapse short accidental substring matches (< 8 chars)", () => {
    // "aaa" or "aa" are below the 8-char floor — should NOT be
    // collapsed. Prevents false-positive damage to legit prose.
    const raw = "Weekly rentals starting at $299. See our aaa special.";
    const out = cleanScrapedText(raw);
    expect(out).toContain("aaa");
    expect(out).toContain("$299");
  });

  test("idempotent on real-shape input", () => {
    const raw = "EZ Rentals and Leasing".repeat(10) + " Weekly rentals from $299.";
    const first = cleanScrapedText(raw);
    const second = cleanScrapedText(first);
    expect(second).toBe(first);
  });
});
