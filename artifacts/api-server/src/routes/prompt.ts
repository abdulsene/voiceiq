/**
 * Sprint 3 Stage 4 — prompt editing API endpoints.
 *
 * Six endpoints for the customer prompt-editing feature:
 *   - GET    /api/business/prompt                          owner: read state
 *   - PATCH  /api/business/prompt                          owner: raw save + sync
 *   - PATCH  /api/business/prompt/helpers                  owner: soft-field updates
 *   - POST   /api/business/prompt/regenerate               owner: re-render + sync
 *   - PATCH  /api/admin/business/:businessId/prompt        admin: cross-tenant save + sync
 *   - GET    /api/admin/business/:businessId/prompt/audit  admin: per-business history
 *
 * Auth: customer endpoints use requireAuth + requirePermission("settings", *).
 * Admin endpoints use requireAuth + requireStaffPermission("customers", *)
 * from staff-rbac.ts — verifies the caller's staff role from user_roles,
 * NOT the per-tenant `req.isAdmin` flag (which would let any business
 * owner cross-tenant via /admin/business/:businessId/*).
 *
 * Sync model: synchronous PATCH to ElevenLabs via lib/elevenlabs-agent.ts
 * with verify-after-write. If DB persists but ElevenLabs sync fails, the
 * endpoint returns 200 with { ok:false, savedToDb:true, syncError } so
 * the customer's edit is durable and they can retry from the UI.
 *
 * Audit: every successful or failed write produces exactly one row in
 * prompt_audit_log (migration 021). Helper-field PATCH does NOT audit
 * (intermediate state, not a prompt change).
 *
 * Testability: each handler delegates to a perform* internal function
 * that takes an explicit SupabaseClient. Tests stub the supabase via
 * the helper mock from src/tests/helpers and mock the elevenlabs-agent
 * module via vi.mock — no supertest needed.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";

import { renderPromptFromHelpers } from "../lib/prompt-renderer";
import { updateAgentPrompt, type UpdateAgentResult } from "../lib/elevenlabs-agent";
import { fetchIndustryTemplate, fetchObjectionHandlers } from "./api";

// ───────────────────────────────────────────────────────────────────────
// Constants

const PROMPT_MIN_LENGTH = 1;
const PROMPT_MAX_LENGTH = 50_000;
const AUDIT_LIMIT_DEFAULT = 20;
const AUDIT_LIMIT_MAX = 100;

/**
 * Allowlist for PATCH /helpers body keys. Scoped to soft-tuning fields
 * only — identity / contact fields (business_name, phone_number,
 * languages, etc.) have their own update flow (see auth.ts:394).
 */
const HELPER_FIELD_ALLOWLIST = [
  "custom_faqs",
  "never_say_list",
  "objection_handling",
  "tone_preference",
  "after_hours_message",
  "tone",
] as const;

type HelperFieldKey = (typeof HELPER_FIELD_ALLOWLIST)[number];

// ───────────────────────────────────────────────────────────────────────
// Supabase client — lazy singleton + test override hook

let _supabase: SupabaseClient | null = null;

function defaultGetSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

let _supabaseOverride: SupabaseClient | null | undefined = undefined;
/** @internal exported for tests */
export function _setSupabaseClientForTests(client: SupabaseClient | null | undefined): void {
  _supabaseOverride = client;
}
function getSupabase(): SupabaseClient | null {
  if (_supabaseOverride !== undefined) return _supabaseOverride;
  return defaultGetSupabase();
}

// ───────────────────────────────────────────────────────────────────────
// Admin endpoints are gated by `requireStaffPermission("customers", ...)`
// from staff-rbac.ts. The previous local `requireAdminRole` helper only
// checked `req.isAdmin` (per-tenant owner/admin role) and was deleted in
// the security hotfix that landed alongside this comment.
// ───────────────────────────────────────────────────────────────────────
// Helper validation

interface HelpersValidationResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

/**
 * Validate a PATCH /helpers body. Returns the payload object (mapping
 * directly to business_configs columns) or an error string.
 *
 * Rejects:
 *   - any key not in HELPER_FIELD_ALLOWLIST (anti-mass-assignment)
 *   - malformed shapes (e.g. non-array custom_faqs)
 *   - oversized strings / arrays
 */
function validateHelpersBody(body: unknown): HelpersValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  const keys = Object.keys(raw);

  if (keys.length === 0) {
    return { ok: false, error: "Body must contain at least one helper field" };
  }

  // Reject unknown keys before doing any per-field validation.
  const unknownKeys = keys.filter(
    (k) => !(HELPER_FIELD_ALLOWLIST as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `Unknown helper field(s): ${unknownKeys.join(", ")}. Allowed: ${HELPER_FIELD_ALLOWLIST.join(", ")}`,
    };
  }

  const payload: Record<string, unknown> = {};

  for (const key of keys as HelperFieldKey[]) {
    const value = raw[key];

    switch (key) {
      case "custom_faqs": {
        if (!Array.isArray(value)) {
          return { ok: false, error: "custom_faqs must be an array" };
        }
        if (value.length > 50) {
          return { ok: false, error: "custom_faqs may have at most 50 entries" };
        }
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as { question?: unknown; answer?: unknown };
          if (
            !item ||
            typeof item.question !== "string" ||
            typeof item.answer !== "string" ||
            item.question.trim().length === 0 ||
            item.answer.trim().length === 0
          ) {
            return {
              ok: false,
              error: `custom_faqs[${i}] must be { question, answer } with non-empty strings`,
            };
          }
        }
        payload.custom_faqs = value;
        break;
      }
      case "never_say_list": {
        if (!Array.isArray(value)) {
          return { ok: false, error: "never_say_list must be an array" };
        }
        if (value.length > 100) {
          return { ok: false, error: "never_say_list may have at most 100 entries" };
        }
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] !== "string" || (value[i] as string).trim().length === 0) {
            return {
              ok: false,
              error: `never_say_list[${i}] must be a non-empty string`,
            };
          }
        }
        payload.never_say_list = value;
        break;
      }
      case "objection_handling": {
        if (!Array.isArray(value)) {
          return { ok: false, error: "objection_handling must be an array" };
        }
        if (value.length > 50) {
          return { ok: false, error: "objection_handling may have at most 50 entries" };
        }
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as { objection?: unknown; response?: unknown };
          if (
            !item ||
            typeof item.objection !== "string" ||
            typeof item.response !== "string" ||
            item.objection.trim().length === 0 ||
            item.response.trim().length === 0
          ) {
            return {
              ok: false,
              error: `objection_handling[${i}] must be { objection, response } with non-empty strings`,
            };
          }
        }
        payload.objection_handling = value;
        break;
      }
      case "tone_preference": {
        if (typeof value !== "string") {
          return { ok: false, error: "tone_preference must be a string" };
        }
        if (value.length > 500) {
          return { ok: false, error: "tone_preference may not exceed 500 characters" };
        }
        payload.tone_preference = value;
        break;
      }
      case "after_hours_message": {
        if (typeof value !== "string") {
          return { ok: false, error: "after_hours_message must be a string" };
        }
        if (value.length > 1000) {
          return {
            ok: false,
            error: "after_hours_message may not exceed 1000 characters",
          };
        }
        payload.after_hours_message = value;
        break;
      }
      case "tone": {
        if (typeof value !== "string" || value.length === 0 || value.length > 64) {
          return { ok: false, error: "tone must be a non-empty string up to 64 characters" };
        }
        payload.tone = value;
        break;
      }
    }
  }

  return { ok: true, payload };
}

// ───────────────────────────────────────────────────────────────────────
// Shared types for the save/sync flow

interface BusinessConfigForSync {
  agent_id: string | null;
  system_prompt: string | null;
}

/**
 * Look up the minimum business_configs columns needed before a save.
 * Returns null if the row doesn't exist.
 */
async function readBusinessForSave(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessConfigForSync | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select("agent_id, system_prompt")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`business_configs read failed: ${error.message}`);
  return (data ?? null) as BusinessConfigForSync | null;
}

interface SaveSyncCtx {
  supabase: SupabaseClient;
  businessId: string;
  userId: string;
  agentId: string;
  oldPrompt: string | null;
  newPrompt: string;
  source: "owner_raw" | "owner_helpers_regen" | "admin_raw";
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * If true, also clear prompt_helpers_dirty_at on the business_configs
   * row. Set for owner_raw (the customer accepted the current
   * helpers state) and owner_helpers_regen (regen IS the dirty clear).
   * Unset for admin_raw, which doesn't touch the helpers signal.
   */
  clearHelpersDirty: boolean;
}

interface SaveSyncSuccess {
  ok: true;
  charsWritten: number;
  syncedAt: string;
  auditLogId: string | null;
}

interface SaveSyncFailure {
  ok: false;
  savedToDb: true;
  syncError: string;
  auditLogId: string | null;
}

type SaveSyncResult = SaveSyncSuccess | SaveSyncFailure;

/**
 * Persist the prompt + call ElevenLabs + write audit log + update
 * sync-state columns. Used by PATCH /business/prompt,
 * POST /business/prompt/regenerate, and PATCH /admin/.../prompt.
 *
 * Order of operations:
 *   1. UPDATE business_configs (system_prompt, prompt_updated_at,
 *      prompt_updated_by, optionally prompt_helpers_dirty_at = NULL)
 *   2. Call updateAgentPrompt(agentId, 'en', newPrompt)
 *   3. INSERT prompt_audit_log row capturing both DB and sync outcome
 *   4. UPDATE business_configs sync-state columns
 *      (prompt_last_synced_at on success, prompt_sync_error on failure)
 *
 * Throws on DB step 1 failure (returned as 500 by callers). All other
 * failures return the structured SaveSyncResult.
 */
async function performSaveAndSync(ctx: SaveSyncCtx): Promise<SaveSyncResult> {
  const nowIso = new Date().toISOString();

  // Step 1: persist the prompt + bookkeeping.
  const dbUpdate: Record<string, unknown> = {
    system_prompt: ctx.newPrompt,
    prompt_updated_at: nowIso,
    prompt_updated_by: ctx.userId,
  };
  if (ctx.clearHelpersDirty) {
    dbUpdate.prompt_helpers_dirty_at = null;
  }
  const { error: updErr } = await ctx.supabase
    .from("business_configs")
    .update(dbUpdate)
    .eq("business_id", ctx.businessId);
  if (updErr) {
    throw new Error(`business_configs update failed: ${updErr.message}`);
  }

  // Step 2: push to ElevenLabs.
  const syncResult: UpdateAgentResult = await updateAgentPrompt(
    ctx.agentId,
    "en",
    ctx.newPrompt,
  );

  // Step 3: write the audit row. Best-effort — we return the auditLogId
  // when available, null when the insert failed (logged).
  let auditLogId: string | null = null;
  const auditPayload = {
    business_id: ctx.businessId,
    changed_by_user_id: ctx.userId,
    language: "en",
    source: ctx.source,
    old_prompt: ctx.oldPrompt,
    new_prompt: ctx.newPrompt,
    sync_to_elevenlabs_ok: syncResult.ok,
    elevenlabs_error: syncResult.ok ? null : syncResult.error,
    ip_address: ctx.ipAddress,
    user_agent: ctx.userAgent,
  };
  try {
    const { data: inserted, error: auditErr } = await ctx.supabase
      .from("prompt_audit_log")
      .insert(auditPayload)
      .select("id")
      .maybeSingle();
    if (auditErr) {
      console.error(
        `[prompt] audit log insert failed for ${ctx.businessId}: ${auditErr.message}`,
      );
    } else if (inserted && typeof (inserted as { id?: unknown }).id === "string") {
      auditLogId = (inserted as { id: string }).id;
    }
  } catch (err: any) {
    console.error(
      `[prompt] audit log insert exception for ${ctx.businessId}: ${err?.message ?? err}`,
    );
  }

  // Step 4: update sync-state columns.
  const syncStateUpdate: Record<string, unknown> = syncResult.ok
    ? { prompt_last_synced_at: nowIso, prompt_sync_error: null }
    : { prompt_sync_error: syncResult.error };
  const { error: syncStateErr } = await ctx.supabase
    .from("business_configs")
    .update(syncStateUpdate)
    .eq("business_id", ctx.businessId);
  if (syncStateErr) {
    // Non-fatal: prompt is persisted, audit row exists. Log loudly.
    console.error(
      `[prompt] sync-state update failed for ${ctx.businessId}: ${syncStateErr.message}`,
    );
  }

  if (syncResult.ok) {
    return {
      ok: true,
      charsWritten: syncResult.charsWritten,
      syncedAt: nowIso,
      auditLogId,
    };
  }
  return {
    ok: false,
    savedToDb: true,
    syncError: syncResult.error,
    auditLogId,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Shared helpers used by BOTH customer and admin variants of the
// prompt endpoints. The customer endpoints use req.businessId; the
// admin endpoints use req.params.businessId. Auth-scope is the only
// real difference; the data plumbing is identical.

/** Column list shared by GET /business/prompt + GET /admin/business/:id/prompt. */
const PROMPT_STATE_COLUMNS =
  "business_id, business_name, industry, business_hours, timezone, " +
  "owner_name, services, website, phone_number, languages, " +
  "spanish_enabled, french_enabled, custom_faqs, objection_handling, " +
  "tone_preference, never_say_list, tone, after_hours_message, " +
  "agent_id, system_prompt, prompt_updated_at, prompt_updated_by, " +
  "prompt_last_synced_at, prompt_sync_error, prompt_helpers_dirty_at";

/**
 * Load the full prompt-state row for a business. Returns `null` when
 * the business doesn't exist. Throws on DB errors so callers can
 * 500-out with a consistent message.
 */
async function loadPromptState(
  supabase: SupabaseClient,
  businessId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select(PROMPT_STATE_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    throw new Error(`business_configs read failed: ${error.message}`);
  }
  return (data as Record<string, unknown> | null) ?? null;
}

interface HelpersUpdateCtx {
  supabase: SupabaseClient;
  businessId: string;
  /** The validated helpers payload from validateHelpersBody. */
  payload: Record<string, unknown>;
  /**
   * When set, write an audit row attributing the change. The customer
   * helpers PATCH leaves this unset (no audit, since /regenerate is
   * what actually changes the rendered prompt + writes its own audit).
   * The admin helpers PATCH sets it to 'admin_raw' with the staff
   * caller's userId — admin operations always need attribution.
   */
  audit?: {
    source: "admin_raw";
    userId: string;
    ipAddress: string | null;
    userAgent: string | null;
  };
}

interface HelpersUpdateResult {
  ok: true;
  updated: string[];
  dirty_at: string;
}

/**
 * Persist a helpers update + (optionally) write an audit row. Shared
 * between customer PATCH /business/prompt/helpers (no audit) and
 * admin PATCH /admin/business/:id/prompt/helpers (audit with
 * source='admin_raw').
 *
 * For the admin audit row the old_prompt sentinel + JSON-serialized
 * payload give the History Inspect dialog forensic context. Per the
 * Phase 3A decision: no new audit-source value, no new migration —
 * label as 'admin_raw' so the existing CHECK constraint accepts it.
 */
async function performHelpersUpdate(
  ctx: HelpersUpdateCtx,
): Promise<HelpersUpdateResult> {
  const nowIso = new Date().toISOString();
  const update = { ...ctx.payload, prompt_helpers_dirty_at: nowIso };
  const { error: updErr } = await ctx.supabase
    .from("business_configs")
    .update(update)
    .eq("business_id", ctx.businessId);
  if (updErr) {
    throw new Error(`business_configs update failed: ${updErr.message}`);
  }

  if (ctx.audit) {
    // 2000-char truncation guards against an outsized custom_faqs blob
    // overflowing the prompt_audit_log new_prompt column in pathological
    // cases. The full state is recoverable from business_configs anyway;
    // the audit row's job is just attribution + forensic outline.
    const payloadJson = JSON.stringify(ctx.payload);
    const newPromptForAudit =
      payloadJson.length > 2000
        ? `${payloadJson.slice(0, 1997)}...`
        : payloadJson;
    const { error: auditErr } = await ctx.supabase
      .from("prompt_audit_log")
      .insert({
        business_id: ctx.businessId,
        changed_by_user_id: ctx.audit.userId,
        language: "en",
        source: ctx.audit.source,
        old_prompt: "(helpers state pre-edit)",
        new_prompt: newPromptForAudit,
        sync_to_elevenlabs_ok: true,
        elevenlabs_error: null,
        ip_address: ctx.audit.ipAddress,
        user_agent: ctx.audit.userAgent,
      });
    if (auditErr) {
      // Non-fatal: the helpers update is already persisted. Log
      // loudly so ops can backfill the audit row if it ever matters.
      console.error(
        `[prompt:helpers-audit] insert failed for ${ctx.businessId}: ${auditErr.message}`,
      );
    }
  }

  return {
    ok: true,
    updated: Object.keys(ctx.payload),
    dirty_at: nowIso,
  };
}

interface RegenerateCtx {
  supabase: SupabaseClient;
  businessId: string;
  userId: string;
  source: "owner_helpers_regen" | "admin_raw";
  ipAddress: string | null;
  userAgent: string | null;
}

type RegenerateResult =
  | SaveSyncResult
  | { ok: false; status: 404 | 409; error: string };

/**
 * Read the full business_configs row, render the helpers via the
 * pure prompt-renderer, then call performSaveAndSync. Used by both
 * customer POST /business/prompt/regenerate AND admin POST
 * /admin/business/:id/prompt/regenerate — the only difference is
 * the audit `source` and which userId attributes the change.
 *
 * Returns a discriminated union so callers can map 404 / 409 to
 * specific HTTP codes without leaking the underlying shape.
 */
async function performRegenerate(
  ctx: RegenerateCtx,
): Promise<RegenerateResult> {
  const { data: cfg, error: cfgErr } = await ctx.supabase
    .from("business_configs")
    .select(
      "business_id, business_name, industry, business_hours, timezone, owner_name, services, website, phone_number, languages, spanish_enabled, french_enabled, custom_faqs, objection_handling, tone_preference, never_say_list, website_context_text, agent_id, system_prompt",
    )
    .eq("business_id", ctx.businessId)
    .maybeSingle();
  if (cfgErr) {
    throw new Error(`business_configs read failed: ${cfgErr.message}`);
  }
  if (!cfg) {
    return { ok: false, status: 404, error: "Business not found" };
  }
  const cfgRow = cfg as Record<string, any>;
  if (!cfgRow.agent_id) {
    return {
      ok: false,
      status: 409,
      error: "Business has no ElevenLabs agent configured; cannot sync",
    };
  }
  if (!cfgRow.business_name || !cfgRow.industry || !cfgRow.business_hours) {
    return {
      ok: false,
      status: 409,
      error:
        "Business is missing required fields (business_name, industry, business_hours) — complete onboarding before regenerating",
    };
  }

  const industryTemplate = await fetchIndustryTemplate(cfgRow.industry);
  const objectionHandlersFromTable = await fetchObjectionHandlers(
    ctx.businessId,
  );

  const newPrompt = renderPromptFromHelpers({
    business_name: cfgRow.business_name,
    industry: cfgRow.industry,
    business_hours: cfgRow.business_hours,
    timezone: cfgRow.timezone || "America/New_York",
    owner_name: cfgRow.owner_name ?? undefined,
    services: cfgRow.services ?? undefined,
    website: cfgRow.website ?? undefined,
    phone_number: cfgRow.phone_number ?? undefined,
    languages: Array.isArray(cfgRow.languages) ? cfgRow.languages : undefined,
    spanish_enabled: !!cfgRow.spanish_enabled,
    french_enabled: !!cfgRow.french_enabled,
    industryTemplate,
    websiteContext: cfgRow.website_context_text ?? null,
    customFaqs: Array.isArray(cfgRow.custom_faqs) ? cfgRow.custom_faqs : null,
    objectionHandling: Array.isArray(cfgRow.objection_handling)
      ? cfgRow.objection_handling
      : null,
    objectionHandlersFromTable,
    tonePreference: cfgRow.tone_preference ?? null,
    neverSayList: Array.isArray(cfgRow.never_say_list)
      ? cfgRow.never_say_list
      : null,
  });

  return performSaveAndSync({
    supabase: ctx.supabase,
    businessId: ctx.businessId,
    userId: ctx.userId,
    agentId: cfgRow.agent_id,
    oldPrompt: cfgRow.system_prompt ?? null,
    newPrompt,
    source: ctx.source,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    clearHelpersDirty: true,
  });
}

// ───────────────────────────────────────────────────────────────────────
// Router

const router: IRouter = Router();

// ── GET /api/business/prompt ───────────────────────────────────────────

router.get(
  "/business/prompt",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const businessId = req.businessId;
      if (!businessId) {
        return res.status(400).json({ error: "No active business" });
      }

      const data = await loadPromptState(supabase, businessId);
      if (!data) return res.status(404).json({ error: "Business not found" });
      return res.json(data);
    } catch (e: any) {
      console.error("[prompt:GET] unexpected:", e?.message ?? e);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── PATCH /api/business/prompt ────────────────────────────────────────

router.patch(
  "/business/prompt",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const businessId = req.businessId;
      const userId = req.userId;
      if (!businessId || !userId) {
        return res.status(400).json({ error: "No active business" });
      }

      const body = (req.body || {}) as { system_prompt?: unknown };
      const newPrompt = body.system_prompt;
      if (typeof newPrompt !== "string") {
        return res.status(400).json({ error: "system_prompt must be a string" });
      }
      if (newPrompt.length < PROMPT_MIN_LENGTH || newPrompt.length > PROMPT_MAX_LENGTH) {
        return res.status(400).json({
          error: `system_prompt must be between ${PROMPT_MIN_LENGTH} and ${PROMPT_MAX_LENGTH} characters`,
        });
      }

      const business = await readBusinessForSave(supabase, businessId);
      if (!business) return res.status(404).json({ error: "Business not found" });
      if (!business.agent_id) {
        return res.status(409).json({
          error: "Business has no ElevenLabs agent configured; cannot sync",
        });
      }

      const result = await performSaveAndSync({
        supabase,
        businessId,
        userId,
        agentId: business.agent_id,
        oldPrompt: business.system_prompt,
        newPrompt,
        source: "owner_raw",
        ipAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
        clearHelpersDirty: true,
      });
      return res.json(result);
    } catch (e: any) {
      console.error("[prompt:PATCH raw] error:", e?.message ?? e);
      return res.status(500).json({
        error: "Failed to save prompt",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── PATCH /api/business/prompt/helpers ────────────────────────────────

router.patch(
  "/business/prompt/helpers",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const businessId = req.businessId;
      if (!businessId) return res.status(400).json({ error: "No active business" });

      const validation = validateHelpersBody(req.body);
      if (!validation.ok || !validation.payload) {
        return res.status(400).json({ error: validation.error });
      }

      // Customer helpers PATCH is intermediate state — no audit row.
      // The audit happens at POST /regenerate via performSaveAndSync.
      const result = await performHelpersUpdate({
        supabase,
        businessId,
        payload: validation.payload,
      });
      return res.json(result);
    } catch (e: any) {
      console.error("[prompt:PATCH helpers] unexpected:", e?.message ?? e);
      return res.status(500).json({
        error: "Failed to save helper fields",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── POST /api/business/prompt/regenerate ──────────────────────────────

router.post(
  "/business/prompt/regenerate",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const businessId = req.businessId;
      const userId = req.userId;
      if (!businessId || !userId) {
        return res.status(400).json({ error: "No active business" });
      }

      const result = await performRegenerate({
        supabase,
        businessId,
        userId,
        source: "owner_helpers_regen",
        ipAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      if ("status" in result && result.status) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.json(result);
    } catch (e: any) {
      console.error("[prompt:regenerate] error:", e?.message ?? e);
      return res.status(500).json({
        error: "Failed to regenerate prompt",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── GET /api/business/prompt/audit ────────────────────────────────────

router.get(
  "/business/prompt/audit",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const businessId = req.businessId;
      if (!businessId) {
        return res.status(400).json({ error: "No active business" });
      }

      // Customer-facing cap is tighter than the admin endpoint's 100.
      // The dashboard's HistoryViewer paginates 20 at a time; allowing
      // up to 50 covers power-user "load more" without inviting full
      // table scrapes via ?limit=1000.
      const CUSTOMER_AUDIT_LIMIT_MAX = 50;
      const parsedLimit = parseInt(String(req.query.limit ?? AUDIT_LIMIT_DEFAULT), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(CUSTOMER_AUDIT_LIMIT_MAX, parsedLimit))
        : AUDIT_LIMIT_DEFAULT;
      const parsedOffset = parseInt(String(req.query.offset ?? 0), 10);
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

      // ip_address is intentionally NOT selected — exposing a
      // teammate's IP through the customer-facing surface is a leak.
      // The admin endpoint below still includes it for incident
      // response. user_agent IS kept so the dashboard's diff dialog
      // can distinguish backfill scripts ("backfill-*.ts") from
      // browser writes.
      const { data, error, count } = await supabase
        .from("prompt_audit_log")
        .select(
          "id, changed_by_user_id, changed_at, language, source, old_prompt, new_prompt, sync_to_elevenlabs_ok, elevenlabs_error, user_agent",
          { count: "exact" },
        )
        .eq("business_id", businessId)
        .order("changed_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) {
        console.error(
          "[prompt:audit:customer] read error:",
          error.message,
        );
        return res.status(500).json({ error: "Failed to load audit history" });
      }

      return res.json({
        business_id: businessId,
        limit,
        offset,
        total: count ?? 0,
        rows: data ?? [],
      });
    } catch (e: any) {
      console.error("[prompt:audit:customer] unexpected:", e?.message ?? e);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── PATCH /api/admin/business/:businessId/prompt ──────────────────────

// ── GET /api/admin/business/:businessId/prompt ────────────────────────
// Admin parity for the customer GET. Same flat row shape, scoped to
// the path param business_id (not req.businessId, which is the staff
// caller's active tenant).

router.get(
  "/admin/business/:businessId/prompt",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const targetBusinessId = String(req.params.businessId);
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res
          .status(400)
          .json({ error: "businessId path param required" });
      }
      const data = await loadPromptState(supabase, targetBusinessId);
      if (!data) return res.status(404).json({ error: "Business not found" });
      return res.json(data);
    } catch (e: any) {
      console.error("[prompt:GET admin] unexpected:", e?.message ?? e);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── PATCH /api/admin/business/:businessId/prompt/helpers ──────────────
// Admin parity for the customer helpers PATCH, with the asymmetry
// that admin writes a forensic audit row (source='admin_raw') so the
// HistoryViewer can attribute the change to the staff caller.

router.patch(
  "/admin/business/:businessId/prompt/helpers",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Auth context missing" });
      }
      const targetBusinessId = String(req.params.businessId);
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res
          .status(400)
          .json({ error: "businessId path param required" });
      }

      const validation = validateHelpersBody(req.body);
      if (!validation.ok || !validation.payload) {
        return res.status(400).json({ error: validation.error });
      }

      const result = await performHelpersUpdate({
        supabase,
        businessId: targetBusinessId,
        payload: validation.payload,
        audit: {
          source: "admin_raw",
          userId,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers["user-agent"] as string) ?? null,
        },
      });
      return res.json(result);
    } catch (e: any) {
      console.error(
        "[prompt:PATCH admin helpers] unexpected:",
        e?.message ?? e,
      );
      return res.status(500).json({
        error: "Failed to save helper fields",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── POST /api/admin/business/:businessId/prompt/regenerate ────────────
// Admin parity for the customer regenerate. Reuses performRegenerate
// with source='admin_raw' so the audit row attributes the change to
// the staff caller (req.userId) rather than the business owner.

router.post(
  "/admin/business/:businessId/prompt/regenerate",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Auth context missing" });
      }
      const targetBusinessId = String(req.params.businessId);
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res
          .status(400)
          .json({ error: "businessId path param required" });
      }

      const result = await performRegenerate({
        supabase,
        businessId: targetBusinessId,
        userId,
        source: "admin_raw",
        ipAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
      });
      if ("status" in result && result.status) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.json(result);
    } catch (e: any) {
      console.error(
        "[prompt:regenerate admin] error:",
        e?.message ?? e,
      );
      return res.status(500).json({
        error: "Failed to regenerate prompt",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── PATCH /api/admin/business/:businessId/prompt ──────────────────────

router.patch(
  "/admin/business/:businessId/prompt",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Auth context missing" });
      }
      const targetBusinessId = String(req.params.businessId);
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res.status(400).json({ error: "businessId path param required" });
      }

      const body = (req.body || {}) as { system_prompt?: unknown };
      const newPrompt = body.system_prompt;
      if (typeof newPrompt !== "string") {
        return res.status(400).json({ error: "system_prompt must be a string" });
      }
      if (newPrompt.length < PROMPT_MIN_LENGTH || newPrompt.length > PROMPT_MAX_LENGTH) {
        return res.status(400).json({
          error: `system_prompt must be between ${PROMPT_MIN_LENGTH} and ${PROMPT_MAX_LENGTH} characters`,
        });
      }

      const business = await readBusinessForSave(supabase, targetBusinessId);
      if (!business) return res.status(404).json({ error: "Business not found" });
      if (!business.agent_id) {
        return res.status(409).json({
          error: "Business has no ElevenLabs agent configured; cannot sync",
        });
      }

      const result = await performSaveAndSync({
        supabase,
        businessId: targetBusinessId,
        userId,
        agentId: business.agent_id,
        oldPrompt: business.system_prompt,
        newPrompt,
        source: "admin_raw",
        ipAddress: req.ip ?? null,
        userAgent: (req.headers["user-agent"] as string) ?? null,
        clearHelpersDirty: false,
      });
      return res.json(result);
    } catch (e: any) {
      console.error("[prompt:PATCH admin] error:", e?.message ?? e);
      return res.status(500).json({
        error: "Failed to save prompt",
        details: e?.message ?? String(e),
      });
    }
  },
);

// ── GET /api/admin/business/:businessId/prompt/audit ──────────────────

router.get(
  "/admin/business/:businessId/prompt/audit",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const targetBusinessId = String(req.params.businessId);
      if (!targetBusinessId || targetBusinessId === "undefined") {
        return res.status(400).json({ error: "businessId path param required" });
      }

      const parsedLimit = parseInt(String(req.query.limit ?? AUDIT_LIMIT_DEFAULT), 10);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(AUDIT_LIMIT_MAX, parsedLimit))
        : AUDIT_LIMIT_DEFAULT;
      const parsedOffset = parseInt(String(req.query.offset ?? 0), 10);
      const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0;

      const { data, error } = await supabase
        .from("prompt_audit_log")
        .select(
          "id, business_id, changed_by_user_id, changed_at, language, source, old_prompt, new_prompt, sync_to_elevenlabs_ok, elevenlabs_error, ip_address, user_agent",
        )
        .eq("business_id", targetBusinessId)
        .order("changed_at", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) {
        console.error("[prompt:audit] read error:", error.message);
        return res.status(500).json({ error: "Failed to load audit history" });
      }

      return res.json({
        businessId: targetBusinessId,
        limit,
        offset,
        rows: data ?? [],
      });
    } catch (e: any) {
      console.error("[prompt:audit] unexpected:", e?.message ?? e);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

export default router;

// ───────────────────────────────────────────────────────────────────────
// Exports for unit tests (NOT consumed by production code).

/** @internal */
export { performSaveAndSync, validateHelpersBody };
