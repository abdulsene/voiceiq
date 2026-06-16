/**
 * Phase 2.6b — SegmentBuilder shared types + display metadata.
 *
 * FIELD_DISPLAY_INFO + ALLOWED_OPERATORS_BY_TYPE mirror the server-side
 * ALLOWED_FIELDS + ALLOWED_OPERATORS in
 * artifacts/api-server/src/lib/outbound-campaigns/segment-resolver.ts.
 * The server is authoritative; any drift is a bug. Client is kept in
 * sync manually — small surface, tight allowlist, easy to grep when
 * the server adds a field.
 */

export type FieldType = "text" | "boolean" | "integer" | "timestamp";

export type Op =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "older_than"
  | "newer_than"
  | "exists"
  | "not_exists";

export interface FilterClause {
  field: string;
  op: Op;
  value?: unknown;
}

export interface SegmentDefinition {
  version: 1;
  filters: {
    all?: FilterClause[];
    any?: FilterClause[];
  };
}

export interface FieldDisplayInfo {
  /** i18n key — full namespace path. */
  labelKey: string;
  type: FieldType;
  /** Optional enum allowlist; ValueInput renders a Select / MultiSelect when present. */
  enumValues?: string[];
}

export const FIELD_DISPLAY_INFO: Record<string, FieldDisplayInfo> = {
  "leads.status": {
    labelKey: "campaigns.builder.segment.fields.leads_status",
    type: "text",
    enumValues: ["new", "claimed", "in_progress", "resolved", "dismissed"],
  },
  "leads.urgency": {
    labelKey: "campaigns.builder.segment.fields.leads_urgency",
    type: "text",
    enumValues: ["low", "medium", "high", "emergency"],
  },
  "leads.source": {
    labelKey: "campaigns.builder.segment.fields.leads_source",
    type: "text",
  },
  "leads.preferred_channel": {
    labelKey: "campaigns.builder.segment.fields.leads_preferred_channel",
    type: "text",
    enumValues: ["text", "call", "email", "voice_callback"],
  },
  "leads.do_not_call": {
    labelKey: "campaigns.builder.segment.fields.leads_do_not_call",
    type: "boolean",
  },
  "leads.outcome_booked": {
    labelKey: "campaigns.builder.segment.fields.leads_outcome_booked",
    type: "boolean",
  },
  "leads.outbound_attempt_count": {
    labelKey: "campaigns.builder.segment.fields.leads_outbound_attempt_count",
    type: "integer",
  },
  "leads.last_outbound_attempt_at": {
    labelKey: "campaigns.builder.segment.fields.leads_last_outbound_attempt_at",
    type: "timestamp",
  },
  "leads.first_response_at": {
    labelKey: "campaigns.builder.segment.fields.leads_first_response_at",
    type: "timestamp",
  },
  "leads.created_at": {
    labelKey: "campaigns.builder.segment.fields.leads_created_at",
    type: "timestamp",
  },
  "leads.resolved_at": {
    labelKey: "campaigns.builder.segment.fields.leads_resolved_at",
    type: "timestamp",
  },
};

export const ALL_FIELD_KEYS = Object.keys(FIELD_DISPLAY_INFO);

export const ALLOWED_OPERATORS_BY_TYPE: Record<FieldType, Op[]> = {
  text: ["eq", "neq", "in", "not_in", "exists", "not_exists"],
  boolean: ["eq", "neq"],
  integer: ["eq", "neq", "lt", "lte", "gt", "gte"],
  timestamp: ["lt", "lte", "gt", "gte", "older_than", "newer_than", "exists", "not_exists"],
};

export const OP_LABEL_KEYS: Record<Op, string> = {
  eq: "campaigns.builder.segment.ops.eq",
  neq: "campaigns.builder.segment.ops.neq",
  in: "campaigns.builder.segment.ops.in",
  not_in: "campaigns.builder.segment.ops.not_in",
  lt: "campaigns.builder.segment.ops.lt",
  lte: "campaigns.builder.segment.ops.lte",
  gt: "campaigns.builder.segment.ops.gt",
  gte: "campaigns.builder.segment.ops.gte",
  older_than: "campaigns.builder.segment.ops.older_than",
  newer_than: "campaigns.builder.segment.ops.newer_than",
  exists: "campaigns.builder.segment.ops.exists",
  not_exists: "campaigns.builder.segment.ops.not_exists",
};

export function defaultSegment(): SegmentDefinition {
  return { version: 1, filters: { all: [], any: [] } };
}
