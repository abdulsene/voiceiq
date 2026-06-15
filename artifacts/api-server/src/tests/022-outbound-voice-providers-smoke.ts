/**
 * Phase 0 Commit 0-B — outbound voice provider smoke.
 *
 *   T1 — TwilioRestProvider builds calls.create body with full AMD +
 *        recording + status callback wiring for outbound_automated.
 *   T2 — TwilioRestProvider retries on Twilio code 21217 with the
 *        TWILIO_PHONE_NUMBER fallback. Second call's `from` matches.
 *   T3 — ElevenLabsHostedProvider POSTs to the correct ElevenLabs
 *        endpoint with the expected headers + body shape, and surfaces
 *        the Twilio CallSid from the response.
 *
 * Strategy: zero live API calls. T1+T2 inject a fake twilioClient via
 * the constructor; T3 monkey-patches global.fetch. No Supabase needed
 * (env-only ElevenLabs phone number id for T3).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/022-outbound-voice-providers-smoke.ts
 *
 * Env requirements (test/sentinel values are fine — never called):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ELEVENLABS_API_KEY,
 *   ELEVENLABS_DEFAULT_PHONE_NUMBER_ID, TWILIO_PHONE_NUMBER
 */

import { TwilioRestProvider } from "../lib/outbound-voice/twilio-rest-provider";
import { ElevenLabsHostedProvider } from "../lib/outbound-voice/elevenlabs-hosted-provider";
import type {
  PlaceCallOptions,
  TwilioClient,
} from "../lib/outbound-voice/types";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// Seed env with sentinel values. We restore at end.
const origEnv = {
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_DEFAULT_PHONE_NUMBER_ID:
    process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID,
};
process.env.TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "+18005550199";
process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "test-eleven-key";
process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID =
  process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID || "phnum_test_default";

// ── Twilio fake client ────────────────────────────────────────────────
// Records every calls.create invocation and optionally throws on a
// programmable shouldThrow flag (used for the 21217 retry test).

interface FakeCallsCreateArgs {
  to: string;
  from: string;
  url: string;
  record?: boolean;
  recordingChannels?: string;
  recordingStatusCallback?: string;
  recordingStatusCallbackEvent?: string[];
  recordingStatusCallbackMethod?: string;
  statusCallback?: string;
  statusCallbackEvent?: string[];
  statusCallbackMethod?: string;
  machineDetection?: string;
  asyncAmd?: string;
  asyncAmdStatusCallback?: string;
  asyncAmdStatusCallbackMethod?: string;
}

class FakeTwilioClient {
  public captured: FakeCallsCreateArgs[] = [];
  public sequence: Array<{ throwCode?: number; sid?: string }> = [];
  public calls = {
    create: async (args: FakeCallsCreateArgs) => {
      this.captured.push(args);
      const next = this.sequence.shift() ?? { sid: `CA_${this.captured.length}` };
      if (next.throwCode) {
        const err: any = new Error(`Twilio error ${next.throwCode}`);
        err.code = next.throwCode;
        throw err;
      }
      return { sid: next.sid ?? `CA_${this.captured.length}` } as any;
    },
  };
}

function basePayloadAutomated(overrides: Partial<PlaceCallOptions> = {}): PlaceCallOptions {
  return {
    provider: "twilio",
    to: "+12025551234",
    from: "+18005550100",
    businessId: "biz_test_022",
    leadCallId: "00000000-0000-0000-0000-000000000022",
    direction: "outbound_automated",
    recording: true,
    payload: {
      kind: "automated",
      agentId: "agent_test_022",
      callObjective: "appointment_reminder",
      twimlUrl: "https://voice-i-q.replit.app/api/twilio/voice/outbound?lead_call_id=...",
      statusCallbackUrl: "https://voice-i-q.replit.app/api/twilio/call-status?lead_call_id=...",
      recordingStatusCallbackUrl: "https://voice-i-q.replit.app/api/twilio/recording-status",
      amdStatusCallbackUrl: "https://voice-i-q.replit.app/api/twilio/outbound-voice-amd?lead_call_id=...",
    },
    ...overrides,
  };
}

// ── T1 ────────────────────────────────────────────────────────────────

async function runT1() {
  const fake = new FakeTwilioClient();
  const provider = new TwilioRestProvider({ twilioClient: fake as unknown as TwilioClient });
  const opts = basePayloadAutomated();
  const result = await provider.placeCall(opts);
  if (!result.ok) {
    record("T1 builds outbound_automated call body", false, `provider returned !ok: ${JSON.stringify(result)}`);
    return;
  }
  if (fake.captured.length !== 1) {
    record("T1 builds outbound_automated call body", false, `expected 1 calls.create, got ${fake.captured.length}`);
    return;
  }
  const sent = fake.captured[0];
  const failures: string[] = [];
  if (sent.to !== opts.to) failures.push(`to=${sent.to}`);
  if (sent.from !== opts.from) failures.push(`from=${sent.from}`);
  if (sent.url !== (opts.payload as any).twimlUrl) failures.push(`url=${sent.url}`);
  if (sent.record !== true) failures.push(`record=${sent.record}`);
  if (sent.recordingChannels !== "dual") failures.push(`recordingChannels=${sent.recordingChannels}`);
  if (sent.recordingStatusCallback !== (opts.payload as any).recordingStatusCallbackUrl) failures.push(`recordingStatusCallback=${sent.recordingStatusCallback}`);
  if (sent.statusCallback !== (opts.payload as any).statusCallbackUrl) failures.push(`statusCallback=${sent.statusCallback}`);
  if (!Array.isArray(sent.statusCallbackEvent) || sent.statusCallbackEvent.length !== 4) {
    failures.push(`statusCallbackEvent=${JSON.stringify(sent.statusCallbackEvent)}`);
  }
  if (sent.machineDetection !== "DetectMessageEnd") failures.push(`machineDetection=${sent.machineDetection}`);
  if (sent.asyncAmd !== "true") failures.push(`asyncAmd=${sent.asyncAmd}`);
  if (sent.asyncAmdStatusCallback !== (opts.payload as any).amdStatusCallbackUrl) failures.push(`asyncAmdStatusCallback=${sent.asyncAmdStatusCallback}`);
  if (sent.asyncAmdStatusCallbackMethod !== "POST") failures.push(`asyncAmdStatusCallbackMethod=${sent.asyncAmdStatusCallbackMethod}`);
  if (result.provider !== "twilio") failures.push(`result.provider=${result.provider}`);
  if (failures.length > 0) {
    record("T1 outbound_automated body shape", false, failures.join("; "));
  } else {
    record("T1 outbound_automated body shape", true, "to, from, url, recording, status callbacks, AMD all wired correctly");
  }
}

// ── T2 ────────────────────────────────────────────────────────────────

async function runT2() {
  const fake = new FakeTwilioClient();
  fake.sequence = [
    { throwCode: 21217 },           // first call: caller ID not verified
    { sid: "CA21217RETRY" },        // retry with fallback succeeds
  ];
  const provider = new TwilioRestProvider({ twilioClient: fake as unknown as TwilioClient });
  const opts = basePayloadAutomated();
  const result = await provider.placeCall(opts);
  const failures: string[] = [];
  if (!result.ok) failures.push(`result=${JSON.stringify(result)}`);
  if (result.ok && result.callSid !== "CA21217RETRY") failures.push(`callSid=${result.callSid}`);
  if (fake.captured.length !== 2) failures.push(`expected 2 calls, got ${fake.captured.length}`);
  if (fake.captured[0]?.from !== opts.from) failures.push(`first call from=${fake.captured[0]?.from}`);
  if (fake.captured[1]?.from !== process.env.TWILIO_PHONE_NUMBER) {
    failures.push(`retry from=${fake.captured[1]?.from} expected=${process.env.TWILIO_PHONE_NUMBER}`);
  }
  if (failures.length > 0) {
    record("T2 21217 fallback retry", false, failures.join("; "));
  } else {
    record("T2 21217 fallback retry", true, "first call threw 21217; retry used TWILIO_PHONE_NUMBER as from; returned ok with retry CallSid");
  }
}

// ── T3 ────────────────────────────────────────────────────────────────

async function runT3() {
  const captured: { url: string; init: RequestInit } = { url: "", init: {} as RequestInit };
  const origFetch = global.fetch;
  global.fetch = (async (url: any, init?: any) => {
    captured.url = String(url);
    captured.init = init || {};
    const body = JSON.stringify({ callSid: "CAelevenlabs_test_22" });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as any;

  try {
    const provider = new ElevenLabsHostedProvider();
    const result = await provider.placeCall(
      basePayloadAutomated({ provider: "elevenlabs_hosted" }),
    );
    const failures: string[] = [];
    if (!result.ok) failures.push(`result=${JSON.stringify(result)}`);
    if (result.ok && result.callSid !== "CAelevenlabs_test_22") failures.push(`callSid=${result.callSid}`);
    if (result.provider !== "elevenlabs_hosted") failures.push(`provider=${result.provider}`);
    if (captured.url !== "https://api.elevenlabs.io/v1/convai/twilio/outbound_call") {
      failures.push(`url=${captured.url}`);
    }
    if (captured.init.method !== "POST") failures.push(`method=${captured.init.method}`);
    const headers = captured.init.headers as Record<string, string> | undefined;
    if (headers?.["xi-api-key"] !== process.env.ELEVENLABS_API_KEY) {
      failures.push(`xi-api-key header=${headers?.["xi-api-key"]}`);
    }
    const sentBody = typeof captured.init.body === "string" ? JSON.parse(captured.init.body) : null;
    if (sentBody?.agent_id !== "agent_test_022") failures.push(`agent_id=${sentBody?.agent_id}`);
    if (sentBody?.agent_phone_number_id !== process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID) {
      failures.push(`agent_phone_number_id=${sentBody?.agent_phone_number_id}`);
    }
    if (sentBody?.to_number !== "+12025551234") failures.push(`to_number=${sentBody?.to_number}`);
    if (failures.length > 0) {
      record("T3 ElevenLabsHosted POST shape", false, failures.join("; "));
    } else {
      record("T3 ElevenLabsHosted POST shape", true, "endpoint URL, xi-api-key, body fields (agent_id, agent_phone_number_id, to_number), and CallSid extraction all correct");
    }
  } finally {
    global.fetch = origFetch;
  }
}

// ── main ──────────────────────────────────────────────────────────────

async function main() {
  await runT1();
  await runT2();
  await runT3();

  // Restore env so other smokes in the same process don't see our seeds.
  process.env.TWILIO_PHONE_NUMBER = origEnv.TWILIO_PHONE_NUMBER;
  process.env.ELEVENLABS_API_KEY = origEnv.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID = origEnv.ELEVENLABS_DEFAULT_PHONE_NUMBER_ID;

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
