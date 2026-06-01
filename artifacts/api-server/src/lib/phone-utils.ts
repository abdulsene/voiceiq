/**
 * Phone number utilities shared by the signup path (auth.ts) and
 * the admin provisioning endpoint (admin.ts).
 *
 * Kept narrow on purpose — anything more complex than format-tolerant
 * area-code extraction belongs in a dedicated PII / E.164 module.
 */

/**
 * Extract a 3-digit US area code from a phone number in any
 * reasonable format. Returns `null` if the input doesn't look like
 * a US number (after stripping non-digits, expect 10 digits, OR
 * 11 digits starting with `1`).
 *
 * Accepts string | null | undefined so callers don't have to pre-
 * guard — `req.body.phone_number` may be missing, and we'd rather
 * return null than throw on a falsy value.
 *
 * @example
 *   "443 708 7894"     → "443"
 *   "(443) 708-7894"   → "443"
 *   "+14437087894"     → "443"
 *   "1-443-708-7894"   → "443"
 *   "4437087894"       → "443"
 *
 *   ""                 → null
 *   undefined          → null
 *   "123"              → null  (too short)
 *   "abc"              → null  (no digits)
 *   "+44 20 7946 0958" → null  (UK; 11 digits but doesn't start with 1)
 */
export function extractAreaCodeFromPhoneNumber(
  input: string | null | undefined,
): string | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  const digits = input.replace(/\D/g, '');
  let us = digits;
  if (digits.length === 11 && digits.startsWith('1')) {
    us = digits.slice(1);
  }
  if (us.length !== 10) return null;
  return us.slice(0, 3);
}
