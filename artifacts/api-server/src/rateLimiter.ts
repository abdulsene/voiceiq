// In-memory rate limiter and global caps.
// Single-instance only (state is process-local).
// For multi-instance deployment, replace with Redis-backed implementation.

import rateLimit from "express-rate-limit";

// Sprint 1 BUG-17 sub-step 3f: extracted from app.ts so per-route handlers
// in routes/api.ts can apply costlyLimiter directly. Same 5-req-per-minute
// budget as the original definition — single shared instance, no class drift.
// Used by /api/onboard (provisions a real ElevenLabs agent + scrapes a
// website, so anonymous abuse would be a denial-of-wallet vector).
export const costlyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Rate limit exceeded for this action, please wait" },
});

interface BucketEntry {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, BucketEntry>();
const globalCounters = new Map<string, BucketEntry>();
const locks = new Map<string, number>();

export function ipRateLimit(
  ip: string,
  scope: string,
  maxCalls: number,
  windowMs: number,
): { allowed: boolean; remaining: number; resetAt: number } {
  const key = `${scope}:${ip}`;
  const now = Date.now();
  const entry = ipBuckets.get(key);

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + windowMs;
    ipBuckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxCalls - 1, resetAt };
  }

  if (entry.count >= maxCalls) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxCalls - entry.count, resetAt: entry.resetAt };
}

export function globalDailyCap(
  scope: string,
  maxCalls: number,
): { allowed: boolean; used: number; resetAt: number } {
  const now = Date.now();
  const entry = globalCounters.get(scope);
  const oneDayMs = 24 * 60 * 60 * 1000;

  if (!entry || entry.resetAt <= now) {
    const resetAt = now + oneDayMs;
    globalCounters.set(scope, { count: 1, resetAt });
    return { allowed: true, used: 1, resetAt };
  }

  if (entry.count >= maxCalls) {
    return { allowed: false, used: entry.count, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, used: entry.count, resetAt: entry.resetAt };
}

export function tryAcquireLock(key: string, ttlMs = 120_000): boolean {
  const now = Date.now();
  const existing = locks.get(key);
  if (existing && existing > now) {
    return false;
  }
  locks.set(key, now + ttlMs);
  return true;
}

export function releaseLock(key: string): void {
  locks.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipBuckets.entries()) {
    if (v.resetAt <= now) ipBuckets.delete(k);
  }
  for (const [k, v] of globalCounters.entries()) {
    if (v.resetAt <= now) globalCounters.delete(k);
  }
  for (const [k, expireAt] of locks.entries()) {
    if (expireAt <= now) locks.delete(k);
  }
}, 5 * 60 * 1000).unref?.();
