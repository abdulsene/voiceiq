/**
 * Stage 6 Phase 1 — admin override endpoints for /admin/businesses.
 *
 * Three endpoints, all gated by `requireStaffPermission("customers", ...)`
 * from staff-rbac (the post-hotfix gate; see commit aaf14de):
 *
 *   GET   /api/admin/businesses              list with filters/search/sort
 *   GET   /api/admin/business/:businessId    combined business + prompt + voice
 *   PATCH /api/admin/business/:businessId/voice   admin voice switch
 *
 * Design choices worth knowing:
 *
 * - Separate file (not folded into admin.ts) for isolation: admin.ts is
 *   7000+ lines and tangled. The Stage 6 admin override UI is a focused
 *   surface; keeping its endpoints in their own file makes the test
 *   harness small and the route ownership obvious.
 *
 * - Helper field names match the DB columns exactly (`never_say_list`,
 *   `objection_handling`) instead of the prettier `never_say` /
 *   `common_objections` from the Phase 1 spec. Reason: the customer
 *   GET /api/business/prompt already returns these under the DB names,
 *   and Phase 3 will refactor PromptEditor to switch URLs via an
 *   `apiBase` prop. Identical field names mean zero adapter layer.
 *
 * - Owner email enrichment: user_businesses (role='owner', ordered by
 *   created_at ASC) → user_id → auth.users.email via
 *   `supabase.auth.admin.listUsers` for the list endpoint (batch) or
 *   `getUserById` for the single endpoint. Pluggable via
 *   `_setUserEmailLookupForTests` so tests can stub without hitting
 *   the auth admin API.
 *
 * - Test-business exclusion (include_test=false, default) uses a
 *   heuristic on business_id + business_name, since there is no
 *   `is_test` flag in the schema. Heuristic locked in the Phase 1 spec:
 *     business_id LIKE 'demo_%' OR business_id = 'demo-business' OR
 *     business_name LIKE '[DEMO]%' OR business_name LIKE '[SALES DEMO]%' OR
 *     business_name LIKE 'Test %'
 *
 * - PATCH voice audit row sets:
 *     source = 'admin_voice_change'           (migration 025)
 *     changed_by_user_id = req.userId         (staff caller, NOT owner)
 *   The staff caller's identity is what makes admin overrides
 *   distinguishable in the audit log from owner-initiated voice_change
 *   rows.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { requireAuth } from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";
import { VOICE_CATALOG, type CatalogVoice } from "./voices";
import {
  updateAgentVoice,
  type UpdateVoiceResult,
} from "../lib/elevenlabs-agent";

// ───────────────────────────────────────────────────────────────────────
// Constants

const ADMIN_BUSINESSES_DEFAULT_LIMIT = 25;
const ADMIN_BUSINESSES_MAX_LIMIT = 100;

const SUMMARY_COLS =
  "business_id, business_name, plan_id, subscription_status, " +
  "agent_id, voice_id, voice_last_synced_at, voice_sync_error, " +
  "prompt_updated_at, prompt_sync_error, created_at";

/** Catalog-membership lookup. Rebuilt from VOICE_CATALOG so we don't
 *  have to export the internal VOICE_BY_ID from voices.ts. */
const VOICE_BY_ID = new Map<string, CatalogVoice>(
  VOICE_CATALOG.map((v) => [v.voice_id, v] as const),
);

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
export function _setSupabaseClientForTests(
  client: SupabaseClient | null | undefined,
): void {
  _supabaseOverride = client;
}
function getSupabase(): SupabaseClient | null {
  if (_supabaseOverride !== undefined) return _supabaseOverride;
  return defaultGetSupabase();
}

// ───────────────────────────────────────────────────────────────────────
// Owner-email enrichment — pluggable for tests

type UserEmailLookup = (
  userIds: readonly string[],
) => Promise<Record<string, string>>;

let _userEmailLookupOverride: UserEmailLookup | null = null;
/** @internal exported for tests */
export function _setUserEmailLookupForTests(
  fn: UserEmailLookup | null,
): void {
  _userEmailLookupOverride = fn;
}

/**
 * Map a set of user IDs to their auth.users.email. The default impl
 * calls supabase.auth.admin.listUsers (batched, page 1, perPage 1000)
 * — fine for the current ~50 owners across ~48 businesses. Tests
 * override via `_setUserEmailLookupForTests` to skip the auth admin
 * call entirely.
 *
 * On any failure we return an empty map (callers fall back to
 * owner_email = null per spec).
 */
async function lookupUserEmails(
  supabase: SupabaseClient,
  userIds: readonly string[],
): Promise<Record<string, string>> {
  if (_userEmailLookupOverride) return _userEmailLookupOverride(userIds);
  if (userIds.length === 0) return {};
  try {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });
    if (error) {
      console.warn("[admin-businesses] listUsers failed:", error.message);
      return {};
    }
    const wanted = new Set(userIds);
    const map: Record<string, string> = {};
    for (const u of data?.users ?? []) {
      if (wanted.has(u.id) && typeof u.email === "string") {
        map[u.id] = u.email;
      }
    }
    return map;
  } catch (err: any) {
    console.warn("[admin-businesses] listUsers threw:", err?.message ?? err);
    return {};
  }
}

// ───────────────────────────────────────────────────────────────────────
// Shared shape: BusinessSummary

interface BusinessSummaryRow {
  business_id: string;
  business_name: string | null;
  plan_id: string | null;
  subscription_status: string | null;
  agent_id: string | null;
  voice_id: string | null;
  voice_last_synced_at: string | null;
  voice_sync_error: string | null;
  prompt_updated_at: string | null;
  prompt_sync_error: string | null;
  created_at: string | null;
}

interface BusinessSummary extends BusinessSummaryRow {
  owner_email: string | null;
}

/**
 * Resolve owner emails for the given list of business_ids. Picks the
 * earliest-created `user_businesses` row with role='owner' per
 * business. Returns a `business_id → email | null` map.
 */
async function resolveOwnerEmails(
  supabase: SupabaseClient,
  businessIds: readonly string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const bid of businessIds) out[bid] = null;
  if (businessIds.length === 0) return out;

  const { data: links, error } = await supabase
    .from("user_businesses")
    .select("business_id, user_id, role, created_at")
    .in("business_id", businessIds as string[])
    .eq("role", "owner")
    .order("created_at", { ascending: true });
  if (error) {
    console.warn(
      "[admin-businesses] user_businesses read failed:",
      error.message,
    );
    return out;
  }

  // First-owner-wins per business (the .order ASC guarantees deterministic
  // pick when multiple owner rows exist).
  const businessToUser: Record<string, string> = {};
  for (const row of (links ?? []) as Array<{
    business_id: string;
    user_id: string;
  }>) {
    if (!businessToUser[row.business_id]) {
      businessToUser[row.business_id] = row.user_id;
    }
  }

  const userIds = Array.from(new Set(Object.values(businessToUser)));
  const emails = await lookupUserEmails(supabase, userIds);
  for (const [bid, uid] of Object.entries(businessToUser)) {
    out[bid] = emails[uid] ?? null;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// Single-business detail loader (used by GET endpoint 2 AND PATCH voice
// endpoint 3 — the latter calls this after the update to return the
// refreshed state in one round-trip).

interface BusinessDetail {
  business: BusinessSummary;
  prompt: {
    system_prompt: string | null;
    helpers: {
      tone_preference: string | null;
      custom_faqs: unknown;
      never_say_list: unknown;
      objection_handling: unknown;
      after_hours_message: string | null;
    };
    prompt_updated_at: string | null;
    prompt_sync_error: string | null;
  };
  voice: {
    voice_id: string | null;
    voice_last_synced_at: string | null;
    voice_sync_error: string | null;
  };
}

const DETAIL_COLS =
  SUMMARY_COLS +
  ", system_prompt, tone_preference, custom_faqs, never_say_list, " +
  "objection_handling, after_hours_message";

async function loadBusinessDetail(
  supabase: SupabaseClient,
  businessId: string,
): Promise<BusinessDetail | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select(DETAIL_COLS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    throw new Error(`business_configs read failed: ${error.message}`);
  }
  if (!data) return null;
  // Supabase JS's type inference for `.select(stringLiteral)` produces
  // a structural type that doesn't overlap with our hand-written row
  // shape — cast through unknown so the compiler trusts the assertion.
  const row = data as unknown as BusinessSummaryRow & {
    system_prompt: string | null;
    tone_preference: string | null;
    custom_faqs: unknown;
    never_say_list: unknown;
    objection_handling: unknown;
    after_hours_message: string | null;
  };

  const ownerEmails = await resolveOwnerEmails(supabase, [businessId]);

  return {
    business: {
      business_id: row.business_id,
      business_name: row.business_name,
      plan_id: row.plan_id,
      subscription_status: row.subscription_status,
      agent_id: row.agent_id,
      voice_id: row.voice_id,
      voice_last_synced_at: row.voice_last_synced_at,
      voice_sync_error: row.voice_sync_error,
      prompt_updated_at: row.prompt_updated_at,
      prompt_sync_error: row.prompt_sync_error,
      created_at: row.created_at,
      owner_email: ownerEmails[businessId] ?? null,
    },
    prompt: {
      system_prompt: row.system_prompt,
      helpers: {
        tone_preference: row.tone_preference,
        custom_faqs: row.custom_faqs,
        never_say_list: row.never_say_list,
        objection_handling: row.objection_handling,
        after_hours_message: row.after_hours_message,
      },
      prompt_updated_at: row.prompt_updated_at,
      prompt_sync_error: row.prompt_sync_error,
    },
    voice: {
      voice_id: row.voice_id,
      voice_last_synced_at: row.voice_last_synced_at,
      voice_sync_error: row.voice_sync_error,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Router

const router: IRouter = Router();

// ── GET /api/admin/businesses ─────────────────────────────────────────

router.get(
  "/admin/businesses",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    try {
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      // Parse + clamp pagination.
      const parsedLimit = parseInt(
        String(req.query.limit ?? ADMIN_BUSINESSES_DEFAULT_LIMIT),
        10,
      );
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(ADMIN_BUSINESSES_MAX_LIMIT, parsedLimit))
        : ADMIN_BUSINESSES_DEFAULT_LIMIT;
      const parsedOffset = parseInt(String(req.query.offset ?? 0), 10);
      const offset = Number.isFinite(parsedOffset)
        ? Math.max(0, parsedOffset)
        : 0;

      const sort =
        req.query.sort === "name" || req.query.sort === "plan"
          ? (req.query.sort as "name" | "plan")
          : "recent";
      const includeTest = req.query.include_test === "true";
      const hasSyncErrors = req.query.has_sync_errors === "true";
      const plan = req.query.plan ? String(req.query.plan) : null;
      const searchRaw = req.query.search ? String(req.query.search) : null;

      let query = supabase
        .from("business_configs")
        .select(SUMMARY_COLS, { count: "exact" });

      if (searchRaw) {
        // PostgREST's .or() syntax embeds the value in a filter string
        // parsed server-side. Sanitize against the filter-string special
        // chars (comma, parens) so an ill-formed search can't break out
        // of its column predicate.
        const safe = searchRaw.replace(/[,()]/g, "");
        if (safe.length > 0) {
          query = query.or(
            `business_name.ilike.%${safe}%,business_id.ilike.%${safe}%`,
          );
        }
      }

      if (plan) {
        query = query.eq("plan_id", plan);
      }

      if (hasSyncErrors) {
        query = query.or(
          "voice_sync_error.not.is.null,prompt_sync_error.not.is.null",
        );
      }

      if (!includeTest) {
        query = query
          .not("business_id", "like", "demo_%")
          .neq("business_id", "demo-business")
          .not("business_name", "like", "[DEMO]%")
          .not("business_name", "like", "[SALES DEMO]%")
          .not("business_name", "like", "Test %")
          // Lowercase placeholder names that the original "Test %"
          // heuristic missed. Exact-match on the LOWER() to catch
          // both "test" and "Test" while not falsely excluding
          // legitimate names that happen to contain "test".
          .not("business_name", "ilike", "test")
          .not("business_name", "ilike", "tes")
          .not("business_name", "ilike", "fdfds");
      }

      const orderCol =
        sort === "name"
          ? "business_name"
          : sort === "plan"
            ? "plan_id"
            : "created_at";
      const ascending = sort === "name" || sort === "plan";
      query = query.order(orderCol, { ascending });
      query = query.range(offset, offset + limit - 1);

      const { data, error, count } = await query;
      if (error) {
        console.error(
          "[admin-businesses:list] read error:",
          error.message,
        );
        return res
          .status(500)
          .json({ error: "Failed to load businesses" });
      }

      const rows = (data ?? []) as unknown as BusinessSummaryRow[];
      const businessIds = rows.map((r) => r.business_id);
      const ownerEmails = await resolveOwnerEmails(supabase, businessIds);

      const enriched: BusinessSummary[] = rows.map((r) => ({
        ...r,
        owner_email: ownerEmails[r.business_id] ?? null,
      }));

      return res.json({
        rows: enriched,
        total: count ?? enriched.length,
        limit,
        offset,
      });
    } catch (e: any) {
      console.error(
        "[admin-businesses:list] unexpected:",
        e?.message ?? e,
      );
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── GET /api/admin/business/:businessId/voice ──────────────────────────
// Mirrors the customer GET /business/voice shape EXACTLY so VoiceTab
// works via pure URL swap (apiBase prop). Same fields including
// catalog_match resolved server-side, same agent_id, same scoping
// pattern (path-param business_id, not req.businessId). Stage 6
// Phase 3B prerequisite for the admin drill-in's Voice tab.

router.get(
  "/admin/business/:businessId/voice",
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

      const { data, error } = await supabase
        .from("business_configs")
        .select(
          "business_id, voice_id, voice_last_synced_at, voice_sync_error, agent_id",
        )
        .eq("business_id", targetBusinessId)
        .maybeSingle();
      if (error) {
        console.error(
          "[admin-businesses:voice-get] read error:",
          error.message,
        );
        return res.status(500).json({ error: "Failed to load voice state" });
      }
      if (!data) return res.status(404).json({ error: "Business not found" });
      const row = data as {
        business_id: string;
        voice_id: string | null;
        voice_last_synced_at: string | null;
        voice_sync_error: string | null;
        agent_id: string | null;
      };
      const knownVoice = row.voice_id
        ? VOICE_BY_ID.get(row.voice_id) ?? null
        : null;
      return res.json({
        business_id: row.business_id,
        voice_id: row.voice_id,
        voice_last_synced_at: row.voice_last_synced_at,
        voice_sync_error: row.voice_sync_error,
        agent_id: row.agent_id,
        catalog_match: knownVoice,
      });
    } catch (e: any) {
      console.error(
        "[admin-businesses:voice-get] unexpected:",
        e?.message ?? e,
      );
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── GET /api/admin/business/:businessId ────────────────────────────────

router.get(
  "/admin/business/:businessId",
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

      const detail = await loadBusinessDetail(supabase, targetBusinessId);
      if (!detail) {
        return res.status(404).json({ error: "Business not found" });
      }
      return res.json(detail);
    } catch (e: any) {
      console.error(
        "[admin-businesses:single] unexpected:",
        e?.message ?? e,
      );
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── PATCH /api/admin/business/:businessId/voice ────────────────────────

router.patch(
  "/admin/business/:businessId/voice",
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

      const body = (req.body || {}) as { voice_id?: unknown };
      const newVoiceId = body.voice_id;
      if (typeof newVoiceId !== "string" || !VOICE_BY_ID.has(newVoiceId)) {
        return res.status(400).json({
          error: "voice_id is required and must be one of the catalog voices",
        });
      }

      // Look up agent_id + previous voice (audit needs the prior value).
      const { data: cfg, error: cfgErr } = await supabase
        .from("business_configs")
        .select("agent_id, voice_id")
        .eq("business_id", targetBusinessId)
        .maybeSingle();
      if (cfgErr) {
        console.error(
          "[admin-businesses:voice] config read error:",
          cfgErr.message,
        );
        return res.status(500).json({ error: "Failed to load business" });
      }
      if (!cfg) return res.status(404).json({ error: "Business not found" });
      const cfgRow = cfg as { agent_id: string | null; voice_id: string | null };
      if (!cfgRow.agent_id) {
        return res.status(409).json({
          error:
            "Business has no ElevenLabs agent configured; cannot sync voice",
        });
      }
      const oldVoiceId = cfgRow.voice_id;
      const nowIso = new Date().toISOString();

      // Step 1: persist new voice_id (DB-first, sync-second pattern).
      const { error: updErr } = await supabase
        .from("business_configs")
        .update({ voice_id: newVoiceId })
        .eq("business_id", targetBusinessId);
      if (updErr) {
        console.error(
          "[admin-businesses:voice] DB update failed:",
          updErr.message,
        );
        return res.status(500).json({
          error: "Failed to save voice",
          details: updErr.message,
        });
      }

      // Step 2: push to ElevenLabs (verify-after-write inside helper).
      const syncResult: UpdateVoiceResult = await updateAgentVoice(
        cfgRow.agent_id,
        newVoiceId,
      );

      // Step 3: write audit row (best-effort). The critical bit is
      // changed_by_user_id = req.userId (the STAFF caller), making this
      // row distinguishable from owner-initiated voice_change rows. The
      // 'admin_voice_change' source value depends on migration 025
      // having been applied to production.
      try {
        const { error: auditErr } = await supabase
          .from("prompt_audit_log")
          .insert({
            business_id: targetBusinessId,
            changed_by_user_id: userId,
            language: "en",
            source: "admin_voice_change",
            old_prompt: oldVoiceId ?? "NULL",
            new_prompt: newVoiceId,
            sync_to_elevenlabs_ok: syncResult.ok,
            elevenlabs_error: syncResult.ok ? null : syncResult.error,
            ip_address: req.ip ?? null,
            user_agent: (req.headers["user-agent"] as string) ?? null,
          });
        if (auditErr) {
          console.error(
            `[admin-businesses:voice] audit insert failed for ${targetBusinessId}: ${auditErr.message}`,
          );
        }
      } catch (err: any) {
        console.error(
          `[admin-businesses:voice] audit insert exception: ${err?.message ?? err}`,
        );
      }

      // Step 4: sync-state columns (best-effort — voice is persisted).
      const syncStateUpdate: Record<string, unknown> = syncResult.ok
        ? { voice_last_synced_at: nowIso, voice_sync_error: null }
        : { voice_sync_error: syncResult.error };
      const { error: syncStateErr } = await supabase
        .from("business_configs")
        .update(syncStateUpdate)
        .eq("business_id", targetBusinessId);
      if (syncStateErr) {
        console.error(
          `[admin-businesses:voice] sync-state update failed: ${syncStateErr.message}`,
        );
      }

      // Return refreshed detail so the frontend can update in place
      // without a second round-trip.
      const detail = await loadBusinessDetail(supabase, targetBusinessId);
      if (!detail) {
        // Vanishingly unlikely — we just wrote the row.
        return res.status(404).json({ error: "Business not found" });
      }
      return res.json(detail);
    } catch (e: any) {
      console.error(
        "[admin-businesses:voice] unexpected:",
        e?.message ?? e,
      );
      return res.status(500).json({
        error: "Failed to save voice",
        details: e?.message ?? String(e),
      });
    }
  },
);

export default router;
