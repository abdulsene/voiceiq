/**
 * Phase 5.6 commit 2 — soft userId resolver for rate-limit keying.
 *
 * ────────────────────────────────────────────────────────────────────
 *   DO NOT WIRE THIS INTO requireAuth OR ANY AUTHORIZATION PATH.
 * ────────────────────────────────────────────────────────────────────
 *
 * This module maintains a token→userId cache so the rate limiter can
 * dispatch per-user with sub-millisecond overhead. The cache is
 * intentionally NOT invalidated on session revocation — a token
 * revoked in Supabase will keep resolving to its old userId here for
 * up to CACHE_TTL_MS before it drops. That is FINE for rate-limit
 * accounting (a revoked user hitting our limits from a stolen token
 * still gets throttled; they just get throttled on the "wrong" bucket
 * name) but it is CATASTROPHIC for authorization decisions. If you're
 * tempted to reuse `resolveUserId` inside requireAuth to save the
 * Supabase round-trip, don't — the correctness gap is a security
 * bug waiting to happen.
 *
 * Design:
 *   - Cache: Map<token, {userId, expiresAt}>, 2-min TTL, 500-entry cap.
 *     Eviction is oldest-first (Map iteration = insertion order), not
 *     true LRU — close enough at 500 entries where activity churns
 *     within seconds.
 *   - Single-flight: while one Supabase call is in flight for a
 *     token, subsequent misses attach to the same promise instead of
 *     racing. Every process republish empties the cache while users
 *     are mid-session; without single-flight, 4 EZ-Rentals staff
 *     resuming their 30-second poll cycles all trigger simultaneous
 *     Supabase calls per token. With it, they collapse to one.
 *   - Middleware NEVER rejects: missing header, malformed token,
 *     Supabase failure — all fall through to next() without touching
 *     res. The downstream rate-limit dispatcher inspects req.userId
 *     to pick the user vs IP bucket.
 *
 * Scale note:
 *   500 entries × 4 people/tenant ≈ 125 tenants worth of active
 *   sessions cached. Fine at current scale. At 30 concurrent staff
 *   per tenant we'd want to raise the cap and/or switch to a real
 *   LRU. The 4-minute sweep interval is deliberately > TTL so at
 *   most one TTL-worth of stale entries can build up between sweeps
 *   even under low activity.
 */

import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const SWEEP_INTERVAL_MS = 4 * 60 * 1000;

interface CacheEntry {
  userId: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CacheEntry>();

// Single-flight registry — see module header for rationale.
const inflight = new Map<string, Promise<string | null>>();

let supabaseSingleton: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (supabaseSingleton) return supabaseSingleton;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  supabaseSingleton = createClient(url, key, {
    auth: { persistSession: false },
  });
  return supabaseSingleton;
}

function evictOldestIfFull(): void {
  if (tokenCache.size < CACHE_MAX_ENTRIES) return;
  // Map iteration is insertion order (ES2015+). First key is the
  // oldest INSERT, which is close-enough to LRU at this scale.
  const oldestKey = tokenCache.keys().next().value;
  if (oldestKey !== undefined) tokenCache.delete(oldestKey);
}

async function resolveUserId(token: string): Promise<string | null> {
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.userId;

  const existing = inflight.get(token);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const supabase = getSupabase();
      if (!supabase) return null;
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return null;
      const userId = data.user.id;
      evictOldestIfFull();
      tokenCache.set(token, {
        userId,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return userId;
    } catch {
      return null;
    } finally {
      inflight.delete(token);
    }
  })();
  inflight.set(token, promise);
  return promise;
}

/**
 * Express middleware. Sets req.userId if the Bearer token resolves to
 * a Supabase user. Never rejects — errors, missing headers, and
 * unresolved tokens all fall through to next() with req.userId
 * unset. Downstream rate-limit dispatcher branches on that.
 */
export async function resolveUserIdSoft(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return next();
  }
  const token = authHeader.slice(7).trim();
  if (!token) return next();
  try {
    const userId = await resolveUserId(token);
    if (userId) req.userId = userId;
  } catch {
    // resolveUserId already catches; belt-and-suspenders.
  }
  next();
}

// Periodic sweep so expired entries don't linger indefinitely under
// low activity. Interval > TTL by design — see module header.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenCache.entries()) {
    if (v.expiresAt <= now) tokenCache.delete(k);
  }
}, SWEEP_INTERVAL_MS).unref?.();

// ───────────────────────────────────────────────────────────────────────
// Test hooks — DO NOT import from production code.

/** @internal */
export function _tokenCacheSizeForTests(): number {
  return tokenCache.size;
}
/** @internal */
export function _clearTokenCacheForTests(): void {
  tokenCache.clear();
  inflight.clear();
  supabaseSingleton = null;
}
