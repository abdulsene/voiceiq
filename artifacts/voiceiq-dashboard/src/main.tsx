import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import "./i18n";
import App from "./App";
import "./index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.PROD ? "production" : "development",
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
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

createRoot(document.getElementById("root")!).render(<App />);
