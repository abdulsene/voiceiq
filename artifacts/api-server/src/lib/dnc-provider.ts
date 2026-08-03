/**
 * Phase 5.1 — DNC provider abstraction.
 *
 * Federal National Do Not Call Registry scrubbing. Interface only in
 * this phase — the provider selection + credentials are DEFERRED
 * pending Abdul's legal-counsel decision on the "caller of record"
 * question under TCPA. That decision determines:
 *
 *   - Whether Neverr or the tenant is registered as a telemarketer.
 *   - Who pays the FTC's ~$96/area-code/year subscription (or
 *     picks a third-party service).
 *   - Who signs on the dotted line for the compliance certification.
 *
 * Until that lands, the pipeline uses NoOpDncProvider — every
 * scrub check returns "unknown, do not block on federal DNC." The
 * per-tenant dnc_list + voice_opt_outs still fire; only the
 * federal-registry consult is stubbed.
 *
 * When Abdul chooses a provider (likely a third-party like DNC.com
 * or Contact Center Compliance rather than direct FTC registration —
 * see Phase 5.0 §3 recommendation), add a concrete implementation
 * that satisfies DncProvider. No callers need to change.
 *
 * Provider is selected via environment variable
 * (DNC_PROVIDER='noop' | 'dnc_com' | ...) so ops can flip live
 * without a code change. Never hardcode — the identity of the
 * scrubbing party may vary per-tenant later.
 */

/** Individual scrub outcome. */
export interface DncScrubResult {
  phone: string;
  /**
   *   'listed'          — number is on the federal DNC (block).
   *   'clean'           — number is not on the registry.
   *   'wireless_unknown'— provider couldn't determine wireless vs
   *                       landline; caller should treat as blocked
   *                       for autodialer purposes if TCPA applies.
   *   'unknown'         — provider returned no useful signal
   *                       (typically NoOpDncProvider). Caller should
   *                       NOT rely on federal DNC status but still
   *                       consult voice_opt_outs + tenant dnc_list.
   */
  status: "listed" | "clean" | "wireless_unknown" | "unknown";
  /**
   *   Free-form provider notes (registry timestamp, jurisdictional
   *   flags — state DNC registries, known-litigator alerts, etc.).
   *   Persisted alongside the row for compliance audit.
   */
  notes?: string;
  /**
   *   Provider identifier so scrub records tell us later which
   *   service produced the result. Populated by the provider itself.
   */
  provider: string;
  scrubbed_at: string;  // ISO
}

/**
 * Provider surface — small enough that a NoOp is trivial and a
 * third-party integration is straightforward.
 *
 * Batch API kept intentionally simple (an array in, an array out).
 * Real providers rate-limit and batch server-side; the interface
 * doesn't force us to expose that plumbing to callers.
 */
export interface DncProvider {
  /** Provider identity string — 'noop' | 'dnc_com' | ... */
  readonly name: string;
  /**
   * Scrub one phone. E.164 in, DncScrubResult out. Never throws —
   * transport errors are represented as status='unknown' with a
   * notes explanation.
   */
  scrubOne(phone: string): Promise<DncScrubResult>;
  /**
   * Scrub a batch. Providers with a native batch API should override
   * this; the default (in the base class helper below) just maps
   * scrubOne over the array.
   */
  scrubBatch(phones: string[]): Promise<DncScrubResult[]>;
}

/**
 * NoOp implementation — the current default. Returns status='unknown'
 * for every phone. Callers that consult this provider MUST treat
 * unknown as "no signal from federal DNC" and fall back to the
 * per-tenant DNC + voice_opt_outs gates (which still enforce).
 *
 * Explicitly documented as a no-op so a future integration doesn't
 * silently replace this without ops knowing — see the ops-flip
 * checklist in migration 051's header.
 */
export class NoOpDncProvider implements DncProvider {
  readonly name = "noop";

  async scrubOne(phone: string): Promise<DncScrubResult> {
    return {
      phone,
      status: "unknown",
      notes: "DNC provider not configured — federal DNC scrub skipped. Per-tenant dnc_list + voice_opt_outs still enforce.",
      provider: this.name,
      scrubbed_at: new Date().toISOString(),
    };
  }

  async scrubBatch(phones: string[]): Promise<DncScrubResult[]> {
    // Provider-agnostic default. Sequential to avoid burst behaviour
    // any real provider would rate-limit. Fine for the NoOp path.
    const out: DncScrubResult[] = [];
    for (const p of phones) out.push(await this.scrubOne(p));
    return out;
  }
}

/**
 * Provider selector. Env-driven; DNC_PROVIDER defaults to 'noop'.
 * Adding a real provider is: implement DncProvider, add a case here.
 * No caller-side changes needed.
 */
let _provider: DncProvider | null = null;
export function getDncProvider(): DncProvider {
  if (_provider) return _provider;
  const kind = (process.env.DNC_PROVIDER || "noop").toLowerCase();
  switch (kind) {
    case "noop":
      _provider = new NoOpDncProvider();
      break;
    // Reserved for future integrations. Do NOT wire without Abdul's
    // caller-of-record decision.
    // case "dnc_com":
    //   _provider = new DncComProvider({ apiKey: process.env.DNC_COM_API_KEY! });
    //   break;
    default:
      console.warn(`[dnc-provider] unknown DNC_PROVIDER='${kind}' — falling back to noop`);
      _provider = new NoOpDncProvider();
  }
  return _provider;
}

/** Test injection seam — the singleton makes normal usage cache-friendly. */
export function _resetDncProviderForTests() {
  _provider = null;
}
