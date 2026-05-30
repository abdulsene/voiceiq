/**
 * POST /api/chat/tts — Alex Voice Mode (Sprint 5, Sunday May 3 2026).
 *
 * Surface (mounted by routes/index.ts before the apiRouter catch-all):
 *   POST /api/chat/tts  body: { text: string }  →  audio/mpeg stream
 *
 * Auth model:
 *   PUBLIC. Inherits the existing /^\/api\/chat\// AUTH_BYPASS rule
 *   from app.ts:199 (originally added for the anonymous chat
 *   endpoints). Same identity model as chat.ts: the visitor cookie is
 *   the implicit identity, but this route doesn't currently bind to a
 *   conversation row — it's a stateless text→speech transformer the
 *   ChatWidget hits after each Alex reply when voice mode is on.
 *
 * Cost containment:
 *   text length capped at TTS_MAX_TEXT (5000) so a malicious body can't
 *   consume an unbounded chunk of our ElevenLabs quota in a single
 *   request. The IP rate-limiter (express-rate-limit, applied at app
 *   level) provides the per-IP quota cap orthogonally.
 *
 * Streaming:
 *   ElevenLabs returns the MP3 chunked. We pipe upstream.body
 *   straight through to res so the browser can begin playback before
 *   the full clip is generated. If upstream returns Content-Length
 *   (rare for streamed audio), we forward it; otherwise we leave it
 *   off and let the browser read until EOF.
 *
 * Side-effect on import:
 *   Triggers lib/elevenlabs-tts.ts's boot-time ELEVENLABS_API_KEY
 *   check — by design, mirrors the chat.ts → lib/anthropic.ts pattern.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { Readable } from "node:stream";
import rateLimit from "express-rate-limit";
import { synthesizeSpeech } from "../lib/elevenlabs-tts.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";

const router: IRouter = Router();

const TTS_MAX_TEXT = 5000;

// ---------------------------------------------------------------------------
// Per-visitor TTS rate limit (2026-05-03).
//
// Why per-visitor, not per-IP:
//   ElevenLabs charges per character synthesized. The chat widget runs
//   anonymously behind a `neverr_visitor_id` HttpOnly cookie minted on
//   first /api/chat/conversation hit (see routes/chat.ts:122
//   getOrSetVisitorId). That cookie is a much tighter cost-attribution
//   key than IP — multiple students on a campus NAT share an IP, and
//   one bored visitor on residential WiFi could otherwise burn the
//   limiter's whole window for everyone behind their CGNAT.
//
// Fallback to IP (via express-rate-limit's ipKeyGenerator helper which
//   normalizes IPv6 /64 prefixes the same way the package's defaults
//   do) covers:
//     - a brand-new visitor hitting /chat/tts before any chat-conv
//       round-trip has set the cookie (rare but possible if the
//       widget client diverges)
//     - clients that block cookies
//
// Limits are env-configurable so ops can tighten them without a code
// change once we have real-traffic data:
//   NEVERR_TTS_RATE_LIMIT_PER_WINDOW (default: 30)
//   NEVERR_TTS_RATE_LIMIT_WINDOW_MS  (default: 300_000 = 5 min)
//
// 30 / 5min ≈ 6 TTS calls/min, which is well above an active human
// conversation cadence (Alex replies are spaced by user thinking +
// speaking + transcription latency) and tight enough to make a
// cost-amplification attack uneconomic. Defaults reviewed against the
// per-visitor exposure cap = 30 * TTS_MAX_TEXT chars = 150K chars per
// 5-minute window — a hard ceiling on per-visitor ElevenLabs spend.
//
// Architect-flagged 2026-05-03 follow-up to the voice-mode launch:
// "global /api IP rate limiter covers sprint scope; per-visitor cost
// protection is worthwhile follow-up". This is that follow-up.
// ---------------------------------------------------------------------------
const TTS_RATE_LIMIT_PER_WINDOW = (() => {
  const raw = process.env["NEVERR_TTS_RATE_LIMIT_PER_WINDOW"];
  if (!raw) return 30;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

const TTS_RATE_LIMIT_WINDOW_MS = (() => {
  const raw = process.env["NEVERR_TTS_RATE_LIMIT_WINDOW_MS"];
  if (!raw) return 300_000;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();

const VISITOR_COOKIE = "neverr_visitor_id";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors routes/chat.ts:parseCookies — duplicated rather than imported
// to keep chat-tts.ts a leaf module (no cross-route imports). The
// parseCookies helper there has a header explaining why the codebase
// avoids the cookie-parser middleware.
function readVisitorCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== VISITOR_COOKIE) continue;
    let v = part.slice(eq + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* leave raw */
    }
    return UUID_RE.test(v) ? v : null;
  }
  return null;
}

// IP-keyed cost ceiling. Stops cookie-rotation bypass: an attacker
// spinning fresh neverr_visitor_id UUIDs per request gets a fresh
// "tts:visitor:<uuid>" bucket, so the per-visitor limiter alone would
// not cap their spend. The IP-keyed ceiling caps total ElevenLabs cost
// per source IP regardless of visitor identity. Sized 3× the per-visitor
// max to accommodate small-office NAT (a handful of legitimate users
// behind one egress IP) while still hard-capping abuse.
const TTS_IP_CEILING = TTS_RATE_LIMIT_PER_WINDOW * 3;

function ttsRateLimitedResponse(
  req: Request,
  res: Response,
  reason: "visitor" | "ip",
): void {
    const meta = extractRequestMeta(req);
  const visitor = readVisitorCookie(req);
  // express-rate-limit attaches per-request state at req.rateLimit.
  // Pull current/remaining/reset for forensics in the audit row.
  const rl = (req as Request & { rateLimit?: Record<string, unknown> })
    .rateLimit;
  auditLog({
    action: "chat.tts.rate_limited",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    success: false,
    details: {
      reason,
      visitor_id: visitor,
      endpoint: "/api/chat/tts",
      window_ms: TTS_RATE_LIMIT_WINDOW_MS,
      max: reason === "visitor" ? TTS_RATE_LIMIT_PER_WINDOW : TTS_IP_CEILING,
      // express-rate-limit v7 exposes req.rateLimit as
      // { limit, used, remaining, resetTime }. Earlier draft of this
      // file read `current`, which v6 used; v7 renamed to `used`.
      used: rl?.["used"] ?? null,
      limit: rl?.["limit"] ?? null,
      remaining: rl?.["remaining"] ?? null,
      reset_ms: rl?.["resetTime"]
        ? new Date(rl["resetTime"] as string | number | Date).getTime()
        : null,
    },
  });
  // express-rate-limit already set RateLimit-* + Retry-After headers
  // (standardHeaders: true). We just need to send the JSON body the
  // ChatWidget expects so it can render the "slow down" inline note.
  res.status(429).json({
    error: "rate_limited",
    message: "Too many voice requests — slow down and try again shortly.",
  });
}

const ttsVisitorLimiter = rateLimit({
  windowMs: TTS_RATE_LIMIT_WINDOW_MS,
  max: TTS_RATE_LIMIT_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    const visitor = readVisitorCookie(req);
    // No visitor cookie → key on IP under this limiter so unauthenticated
    // callers still get the per-visitor cap (the IP-ceiling limiter below
    // is the secondary, cookie-rotation-proof guard).
    return visitor ? `tts:visitor:${visitor}` : `tts:ip:${req.ip ?? "unknown"}`;
  },
  // express-rate-limit v7 emits a startup warning when keyGenerator
  // returns a raw req.ip (IPv6-collision concern). The recommended
  // workaround is the `ipKeyGenerator` helper, but the installed
  // version (7.5.1) doesn't export it as a named export in the ESM
  // build. Disabling validation silences the warning; IPv6 /64
  // collisions only matter for the IP fallback path, and the IP-ceiling
  // limiter below provides a second layer of cost containment.
  validate: false,
  handler: (req: Request, res: Response) =>
    ttsRateLimitedResponse(req, res, "visitor"),
});

// Hard ceiling: regardless of visitor cookie, no single IP may exceed
// TTS_IP_CEILING TTS calls per window. This is the defense against the
// cookie-rotation bypass (forge a fresh UUID per request → fresh visitor
// bucket but same IP bucket). Runs AFTER the visitor limiter in the
// chain because the visitor cap is the tighter normal-user constraint.
const ttsIpLimiter = rateLimit({
  windowMs: TTS_RATE_LIMIT_WINDOW_MS,
  max: TTS_IP_CEILING,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => `tts:ipcap:${req.ip ?? "unknown"}`,
  validate: false,
  handler: (req: Request, res: Response) =>
    ttsRateLimitedResponse(req, res, "ip"),
});

console.log(
  `[chat-tts] rate limits: ${TTS_RATE_LIMIT_PER_WINDOW}/visitor + ${TTS_IP_CEILING}/ip per ${TTS_RATE_LIMIT_WINDOW_MS}ms`,
);

router.post(
  "/chat/tts",
  ttsVisitorLimiter,
  ttsIpLimiter,
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const { text } = (req.body || {}) as { text?: unknown };

    if (
      typeof text !== "string" ||
      text.length === 0 ||
      text.length > TTS_MAX_TEXT
    ) {
      return res
        .status(400)
        .json({ error: `text required (1-${TTS_MAX_TEXT} chars)` });
    }

    const result = await synthesizeSpeech(text);

    if (!result.ok) {
      console.warn(
        "[chat-tts] synthesis failed:",
        result.status,
        result.reason.slice(0, 200),
      );
      auditLog({
        action: "chat.tts.synthesized",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        success: false,
        details: {
          chars: text.length,
          upstream_status: result.status,
          reason: result.reason.slice(0, 200),
        },
      });
      // 503 stays 503 (config error — distinct from upstream rejection so
      // ops can grep for it). Everything else collapses to 502 so the
      // frontend's "Alex's voice is offline" branch handles it uniformly.
      const status = result.status === 503 ? 503 : 502;
      return res.status(status).json({
        error: status === 503 ? "TTS not configured" : "TTS unavailable",
      });
    }

    const upstream = result.response;

    // Empty-body guard MUST run before the success audit so we don't
    // log success rows for failures (architect LOW #5).
    if (!upstream.body) {
      auditLog({
        action: "chat.tts.synthesized",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        success: false,
        details: { chars: text.length, reason: "empty body" },
      });
      return res.status(502).json({ error: "Empty TTS response body" });
    }

    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "audio/mpeg",
    );
    res.setHeader("Cache-Control", "no-store");
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);

    auditLog({
      action: "chat.tts.synthesized",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: true,
      details: { chars: text.length },
    });

    // Convert fetch's web ReadableStream → Node Readable so we can
    // pipe straight into the express Response. Node 18+ provides
    // Readable.fromWeb; api-server already relies on built-in fetch
    // (api.ts:596 etc.), so the same Node version covers this.
    Readable.fromWeb(upstream.body as never)
      .on("error", (err) => {
        console.warn("[chat-tts] stream error:", err.message);
        if (!res.headersSent) {
          res.status(502).json({ error: "Stream interrupted" });
        } else {
          res.end();
        }
      })
      .pipe(res);
    // Express handler signature requires every path to return; the pipe
    // above continues writing to `res` asynchronously after we return.
    return;
  },
);

export default router;
