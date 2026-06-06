/**
 * Sprint 3 Stage 5 Session 1 / Phase 2 — voice picker endpoints.
 *
 * Three endpoints for the customer voice-selection feature:
 *   - GET    /api/voices/catalog    curated list of 12 ElevenLabs voices
 *   - POST   /api/voices/preview    business-name personalized TTS sample
 *   - PATCH  /api/business/voice    DB-first save + ElevenLabs sync
 *
 * Auth: requireAuth + requirePermission("settings", "read"|"write")
 *
 * Sync model: same as Stage 4 prompt endpoints — DB write FIRST, then
 * ElevenLabs PATCH with verify-after-write. If DB persists but the
 * ElevenLabs PATCH fails, the endpoint returns HTTP 200 with
 * { ok: false, savedToDb: true, syncError } so the dashboard can show
 * an actionable retry button.
 *
 * Audit: every successful or failed PATCH writes one row to
 * prompt_audit_log with source='voice_change'. The new_prompt column
 * is co-opted to hold the new voice_id string (same pattern as the
 * backfill script). The old voice_id goes in old_prompt; the literal
 * string 'NULL' is used when the column was actually NULL pre-change
 * to keep grep queries simple.
 *
 * Rate limit: 60 previews/business/hour via the existing
 * ipRateLimit(key, scope, max, windowMs) helper. The bucket key is
 * req.businessId — per-business, not per-IP, per spec.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import {
  requireAuth,
  requirePermission,
} from "../middlewares/auth";

import {
  updateAgentVoice,
  type UpdateVoiceResult,
} from "../lib/elevenlabs-agent";

import { ipRateLimit } from "../rateLimiter";

// ───────────────────────────────────────────────────────────────────────
// Constants

const ELEVENLABS_TTS_API = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_flash_v2";
const TTS_TIMEOUT_MS = 15_000;

const PREVIEW_RATE_MAX = 60;
const PREVIEW_RATE_WINDOW_MS = 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────────────
// Voice catalog
//
// 12 curated ElevenLabs voices. Exported so the test file can import
// and assert against the same source of truth. Order is the rendering
// order in the dashboard (do not sort alphabetically).
//
// TODO Dec 2026: ElevenLabs publishes a deprecation date of
// 2026-12-31 for all Default voices — every voice_id in this array
// will stop working on that date and the catalog will need to migrate
// to perpetual voices before then. Recommended fix: switch to a
// dynamic catalog that proxies GET /v1/voices (cached 24h) with an
// allowlist of voice IDs we want to surface. Saves a future Abdul
// from re-investigating the same deprecation timeline.

export interface CatalogVoice {
  voice_id: string;
  name: string;
  gender: "male" | "female";
  accent: "American" | "British" | "Australian" | "Swedish";
  descriptor: string;
  personality_tag: string;
}

export const VOICE_CATALOG: readonly CatalogVoice[] = [
  {
    voice_id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    gender: "female",
    accent: "American",
    descriptor: "Warm, professional, conversational",
    personality_tag: "Hospitality-friendly",
  },
  {
    voice_id: "9BWtsMINqrJLrRacOk9x",
    name: "Aria",
    gender: "female",
    accent: "American",
    descriptor: "Expressive, social media energy",
    personality_tag: "Engaging",
  },
  {
    voice_id: "IKne3meq5aSn9XLyUdCD",
    name: "Charlie",
    gender: "male",
    accent: "Australian",
    descriptor: "Casual, natural, conversational",
    personality_tag: "Relaxed",
  },
  {
    voice_id: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    gender: "male",
    accent: "American",
    descriptor: "Deep, narrative, steady",
    personality_tag: "Authoritative",
  },
  {
    voice_id: "pqHfZKP75CvOlQylNhV4",
    name: "Bill",
    gender: "male",
    accent: "American",
    descriptor: "Authoritative, mature, confident",
    personality_tag: "News-anchor",
  },
  {
    voice_id: "pFZP5JQG7iQjIQuC4Bku",
    name: "Lily",
    gender: "female",
    accent: "British",
    descriptor: "Warm, narration, calm",
    personality_tag: "Reassuring",
  },
  {
    voice_id: "TX3LPaxmHKxFdv7VOQHJ",
    name: "Liam",
    gender: "male",
    accent: "American",
    descriptor: "Articulate, clear, narration",
    personality_tag: "Crisp",
  },
  {
    voice_id: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda",
    gender: "female",
    accent: "American",
    descriptor: "Friendly, conversational, upbeat",
    personality_tag: "Approachable",
  },
  {
    voice_id: "JBFqnCBsd6RMkjVDRZzb",
    name: "George",
    gender: "male",
    accent: "British",
    descriptor: "Warm, captivating storyteller",
    personality_tag: "Calm",
  },
  {
    voice_id: "XB0fDUnXU5powFXDhCwa",
    name: "Charlotte",
    gender: "female",
    accent: "Swedish",
    descriptor: "Soft, intimate, mature",
    personality_tag: "Boutique",
  },
  {
    voice_id: "onwK4e9ZLuTAKqWW03F9",
    name: "Daniel",
    gender: "male",
    accent: "British",
    descriptor: "News-anchor, authoritative",
    personality_tag: "Trustworthy",
  },
  {
    voice_id: "N2lVS1w4EtoT3dr4eOWO",
    name: "Callum",
    gender: "male",
    accent: "American",
    descriptor: "Intense, hoarse, transatlantic",
    personality_tag: "Character",
  },
];

const VOICE_BY_ID = new Map<string, CatalogVoice>(
  VOICE_CATALOG.map((v) => [v.voice_id, v]),
);

// ───────────────────────────────────────────────────────────────────────
// Supabase client — lazy singleton + test override

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
// Fetch helper with timeout (TTS — separate from elevenlabs-agent's
// internal helper since that one isn't exported).

// Local alias — `Response` is shadowed by the express type import
// above. This lets fetchWithTimeout's return type point at the
// global Web Response (what fetch returns), not Express's Response.
type FetchResponse = globalThis.Response;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<FetchResponse> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(handle);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Router

const router: IRouter = Router();

// ── GET /api/voices/catalog ───────────────────────────────────────────

router.get(
  "/voices/catalog",
  requireAuth,
  requirePermission("settings", "read"),
  async (_req: Request, res: Response) => {
    return res.json({ voices: VOICE_CATALOG });
  },
);

// ── GET /api/business/voice ───────────────────────────────────────────

router.get(
  "/business/voice",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId;
      if (!businessId) {
        return res.status(400).json({ error: "No active business" });
      }
      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }
      const { data, error } = await supabase
        .from("business_configs")
        .select(
          "business_id, voice_id, voice_last_synced_at, voice_sync_error, agent_id",
        )
        .eq("business_id", businessId)
        .maybeSingle();
      if (error) {
        console.error("[voices:GET] read error:", error.message);
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
        // Convenience field for the dashboard: the CatalogVoice entry
        // matching voice_id if the customer's currently configured
        // voice is in the curated catalog (null if voice_id is set but
        // points to a voice we don't surface, or if voice_id is null).
        catalog_match: knownVoice,
      });
    } catch (e: any) {
      console.error("[voices:GET] unexpected:", e?.message ?? e);
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── POST /api/voices/preview ──────────────────────────────────────────

router.post(
  "/voices/preview",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId;
      if (!businessId) {
        return res.status(400).json({ error: "No active business" });
      }

      // Rate limit per business (60/hour).
      const limit = ipRateLimit(
        businessId,
        "voice_preview",
        PREVIEW_RATE_MAX,
        PREVIEW_RATE_WINDOW_MS,
      );
      if (!limit.allowed) {
        return res.status(429).json({
          error: "Preview rate limit reached. Try again in a few minutes.",
          resetAt: limit.resetAt,
        });
      }

      const body = (req.body || {}) as { voice_id?: unknown };
      const voiceId = body.voice_id;
      if (typeof voiceId !== "string" || !VOICE_BY_ID.has(voiceId)) {
        return res.status(400).json({
          error: "voice_id is required and must be one of the catalog voices",
        });
      }

      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      // Look up business name + ai_name to personalize the preview.
      const { data: cfg, error: cfgErr } = await supabase
        .from("business_configs")
        .select("business_name, ai_name")
        .eq("business_id", businessId)
        .maybeSingle();
      if (cfgErr) {
        console.error("[voices:preview] config read error:", cfgErr.message);
        return res.status(500).json({ error: "Failed to load business" });
      }
      if (!cfg) {
        return res.status(404).json({ error: "Business not found" });
      }
      const c = cfg as { business_name?: string; ai_name?: string };
      const businessName = (c.business_name ?? "").trim() || "our business";
      const aiName = (c.ai_name ?? "").trim() || "Alex";

      const previewText = `Hello, this is ${aiName} from ${businessName}. How can I help you today?`;

      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        return res
          .status(500)
          .json({ error: "ELEVENLABS_API_KEY not configured" });
      }

      // Call ElevenLabs TTS.
      let ttsResp: FetchResponse;
      try {
        ttsResp = await fetchWithTimeout(
          `${ELEVENLABS_TTS_API}/${voiceId}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
              "xi-api-key": apiKey,
            },
            body: JSON.stringify({
              text: previewText,
              model_id: TTS_MODEL_ID,
              voice_settings: { stability: 0.5, similarity_boost: 0.8 },
            }),
          },
          TTS_TIMEOUT_MS,
        );
      } catch (err: any) {
        const isAbort = err?.name === "AbortError";
        Sentry.captureException(err, {
          extra: { businessId, voice_id: voiceId, route: "voices/preview" },
        });
        return res.status(isAbort ? 504 : 502).json({
          error: isAbort
            ? "ElevenLabs request timed out"
            : "Failed to reach ElevenLabs",
        });
      }

      if (!ttsResp.ok) {
        const text = await ttsResp.text().catch(() => "");
        console.error(
          `[voices:preview] ElevenLabs ${ttsResp.status}: ${text.slice(0, 200)}`,
        );
        Sentry.captureMessage("voices_preview_elevenlabs_non2xx", {
          level: "error",
          extra: {
            businessId,
            voice_id: voiceId,
            status: ttsResp.status,
            body: text.slice(0, 500),
            route: "voices/preview",
          },
        });
        return res.status(502).json({
          error: `ElevenLabs returned ${ttsResp.status}`,
        });
      }

      // Stream audio bytes back. We buffer fully then send rather
      // than piping — keeps the response simple and the body fits in
      // memory comfortably for a ~5-second preview clip.
      const audioArrayBuffer = await ttsResp.arrayBuffer();
      const audioBuffer = Buffer.from(audioArrayBuffer);

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", String(audioBuffer.length));
      res.setHeader("Cache-Control", "private, max-age=300");
      return res.send(audioBuffer);
    } catch (err: any) {
      console.error("[voices:preview] unexpected:", err?.message ?? err);
      Sentry.captureException(err, {
        extra: {
          businessId: req.businessId,
          voice_id: (req.body as { voice_id?: unknown })?.voice_id,
          route: "voices/preview",
        },
      });
      return res.status(500).json({ error: "server_error" });
    }
  },
);

// ── PATCH /api/business/voice ─────────────────────────────────────────

router.patch(
  "/business/voice",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    try {
      const businessId = req.businessId;
      const userId = req.userId;
      if (!businessId || !userId) {
        return res.status(400).json({ error: "No active business" });
      }

      const body = (req.body || {}) as { voice_id?: unknown };
      const newVoiceId = body.voice_id;
      if (typeof newVoiceId !== "string" || !VOICE_BY_ID.has(newVoiceId)) {
        return res.status(400).json({
          error: "voice_id is required and must be one of the catalog voices",
        });
      }
      const voiceEntry = VOICE_BY_ID.get(newVoiceId)!;

      const supabase = getSupabase();
      if (!supabase) {
        return res.status(500).json({ error: "Database not configured" });
      }

      // Look up agent_id + current voice_id for audit.
      const { data: cfg, error: cfgErr } = await supabase
        .from("business_configs")
        .select("agent_id, voice_id")
        .eq("business_id", businessId)
        .maybeSingle();
      if (cfgErr) {
        console.error("[voices:PATCH] config read error:", cfgErr.message);
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

      // Step 1: persist the voice_id.
      const { error: updErr } = await supabase
        .from("business_configs")
        .update({ voice_id: newVoiceId })
        .eq("business_id", businessId);
      if (updErr) {
        console.error("[voices:PATCH] DB update failed:", updErr.message);
        return res.status(500).json({
          error: "Failed to save voice",
          details: updErr.message,
        });
      }

      // Step 2: push to ElevenLabs.
      const syncResult: UpdateVoiceResult = await updateAgentVoice(
        cfgRow.agent_id,
        newVoiceId,
      );

      // Step 3: write audit row (best-effort).
      let auditLogId: string | null = null;
      try {
        const { data: inserted, error: auditErr } = await supabase
          .from("prompt_audit_log")
          .insert({
            business_id: businessId,
            changed_by_user_id: userId,
            language: "en",
            source: "voice_change",
            old_prompt: oldVoiceId ?? "NULL",
            new_prompt: newVoiceId,
            sync_to_elevenlabs_ok: syncResult.ok,
            elevenlabs_error: syncResult.ok ? null : syncResult.error,
            ip_address: req.ip ?? null,
            user_agent: (req.headers["user-agent"] as string) ?? null,
          })
          .select("id")
          .maybeSingle();
        if (auditErr) {
          console.error(
            `[voices:PATCH] audit insert failed for ${businessId}: ${auditErr.message}`,
          );
        } else if (inserted && typeof (inserted as { id?: unknown }).id === "string") {
          auditLogId = (inserted as { id: string }).id;
        }
      } catch (err: any) {
        console.error(`[voices:PATCH] audit insert exception: ${err?.message ?? err}`);
      }

      // Step 4: sync-state columns (best-effort — voice is persisted).
      const syncStateUpdate: Record<string, unknown> = syncResult.ok
        ? { voice_last_synced_at: nowIso, voice_sync_error: null }
        : { voice_sync_error: syncResult.error };
      const { error: syncStateErr } = await supabase
        .from("business_configs")
        .update(syncStateUpdate)
        .eq("business_id", businessId);
      if (syncStateErr) {
        console.error(
          `[voices:PATCH] sync-state update failed: ${syncStateErr.message}`,
        );
      }

      if (syncResult.ok) {
        return res.json({
          ok: true,
          synced: true,
          new_voice_id: newVoiceId,
          voice_name: voiceEntry.name,
          auditLogId,
        });
      }

      // Sync failure: DB has the new value, ElevenLabs does not.
      Sentry.captureMessage("voice_change_sync_failed", {
        level: "warning",
        extra: {
          businessId,
          agent_id: cfgRow.agent_id,
          new_voice_id: newVoiceId,
          syncError: syncResult.error,
          stage: syncResult.stage,
          route: "voices/PATCH",
        },
      });
      return res.json({
        ok: false,
        savedToDb: true,
        syncError: syncResult.error,
        new_voice_id: newVoiceId,
        voice_name: voiceEntry.name,
        auditLogId,
      });
    } catch (err: any) {
      console.error("[voices:PATCH] error:", err?.message ?? err);
      Sentry.captureException(err, {
        extra: {
          businessId: req.businessId,
          voice_id: (req.body as { voice_id?: unknown })?.voice_id,
          route: "voices/PATCH",
        },
      });
      return res.status(500).json({
        error: "Failed to save voice",
        details: err?.message ?? String(err),
      });
    }
  },
);

export default router;
