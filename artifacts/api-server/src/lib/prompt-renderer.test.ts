/**
 * Unit tests for src/lib/prompt-renderer.ts (Sprint 3 Stage 3).
 *
 * Covers:
 *   - Minimal opts → renders header
 *   - business_name interpolation
 *   - Each helper section (industry, tone, FAQs, prohibitions)
 *     appears when its source field is populated
 *   - Multilingual: spanish_enabled=true appends the LANGUAGE_BLOCKS.es
 *     section
 *   - EZ Rentals byte-perfect: rendering with the real EZ Rentals
 *     business_config values produces exactly 1690 chars and starts
 *     with the spec'd header. Acts as the regression backstop for
 *     the extraction — proves the move is a no-op for the most
 *     important real-world input.
 */

import { describe, test, expect } from "vitest";

import {
  renderPromptFromHelpers,
  resolveLanguages,
  buildMultilingualGreeting,
  type IndustryTemplate,
} from "./prompt-renderer";

// ───────────────────────────────────────────────────────────────────────
// Minimal opts fixture — only the four required fields.

const MINIMAL_OPTS = {
  business_name: "Acme Co",
  industry: "general",
  business_hours: "Monday-Friday 9AM-5PM",
  timezone: "America/New_York",
} as const;

// ───────────────────────────────────────────────────────────────────────

describe("renderPromptFromHelpers — happy paths", () => {
  test("minimal opts return a non-empty string with the spec'd header prefix", () => {
    const out = renderPromptFromHelpers({ ...MINIMAL_OPTS });
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out.startsWith("You are Alex, the professional AI receptionist for Acme Co, a general business.")).toBe(true);
  });

  test("business_name interpolates into multiple sections of the header", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      business_name: "My Special Bakery",
    });
    expect(out).toContain("for My Special Bakery, a general business.");
    expect(out).toContain("- Business Name: My Special Bakery");
    // The "You represent X professionally" sentence at YOUR ROLE block.
    expect(out).toContain("You represent My Special Bakery professionally");
  });

  test("industryTemplate.description appears under ABOUT THIS INDUSTRY:", () => {
    const tmpl: IndustryTemplate = {
      industry_id: "test",
      name: "Test Industry",
      description: "We help test the renderer with realistic content.",
    };
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: tmpl,
    });
    expect(out).toContain("ABOUT THIS INDUSTRY:");
    expect(out).toContain("We help test the renderer with realistic content.");
  });

  test("tonePreference appears under TONE AND VOICE PREFERENCE:", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      tonePreference: "warm and casual, never use jargon",
    });
    expect(out).toContain("TONE AND VOICE PREFERENCE");
    expect(out).toContain("warm and casual, never use jargon");
  });

  test("customFaqs render as Q/A pairs under BUSINESS-SPECIFIC FAQS:", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      customFaqs: [
        { question: "What are your hours?", answer: "9 to 5 Mon-Fri." },
        { question: "Do you take walk-ins?", answer: "Yes, before 4 PM." },
      ],
    });
    expect(out).toContain("BUSINESS-SPECIFIC FAQS");
    expect(out).toContain("Q: What are your hours?");
    expect(out).toContain("A: 9 to 5 Mon-Fri.");
    expect(out).toContain("Q: Do you take walk-ins?");
    expect(out).toContain("A: Yes, before 4 PM.");
  });

  test("neverSayList renders as bulleted STRICT PROHIBITIONS:", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      neverSayList: ["promise specific medical outcomes", "discuss competitors"],
    });
    expect(out).toContain("STRICT PROHIBITIONS");
    expect(out).toContain("- promise specific medical outcomes");
    expect(out).toContain("- discuss competitors");
  });

  test("empty / whitespace entries in neverSayList are filtered out", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      neverSayList: ["valid prohibition", "  ", "", "another valid one"],
    });
    expect(out).toContain("- valid prohibition");
    expect(out).toContain("- another valid one");
    // The blank entries should not produce naked "- " bullets.
    expect(out).not.toMatch(/\n- \n/);
  });
});

describe("renderPromptFromHelpers — multilingual", () => {
  test("spanish_enabled=true appends the LANGUAGE_BLOCKS.es section + MULTILINGUAL RULES", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      spanish_enabled: true,
    });
    expect(out).toContain("IDIOMA / SPANISH LANGUAGE DETECTION");
    expect(out).toContain("Eres completamente bilingue");
    expect(out).toContain("Gracias por llamar a Acme Co");
    expect(out).toContain("MULTILINGUAL RULES");
  });

  test("french_enabled=true appends the LANGUAGE_BLOCKS.fr section", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      french_enabled: true,
    });
    expect(out).toContain("LANGUE / FRENCH LANGUAGE DETECTION");
    expect(out).toContain("Merci d'avoir appele Acme Co");
  });

  test("no language flags → no MULTILINGUAL RULES block", () => {
    const out = renderPromptFromHelpers({ ...MINIMAL_OPTS });
    expect(out).not.toContain("MULTILINGUAL RULES");
    expect(out).not.toContain("IDIOMA / SPANISH");
    expect(out).not.toContain("LANGUE / FRENCH");
  });
});

describe("resolveLanguages helper", () => {
  test("opts.languages — strips 'en' and dedupes", () => {
    const out = resolveLanguages({ languages: ["en", "es", "fr", "es"] });
    expect(out).toEqual(expect.arrayContaining(["es", "fr"]));
    expect(out).not.toContain("en");
    expect(new Set(out).size).toBe(out.length);
  });

  test("legacy spanish_enabled + french_enabled merge into the set", () => {
    const out = resolveLanguages({
      languages: ["ar"],
      spanish_enabled: true,
      french_enabled: true,
    });
    expect(out).toEqual(expect.arrayContaining(["ar", "es", "fr"]));
  });
});

describe("buildMultilingualGreeting helper", () => {
  test("returns the EN greeting alone when no other languages enabled", () => {
    const out = buildMultilingualGreeting({ business_name: "Acme Co" });
    expect(out).toBe("Thank you for calling Acme Co! How can I help you today?");
  });

  test("appends Spanish greeting when spanish_enabled=true", () => {
    const out = buildMultilingualGreeting({
      business_name: "Acme Co",
      spanish_enabled: true,
    });
    expect(out).toContain("Thank you for calling Acme Co");
    expect(out).toContain("Gracias por llamar a Acme Co");
  });
});

// ───────────────────────────────────────────────────────────────────────
// EZ Rentals byte-perfect regression
//
// Values pulled from Supabase queries earlier in the project for
// biz_1779288494109_z4z979. The backfill recorded the prompt at
// 1690 chars. This test pins the renderer's output for the most
// important real customer — proves the extraction is a no-op for
// the case we care about most.

describe("EZ Rentals byte-perfect regression", () => {
  // Baseline last updated Phase 5.3 (2026-08-10). The 1690 value was
  // stale before this commit — the renderer grew between the extract
  // sprint and now (added responsibilities/critical-rules blocks,
  // request_callback playbook prose, etc.) and this pin drifted
  // without being updated. Phase 5.3 does NOT change the base output
  // for this call shape (no industryTemplate, no topics, no
  // websiteContext, no toolsAvailable), so the 4168 here reflects the
  // current renderer verbatim.
  test("renderPromptFromHelpers with EZ Rentals config produces the byte-perfect baseline + correct header", () => {
    const out = renderPromptFromHelpers({
      business_name: "EZ RENTALS AND LEASING LLC",
      industry: "car_rental",
      business_hours: "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 4:00 PM",
      timezone: "America/New_York",
      phone_number: "443 708 7894",
      website: "www.ezrentalsandleasing.com",
    });

    expect(out.startsWith(
      "You are Alex, the professional AI receptionist for EZ RENTALS AND LEASING LLC, a car_rental business.",
    )).toBe(true);
    expect(out).toHaveLength(4168);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Phase 5.3 — sanitizer + tool-gating regression tests.

describe("Phase 5.3 — call_scripts sanitizer", () => {
  const scriptWithPlaceholder: IndustryTemplate = {
    industry_id: "car_rental",
    name: "Car Rental",
    call_scripts: [
      {
        name: "Insurance explainer",
        trigger: "caller asks about insurance",
        script:
          "Explain that CDW costs $X/day, LDW $Y/day, and personal accident $Z/day.",
      },
    ],
  };

  test("scripts containing $X/day placeholders get replaced with a callback fallback", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: scriptWithPlaceholder,
    });
    expect(out).not.toContain("$X/day");
    expect(out).not.toContain("$Y/day");
    expect(out).not.toContain("$Z/day");
    expect(out).toContain("request_callback");
    expect(out).toContain("CALL PLAYBOOK");
    // Heading remains so Alex still recognizes the situation.
    expect(out).toContain("### Insurance explainer");
    // Redaction notice at top of playbook.
    expect(out).toContain("intentionally redacted");
  });

  test("scripts with {curly} placeholders get replaced with a callback fallback", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: {
        industry_id: "car_rental",
        name: "Car Rental",
        call_scripts: [
          {
            name: "Availability",
            trigger: "caller asks what's available",
            script: "Read out our current {quotes} for the dates.",
          },
        ],
      },
    });
    expect(out).not.toMatch(/\{quotes\}/);
    expect(out).toContain("### Availability");
    expect(out).toContain("request_callback");
  });

  test("scripts claiming live-inventory capability get replaced", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: {
        industry_id: "car_rental",
        name: "Car Rental",
        call_scripts: [
          {
            name: "Rate quote",
            trigger: "caller asks for a price",
            script:
              "Quote availability and pricing from live inventory across all vehicle classes.",
          },
        ],
      },
    });
    expect(out).not.toMatch(/live\s+inventory/i);
    expect(out).toContain("request_callback");
  });

  test("clean scripts pass through untouched", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: {
        industry_id: "car_rental",
        name: "Car Rental",
        call_scripts: [
          {
            name: "Existing reservation",
            trigger: "caller has a booking",
            script:
              "Ask for the confirmation number. Verify the name. Answer the modification question.",
          },
        ],
      },
    });
    expect(out).toContain(
      "Ask for the confirmation number. Verify the name. Answer the modification question.",
    );
    expect(out).not.toContain("intentionally redacted");
  });

  test("value_props containing live-inventory claims are dropped", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      industryTemplate: {
        industry_id: "car_rental",
        name: "Car Rental",
        value_props: [
          "Fast pickup at all locations",
          "Real-time inventory across vehicle classes",
        ],
      },
    });
    expect(out).toContain("Fast pickup at all locations");
    expect(out).not.toMatch(/real[-\s]?time\s+inventory/i);
  });
});

describe("Phase 5.3 — toolsAvailable gating", () => {
  test("toolsAvailable.transfer=false removes warm-transfer language", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      toolsAvailable: { transfer: false, record_appointment: false },
    });
    expect(out).not.toContain("warm-transfer");
    expect(out).not.toContain("transfer to the team");
    expect(out).toContain(
      "you do NOT have the ability to transfer calls to a human on this line",
    );
  });

  test("toolsAvailable defaults (undefined) keep legacy transfer language", () => {
    const out = renderPromptFromHelpers({ ...MINIMAL_OPTS });
    expect(out).toContain("warm-transfer");
  });

  test("topics section swaps record_appointment reference when the tool is off", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      topics: [
        {
          slug: "sales",
          name: "Sales",
          description: "New customer inquiries",
        },
      ],
      toolsAvailable: { transfer: false, record_appointment: false },
    });
    expect(out).toContain("DEPARTMENTS & TOPIC EXPERTISE");
    expect(out).not.toContain("use record_appointment for that");
    expect(out).toContain(
      "capture scheduling requests with request_callback",
    );
  });

  test("topics section keeps record_appointment reference when the tool IS registered", () => {
    const out = renderPromptFromHelpers({
      ...MINIMAL_OPTS,
      topics: [
        {
          slug: "sales",
          name: "Sales",
        },
      ],
      toolsAvailable: { transfer: true, record_appointment: true },
    });
    expect(out).toContain("use record_appointment for that");
  });
});
