/**
 * Phase 2.6b — ScheduleBuilder types. Mirrors the server-side DSL in
 * artifacts/api-server/src/lib/outbound-campaigns/schedule-resolver.ts.
 */

export type ScheduleStrategy = "bulk" | "time_relative";

export interface BulkScheduleDefinition {
  version: 1;
  strategy: "bulk";
  fire_at: string;
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

export function defaultBulkSchedule(): BulkScheduleDefinition {
  // Tomorrow at noon local — a sensible non-past starting point.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(12, 0, 0, 0);
  return { version: 1, strategy: "bulk", fire_at: tomorrow.toISOString() };
}

export function defaultTimeRelativeSchedule(): TimeRelativeScheduleDefinition {
  return {
    version: 1,
    strategy: "time_relative",
    anchor: {
      table: "appointments",
      field: "appointment_datetime",
      lead_join: "lead_id",
      filter: { status: "confirmed" },
    },
    // 24 hours before appointment.
    offset_minutes: -1440,
  };
}
