import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.PROD ? "production" : "development",
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    // Phase 5.5 — capture a session replay when an error is caught.
    // Sample rate is 1.0 for error sessions specifically (all-caught,
    // not all-sessions) so ops has a reproduction of the crash context
    // without paying for full-session recording. The Phase-5.5
    // incident (blank dashboard for a staff user) would have been
    // triaged in minutes instead of hours with a replay attached to
    // the Sentry event.
    replaysOnErrorSampleRate: 1.0,
    integrations: [Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true })],
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "NetworkError when attempting to fetch resource",
      "Failed to fetch",
      "AbortError",
      "Non-Error promise rejection captured",
    ],
  });
  console.log("[Sentry] Dashboard error monitoring initialized");
} else {
  console.log("[Sentry] VITE_SENTRY_DSN not set, monitoring disabled");
}

// Phase 5.5 — root ErrorBoundary wraps <App/> so React render crashes
// (e.g. a conditional-hook bug) render a recovery UI instead of a
// white screen, and are reported to Sentry with the active
// business_id + user_id tags for triage.
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
