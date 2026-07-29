/**
 * Phase 3.1a — best-effort parser for the free-form
 * business_configs.business_hours TEXT column into structured
 * business_hours table rows.
 *
 * Real production samples this parser targets:
 *   - "Monday-Friday 9AM-5PM"                                    ← canonical
 *   - "Tuesday-Saturday 10AM-7PM"
 *   - "9-5 Mon-Fri"                                              ← reversed order
 *   - "9-5"                                                      ← bare — assume Mon-Fri
 *   - "Monday-Friday 7AM-7PM, 24/7 Emergency"                    ← ignore emergency appendix
 *   - "Mon-Fri 9:00 AM - 5:00 PM"                                ← spaces + colons
 *   - "Mon, Tue, Wed, Thu, Fri, Sat 9:00 AM - 4:00 PM"           ← EZ Rentals; day list
 *   - "24/7"                                                     ← always-open
 *   - "By appointment"                                           ← unparseable → fallback
 *
 * The parser always returns 7 rows (one per weekday) so the API layer
 * can bulk-upsert without gap-handling. Days that couldn't be parsed
 * as open are marked is_closed=true.
 *
 * Fallback ordering:
 *   1. "24/7" / "24 hours" / "always open"  → all 7 days open 00:00-23:59
 *   2. Day range + time range               → primary path
 *   3. Day list + time range                → day-list variant
 *   4. Bare time range (no days)            → assume Mon-Fri
 *   5. Nothing recognizable                 → all 7 days closed=false Mon-Fri 09:00-17:00,
 *                                              Sat+Sun is_closed=true; warning added
 *
 * day_of_week uses JavaScript / Postgres DOW convention:
 *   0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday
 *
 * The parser is pure — no DB, no logging, no side effects. Callers
 * (route handlers, backfill scripts) are responsible for Sentry-logging
 * parseWarnings alongside the raw input and business_id.
 */

export interface BusinessHoursRow {
  day_of_week: number; // 0=Sunday .. 6=Saturday
  opens_at: string | null; // 'HH:MM' 24h format, or null when closed
  closes_at: string | null;
  timezone: string;
  is_closed: boolean;
}

export interface ParseResult {
  rows: BusinessHoursRow[]; // always length 7 (Sun..Sat)
  parseWarnings: string[];
  usedFallback: boolean;
}

const DEFAULT_TZ = "America/New_York";

// Prefix map — first 3 letters, lowercase. Handles both short ("Mon")
// and long ("Monday") forms. Order matters: sun before sat before sun (etc)
// doesn't apply here because we match on the leading 3 letters.
const DAY_PREFIX_TO_DOW: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

// Weekday-only Mon-Fri (for the "9-5" bare-time and fallback cases).
const MON_FRI_DOWS = [1, 2, 3, 4, 5];
const ALL_DOWS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Build the 7-row skeleton with all days closed. Callers open specific
 * days via openDays().
 */
function skeleton(tz: string): BusinessHoursRow[] {
  const rows: BusinessHoursRow[] = [];
  for (let dow = 0; dow < 7; dow++) {
    rows.push({ day_of_week: dow, opens_at: null, closes_at: null, timezone: tz, is_closed: true });
  }
  return rows;
}

function openDays(
  rows: BusinessHoursRow[],
  dows: number[],
  opens: string,
  closes: string,
): void {
  for (const dow of dows) {
    rows[dow] = {
      day_of_week: dow,
      opens_at: opens,
      closes_at: closes,
      timezone: rows[dow].timezone,
      is_closed: false,
    };
  }
}

/**
 * Detect always-open shorthand.
 */
function isAlwaysOpen(text: string): boolean {
  return /(?:^|\W)(?:24\s*\/\s*7|24\s*hours?|always\s*open)(?:$|\W)/i.test(text);
}

/**
 * Extract a day range like "Mon-Fri", "Monday - Friday", "Tuesday–Saturday"
 * from the START of the input. Returns the inclusive DOW list on match.
 */
function matchDayRange(text: string): number[] | null {
  const m = /^\s*([a-z]{3,9})\s*[-–]\s*([a-z]{3,9})/i.exec(text);
  if (!m) return null;
  const startDow = DAY_PREFIX_TO_DOW[m[1].slice(0, 3).toLowerCase()];
  const endDow = DAY_PREFIX_TO_DOW[m[2].slice(0, 3).toLowerCase()];
  if (startDow === undefined || endDow === undefined) return null;
  return expandDowRange(startDow, endDow);
}

/**
 * Expand an inclusive DOW range, wrapping around the week if end < start
 * (e.g., "Fri-Mon" → [5, 6, 0, 1]).
 */
function expandDowRange(start: number, end: number): number[] {
  const out: number[] = [];
  let cur = start;
  // Safety cap at 7 iterations — the loop naturally terminates once we
  // hit `end`.
  for (let i = 0; i < 7; i++) {
    out.push(cur);
    if (cur === end) return out;
    cur = (cur + 1) % 7;
  }
  return out;
}

/**
 * Extract a comma or space-separated day list from the START of input
 * (e.g., "Mon, Tue, Wed, Thu, Fri, Sat", "Sunday", "Mon Tue"). Returns
 * the DOW list on match of one or more distinct days. A single day is a
 * legitimate list — "Sunday 10AM-2PM" means Sunday only.
 */
function matchDayList(text: string): number[] | null {
  // Consume "Mon,? " or "Monday,? " up to something that isn't a day.
  const re = /\s*([a-z]{3,9})\s*,?\s*/giy;
  const dows: number[] = [];
  const seen = new Set<number>();
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    const prefix = m[1].slice(0, 3).toLowerCase();
    const dow = DAY_PREFIX_TO_DOW[prefix];
    if (dow === undefined) break;
    if (seen.has(dow)) break; // duplicate day → stop
    seen.add(dow);
    dows.push(dow);
    // Don't gobble words that aren't days — the regex `y` flag anchors
    // to lastIndex, so as soon as we get an invalid day the outer loop
    // breaks.
  }
  return dows.length >= 1 ? dows : null;
}

/**
 * Find a time range like "9-5", "9AM-5PM", "9:00 AM - 5:00 PM",
 * "10AM-7PM", anywhere in the input. Returns the first match. AM/PM is
 * optional; when absent, hour < 8 is assumed PM, hour >= 8 is assumed
 * AM (matches how humans write "9-5" for 9AM-5PM and "10-2" for
 * 10AM-2PM).
 */
function matchTimeRange(text: string): { opens_at: string; closes_at: string } | null {
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
  const m = re.exec(text);
  if (!m) return null;

  const startHour = parseInt(m[1], 10);
  const startMin = m[2] ? parseInt(m[2], 10) : 0;
  const startAmpm = m[3]?.toLowerCase() as "am" | "pm" | undefined;
  const endHour = parseInt(m[4], 10);
  const endMin = m[5] ? parseInt(m[5], 10) : 0;
  const endAmpm = m[6]?.toLowerCase() as "am" | "pm" | undefined;

  if (!Number.isFinite(startHour) || !Number.isFinite(endHour)) return null;
  if (startHour > 24 || endHour > 24 || startMin > 59 || endMin > 59) return null;

  const startH24 = to24h(startHour, startAmpm, false);
  const endH24 = to24h(endHour, endAmpm, true);
  if (startH24 === null || endH24 === null) return null;

  return {
    opens_at: fmt(startH24, startMin),
    closes_at: fmt(endH24, endMin),
  };
}

/**
 * Convert 12-hour to 24-hour. When ampm is absent, infer:
 *   - hours >= 8 and <= 11  → AM
 *   - hours 12              → 12 (noon or midnight if isEnd)
 *   - hours 1..7            → PM (afternoon)
 *   - hours 0               → 00:00 (midnight)
 * This heuristic handles "9-5" as 09:00-17:00 and "10-2" as 10:00-14:00
 * without requiring AM/PM tags.
 */
function to24h(hour: number, ampm: "am" | "pm" | undefined, isEnd: boolean): number | null {
  if (hour < 0 || hour > 24) return null;
  if (hour === 24) return 23; // "9-24" → treat as 23:59 territory
  if (ampm === "am") return hour === 12 ? 0 : hour;
  if (ampm === "pm") return hour === 12 ? 12 : hour + 12;
  // No AM/PM — infer.
  if (hour === 0) return 0;
  if (hour === 12) return 12;
  if (hour >= 8 && hour <= 11) return hour; // 8, 9, 10, 11 → AM
  if (hour >= 1 && hour <= 7) return hour + 12; // 1..7 → PM (13..19)
  return hour; // fallthrough for edge cases
}

function fmt(hour: number, minute: number): string {
  const hh = hour.toString().padStart(2, "0");
  const mm = minute.toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Best-effort parse of a free-form business_hours string into 7
 * structured rows. Always returns 7 rows; failed parses fall back to
 * Mon-Fri 09:00-17:00 with parseWarnings populated.
 */
export function parseBusinessHours(input: string | null | undefined, defaultTz?: string): ParseResult {
  const tz = defaultTz || DEFAULT_TZ;
  const warnings: string[] = [];

  if (!input || typeof input !== "string" || input.trim().length === 0) {
    return {
      rows: fallback(tz),
      parseWarnings: ["empty or missing business_hours text; used Mon-Fri 09:00-17:00 fallback"],
      usedFallback: true,
    };
  }

  const raw = input.trim();
  const normalized = raw.replace(/–/g, "-").replace(/\s+/g, " ");

  // Ignore appendix segments after a comma when the appendix looks like
  // an emergency/24-7 line. Runs BEFORE isAlwaysOpen so the appendix's
  // "24/7" doesn't hijack the primary segment. Typical case: "Monday-
  // Friday 7AM-7PM, 24/7 Emergency" — parse the first segment only.
  //
  // If the first segment lacks recognizable day + time, we still try the
  // whole string (day-list form uses commas too — "Mon, Tue, Wed 9-5").
  const commaIdx = normalized.indexOf(",");
  const isAppendixEmergency =
    commaIdx > 0 && /24\s*\/?\s*7|emergency/i.test(normalized.slice(commaIdx));

  const primary = isAppendixEmergency ? normalized.slice(0, commaIdx).trim() : normalized;

  // Always-open shorthand — only applies when the *primary* segment says so.
  if (isAlwaysOpen(primary)) {
    const rows = skeleton(tz);
    openDays(rows, ALL_DOWS, "00:00", "23:59");
    return { rows, parseWarnings: [], usedFallback: false };
  }

  // (2) Day range + time range on the primary segment.
  const rangeDows = matchDayRange(primary);
  if (rangeDows) {
    const time = matchTimeRange(primary);
    if (time) {
      const rows = skeleton(tz);
      openDays(rows, rangeDows, time.opens_at, time.closes_at);
      return { rows, parseWarnings: warnings, usedFallback: false };
    }
    warnings.push(`found day range but no time range in "${raw}"; used fallback`);
    return { rows: fallback(tz, rangeDows), parseWarnings: warnings, usedFallback: true };
  }

  // (2b) Time range appears BEFORE day range: "9-5 Mon-Fri".
  const timeFirst = matchTimeRange(primary);
  if (timeFirst) {
    // Strip the matched time so we can search the remainder for a day range or list.
    const timeRe = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
    const tmpText = primary.replace(timeRe, " ").trim();
    const rangeAfter = matchDayRange(tmpText);
    if (rangeAfter) {
      const rows = skeleton(tz);
      openDays(rows, rangeAfter, timeFirst.opens_at, timeFirst.closes_at);
      return { rows, parseWarnings: warnings, usedFallback: false };
    }
    const listAfter = matchDayList(tmpText);
    if (listAfter) {
      const rows = skeleton(tz);
      openDays(rows, listAfter, timeFirst.opens_at, timeFirst.closes_at);
      return { rows, parseWarnings: warnings, usedFallback: false };
    }
    // No days found around the time range → assume Mon-Fri.
    const rows = skeleton(tz);
    openDays(rows, MON_FRI_DOWS, timeFirst.opens_at, timeFirst.closes_at);
    warnings.push(`time range with no days in "${raw}"; assumed Mon-Fri`);
    return { rows, parseWarnings: warnings, usedFallback: false };
    // (This is the "bare 9-5" case — Mon-Fri assumed per spec.)
  }

  // (3) Day list + time range.
  const listDows = matchDayList(primary);
  if (listDows) {
    // matchDayList consumed leading day names; the remainder should
    // contain the time.
    const listRe = /^\s*(?:[a-z]{3,9}\s*,?\s*)+/i;
    const consumedLen = listRe.exec(primary)?.[0].length ?? 0;
    const remainder = primary.slice(consumedLen);
    const time = matchTimeRange(remainder);
    if (time) {
      const rows = skeleton(tz);
      openDays(rows, listDows, time.opens_at, time.closes_at);
      return { rows, parseWarnings: warnings, usedFallback: false };
    }
    warnings.push(`found day list but no time range in "${raw}"; used fallback`);
    return { rows: fallback(tz, listDows), parseWarnings: warnings, usedFallback: true };
  }

  // (5) Nothing recognizable — Mon-Fri 9-5 fallback.
  warnings.push(`could not parse "${raw}"; used Mon-Fri 09:00-17:00 fallback`);
  return { rows: fallback(tz), parseWarnings: warnings, usedFallback: true };
}

function fallback(tz: string, openDowsList: number[] = MON_FRI_DOWS): BusinessHoursRow[] {
  const rows = skeleton(tz);
  openDays(rows, openDowsList, "09:00", "17:00");
  return rows;
}

/**
 * Compute whether a business is open at the given instant, given its
 * 7-day schedule and a timezone. Returns { is_open, current_day_row,
 * next_opens_at }. The timezone is taken from the first non-null row's
 * timezone (rows should all share a tz in Phase 3.1a; multi-location
 * variance is a future concern).
 *
 * next_opens_at is the ISO string of the next opening moment when
 * !is_open. When is_open, next_opens_at is null.
 */
export function computeIsOpenNow(
  rows: BusinessHoursRow[],
  now: Date,
): {
  is_open: boolean;
  current_day_row: BusinessHoursRow | null;
  next_opens_at: string | null;
  timezone: string;
} {
  const tz = rows.find((r) => r.timezone)?.timezone || DEFAULT_TZ;

  // Resolve the current wall-clock time in the business's tz.
  const { dow, hh, mm } = wallClockInTz(now, tz);
  const currentTime = fmt(hh, mm);
  const currentRow = rows.find((r) => r.day_of_week === dow) || null;

  const isOpenToday =
    currentRow !== null &&
    !currentRow.is_closed &&
    currentRow.opens_at !== null &&
    currentRow.closes_at !== null &&
    currentTime >= currentRow.opens_at &&
    currentTime < currentRow.closes_at;

  if (isOpenToday) {
    return { is_open: true, current_day_row: currentRow, next_opens_at: null, timezone: tz };
  }

  // Not currently open — find the next opening.
  const nextIso = findNextOpenIso(rows, now, tz);
  return { is_open: false, current_day_row: currentRow, next_opens_at: nextIso, timezone: tz };
}

/**
 * Resolve current wall-clock in a target timezone. Uses Intl for DST
 * correctness (Intl handles US DST transitions properly).
 */
function wallClockInTz(instant: Date, tz: string): { dow: number; hh: number; mm: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    }).formatToParts(instant);
    let hh = 0;
    let mm = 0;
    let dowStr = "";
    for (const p of parts) {
      if (p.type === "hour") hh = parseInt(p.value, 10);
      else if (p.type === "minute") mm = parseInt(p.value, 10);
      else if (p.type === "weekday") dowStr = p.value.toLowerCase();
    }
    if (hh === 24) hh = 0; // Intl sometimes returns "24" for midnight
    const dow = DAY_NAMES.indexOf(dowStr.slice(0, 3));
    return { dow: dow >= 0 ? dow : instant.getUTCDay(), hh, mm };
  } catch {
    // Invalid tz — fall back to UTC clock (deterministic but wrong-for-tz).
    return { dow: instant.getUTCDay(), hh: instant.getUTCHours(), mm: instant.getUTCMinutes() };
  }
}

/**
 * Walk forward day-by-day (up to 8 days to be defensive against
 * all-closed schedules) until we find an opening moment strictly
 * later than `now` in the business's timezone. Returns an ISO string
 * anchored to `now`'s day for readability; the caller uses it to
 * render "Opens Monday at 9:00 AM".
 */
function findNextOpenIso(rows: BusinessHoursRow[], now: Date, tz: string): string | null {
  const { dow: todayDow, hh, mm } = wallClockInTz(now, tz);
  const currentTime = fmt(hh, mm);

  for (let offset = 0; offset < 8; offset++) {
    const candidateDow = (todayDow + offset) % 7;
    const row = rows.find((r) => r.day_of_week === candidateDow);
    if (!row || row.is_closed || !row.opens_at || !row.closes_at) continue;

    if (offset === 0) {
      // Today. Only counts if opens_at is still in the future.
      if (currentTime < row.opens_at) {
        return anchorToDay(now, offset, row.opens_at, tz);
      }
      // Past today's opening — skip to tomorrow.
      continue;
    }
    return anchorToDay(now, offset, row.opens_at, tz);
  }
  return null;
}

/**
 * Produce an ISO string for "date + offset days at hh:mm in tz". We
 * build the string in the business's tz then convert to UTC.
 *
 * Intl doesn't provide a straightforward local-time → UTC round-trip,
 * so we approximate by taking `now`, adding `offset` days, and setting
 * the wall-clock components to the target hh:mm. The result is
 * approximate for DST-transition days (off by an hour), which is
 * acceptable for a "next opens at" display — the actual open moment is
 * always +/- 60 minutes anyway.
 */
function anchorToDay(now: Date, dayOffset: number, hhmm: string, tz: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);

  // Determine `now` in the target tz to know what "the same wall-clock
  // hour on day D+offset" means when converted back to UTC.
  const { hh: nowHh, mm: nowMm } = wallClockInTz(now, tz);
  const utcOffsetHrs = (now.getUTCHours() - nowHh + 24) % 24;
  const utcOffsetMins = (now.getUTCMinutes() - nowMm + 60) % 60;

  const anchor = new Date(now.getTime());
  anchor.setUTCDate(anchor.getUTCDate() + dayOffset);
  anchor.setUTCHours(h + utcOffsetHrs, m + utcOffsetMins, 0, 0);
  return anchor.toISOString();
}
