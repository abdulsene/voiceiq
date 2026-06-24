/**
 * Phase 2.6a — campaigns CRUD endpoints.
 *
 *   GET    /api/business/campaigns                — list (paginated)
 *   GET    /api/business/campaigns/:id            — detail
 *   POST   /api/business/campaigns                — create draft
 *   PATCH  /api/business/campaigns/:id            — partial update
 *   DELETE /api/business/campaigns/:id            — atomic delete via RPC
 *   POST   /api/business/campaigns/preview        — dry-run segment+schedule
 *   GET    /api/business/campaigns/:id/leads      — paginated junction view
 *
 * Tenant scoping: every route resolves businessId from `req.businessId`
 * (set by requireAuth based on the user's active business). URL :id
 * params are scoped via WHERE id=$1 AND business_id=$tenantBizId in
 * every read/write so cross-tenant access returns 404 (not 403 — we
 * don't leak existence).
 *
 * Validation: POST/PATCH bodies run through parseSegmentDefinition and
 * parseScheduleDefinition (from lib/outbound-campaigns/*) on the JSON
 * fields. Both are hand-written validators matching the Phase 2.2.5
 * convention; failures return 400 with the specific error string.
 *
 * Preview: POST /campaigns/preview is a dry-run that resolves the
 * proposed segment + schedule without inserting anything. Returns 200
 * (even on parse error) with the error string in `segment_error` or
 * `schedule_error` so the dashboard's live-preview can render the
 * error inline as the user types.
 *
 * DELETE delegates to the migration 033 RPC
 * (delete_campaign_with_cancellations) which atomically: SELECT FOR
 * UPDATE locks the campaign, cancels any 'scheduled' lead_calls, then
 * DELETEs the campaign (cascade wipes junction rows). Returns the
 * counts so the success toast can report "Canceled X scheduled calls."
 *
 * Handlers are exported as functions so the 034 smoke can invoke them
 * directly with a mock req/res + FakeSupabaseClient (same pattern as
 * 028 schedule-call handler).
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import {
  parseSegmentDefinition,
  resolveSegment,
  type SegmentDefinition,
} from "../lib/outbound-campaigns/segment-resolver";
import {
  parseScheduleDefinition,
  resolveSchedule,
  type ScheduleDefinition,
} from "../lib/outbound-campaigns/schedule-resolver";

const router = Router();

const NAME_MAX = 200;
const OBJECTIVE_MAX = 100;
const VOICEMAIL_OVERRIDE_MAX = 2000;
const AGENT_ID_MAX = 200;
const VALID_STATUSES = ["draft", "queued", "active", "paused", "completed", "cancelled"] as const;
const VALID_STRATEGIES = ["bulk", "time_relative"] as const;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const PREVIEW_SAMPLE_LIMIT = 10;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Body parsing / validation ────────────────────────────────────────

interface ParsedCreateBody {
  name: string;
  call_objective: string;
  status?: string;
  agent_id?: string | null;
  voicemail_text_override?: string | null;
  segment_definition?: SegmentDefinition | null;
  schedule_definition?: ScheduleDefinition | null;
  schedule_strategy?: string;
  daily_cap?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

interface ParsedPatchBody {
  name?: string;
  call_objective?: string;
  status?: string;
  agent_id?: string | null;
  voicemail_text_override?: string | null;
  segment_definition?: SegmentDefinition | null;
  schedule_definition?: ScheduleDefinition | null;
  schedule_strategy?: string;
  daily_cap?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
}

function validateString(v: unknown, field: string, max: number, required: boolean): string | null | { error: string } {
  if (v === undefined || v === null || v === "") {
    if (required) return { error: `${field} is required` };
    return null;
  }
  if (typeof v !== "string") return { error: `${field} must be a string` };
  const trimmed = v.trim();
  if (required && trimmed.length === 0) return { error: `${field} is required` };
  if (trimmed.length > max) return { error: `${field} exceeds ${max} characters` };
  return trimmed;
}

function validateOptionalInt(v: unknown, field: string): number | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || Math.floor(v) !== v) {
    return { error: `${field} must be an integer` };
  }
  if (v < 0) return { error: `${field} must be non-negative` };
  return v;
}

function validateStatus(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !(VALID_STATUSES as readonly string[]).includes(v)) {
    return { error: `status must be one of ${VALID_STATUSES.join(", ")}` };
  }
  return v;
}

function validateStrategy(v: unknown): string | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !(VALID_STRATEGIES as readonly string[]).includes(v)) {
    return { error: `schedule_strategy must be one of ${VALID_STRATEGIES.join(", ")}` };
  }
  return v;
}

function validateOptionalIsoString(v: unknown, field: string): string | null | { error: string } {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return { error: `${field} must be a string` };
  const d = new Date(v);
  if (isNaN(d.getTime())) return { error: `${field} must be a valid ISO 8601 timestamp` };
  return v;
}

function validateSegmentField(v: unknown): SegmentDefinition | null | { error: string } {
  if (v === undefined || v === null) return null;
  const parsed = parseSegmentDefinition(v);
  if ("error" in parsed) return { error: `segment_definition: ${parsed.error}` };
  return parsed;
}

function validateScheduleField(v: unknown): ScheduleDefinition | null | { error: string } {
  if (v === undefined || v === null) return null;
  const parsed = parseScheduleDefinition(v);
  if ("error" in parsed) return { error: `schedule_definition: ${parsed.error}` };
  return parsed;
}

export function parseCreateBody(body: any): ParsedCreateBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const name = validateString(body.name, "name", NAME_MAX, true);
  if (typeof name === "object" && name && "error" in name) return name;
  if (name === null) return { error: "name is required" };
  const call_objective = validateString(body.call_objective, "call_objective", OBJECTIVE_MAX, true);
  if (typeof call_objective === "object" && call_objective && "error" in call_objective) return call_objective;
  if (call_objective === null) return { error: "call_objective is required" };
  const status = validateStatus(body.status);
  if (typeof status === "object" && status && "error" in status) return status;
  const agent_id = validateString(body.agent_id, "agent_id", AGENT_ID_MAX, false);
  if (typeof agent_id === "object" && agent_id && "error" in agent_id) return agent_id;
  const voicemail = validateString(body.voicemail_text_override, "voicemail_text_override", VOICEMAIL_OVERRIDE_MAX, false);
  if (typeof voicemail === "object" && voicemail && "error" in voicemail) return voicemail;
  const segment = validateSegmentField(body.segment_definition);
  if (segment && typeof segment === "object" && "error" in segment) return segment;
  const schedule = validateScheduleField(body.schedule_definition);
  if (schedule && typeof schedule === "object" && "error" in schedule) return schedule;
  const strategy = validateStrategy(body.schedule_strategy);
  if (typeof strategy === "object" && strategy && "error" in strategy) return strategy;
  const daily_cap = validateOptionalInt(body.daily_cap, "daily_cap");
  if (typeof daily_cap === "object" && daily_cap && "error" in daily_cap) return daily_cap;
  const starts_at = validateOptionalIsoString(body.starts_at, "starts_at");
  if (typeof starts_at === "object" && starts_at && "error" in starts_at) return starts_at;
  const ends_at = validateOptionalIsoString(body.ends_at, "ends_at");
  if (typeof ends_at === "object" && ends_at && "error" in ends_at) return ends_at;

  return {
    name: name as string,
    call_objective: call_objective as string,
    status: (status as string | null) ?? undefined,
    agent_id: (agent_id as string | null) ?? null,
    voicemail_text_override: (voicemail as string | null) ?? null,
    segment_definition: (segment as SegmentDefinition | null) ?? null,
    schedule_definition: (schedule as ScheduleDefinition | null) ?? null,
    schedule_strategy: (strategy as string | null) ?? undefined,
    daily_cap: (daily_cap as number | null) ?? null,
    starts_at: (starts_at as string | null) ?? null,
    ends_at: (ends_at as string | null) ?? null,
  };
}

export function parsePatchBody(body: any): ParsedPatchBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const out: ParsedPatchBody = {};

  if ("name" in body) {
    const v = validateString(body.name, "name", NAME_MAX, true);
    if (typeof v === "object" && v && "error" in v) return v;
    if (v === null) return { error: "name cannot be empty when provided" };
    out.name = v as string;
  }
  if ("call_objective" in body) {
    const v = validateString(body.call_objective, "call_objective", OBJECTIVE_MAX, true);
    if (typeof v === "object" && v && "error" in v) return v;
    if (v === null) return { error: "call_objective cannot be empty when provided" };
    out.call_objective = v as string;
  }
  if ("status" in body) {
    const v = validateStatus(body.status);
    if (typeof v === "object" && v && "error" in v) return v;
    if (v) out.status = v as string;
  }
  if ("agent_id" in body) {
    const v = validateString(body.agent_id, "agent_id", AGENT_ID_MAX, false);
    if (typeof v === "object" && v && "error" in v) return v;
    out.agent_id = (v as string | null) ?? null;
  }
  if ("voicemail_text_override" in body) {
    const v = validateString(body.voicemail_text_override, "voicemail_text_override", VOICEMAIL_OVERRIDE_MAX, false);
    if (typeof v === "object" && v && "error" in v) return v;
    out.voicemail_text_override = (v as string | null) ?? null;
  }
  if ("segment_definition" in body) {
    const v = validateSegmentField(body.segment_definition);
    if (v && typeof v === "object" && "error" in v) return v;
    out.segment_definition = (v as SegmentDefinition | null) ?? null;
  }
  if ("schedule_definition" in body) {
    const v = validateScheduleField(body.schedule_definition);
    if (v && typeof v === "object" && "error" in v) return v;
    out.schedule_definition = (v as ScheduleDefinition | null) ?? null;
  }
  if ("schedule_strategy" in body) {
    const v = validateStrategy(body.schedule_strategy);
    if (typeof v === "object" && v && "error" in v) return v;
    if (v) out.schedule_strategy = v as string;
  }
  if ("daily_cap" in body) {
    const v = validateOptionalInt(body.daily_cap, "daily_cap");
    if (typeof v === "object" && v && "error" in v) return v;
    out.daily_cap = (v as number | null) ?? null;
  }
  if ("starts_at" in body) {
    const v = validateOptionalIsoString(body.starts_at, "starts_at");
    if (typeof v === "object" && v && "error" in v) return v;
    out.starts_at = (v as string | null) ?? null;
  }
  if ("ends_at" in body) {
    const v = validateOptionalIsoString(body.ends_at, "ends_at");
    if (typeof v === "object" && v && "error" in v) return v;
    out.ends_at = (v as string | null) ?? null;
  }

  return out;
}

// ── Handler functions (exported for 034 smoke direct testing) ────────

export async function handleListCampaigns(
  supabase: SupabaseClient,
  businessId: string,
  query: { offset?: number; limit?: number; status?: string; objective?: string },
): Promise<{ ok: true; campaigns: any[]; total: number } | { ok: false; status: number; error: string }> {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIST_LIMIT));
  try {
    let q = supabase
      .from("outbound_campaigns")
      .select(
        "id, business_id, name, call_objective, status, agent_id, target_count, completed_count, succeeded_count, failed_count, voicemail_count, daily_cap, voicemail_text_override, schedule_strategy, last_expansion_at, created_at, updated_at",
        { count: "exact" },
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.status) q = q.eq("status", query.status);
    if (query.objective) q = q.eq("call_objective", query.objective);
    const { data, error, count } = await q;
    if (error) {
      Sentry.captureMessage("campaigns_list_failed", { level: "error", extra: { businessId, error: error.message } });
      return { ok: false, status: 500, error: "Database error" };
    }
    return { ok: true, campaigns: (data as any[]) ?? [], total: count ?? 0 };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleGetCampaign(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
): Promise<{ ok: true; campaign: any } | { ok: false; status: number; error: string }> {
  try {
    const { data, error } = await supabase
      .from("outbound_campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("campaign_detail_failed", { level: "error", extra: { campaignId, error: error.message } });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (!data) return { ok: false, status: 404, error: "Campaign not found" };
    return { ok: true, campaign: data };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleCreateCampaign(
  supabase: SupabaseClient,
  businessId: string,
  userId: string,
  body: ParsedCreateBody,
): Promise<{ ok: true; campaign: any } | { ok: false; status: number; error: string }> {
  const row: Record<string, unknown> = {
    business_id: businessId,
    name: body.name,
    call_objective: body.call_objective,
    status: body.status ?? "draft",
    created_by: userId,
  };
  if (body.agent_id !== undefined) row.agent_id = body.agent_id;
  if (body.voicemail_text_override !== undefined) row.voicemail_text_override = body.voicemail_text_override;
  if (body.segment_definition !== undefined) row.segment_definition = body.segment_definition;
  if (body.schedule_definition !== undefined) row.schedule_definition = body.schedule_definition;
  if (body.schedule_strategy !== undefined) row.schedule_strategy = body.schedule_strategy;
  if (body.daily_cap !== undefined) row.daily_cap = body.daily_cap;
  if (body.starts_at !== undefined) row.starts_at = body.starts_at;
  if (body.ends_at !== undefined) row.ends_at = body.ends_at;

  try {
    const { data, error } = await supabase
      .from("outbound_campaigns")
      .insert(row)
      .select("*")
      .single();
    if (error || !data) {
      Sentry.captureMessage("campaign_create_failed", { level: "error", extra: { businessId, error: error?.message } });
      return { ok: false, status: 500, error: error?.message || "Insert failed" };
    }
    return { ok: true, campaign: data };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handlePatchCampaign(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  body: ParsedPatchBody,
): Promise<{ ok: true; campaign: any } | { ok: false; status: number; error: string }> {
  if (Object.keys(body).length === 0) {
    return { ok: false, status: 400, error: "No fields to update" };
  }
  const updateRow: Record<string, unknown> = { ...body, updated_at: new Date().toISOString() };
  try {
    const { data, error } = await supabase
      .from("outbound_campaigns")
      .update(updateRow)
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .select("*")
      .single();
    if (error) {
      const msg = error.message || "Update failed";
      // PostgREST returns PGRST116 for "no rows updated" when single() is used.
      if (/no.*row|PGRST116/i.test(msg)) {
        return { ok: false, status: 404, error: "Campaign not found" };
      }
      Sentry.captureMessage("campaign_patch_failed", { level: "error", extra: { campaignId, error: msg } });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (!data) return { ok: false, status: 404, error: "Campaign not found" };
    return { ok: true, campaign: data };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleDeleteCampaign(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
): Promise<
  | { ok: true; canceled_call_count: number; deleted_junction_count: number }
  | { ok: false; status: number; error: string }
> {
  try {
    const { data, error } = await supabase.rpc("delete_campaign_with_cancellations", {
      p_campaign_id: campaignId,
      p_business_id: businessId,
    });
    if (error) {
      Sentry.captureMessage("campaign_delete_rpc_failed", {
        level: "error",
        extra: { campaignId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const rows = (data as Array<{ canceled_call_count: number; deleted_junction_count: number }>) ?? [];
    if (rows.length === 0) {
      return { ok: false, status: 404, error: "Campaign not found" };
    }
    const row = rows[0];
    return {
      ok: true,
      canceled_call_count: row.canceled_call_count ?? 0,
      deleted_junction_count: row.deleted_junction_count ?? 0,
    };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

interface PreviewSampleRow {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  scheduledFor?: string;
}

interface PreviewResponse {
  count: number;
  sample: PreviewSampleRow[];
  segment_error?: string;
  schedule_error?: string;
}

export async function handlePreviewCampaign(
  supabase: SupabaseClient,
  businessId: string,
  body: { segment_definition?: unknown; schedule_definition?: unknown },
): Promise<PreviewResponse> {
  // (1) Parse segment.
  const segParsed = parseSegmentDefinition(body.segment_definition);
  if ("error" in segParsed) {
    return { count: 0, sample: [], segment_error: segParsed.error };
  }
  // (2) Resolve segment.
  const segResult = await resolveSegment(supabase, businessId, segParsed as SegmentDefinition);
  if (segResult.error) {
    return { count: 0, sample: [], segment_error: segResult.error };
  }
  const allLeadIds = segResult.leadIds;
  const count = allLeadIds.length;
  const sampleIds = allLeadIds.slice(0, PREVIEW_SAMPLE_LIMIT);

  // (3) Fetch sample lead contact info.
  let sample: PreviewSampleRow[] = [];
  if (sampleIds.length > 0) {
    try {
      const { data: leadRows } = await supabase
        .from("leads")
        .select("id, contact_name, contact_phone")
        .eq("business_id", businessId)
        .in("id", sampleIds);
      sample = ((leadRows as PreviewSampleRow[]) ?? []).map((r) => ({
        id: r.id,
        contact_name: r.contact_name,
        contact_phone: r.contact_phone,
      }));
    } catch {
      // Best-effort; sample stays empty but count is correct.
    }
  }

  // (4) Optionally resolve schedule.
  if (body.schedule_definition !== undefined && body.schedule_definition !== null) {
    const schedParsed = parseScheduleDefinition(body.schedule_definition);
    if ("error" in schedParsed) {
      return { count, sample, schedule_error: schedParsed.error };
    }
    const schedResult = await resolveSchedule(
      supabase,
      businessId,
      sampleIds,
      schedParsed as ScheduleDefinition,
    );
    if (schedResult.error) {
      return { count, sample, schedule_error: schedResult.error };
    }
    // Merge scheduledFor onto sample rows.
    sample = sample.map((row) => {
      const sf = schedResult.scheduledFor.get(row.id);
      return sf ? { ...row, scheduledFor: sf.toISOString() } : row;
    });
  }

  return { count, sample };
}

export async function handleGetCampaignLeads(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
  query: { offset?: number; limit?: number; state?: string; skip_reason?: string },
): Promise<
  | { ok: true; rows: any[]; total: number }
  | { ok: false; status: number; error: string }
> {
  // Verify the campaign belongs to this tenant first.
  const owner = await supabase
    .from("outbound_campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!owner.data) return { ok: false, status: 404, error: "Campaign not found" };

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIST_LIMIT));
  try {
    let q = supabase
      .from("outbound_campaign_leads")
      .select(
        "id, lead_id, state, skip_reason, scheduled_call_id, scheduled_for, completed_at, created_at, updated_at, leads!inner(contact_name, contact_phone)",
        { count: "exact" },
      )
      .eq("campaign_id", campaignId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (query.state) q = q.eq("state", query.state);
    if (query.skip_reason) q = q.eq("skip_reason", query.skip_reason);
    const { data, error, count } = await q;
    if (error) {
      Sentry.captureMessage("campaign_leads_list_failed", {
        level: "error",
        extra: { campaignId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    return { ok: true, rows: (data as any[]) ?? [], total: count ?? 0 };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

// ── Metrics (Phase 2.7a) ────────────────────────────────────────────
//
// Re-aggregates from outbound_campaign_leads at query time rather than
// trusting outbound_campaigns.{target,scheduled,...}_count. The
// precomputed columns are maintained by the expansion worker + post-
// call writebacks; any drift surfaces here as a visible mismatch
// rather than getting papered over. (Phase 2.7 intentionally does NOT
// auto-reconcile — it surfaces. Auto-reconciliation can land later if
// the drift turns out to be a real ops pattern.)
//
// Phase 2.7a-fix: succeeded/failed/voicemail are NOT junction states
// (the junction CHECK constraint allows only pending/scheduled/
// completed/skipped/opted_out — see migration 032). Those outcomes
// live on the lead_calls row that the junction points at via
// scheduled_call_id, written by the twilio-outbound-voice status +
// AMD webhooks. We JOIN to lead_calls for state='completed' junction
// rows and derive the outcome in Node using the canonical mapping
// from src/routes/twilio-outbound-voice.ts.

export interface CampaignMetricsCounters {
  target: number;
  pending: number;
  scheduled: number;
  completed: number;
  succeeded: number;
  failed: number;
  voicemail: number;
  skipped: number;
}

export interface CampaignMetricsRates {
  connect_rate: number;
  voicemail_rate: number;
  skip_rate: number;
  completion_rate: number;
}

export interface CampaignMetricsTimeSeriesRow {
  date: string;
  scheduled: number;
  succeeded: number;
  failed: number;
  voicemail: number;
  skipped: number;
}

export interface CampaignMetricsResponse {
  campaign_id: string;
  counters: CampaignMetricsCounters;
  rates: CampaignMetricsRates;
  time_series: CampaignMetricsTimeSeriesRow[];
  skip_reasons: Array<{ reason: string; count: number }>;
  state_distribution: Array<{ state: string; count: number }>;
}

// Top 10 skip-reasons; tie-break alphabetically so the smoke can assert
// deterministic ordering (T3).
const SKIP_REASONS_LIMIT = 10;

// State allowlist for the time-series pivot — anything else (legacy /
// future states) folds into NO series and is silently ignored. The
// junction's state column is a CHECK-constrained enum (see migration
// 032), so this should never trip in practice, but the explicit list
// keeps the wire shape stable when a new state is introduced.
const TIME_SERIES_STATES = ["scheduled", "succeeded", "failed", "voicemail", "skipped"] as const;
type TimeSeriesState = (typeof TIME_SERIES_STATES)[number];

function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const r = numerator / denominator;
  // Cap at [0, 1] — drift could theoretically push above 1 if counter
  // semantics differ from junction reality; clamp so the UI doesn't
  // render >100%. The drift itself is still visible via the counters.
  if (!Number.isFinite(r)) return 0;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

// Canonical outcome mapping — kept in lockstep with
// src/routes/twilio-outbound-voice.ts:
//   - status handler sets status='completed' on CallStatus=completed,
//     and status='failed' (end_reason ∈ {no-answer, busy, failed,
//     canceled}) on the terminal-failure callbacks.
//   - AMD handler sets voicemail_left=false on first AnsweredBy, then
//     tryRedirectToVoicemail flips voicemail_left=true ONLY on a
//     successful redirect to the /voicemail TwiML route.
// Priority matters: voicemail_left wins over status='completed' because
// a voicemail call also ends in status='completed' (the redirect happens
// mid-call, then the call still terminates normally). Returns null for
// pre-terminal rows so the caller can detect drift between the junction
// state and the lead_calls reality.
type LeadCallFields = {
  status: string | null;
  voicemail_left: boolean | null;
  end_reason: string | null;
};
type DerivedOutcome = "succeeded" | "failed" | "voicemail" | null;
function deriveOutcome(call: LeadCallFields | null): DerivedOutcome {
  if (!call) return null;
  if (call.voicemail_left === true) return "voicemail";
  if (call.status === "failed") return "failed";
  if (call.status === "completed") return "succeeded";
  return null;
}

// PostgREST embedded select returns the joined row either as a single
// object or a one-element array depending on the relationship cardinality
// it infers. scheduled_call_id is a many-to-one FK (each junction row
// points at one lead_call) so a single object is the expected shape, but
// supabase-js typings have historically waffled on this — handle both.
function extractEmbeddedLeadCall(row: any): LeadCallFields | null {
  const lc = row?.lead_calls;
  if (!lc) return null;
  if (Array.isArray(lc)) return (lc[0] as LeadCallFields) ?? null;
  return lc as LeadCallFields;
}

export async function handleGetCampaignMetrics(
  supabase: SupabaseClient,
  businessId: string,
  campaignId: string,
): Promise<
  | { ok: true; metrics: CampaignMetricsResponse }
  | { ok: false; status: number; error: string }
> {
  // (1) Tenant ownership gate — 404 (not 403) on cross-tenant, mirrors
  //     handleGetCampaignLeads's pattern. No existence leak.
  try {
    const owner = await supabase
      .from("outbound_campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (!owner.data) return { ok: false, status: 404, error: "Campaign not found" };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }

  // (2) Parallel data fetch: 3 supabase-js queries + 1 RPC.
  //     - states: every junction row's `state` for the campaign. Used
  //       to derive lifecycle counters + state_distribution in Node.
  //     - skipReasons: only state='skipped' rows; group + top-10 in
  //       Node after fetch.
  //     - completedOutcomes: junction state='completed' rows JOIN'd to
  //       lead_calls via scheduled_call_id (PostgREST embedded select).
  //       succeeded/failed/voicemail derive from lead_calls fields per
  //       the canonical mapping in twilio-outbound-voice.ts — see
  //       deriveOutcome() above. The junction's `state` column tops
  //       out at 'completed'; the per-outcome split lives on lead_calls.
  //     - rpcTimeSeries: campaign_metrics_time_series RPC (migration
  //       034) — returns (day, state, count) for the last 30 days.
  try {
    const [statesResp, skipReasonsResp, completedOutcomesResp, rpcResp] = await Promise.all([
      supabase.from("outbound_campaign_leads").select("state").eq("campaign_id", campaignId),
      supabase
        .from("outbound_campaign_leads")
        .select("skip_reason")
        .eq("campaign_id", campaignId)
        .eq("state", "skipped"),
      supabase
        .from("outbound_campaign_leads")
        .select("id, state, lead_calls!scheduled_call_id(status, voicemail_left, end_reason)")
        .eq("campaign_id", campaignId)
        .eq("state", "completed"),
      supabase.rpc("campaign_metrics_time_series", { p_campaign_id: campaignId }),
    ]);

    if (statesResp.error) {
      Sentry.captureMessage("campaign_metrics_states_failed", {
        level: "error",
        extra: { campaignId, error: statesResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (skipReasonsResp.error) {
      Sentry.captureMessage("campaign_metrics_skip_reasons_failed", {
        level: "error",
        extra: { campaignId, error: skipReasonsResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (completedOutcomesResp.error) {
      Sentry.captureMessage("campaign_metrics_completed_outcomes_failed", {
        level: "error",
        extra: { campaignId, error: completedOutcomesResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (rpcResp.error) {
      Sentry.captureMessage("campaign_metrics_time_series_failed", {
        level: "error",
        extra: { campaignId, error: rpcResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }

    // (2a) Lifecycle counters from the junction state column. Note:
    //      succeeded/failed/voicemail are NOT computed here — they
    //      derive from lead_calls in (2a-bis). The junction CHECK
    //      constraint (migration 032) limits state to pending/
    //      scheduled/completed/skipped/opted_out, so reading those
    //      three from stateCounts would always return 0 in production
    //      (the original Phase 2.7a bug).
    const stateRows = (statesResp.data as Array<{ state: string | null }> | null) ?? [];
    const stateCounts: Record<string, number> = {};
    for (const r of stateRows) {
      const s = r.state ?? "unknown";
      stateCounts[s] = (stateCounts[s] ?? 0) + 1;
    }

    // (2a-bis) succeeded/failed/voicemail derivation from lead_calls.
    //          Iterate the completed junction rows, extract the
    //          embedded lead_call payload, and bucket via the
    //          canonical mapping helper. Rows where the FK is NULL
    //          (e.g. retention pruned the lead_call) or the call hasn't
    //          reached terminal status fall through to no-outcome —
    //          they show up as drift (succeeded + failed + voicemail
    //          < completed) which is the intentional Phase 2.7
    //          surface-don't-paper-over posture.
    const completedRows = (completedOutcomesResp.data as any[] | null) ?? [];
    let succeededCount = 0;
    let failedCount = 0;
    let voicemailCount = 0;
    for (const row of completedRows) {
      const outcome = deriveOutcome(extractEmbeddedLeadCall(row));
      if (outcome === "succeeded") succeededCount += 1;
      else if (outcome === "failed") failedCount += 1;
      else if (outcome === "voicemail") voicemailCount += 1;
    }

    const counters: CampaignMetricsCounters = {
      target: stateRows.length,
      pending: stateCounts["pending"] ?? 0,
      scheduled: stateCounts["scheduled"] ?? 0,
      completed: stateCounts["completed"] ?? 0,
      succeeded: succeededCount,
      failed: failedCount,
      voicemail: voicemailCount,
      skipped: stateCounts["skipped"] ?? 0,
    };

    // (2b) state_distribution — derived from the same counts, sorted
    //      by count desc so the donut renders biggest slice first.
    const state_distribution = Object.entries(stateCounts)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => (b.count - a.count) || a.state.localeCompare(b.state));

    // (2c) Rates — guarded against div/0 + clamped to [0, 1].
    //      connect_rate denom = (completed - voicemail) so voicemail
    //      doesn't inflate the connect rate; a voicemail is a delivery,
    //      not a conversation.
    const rates: CampaignMetricsRates = {
      connect_rate: safeRate(counters.succeeded, counters.completed - counters.voicemail),
      voicemail_rate: safeRate(counters.voicemail, counters.completed),
      skip_rate: safeRate(counters.skipped, counters.target),
      completion_rate: safeRate(counters.completed, counters.scheduled),
    };

    // (2d) skip_reasons — group + top-10 by count desc, then
    //      alphabetical on ties so T3 can assert deterministic order.
    const skipRows = (skipReasonsResp.data as Array<{ skip_reason: string | null }> | null) ?? [];
    const reasonCounts: Record<string, number> = {};
    for (const r of skipRows) {
      const reason = r.skip_reason ?? "unspecified";
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
    const skip_reasons = Object.entries(reasonCounts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason))
      .slice(0, SKIP_REASONS_LIMIT);

    // (2e) time_series — pivot (day, state, count) rows into one
    //      object per day with one field per state-series. Days appear
    //      in ASC order (RPC's ORDER BY day ASC). The pivot intentionally
    //      ignores unknown states (allowlist via TIME_SERIES_STATES).
    type RawTsRow = { day: string; state: string; count: number | string };
    const tsRows = (rpcResp.data as RawTsRow[] | null) ?? [];
    const byDay = new Map<string, CampaignMetricsTimeSeriesRow>();
    for (const r of tsRows) {
      const dayStr = typeof r.day === "string" ? r.day : new Date(r.day).toISOString().slice(0, 10);
      const cnt = typeof r.count === "number" ? r.count : parseInt(String(r.count), 10) || 0;
      let row = byDay.get(dayStr);
      if (!row) {
        row = { date: dayStr, scheduled: 0, succeeded: 0, failed: 0, voicemail: 0, skipped: 0 };
        byDay.set(dayStr, row);
      }
      if ((TIME_SERIES_STATES as readonly string[]).includes(r.state)) {
        row[r.state as TimeSeriesState] = cnt;
      }
    }
    const time_series = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));

    return {
      ok: true,
      metrics: {
        campaign_id: campaignId,
        counters,
        rates,
        time_series,
        skip_reasons,
        state_distribution,
      },
    };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

// ── Route registrations ─────────────────────────────────────────────

router.get(
  "/business/campaigns",
  requireAuth,
  requirePermission("calls", "read"),
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
    const result = await handleListCampaigns(supabase, businessId, {
      offset: req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : undefined,
      limit: req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      objective: typeof req.query.objective === "string" ? req.query.objective : undefined,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ campaigns: result.campaigns, total: result.total });
  },
);

// POST /preview MUST be registered BEFORE the GET /:id route so the
// path "preview" isn't interpreted as a campaign id.
router.post(
  "/business/campaigns/preview",
  requireAuth,
  requirePermission("calls", "read"),
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
    const body = (req.body || {}) as { segment_definition?: unknown; schedule_definition?: unknown };
    const result = await handlePreviewCampaign(supabase, businessId, body);
    // 200 always — parse/runtime errors come back inline so the live-
    // preview dashboard component can render them as the user types.
    res.json(result);
  },
);

router.post(
  "/business/campaigns",
  requireAuth,
  requirePermission("calls", "write"),
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
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = parseCreateBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handleCreateCampaign(supabase, businessId, userId, parsed);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json({ campaign: result.campaign });
  },
);

router.get(
  "/business/campaigns/:id",
  requireAuth,
  requirePermission("calls", "read"),
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
    const campaignId = String(req.params.id);
    const result = await handleGetCampaign(supabase, businessId, campaignId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ campaign: result.campaign });
  },
);

router.patch(
  "/business/campaigns/:id",
  requireAuth,
  requirePermission("calls", "write"),
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
    const campaignId = String(req.params.id);
    const parsed = parsePatchBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handlePatchCampaign(supabase, businessId, campaignId, parsed);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ campaign: result.campaign });
  },
);

router.delete(
  "/business/campaigns/:id",
  requireAuth,
  requirePermission("calls", "write"),
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
    const campaignId = String(req.params.id);
    const result = await handleDeleteCampaign(supabase, businessId, campaignId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      success: true,
      canceled_call_count: result.canceled_call_count,
      deleted_junction_count: result.deleted_junction_count,
    });
  },
);

router.get(
  "/business/campaigns/:id/leads",
  requireAuth,
  requirePermission("calls", "read"),
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
    const campaignId = String(req.params.id);
    const result = await handleGetCampaignLeads(supabase, businessId, campaignId, {
      offset: req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : undefined,
      limit: req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : undefined,
      state: typeof req.query.state === "string" ? req.query.state : undefined,
      skip_reason: typeof req.query.skip_reason === "string" ? req.query.skip_reason : undefined,
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ rows: result.rows, total: result.total });
  },
);

// Phase 2.7a: GET /:id/metrics — aggregated counters, rates, time
// series, and skip-reason pareto for the campaign. Tenant-scoped via
// handleGetCampaignMetrics's ownership check; cross-tenant returns
// 404 the same as the other detail routes.
router.get(
  "/business/campaigns/:id/metrics",
  requireAuth,
  requirePermission("calls", "read"),
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
    const campaignId = String(req.params.id);
    const result = await handleGetCampaignMetrics(supabase, businessId, campaignId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ metrics: result.metrics });
  },
);

export default router;
