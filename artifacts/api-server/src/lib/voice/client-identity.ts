/**
 * Phase 3.3a — single source of truth for the Twilio Client identity
 * that a (user_id, business_id) pair registers under.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Why per-MEMBERSHIP, not per-user (Phase 3.3a correction of 3.3):
 *
 * Phase 3.3 (commit fd5b544) shipped a per-USER identity
 * (`user_<uuid_hex>`). Verified in prod: 40 user_businesses rows, 38
 * distinct identities, 2 users with dual memberships shared an
 * identity across tenants.
 *
 * Twilio's `<Client><Identity>X</Identity></Client>` is a GLOBAL
 * address — the account has no tenant scoping. Under the 3.3 formula
 * a dual-tenant user's browser would ring for BOTH businesses'
 * inbound calls, showing the OTHER tenant's topic name in the banner
 * (topic_name is a Client CustomParameter — sent by whichever biz
 * initiated the dial). That's a cross-tenant data leak in the UI,
 * not just a routing miss.
 *
 * Fix: bake the business_id into the identity as a stable 12-hex-char
 * suffix. Same (user, biz) always produces the same identity so the
 * token endpoint and the routing candidate query agree; different biz
 * for the same user produces a different identity so the two Devices
 * register independently and receive only their own tenant's calls.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Constraints the formula must satisfy:
 *
 *   1. Deterministic — recomputable from (user_id, business_id) alone
 *      so the token endpoint can derive it from JWT + active-biz
 *      header without a DB roundtrip.
 *   2. NOT using user_businesses.id — that's a uuid, would break
 *      recomputability from (user_id, business_id).
 *   3. Twilio Client identity: matches [a-zA-Z0-9_.-]+ up to 121
 *      chars. Our shape: `user_<32hex>__<12hex>` = 5 + 32 + 2 + 12 =
 *      51 chars. Well within limits, only [a-z0-9_] characters.
 *   4. Business_id in this codebase is TEXT (see user_businesses
 *      column type), not UUID — could be a slug like "ez-rentals" or
 *      a uuid. md5 hashing normalizes to fixed-width hex either way
 *      AND avoids leaking readable tenant identifiers to anyone who
 *      inspects a client-side JS bundle or Twilio Console log.
 *   5. Collision resistance: 12 hex chars = 48 bits = ~2.8e14
 *      unique suffixes per user. Birthday-bound at ~1.7e7 memberships
 *      per user before ~50% collision odds; irrelevant at real scale.
 *
 * ─────────────────────────────────────────────────────────────────────
 * MUST stay in sync with migration 043's DDL formula. If you change
 * one, change the other. There is a smoke test asserting the two
 * agree — `buildClientIdentity` values equal what the migration
 * writes.
 */

import { createHash } from "node:crypto";

/**
 * The exact formula, in one place. Backfill SQL, the token endpoint,
 * the team-invite row-creation path — all read from here.
 *
 *   user_<user_uuid_hex_no_dashes>__<md5(business_id)[0:12]>
 *
 * Example (user 4faa..., biz "ez-rentals"):
 *   user_4faa8c0c7c8b4f2a9d1e3f5a6b7c8d9e__1e0f2a3b4c5d
 */
export function buildClientIdentity(userId: string, businessId: string): string {
  const normalizedUser = String(userId).replace(/-/g, "");
  const bizSuffix = createHash("md5").update(String(businessId)).digest("hex").slice(0, 12);
  return `user_${normalizedUser}__${bizSuffix}`;
}

/**
 * Extract the `user_<uuid_hex>` portion from an identity, without
 * assuming any particular suffix. Useful for logging / audits where
 * we want the user segment but the routing engine's authoritative
 * identity resolution goes through user_businesses.client_identity
 * directly (matches on the full string).
 *
 * Returns null for anything that doesn't look like our identity shape.
 */
export function parseClientIdentityUserSegment(identity: string): string | null {
  const m = /^(user_[0-9a-f]{32})__[0-9a-f]{12}$/i.exec(identity);
  return m ? m[1] : null;
}
