/**
 * Phase 2.7b — two-way URL ?tab=… sync for shadcn Tabs.
 *
 * AiSettingsPage's prior pattern read the param once on mount but never
 * pushed back, so deep-linking worked but a tab switch left the URL
 * stale. The campaign Reporting tab needs both directions (reload-
 * resilient state) so we extract the hook here and retrofit
 * AiSettingsPage onto it — single source of truth.
 *
 * Behavior:
 *   - On mount: parse ?tab=<value>; if it's in the allowlist, return
 *     that; otherwise return the default. Done with a lazy initial
 *     state so window.location is read exactly once per mount.
 *   - On setTab(next): replaceState (NOT pushState — back/forward
 *     shouldn't accumulate per-tab history entries). The param is
 *     dropped when next === defaultTab so URLs stay clean for the
 *     common case.
 *   - On popstate: re-read the URL so browser back/forward updates
 *     the active tab.
 *
 * Generic over T extends string so callers can type their tab keys
 * tightly (e.g. "voice" | "prompt" | …).
 */

import { useCallback, useEffect, useState } from "react";

function readFromUrl<T extends string>(
  tabs: readonly T[],
  defaultTab: T,
  paramName: string,
): T {
  if (typeof window === "undefined") return defaultTab;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(paramName);
  if (raw && (tabs as readonly string[]).includes(raw)) return raw as T;
  return defaultTab;
}

function writeToUrl(value: string, defaultTab: string, paramName: string) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (value === defaultTab) {
    url.searchParams.delete(paramName);
  } else {
    url.searchParams.set(paramName, value);
  }
  // Preserve search shape: only stringify when content remains.
  const next = url.pathname + (url.search ? url.search : "") + url.hash;
  // replaceState — not pushState — so the back button takes the user
  // out of the page, not through every tab they clicked.
  window.history.replaceState(null, "", next);
}

export function useTabQueryState<T extends string>(
  tabs: readonly T[],
  defaultTab: T,
  paramName: string = "tab",
): [T, (next: T) => void] {
  const [tab, setTabState] = useState<T>(() => readFromUrl(tabs, defaultTab, paramName));

  const setTab = useCallback(
    (next: T) => {
      setTabState((prev) => {
        if (prev === next) return prev;
        writeToUrl(next, defaultTab, paramName);
        return next;
      });
    },
    [defaultTab, paramName],
  );

  // Back/forward navigation should reflect on the active tab. We listen
  // to popstate (replaceState doesn't fire it, so our own setTab calls
  // are not echoed — only genuine browser navigation triggers this).
  useEffect(() => {
    function onPop() {
      const next = readFromUrl(tabs, defaultTab, paramName);
      setTabState((prev) => (prev === next ? prev : next));
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [tabs, defaultTab, paramName]);

  return [tab, setTab];
}
