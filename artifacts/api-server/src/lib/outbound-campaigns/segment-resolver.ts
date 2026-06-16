/**
 * Phase 2.3 — segment-resolver.
 *
 * Translates a campaign's segment_definition (JSON DSL) into a
 * supabase-js query against the leads table. Returns the matching
 * lead IDs.
 *
 * SECURITY-BY-CONSTRUCTION
 * ────────────────────────
 * Field names and operator names are gated by hard-coded allowlists.
 * User-supplied field/op strings are looked up in maps and the MAP'S
 * column name (never the user string) is what flows to supabase-js.
 * Unknown fields/ops are rejected at validation time before any DB
 * call.
 *
 * Values go through supabase-js's PostgREST URL parameterization for
 * the AND-chain (.eq/.in/etc.). For the OR-clause (.or() builder),
 * PostgREST does NOT parameterize values — see SQL Injection Guard
 * below.
 *
 * SQL INJECTION GUARD (filters.any)
 * ─────────────────────────────────
 * supabase-js's .or() takes a PostgREST URL-format string like
 * "col.op.val,col.op.val". The VALUES are string-concatenated into
 * that URL — a value containing a comma, paren, double-quote, or
 * backslash would mis-parse and could be exploited.
 *
 * Mitigation: parseSegmentDefinition rejects any string value
 * containing one of those four characters. Phase 2 segment vocabulary
 * (status names, urgency levels, source labels) never legitimately
 * contains those chars. If a future use case needs them, we lift to a
 * Postgres RPC function (Phase 3+) — clean Postgres-side escaping.
 *
 * Documented in JSDoc + the parser's specific error message + a
 * load-bearing smoke test (T12) so a future maintainer who relaxes
 * the validator trips the regression guard immediately.
 *
 * JSON DSL SHAPE
 * ──────────────
 *   {
 *     "version": 1,
 *     "filters": {
 *       "all": [          // AND-joined chain
 *         { "field": "leads.status", "op": "in", "value": ["new", "claimed"] },
 *         { "field": "leads.do_not_call", "op": "eq", "value": false },
 *         { "field": "leads.last_outbound_attempt_at", "op": "older_than", "value": "30d" }
 *       ],
 *       "any": [          // OR-joined; combined with .all via AND
 *         { "field": "leads.urgency", "op": "eq", "value": "high" },
 *         { "field": "leads.urgency", "op": "eq", "value": "emergency" }
 *       ]
 *     }
 *   }
 *
 * Empty filters ({} or {all: [], any: []}) returns all business-scoped
 * leadIds — useful for "everyone except DNCs" campaigns paired with
 * calling_hours + consent gates at fire time.
 *
 * older_than / newer_than VALUE FORMAT
 * ────────────────────────────────────
 * Duration string: `(N)(s|m|h|d|w)` where N is a positive integer.
 * Examples: "30d" = 30 days, "2h" = 2 hours, "45m" = 45 minutes,
 * "60s" = 60 seconds, "1w" = 1 week.
 *
 * `older_than: "30d"` translates to `col < (NOW - 30d)`.
 * `newer_than: "30d"` translates to `col > (NOW - 30d)`.
 *
 * VERSIONING
 * ──────────
 * Top-level `version: 1` is required for forward-compat. Future
 * versions can be migrated forward at read time; this resolver only
 * accepts version 1.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Allowlists ───────────────────────────────────────────────────────

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

export interface FieldSpec {
  /** Column name as it lives in the leads table. Never user-supplied. */
  col: string;
  type: FieldType;
}

export const ALLOWED_FIELDS: ReadonlyMap<string, FieldSpec> = new Map([
  ["leads.status", { col: "status", type: "text" }],
  ["leads.urgency", { col: "urgency", type: "text" }],
  ["leads.source", { col: "source", type: "text" }],
  ["leads.preferred_channel", { col: "preferred_channel", type: "text" }],
  ["leads.do_not_call", { col: "do_not_call", type: "boolean" }],
  ["leads.outcome_booked", { col: "outcome_booked", type: "boolean" }],
  ["leads.outbound_attempt_count", { col: "outbound_attempt_count", type: "integer" }],
  ["leads.last_outbound_attempt_at", { col: "last_outbound_attempt_at", type: "timestamp" }],
  ["leads.first_response_at", { col: "first_response_at", type: "timestamp" }],
  ["leads.created_at", { col: "created_at", type: "timestamp" }],
  ["leads.resolved_at", { col: "resolved_at", type: "timestamp" }],
]);

export const ALLOWED_OPERATORS: ReadonlyMap<FieldType, ReadonlySet<Op>> = new Map([
  ["text", new Set<Op>(["eq", "neq", "in", "not_in", "exists", "not_exists"])],
  ["boolean", new Set<Op>(["eq", "neq"])],
  ["integer", new Set<Op>(["eq", "neq", "lt", "lte", "gt", "gte"])],
  ["timestamp", new Set<Op>(["lt", "lte", "gt", "gte", "older_than", "newer_than", "exists", "not_exists"])],
]);

const VALUE_ESCAPE_RE = /[,()"\\]/;
const IN_VALUE_MAX = 50;
const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;

// ── Types ────────────────────────────────────────────────────────────

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

export interface ResolveSegmentResult {
  leadIds: string[];
  error?: string;
}

// ── Validation ───────────────────────────────────────────────────────

/**
 * Hand-written validator. Returns the parsed shape OR `{ error: string }`.
 * Caller branches via `"error" in result`. Matches Phase 2.2.5's
 * parseRecordAppointmentPayload convention.
 */
export function parseSegmentDefinition(input: unknown): SegmentDefinition | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: "segment_definition must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) {
    return { error: "segment_definition.version must be 1" };
  }
  if (!obj.filters || typeof obj.filters !== "object") {
    return { error: "segment_definition.filters is required" };
  }
  const filters = obj.filters as Record<string, unknown>;
  const allRaw = filters.all;
  const anyRaw = filters.any;
  if (allRaw !== undefined && !Array.isArray(allRaw)) {
    return { error: "filters.all must be an array if provided" };
  }
  if (anyRaw !== undefined && !Array.isArray(anyRaw)) {
    return { error: "filters.any must be an array if provided" };
  }

  const allClauses: FilterClause[] = [];
  for (const [idx, raw] of (allRaw as unknown[] ?? []).entries()) {
    const parsed = parseClause(raw, `filters.all[${idx}]`);
    if ("error" in parsed) return parsed;
    allClauses.push(parsed);
  }
  const anyClauses: FilterClause[] = [];
  for (const [idx, raw] of (anyRaw as unknown[] ?? []).entries()) {
    const parsed = parseClause(raw, `filters.any[${idx}]`);
    if ("error" in parsed) return parsed;
    anyClauses.push(parsed);
  }

  return { version: 1, filters: { all: allClauses, any: anyClauses } };
}

function parseClause(input: unknown, path: string): FilterClause | { error: string } {
  if (!input || typeof input !== "object") {
    return { error: `${path} must be an object` };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.field !== "string") {
    return { error: `${path}.field must be a string` };
  }
  const field = obj.field;
  const spec = ALLOWED_FIELDS.get(field);
  if (!spec) {
    return {
      error: `${path}.field '${field}' is not allowed. Allowed: ${Array.from(ALLOWED_FIELDS.keys()).join(", ")}`,
    };
  }
  if (typeof obj.op !== "string") {
    return { error: `${path}.op must be a string` };
  }
  const op = obj.op as Op;
  const allowedOps = ALLOWED_OPERATORS.get(spec.type)!;
  if (!allowedOps.has(op)) {
    return {
      error: `${path}.op '${op}' is not allowed on ${spec.type} field '${field}'. Allowed: ${Array.from(allowedOps).join(", ")}`,
    };
  }

  // Value validation per (op, type).
  const value = obj.value;
  if (op === "exists" || op === "not_exists") {
    // value is ignored for existence checks
    return { field, op, value: undefined };
  }
  if (op === "in" || op === "not_in") {
    if (!Array.isArray(value)) {
      return { error: `${path}.value must be an array for op '${op}'` };
    }
    if (value.length === 0) {
      return { error: `${path}.value array must be non-empty for op '${op}'` };
    }
    if (value.length > IN_VALUE_MAX) {
      return { error: `${path}.value array exceeds ${IN_VALUE_MAX} elements` };
    }
    for (const [i, v] of value.entries()) {
      const e = validatePrimitive(v, spec.type, `${path}.value[${i}]`);
      if (e) return { error: e };
    }
    return { field, op, value };
  }
  if (op === "older_than" || op === "newer_than") {
    if (typeof value !== "string") {
      return { error: `${path}.value must be a duration string for op '${op}'` };
    }
    if (!DURATION_RE.test(value)) {
      return { error: `${path}.value must match duration format (e.g. '30d', '2h', '45m'); got '${value}'` };
    }
    return { field, op, value };
  }
  // Single primitive ops (eq, neq, lt, lte, gt, gte).
  const e = validatePrimitive(value, spec.type, `${path}.value`);
  if (e) return { error: e };
  return { field, op, value };
}

function validatePrimitive(v: unknown, type: FieldType, path: string): string | null {
  switch (type) {
    case "text":
      if (typeof v !== "string") return `${path} must be a string`;
      if (VALUE_ESCAPE_RE.test(v)) {
        return `${path} contains a reserved character (',', '(', ')', '\"', or '\\\\') — not allowed in segment definitions`;
      }
      return null;
    case "boolean":
      if (typeof v !== "boolean") return `${path} must be a boolean`;
      return null;
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v) || Math.floor(v) !== v) {
        return `${path} must be an integer`;
      }
      return null;
    case "timestamp":
      if (typeof v !== "string") return `${path} must be an ISO 8601 timestamp string`;
      if (isNaN(new Date(v).getTime())) return `${path} must be a valid ISO 8601 timestamp`;
      if (VALUE_ESCAPE_RE.test(v)) {
        return `${path} contains a reserved character — not allowed in segment definitions`;
      }
      return null;
  }
}

// ── Duration parsing ─────────────────────────────────────────────────

/**
 * Parse "30d" / "2h" / "45m" / "60s" / "1w" into milliseconds. Returns
 * null on parse failure (caller should have validated upstream).
 */
export function parseDuration(s: string): number | null {
  const m = DURATION_RE.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "s": return n * 1000;
    case "m": return n * 60 * 1000;
    case "h": return n * 60 * 60 * 1000;
    case "d": return n * 24 * 60 * 60 * 1000;
    case "w": return n * 7 * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

// ── Resolution ───────────────────────────────────────────────────────

/**
 * Translate a parsed segment_definition into a supabase-js query and
 * return matching lead IDs. `now` is the wall-clock used for
 * older_than/newer_than cutoffs (defaults to new Date()); accepts an
 * override for deterministic tests.
 */
export async function resolveSegment(
  supabase: SupabaseClient,
  businessId: string,
  segmentDefinition: SegmentDefinition,
  now: Date = new Date(),
): Promise<ResolveSegmentResult> {
  let q = supabase.from("leads").select("id").eq("business_id", businessId);

  // filters.all — AND-chained.
  for (const clause of segmentDefinition.filters.all ?? []) {
    q = applyAndClause(q, clause, now);
  }

  // filters.any — single .or() with comma-joined clauses.
  const anyClauses = segmentDefinition.filters.any ?? [];
  if (anyClauses.length > 0) {
    const orStrings = anyClauses
      .map((c) => buildOrClauseString(c, now))
      .filter((s): s is string => s !== null);
    if (orStrings.length > 0) {
      q = q.or(orStrings.join(","));
    }
  }

  try {
    const { data, error } = await q;
    if (error) {
      return { leadIds: [], error: error.message };
    }
    const rows = (data ?? []) as Array<{ id: string }>;
    return { leadIds: rows.map((r) => r.id) };
  } catch (err: any) {
    return { leadIds: [], error: err?.message || String(err) };
  }
}

function applyAndClause(q: any, clause: FilterClause, now: Date): any {
  const spec = ALLOWED_FIELDS.get(clause.field)!;
  const col = spec.col;
  switch (clause.op) {
    case "eq": return q.eq(col, clause.value);
    case "neq": return q.neq(col, clause.value);
    case "in": return q.in(col, clause.value as unknown[]);
    case "not_in": return q.not(col, "in", `(${(clause.value as unknown[]).join(",")})`);
    case "lt": return q.lt(col, clause.value);
    case "lte": return q.lte(col, clause.value);
    case "gt": return q.gt(col, clause.value);
    case "gte": return q.gte(col, clause.value);
    case "older_than": {
      const ms = parseDuration(clause.value as string)!;
      return q.lt(col, new Date(now.getTime() - ms).toISOString());
    }
    case "newer_than": {
      const ms = parseDuration(clause.value as string)!;
      return q.gt(col, new Date(now.getTime() - ms).toISOString());
    }
    case "exists": return q.not(col, "is", null);
    case "not_exists": return q.is(col, null);
  }
}

function buildOrClauseString(clause: FilterClause, now: Date): string | null {
  const spec = ALLOWED_FIELDS.get(clause.field)!;
  const col = spec.col;
  switch (clause.op) {
    case "eq": return `${col}.eq.${formatScalar(clause.value)}`;
    case "neq": return `${col}.neq.${formatScalar(clause.value)}`;
    case "in": {
      const arr = (clause.value as unknown[]).map(formatScalar).join(",");
      return `${col}.in.(${arr})`;
    }
    case "not_in": {
      const arr = (clause.value as unknown[]).map(formatScalar).join(",");
      return `not.${col}.in.(${arr})`;
    }
    case "lt": return `${col}.lt.${formatScalar(clause.value)}`;
    case "lte": return `${col}.lte.${formatScalar(clause.value)}`;
    case "gt": return `${col}.gt.${formatScalar(clause.value)}`;
    case "gte": return `${col}.gte.${formatScalar(clause.value)}`;
    case "older_than": {
      const ms = parseDuration(clause.value as string)!;
      return `${col}.lt.${new Date(now.getTime() - ms).toISOString()}`;
    }
    case "newer_than": {
      const ms = parseDuration(clause.value as string)!;
      return `${col}.gt.${new Date(now.getTime() - ms).toISOString()}`;
    }
    case "exists": return `not.${col}.is.null`;
    case "not_exists": return `${col}.is.null`;
  }
}

function formatScalar(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  // String values — already validator-rejected for escape chars at parse
  // time. The remaining surface is safe to concatenate into the .or()
  // URL string.
  return String(v);
}
