import * as Sentry from "@sentry/node";

if (process.env.SENTRY_API_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_API_DSN,
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    tracesSampleRate: 0,
    ignoreErrors: [
      "Non-Error promise rejection captured",
      "AbortError",
    ],
    beforeSend(_event, hint) {
      const error = hint.originalException as any;
      if (error?.statusCode >= 400 && error?.statusCode < 500) {
        return null;
      }
      return _event;
    },
  });
  console.log("[Sentry] API error monitoring initialized");
} else {
  console.log("[Sentry] SENTRY_API_DSN not set, monitoring disabled");
}

import app from "./app";
import { scheduleBriefings, scheduleRetentionCron } from "./cron";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  scheduleBriefings();
  scheduleRetentionCron();
});
