/**
 * Phase 4.2 — ElevenLabs post-call webhook signature verification.
 *
 * ElevenLabs signs webhook deliveries with HMAC-SHA256. This module
 * verifies the signature against the raw request body. Fails closed:
 * a bad signature MUST cause the handler to reject before touching
 * the database — otherwise anyone who guesses the URL can insert
 * fabricated call records into any tenant.
 *
 * Authoritative spec (cross-referenced against ElevenLabs official
 * docs at elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
 * plus Hookdeck's ElevenLabs verification reference at
 * github.com/hookdeck/webhook-skills/skills/elevenlabs-webhooks):
 *
 *   Header:            ElevenLabs-Signature
 *   Header format:     "t=<unix_seconds>,v0=<hex_hmac_sha256>"
 *   Signed string:     "<unix_seconds>.<raw_request_body>"
 *                      (dot separator; raw body — parsed JSON would
 *                       change whitespace and break verification)
 *   Algorithm:         HMAC-SHA256, hex-encoded digest
 *   Timestamp window:  30 minutes (1800s) — reject older
 *   Secret:            generated in the ElevenLabs dashboard when the
 *                      webhook is created; stored in Replit Secrets
 *                      as ELEVENLABS_WEBHOOK_SECRET
 *
 * Retry semantics (per ElevenLabs docs): 4xx responses are NOT
 * retried — they're treated as configuration errors. So returning
 * 401 on signature failure is safe: no retry storms, and no risk of
 * duplicate delivery on the next attempt. 5xx WOULD be retried, so
 * only return 500 for actual server-side failures (DB down, etc.),
 * never for auth failures.
 *
 * The 2-minute polling fallback (syncElevenLabsConversations in
 * routes/api.ts) is untouched — if pushes start failing the poller
 * catches up within 2 minutes. Push+poll belt-and-braces is why
 * production coverage was 94% even with 1 known push miss (Phase 4.1
 * investigation).
 */

import { createHmac, timingSafeEqual } from "crypto";

/** 30 minutes in seconds — matches ElevenLabs' documented tolerance. */
export const SIGNATURE_TIMESTAMP_TOLERANCE_SECS = 30 * 60;

/**
 * Verification outcome. Discriminated union so the caller can log
 * the specific failure reason without leaking it in the HTTP
 * response (all failures return the same 401 to prevent probing).
 */
export type SignatureVerification =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "malformed_header" | "stale_timestamp" | "signature_mismatch" | "no_secret" };

/**
 * Parse the ElevenLabs-Signature header value.
 *
 * Format: `t=<unix_seconds>,v0=<hex_signature>`
 *
 * Extra tolerance: we accept segments in any order (spec sample
 * always has t first, but we don't want to be strict about
 * ordering when the semantic is clear) and ignore unknown keys
 * (v1=... etc. — future-proofing if ElevenLabs adds versions).
 */
export function parseSignatureHeader(raw: string | undefined): {
  timestamp: number;
  signatureHex: string;
} | null {
  if (!raw || typeof raw !== "string") return null;
  const parts = raw.split(",").map((p) => p.trim());
  let ts: number | null = null;
  let sig: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return null;
      ts = Math.floor(n);
    } else if (k === "v0") {
      if (!/^[0-9a-f]+$/i.test(v)) return null;
      sig = v.toLowerCase();
    }
  }
  if (ts === null || sig === null) return null;
  return { timestamp: ts, signatureHex: sig };
}

/**
 * Verify a webhook signature against the raw request body.
 *
 * MUST be called with the raw body bytes, NOT a re-serialized JSON
 * string — re-serialization can change whitespace and key ordering
 * and will silently invalidate the HMAC. See routes/api.ts where
 * this is wired: the /webhook/elevenlabs path uses express.raw()
 * BEFORE express.json() so req.body arrives as a Buffer.
 */
export function verifyElevenLabsSignature(input: {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  secret: string | undefined;
  nowSecs?: number;
}): SignatureVerification {
  if (!input.secret) return { ok: false, reason: "no_secret" };

  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed && !input.signatureHeader) return { ok: false, reason: "missing_header" };
  if (!parsed) return { ok: false, reason: "malformed_header" };

  const now = input.nowSecs ?? Math.floor(Date.now() / 1000);
  const ageSecs = Math.abs(now - parsed.timestamp);
  if (ageSecs > SIGNATURE_TIMESTAMP_TOLERANCE_SECS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  // Canonical string: "<timestamp>.<rawBody>". A dot literal — no
  // JSON re-serialization, no whitespace normalization. This is the
  // exact reason we route the raw Buffer through here.
  const bodyStr = Buffer.isBuffer(input.rawBody)
    ? input.rawBody.toString("utf8")
    : input.rawBody;
  const canonical = `${parsed.timestamp}.${bodyStr}`;

  const expectedHex = createHmac("sha256", input.secret)
    .update(canonical, "utf8")
    .digest("hex");

  // Constant-time comparison. Same-length Buffer conversion is
  // required — timingSafeEqual throws on length mismatch, so we
  // guard first to keep the mismatch reason clean.
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const providedBuf = Buffer.from(parsed.signatureHex, "hex");
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: "signature_mismatch" };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}
