import { WorkOS } from "@workos-inc/node";

/**
 * WorkOS SSO client singleton — Sprint 5 Phase 1 scaffolding.
 *
 * Boot-time contract:
 *   1. Both WORKOS_API_KEY and WORKOS_CLIENT_ID must be present in the
 *      environment when this module is loaded. Either being missing is
 *      a fail-loud error — the SSO module refuses to load rather than
 *      silently no-op'ing and surprising callers at request time.
 *   2. Importing this module is the trigger. Until routes/sso.ts is
 *      mounted in routes/index.ts (Phase 2), the api-server boot path
 *      does NOT touch this file, so api-server boots normally even if
 *      these env vars happen to be unset on a given environment.
 *   3. Once routes/sso.ts is mounted, any process where WORKOS_API_KEY
 *      or WORKOS_CLIENT_ID is missing will fail at boot with the clear
 *      messages below — the intended fail-fast for a misconfigured
 *      deploy.
 *
 * Never log the API key or the client ID itself. The init log below is
 * intentionally bare — its presence in the logs is the only signal
 * needed to confirm the lib loaded cleanly.
 */

const apiKey = process.env.WORKOS_API_KEY;
const clientId = process.env.WORKOS_CLIENT_ID;

if (!apiKey) {
  throw new Error(
    "[workos] WORKOS_API_KEY is required to initialize the WorkOS SSO " +
      "client. Refusing to load the SSO module without it.",
  );
}

if (!clientId) {
  throw new Error(
    "[workos] WORKOS_CLIENT_ID is required to initialize the WorkOS SSO " +
      "client. Refusing to load the SSO module without it.",
  );
}

export const workos = new WorkOS(apiKey);
export const WORKOS_CLIENT_ID: string = clientId;

console.log("[workos] SSO client initialized");
