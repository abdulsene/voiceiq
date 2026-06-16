/**
 * Client-side mirror of the server-side parseSegmentDefinition in
 * artifacts/api-server/src/lib/outbound-campaigns/segment-resolver.ts.
 *
 * Used by JsonEditor's parse-on-blur. Identical error shape:
 *   { ok: true; value: SegmentDefinition } | { ok: false; error: string }
 *
 * The server still validates on POST — this is purely a UX nicety so
 * users get immediate feedback when typing JSON. If client and server
 * disagree, the server wins (and we should bring them back into sync).
 */

import {
  ALL_FIELD_KEYS,
  ALLOWED_OPERATORS_BY_TYPE,
  FIELD_DISPLAY_INFO,
  type FilterClause,
  type Op,
  type SegmentDefinition,
} from "./types";

const VALUE_ESCAPE_RE = /[,()"\\]/;
const IN_VALUE_MAX = 50;
const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;

export type ParseResult =
  | { ok: true; value: SegmentDefinition }
  | { ok: false; error: string };

export function parseSegmentDefinition(input: unknown): ParseResult {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "segment_definition must be an object" };
  }
  const obj = input as Record<string, unknown>;
  if (obj.version !== 1) {
    return { ok: false, error: "segment_definition.version must be 1" };
  }
  if (!obj.filters || typeof obj.filters !== "object") {
    return { ok: false, error: "segment_definition.filters is required" };
  }
  const filters = obj.filters as Record<string, unknown>;
  const allRaw = filters.all;
  const anyRaw = filters.any;
  if (allRaw !== undefined && !Array.isArray(allRaw)) {
    return { ok: false, error: "filters.all must be an array if provided" };
  }
  if (anyRaw !== undefined && !Array.isArray(anyRaw)) {
    return { ok: false, error: "filters.any must be an array if provided" };
  }
  const allClauses: FilterClause[] = [];
  for (const [idx, raw] of (allRaw as unknown[] ?? []).entries()) {
    const r = parseClause(raw, `filters.all[${idx}]`);
    if (!r.ok) return r;
    allClauses.push(r.value);
  }
  const anyClauses: FilterClause[] = [];
  for (const [idx, raw] of (anyRaw as unknown[] ?? []).entries()) {
    const r = parseClause(raw, `filters.any[${idx}]`);
    if (!r.ok) return r;
    anyClauses.push(r.value);
  }
  return { ok: true, value: { version: 1, filters: { all: allClauses, any: anyClauses } } };
}

function parseClause(input: unknown, path: string): { ok: true; value: FilterClause } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: `${path} must be an object` };
  const obj = input as Record<string, unknown>;
  if (typeof obj.field !== "string") return { ok: false, error: `${path}.field must be a string` };
  if (!ALL_FIELD_KEYS.includes(obj.field)) {
    return {
      ok: false,
      error: `${path}.field '${obj.field}' is not allowed. Allowed: ${ALL_FIELD_KEYS.join(", ")}`,
    };
  }
  const info = FIELD_DISPLAY_INFO[obj.field];
  if (typeof obj.op !== "string") return { ok: false, error: `${path}.op must be a string` };
  const op = obj.op as Op;
  const allowed = ALLOWED_OPERATORS_BY_TYPE[info.type];
  if (!allowed.includes(op)) {
    return {
      ok: false,
      error: `${path}.op '${op}' is not allowed on ${info.type} field '${obj.field}'. Allowed: ${allowed.join(", ")}`,
    };
  }
  const v = obj.value;
  if (op === "exists" || op === "not_exists") {
    return { ok: true, value: { field: obj.field, op, value: undefined } };
  }
  if (op === "in" || op === "not_in") {
    if (!Array.isArray(v)) return { ok: false, error: `${path}.value must be an array for op '${op}'` };
    if (v.length === 0) return { ok: false, error: `${path}.value must be non-empty for op '${op}'` };
    if (v.length > IN_VALUE_MAX) return { ok: false, error: `${path}.value exceeds ${IN_VALUE_MAX}` };
    for (const [i, vv] of v.entries()) {
      const e = checkPrimitive(vv, info.type, `${path}.value[${i}]`);
      if (e) return { ok: false, error: e };
    }
    return { ok: true, value: { field: obj.field, op, value: v } };
  }
  if (op === "older_than" || op === "newer_than") {
    if (typeof v !== "string") return { ok: false, error: `${path}.value must be a duration string for op '${op}'` };
    if (!DURATION_RE.test(v)) {
      return { ok: false, error: `${path}.value must match '30d' / '2h' / '45m' / '60s' / '1w'; got '${v}'` };
    }
    return { ok: true, value: { field: obj.field, op, value: v } };
  }
  const e = checkPrimitive(v, info.type, `${path}.value`);
  if (e) return { ok: false, error: e };
  return { ok: true, value: { field: obj.field, op, value: v } };
}

function checkPrimitive(v: unknown, type: "text" | "boolean" | "integer" | "timestamp", path: string): string | null {
  switch (type) {
    case "text":
      if (typeof v !== "string") return `${path} must be a string`;
      if (VALUE_ESCAPE_RE.test(v)) return `${path} contains a reserved char (',', '(', ')', '"', '\\')`;
      return null;
    case "boolean":
      if (typeof v !== "boolean") return `${path} must be a boolean`;
      return null;
    case "integer":
      if (typeof v !== "number" || !Number.isFinite(v) || Math.floor(v) !== v) return `${path} must be an integer`;
      return null;
    case "timestamp":
      if (typeof v !== "string") return `${path} must be an ISO 8601 timestamp`;
      if (isNaN(new Date(v).getTime())) return `${path} must be a valid ISO 8601 timestamp`;
      if (VALUE_ESCAPE_RE.test(v)) return `${path} contains a reserved char`;
      return null;
  }
}
