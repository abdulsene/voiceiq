/**
 * Phase 5.5 — top-level React error boundary + fallback UI.
 *
 * Motivating incident: a role='user' at a live tenant landed on
 * /dashboard, hit a conditional-hook bug in CommandCenter (React
 * error #310), and the entire tree unmounted to a blank white page.
 * She had no affordance to recover, and we had no signal — Sentry
 * initialized fine but no boundary means no explicit React error
 * report and no fallback UI.
 *
 * This boundary:
 *   - Catches any render error below <App/>
 *   - Reports the error to Sentry with the caller's active
 *     business_id + user_id tags so ops can filter by tenant
 *   - Renders a fallback with reload + copy-error-id actions
 *   - Prevents crashes below auth (login/signup) from bricking the
 *     whole app — those flows re-render on retry
 *
 * The boundary sits ABOVE routing (main.tsx wraps <App/>). We do
 * NOT add per-route boundaries below it — a per-route boundary
 * would hide crashes inside a route by rendering "something went
 * wrong" while other routes keep working, which is worse for
 * detection than a full white screen (the customer complains
 * faster). This boundary is the only one; page routes that need
 * their own graceful degradation should handle it inline.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  eventId: string | null;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, eventId: null, error: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Tag with the active business_id + user_id if we can read them
    // from localStorage. Non-fatal on missing values (login screens
    // won't have them yet).
    const activeBusinessId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem("neverr_active_business_id") ||
          localStorage.getItem("neverr_business_id")
        : null;

    const eventId = Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
      tags: {
        boundary: "root",
        // Business id is not PII on our surface but is the single
        // most useful filter for "who is affected" in Sentry.
        ...(activeBusinessId ? { business_id: activeBusinessId } : {}),
      },
      // Escalated so this is not swallowed by default alert rules —
      // React render crashes should page someone.
      level: "fatal",
    });
    this.setState({ eventId });

    // Also log to console so a developer poking at devtools sees
    // the full stack alongside the fallback UI.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] React render crashed:", error, errorInfo);
  }

  handleReload = (): void => {
    // Full reload — clears any transient bad state (stale WS
    // subscriptions, broken query cache, etc). Cheaper and more
    // reliable than trying to reset state locally.
    window.location.reload();
  };

  handleCopyEventId = (): void => {
    if (!this.state.eventId) return;
    navigator.clipboard.writeText(this.state.eventId).catch(() => {
      /* clipboard denial is fine — the ID is visible on screen */
    });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-screen bg-neutral-50 flex items-center justify-center px-4"
      >
        <div className="max-w-md w-full bg-white rounded-2xl border border-neutral-200 shadow-sm p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center shrink-0">
              <svg
                className="w-5 h-5 text-red-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-neutral-900">
                Something went wrong
              </h1>
              <p className="text-sm text-neutral-600 mt-1 leading-relaxed">
                The dashboard hit an unexpected error and couldn't render.
                Try reloading — most of the time that clears it. If it
                keeps happening, share the error ID below with support.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={this.handleReload}
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800 transition-colors"
            >
              Reload dashboard
            </button>
            {this.state.eventId ? (
              <button
                type="button"
                onClick={this.handleCopyEventId}
                className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-white border border-neutral-200 text-neutral-700 text-sm font-medium hover:bg-neutral-50 transition-colors"
              >
                Copy error ID
              </button>
            ) : null}
          </div>

          {this.state.eventId ? (
            <p className="mt-4 text-xs text-neutral-400">
              Error ID:{" "}
              <span className="font-mono text-neutral-600">
                {this.state.eventId}
              </span>
            </p>
          ) : null}
        </div>
      </div>
    );
  }
}
