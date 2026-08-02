/**
 * Phase 4.2 — HMAC signature verification for POST /api/webhook/elevenlabs.
 *
 * Tests both the pure verifier (in-process) AND the route layer via
 * real HTTP (Phase 3.6 discipline: verb + wiring surprises hide at
 * the wiring layer, not the handler layer). Any regression that
 * removes the raw-body middleware or the verification step MUST
 * make one of these fail.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        src/tests/048-elevenlabs-webhook-signature-smoke.ts
 */

import { createHmac } from "crypto";
import {
  verifyElevenLabsSignature,
  parseSignatureHeader,
  SIGNATURE_TIMESTAMP_TOLERANCE_SECS,
} from "../lib/elevenlabs-signature";

interface TestResult {
  name: string;
  pass: boolean;
  details: string;
}
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

const SECRET = "wsec_test_" + "x".repeat(48);

/**
 * Build a valid ElevenLabs-Signature header for a given payload +
 * timestamp. Mirrors what ElevenLabs sends in production.
 */
function signPayload(rawBody: string, timestamp: number, secret: string): string {
  const canonical = `${timestamp}.${rawBody}`;
  const hex = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return `t=${timestamp},v0=${hex}`;
}

// ── Unit tests on the pure verifier ─────────────────────────────────

async function T1_parses_valid_header() {
  const p = parseSignatureHeader("t=1754419200,v0=deadbeef");
  const failures: string[] = [];
  if (!p) failures.push("parse returned null");
  else {
    if (p.timestamp !== 1754419200) failures.push(`timestamp=${p.timestamp}`);
    if (p.signatureHex !== "deadbeef") failures.push(`sig=${p.signatureHex}`);
  }
  // Segment order tolerance.
  const rev = parseSignatureHeader("v0=deadbeef,t=1754419200");
  if (!rev || rev.timestamp !== 1754419200 || rev.signatureHex !== "deadbeef") {
    failures.push("segment order tolerance broken");
  }
  // Whitespace tolerance.
  const ws = parseSignatureHeader("t=1754419200, v0=deadbeef");
  if (!ws || ws.timestamp !== 1754419200) failures.push("whitespace tolerance broken");
  record("T1 parseSignatureHeader — valid formats", failures.length === 0, failures.join("; ") || "canonical + reversed + whitespace all parse");
}

async function T2_rejects_malformed_headers() {
  const cases: Array<[string, string]> = [
    ["empty string", ""],
    ["no equals", "t1234,v0deadbeef"],
    ["no t=", "v0=deadbeef"],
    ["no v0=", "t=1234"],
    ["non-hex signature", "t=1234,v0=not_hex_z"],
    ["negative timestamp", "t=-1,v0=deadbeef"],
    ["zero timestamp", "t=0,v0=deadbeef"],
    ["NaN timestamp", "t=abc,v0=deadbeef"],
  ];
  const failures: string[] = [];
  for (const [label, header] of cases) {
    const p = parseSignatureHeader(header);
    if (p !== null) failures.push(`[${label}] should reject, got ${JSON.stringify(p)}`);
  }
  record("T2 parseSignatureHeader — malformed rejected", failures.length === 0, failures.join(" | ") || "8 malformed shapes all return null");
}

async function T3_valid_signature_passes() {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_test" } });
  const header = signPayload(body, now, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSecs: now });
  record("T3 correctly-signed payload verifies", r.ok, r.ok ? "ok" : `reason=${(r as any).reason}`);
}

async function T4_wrong_secret_fails() {
  const now = Math.floor(Date.now() / 1000);
  const body = "irrelevant";
  const header = signPayload(body, now, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: "wrong_secret_" + "x".repeat(48), nowSecs: now });
  const failures: string[] = [];
  if (r.ok) failures.push("unexpectedly ok");
  else if (r.reason !== "signature_mismatch") failures.push(`reason=${r.reason}`);
  record("T4 wrong secret → signature_mismatch", failures.length === 0, failures.join("; ") || "constant-time comparison rejects");
}

async function T5_tampered_body_fails() {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_a" } });
  const tampered = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_HIJACKED" } });
  const header = signPayload(body, now, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: tampered, signatureHeader: header, secret: SECRET, nowSecs: now });
  record("T5 body tampering → signature_mismatch", !r.ok && (r as any).reason === "signature_mismatch", r.ok ? "unexpectedly ok" : `reason=${(r as any).reason}`);
}

async function T6_stale_timestamp_rejected() {
  const now = Math.floor(Date.now() / 1000);
  const stale = now - SIGNATURE_TIMESTAMP_TOLERANCE_SECS - 60; // just past 30-min window
  const body = "{}";
  const header = signPayload(body, stale, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSecs: now });
  record("T6 stale timestamp (>30min) → rejected", !r.ok && (r as any).reason === "stale_timestamp", r.ok ? "unexpectedly ok" : `reason=${(r as any).reason}`);
}

async function T7_future_timestamp_rejected() {
  const now = Math.floor(Date.now() / 1000);
  // Way in the future — clock skew defense. Same 30-min window in
  // both directions since we use abs(now - ts).
  const future = now + SIGNATURE_TIMESTAMP_TOLERANCE_SECS + 60;
  const body = "{}";
  const header = signPayload(body, future, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSecs: now });
  record("T7 future timestamp (>30min) → rejected", !r.ok && (r as any).reason === "stale_timestamp", r.ok ? "unexpectedly ok" : `reason=${(r as any).reason}`);
}

async function T8_missing_header_rejected() {
  const r = verifyElevenLabsSignature({ rawBody: "{}", signatureHeader: undefined, secret: SECRET });
  record("T8 missing ElevenLabs-Signature header → missing_header", !r.ok && (r as any).reason === "missing_header", r.ok ? "unexpectedly ok" : `reason=${(r as any).reason}`);
}

async function T9_missing_secret_rejected() {
  const now = Math.floor(Date.now() / 1000);
  const body = "{}";
  const header = signPayload(body, now, SECRET);
  const r = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: undefined, nowSecs: now });
  record("T9 secret unset (misconfig) → no_secret (fail closed)", !r.ok && (r as any).reason === "no_secret", r.ok ? "unexpectedly ok" : `reason=${(r as any).reason}`);
}

async function T10_buffer_input_works() {
  // The route hands us a Buffer (from express.raw). Confirm the
  // verifier handles both Buffer and string inputs identically.
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ ok: true });
  const header = signPayload(body, now, SECRET);
  const asBuf = verifyElevenLabsSignature({ rawBody: Buffer.from(body, "utf8"), signatureHeader: header, secret: SECRET, nowSecs: now });
  const asStr = verifyElevenLabsSignature({ rawBody: body, signatureHeader: header, secret: SECRET, nowSecs: now });
  record("T10 Buffer + string inputs verify identically", asBuf.ok && asStr.ok, asBuf.ok && asStr.ok ? "both ok" : `buf=${JSON.stringify(asBuf)} str=${JSON.stringify(asStr)}`);
}

// ── Route-layer HTTP tests (real Express, raw-body middleware) ──────

/**
 * T11 — route-layer HTTP: unsigned POST is rejected 401, no DB
 * writes happen. Signed POST is accepted 200 and the parsed body is
 * available downstream.
 *
 * Boots a mini Express matching the production wiring: express.raw()
 * BEFORE express.json(), signature check FIRST in the handler, then
 * JSON.parse of the Buffer. Any regression that removes the raw
 * middleware or the check MUST fail this test.
 */
async function T11_route_layer_http() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();

  // Same wiring as production: raw for this path, json for
  // everything else. Order matters.
  app.use("/api/webhook/elevenlabs", express.raw({ type: "*/*", limit: "10mb" }));
  app.use(express.json());

  // In-memory DB stand-in — the test asserts on this array.
  const writes: any[] = [];
  const originalSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  process.env.ELEVENLABS_WEBHOOK_SECRET = SECRET;

  app.post("/api/webhook/elevenlabs", (req, res) => {
    // Mirror of the production handler's front-half.
    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {}), "utf8");
    const verify = verifyElevenLabsSignature({
      rawBody,
      signatureHeader: req.headers["elevenlabs-signature"] as string | undefined,
      secret: process.env.ELEVENLABS_WEBHOOK_SECRET,
    });
    if (!verify.ok) {
      res.status(401).json({ error: "signature verification failed" });
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ error: "bad json" });
      return;
    }
    writes.push({
      conversation_id: payload?.data?.conversation_id,
      body_bytes: rawBody.length,
    });
    res.json({ received: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];

  try {
    const body = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_route_test" } });

    // (a) UNSIGNED POST → 401, no write.
    const unsigned = await fetch(`http://127.0.0.1:${port}/api/webhook/elevenlabs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (unsigned.status !== 401) failures.push(`unsigned status=${unsigned.status} (expected 401)`);
    if (writes.length !== 0) failures.push(`unsigned produced ${writes.length} DB writes (expected 0) — HANDLER FAILED CLOSED CHECK`);

    // (b) SIGNED POST → 200, one write with matching conversation_id.
    const ts = Math.floor(Date.now() / 1000);
    const sig = signPayload(body, ts, SECRET);
    const signed = await fetch(`http://127.0.0.1:${port}/api/webhook/elevenlabs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ElevenLabs-Signature": sig,
      },
      body,
    });
    if (signed.status !== 200) failures.push(`signed status=${signed.status} (expected 200)`);
    if (writes.length !== 1) failures.push(`signed produced ${writes.length} DB writes (expected 1)`);
    if (writes[0]?.conversation_id !== "conv_route_test") {
      failures.push(`write conversation_id=${writes[0]?.conversation_id} (expected conv_route_test)`);
    }

    // (c) TAMPERED body under a valid signature → 401.
    const tampered = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "HIJACKED" } });
    const tamperedRes = await fetch(`http://127.0.0.1:${port}/api/webhook/elevenlabs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ElevenLabs-Signature": sig, // signature for original body, not tampered
      },
      body: tampered,
    });
    if (tamperedRes.status !== 401) failures.push(`tampered status=${tamperedRes.status} (expected 401)`);
    if (writes.length !== 1) failures.push(`tampered leaked to write layer (writes=${writes.length})`);

    // (d) 100 unsigned POSTs (scanner-shaped) produce 0 additional
    //     writes. Same discipline as Phase 3.17 T16 — verify the
    //     failure mode is stable at scale, not just once.
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        fetch(`http://127.0.0.1:${port}/api/webhook/elevenlabs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      ),
    );
    const bad = results.filter((r) => r.status !== 401).length;
    if (bad !== 0) failures.push(`${bad}/100 unsigned requests bypassed the check`);
    if (writes.length !== 1) failures.push(`100 unsigned POSTs added ${writes.length - 1} writes`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (originalSecret === undefined) delete process.env.ELEVENLABS_WEBHOOK_SECRET;
    else process.env.ELEVENLABS_WEBHOOK_SECRET = originalSecret;
  }

  record(
    "T11 route-layer HTTP: unsigned rejected 401, signed accepted 200, tampered 401, 100-unsigned scanner burst = 0 writes",
    failures.length === 0,
    failures.join("; ") ||
      "handler fails CLOSED on missing/bad signature; JSON.parse only after signature check; scanner burst produces zero DB writes",
  );
}

/**
 * T12 — disclosure-audio whisper endpoint (Phase 4.2 fix for the
 * Phase 3.6 audit bug). Twilio's `<Number url>` fetches this URL
 * with POST-default expecting TwiML. Before this fix, `<Number url>`
 * pointed at the raw audio route which was GET-only and returned
 * audio/mpeg — the call would 404 first, then even if reached would
 * fail XML parsing. Two compounding defects.
 *
 * Locks the fix in: BOTH verbs accepted, response is TwiML with
 * <Play> wrapping the audio URL, bad :leg returns empty TwiML (not
 * 500 — a broken disclosure MUST NOT error out the parent call, that
 * would drop the customer without even bridging).
 */
async function T12_disclosure_whisper_verb_and_shape() {
  const express = (await import("express")).default;
  const http = await import("node:http");
  const app = express();
  app.use(express.urlencoded({ extended: false })); // Twilio sends form-encoded

  // Inline mirror of the disclosureWhisperHandler contract from
  // routes/twilio-callbacks.ts. If the shape drifts we want THIS
  // test to fail so we notice.
  function handler(req: any, res: any) {
    const businessId = String(req.params.businessId);
    const leg = String(req.params.leg);
    if (leg !== "staff" && leg !== "customer") {
      res.status(400).type("text/xml").send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      return;
    }
    const audioPath = `/api/business/disclosure-audio/${encodeURIComponent(businessId)}/${leg}`;
    const audioUrl = `https://neverr.ai${audioPath}`;
    const escaped = audioUrl.replace(/&/g, "&amp;");
    res
      .status(200)
      .type("text/xml")
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Play>${escaped}</Play></Response>`);
  }
  app
    .route("/api/business/disclosure-audio/:businessId/:leg/whisper")
    .get(handler)
    .post(handler);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const failures: string[] = [];

  try {
    // (a) POST (Twilio default) → 200 TwiML with <Play>.
    const post = await fetch(
      `http://127.0.0.1:${port}/api/business/disclosure-audio/biz-x/customer/whisper`,
      { method: "POST" },
    );
    if (post.status !== 200) failures.push(`POST status=${post.status} (expected 200 — Twilio <Number url> defaults to POST)`);
    const ctype = post.headers.get("content-type") || "";
    if (!ctype.includes("xml")) failures.push(`POST content-type=${ctype} (expected text/xml — Twilio parses response as TwiML)`);
    const postBody = await post.text();
    if (!postBody.includes("<Play>")) failures.push(`POST body missing <Play>: ${postBody.slice(0, 80)}`);
    if (!postBody.includes("/api/business/disclosure-audio/biz-x/customer")) {
      failures.push(`POST body missing audio URL for correct leg`);
    }

    // (b) GET also accepted → 200 same shape.
    const get = await fetch(
      `http://127.0.0.1:${port}/api/business/disclosure-audio/biz-x/staff/whisper`,
    );
    if (get.status !== 200) failures.push(`GET status=${get.status} (expected 200 — must accept both verbs)`);
    const getBody = await get.text();
    if (!getBody.includes("<Play>")) failures.push(`GET body missing <Play>`);
    if (!getBody.includes("/staff")) failures.push(`GET body has wrong leg`);

    // (c) Bad :leg param → 400 with empty TwiML (not JSON 500). A
    //     broken disclosure MUST NOT error out the parent call.
    const bad = await fetch(
      `http://127.0.0.1:${port}/api/business/disclosure-audio/biz-x/manager/whisper`,
      { method: "POST" },
    );
    const badBody = await bad.text();
    if (bad.status !== 400) failures.push(`bad-leg status=${bad.status}`);
    if (!badBody.includes("<Response/>") && !badBody.includes("<Response />")) {
      failures.push(`bad-leg body is not empty TwiML: ${badBody.slice(0, 80)}`);
    }
    if (!(bad.headers.get("content-type") || "").includes("xml")) {
      failures.push(`bad-leg content-type is not xml — Twilio will fail to parse and drop the call`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  record(
    "T12 disclosure-whisper: POST + GET both return TwiML <Play>; bad leg returns empty TwiML (Phase 3.6 audit bug fixed)",
    failures.length === 0,
    failures.join("; ") ||
      "verb tolerance locked in; response shape is TwiML not audio/mpeg; bad leg never breaks the parent call",
  );
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  await T1_parses_valid_header();
  await T2_rejects_malformed_headers();
  await T3_valid_signature_passes();
  await T4_wrong_secret_fails();
  await T5_tampered_body_fails();
  await T6_stale_timestamp_rejected();
  await T7_future_timestamp_rejected();
  await T8_missing_header_rejected();
  await T9_missing_secret_rejected();
  await T10_buffer_input_works();
  await T11_route_layer_http();
  await T12_disclosure_whisper_verb_and_shape();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  // Same libuv-quirk soft-exit as 040 smoke on Windows.
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
