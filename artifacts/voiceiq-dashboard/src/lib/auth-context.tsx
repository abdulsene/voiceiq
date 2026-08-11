/**
 * Phase 5.6 — shared /api/auth/me result across the dashboard chrome.
 *
 * Motivating incident (Phase 5.6): a 4-person tenant behind a single
 * office NAT was sharing one 100-request / 15-minute IP-keyed bucket.
 * The dashboard mount fired THREE separate /api/auth/me calls (from
 * AuthGuard, DemoBanner, and Sidebar). All three had their own
 * failure-handling posture; the AuthGuard's treated any non-2xx as
 * "logged out" and 429-fired /api/auth/me responses started logging
 * staff out constantly.
 *
 * This module fixes the duplicate-fetch part. AuthGuard owns the ONE
 * canonical fetch and publishes the result via context; DemoBanner
 * and Sidebar read from context instead of firing their own request.
 * Cuts /api/auth/me traffic from 3 requests per page load to 1.
 *
 * The failure-classification fix (401 → logout, 429/5xx/network →
 * keep session, never redirect to /signup on a throttle) is handled
 * by AuthGuard's own fetch logic in App.tsx. This module intentionally
 * has NO knowledge of session-clearing — it's a data pipe only.
 */

import { createContext, useContext } from "react";

export interface AuthMeBusiness {
  business_id: string;
  role: string | null;
  business_configs?:
    | { business_name?: string | null }
    | Array<{ business_name?: string | null }>;
  // /api/auth/me returns more per-business context (subscription_status,
  // plan_id, etc.); consumers pluck what they need. Kept `unknown` so
  // adding a field doesn't require a type migration here.
  [key: string]: unknown;
}

export interface AuthMeData {
  user?: { id: string; email: string } | null;
  businesses: AuthMeBusiness[];
  staff_role?: string | null;
  // Passthrough for demo / onboarding flags that DemoBanner reads.
  [key: string]: unknown;
}

export interface AuthContextValue {
  /**
   * The last successful /api/auth/me response body, or null when the
   * fetch has not yet resolved OR resolved as a transient failure
   * (429 / 5xx / network) after retries. Consumers MUST handle null
   * gracefully — don't crash a component just because the data
   * hasn't landed yet.
   */
  data: AuthMeData | null;
  /**
   * True while the initial validation is in flight (including any
   * retry-with-backoff attempts). Consumers can render a placeholder
   * during this window.
   */
  loading: boolean;
  /**
   * Manually re-trigger the /api/auth/me fetch. Used after actions
   * that mutate the caller's memberships (accepting an invite, adding
   * a business) so downstream consumers see the new state without a
   * full page reload.
   */
  refetch: () => void;
}

const defaultValue: AuthContextValue = {
  data: null,
  loading: true,
  refetch: () => {},
};

export const AuthContext = createContext<AuthContextValue>(defaultValue);

/**
 * Consume the shared /api/auth/me result. Safe to call outside the
 * provider — returns { data: null, loading: true, refetch: noop }.
 * That means components mounted above AuthGuard (e.g. public landing
 * pages) don't crash if they accidentally call useAuth().
 */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
