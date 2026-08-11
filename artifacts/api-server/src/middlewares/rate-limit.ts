/**
 * Phase 5.6 commit 2 — two-limiter dispatch.
 *
 * userLimiter: 900 requests / 15 min per authenticated user, keyed on
 *              req.userId (set by resolveUserIdSoft upstream).
 *              Steady-state per dashboard user is ~90/15min (six
 *              polling loops at 30s + occasional page loads); 900
 *              gives 10x headroom so one heavy user can't self-DoS
 *              and only catches a runaway client-side loop.
 *
 * ipLimiter:   100 requests / 15 min per IP, keyed on req.ip. Applies
 *              to every request WITHOUT a resolved userId — anonymous
 *              login attempts, Twilio webhooks, ElevenLabs tool
 *              endpoints (Bearer ELEVENLABS_TOOL_SECRET, not a
 *              Supabase JWT), public marketing routes, and any
 *              authenticated request whose token failed to resolve.
 *              Matches the pre-5.6 generalLimiter budget; narrower
 *              scope now that authenticated users have their own
 *              bucket.
 *
 * Dispatcher chooses ONE limiter per request based on req.userId
 * presence. Every /api request is protected by exactly one bucket;
 * no path is unlimited.
 *
 * Custom handler on each limiter emits a structured console.warn AND
 * a Sentry captureMessage with level 'warning' so on-call sees a
 * paging signal when a single tenant sustains 429s. The pre-5.6
 * limiter had no handler — 429s were completely silent server-side.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import * as Sentry from "@sentry/node";

const WINDOW_MS = 15 * 60 * 1000;

// Exported so tests can override without hardcoding.
export const RATE_LIMIT_USER_MAX_DEFAULT = 900;
export const RATE_LIMIT_IP_MAX_DEFAULT = 100;

interface RateLimitLoggerMeta {
  key: string;
  path: string;
  method: string;
  ip: string | undefined;
  userId: string | null;
  activeBusinessId: string | null;
  userAgent: string;
}

/**
 * Emits a structured log line + a Sentry warning when a limiter
 * trips. Broken out so both handlers use identical shape, and so
 * tests can spy on it.
 */
export function reportRateLimitTripped(req: Request, key: string): void {
  const activeBiz = req.headers["x-active-business"];
  // When mounted at .use("/api", …) req.path is the mount-relative
  // path ("/echo") and req.baseUrl is the mount point ("/api"). Join
  // them so ops sees the full URL as sent by the client — matters
  // when filtering Sentry events by endpoint.
  const fullPath = `${req.baseUrl ?? ""}${req.path}`;
  const meta: RateLimitLoggerMeta = {
    key,
    path: fullPath,
    method: req.method,
    ip: req.ip,
    userId: req.userId ?? null,
    activeBusinessId:
      typeof activeBiz === "string"
        ? activeBiz
        : Array.isArray(activeBiz)
          ? activeBiz[0] ?? null
          : null,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200),
  };
  console.warn("[rate-limit] tripped", JSON.stringify(meta));
  try {
    Sentry.captureMessage("rate_limit_tripped", {
      level: "warning",
      tags: {
        rate_limit_key: key,
        // Path is high-cardinality but useful as a search filter in
        // Sentry. Sentry will hash long paths automatically.
        rate_limit_path: fullPath,
      },
      extra: meta,
    });
  } catch {
    // Sentry init may be gated on env var; never let a monitoring
    // failure surface to the caller.
  }
}

export interface CreateRateLimitersOptions {
  userMax?: number;
  ipMax?: number;
  windowMs?: number;
  // Test hook — overrides the default JSON body sent with the 429.
  // Production leaves it unset and gets the standard message.
  message?: unknown;
}

export interface RateLimiterBundle {
  userLimiter: RequestHandler;
  ipLimiter: RequestHandler;
  /**
   * Middleware that inspects req.userId and dispatches to
   * userLimiter or ipLimiter. Mount this after resolveUserIdSoft.
   */
  dispatch: RequestHandler;
}

export function createRateLimiters(
  opts: CreateRateLimitersOptions = {},
): RateLimiterBundle {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const userMax = opts.userMax ?? RATE_LIMIT_USER_MAX_DEFAULT;
  const ipMax = opts.ipMax ?? RATE_LIMIT_IP_MAX_DEFAULT;
  const message = opts.message ?? {
    error: "Too many requests, please try again later",
  };

  const userLimiter = rateLimit({
    windowMs,
    max: userMax,
    standardHeaders: true,
    legacyHeaders: false,
    // userId is guaranteed set at this point — the dispatcher only
    // routes here when it is. Fallback to `unknown` is belt-and-
    // suspenders so a bad dispatch mount can't create a shared
    // "undefined" bucket.
    keyGenerator: (req) => `user:${req.userId ?? "unknown"}`,
    message,
    handler: (req, res, _next, options) => {
      const key = `user:${req.userId ?? "unknown"}`;
      reportRateLimitTripped(req, key);
      res.status(options.statusCode).json(options.message);
    },
  });

  const ipLimiter = rateLimit({
    windowMs,
    max: ipMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ip:${req.ip ?? "unknown"}`,
    message,
    handler: (req, res, _next, options) => {
      const key = `ip:${req.ip ?? "unknown"}`;
      reportRateLimitTripped(req, key);
      res.status(options.statusCode).json(options.message);
    },
  });

  const dispatch: RequestHandler = (req, res, next) => {
    if (req.userId) return userLimiter(req, res, next);
    return ipLimiter(req, res, next);
  };

  return { userLimiter, ipLimiter, dispatch };
}
