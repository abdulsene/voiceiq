/**
 * Phase 5.3 — unit tests for the scrape cleaner used by both
 * src/scraping.ts (on ingest) and src/lib/prompt-renderer.ts (as a
 * safety net for legacy dirty rows).
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
