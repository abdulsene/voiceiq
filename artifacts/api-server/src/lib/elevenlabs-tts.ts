/**
 * ElevenLabs TTS wrapper — Sprint 5 Alex Voice Mode (Sunday May 3 2026).
 *
 * Singleton-style helper around ElevenLabs' /v1/text-to-speech endpoint.
 * Mirrors the boot-check pattern from lib/anthropic.ts: ELEVENLABS_API_KEY
 * presence is logged at module load (warn if missing, info if present)
 * so a misconfigured deploy is obvious in the api-server boot log.
 *
 * Why fetch() rather than the elevenlabs SDK:
 *   - Existing api-server code already calls ElevenLabs via fetch() in
 *     api.ts (sync, outbound-call) and agents.ts (CRUD on convai agents).
 *     Spec says "use existing tooling — don't add new frontend
 *     dependencies"; the same restraint applies to backend deps.
 *   - The synthesis endpoint returns audio/mpeg as a streaming body —
 *     fetch's Response.body (web ReadableStream) maps cleanly onto a
 *     Node Readable that can pipe straight to res. SDK would buffer.
 *
 * Voice ID resolution (highest precedence first):
 *   1. process.env.ELEVENLABS_VOICE_ID — operator override.
 *   2. ELEVENLABS_DEFAULT_VOICE_ID below ("Rachel", warm/friendly,
 *      ElevenLabs library default — works for any account tier).
 *
 *   ELEVENLABS_AGENT_ID is intentionally NOT used here. That env var is
 *   the convai agent identifier (`agent_xxx`), not a voice id, so the
 *   /text-to-speech endpoint would 422.
 *
 * Model: eleven_turbo_v2_5. Lowest end-to-end latency, multilingual,
 * suitable for back-and-forth chat. Account-tier rejection isn't
 * silently retried — the caller surfaces a 502 and the frontend falls
 * back to text-only.
 */

const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export const ELEVENLABS_DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel
export const ELEVENLABS_DEFAULT_MODEL = "eleven_turbo_v2_5";

// ---------------------------------------------------------------------------
// Boot-time presence check. Module side-effect by design — importing this
// file from any route triggers the warn so a missing key is loud at boot
// rather than silent until the first /api/chat/tts request.
// ---------------------------------------------------------------------------
(() => {
  if (!process.env["ELEVENLABS_API_KEY"]) {
    console.warn(
      "[elevenlabs-tts] ELEVENLABS_API_KEY missing — /api/chat/tts will return 503 on every call",
    );
    return;
  }
  const voiceId =
    process.env["ELEVENLABS_VOICE_ID"] || ELEVENLABS_DEFAULT_VOICE_ID;
  console.log(
    `[elevenlabs-tts] ready (voice=${voiceId}, model=${ELEVENLABS_DEFAULT_MODEL})`,
  );
})();

export type TtsResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; reason: string };

/**
 * Synthesize `text` to speech and return the upstream fetch Response.
 *
 * The caller is expected to pipe response.body through to the client
 * for low latency. We return the Response (not a Buffer) so streaming
 * is the default. On error, returns a structured failure with the
 * upstream status code and a short reason string (truncated upstream
 * body, never logged at info level).
 *
 * Status codes we surface:
 *   503 — ELEVENLABS_API_KEY missing (config error, distinct from upstream).
 *   502 — Network failure or any non-2xx from ElevenLabs.
 *   200 — ok: true with the streaming Response.
 */
export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  const apiKey = process.env["ELEVENLABS_API_KEY"];
  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      reason: "ELEVENLABS_API_KEY not configured",
    };
  }
  const voiceId =
    process.env["ELEVENLABS_VOICE_ID"] || ELEVENLABS_DEFAULT_VOICE_ID;

  // output_format=mp3_44100_128 is the broadest-compat MP3 preset:
  // every browser HTMLAudioElement plays it without flag-gated codecs,
  // and the bitrate keeps file size small (~16 KB/sec).
  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_DEFAULT_MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, reason: `network: ${msg}` };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 500);
    } catch {
      /* ignore — body might already be consumed or stream-broken */
    }
    return {
      ok: false,
      status: response.status,
      reason: body || `upstream ${response.status}`,
    };
  }
  return { ok: true, response };
}
