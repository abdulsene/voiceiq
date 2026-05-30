// ===========================================================================
// CookieConsentManager — GDPR cookie banner UI gating.
//
// What this is:
//   The CookieYes script (loaded in index.html) renders its banner DOM
//   the moment it boots. We always WANT the script to load (so consent
//   state is stored consistently in cookies app-wide), but we DON'T want
//   the banner UI to appear on:
//     - /signup, /login, /contact  → competes with primary forms
//     - /dashboard, /calls, etc.   → authenticated users have already
//                                    accepted via the signup ToS click
//
// How this works:
//   This component renders nothing. On every route change it toggles a
//   `cky-route-hidden` class on <html>. CSS rules in src/index.css
//   ("CookieYes — route-scoped UI suppression") hide CookieYes's
//   banner / floating revisit-button / modal DOM when that class is set.
//
//   First-paint priming: index.html has an inline <script> in <head>
//   that applies the same class synchronously based on
//   window.location.pathname BEFORE the CookieYes script tag executes.
//   That prevents a ~100ms banner flash on hard-reload / deep-link to a
//   hidden route. This component then takes over for client-side
//   navigations (where the inline script never re-runs). Keep the
//   HIDE_EXACT / HIDE_PREFIX rules below in sync with the inline copy
//   in index.html — divergence would mean "first-paint shows banner,
//   then React hides it" or vice-versa.
//
// Why CSS-toggle instead of conditional script injection:
//   - Mounting/unmounting a third-party script that registers globals is
//     fragile (CookieYes attaches to window, polls cookies, queues
//     callbacks). Loading once + CSS hide is reversible and side-effect
//     free.
//   - Consent must persist across navigation. If a visitor accepts on
//     "/" (Landing) and then navigates to "/pricing", the banner should
//     stay dismissed. That requires the script to have run on every page.
//   - Symmetric to the ChatWidget pattern — same HIDE_EXACT /
//     HIDE_PREFIX vocabulary keeps the rules co-located mentally for
//     future maintainers.
//
// What this is NOT:
//   - It does not change CookieYes's category configuration (Necessary /
//     Analytics / Marketing) — that's done in app.cookieyes.com.
//   - It does not gate analytics scripts on the consent decision. Today
//     no extra analytics scripts are loaded; if/when we add them, gate
//     them via window.dataLayer + CookieYes's `cky_consent` cookie.
//   - It does not handle the cookie-policy text page (/privacy, /terms
//     already exist as standalone routes).
// ===========================================================================
import { useEffect } from "react";
import { useLocation } from "wouter";

// Mirror of ChatWidget.tsx HIDE_EXACT / HIDE_PREFIX. Kept as separate
// constants (not imported from ChatWidget) because the two components have
// distinct "should I be visible?" questions that may diverge — e.g. it's
// plausible we'd later WANT the chat widget on /pricing but not the
// cookie banner there. Today the rules happen to be the same.
const HIDE_EXACT = new Set<string>(["/signup", "/login", "/contact"]);
const HIDE_PREFIX: string[] = [
  "/dashboard",
  "/calls",
  "/contacts",
  "/appointments",
  "/sms",
  "/analytics",
  "/benchmarks",
  "/admin",
  "/settings",
  "/mfa-setup",
  "/mfa-verify",
];

function isHiddenPath(path: string): boolean {
  if (HIDE_EXACT.has(path)) return true;
  return HIDE_PREFIX.some((p) => path === p || path.startsWith(p + "/"));
}

const HIDE_CLASS = "cky-route-hidden";

export default function CookieConsentManager(): null {
  const [location] = useLocation();

  useEffect(() => {
    const root = document.documentElement;
    if (isHiddenPath(location)) {
      root.classList.add(HIDE_CLASS);
    } else {
      root.classList.remove(HIDE_CLASS);
    }
    // No cleanup needed — the next route change re-runs this effect and
    // reconciles the class. On unmount (e.g. SSR hydration edge cases or
    // tests) we leave the class as-is so the visual state matches the
    // last evaluated route.
  }, [location]);

  return null;
}
