import * as cheerio from "cheerio";
import { globalDailyCap } from "./rateLimiter";
import { cleanScrapedText } from "./lib/scrape-clean";

export interface ScrapedData {
  success: boolean;
  tier_used?: "cheerio" | "firecrawl" | null;
  reason?: string;
  structured?: {
    business_name?: string;
    tagline?: string;
    description?: string;
    phone?: string;
    email?: string;
    address?: string;
    hours?: string;
    services?: string[];
    pages_scraped?: string[];
  };
  context_text?: string;
  scraped_at?: string;
}

const FETCH_TIMEOUT_MS = 10000;
const MAX_PAGES = 3;
const MAX_CONTEXT_CHARS = 5000;
const USER_AGENT = "NeverrBot/1.0 (+https://neverr.ai/bot)";
const NAV_KEYWORDS = ["about", "service", "faq", "contact", "pricing", "team", "what-we-do", "our-services"];

function normalizeUrl(input: string): string | null {
  try {
    let url = input.trim();
    if (!url.match(/^https?:\/\//i)) url = "https://" + url;
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
}

async function fetchTextWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<FetchResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
      signal: controller.signal,
      redirect: "follow",
    });
    const body = await res.text();
    clearTimeout(timeout);
    return { ok: res.ok, status: res.status, body };
  } catch (e: any) {
    clearTimeout(timeout);
    console.warn("[Scrape] Fetch failed for", url, e.message ?? String(e));
    return null;
  }
}

function isJsRenderedShell(html: string): boolean {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  return bodyText.length < 500;
}

/**
 * Phase 5.4 — extract body text while preserving DOM structure.
 *
 * The bug this fixes: `$("body").text()` walks the DOM depth-first
 * and concatenates every text node with no inter-element separator.
 * Then the historical `.replace(/\s+/g, " ")` collapse folded any
 * HTML-native whitespace (indentation, minified markup, etc) into
 * single spaces. Result: a nav bar like `<ul><li><a>Home</a></li>
 * <li><a>About</a></li></ul>` produced "HomeAbout" — a single 8-char
 * segment with no way to dedup nav repetitions downstream.
 *
 * Fix: insert explicit `\n` (block-level) or ` ` (inline like <a>)
 * boundaries BEFORE `.text()`, then collapse horizontal whitespace
 * only, leaving newlines intact so lib/scrape-clean.ts has real
 * segment boundaries to work with.
 *
 * `<a>` gets a space instead of newline because `<a>` is also used
 * for inline prose links ("See our <a>pricing</a> page"). A newline
 * there would fragment sentences; a space preserves the word
 * boundary without splitting the sentence.
 *
 * Called from scrapeCheerio in both the homepage and secondary-page
 * loops. isJsRenderedShell keeps its historical single-line collapse
 * (only used for the length-threshold shell check — structure
 * doesn't matter for that gate).
 */
const BLOCK_SELECTOR =
  "br, p, div, li, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, ul, ol, tr, td, dt, dd, blockquote, pre, main, aside, form";

/** @internal exported for scraping.test.ts. */
export function extractBodyTextStructured($: cheerio.CheerioAPI): string {
  // <br> is a hard line break in visual rendering; treat as \n.
  $("br").replaceWith("\n");
  // Append \n inside every block element so text() concatenation
  // gets a boundary between sibling blocks.
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).append("\n");
  });
  // Append a space inside every <a> so "HomeAbout" (concatenated
  // nav) becomes "Home About " without splitting inline prose links.
  $("a").each((_, el) => {
    $(el).append(" ");
  });
  const raw = $("body").text();
  // Collapse horizontal whitespace but PRESERVE \n so segments have
  // boundaries. Then collapse runs of newlines to single \n.
  return raw
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function extractStructured($: cheerio.CheerioAPI, _url: string): Partial<NonNullable<ScrapedData["structured"]>> {
  const structured: Partial<NonNullable<ScrapedData["structured"]>> = {};

  const title = $("title").first().text().trim();
  const h1 = $("h1").first().text().trim();
  const ogSiteName = $('meta[property="og:site_name"]').attr("content")?.trim();
  structured.business_name = ogSiteName || (title.split(/[|\-–—]/)[0]?.trim()) || h1 || undefined;

  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim();
  const metaDesc = $('meta[name="description"]').attr("content")?.trim();
  structured.tagline = ogDesc || metaDesc || $("h2").first().text().trim() || undefined;

  const firstPara = $("p").first().text().trim();
  structured.description = firstPara && firstPara.length > 40 ? firstPara.substring(0, 500) : undefined;

  const bodyText = $("body").text().replace(/\s+/g, " ").substring(0, 50000);
  const phoneMatch = bodyText.match(/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
  if (phoneMatch) structured.phone = phoneMatch[0].trim();

  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) structured.email = emailMatch[0].trim();

  const hoursText = bodyText.match(/(?:hours?|open)[\s:]{1,5}((?:mon|tue|wed|thu|fri|sat|sun|daily|weekday|weekend|24\/7)[^.]{5,120})/i);
  if (hoursText) structured.hours = hoursText[1].trim().substring(0, 200);

  const addressMatch = bodyText.match(/\b\d{1,5}\s+[A-Za-z][A-Za-z0-9 .'-]{2,40},\s+[A-Za-z][A-Za-z .'-]{1,30},\s+[A-Z]{2}\s+\d{5}\b/);
  if (addressMatch) structured.address = addressMatch[0].trim();

  const services: string[] = [];
  $("ul li, ol li").each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 5 && text.length < 120 && !text.match(/^(home|about|contact|faq|login|sign|menu)/i)) {
      services.push(text);
    }
  });
  if (services.length > 0) structured.services = Array.from(new Set(services)).slice(0, 15);

  return structured;
}

function findRelevantLinks($: cheerio.CheerioAPI, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const found = new Set<string>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const linkText = $(el).text().toLowerCase().trim();
    if (!href) return;

    let absoluteUrl: URL;
    try {
      absoluteUrl = new URL(href, baseUrl);
    } catch {
      return;
    }

    if (absoluteUrl.hostname !== base.hostname) return;
    if (absoluteUrl.protocol !== "https:" && absoluteUrl.protocol !== "http:") return;

    const pathLower = absoluteUrl.pathname.toLowerCase();
    const matches = NAV_KEYWORDS.some(kw => pathLower.includes(kw) || linkText.includes(kw));

    if (matches && absoluteUrl.pathname !== base.pathname) {
      absoluteUrl.hash = "";
      found.add(absoluteUrl.toString().replace(/\/$/, ""));
    }
  });

  return Array.from(found);
}

async function scrapeCheerio(homepageUrl: string): Promise<ScrapedData> {
  const pagesScraped: string[] = [];
  const allText: string[] = [];
  let combinedStructured: Partial<NonNullable<ScrapedData["structured"]>> = {};

  const homepageRes = await fetchTextWithTimeout(homepageUrl);
  if (!homepageRes || !homepageRes.ok) {
    return { success: false, reason: "homepage_fetch_failed", tier_used: "cheerio" };
  }

  const homepageHtml = homepageRes.body;
  if (isJsRenderedShell(homepageHtml)) {
    return { success: false, reason: "js_rendered_shell", tier_used: "cheerio" };
  }

  const $home = cheerio.load(homepageHtml);
  combinedStructured = extractStructured($home, homepageUrl);
  pagesScraped.push(homepageUrl);

  $home("script, style, noscript").remove();
  // Phase 5.4 — structure-preserving extraction (see comment on
  // extractBodyTextStructured). The old `.text().replace(/\s+/g, " ")`
  // collapsed a nav bar to a single "HomeAbout"-style blob with no
  // segment boundaries, which defeated downstream dedup.
  const homeText = extractBodyTextStructured($home);
  allText.push(`=== ${homepageUrl} ===\n${homeText.substring(0, 3000)}`);

  const navLinks = findRelevantLinks($home, homepageUrl);
  const linksToFetch = navLinks.slice(0, MAX_PAGES - 1);
  console.log("[Scrape] Found", navLinks.length, "nav links, fetching", linksToFetch.length, ":", linksToFetch);

  for (const link of linksToFetch) {
    await new Promise(r => setTimeout(r, 2000));

    console.log("[Scrape] Fetching secondary page:", link);
    const res = await fetchTextWithTimeout(link);
    if (!res || !res.ok) {
      console.log("[Scrape] Secondary fetch skipped:", link, res?.status);
      continue;
    }
    console.log("[Scrape] Secondary fetch OK:", link, res.status);

    const html = res.body;
    const $ = cheerio.load(html);

    const secondary = extractStructured($, link);
    for (const [k, v] of Object.entries(secondary)) {
      if (v && !(combinedStructured as any)[k]) {
        (combinedStructured as any)[k] = v;
      }
    }

    $("script, style, noscript").remove();
    const pageText = extractBodyTextStructured($);
    allText.push(`=== ${link} ===\n${pageText.substring(0, 1500)}`);
    pagesScraped.push(link);
  }

  combinedStructured.pages_scraped = pagesScraped;

  // Phase 5.3 — clean BEFORE capping to MAX_CONTEXT_CHARS so we spend
  // the char budget on signal (facts, positioning) rather than nav
  // repeats. Capping after clean also lets us drop the mid-word tail
  // that a naive substring produced.
  const rawJoined = allText.join("\n\n");
  const cleaned = cleanScrapedText(rawJoined);
  const contextText = cleaned.substring(0, MAX_CONTEXT_CHARS);

  if (contextText.length < 400) {
    return { success: false, reason: "insufficient_content", tier_used: "cheerio" };
  }

  return {
    success: true,
    tier_used: "cheerio",
    structured: combinedStructured,
    context_text: contextText,
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeFirecrawl(homepageUrl: string): Promise<ScrapedData> {
  const cap = globalDailyCap("firecrawl", 200);
  if (!cap.allowed) {
    console.warn("[Scrape] Firecrawl daily cap reached:", cap.used, "of 200");
    return { success: false, reason: "firecrawl_daily_cap_reached", tier_used: "firecrawl" };
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return { success: false, reason: "firecrawl_not_configured", tier_used: "firecrawl" };
  }

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: homepageUrl,
        formats: ["markdown"],
        onlyMainContent: true,
        waitFor: 2000,
        timeout: 20000,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn("[Scrape] Firecrawl failed:", res.status, errText.substring(0, 200));
      return { success: false, reason: `firecrawl_http_${res.status}`, tier_used: "firecrawl" };
    }

    const data: any = await res.json();
    const markdown: string = data?.data?.markdown || "";
    const metadata: any = data?.data?.metadata || {};

    if (!markdown || markdown.length < 200) {
      return { success: false, reason: "firecrawl_empty_result", tier_used: "firecrawl" };
    }

    const structured: NonNullable<ScrapedData["structured"]> = {
      business_name: metadata.title?.split(/[|\-–—]/)[0]?.trim() || metadata.ogTitle,
      tagline: metadata.description || metadata.ogDescription,
      pages_scraped: [homepageUrl],
    };

    const phoneMatch = markdown.match(/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
    if (phoneMatch) structured.phone = phoneMatch[0].trim();

    const emailMatch = markdown.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) structured.email = emailMatch[0].trim();

    const addressMatch = markdown.match(/\b\d{1,5}\s+[A-Za-z][A-Za-z0-9 .'-]{2,40},\s+[A-Za-z][A-Za-z .'-]{1,30},\s+[A-Z]{2}\s+\d{5}\b/);
    if (addressMatch) structured.address = addressMatch[0].trim();

    const hoursText = markdown.match(/(?:hours?|open)[\s:]{1,5}((?:mon|tue|wed|thu|fri|sat|sun|daily|weekday|weekend|24\/7)[^.\n]{5,120})/i);
    if (hoursText) structured.hours = hoursText[1].trim().substring(0, 200);

    const bulletLines = markdown.match(/^[-*]\s+(.+)$/gm) || [];
    const services = bulletLines
      .map(l => l.replace(/^[-*]\s+/, "").trim())
      .filter(s => s.length > 5 && s.length < 120)
      .slice(0, 15);
    if (services.length > 0) structured.services = services;

    // Phase 5.3 — even Firecrawl's onlyMainContent markdown carries
    // duplicate hero blocks on sites with heavy above-fold repetition.
    // Same cleaner as the Cheerio path; dedup + boilerplate strip
    // before the char cap.
    const cleanedMarkdown = cleanScrapedText(markdown);

    return {
      success: true,
      tier_used: "firecrawl",
      structured,
      context_text: cleanedMarkdown.substring(0, MAX_CONTEXT_CHARS),
      scraped_at: new Date().toISOString(),
    };
  } catch (e: any) {
    console.warn("[Scrape] Firecrawl error:", e.message ?? String(e));
    return { success: false, reason: "firecrawl_exception", tier_used: "firecrawl" };
  }
}

function withHardTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`hard_timeout_${label}_${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

export async function scrapeWebsite(rawUrl: string): Promise<ScrapedData> {
  const url = normalizeUrl(rawUrl);
  if (!url) return { success: false, reason: "invalid_url" };

  console.log("[Scrape] Starting scrape for:", url);

  let tier1: ScrapedData;
  try {
    tier1 = await withHardTimeout(scrapeCheerio(url), 35000, "cheerio");
  } catch (e: any) {
    console.warn("[Scrape] Cheerio hard timeout/error:", e.message);
    tier1 = { success: false, reason: e.message || "cheerio_exception", tier_used: "cheerio" };
  }
  if (tier1.success) {
    console.log("[Scrape] Tier 1 (cheerio) succeeded for:", url,
      "- pages:", tier1.structured?.pages_scraped?.length || 0,
      "- context chars:", tier1.context_text?.length || 0);
    return tier1;
  }

  console.log("[Scrape] Tier 1 (cheerio) failed:", tier1.reason, "- falling through to Firecrawl");

  let tier2: ScrapedData;
  try {
    tier2 = await withHardTimeout(scrapeFirecrawl(url), 30000, "firecrawl");
  } catch (e: any) {
    console.warn("[Scrape] Firecrawl hard timeout/error:", e.message);
    tier2 = { success: false, reason: e.message || "firecrawl_exception", tier_used: "firecrawl" };
  }
  if (tier2.success) {
    console.log("[Scrape] Tier 2 (firecrawl) succeeded for:", url,
      "- context chars:", tier2.context_text?.length || 0);
    return tier2;
  }

  console.log("[Scrape] Tier 2 (firecrawl) also failed:", tier2.reason);
  return {
    success: false,
    reason: `both_tiers_failed: tier1=${tier1.reason}, tier2=${tier2.reason}`,
  };
}
