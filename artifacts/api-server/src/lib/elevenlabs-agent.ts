/**
 * ElevenLabs agent sync — push prompt updates from our DB to the
 * agent's configuration on ElevenLabs' side, with verify-after-write.
 *
 * This module is the single place that talks to /v1/convai/agents/*
 * for prompt updates. It is intentionally pure I/O:
 *   - no Supabase writes
 *   - no audit log writes
 *   - no console logging
 *   - no business_configs lookups
 *
 * The caller (Stage 4 API endpoint) owns persistence + auditing and
 * decides what to do with the structured result this module returns.
 *
 * Why structured-return instead of throw:
 *   The caller needs to record sync state (prompt_last_synced_at,
 *   prompt_sync_error) for both success and failure paths. Returning
 *   a discriminated-union result keeps that flow linear without
 *   try/catch around every call. Internal helpers may throw
 *   ElevenLabsAgentError; the public functions catch and convert.
 *
 * Multi-language support:
 *   - 'en' lives at conversation_config.agent.prompt.prompt
 *   - 'fr' / 'es' live at
 *     conversation_config.language_presets.{lang}.overrides.agent.prompt.prompt
 *   buildPatchBody + extractPromptFromAgent dispatch on the language.
 *
 * Retry policy: ONE retry after 2s for 429 + 5xx responses. The
 * caller (synchronous API endpoint) can't afford long retry chains;
 * if 2s isn't enough, surface the failure and let the user retry
 * from the dashboard.
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1/convai/agents";
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const PROMPT_MIN_LENGTH = 1;
const PROMPT_MAX_LENGTH = 50_000;
const AGENT_ID_PATTERN = /^agent_[a-z0-9]+$/i;

export type Language = "en" | "fr" | "es";
const SUPPORTED_LANGUAGES: readonly Language[] = ["en", "fr", "es"] as const;

// ───────────────────────────────────────────────────────────────────────
// Error class

export type ElevenLabsAgentErrorSubcode =
  | "agent_not_found"
  | "invalid_response"
  | "verify_mismatch"
  | "patch_failed"
  | "network"
  | "validation";

export type ElevenLabsAgentErrorStage = "patch" | "verify" | "fetch";

export class ElevenLabsAgentError extends Error {
  constructor(
    public subcode: ElevenLabsAgentErrorSubcode,
    message: string,
    public httpStatus: number | null = null,
    public stage: ElevenLabsAgentErrorStage = "patch",
  ) {
    super(message);
    this.name = "ElevenLabsAgentError";
  }
}

// ───────────────────────────────────────────────────────────────────────
// Result types (discriminated unions)

export interface UpdateAgentSuccess {
  ok: true;
  agentId: string;
  language: Language;
  charsWritten: number;
  verifiedAt: Date;
}

export interface UpdateAgentFailure {
  ok: false;
  agentId: string;
  language: Language;
  error: string;
  httpStatus: number | null;
  stage: "patch" | "verify";
}

export type UpdateAgentResult = UpdateAgentSuccess | UpdateAgentFailure;

export interface FetchAgentSuccess {
  ok: true;
  prompt: string | null;
  agentName: string;
}

export interface FetchAgentFailure {
  ok: false;
  error: string;
  httpStatus: number | null;
}

export type FetchAgentResult = FetchAgentSuccess | FetchAgentFailure;

// ───────────────────────────────────────────────────────────────────────
// Validation

/**
 * Validate the agentId is a non-empty string matching ElevenLabs'
 * `agent_<lowercase-hex>` shape. Throws ElevenLabsAgentError with
 * `subcode='validation'` on malformed input. The caller (public
 * `updateAgentPrompt` / `fetchAgentPrompt`) catches and converts to
 * a structured failure result.
 */
function validateAgentId(agentId: string): void {
  if (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId)) {
    throw new ElevenLabsAgentError(
      "validation",
      `Invalid agentId: ${JSON.stringify(agentId)} (expected /^agent_[a-z0-9]+$/i)`,
    );
  }
}

function validateLanguage(language: string): Language {
  if (!SUPPORTED_LANGUAGES.includes(language as Language)) {
    throw new ElevenLabsAgentError(
      "validation",
      `Invalid language: ${JSON.stringify(language)} (expected one of: ${SUPPORTED_LANGUAGES.join(", ")})`,
    );
  }
  return language as Language;
}

function validatePrompt(prompt: string): void {
  if (typeof prompt !== "string" || prompt.length < PROMPT_MIN_LENGTH) {
    throw new ElevenLabsAgentError(
      "validation",
      `Invalid prompt: must be a non-empty string`,
    );
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    throw new ElevenLabsAgentError(
      "validation",
      `Invalid prompt: exceeds maximum length (${prompt.length} > ${PROMPT_MAX_LENGTH})`,
    );
  }
}

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY environment variable is required but not set");
  }
  return key;
}

// ───────────────────────────────────────────────────────────────────────
// Language-aware path helpers

function buildPatchBody(language: Language, prompt: string): unknown {
  if (language === "en") {
    return {
      conversation_config: {
        agent: { prompt: { prompt } },
      },
    };
  }
  return {
    conversation_config: {
      language_presets: {
        [language]: {
          overrides: {
            agent: { prompt: { prompt } },
          },
        },
      },
    },
  };
}

function extractPromptFromAgent(agentJson: unknown, language: Language): string | null {
  const root = agentJson as
    | {
        conversation_config?: {
          agent?: { prompt?: { prompt?: unknown } };
          language_presets?: Record<string, {
            overrides?: { agent?: { prompt?: { prompt?: unknown } } };
          }>;
        };
      }
    | null
    | undefined;
  if (language === "en") {
    const p = root?.conversation_config?.agent?.prompt?.prompt;
    return typeof p === "string" ? p : null;
  }
  const p =
    root?.conversation_config?.language_presets?.[language]?.overrides?.agent?.prompt?.prompt;
  return typeof p === "string" ? p : null;
}

// ───────────────────────────────────────────────────────────────────────
// Fetch with timeout helper

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(handle);
  }
}

// ───────────────────────────────────────────────────────────────────────
// fetchAgentPrompt — public

/**
 * GET an agent and read the prompt at the language-specific path.
 *
 * Returns `{ ok: true, prompt, agentName }` on success. `prompt` is
 * `null` when the agent exists but has no prompt set at the requested
 * language path (e.g. requesting 'fr' on an EN-only agent).
 *
 * Never throws; all failure modes (validation, network, 401, 404,
 * other HTTP) flow back through `{ ok: false, error, httpStatus }`.
 */
export async function fetchAgentPrompt(
  agentId: string,
  language: string,
): Promise<FetchAgentResult> {
  let lang: Language;
  try {
    validateAgentId(agentId);
    lang = validateLanguage(language);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ElevenLabsAgentError ? err.message : String(err),
      httpStatus: null,
    };
  }

  const url = `${ELEVENLABS_API_BASE}/${agentId}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { "xi-api-key": getApiKey() } },
      DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      error: isAbort
        ? `Request timed out after ${DEFAULT_TIMEOUT_MS}ms`
        : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: null,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      error: "ELEVENLABS_API_KEY is invalid or revoked (401)",
      httpStatus: 401,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: `Agent not found: ${agentId}`,
      httpStatus: 404,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
      httpStatus: response.status,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: response.status,
    };
  }

  const prompt = extractPromptFromAgent(json, lang);
  const agentName =
    typeof (json as { name?: unknown })?.name === "string"
      ? ((json as { name: string }).name)
      : "";

  return { ok: true, prompt, agentName };
}

// ───────────────────────────────────────────────────────────────────────
// updateAgentPrompt — public

/**
 * PATCH the agent's prompt at the language-specific path, then GET
 * the agent and verify the persisted value matches what we sent
 * (string-equal, no normalisation).
 *
 * Retry policy: ONE retry after 2s for 429 + 5xx responses. Other
 * statuses (401, 404, 4xx, 2xx-with-mismatch) are returned without
 * retry.
 *
 * Never throws; all failure modes flow back through
 * `{ ok: false, error, httpStatus, stage }`.
 */
export async function updateAgentPrompt(
  agentId: string,
  language: string,
  prompt: string,
): Promise<UpdateAgentResult> {
  // Validation. On failure we return immediately with stage='patch'
  // (the PATCH never went out, but 'patch' is the closest of the two
  // allowed stage values in UpdateAgentFailure).
  let lang: Language;
  try {
    validateAgentId(agentId);
    lang = validateLanguage(language);
    validatePrompt(prompt);
  } catch (err) {
    return {
      ok: false,
      agentId,
      language: language as Language,
      error: err instanceof ElevenLabsAgentError ? err.message : String(err),
      httpStatus: null,
      stage: "patch",
    };
  }

  const url = `${ELEVENLABS_API_BASE}/${agentId}`;
  const body = JSON.stringify(buildPatchBody(lang, prompt));

  // PATCH with one retry on 429 / 5xx.
  let response: Response;
  let attempt = 0;
  for (;;) {
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": getApiKey(),
          },
          body,
        },
        DEFAULT_TIMEOUT_MS,
      );
    } catch (err) {
      const isAbort = (err as { name?: string })?.name === "AbortError";
      return {
        ok: false,
        agentId,
        language: lang,
        error: isAbort
          ? `PATCH request timed out after ${DEFAULT_TIMEOUT_MS}ms`
          : `Network error: ${err instanceof Error ? err.message : String(err)}`,
        httpStatus: null,
        stage: "patch",
      };
    }

    if (response.status === 401) {
      return {
        ok: false,
        agentId,
        language: lang,
        error: "ELEVENLABS_API_KEY is invalid or revoked (401)",
        httpStatus: 401,
        stage: "patch",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        agentId,
        language: lang,
        error: `Agent not found: ${agentId}`,
        httpStatus: 404,
        stage: "patch",
      };
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < 1) {
        attempt++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        agentId,
        language: lang,
        error: `PATCH failed after retry: HTTP ${response.status}: ${text.slice(0, 300)}`,
        httpStatus: response.status,
        stage: "patch",
      };
    }
    break;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      agentId,
      language: lang,
      error: `PATCH failed: HTTP ${response.status}: ${text.slice(0, 300)}`,
      httpStatus: response.status,
      stage: "patch",
    };
  }

  // Verify-after-write: re-GET the agent and confirm the prompt at
  // the language-specific path matches byte-for-byte.
  const verify = await fetchAgentPrompt(agentId, lang);
  if (!verify.ok) {
    return {
      ok: false,
      agentId,
      language: lang,
      error: `Verify-after-write failed: ${verify.error}`,
      httpStatus: verify.httpStatus,
      stage: "verify",
    };
  }

  if (verify.prompt !== prompt) {
    const actualLen = verify.prompt?.length ?? 0;
    return {
      ok: false,
      agentId,
      language: lang,
      error: `Verify mismatch: sent ${prompt.length} chars, ElevenLabs returned ${actualLen} chars`,
      httpStatus: null,
      stage: "verify",
    };
  }

  return {
    ok: true,
    agentId,
    language: lang,
    charsWritten: prompt.length,
    verifiedAt: new Date(),
  };
}

// ───────────────────────────────────────────────────────────────────────
// Voice helpers (Sprint 3 Stage 5 Session 1 / Phase 2)
//
// Symmetric to updateAgentPrompt / fetchAgentPrompt above. Same
// retry policy (one retry after 2s on 429/5xx), same timeout
// (DEFAULT_TIMEOUT_MS), same verify-after-write semantics, same
// structured-return contract.

export interface UpdateVoiceSuccess {
  ok: true;
  agentId: string;
  voiceId: string;
  verifiedAt: Date;
}

export interface UpdateVoiceFailure {
  ok: false;
  agentId: string;
  voiceId: string;
  error: string;
  httpStatus: number | null;
  stage: "patch" | "verify";
}

export type UpdateVoiceResult = UpdateVoiceSuccess | UpdateVoiceFailure;

export interface FetchVoiceSuccess {
  ok: true;
  voiceId: string | null;
  agentName: string;
}

export interface FetchVoiceFailure {
  ok: false;
  error: string;
  httpStatus: number | null;
}

export type FetchVoiceResult = FetchVoiceSuccess | FetchVoiceFailure;

function buildVoicePatchBody(voiceId: string): unknown {
  return {
    conversation_config: {
      tts: { voice_id: voiceId },
    },
  };
}

function extractVoiceFromAgent(agentJson: unknown): string | null {
  const root = agentJson as
    | { conversation_config?: { tts?: { voice_id?: unknown } } }
    | null
    | undefined;
  const v = root?.conversation_config?.tts?.voice_id;
  return typeof v === "string" ? v : null;
}

/**
 * GET an agent and read conversation_config.tts.voice_id. Returns
 * `{ ok: true, voiceId, agentName }` on success. `voiceId` is `null`
 * when the agent exists but has no tts.voice_id configured.
 *
 * Never throws; validation / network / 401 / 404 / other failures all
 * flow back through `{ ok: false, error, httpStatus }`.
 */
export async function fetchAgentVoice(
  agentId: string,
): Promise<FetchVoiceResult> {
  try {
    validateAgentId(agentId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof ElevenLabsAgentError ? err.message : String(err),
      httpStatus: null,
    };
  }

  const url = `${ELEVENLABS_API_BASE}/${agentId}`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { "xi-api-key": getApiKey() } },
      DEFAULT_TIMEOUT_MS,
    );
  } catch (err) {
    const isAbort = (err as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      error: isAbort
        ? `Request timed out after ${DEFAULT_TIMEOUT_MS}ms`
        : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: null,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      error: "ELEVENLABS_API_KEY is invalid or revoked (401)",
      httpStatus: 401,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: `Agent not found: ${agentId}`,
      httpStatus: 404,
    };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      error: `HTTP ${response.status}: ${text.slice(0, 300)}`,
      httpStatus: response.status,
    };
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`,
      httpStatus: response.status,
    };
  }

  const voiceId = extractVoiceFromAgent(json);
  const agentName =
    typeof (json as { name?: unknown })?.name === "string"
      ? ((json as { name: string }).name)
      : "";

  return { ok: true, voiceId, agentName };
}

/**
 * PATCH the agent's tts.voice_id, then GET the agent and verify
 * the persisted value matches what we sent.
 *
 * Retry policy: ONE retry after 2s for 429 + 5xx responses. Other
 * statuses (401, 404, other 4xx, 2xx-with-mismatch) are returned
 * without retry.
 *
 * Never throws; all failure modes flow back through
 * `{ ok: false, error, httpStatus, stage }`.
 */
export async function updateAgentVoice(
  agentId: string,
  voiceId: string,
): Promise<UpdateVoiceResult> {
  try {
    validateAgentId(agentId);
    if (typeof voiceId !== "string" || voiceId.length === 0) {
      throw new ElevenLabsAgentError(
        "validation",
        `Invalid voiceId: must be a non-empty string`,
      );
    }
  } catch (err) {
    return {
      ok: false,
      agentId,
      voiceId,
      error: err instanceof ElevenLabsAgentError ? err.message : String(err),
      httpStatus: null,
      stage: "patch",
    };
  }

  const url = `${ELEVENLABS_API_BASE}/${agentId}`;
  const body = JSON.stringify(buildVoicePatchBody(voiceId));

  // PATCH with one retry on 429 / 5xx.
  let response: Response;
  let attempt = 0;
  for (;;) {
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": getApiKey(),
          },
          body,
        },
        DEFAULT_TIMEOUT_MS,
      );
    } catch (err) {
      const isAbort = (err as { name?: string })?.name === "AbortError";
      return {
        ok: false,
        agentId,
        voiceId,
        error: isAbort
          ? `PATCH request timed out after ${DEFAULT_TIMEOUT_MS}ms`
          : `Network error: ${err instanceof Error ? err.message : String(err)}`,
        httpStatus: null,
        stage: "patch",
      };
    }

    if (response.status === 401) {
      return {
        ok: false,
        agentId,
        voiceId,
        error: "ELEVENLABS_API_KEY is invalid or revoked (401)",
        httpStatus: 401,
        stage: "patch",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        agentId,
        voiceId,
        error: `Agent not found: ${agentId}`,
        httpStatus: 404,
        stage: "patch",
      };
    }

    if (response.status === 429 || response.status >= 500) {
      if (attempt < 1) {
        attempt++;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const text = await response.text().catch(() => "");
      return {
        ok: false,
        agentId,
        voiceId,
        error: `PATCH failed after retry: HTTP ${response.status}: ${text.slice(0, 300)}`,
        httpStatus: response.status,
        stage: "patch",
      };
    }
    break;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      agentId,
      voiceId,
      error: `PATCH failed: HTTP ${response.status}: ${text.slice(0, 300)}`,
      httpStatus: response.status,
      stage: "patch",
    };
  }

  // Verify-after-write.
  const verify = await fetchAgentVoice(agentId);
  if (!verify.ok) {
    return {
      ok: false,
      agentId,
      voiceId,
      error: `Verify-after-write failed: ${verify.error}`,
      httpStatus: verify.httpStatus,
      stage: "verify",
    };
  }
  if (verify.voiceId !== voiceId) {
    return {
      ok: false,
      agentId,
      voiceId,
      error: `Verify mismatch: sent ${voiceId}, ElevenLabs returned ${verify.voiceId ?? "null"}`,
      httpStatus: null,
      stage: "verify",
    };
  }

  return {
    ok: true,
    agentId,
    voiceId,
    verifiedAt: new Date(),
  };
}
