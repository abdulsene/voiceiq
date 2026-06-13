/**
 * Trust-portal token issuance + verification.
 *
 * The customer-facing /r/<token> URL is signed with HS256. Claims:
 *   { lead_id, business_id, iat, version: 1, aud: 'trust_portal' }
 *
 * Why no exp: per Slice 3A design, tokens revoke via state changes,
 * not expiry. Two kill switches:
 *   - business_configs.trust_portal_disabled  (tenant-wide)
 *   - leads.trust_portal_disabled             (per-lead)
 * The route layer (routes/public-lead.ts) checks both before
 * returning data. A leaked URL works until one of those flips, or
 * the lead is hard-deleted (CASCADE on the FK nukes any reference).
 *
 * Tradeoff documented: leaked URLs persist longer than a typical
 * 30-day expiry would allow. Mitigation: when a customer reports a
 * leak, staff flip leads.trust_portal_disabled = true. Recovery is
 * one POST. Acceptable for first launch; revisit if a partner asks
 * for shorter-lived tokens.
 *
 * Secret rotation: regenerate TRUST_PORTAL_SIGNING_SECRET in Replit
 * Secrets → restart api-server. All existing tokens become invalid;
 * customers who held old /r/<token> links see the same 404 that a
 * disabled token does, with no user-visible diff. Staff can re-issue
 * via a future "re-send portal link" SMS template.
 */

import jwt from "jsonwebtoken";

const SIGN_ALGORITHM: jwt.Algorithm = "HS256";
const AUDIENCE = "trust_portal";
const TOKEN_VERSION = 1;

export interface TrustPortalClaims {
  lead_id: string;
  business_id: string;
  iat: number;
  version: number;
  aud: string;
}

function requireSecret(): string {
  const s = process.env.TRUST_PORTAL_SIGNING_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "TRUST_PORTAL_SIGNING_SECRET is required and must be ≥32 chars. Generate one with `openssl rand -hex 32` and add to Replit Secrets.",
    );
  }
  return s;
}

/**
 * Issue a fresh token for a given lead. Idempotent — call as many
 * times as you like; the same lead_id/business_id pair produces the
 * same token modulo iat (which changes per call). All tokens for the
 * lead are valid until the lead is deleted or a kill switch flips.
 */
export function signTrustToken(leadId: string, businessId: string): string {
  if (!leadId || !businessId) {
    throw new Error("signTrustToken: leadId and businessId are required");
  }
  return jwt.sign(
    { lead_id: leadId, business_id: businessId, version: TOKEN_VERSION },
    requireSecret(),
    {
      algorithm: SIGN_ALGORITHM,
      audience: AUDIENCE,
      // no expiresIn — revocation is state-driven, not time-driven.
    },
  );
}

/**
 * Verify a token. Returns the parsed claims on success, or null for
 * any failure mode (bad signature, malformed, wrong audience, wrong
 * version, missing fields). Callers should treat null as "404 not
 * found" — never leak the failure reason to the customer.
 */
export function verifyTrustToken(raw: string | null | undefined): TrustPortalClaims | null {
  if (!raw || typeof raw !== "string") return null;
  let secret: string;
  try {
    secret = requireSecret();
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = jwt.verify(raw, secret, {
      algorithms: [SIGN_ALGORITHM],
      audience: AUDIENCE,
    });
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const c = decoded as Record<string, unknown>;
  if (
    typeof c.lead_id !== "string" ||
    typeof c.business_id !== "string" ||
    typeof c.iat !== "number" ||
    c.version !== TOKEN_VERSION ||
    c.aud !== AUDIENCE
  ) {
    return null;
  }
  return {
    lead_id: c.lead_id,
    business_id: c.business_id,
    iat: c.iat,
    version: c.version,
    aud: c.aud,
  };
}
