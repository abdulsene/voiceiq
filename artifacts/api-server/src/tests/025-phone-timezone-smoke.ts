/**
 * Phase 1.2 — phone-timezone smoke.
 *
 * 12 cases covering the major US/Canada timezones, a territory, a
 * span-TZ regression guard, two non-NANP rejections, and two
 * degenerate inputs.
 *
 * No I/O, no DB, no fetch — pure-function lookup test.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/025-phone-timezone-smoke.ts
 */

import { resolveRecipientTimezone, __areaCodeMapSize } from "../lib/phone-timezone";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

function expect(name: string, phone: string, expected: string | null) {
  const got = resolveRecipientTimezone(phone);
  const ok = got === expected;
  record(
    name,
    ok,
    ok
      ? `${phone} → ${expected === null ? "null" : expected}`
      : `${phone}: expected=${expected === null ? "null" : expected} got=${got === null ? "null" : got}`,
  );
}

async function main() {
  // T0: boot sanity — the module's own assert would have crashed
  // earlier if the JSON was partial. Mirror that here for visibility.
  if (__areaCodeMapSize < 300) {
    record("T0 map size sanity", false, `expected >=300, got ${__areaCodeMapSize}`);
  } else {
    record("T0 map size sanity", true, `${__areaCodeMapSize} entries loaded`);
  }

  expect("T1  202 DC → America/New_York", "+12025551212", "America/New_York");
  expect("T2  310 LA → America/Los_Angeles", "+13105551212", "America/Los_Angeles");
  expect("T3  312 Chicago → America/Chicago", "+13125551212", "America/Chicago");
  expect("T4  907 Anchorage → America/Anchorage", "+19075551212", "America/Anchorage");
  expect("T5  808 Honolulu → Pacific/Honolulu", "+18085551212", "Pacific/Honolulu");
  expect("T6  787 Puerto Rico → America/Puerto_Rico", "+17875551212", "America/Puerto_Rico");
  expect("T7  970 CO/UT span → America/Denver (Mountain dominant)", "+19705551212", "America/Denver");
  expect("T8  416 Toronto → America/Toronto", "+14165551212", "America/Toronto");
  expect("T9  UK +44 → null (non-NANP)", "+447911123456", null);
  expect("T10 France +33 → null (non-NANP)", "+33145678901", null);
  expect("T11 '+1' degenerate → null", "+1", null);
  expect("T12 '' empty → null", "", null);

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
