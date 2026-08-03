/**
 * Phase 4.4 — shared direction filter used by every list surface
 * that displays calls (Command Center strip, Calls & Leads list,
 * Phone recent, Contacts side panel).
 *
 * One component so behaviour never diverges across surfaces. Each
 * caller passes a distinct storageKey so a user's toggle on the
 * Phone page doesn't collide with their toggle on Command Center.
 *
 * Persistence is per-user via localStorage. Persists across page
 * reloads AND across sessions on the same browser.
 *
 * Design (per Phase 4.3 audit recommendation):
 *   - Single control, not separate tabs / pages. A tenant with a
 *     softphone will want both directions in one list; forcing a
 *     page switch is friction.
 *   - Three values: "all" / "inbound" / "outbound". Default "all".
 *   - Filter is a PREDICATE, not a data mutation — callers get the
 *     value and filter their own list. Keeps caller-side render
 *     paths in one place.
 */

import { useCallback, useEffect, useState } from "react";

export type DirectionFilterValue = "all" | "inbound" | "outbound";

const STORAGE_PREFIX = "neverr_direction_filter:";

/**
 * useDirectionFilter — hook returning [value, setValue] backed by
 * localStorage under `${STORAGE_PREFIX}${storageKey}`. Reads the
 * stored value on mount; writes on every change.
 *
 * storageKey MUST be unique per surface. Suggested keys:
 *   - "command_center_strip"
 *   - "calls_leads_list"
 *   - "phone_recent"
 *   - "contacts_panel"
 */
export function useDirectionFilter(storageKey: string): [DirectionFilterValue, (v: DirectionFilterValue) => void] {
  const [value, setValueState] = useState<DirectionFilterValue>("all");

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      if (raw === "inbound" || raw === "outbound" || raw === "all") {
        setValueState(raw);
      }
    } catch {
      // localStorage disabled (private-mode etc.); default "all" is fine.
    }
  }, [storageKey]);

  const setValue = useCallback(
    (next: DirectionFilterValue) => {
      setValueState(next);
      try {
        localStorage.setItem(STORAGE_PREFIX + storageKey, next);
      } catch {
        // Non-fatal; state is still updated for the session.
      }
    },
    [storageKey],
  );

  return [value, setValue];
}

/**
 * matchesDirection — the predicate. Wraps the null/undefined check
 * so callers don't repeat it. `null` direction (very old rows)
 * counts as inbound.
 */
export function matchesDirection(
  filter: DirectionFilterValue,
  callDirection: string | null | undefined,
): boolean {
  if (filter === "all") return true;
  const d = (callDirection || "inbound").toLowerCase();
  return d === filter;
}

/**
 * DirectionFilter — the visual control. Segmented button. Compact
 * (fits above a table header, in a card top-right, etc.).
 */
export function DirectionFilter({
  value,
  onChange,
  size = "sm",
}: {
  value: DirectionFilterValue;
  onChange: (v: DirectionFilterValue) => void;
  size?: "sm" | "md";
}) {
  const options: Array<{ value: DirectionFilterValue; label: string }> = [
    { value: "all", label: "All" },
    { value: "inbound", label: "Inbound" },
    { value: "outbound", label: "Outbound" },
  ];
  const btnPad = size === "md" ? "px-3 py-1.5 text-xs" : "px-2 py-1 text-[11px]";
  return (
    <div
      role="tablist"
      aria-label="Filter by call direction"
      className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`${btnPad} rounded-md font-medium transition-colors ${
              active
                ? "bg-slate-800 text-white"
                : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
