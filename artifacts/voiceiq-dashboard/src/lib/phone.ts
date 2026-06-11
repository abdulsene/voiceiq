/**
 * Tiny phone-number helpers shared between the customer dashboard's
 * transfer-settings UI and any future field that wants a "type-anywhere,
 * store-as-E.164" experience.
 *
 * Scope deliberately limited to NANP (+1 US/Canada). The customer base is
 * SMB North America; international support can land when there's demand
 * (would mean a libphonenumber-js dep — not worth the bundle weight yet).
 *
 * Conventions:
 *   - `parsePhoneToE164(raw)` returns `+1NNNNNNNNNN` when the input has
 *     exactly 10 NANP-shaped digits, OR `+NNNNN…` when the input already
 *     starts with + and has 7-15 digits, OR null when it can't be
 *     normalized. The 7-digit floor matches middlewares/validate.ts's
 *     regex on the server.
 *   - `formatPhoneForDisplay(e164)` pretty-prints a stored E.164 string
 *     as `+1 (NNN) NNN-NNNN` for NANP; non-NANP and malformed inputs
 *     fall through to the original string so nothing ever renders
 *     "undefined" to the customer.
 *
 * Both are pure / side-effect free.
 */

const NANP_DIGITS = 10;
const E164_MIN_DIGITS = 7;
const E164_MAX_DIGITS = 15;

/**
 * Strip everything except digits and a single leading +.
 */
function normalize(raw: string): string {
  const trimmed = raw.trim();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return hasLeadingPlus ? "+" + digits : digits;
}

/**
 * Accepts any of:
 *   "4437087894"           → "+14437087894"
 *   "443-708-7894"         → "+14437087894"
 *   "(443) 708-7894"       → "+14437087894"
 *   "1-443-708-7894"       → "+14437087894"   (11 digits leading with 1)
 *   "+14437087894"         → "+14437087894"
 *   "+447911123456"        → "+447911123456"  (non-NANP, passthrough)
 *   "x" or ""              → null
 *
 * Returns null for inputs that can't be unambiguously normalized to a
 * valid E.164 string. Caller should treat null as "not yet a phone."
 */
export function parsePhoneToE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const n = normalize(raw);
  if (!n) return null;

  // Already in E.164 shape — validate length.
  if (n.startsWith("+")) {
    const d = n.slice(1);
    if (d.length < E164_MIN_DIGITS || d.length > E164_MAX_DIGITS) return null;
    return n;
  }

  // Bare digits. Two NANP shapes are recognized:
  //   - 10 digits → assume US/Canada, prepend +1
  //   - 11 digits starting with 1 → already includes country code
  if (n.length === NANP_DIGITS) {
    return "+1" + n;
  }
  if (n.length === NANP_DIGITS + 1 && n.startsWith("1")) {
    return "+" + n;
  }

  // Anything else is ambiguous — could be a partial NANP (still typing),
  // could be a malformed international. Bail.
  return null;
}

/**
 * Pretty-print an E.164 string for display. NANP gets the conventional
 * `+1 (NNN) NNN-NNNN` shape; anything else falls through to the raw
 * input. Never throws; never returns undefined.
 */
export function formatPhoneForDisplay(e164: string | null | undefined): string {
  if (!e164) return "";
  const trimmed = e164.trim();
  if (!trimmed) return "";
  // NANP: +1 followed by 10 digits
  if (trimmed.startsWith("+1") && trimmed.length === 12) {
    const d = trimmed.slice(2);
    if (/^\d{10}$/.test(d)) {
      return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    }
  }
  return trimmed;
}

/**
 * "Is this a complete, valid phone number we'd be willing to PUT to the
 * server?" — used to gate Save in the TransferTab. Strict: parses must
 * succeed AND the result must start with + AND have ≥ E164_MIN_DIGITS.
 * Server runs the same regex (`/^\+?[1-9]\d{1,14}$/`) but the UX wants
 * to disable Save before the user can fire a 400.
 */
export function isPhoneE164Valid(raw: string | null | undefined): boolean {
  const parsed = parsePhoneToE164(raw);
  if (!parsed) return false;
  // Same regex shape the server uses (middlewares/validate.ts) — leading +
  // followed by 1-9 then 6-14 more digits. parsePhoneToE164 already
  // enforces length and shape; this final check is defense-in-depth.
  return /^\+[1-9]\d{6,14}$/.test(parsed);
}

/**
 * Compare two phones for "same underlying number" — ignores formatting
 * differences. Used by the loop guard hint client-side so a customer
 * who types "(443) 331-4649" while their Twilio number is stored as
 * "+14433314649" still sees the pre-save warning instead of slamming
 * into a 400. Server-side loop guard does the same digits-only
 * comparison.
 */
export function phonesEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  if (!da || !db) return false;
  // Match on the last 10 digits when both have at least that many — covers
  // "+14433314649" ↔ "4433314649" ↔ "1 443 331 4649" without false-positiving
  // on totally different numbers that happen to share short suffixes.
  if (da.length >= 10 && db.length >= 10) {
    return da.slice(-10) === db.slice(-10);
  }
  return da === db;
}
