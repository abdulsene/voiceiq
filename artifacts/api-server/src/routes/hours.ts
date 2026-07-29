/**
 * Phase 3.1a — structured business hours endpoints.
 *
 *   GET   /api/business/hours          — 7 rows (or fewer if none configured yet)
 *   PATCH /api/business/hours          — bulk upsert (send the full 7-row schedule)
 *   GET   /api/business/hours/now      — is_open + next_opens_at (load-bearing for
 *                                        Phase 3.5 after-hours flow)
 *
 * PATCH is a bulk replace. UI sends the complete 7-day schedule; the
 * handler deletes existing rows for the business and re-inserts. Doing
 * it this way (rather than per-row upsert) makes it trivial for the
 * client to reason about "I saved the whole schedule". UNIQUE
 * (business_id, day_of_week) still keeps individual rows correct.
 *
 * Validation:
 *   * day_of_week 0-6, each appearing exactly once
 *   * is_closed=true ⇔ opens_at and closes_at both null
 *   * is_closed=false ⇔ both non-null and opens_at < closes_at
 *     (overnight windows deferred to Phase 3.5)
 *   * timezone must be a valid IANA name — validated via
 *     Intl.DateTimeFormat throw-on-invalid
 *
 * "is_open now?" uses computeIsOpenNow from lib/business-hours/parser.ts
 * so the same logic drives both this endpoint and any Phase 3.5
 * after-hours cron.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import {
  computeIsOpenNow,
  parseBusinessHours,
  type BusinessHoursRow,
} from "../lib/business-hours/parser";

const router = Router();

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Validation ───────────────────────────────────────────────────────

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ParsedHoursRow {
  day_of_week: number;
  opens_at: string | null;
  closes_at: string | null;
  timezone: string;
  is_closed: boolean;
}

export function parseHoursBody(body: unknown): { hours: ParsedHoursRow[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.hours)) return { error: "hours must be an array" };
  if (b.hours.length === 0) return { error: "hours must contain at least one row" };

  const out: ParsedHoursRow[] = [];
  const seenDows = new Set<number>();
  for (const raw of b.hours as unknown[]) {
    if (!raw || typeof raw !== "object") return { error: "each hours row must be an object" };
    const r = raw as Record<string, unknown>;

    const dow = typeof r.day_of_week === "number" ? r.day_of_week : NaN;
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      return { error: "day_of_week must be an integer 0-6" };
    }
    if (seenDows.has(dow)) return { error: `duplicate day_of_week ${dow}` };
    seenDows.add(dow);

    const timezone = typeof r.timezone === "string" && r.timezone.trim().length > 0
      ? r.timezone.trim()
      : "America/New_York";
    if (!isValidTimezone(timezone)) return { error: `invalid IANA timezone "${timezone}"` };

    const is_closed = r.is_closed === true;

    let opens_at: string | null = null;
    let closes_at: string | null = null;

    if (is_closed) {
      // Enforce both times null when closed.
      if (r.opens_at !== undefined && r.opens_at !== null) {
        return { error: `day ${dow}: opens_at must be null when is_closed=true` };
      }
      if (r.closes_at !== undefined && r.closes_at !== null) {
        return { error: `day ${dow}: closes_at must be null when is_closed=true` };
      }
    } else {
      if (typeof r.opens_at !== "string" || !HHMM_RE.test(r.opens_at)) {
        return { error: `day ${dow}: opens_at must be HH:MM (24h)` };
      }
      if (typeof r.closes_at !== "string" || !HHMM_RE.test(r.closes_at)) {
        return { error: `day ${dow}: closes_at must be HH:MM (24h)` };
      }
      opens_at = r.opens_at;
      closes_at = r.closes_at;
      if (opens_at >= closes_at) {
        return { error: `day ${dow}: opens_at must be earlier than closes_at (overnight windows not yet supported)` };
      }
    }

    out.push({ day_of_week: dow, opens_at, closes_at, timezone, is_closed });
  }

  return { hours: out };
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function handleGetHours(
  supabase: SupabaseClient,
  businessId: string,
): Promise<{ ok: true; hours: BusinessHoursRow[] } | { ok: false; status: number; error: string }> {
  try {
    const { data, error } = await supabase
      .from("business_hours")
      .select("day_of_week, opens_at, closes_at, timezone, is_closed")
      .eq("business_id", businessId)
      .order("day_of_week", { ascending: true });
    if (error) {
      Sentry.captureMessage("hours_get_failed", {
        level: "error",
        extra: { businessId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const rows = (data as any[] | null) ?? [];
    const hours: BusinessHoursRow[] = rows.map((r) => ({
      day_of_week: r.day_of_week,
      opens_at: r.opens_at ? String(r.opens_at).slice(0, 5) : null,
      closes_at: r.closes_at ? String(r.closes_at).slice(0, 5) : null,
      timezone: r.timezone || "America/New_York",
      is_closed: r.is_closed === true,
    }));
    return { ok: true, hours };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handlePatchHours(
  supabase: SupabaseClient,
  businessId: string,
  hours: ParsedHoursRow[],
): Promise<{ ok: true; hours: BusinessHoursRow[] } | { ok: false; status: number; error: string }> {
  // Bulk replace: DELETE existing rows, then INSERT the new set. Simpler
  // than per-row upsert and matches the UI's "save the whole schedule"
  // mental model.
  const del = await supabase.from("business_hours").delete().eq("business_id", businessId);
  if (del.error) {
    Sentry.captureMessage("hours_patch_delete_failed", {
      level: "error",
      extra: { businessId, error: del.error.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }

  const rows = hours.map((h) => ({
    business_id: businessId,
    day_of_week: h.day_of_week,
    opens_at: h.opens_at,
    closes_at: h.closes_at,
    timezone: h.timezone,
    is_closed: h.is_closed,
  }));
  const ins = await supabase.from("business_hours").insert(rows).select("*");
  if (ins.error) {
    Sentry.captureMessage("hours_patch_insert_failed", {
      level: "error",
      extra: { businessId, error: ins.error.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }
  const persisted: BusinessHoursRow[] = ((ins.data as any[] | null) ?? [])
    .map((r) => ({
      day_of_week: r.day_of_week,
      opens_at: r.opens_at ? String(r.opens_at).slice(0, 5) : null,
      closes_at: r.closes_at ? String(r.closes_at).slice(0, 5) : null,
      timezone: r.timezone || "America/New_York",
      is_closed: r.is_closed === true,
    }))
    .sort((a, b) => a.day_of_week - b.day_of_week);
  return { ok: true, hours: persisted };
}

export interface HoursNowResult {
  is_open: boolean;
  current_day_row: BusinessHoursRow | null;
  next_opens_at: string | null;
  timezone: string;
}

/**
 * "Is the business open right now?"
 *
 * If no structured hours exist for this business, falls back to parsing
 * business_configs.business_hours (free-form text) via the TS parser so
 * a business that hasn't run the admin migration still gets a
 * meaningful answer. Two flags on the response tell the caller which
 * source was used.
 */
export async function handleHoursNow(
  supabase: SupabaseClient,
  businessId: string,
  now: Date,
): Promise<
  | { ok: true; source: "structured" | "parsed_fallback" | "default_fallback"; result: HoursNowResult }
  | { ok: false; status: number; error: string }
> {
  const structuredResp = await handleGetHours(supabase, businessId);
  if (!structuredResp.ok) return structuredResp;

  if (structuredResp.hours.length > 0) {
    return {
      ok: true,
      source: "structured",
      result: computeIsOpenNow(structuredResp.hours, now),
    };
  }

  // No structured hours — fall back to parsing the free-form text.
  const bizResp = await supabase
    .from("business_configs")
    .select("business_hours")
    .eq("business_id", businessId)
    .maybeSingle();
  if (bizResp.error) return { ok: false, status: 500, error: "Database error" };
  const raw = (bizResp.data as { business_hours?: string | null } | null)?.business_hours;
  const parsed = parseBusinessHours(raw ?? null);
  return {
    ok: true,
    source: parsed.usedFallback ? "default_fallback" : "parsed_fallback",
    result: computeIsOpenNow(parsed.rows, now),
  };
}

// ── Route registrations ─────────────────────────────────────────────

router.get(
  "/business/hours",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleGetHours(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ hours: result.hours });
  },
);

// GET /now MUST come before GET /:something-else so the "now" path
// isn't captured by a params-style route.
router.get(
  "/business/hours/now",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleHoursNow(supabase, businessId, new Date());
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ source: result.source, ...result.result });
  },
);

router.patch(
  "/business/hours",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const parsed = parseHoursBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handlePatchHours(supabase, businessId, parsed.hours);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ hours: result.hours });
  },
);

export default router;
