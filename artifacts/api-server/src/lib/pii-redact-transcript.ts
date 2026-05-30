/**
 * PII redaction wrapper for ElevenLabs call transcripts.
 *
 * Why this exists:
 *   /enterprise and /industries pages claim "HIPAA-conscious by design —
 *   minimizes PHI on the line". Until tonight that was aspirational — the
 *   PIIProcessor at src/security/pii.ts existed but was wired only into
 *   the ad-hoc /api/security/pii/{detect,redact} endpoints in
 *   routes/enterprise.ts. This module pipes every ElevenLabs transcript
 *   through PIIProcessor BEFORE it lands in the `calls.transcript`
 *   column.
 *
 * Scope (intentional):
 *   - Only the transcript TEXT is redacted. Operational columns
 *     (caller_name, caller_number) stay raw — they are required for
 *     callbacks, SMS follow-up, and contact-deduplication. Stripping
 *     them would break the product. Inline mentions of names / phones
 *     inside the transcript text DO still get redacted (Claude tends to
 *     repeat the name back to the caller, so the same PII often appears
 *     in both places).
 *   - Encryption-at-rest of redacted instances is intentionally NOT
 *     persisted yet. The encrypted blobs returned by PIIProcessor.redactPII()
 *     are useful for "unredact for compliance request" flows (covered by
 *     the compliance/government-access route in routes/enterprise.ts).
 *     The `calls` table doesn't have a column for them; adding one is
 *     out of scope tonight (would require a migration).
 *
 * Configurability — TODO surfaced to product:
 *   The task spec asked for "use existing business_configs.pii_handling
 *   field if it exists". It does NOT exist. The closest field is
 *   industry_templates.compliance_requirements (JSONB) which is keyed
 *   by industry_code, not business_id. Recommendation deferred to
 *   product:
 *     A) Add business_configs.pii_handling TEXT DEFAULT 'minimize'
 *     B) Or join through industry_templates and check
 *        compliance_requirements.pii_redaction
 *   For now: default-ON globally with an env-var kill switch
 *   PII_REDACTION_MODE=off (for emergency disable, e.g. if a customer
 *   reports redactions breaking their workflow). This is the conservative
 *   HIPAA stance — opt-out, not opt-in.
 *
 * Audit:
 *   Every redaction emits a `pii.processed` audit log via auditLog().
 *   audit_logs may be missing in dev — auditLog() catches that and
 *   logs to console.error, no crash. We additionally console.log every
 *   redaction so dev visibility is preserved without grepping audit_logs.
 */

import { PIIProcessor } from "../security/pii.js";
import { auditLog } from "../middlewares/audit.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type PIIRedactionMode = "minimize" | "off";

// ---------------------------------------------------------------------------
// Per-business pii_handling lookup
//
// Migration 016 adds business_configs.pii_handling TEXT NOT NULL DEFAULT
// 'minimize' CHECK ('minimize' | 'off'). resolveRedactionMode() consults
// this column first, then PII_REDACTION_MODE env, then defaults to
// 'minimize'.
//
// The lookup is on the hot ingestion path (every webhook + every sync
// poll), so we cache per-business decisions for 60s. The cache is
// process-local (no Redis) — fine because ingestion is sticky to one
// api-server instance per call, and a 60s window of staleness is
// acceptable for an admin-toggled compliance setting.
//
// On any DB error (column missing in dev, network blip, RLS surprise)
// we return null and let the env/default chain take over. We never
// throw — dropping a webhook because business_configs is unhappy is
// strictly worse than persisting a redacted-by-default row.
// ---------------------------------------------------------------------------
const PII_HANDLING_CACHE_TTL_MS = 60_000;
const _piiHandlingCache = new Map<string, { mode: PIIRedactionMode; expires: number }>();

let _supabase: SupabaseClient | null = null;
function defaultGetSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

// Test-only override hook. `undefined` = use real getter; `null` = simulate
// "supabase not configured"; a stubbed client = simulate DB responses.
let _supabaseOverride: SupabaseClient | null | undefined = undefined;
export function _setSupabaseGetterForTests(client: SupabaseClient | null | undefined): void {
  _supabaseOverride = client;
}
function getSupabaseForLookup(): SupabaseClient | null {
  if (_supabaseOverride !== undefined) return _supabaseOverride;
  return defaultGetSupabase();
}

/** @internal exported for tests */
export function _resetPiiHandlingCache(): void {
  _piiHandlingCache.clear();
}

async function lookupBusinessPiiHandling(businessId: string): Promise<PIIRedactionMode | null> {
  const now = Date.now();
  const cached = _piiHandlingCache.get(businessId);
  if (cached && cached.expires > now) return cached.mode;

  const sb = getSupabaseForLookup();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("business_configs")
      .select("pii_handling")
      .eq("business_id", businessId)
      .maybeSingle();
    if (error) {
      // Column missing in dev (migration 016 not yet applied) surfaces here
      // with code 42703 / message "column ... does not exist". Don't cache
      // — caller will fall through to env/default and we want to pick up
      // the column the moment migration runs.
      console.error(
        `[PII] business_configs.pii_handling lookup failed for ${businessId} — falling back to env. err=${error.message ?? error.code ?? "unknown"}`,
      );
      return null;
    }
    if (!data || data.pii_handling == null) {
      // Row missing or column null → no per-business override. Cache the
      // null-decision as 'minimize' would be wrong (env might say 'off');
      // skip caching, falls through to env on each call (cheap once
      // migration 016 fills the default for every row).
      return null;
    }
    const raw = String(data.pii_handling).toLowerCase();
    const mode: PIIRedactionMode = raw === "off" ? "off" : "minimize";
    _piiHandlingCache.set(businessId, { mode, expires: now + PII_HANDLING_CACHE_TTL_MS });
    return mode;
  } catch (err: any) {
    console.error(
      `[PII] business_configs.pii_handling threw for ${businessId} — falling back to env. err=${err?.message ?? err}`,
    );
    return null;
  }
}

export interface RedactionSummary {
  /** Final text to persist. Equal to the input when mode === "off". */
  redactedText: string;
  /** Length of the original text (chars). */
  originalLength: number;
  /** Length after redaction (chars). May be longer if placeholders are. */
  redactedLength: number;
  /** Total PII instances replaced (sum across all PII types). */
  redactionCount: number;
  /** Per-type breakdown — useful for compliance dashboards. */
  byType: Record<string, number>;
  /** The mode that was actually applied. */
  mode: PIIRedactionMode;
}

/**
 * Single shared instance — PIIProcessor is stateless across calls (its
 * regex patterns are rebuilt per .detectPII() / .redactPII() invocation
 * to avoid `g` flag lastIndex bugs), so a singleton is safe.
 */
let _processor: PIIProcessor | null = null;
function processor(): PIIProcessor {
  if (!_processor) _processor = new PIIProcessor();
  return _processor;
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
 * never throw — see lookupBusinessPiiHandling() for the rationale.
 *
 * @internal exported for tests
 */
export async function resolveRedactionMode(businessId: string | null | undefined): Promise<PIIRedactionMode> {
  if (businessId) {
    const businessMode = await lookupBusinessPiiHandling(businessId);
    if (businessMode) return businessMode;
  }
  const env = (process.env.PII_REDACTION_MODE || "minimize").toLowerCase();
  if (env === "off") return "off";
  return "minimize";
}

/**
 * Redact PII from a call transcript and emit an audit event. Safe to call
 * with empty / null input — returns an empty summary.
 *
 * Never throws — failure to audit is swallowed (audit table may be
 * missing in dev), failure to redact returns the original text and logs
 * the error. The webhook handler MUST keep working even when this helper
 * misbehaves.
 */
export async function redactCallTranscript(
  rawTranscript: string | null | undefined,
  ctx: {
    businessId?: string | null;
    /** Where this call came from — "webhook" | "lead" | "sync" — for audit. */
    source: "webhook" | "lead" | "sync";
    /** ElevenLabs conversation id, if known — included in audit details. */
    conversationId?: string | null;
  },
): Promise<RedactionSummary> {
  const text = rawTranscript || "";
  const businessId = ctx.businessId || null;
  const mode = await resolveRedactionMode(businessId);

  // Empty input → no work, no audit (would just spam audit_logs).
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

  // Mode "off" → straight passthrough. Emit audit + console so the
  // control plane has a complete record of every transcript that flowed
  // through the redaction layer, including ones that bypassed redaction
  // because the kill-switch was on. Without this, "why is PHI in the DB?"
  // investigations would have to reason from absence-of-evidence.
  if (mode === "off") {
    console.warn(
      `[PII] mode=off — passing transcript through unredacted (source=${ctx.source} conv=${ctx.conversationId ?? "n/a"} chars=${text.length})`,
    );
    void auditLog({
      businessId: businessId || undefined,
      action: "pii.processed",
      resource: "calls",
      resourceId: ctx.conversationId || undefined,
      success: true,
      details: {
        source: ctx.source,
        mode,
        originalLength: text.length,
        redactedLength: text.length,
        redactionCount: 0,
        byType: {},
      },
      complianceFlags: ["PII-REDACTION", "HIPAA-candidate"],
    });
    return {
      redactedText: text,
      originalLength: text.length,
      redactedLength: text.length,
      redactionCount: 0,
      byType: {},
      mode,
    };
  }

  // Default: minimize.
  let result;
  try {
    result = processor().redactPII(text);
  } catch (err: any) {
    // Never let a regex bug or encryption failure block the webhook
    // response — that would mean dropping the call entirely, which is
    // strictly worse than persisting a non-redacted row.
    console.error(
      `[PII] redactPII threw — falling back to raw text. source=${ctx.source} conv=${ctx.conversationId ?? "n/a"} err=${err?.message ?? err}`,
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

  const byType: Record<string, number> = {};
  let total = 0;
  for (const det of result.detections) {
    byType[det.type] = (byType[det.type] ?? 0) + det.count;
    total += det.count;
  }

  // Visible at the dev console — auditLog() may silently drop in dev if
  // audit_logs is missing.
  console.log(
    `[PII] redacted source=${ctx.source} conv=${ctx.conversationId ?? "n/a"} business=${businessId ?? "n/a"} count=${total} types=${Object.keys(byType).join(",") || "none"}`,
  );

  // Fire-and-forget audit. auditLog handles its own errors and never throws.
  void auditLog({
    businessId: businessId || undefined,
    action: "pii.processed",
    resource: "calls",
    resourceId: ctx.conversationId || undefined,
    success: true,
    details: {
      source: ctx.source,
      mode,
      originalLength: text.length,
      redactedLength: result.redacted.length,
      redactionCount: total,
      byType,
    },
    complianceFlags: ["PII-REDACTION", "HIPAA-candidate"],
  });

  return {
    redactedText: result.redacted,
    originalLength: text.length,
    redactedLength: result.redacted.length,
    redactionCount: total,
    byType,
    mode,
  };
}
