/**
 * Phase 0 Commit 0-B — outbound voice provider abstraction.
 *
 * Single barrel for the substrate. Re-exports the types + concrete
 * providers + a tiny factory. Callers should depend on this module,
 * not on the individual implementation files, so a future swap (e.g.
 * a Vonage provider) is a one-line factory edit.
 *
 * Out of scope in 0-B:
 *   - DNC / consent / calling-hours gates → Commit 0-C
 *   - AMD webhook route + TwiML route for outbound_automated → 0-D
 *   - Refactor of routes/lead-calls.ts handleInitiateCall to use this → Phase 1
 *   - Migration of the 4 legacy publicBase inline derivations to
 *     lib/public-url.ts → separate polish commit
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallProvider, ICallProvider, TwilioClient } from "./types";
import { TwilioRestProvider } from "./twilio-rest-provider";
import { ElevenLabsHostedProvider } from "./elevenlabs-hosted-provider";

export * from "./types";
export { TwilioRestProvider } from "./twilio-rest-provider";
export { ElevenLabsHostedProvider } from "./elevenlabs-hosted-provider";
// Phase 1.3 — placement primitive. Re-exported here so consumers
// import from a single barrel rather than reaching into the file
// directly. See JSDoc in place-call.ts for invariants.
export { placeCall, type PlaceCallRequest, type PlaceCallResponse } from "./place-call";

export interface GetProviderOptions {
  twilioClient?: TwilioClient;
  supabase?: SupabaseClient;
}

export function getProvider(
  provider: CallProvider,
  options: GetProviderOptions = {},
): ICallProvider {
  switch (provider) {
    case "twilio":
      return new TwilioRestProvider({ twilioClient: options.twilioClient });
    case "elevenlabs_hosted":
      return new ElevenLabsHostedProvider({ supabase: options.supabase });
    default: {
      // Exhaustiveness check — TS catches a missing case at compile time.
      const _exhaustive: never = provider;
      throw new Error(`Unknown call provider: ${String(_exhaustive)}`);
    }
  }
}
