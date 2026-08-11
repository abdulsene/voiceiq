/**
 * Phase 5.4 — unit tests for the structure-preserving body-text
 * extractor introduced to fix the concatenation defect that survived
 * Phase 5.3.
 *
 * The bug (verified in production on EZ Rentals):
 *   `$("body").text().replace(/\s+/g, " ")` walks the DOM and
 *   concatenates every text node with NO inter-element separator,
 *   then collapses even HTML-native newlines. A nav bar rendered as
 *   <ul><li><a>Home</a></li><li><a>About</a></li></ul> produced
 *   "HomeAbout" — one 8-char segment with nothing to dedup on.
 *
 * The fix (extractBodyTextStructured): before `.text()`, append `\n`
 * inside every block-level element and append a space inside every
 * `<a>`. Then collapse only HORIZONTAL whitespace and merge runs of
 * newlines. Downstream lib/scrape-clean.ts then has real segment
 * boundaries to work with.
 */

import { describe, test, expect } from "vitest";
import * as cheerio from "cheerio";

import { extractBodyTextStructured } from "./scraping";

describe("extractBodyTextStructured (Phase 5.4 root fix)", () => {
  test("nav with no whitespace between anchors gets space-separated", () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    // Historical bug: "HomeAboutContact". Fixed: separated.
    expect(out).not.toContain("HomeAboutContact");
    expect(out).toMatch(/Home\s+About\s+Contact/);
  });

  test("block-level elements produce newline boundaries", () => {
    const html = `
      <html><body>
        <h1>EZ Rentals</h1>
        <p>Flexible weekly rentals.</p>
        <div>Serving Baltimore, MD.</div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    // Historical bug: all three would concatenate on one line.
    // Fixed: each block on its own line.
    expect(out.split("\n").length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("EZ Rentals");
    expect(out).toContain("Flexible weekly rentals.");
    expect(out).toContain("Serving Baltimore, MD.");
  });

  test("<br> becomes a newline", () => {
    const html = "<body>Line one<br>Line two<br>Line three</body>";
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    expect(out.split(/\n/).filter((l) => l.trim().length > 0).length).toBe(3);
  });

  test("nav repeated at mobile + desktop templates becomes dedupable segments", () => {
    // Common template pattern: same nav rendered twice for mobile
    // and desktop visibility. Pre-Phase-5.4 this concatenated as
    // "HomeAboutContactHomeAboutContact" with no delimiter.
    const html = `
      <html><body>
        <nav class="mobile"><a>Home</a><a>About</a><a>Contact</a></nav>
        <nav class="desktop"><a>Home</a><a>About</a><a>Contact</a></nav>
        <main><h1>EZ Rentals</h1><p>Weekly rentals from $299.</p></main>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    // The output has structure — nav items separated by spaces,
    // navs separated by newlines. Real content preserved.
    expect(out).toContain("EZ Rentals");
    expect(out).toContain("Weekly rentals from $299.");
    // The nav concatenation-bug is gone: no "HomeAboutContact"
    // substring smashed together.
    expect(out).not.toContain("HomeAboutContact");
    expect(out).not.toContain("ContactHome");
  });

  test("inline <a> in prose gets a trailing space, not a newline", () => {
    // Historical concern: if <a> got a newline, sentences like "See
    // our pricing page for details" would fragment as "See our
    // pricing\npage for details." Space keeps sentence intact.
    const html = "<body><p>See our <a>pricing</a> page for details.</p></body>";
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    // Sentence stays on one line (only trailing \n from <p>).
    const nonEmptyLines = out.split("\n").filter((l) => l.trim().length > 0);
    expect(nonEmptyLines.length).toBe(1);
    expect(nonEmptyLines[0]).toContain("pricing");
    expect(nonEmptyLines[0]).toContain("page for details");
  });

  test("empty and whitespace-only elements collapse cleanly", () => {
    const html = `
      <html><body>
        <div></div>
        <div>   </div>
        <p>Real content here.</p>
        <div></div>
      </body></html>
    `;
    const $ = cheerio.load(html);
    const out = extractBodyTextStructured($);
    // No runs of blank lines from the empty divs.
    expect(out).not.toMatch(/\n\n/);
    expect(out).toContain("Real content here.");
  });
});
