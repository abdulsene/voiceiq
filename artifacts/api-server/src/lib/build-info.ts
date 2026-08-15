/**
 * Phase 6.7 — build-time deploy fingerprint.
 *
 * `__BUILD_COMMIT__` and `__BUILD_TIME__` are substituted as literal
 * string constants by esbuild's `define` at bundle time (see
 * artifacts/api-server/build.ts:readBuildInfo). In production, the
 * running bundle carries the git SHA + ISO timestamp of the checkout
 * that was built — not "the git state right now" and not "process
 * boot time." That's the load-bearing property: /api/healthz can
 * report WHICH commit is executing.
 *
 * In dev (tsx src/index.ts) the constants are not defined at all —
 * esbuild never runs — so `typeof __BUILD_COMMIT__ === "undefined"`
 * at runtime. Fallbacks return the literal "dev" so dev machines
 * report "dev / dev" rather than throwing ReferenceError on access.
 *
 * The `typeof x !== "undefined"` guard is the only safe way to
 * probe for an undeclared global identifier — a bare `x` reference
 * would ReferenceError at dev-time.
 */

declare const __BUILD_COMMIT__: string | undefined;
declare const __BUILD_TIME__: string | undefined;

export const BUILD_COMMIT: string =
  typeof __BUILD_COMMIT__ !== "undefined" && __BUILD_COMMIT__
    ? __BUILD_COMMIT__
    : "dev";

export const BUILD_TIME: string =
  typeof __BUILD_TIME__ !== "undefined" && __BUILD_TIME__
    ? __BUILD_TIME__
    : "dev";
