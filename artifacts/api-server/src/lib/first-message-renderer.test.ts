/**
 * Unit tests for lib/first-message-renderer.ts.
 *
 * Pure-function coverage: happy paths, edge cases (apostrophes,
 * accents, whitespace), and the empty-input guards. No mocks needed.
 */

import { describe, test, expect } from "vitest";

import {
  renderFirstMessage,
  renderPreviewFirstMessage,
} from "./first-message-renderer";

describe("renderFirstMessage", () => {
  test("happy path — emits disclosure between greeting and question", () => {
    const out = renderFirstMessage({ business_name: "EZ Rentals" });
    expect(out).toBe(
      "Thank you for calling EZ Rentals. This call may be recorded for quality and training purposes. How can I help you today?",
    );
  });

  test("preserves apostrophe in business name", () => {
    const out = renderFirstMessage({ business_name: "Joe's Diner" });
    expect(out).toContain("calling Joe's Diner.");
  });

  test("preserves accents/unicode in business name", () => {
    const out = renderFirstMessage({ business_name: "Café Crème" });
    expect(out).toContain("calling Café Crème.");
  });

  test("trims surrounding whitespace from business name", () => {
    const out = renderFirstMessage({ business_name: "  Acme  " });
    expect(out).toContain("calling Acme.");
    expect(out).not.toContain("calling  Acme  ");
  });

  test("throws on empty business_name", () => {
    expect(() => renderFirstMessage({ business_name: "" })).toThrow(
      /business_name is required/,
    );
  });

  test("throws on whitespace-only business_name", () => {
    expect(() => renderFirstMessage({ business_name: "   " })).toThrow(
      /business_name is required/,
    );
  });

  test("throws when business_name is null/undefined (defensive)", () => {
    expect(() =>
      renderFirstMessage({ business_name: undefined as unknown as string }),
    ).toThrow(/business_name is required/);
    expect(() =>
      renderFirstMessage({ business_name: null as unknown as string }),
    ).toThrow(/business_name is required/);
  });

  test("disclosure sentence is always present and exact", () => {
    // Regression guard: a careless rewrite that drops or rewords the
    // disclosure clause would silently break compliance for every new
    // agent. Pin the exact string.
    const out = renderFirstMessage({ business_name: "Anyone" });
    expect(out).toContain(
      "This call may be recorded for quality and training purposes.",
    );
  });
});

describe("renderPreviewFirstMessage", () => {
  test("happy path — disclosure leads, marketing copy follows", () => {
    const out = renderPreviewFirstMessage({ industry_name: "Dental" });
    expect(out).toBe(
      "This call may be recorded for quality and training purposes. Hi! This is a live preview of your Dental AI receptionist. Ask me anything to see how I'd handle calls for your business.",
    );
  });

  test("disclosure sentence comes first", () => {
    const out = renderPreviewFirstMessage({ industry_name: "HVAC" });
    expect(out.startsWith("This call may be recorded")).toBe(true);
  });

  test("trims whitespace from industry name", () => {
    const out = renderPreviewFirstMessage({ industry_name: "  Dental  " });
    expect(out).toContain("preview of your Dental AI");
    expect(out).not.toContain("of your  Dental  ");
  });

  test("throws on empty industry_name", () => {
    expect(() =>
      renderPreviewFirstMessage({ industry_name: "" }),
    ).toThrow(/industry_name is required/);
  });

  test("throws on whitespace-only industry_name", () => {
    expect(() =>
      renderPreviewFirstMessage({ industry_name: "   " }),
    ).toThrow(/industry_name is required/);
  });

  test("throws when industry_name is null/undefined (defensive)", () => {
    expect(() =>
      renderPreviewFirstMessage({
        industry_name: undefined as unknown as string,
      }),
    ).toThrow(/industry_name is required/);
    expect(() =>
      renderPreviewFirstMessage({
        industry_name: null as unknown as string,
      }),
    ).toThrow(/industry_name is required/);
  });
});
