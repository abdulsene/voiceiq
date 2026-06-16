/**
 * Phase 1.7a — POST /api/business/configure outbound_* field plumbing smoke.
 *
 * The /configure route lives at api.ts and accepts conditional field
 * updates (a `if (body.X !== undefined) configData.X = body.X` pattern).
 * Phase 1.7 added 10 outbound_* fields via the exported helper
 * `applyOutboundConfigFields(body, configData)`. This smoke unit-tests
 * that helper directly — full route dispatch would require mocking
 * requireAuth + Supabase + audit middleware, which is disproportionate
 * for a 10-line conditional-pass-through.
 *
 *   T1  Empty body — no outbound_* keys → configData unchanged
 *   T2  Subset — only outbound_voice_enabled set → only that field
 *       applied; the other 9 untouched
 *   T3  Full set — all 10 fields supplied → all 10 applied with
 *       correct values
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/028b-business-configs-outbound-fields-smoke.ts
 */

import { applyOutboundConfigFields } from "../routes/api";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

const OUTBOUND_KEYS = [
  "outbound_voice_enabled",
  "outbound_provider",
  "outbound_calling_hours_start",
  "outbound_calling_hours_end",
  "outbound_calling_hours_days",
  "max_outbound_calls_per_day",
  "record_outbound_calls",
  "voice_consent_default",
  "outbound_voicemail_text",
  "elevenlabs_phone_number_id",
] as const;

function T1() {
  const configData: Record<string, unknown> = { business_id: "biz_test_028b" };
  applyOutboundConfigFields({}, configData);
  const touchedOutboundKeys = OUTBOUND_KEYS.filter((k) => k in configData);
  const ok = touchedOutboundKeys.length === 0 && Object.keys(configData).length === 1;
  record("T1 empty body leaves configData alone", ok, `touched=[${touchedOutboundKeys.join(",")}] keys=${Object.keys(configData).length}`);
}

function T2() {
  const configData: Record<string, unknown> = { business_id: "biz_test_028b" };
  applyOutboundConfigFields({ outbound_voice_enabled: true }, configData);
  const failures: string[] = [];
  if (configData.outbound_voice_enabled !== true) failures.push(`outbound_voice_enabled=${configData.outbound_voice_enabled}`);
  // The other 9 must not be present.
  for (const k of OUTBOUND_KEYS) {
    if (k === "outbound_voice_enabled") continue;
    if (k in configData) failures.push(`unexpectedly applied ${k}`);
  }
  record("T2 subset (only outbound_voice_enabled)", failures.length === 0, failures.join("; ") || "only the one field applied");
}

function T3() {
  const configData: Record<string, unknown> = { business_id: "biz_test_028b" };
  const fullBody: Record<string, unknown> = {
    outbound_voice_enabled: true,
    outbound_provider: "twilio",
    outbound_calling_hours_start: "09:00:00",
    outbound_calling_hours_end: "20:00:00",
    outbound_calling_hours_days: [1, 2, 3, 4, 5],
    max_outbound_calls_per_day: 250,
    record_outbound_calls: false,
    voice_consent_default: true,
    outbound_voicemail_text: "Hi, sorry we missed you. Please call back.",
    elevenlabs_phone_number_id: "phnum_test_028b",
  };
  applyOutboundConfigFields(fullBody, configData);
  const failures: string[] = [];
  for (const k of OUTBOUND_KEYS) {
    if (!(k in configData)) failures.push(`missing ${k}`);
    else if (configData[k] !== fullBody[k] && JSON.stringify(configData[k]) !== JSON.stringify(fullBody[k]))
      failures.push(`${k}=${JSON.stringify(configData[k])} expected ${JSON.stringify(fullBody[k])}`);
  }
  record("T3 full set — all 10 outbound_* applied", failures.length === 0, failures.join("; ") || "all 10 fields applied with correct values");
}

function main() {
  T1();
  T2();
  T3();
  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main();
