/**
 * PII redaction for ElevenLabs / OpenAI Realtime call transcripts in the
 * voiceiq-engine server.
 *
 * Why this exists:
 *   /enterprise and /industries marketing pages claim "HIPAA-conscious by
 *   design — minimizes PHI on the line". Saturday wired the api-server
 *   ingestion paths through PIIProcessor; the engine has its own ingestion
 *   paths (POST /api/lead, POST /webhook/elevenlabs, handleCallEnd) that
 *   were silently bypassing redaction. Same compliance claim covers them.
 *
 * Why this is duplicated from artifacts/api-server/src/security/pii.ts +
 * artifacts/api-server/src/lib/pii-redact-transcript.ts:
 *   - Engine is plain-JS ESM, separate package, separate Supabase client,
 *     no shared TypeScript build, no FieldEncryption infra.
 *   - Importing across artifact boundaries would require pulling in the
 *     entire api-server compile graph.
 *   - Spec explicitly allows "acceptable duplication for security-critical
 *     code". The regex patterns are copied verbatim from
 *     api-server/src/security/pii.ts so detection behaviour stays in sync.
 *     If you change patterns there, mirror them here.
 *
 * Scope (intentional):
 *   - Only the transcript TEXT field is redacted. Operational columns
 *     (caller_name, caller_number, lead_data) stay raw — they power the
 *     product (callbacks, SMS follow-up, dedup). Inline mentions of names
 *     / phones inside the transcript text DO still get redacted.
 *   - No encryption-at-rest of redacted instances (engine has no
 *     FieldEncryption module — that lives in api-server only). The
 *     api-server PII pipeline retains full encrypt-at-rest for compliance
 *     "unredact" flows; engine just redacts.
 *
 * Audit:
 *   Engine has no audit_logs writer — it logs to stdout. Every redaction
 *   emits a `[pii]` prefixed structured console line so ops can grep.
 *   Never throws (the webhook handler MUST keep working even if redaction
 *   misbehaves — dropping a call entirely is strictly worse than
 *   persisting a non-redacted row).
 *
 * Kill switch:
 *   PII_REDACTION_MODE=off bypasses redaction (still logs that it
 *   bypassed, so investigations have a paper trail).
 */

const BASE_CONFIDENCE = {
  email: 0.95,
  ssn: 0.95,
  phone: 0.9,
  credit_card: 0.9,
  date_of_birth: 0.8,
  address: 0.75,
  name: 0.6,
};

const REDACTION = {
  phone: '***-***-****',
  email: '***@***.***',
  ssn: '***-**-****',
  credit_card: '****-****-****-****',
  address: '[REDACTED-ADDRESS]',
  name: '[REDACTED-NAME]',
  date_of_birth: '**/**/****',
};

// Patterns must be created fresh per call (global flag is stateful) so
// they're built inside the function, not stored.
function patterns() {
  return {
    phone:
      /(?<!\d)(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]?\d{4}(?!\d)/g,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    ssn: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
    credit_card:
      /\b(?:4\d{3}([-\s]?)\d{4}\1\d{4}\1\d{4}|5[1-5]\d{2}([-\s]?)\d{4}\2\d{4}\2\d{4}|3[47]\d{2}([-\s]?)\d{6}\3\d{5}|6(?:011|5\d{2})([-\s]?)\d{4}\4\d{4}\4\d{4})\b/g,
    address:
      /\b\d{1,6}\s+(?:[A-Z][A-Za-z0-9.'-]{0,20}\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Highway|Hwy)\b\.?/g,
    name: /\b[A-Z][a-z]{1,15}\s+[A-Z][a-z]{1,15}\b/g,
    date_of_birth:
      /\b(?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12][0-9]|3[01])[-/](?:19|20)\d{2}\b/g,
  };
}

/**
 * Detect PII without redacting. Returns array of {type, instances, count, confidence}.
 * Exported for tests + future analytics.
 */
export function detectPII(text) {
  if (!text) return [];
  const out = [];
  const pats = patterns();
  for (const [type, pattern] of Object.entries(pats)) {
    const matches = Array.from(text.matchAll(pattern));
    if (matches.length === 0) continue;
    out.push({
      type,
      instances: matches.map((m) => m[0]),
      count: matches.length,
      confidence: BASE_CONFIDENCE[type] ?? 0.7,
    });
  }
  return out;
}

/**
 * Redact in priority order (most specific first) so a phone match inside
 * a longer "name" line isn't double-counted by the name pattern.
 */
export function redactPII(text) {
  if (!text) return { original: text, redacted: text, detections: [] };
  const order = [
    'credit_card',
    'ssn',
    'email',
    'phone',
    'date_of_birth',
    'address',
    'name',
  ];
  const detections = [];
  let redacted = text;
  const pats = patterns();
  for (const type of order) {
    const matches = Array.from(redacted.matchAll(pats[type]));
    if (matches.length === 0) continue;
    detections.push({
      type,
      instances: matches.map((m) => m[0]),
      count: matches.length,
      confidence: BASE_CONFIDENCE[type],
    });
    redacted = redacted.replace(pats[type], REDACTION[type]);
  }
  return { original: text, redacted, detections };
}

// ---------------------------------------------------------------------------
// Per-business pii_handling lookup (mirrors api-server/src/lib/pii-redact-transcript.ts)
//
// Migration 016 adds business_configs.pii_handling TEXT NOT NULL DEFAULT
// 'minimize' CHECK ('minimize' | 'off'). resolveRedactionMode() consults
// this column first, then PII_REDACTION_MODE env, then defaults to
// 'minimize'.
//
// 60s in-memory cache keeps the hot webhook/sync path off the DB. DB
// errors fall through to env/default — never throw, never crash
// ingestion (better to persist a redacted-by-default row than drop the
// call).
// ---------------------------------------------------------------------------
import { getClient as defaultGetClient } from '../db.js';

const PII_HANDLING_CACHE_TTL_MS = 60_000;
const _piiHandlingCache = new Map();

let _clientOverride; // undefined = real, null = "not configured", object = stub
export function _setSupabaseGetterForTests(client) {
  _clientOverride = client;
}
function getClientForLookup() {
  if (_clientOverride !== undefined) return _clientOverride;
  return defaultGetClient();
}

/** @internal exported for tests */
export function _resetPiiHandlingCache() {
  _piiHandlingCache.clear();
}

async function lookupBusinessPiiHandling(businessId) {
  const now = Date.now();
  const cached = _piiHandlingCache.get(businessId);
  if (cached && cached.expires > now) return cached.mode;

  const sb = getClientForLookup();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from('business_configs')
      .select('pii_handling')
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) {
      console.error(
        `[pii] business_configs.pii_handling lookup failed for ${businessId} — falling back to env. err=${error.message ?? error.code ?? 'unknown'}`,
      );
      return null;
    }
    if (!data || data.pii_handling == null) return null;
    const raw = String(data.pii_handling).toLowerCase();
    const mode = raw === 'off' ? 'off' : 'minimize';
    _piiHandlingCache.set(businessId, { mode, expires: now + PII_HANDLING_CACHE_TTL_MS });
    return mode;
  } catch (err) {
    console.error(
      `[pii] business_configs.pii_handling threw for ${businessId} — falling back to env. err=${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * Resolve the redaction mode for a given business.
 *
 * Resolution chain (first hit wins):
 *   1. business_configs.pii_handling for the given business_id (cached 60s)
 *   2. PII_REDACTION_MODE env var (global kill switch / override)
 *   3. 'minimize' (HIPAA-conservative default — opt-out, not opt-in)
 *
 * Async because step 1 hits Supabase. DB errors fall through to env/default,
 * never throw.
 */
export async function resolveRedactionMode(businessId) {
  if (businessId) {
    const businessMode = await lookupBusinessPiiHandling(businessId);
    if (businessMode) return businessMode;
  }
  const env = (process.env.PII_REDACTION_MODE || 'minimize').toLowerCase();
  if (env === 'off') return 'off';
  return 'minimize';
}

/**
 * Redact a call transcript before persistence. Safe to call with empty /
 * null input. Never throws — failure to redact returns the original text
 * and logs the error (better to persist raw than drop the call).
 *
 * @param {string|null|undefined} rawTranscript
 * @param {{ businessId?: string|null, source: 'webhook'|'lead'|'sync', conversationId?: string|null }} ctx
 * @returns {Promise<{ redactedText: string, originalLength: number, redactedLength: number, redactionCount: number, byType: Record<string, number>, mode: 'minimize'|'off' }>}
 */
export async function redactCallTranscript(rawTranscript, ctx) {
  const text = rawTranscript || '';
  const businessId = ctx?.businessId || null;
  const source = ctx?.source || 'unknown';
  const conversationId = ctx?.conversationId || null;
  const mode = await resolveRedactionMode(businessId);

  // Empty input → no work, no audit (would just spam logs).
  if (text.length === 0) {
    return {
      redactedText: text,
      originalLength: 0,
      redactedLength: 0,
      redactionCount: 0,
      byType: {},
      mode,
    };
  }

  // Mode 'off' → passthrough but STILL log so investigators see that
  // the transcript flowed through the redaction layer with the kill
  // switch on (matches Saturday's pattern in api-server).
  if (mode === 'off') {
    console.warn(
      `[pii] mode=off — passing transcript through unredacted (source=${source} conv=${conversationId ?? 'n/a'} chars=${text.length})`,
    );
    return {
      redactedText: text,
      originalLength: text.length,
      redactedLength: text.length,
      redactionCount: 0,
      byType: {},
      mode,
    };
  }

  // mode === 'minimize'
  let result;
  try {
    result = redactPII(text);
  } catch (err) {
    console.error(
      `[pii] redactPII threw — falling back to raw text. source=${source} conv=${conversationId ?? 'n/a'} err=${err?.message ?? err}`,
    );
    return {
      redactedText: text,
      originalLength: text.length,
      redactedLength: text.length,
      redactionCount: 0,
      byType: {},
      mode,
    };
  }

  const byType = {};
  let total = 0;
  for (const det of result.detections) {
    byType[det.type] = (byType[det.type] ?? 0) + det.count;
    total += det.count;
  }

  console.log(
    `[pii] redacted source=${source} conv=${conversationId ?? 'n/a'} business=${businessId ?? 'n/a'} count=${total} types=${Object.keys(byType).join(',') || 'none'} chars=${text.length}->${result.redacted.length}`,
  );

  return {
    redactedText: result.redacted,
    originalLength: text.length,
    redactedLength: result.redacted.length,
    redactionCount: total,
    byType,
    mode,
  };
}
