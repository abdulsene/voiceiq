/**
 * Smoke test for voiceiq-engine PII redaction.
 *
 * Run: `node tests/pii-redaction-smoke.js` from the voiceiq-engine
 * directory. Exits non-zero on any failure so CI/script callers can
 * detect regressions.
 *
 * Coverage subset of Saturday's 34-case api-server suite — focused on
 * the patterns most likely to appear in real call transcripts (phones,
 * emails, names, SSN, addresses, DOB, credit cards) plus the kill-switch
 * + null-input guards.
 */

import { redactCallTranscript, redactPII, detectPII, resolveRedactionMode, _resetPiiHandlingCache, _setSupabaseGetterForTests } from '../lib/pii-redact-transcript.js';

let pass = 0;
let fail = 0;
const failures = [];

function assert(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function run() {
  console.log('\n=== PII Redaction Smoke Tests (voiceiq-engine) ===\n');

  // -- 1. Phone numbers --
  console.log('Phones:');
  {
    const r = redactPII('Call me at 415-555-9999 tomorrow');
    assert('dashed phone redacted', r.redacted === 'Call me at ***-***-**** tomorrow', r.redacted);
  }
  {
    const r = redactPII('My number is (415) 555-1212');
    assert('parenthesized phone redacted', !/\d{3}/.test(r.redacted) || /\*{3}/.test(r.redacted), r.redacted);
  }
  {
    const r = redactPII('+1 415.555.9999 is mine');
    assert('country-code phone redacted', !r.redacted.includes('415.555'), r.redacted);
  }

  // -- 2. Email --
  console.log('\nEmails:');
  {
    const r = redactPII('Email me at john@example.com please');
    assert('basic email redacted', r.redacted === 'Email me at ***@***.*** please', r.redacted);
  }
  {
    const r = redactPII('Send to first.last+tag@sub.domain.co.uk');
    assert('complex email redacted', !r.redacted.includes('first.last'), r.redacted);
  }

  // -- 3. SSN --
  console.log('\nSSN:');
  {
    const r = redactPII('SSN is 123-45-6789');
    assert('dashed SSN redacted', r.redacted.includes('***-**-****'), r.redacted);
  }
  {
    const r = redactPII('123456789 is not a phone');
    assert('9-digit-no-sep treated as SSN', r.redacted.includes('***-**-****'), r.redacted);
  }

  // -- 4. Credit card --
  console.log('\nCredit cards:');
  {
    const r = redactPII('Card: 4111-1111-1111-1111');
    assert('dashed Visa redacted', r.redacted.includes('****-****-****-****'), r.redacted);
  }
  {
    const r = redactPII('Card 4111 1111 1111 1111 expires 01/27');
    assert('spaced Visa redacted', !r.redacted.includes('4111 1111'), r.redacted);
  }

  // -- 5. Names --
  console.log('\nNames:');
  {
    const r = redactPII('John Smith called about his account');
    assert('proper-case name redacted', r.redacted.startsWith('[REDACTED-NAME]'), r.redacted);
  }

  // -- 6. Address --
  console.log('\nAddresses:');
  {
    const r = redactPII('I live at 123 Main Street near downtown');
    assert('numbered street address redacted', r.redacted.includes('[REDACTED-ADDRESS]'), r.redacted);
  }
  {
    const r = redactPII('We meet at 4567 Oak Avenue');
    assert('avenue address redacted', r.redacted.includes('[REDACTED-ADDRESS]'), r.redacted);
  }

  // -- 7. DOB --
  console.log('\nDate of birth:');
  {
    const r = redactPII('Born 03/15/1985');
    assert('DOB redacted', r.redacted.includes('**/**/****'), r.redacted);
  }

  // -- 8. Combined transcript (the spec's marquee assertion) --
  console.log('\nCombined (spec proof):');
  {
    const input = 'John Smith called from 415-555-9999 about prescription refill';
    const r = redactPII(input);
    // Per spec output: "[REDACTED-NAME] called from ***-***-**** about prescription refill"
    assert('spec marquee case', r.redacted === '[REDACTED-NAME] called from ***-***-**** about prescription refill', `got: "${r.redacted}"`);
  }

  // -- 9. No-PII passthrough --
  console.log('\nNo-PII passthrough:');
  {
    const input = 'AI: How can I help you today?\nCaller: I need an appointment.';
    const r = redactPII(input);
    assert('clean text unchanged', r.redacted === input);
    assert('clean text has 0 detections', r.detections.length === 0);
  }

  // -- 10. Empty / null input --
  console.log('\nEmpty / null:');
  {
    const r = redactPII('');
    assert('empty string returns empty', r.redacted === '');
    assert('empty string has 0 detections', r.detections.length === 0);
  }
  {
    const r = redactPII(null);
    assert('null returns null/empty without throw', r.redacted === null || r.redacted === '');
  }

  // -- 11. detectPII parity --
  console.log('\ndetectPII:');
  {
    const det = detectPII('Call John Smith at 415-555-9999 or john@example.com');
    const types = det.map(d => d.type).sort();
    assert('detect all 3 types', JSON.stringify(types) === JSON.stringify(['email', 'name', 'phone']), JSON.stringify(types));
  }

  // -- 12. async redactCallTranscript wrapper --
  console.log('\nredactCallTranscript wrapper:');
  {
    const r = await redactCallTranscript('Patient John Smith born 03/15/1985 has SSN 123-45-6789', {
      businessId: 'demo-business',
      source: 'webhook',
      conversationId: 'conv_test_001',
    });
    assert('wrapper redacts', r.redactedText.includes('[REDACTED-NAME]') && r.redactedText.includes('**/**/****') && r.redactedText.includes('***-**-****'), r.redactedText);
    assert('wrapper reports count', r.redactionCount >= 3, `count=${r.redactionCount}`);
    assert('wrapper reports byType', r.byType.name >= 1 && r.byType.ssn >= 1 && r.byType.date_of_birth >= 1, JSON.stringify(r.byType));
    assert('wrapper reports mode=minimize', r.mode === 'minimize');
  }
  {
    const r = await redactCallTranscript('', { source: 'webhook' });
    assert('wrapper handles empty input', r.redactedText === '' && r.redactionCount === 0);
  }
  {
    const r = await redactCallTranscript(null, { source: 'lead' });
    assert('wrapper handles null input', r.redactedText === '' && r.redactionCount === 0);
  }

  // -- 13. Kill switch --
  console.log('\nKill switch (PII_REDACTION_MODE=off):');
  {
    const prev = process.env.PII_REDACTION_MODE;
    process.env.PII_REDACTION_MODE = 'off';
    _setSupabaseGetterForTests(null);
    _resetPiiHandlingCache();
    assert('mode resolves off', (await resolveRedactionMode('demo')) === 'off');
    const r = await redactCallTranscript('John Smith called from 415-555-9999', {
      businessId: 'demo-business',
      source: 'webhook',
    });
    assert('off mode passes through unredacted', r.redactedText === 'John Smith called from 415-555-9999', r.redactedText);
    assert('off mode reports mode=off', r.mode === 'off');
    if (prev === undefined) delete process.env.PII_REDACTION_MODE;
    else process.env.PII_REDACTION_MODE = prev;
    assert('mode resets to minimize after env restore', (await resolveRedactionMode('demo')) === 'minimize');
    _setSupabaseGetterForTests(undefined);
  }

  // -- 14. Realistic transcript (ElevenLabs shape) --
  // NOTE: regex is intentionally identical to api-server/src/security/pii.ts.
  // It is broad on names (any 2 consecutive Capitalized words match,
  // including business names like "Acme Dental") and narrow on addresses
  // (requires a known street-suffix from a fixed list — "Terrace" isn't on
  // it, so we use "Drive"). This test asserts the actual mirrored behavior,
  // not aspirational behavior. Improving the patterns is a separate change
  // that should be made in api-server first and copied back over.
  console.log('\nRealistic ElevenLabs-shape transcript:');
  {
    const transcript = [
      'AI: Thanks for calling, how can I help?',
      'Caller: Hi this is Sarah Johnson, my number is 415-555-7890.',
      'AI: Got it. Email for appointment confirmation?',
      'Caller: sarah.j@gmail.com please.',
      'AI: And your address?',
      'Caller: 742 Maple Drive.',
    ].join('\n');
    const r = await redactCallTranscript(transcript, {
      businessId: 'demo-business',
      source: 'sync',
      conversationId: 'conv_test_realistic',
    });
    assert('realistic — name redacted', r.redactedText.includes('[REDACTED-NAME]'), r.redactedText);
    assert('realistic — phone redacted', r.redactedText.includes('***-***-****'), r.redactedText);
    assert('realistic — email redacted', r.redactedText.includes('***@***.***'), r.redactedText);
    assert('realistic — address redacted (with known street suffix)', r.redactedText.includes('[REDACTED-ADDRESS]'), r.redactedText);
    assert('realistic — keeps conversational text intact', r.redactedText.includes('Thanks for calling') && r.redactedText.includes('appointment'), r.redactedText);
  }

  // -- 14b. Per-business pii_handling override (migration 016) --
  //    Mirrors the api-server tests in src/tests/pii-redaction-smoke.ts.
  //    Stubs the supabase client via _setSupabaseGetterForTests() so we
  //    can assert (a) per-business override beats env, (b) DB error
  //    falls back to env, (c) the 60s cache collapses repeat lookups
  //    into a single DB query.
  console.log('\nPer-business pii_handling override (migration 016):');
  {
    function makeStub(response) {
      let calls = 0;
      const sb = {
        from(_t) {
          return {
            select(_c) {
              return {
                eq(_col, _val) {
                  return {
                    async maybeSingle() { calls++; return response; },
                  };
                },
              };
            },
          };
        },
        get callCount() { return calls; },
      };
      return sb;
    }

    // Case 1 — pii_handling='off' → no redaction
    {
      _setSupabaseGetterForTests(makeStub({ data: { pii_handling: 'off' }, error: null }));
      _resetPiiHandlingCache();
      delete process.env.PII_REDACTION_MODE;
      const r = await redactCallTranscript('Email me at sarah@acme.com', {
        businessId: 'biz_off_user',
        source: 'webhook',
      });
      assert("biz pii_handling='off' → mode=off", r.mode === 'off');
      assert("biz pii_handling='off' → email NOT redacted", r.redactedText.includes('sarah@acme.com'), r.redactedText);
      assert("biz pii_handling='off' → redactionCount=0", r.redactionCount === 0);
    }

    // Case 2 — pii_handling='minimize' wins over env=off
    {
      _setSupabaseGetterForTests(makeStub({ data: { pii_handling: 'minimize' }, error: null }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = 'off';
      const r = await redactCallTranscript('Reach me at jane@example.com', {
        businessId: 'biz_min_user',
        source: 'webhook',
      });
      assert("biz pii_handling='minimize' beats env=off", r.mode === 'minimize');
      assert("biz pii_handling='minimize' → email IS redacted", !r.redactedText.includes('jane@example.com'), r.redactedText);
      delete process.env.PII_REDACTION_MODE;
    }

    // Case 3 — no row in DB → fall back to env
    {
      _setSupabaseGetterForTests(makeStub({ data: null, error: null }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = 'off';
      assert('no business row → fallback to env=off', (await resolveRedactionMode('biz_no_row')) === 'off');
      delete process.env.PII_REDACTION_MODE;
      assert('no business row + no env → fallback to default minimize', (await resolveRedactionMode('biz_no_row')) === 'minimize');
    }

    // Case 4 — DB error (column missing pre-016) → fall back to env
    {
      _setSupabaseGetterForTests(makeStub({
        data: null,
        error: { code: '42703', message: 'column business_configs.pii_handling does not exist' },
      }));
      _resetPiiHandlingCache();
      process.env.PII_REDACTION_MODE = 'off';
      assert('DB error (column missing) → fallback to env=off', (await resolveRedactionMode('biz_db_err')) === 'off');
      delete process.env.PII_REDACTION_MODE;
      assert('DB error + no env → fallback to default minimize', (await resolveRedactionMode('biz_db_err')) === 'minimize');
    }

    // Case 5 — cache hit: 3 lookups within 60s → 1 DB query
    {
      const stub = makeStub({ data: { pii_handling: 'off' }, error: null });
      _setSupabaseGetterForTests(stub);
      _resetPiiHandlingCache();
      const r1 = await resolveRedactionMode('biz_cached');
      const r2 = await resolveRedactionMode('biz_cached');
      const r3 = await resolveRedactionMode('biz_cached');
      assert('cached lookups all return off', r1 === 'off' && r2 === 'off' && r3 === 'off');
      assert('cache hit: 3 calls within 60s → 1 DB query', stub.callCount === 1, `callCount=${stub.callCount}`);
    }

    // Case 6 — distinct business IDs do not share cache
    {
      const stub = makeStub({ data: { pii_handling: 'off' }, error: null });
      _setSupabaseGetterForTests(stub);
      _resetPiiHandlingCache();
      await resolveRedactionMode('biz_a');
      await resolveRedactionMode('biz_b');
      assert('per-business cache: distinct IDs → distinct DB queries', stub.callCount === 2, `callCount=${stub.callCount}`);
    }

    // Cleanup
    _setSupabaseGetterForTests(undefined);
    _resetPiiHandlingCache();
  }

  // -- 15. Wiring guard — assert all 4 ingestion sites in server.js call
  //    redactCallTranscript(). This test would have caught the
  //    syncElevenLabsConversations miss flagged in architect review.
  //
  //    Strategy: strip JS comments first (so a // comment that mentions
  //    e.g. "updateCallTranscript()" doesn't poison indexOf), then check
  //    each function/route body contains an `await redactCallTranscript(`
  //    call AND that the redacted-output variable name is what flows into
  //    the persistence call. This is more robust than naive substring
  //    ordering checks.
  console.log('\nWiring guard — server.js ingestion sites:');
  {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const serverPath = path.resolve(here, '..', 'server.js');
    const rawSrc = await fs.readFile(serverPath, 'utf8');
    // Strip line comments (`// ...`) and block comments (`/* ... */`) so
    // they can't false-positive a wiring check.
    const src = rawSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    function findBlock(startMarker, endMarker) {
      const start = src.indexOf(startMarker);
      if (start < 0) return null;
      const searchFrom = start + startMarker.length;
      const end = endMarker ? src.indexOf(endMarker, searchFrom) : src.length;
      return src.slice(start, end < 0 ? src.length : end);
    }

    // Total redaction call count — should be exactly 4 (one per
    // ingestion site). Catches accidental deletions and accidental
    // duplications.
    const totalCalls = (src.match(/await\s+redactCallTranscript\s*\(/g) || []).length;
    assert('exactly 4 await redactCallTranscript() calls in server.js',
      totalCalls === 4, `found ${totalCalls}`);

    const lead = findBlock("fastify.post('/api/lead'", "fastify.post('/webhook/elevenlabs'");
    assert('POST /api/lead wires redactCallTranscript with source:lead',
      !!lead && /await\s+redactCallTranscript/.test(lead) && /source:\s*['"]lead['"]/.test(lead),
      'missing redactCallTranscript or source != lead');

    const webhook = findBlock("fastify.post('/webhook/elevenlabs'", "fastify.register(async function");
    assert('POST /webhook/elevenlabs wires redactCallTranscript with source:webhook',
      !!webhook && /await\s+redactCallTranscript/.test(webhook) && /source:\s*['"]webhook['"]/.test(webhook),
      'missing redactCallTranscript or source != webhook');

    const callEnd = findBlock('async function handleCallEnd(', 'async function analyzeCallWithClaude(');
    assert('handleCallEnd() wires redactCallTranscript and uses redacted var for updateCallTranscript',
      !!callEnd
        && /await\s+redactCallTranscript/.test(callEnd)
        && /redactedText:\s*fullTranscript\b/.test(callEnd)
        && /updateCallTranscript\([^)]*,\s*\{[^}]*transcript:\s*fullTranscript\b/.test(callEnd),
      'redactCallTranscript missing OR persisted variable is not the redacted output');

    const sync = findBlock('async function syncElevenLabsConversations(', 'syncElevenLabsConversations();');
    assert('syncElevenLabsConversations() wires redactCallTranscript and persists redacted var',
      !!sync
        && /await\s+redactCallTranscript/.test(sync)
        && /redactedText:\s*transcriptText\b/.test(sync)
        && /transcript:\s*transcriptText\b/.test(sync),
      'redactCallTranscript missing OR insert uses raw variable');

    // Negative guard: no raw variable should ever be passed to a
    // `transcript:` field on an insert/update payload.
    const rawLeak = /transcript:\s*(transcriptRaw|fullTranscriptRaw)\b/.test(src);
    assert('no raw transcript variable leaks into a transcript: field',
      !rawLeak, 'a *Raw variable is still being persisted somewhere');
  }

  // -- 16. Known-limitation documentation: the name regex is broad. --
  // This test asserts current behavior so the over-match is intentional
  // and tracked. If/when the api-server pattern is tightened, both
  // suites should be updated together.
  console.log('\nKnown-limitation: broad name regex matches business names:');
  {
    const r = redactPII('Acme Dental is open today');
    assert('two-capitalized-words business name IS matched (current behavior, mirrored from api-server)',
      r.redacted.includes('[REDACTED-NAME]'),
      r.redacted);
  }

  // -- Summary --
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  if (fail > 0) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    }
    process.exit(1);
  }
  console.log('All tests passed ✓');
  process.exit(0);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(2);
});
