/**
 * Phase 3.17 — invite token issuance + hashing.
 *
 * Design: we own the token. The raw token is what appears in the URL
 * (https://neverr.ai/invite/<token>); the DB stores only its SHA-256
 * hash. That way:
 *
 *   - A DB leak cannot replay outstanding invites (the hash is
 *     one-way; you'd need to brute-force 32 bytes of entropy).
 *   - Lookup is O(1) via a UNIQUE index on token_hash.
 *   - Comparison is constant-time-safe because we hash-then-equality
 *     rather than string-comparing the raw token against anything.
 *
 * The token itself is 32 bytes of cryptographically-random data
 * base64url-encoded (43 chars, no padding). That's ~190 bits — more
 * than enough that a scanner blindly guessing URLs cannot find a
 * valid one.
 *
 * Why crypto.randomBytes + Node crypto rather than jwt: this token
 * is a *bearer credential*, not a claims container. We don't need
 * business_id or role encoded in it — those live in the row we look
 * up by hash. Keeping the token opaque means we can rotate hashing
 * later without changing what's in emails already sent.
 */

import { randomBytes, createHash } from "crypto";

/**
 * Generate a fresh URL-safe token. 32 bytes of entropy -> 43 chars
 * of base64url (no padding). Do not modify without also considering:
 *   - Length bounds in acceptance-route parsers
 *   - Existing outstanding invites in the DB (they must keep working)
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256 hex of the raw token. Deterministic — same input, same
 * output. This is what we store in business_invites.token_hash and
 * what we look up by.
 *
 * Kept as a separate export so tests can precompute expected hashes
 * without importing randomBytes.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Convenience: issue one and return both the raw (for the email URL)
 * and the hash (for the DB write). Callers should NEVER log the raw
 * value — treat it like a password.
 */
export function issueInviteToken(): { raw: string; hash: string } {
  const raw = generateInviteToken();
  return { raw, hash: hashInviteToken(raw) };
}

/**
 * Default invite lifetime. 7 days matches the phase brief. Long
 * enough for a Monday-morning invite to survive a week's vacation,
 * short enough that a leaked email doesn't grant indefinite access.
 */
export const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Return an ISO timestamp representing now + INVITE_EXPIRY_MS.
 * Exposed as a helper (not just `new Date(Date.now() + ...)`) so
 * tests can mock it if a fake clock ever ships.
 */
export function inviteExpiryFromNow(now: Date = new Date()): string {
  return new Date(now.getTime() + INVITE_EXPIRY_MS).toISOString();
}
