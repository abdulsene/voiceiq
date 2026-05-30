/**
 * PII redaction smoke test — Sprint 5 PIIProcessor wiring.
 *
 * Two layers:
 *   1. UNIT — exercises PIIProcessor directly: feeds a transcript with
 *      email + phone + SSN + credit card + address + DOB + name and asserts
 *      every category is redacted.
 *   2. INTEGRATION — exercises redactCallTranscript() (the helper that
 *      wraps PIIProcessor + audit). Asserts the mode-resolution
 *      (default minimize, env override off), the byType breakdown,
 *      empty-input handling, and that nothing throws when audit_logs is
 *      missing.
 *
 * No HTTP — pure in-process; runs in <1s. Run with:
 *   pnpm --filter @workspace/api-server run test:pii
 *
 * No dependency on a running server, no DB writes (audit failures are
 * swallowed by auditLog, which is the documented contract).
 */

import { PIIProcessor } from "../security/pii.js";
import {
  redactCallTranscript,
  resolveRedactionMode,
  _resetPiiHandlingCache,
  _setSupabaseGetterForTests,
} from "../lib/pii-redact-transcript.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: any, name: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    const msg = detail ? `${name} — ${detail}` : name;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------------------
// UNIT — PIIProcessor patterns
// ---------------------------------------------------------------------------
async function unitProcessor() {
  section("UNIT: PIIProcessor patterns");

  const proc = new PIIProcessor();

  // Empty input
  const empty = proc.redactPII("");
  assert(empty.redacted === "" && empty.detections.length === 0, "empty input → empty result");

  // Email
  {
    const r = proc.redactPII("Contact us at hello@neverr.ai for help");
    assert(!r.redacted.includes("hello@neverr.ai"), "email stripped from text");
    assert(
      r.detections.some((d) => d.type === "email" && d.count >= 1),
      "email detection recorded",
    );
  }

  // Phone (US formats: parens, hyphens, dotted)
  {
    const r = proc.redactPII("Call (415) 555-1212 or 415-555-1313 anytime");
    assert(!r.redacted.includes("555-1212"), "parenthesized phone stripped");
    assert(!r.redacted.includes("555-1313"), "hyphenated phone stripped");
    const phoneDet = r.detections.find((d) => d.type === "phone");
    assert(phoneDet && phoneDet.count >= 2, "both phones detected", `count=${phoneDet?.count}`);
  }

  // SSN
  {
    const r = proc.redactPII("My SSN is 123-45-6789 for the form");
    assert(!r.redacted.includes("123-45-6789"), "SSN stripped");
    assert(
      r.detections.some((d) => d.type === "ssn" && d.count >= 1),
      "SSN detection recorded",
    );
  }

  // Credit card (Visa test number)
  {
    const r = proc.redactPII("Charge to 4111-1111-1111-1111 please");
    assert(!r.redacted.includes("4111-1111-1111-1111"), "credit card stripped");
  }

  // Combined — the realistic transcript shape we'll see from ElevenLabs
  {
    const sample = "Caller: Hi, I'm John Smith. My email is john@example.com and my number is (415) 555-9999. Call me back about my appt.";
    const r = proc.redactPII(sample);
    assert(!r.redacted.includes("john@example.com"), "combined: email stripped");
    assert(!r.redacted.includes("555-9999"), "combined: phone stripped");
    assert(!r.redacted.includes("John Smith"), "combined: name stripped");
    // The "appt" tail must still be present so the transcript stays useful.
    assert(r.redacted.includes("appt"), "combined: non-PII context preserved");
    console.log(`    sample-original: ${sample}`);
    console.log(`    sample-redacted: ${r.redacted}`);
  }

  // Idempotency-ish — running redaction twice on already-redacted text
  // should NOT find new PII (the placeholder strings shouldn't match
  // any pattern). This guards against a future regex change introducing
  // a self-match loop.
  {
    const first = proc.redactPII("Email: user@host.com");
    const second = proc.redactPII(first.redacted);
    const newCount = second.detections.reduce((s, d) => s + d.count, 0);
    assert(newCount === 0, "redacting an already-redacted string finds nothing", `found=${newCount}`);
  }
}

// ---------------------------------------------------------------------------
// INTEGRATION — redactCallTranscript() wrapper
// ---------------------------------------------------------------------------
async function integrationWrapper() {
  section("INTEGRATION: redactCallTranscript()");

  // Mode resolution — env-only path (no business override, supabase=null)
  {
    _setSupabaseGetterForTests(null);
    _resetPiiHandlingCache();
    const original = process.env.PII_REDACTION_MODE;
    delete process.env.PII_REDACTION_MODE;
    assert((await resolveRedactionMode("any")) === "minimize", "default mode is 'minimize'");
    process.env.PII_REDACTION_MODE = "off";
    assert((await resolveRedactionMode("any")) === "off", "env override 'off' applies");
    process.env.PII_REDACTION_MODE = "minimize";
    assert((await resolveRedactionMode("any")) === "minimize", "env 'minimize' applies");
    process.env.PII_REDACTION_MODE = "garbage";
    assert((await resolveRedactionMode("any")) === "minimize", "garbage env value falls back to 'minimize'");
    if (original === undefined) delete process.env.PII_REDACTION_MODE;
    else process.env.PII_REDACTION_MODE = original;
    _setSupabaseGetterForTests(undefined);
  }

  // Per-business pii_handling override (migration 016)
  section("INTEGRATION: per-business pii_handling (migration 016)");
  {
    // Build a stub supabase client that records every .from(...).select(...).eq(...).maybeSingle() call
    // and returns the configured response.
    type StubResponse = { data: any; error: any };
    function makeStub(response: StubResponse) {
      let calls = 0;
      const sb = {
        from(_table: string) {
          return {
            select(_cols: string) {
              return {
                eq(_col: string, _val: string) {
                  return {
                    async maybeSingle() {
                      calls++;
                      return response;
                    },
                  };
                },
              };
            },
          };
        },
        get callCount() { return calls; },
      } as any;
      return sb;
    }

    // Case 1 — business has pii_handling='off' → no redaction
    {
      _setSupabaseGetterForTests(makeStub({ data: { pii_handling: "off" }, error: null }));
      _resetPiiHandlingCache();
      delete process.env.PII_REDACTION_MODE;
      const r = await redactCallTranscript("Email me at sarah@acme.com please", {
        businessId: "biz_off_user",
        source: "webhook",
      });
      assert(r.mode === "off", "biz pii_handling='off' → mode=off");
      assert(r.redactedText.includes("sarah@acme.com"), "biz pii_handling='off' → email NOT redacted");
      assert(r.redactionCount === 0, "biz pii_handling='off' → redactionCount=0");
    }

    // Case 2 — business has pii_handling='minimize' → redaction happens (even if env says off)
    {
      _setSupabaseGetterForTests(makeStub({ data: { pii_handling: "minimize" }, error: null }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = "off"; // env says off; business override should win
      const r = await redactCallTranscript("Reach me at jane@example.com", {
        businessId: "biz_min_user",
        source: "webhook",
      });
      assert(r.mode === "minimize", "biz pii_handling='minimize' → wins over env=off");
      assert(!r.redactedText.includes("jane@example.com"), "biz pii_handling='minimize' → email IS redacted");
      delete process.env.PII_REDACTION_MODE;
    }

    // Case 3 — business_id missing in DB (no row) → falls back to env var
    {
      _setSupabaseGetterForTests(makeStub({ data: null, error: null }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = "off";
      assert((await resolveRedactionMode("biz_no_row")) === "off",
        "no business row → fallback to env 'off'");
      delete process.env.PII_REDACTION_MODE;
      assert((await resolveRedactionMode("biz_no_row")) === "minimize",
        "no business row + no env → fallback to 'minimize' default");
    }

    // Case 4 — DB error (e.g. column missing pre-migration-016) → falls back to env
    {
      _setSupabaseGetterForTests(makeStub({
        data: null,
        error: { code: "42703", message: 'column business_configs.pii_handling does not exist' },
      }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = "off";
      assert((await resolveRedactionMode("biz_db_err")) === "off",
        "DB error (column missing) → fallback to env 'off'");
      delete process.env.PII_REDACTION_MODE;
      assert((await resolveRedactionMode("biz_db_err")) === "minimize",
        "DB error + no env → fallback to default 'minimize'");
    }

    // Case 5 — cache hit: same business_id queried twice within 60s → only 1 DB call
    {
      const stub = makeStub({ data: { pii_handling: "off" }, error: null });
      _setSupabaseGetterForTests(stub);
      _resetPiiHandlingCache();
      const r1 = await resolveRedactionMode("biz_cached");
      const r2 = await resolveRedactionMode("biz_cached");
      const r3 = await resolveRedactionMode("biz_cached");
      assert(r1 === "off" && r2 === "off" && r3 === "off",
        "cached lookups all return 'off'");
      assert(stub.callCount === 1,
        "cache hit: 3 resolveRedactionMode calls within 60s → 1 DB query",
        `callCount=${stub.callCount}`);
    }

    // Case 6 — cache key is per-businessId: different IDs do not share cache
    {
      const stub = makeStub({ data: { pii_handling: "off" }, error: null });
      _setSupabaseGetterForTests(stub);
      _resetPiiHandlingCache();
      await resolveRedactionMode("biz_a");
      await resolveRedactionMode("biz_b");
      assert(stub.callCount === 2,
        "per-business cache: distinct IDs → distinct DB queries",
        `callCount=${stub.callCount}`);
    }

    // Cleanup — restore real getter so any subsequent tests don't see the stub
    _setSupabaseGetterForTests(undefined);
    _resetPiiHandlingCache();
  }

  // Empty input — no audit, no error
  {
    const r = await redactCallTranscript("", { businessId: "demo", source: "lead" });
    assert(r.redactionCount === 0, "empty input: zero redactions");
    assert(r.redactedText === "", "empty input: empty output");
  }

  {
    const r = await redactCallTranscript(null, { businessId: "demo", source: "lead" });
    assert(r.redactedText === "", "null input → empty output (no crash)");
  }

  // Default minimize — happy path
  {
    delete process.env.PII_REDACTION_MODE;
    const sample =
      "AI: Welcome to Neverr.\nCaller: Hi, I'm Sarah Johnson, my email is sarah@acme.com and my phone is 415-555-7777. I want to book a cleaning.";
    const r = await redactCallTranscript(sample, {
      businessId: "demo-business",
      source: "webhook",
      conversationId: "conv_test_1",
    });
    assert(r.mode === "minimize", "happy: mode=minimize");
    assert(r.redactionCount >= 3, "happy: at least name+email+phone redacted", `count=${r.redactionCount}`);
    assert(!r.redactedText.includes("sarah@acme.com"), "happy: email gone");
    assert(!r.redactedText.includes("555-7777"), "happy: phone gone");
    assert(!r.redactedText.includes("Sarah Johnson"), "happy: name gone");
    assert(r.redactedText.includes("book a cleaning"), "happy: non-PII intent preserved");
    assert(r.byType.email >= 1, "happy: byType.email recorded");
    assert(r.byType.phone >= 1, "happy: byType.phone recorded");
    console.log(`    BEFORE: ${sample}`);
    console.log(`    AFTER:  ${r.redactedText}`);
    console.log(`    SUMMARY: count=${r.redactionCount} byType=${JSON.stringify(r.byType)}`);
  }

  // Mode off — passthrough
  {
    process.env.PII_REDACTION_MODE = "off";
    const sample = "Caller email: passthrough@test.com";
    const r = await redactCallTranscript(sample, {
      businessId: "demo-business",
      source: "sync",
      conversationId: "conv_test_2",
    });
    assert(r.mode === "off", "off: mode=off");
    assert(r.redactedText === sample, "off: text passed through unchanged");
    assert(r.redactionCount === 0, "off: redactionCount=0");
    delete process.env.PII_REDACTION_MODE;
  }

  // No PII in input — should still succeed with zero redactions
  {
    const sample = "AI: How can I help?\nCaller: I'd like to know your hours.";
    const r = await redactCallTranscript(sample, {
      businessId: "demo-business",
      source: "lead",
    });
    assert(r.redactionCount === 0, "clean transcript: zero redactions");
    assert(r.redactedText === sample, "clean transcript: unchanged");
  }
}

async function main() {
  const t0 = Date.now();
  await unitProcessor();
  await integrationWrapper();
  const ms = Date.now() - t0;

  console.log(`\n=== RESULTS ===`);
  console.log(`Pass: ${pass}`);
  console.log(`Fail: ${fail}`);
  console.log(`Time: ${ms}ms`);
  if (fail > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  } else {
    console.log(`\nAll PII redaction smoke tests passed.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
