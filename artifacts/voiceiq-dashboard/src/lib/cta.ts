// 2026-05-03 Calendly env-var swap (frontend half).
// 2026-05-06 Option 2 — embedded /demo-call route.
//
// SINGLE source of truth for the discovery-call CTA URL on the
// marketing site. Every page/component that needs to send the user to
// "book a discovery call" imports this — never hard-code the path
// again. If you find yourself typing "/contact?topic=enterprise" in
// JSX, stop and import this helper instead.
//
// Resolution order:
//   1. If import.meta.env.VITE_CALENDLY_URL is set and starts with
//      https://, return "/demo-call" (the embedded Neverr-branded page
//      that mounts react-calendly's <InlineWidget> with that URL).
//   2. Fallback: /contact?topic=enterprise (the existing generic
//      contact form, scoped to topic=enterprise so the form router
//      knows it's a sales-side intent).
//
// Build-time vs runtime:
//   Vite bakes import.meta.env values into the bundle at build time,
//   so changing VITE_CALENDLY_URL requires a dashboard rebuild — see
//   replit.md for the deploy steps. The api-server side
//   (NEVERR_CALENDLY_URL → Alex chat) is also restart-gated on Replit
//   (Replit Secrets do NOT hot-reload into running processes), but
//   once the api-server workflow is restarted every new conversation
//   immediately sees the live URL — no module-init snapshot, no code
//   edits.
const FALLBACK_URL = "/contact?topic=enterprise";
const DEMO_CALL_ROUTE = "/demo-call";

export function getDiscoveryCallUrl(): string {
  const env = (import.meta.env.VITE_CALENDLY_URL as string | undefined) ?? "";
  if (env && env.startsWith("https://")) return DEMO_CALL_ROUTE;
  return FALLBACK_URL;
}
