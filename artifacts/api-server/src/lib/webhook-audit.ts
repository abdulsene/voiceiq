/**
 * Phase 6.8 — webhook-shape audit.
 *
 * Every Twilio-facing or ElevenLabs-tool endpoint MUST be listed in
 * AUTH_BYPASS_PATTERNS or gatewayAuth returns 401 BEFORE the handler
 * runs, silently dropping data. This has bitten us twice — the two
 * Phase 6.4 callbacks (dial-fallback-record-done, dial-fallback-transcript)
 * shipped without entries and produced six lost voicemails on
 * 2026-08-15 before we caught it.
 *
 * This module provides:
 *   1. `isWebhookShapedPath` — pure classifier for what needs a bypass entry.
 *   2. `findMissingBypassEntries` — audit result given a path list.
 *   3. `enumerateRoutePaths` — Express 5 router-stack walker.
 *
 * The startup assertion in app.ts uses all three at boot to fail loud
 * if a webhook is registered without a matching bypass pattern. The
 * companion smoke test (tests/098-webhook-bypass-audit-smoke.ts) uses
 * the same helpers against the imported apiRouter for CI-parity.
 *
 * Pure — no I/O, no logging.
 */

/**
 * Path prefixes that identify webhook-shape routes. Every route
 * beginning with one of these is treated as external-webhook and
 * required to be bypass-listed. Additions here should be rare and
 * accompanied by a code comment naming the caller.
 */
export const WEBHOOK_PATH_PREFIXES: readonly string[] = [
  "/api/twilio/",   // Twilio inbound + all status callbacks
  "/api/routing/",  // Twilio Dial callbacks + ElevenLabs tool endpoints
  "/api/webhook/",  // ElevenLabs post-call webhook (single route today)
];

/**
 * Exact webhook paths outside the prefixes above. These are the "one-off"
 * Twilio-facing routes registered under generic prefixes (e.g.
 * `/api/voice/outbound`) where the surrounding prefix has NON-webhook
 * siblings (`/api/voice/token`, `/api/voice/heartbeat` etc.) that must
 * NOT be bypass-listed.
 */
export const WEBHOOK_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/api/voice/outbound",
  "/api/voice/outbound-status",
]);

export function isWebhookShapedPath(path: string): boolean {
  if (WEBHOOK_EXACT_PATHS.has(path)) return true;
  for (const prefix of WEBHOOK_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Return the sorted unique list of webhook-shaped paths that are NOT
 * covered by any bypass pattern. Empty list = every webhook is
 * bypass-listed. Caller decides how to react (startup: throw; test:
 * assertion).
 */
export function findMissingBypassEntries(
  registeredPaths: readonly string[],
  bypassPatterns: readonly RegExp[],
): string[] {
  const missing = new Set<string>();
  for (const path of registeredPaths) {
    if (!isWebhookShapedPath(path)) continue;
    const covered = bypassPatterns.some((rx) => rx.test(path));
    if (!covered) missing.add(path);
  }
  return Array.from(missing).sort();
}

/**
 * Recursively walk an Express 5 router stack and collect the full
 * paths of every registered route (relative to `mountPrefix`).
 *
 * Express 5 shape:
 *   - A layer with `layer.route` is a route definition; the path is
 *     `layer.route.path` and it lives at `mountPrefix + layer.route.path`.
 *   - A layer with `layer.name === "router"` is a nested router; the
 *     mount prefix comes from the layer's regex. In this codebase we
 *     mount every sub-router WITHOUT its own prefix (see
 *     routes/index.ts — `router.use(subRouter)` with no path arg), so
 *     the recursion inherits the outer prefix.
 *
 * If a nested router is ever mounted with a prefix, we'd need to parse
 * `layer.regexp` to reconstruct it. That's out of scope for now —
 * assert it in the sub-mount comment when it happens.
 *
 * The `any` cast is intentional: Express's stack types are not part
 * of the public @types/express surface and vary by version. We probe
 * only the two stable shapes documented above.
 */
export function enumerateRoutePaths(
  router: { stack?: unknown[] } | undefined | null,
  mountPrefix = "",
): string[] {
  if (!router || !Array.isArray(router.stack)) return [];
  const paths: string[] = [];
  for (const layerUnknown of router.stack) {
    const layer = layerUnknown as {
      route?: { path?: string | string[] };
      name?: string;
      handle?: { stack?: unknown[] };
    };
    if (layer.route && layer.route.path != null) {
      const routePaths = Array.isArray(layer.route.path)
        ? layer.route.path
        : [layer.route.path];
      for (const p of routePaths) {
        if (typeof p === "string") paths.push(mountPrefix + p);
      }
    } else if (layer.name === "router" && layer.handle) {
      // No sub-prefix parsing — see JSDoc above. All nested mounts in
      // this codebase are prefix-less.
      paths.push(...enumerateRoutePaths(layer.handle as { stack?: unknown[] }, mountPrefix));
    }
  }
  return paths;
}
