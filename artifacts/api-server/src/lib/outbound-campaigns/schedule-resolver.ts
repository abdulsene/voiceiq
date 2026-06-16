/**
 * Phase 2.3 — schedule-resolver.
 *
 * Translates a campaign's schedule_definition into per-lead
 * `scheduledFor` Date objects. Returns a Map<leadId, Date> — leads
 * that don't have a resolvable anchor (time_relative without a
 * matching appointment, OR scheduledFor in the past) are absent from
 * the map. Caller (Phase 2.4 worker) reads the absence and writes
 * outbound_campaign_leads with state='skipped',
 * skip_reason='no_matching_anchor' for those leads.
 *
 * Two strategies supported in 2.3 (matches outbound_campaigns.
 * schedule_strategy CHECK):
 *
 *   bulk:
 *     { version: 1, strategy: "bulk", fire_at: ISO_8601_string }
 *     Every leadId gets the same scheduledFor = fire_at.
 *
 *   time_relative:
 *     {
 *       version: 1,
 *       strategy: "time_relative",
 *       anchor: {
 *         table: "appointments",          // allowlist of 1 in 2.3
 *         field: "appointment_datetime",  // allowlist of 1 in 2.3
 *         lead_join: "lead_id",           // appointments.lead_id = leads.id
 *         filter: { status: "confirmed" } // optional, additional WHERE
 *       },
 *       offset_minutes: -1440             // negative = before; -1440 = 24h before
 *     }
 *     Each lead's scheduledFor = appointment.appointment_datetime + offset_minutes.
 *
 * EARLIEST-WINS for multi-appointment leads. If a lead has two
 * confirmed appointments, the resolver picks the EARLIEST. Alternative
 * "one call per appointment" would require dropping UNIQUE(campaign_id,
 * lead_id) on outbound_campaign_leads — different feature, Phase 3+.
 * Verified by smoke T13 as a regression guard.
 *
 * Past-time filtering. If a computed scheduledFor lands before `now`
 * (default new Date()), the lead is OMITTED from the result map.
 * Past appointments can't be reminded.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Types ────────────────────────────────────────────────────────────

export type ScheduleStrategy = "bulk" | "time_relative";

export interface BulkScheduleDefinition {
  version: 1;
  strategy: "bulk";
  fire_at: string;  // ISO 8601 with timezone
}

export interface TimeRelativeAnchor {
  table: "appointments";
  field: "appointment_datetime";
  lead_join: "lead_id";
  filter?: Record<string, string | number | boolean>;
}

export interface TimeRelativeScheduleDefinition {
  version: 1;
  strategy: "time_relative";
  anchor: TimeRelativeAnchor;
  offset_minutes: number;
}

export type ScheduleDefinition = BulkScheduleDefinition | TimeRelativeScheduleDefinition;

// Allowlist for anchor.filter keys — restricted in 2.3 to a single field.
// Future migrations can expand without changing this resolver's API.
const APPOINTMENT_FILTER_ALLOWLIST: ReadonlyMap<string, "text" | "boolean"> = new Map([
  ["status", "text"],
]);

export interface ResolveScheduleResult {
  scheduledFor: Map<string, Date>;
  error?: string;
}

// ── Validation ───────────────────────────────────────────────────────

export function parseScheduleDefinition(input: unknown): ScheduleDefinition | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "schedule_definition must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) {
    return { error: "schedule_definition.version must be 1" };
  }
  const strategy = obj.strategy;
  if (strategy === "bulk") {
    if (typeof obj.fire_at !== "string") {
      return { error: "schedule_definition.fire_at must be a string for strategy='bulk'" };
    }
    const d = new Date(obj.fire_at);
    if (isNaN(d.getTime())) {
      return { error: "schedule_definition.fire_at must be a valid ISO 8601 timestamp" };
    }
    return { version: 1, strategy: "bulk", fire_at: obj.fire_at };
  }
  if (strategy === "time_relative") {
    if (typeof obj.offset_minutes !== "number" || !Number.isFinite(obj.offset_minutes)) {
      return { error: "schedule_definition.offset_minutes must be a number" };
    }
    if (!obj.anchor || typeof obj.anchor !== "object") {
      return { error: "schedule_definition.anchor is required for strategy='time_relative'" };
    }
    const anchor = obj.anchor as Record<string, unknown>;
    if (anchor.table !== "appointments") {
      return { error: "schedule_definition.anchor.table must be 'appointments' (only supported value in 2.3)" };
    }
    if (anchor.field !== "appointment_datetime") {
      return { error: "schedule_definition.anchor.field must be 'appointment_datetime' (only supported value in 2.3)" };
    }
    if (anchor.lead_join !== "lead_id") {
      return { error: "schedule_definition.anchor.lead_join must be 'lead_id' (only supported value in 2.3)" };
    }
    let filter: Record<string, string | number | boolean> | undefined;
    if (anchor.filter !== undefined) {
      if (!anchor.filter || typeof anchor.filter !== "object") {
        return { error: "schedule_definition.anchor.filter must be an object if provided" };
      }
      filter = {};
      for (const [k, v] of Object.entries(anchor.filter as Record<string, unknown>)) {
        const type = APPOINTMENT_FILTER_ALLOWLIST.get(k);
        if (!type) {
          return {
            error: `schedule_definition.anchor.filter['${k}'] is not allowed. Allowed: ${Array.from(APPOINTMENT_FILTER_ALLOWLIST.keys()).join(", ")}`,
          };
        }
        if (type === "text" && typeof v !== "string") {
          return { error: `schedule_definition.anchor.filter['${k}'] must be a string` };
        }
        if (type === "boolean" && typeof v !== "boolean") {
          return { error: `schedule_definition.anchor.filter['${k}'] must be a boolean` };
        }
        filter[k] = v as string | number | boolean;
      }
    }
    return {
      version: 1,
      strategy: "time_relative",
      anchor: {
        table: "appointments",
        field: "appointment_datetime",
        lead_join: "lead_id",
        filter,
      },
      offset_minutes: obj.offset_minutes,
    };
  }
  return { error: "schedule_definition.strategy must be 'bulk' or 'time_relative'" };
}

// ── Resolution ───────────────────────────────────────────────────────

export async function resolveSchedule(
  supabase: SupabaseClient,
  businessId: string,
  leadIds: string[],
  scheduleDefinition: ScheduleDefinition,
  now: Date = new Date(),
): Promise<ResolveScheduleResult> {
  const out = new Map<string, Date>();

  if (scheduleDefinition.strategy === "bulk") {
    const fireAt = new Date(scheduleDefinition.fire_at);
    if (fireAt.getTime() <= now.getTime()) {
      return { scheduledFor: out, error: "bulk fire_at is in the past — no leads scheduled" };
    }
    for (const leadId of leadIds) {
      out.set(leadId, fireAt);
    }
    return { scheduledFor: out };
  }

  // time_relative
  if (leadIds.length === 0) return { scheduledFor: out };

  let q = supabase
    .from("appointments")
    .select("lead_id, appointment_datetime")
    .eq("business_id", businessId)
    .in("lead_id", leadIds);
  for (const [k, v] of Object.entries(scheduleDefinition.anchor.filter ?? {})) {
    q = q.eq(k, v);
  }
  // Order by appointment_datetime ASC so we can dedupe by lead_id taking
  // the FIRST (earliest) row per lead — earliest-wins semantic.
  q = q.order("appointment_datetime", { ascending: true });

  try {
    const { data, error } = await q;
    if (error) {
      return { scheduledFor: out, error: error.message };
    }
    const rows = (data ?? []) as Array<{ lead_id: string; appointment_datetime: string }>;
    const offsetMs = scheduleDefinition.offset_minutes * 60 * 1000;
    for (const row of rows) {
      // First (earliest, due to ORDER BY ASC) wins per lead.
      if (out.has(row.lead_id)) continue;
      const apptDate = new Date(row.appointment_datetime);
      if (isNaN(apptDate.getTime())) continue;
      const scheduled = new Date(apptDate.getTime() + offsetMs);
      // Filter past scheduledFor — can't fire a call in the past.
      if (scheduled.getTime() <= now.getTime()) continue;
      out.set(row.lead_id, scheduled);
    }
    return { scheduledFor: out };
  } catch (err: any) {
    return { scheduledFor: out, error: err?.message || String(err) };
  }
}
