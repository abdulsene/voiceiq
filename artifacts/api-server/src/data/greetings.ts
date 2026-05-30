/**
 * Sprint 4 FIX 1 — per-industry first-message greetings shared between
 * customer signup (auth.ts), admin sales-demo provisioning (admin.ts),
 * and the one-off batch patch script (sprint4-patch-greetings.ts).
 *
 * Default uses "Hello" (time-of-day-agnostic so we never greet an evening
 * caller with "Good morning"). Per-industry tweaks shift tone:
 *   - warm/formal for healthcare and professional services,
 *   - casual + action-oriented for home services and trades,
 *   - warm/casual for hospitality and personal care.
 *
 * Adding a new industry: add a row to INDUSTRY_GREETINGS keyed by the same
 * `industry` string used in business_configs.industry. Unknown industries
 * fall through to HELLO_DEFAULT.
 */

export type GreetingFn = (businessName: string) => string;

const HELLO_DEFAULT: GreetingFn = (n) =>
  `Hello, thank you for calling ${n}. How can I help you today?`;

export const INDUSTRY_GREETINGS: Record<string, GreetingFn> = {
  // Healthcare-style: warm, formal
  dental:            (n) => `Hello, thank you for calling ${n}. How can I help you today?`,
  medical:           (n) => `Hello, thank you for calling ${n}. How can I help you today?`,
  chiropractic:      (n) => `Hello, thank you for calling ${n}. How can I help you today?`,

  // Professional services: formal, slight gravitas
  legal:             (n) => `Hello, thank you for calling ${n}. How can I help you?`,
  consulting:        (n) => `Hello, thank you for calling ${n}. How can I help you today?`,
  financial_advisor: (n) => `Hello, thank you for calling ${n}. How can I help you today?`,
  real_estate:       (n) => `Hello, thank you for calling ${n}. How can I help you today?`,

  // Home services / trades: casual, action-oriented
  hvac:              (n) => `Hello, thanks for calling ${n}. What can I help you with today?`,
  plumbing:          (n) => `Hello, thanks for calling ${n}. What can I help you with today?`,

  // Hospitality / personal care: warm, casual
  restaurant:        (n) => `Hello, thanks for calling ${n}. How can I help you today?`,
  beauty:            (n) => `Hello, thanks for calling ${n}. How can I help you today?`,

  // Specialty retail / regulated
  automotive:        (n) => `Hello, thanks for calling ${n}. How can I help you today?`,
  firearms_dealer:   (n) => `Hello, thank you for calling ${n}. How can I help you today?`,

  // Public sector
  government:        (n) => `Hello, thank you for calling ${n}. How can I help you today?`,
};

export function getGreeting(
  industry: string | null | undefined,
  businessName: string,
): string {
  const fn = (industry && INDUSTRY_GREETINGS[industry]) || HELLO_DEFAULT;
  return fn(businessName);
}
