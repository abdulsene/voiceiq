/**
 * Phase 0 Commit 0-C — TCPA calling-hours gate.
 *
 * Checks whether the recipient's LOCAL time falls inside the tenant's
 * configured outbound calling window. Three potential blocks:
 *   - tenant_disabled  — business_configs.outbound_voice_enabled=FALSE
 *   - wrong_day        — recipient's local weekday not in the days[] window
 *   - outside_hours    — recipient's local HH:MM outside [start, end)
 *                        (end is EXCLUSIVE — 21:00:00 means we stop at
 *                        20:59:59, which is the TCPA-safe interpretation)
 *
 * Recipient timezone is REQUIRED (no inference here). The campaign
 * engine in Phase 1 will ship lib/phone-timezone.ts which infers an
 * IANA name from area code; until then, callers either pass a
 * tenant-default ("America/New_York") or pull from contact metadata.
 *
 * Implementation uses native Intl.DateTimeFormat — no date-fns-tz
 * dependency. Intl handles DST transitions correctly because the
 * formatter resolves the wall-clock time in the target zone for the
 * given instant. Invalid timezone strings throw RangeError; we catch
 * and fail-closed.
 *
 * Fail-closed: DB error / invalid timezone / anything unexpected
 * returns { allowed: false } with the most-specific blocked_by we
 * can infer. Never throws.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CallingHoursCheckResult {
  allowed: boolean;
  blocked_by?: "tenant_disabled" | "outside_hours" | "wrong_day";
  recipient_local_time?: string;
  recipient_local_weekday?: number;
  window?: { start: string; end: string; days: number[] };
}

export interface CheckCallingHoursOptions {
  businessId: string;
  /** IANA name e.g. 'America/New_York'. REQUIRED. */
  recipientTimezone: string;
  /** Defaults to new Date(). Pass a fixed instant for deterministic tests. */
  now?: Date;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

export async function checkCallingHours(
  supabase: SupabaseClient,
  opts: CheckCallingHoursOptions,
): Promise<CallingHoursCheckResult> {
  let row: {
    outbound_voice_enabled: boolean | null;
    outbound_calling_hours_start: string | null;
    outbound_calling_hours_end: string | null;
    outbound_calling_hours_days: number[] | null;
  } | null;
  try {
    const { data, error } = await supabase
      .from("business_configs")
      .select(
        "outbound_voice_enabled, outbound_calling_hours_start, outbound_calling_hours_end, outbound_calling_hours_days",
      )
      .eq("business_id", opts.businessId)
      .maybeSingle();
    if (error) return { allowed: false, blocked_by: "tenant_disabled" };
    row = data as any;
  } catch {
    return { allowed: false, blocked_by: "tenant_disabled" };
  }
  if (!row) return { allowed: false, blocked_by: "tenant_disabled" };

  if (row.outbound_voice_enabled !== true) {
    return { allowed: false, blocked_by: "tenant_disabled" };
  }

  const start = (row.outbound_calling_hours_start || "08:00:00").slice(0, 5);
  const end = (row.outbound_calling_hours_end || "21:00:00").slice(0, 5);
  const days = Array.isArray(row.outbound_calling_hours_days)
    ? row.outbound_calling_hours_days
    : [1, 2, 3, 4, 5, 6, 7];
  const window = { start, end, days };

  let recipientLocalTime: string;
  let recipientLocalWeekday: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: opts.recipientTimezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    const parts = fmt.formatToParts(opts.now ?? new Date());
    let hour = "";
    let minute = "";
    let weekdayShort = "";
    for (const p of parts) {
      if (p.type === "hour") hour = p.value;
      else if (p.type === "minute") minute = p.value;
      else if (p.type === "weekday") weekdayShort = p.value;
    }
    // Intl returns '24' for midnight in 24h mode in some envs; normalize.
    if (hour === "24") hour = "00";
    recipientLocalTime = `${hour}:${minute}`;
    recipientLocalWeekday = WEEKDAY_TO_ISO[weekdayShort] ?? 0;
    if (!recipientLocalWeekday) {
      console.warn("[calling-hours] unexpected weekday string:", weekdayShort);
      return { allowed: false, blocked_by: "outside_hours", window };
    }
  } catch (err: any) {
    console.warn(
      "[calling-hours] invalid timezone or formatter error:",
      opts.recipientTimezone,
      err?.message,
    );
    return { allowed: false, blocked_by: "outside_hours", window };
  }

  if (!days.includes(recipientLocalWeekday)) {
    return {
      allowed: false,
      blocked_by: "wrong_day",
      recipient_local_time: recipientLocalTime,
      recipient_local_weekday: recipientLocalWeekday,
      window,
    };
  }

  // Lexical compare on 'HH:MM' is valid because both strings are
  // zero-padded fixed-width. start is inclusive, end is exclusive.
  if (recipientLocalTime < start || recipientLocalTime >= end) {
    return {
      allowed: false,
      blocked_by: "outside_hours",
      recipient_local_time: recipientLocalTime,
      recipient_local_weekday: recipientLocalWeekday,
      window,
    };
  }

  return {
    allowed: true,
    recipient_local_time: recipientLocalTime,
    recipient_local_weekday: recipientLocalWeekday,
    window,
  };
}
