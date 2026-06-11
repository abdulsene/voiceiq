/**
 * API-contract smoke harness for the dashboard's TransferTab.
 *
 * The dashboard doesn't run Playwright, so this harness validates the
 * server-side contract the tab depends on. If any of these break, the
 * tab will misbehave:
 *
 *   T1 — GET /api/business/transfer returns the canonical shape the tab
 *        unpacks: transfer_enabled, transfer_to_phone, transfer_conditions,
 *        transfer_wait_message, transfer_warm_message, twilio_phone_number,
 *        and a non-empty `defaults` object with three strings. The
 *        TransferTab seeds its placeholder text from `defaults` — if those
 *        ever go missing the textareas would render with empty placeholders.
 *
 *   T2 — Round-trip PUT then GET preserves the values. Save a known config,
 *        re-read, assert echo. Confirms TransferTab's "refresh local state
 *        from the canonical server response" path will see what it expects.
 *
 *   T3 — PUT with malformed (non-E.164) phone returns 400 with an `error`
 *        string. TransferTab surfaces the error via setServerError(msg)
 *        so the body shape must include `error`.
 *
 *   T4 — PUT with transfer_to_phone equal to the row's twilio_phone_number
 *        returns 400 with an error string that includes the word "loop".
 *        TransferTab's loop guard messaging is server-rendered, so we
 *        assert the substring the dashboard can match against if it ever
 *        wants to specialize the inline error UI.
 *
 *   T5 — PUT with transfer_enabled=true and missing conditions (defaults
 *        seeded) succeeds and the canonical returned row has
 *        transfer_conditions populated (server-side first-enable seeding
 *        is what TransferTab relies on so the customer doesn't get
 *        blocked by a "field required" error on the first save).
 *
 *   T6 — Toggle from enabled → disabled via PUT, GET confirms
 *        transfer_enabled=false AND the stored phone is preserved. The
 *        tab intentionally leaves the phone visible after disabling
 *        ("stays visible so the customer can keep their saved number");
 *        if the server cleared it we'd need a tab-side change.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/016-transfer-tab-page-smoke.ts
 *
 * Requires (env):
 *   TEST_API_BASE        — api-server URL, default http://localhost:8080
 *   TEST_AUTH_BEARER     — JWT for a user belonging to the fixture business
 *                          (the route is gated by requireAuth + settings:write)
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY — to stamp a known
 *                          twilio_phone_number for T4 and reset state
 */
import { createClient } from "@supabase/supabase-js";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const AUTH_BEARER = process.env.TEST_AUTH_BEARER || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

const KNOWN_TWILIO = "+14433314649";
const KNOWN_DESTINATION = "+14105557777";
const KNOWN_CONDITIONS = "When caller asks for the owner directly.";

type GetResp = {
  business_id: string;
  transfer_enabled: boolean;
  transfer_to_phone: string | null;
  transfer_conditions: string | null;
  transfer_wait_message: string | null;
  transfer_warm_message: string | null;
  twilio_phone_number: string | null;
  defaults?: {
    transfer_conditions: string;
    transfer_wait_message: string;
    transfer_warm_message: string;
  };
};

async function getTransfer(): Promise<{ http: number; body: GetResp | { error?: string }; text: string }> {
  const r = await fetch(`${API}/api/business/transfer`, {
    headers: { Authorization: `Bearer ${AUTH_BEARER}` },
  });
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* leave empty */ }
  return { http: r.status, body, text };
}

async function putTransfer(payload: any): Promise<{ http: number; body: any; text: string }> {
  const r = await fetch(`${API}/api/business/transfer`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AUTH_BEARER}` },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* leave empty */ }
  return { http: r.status, body, text };
}

async function main() {
  if (!AUTH_BEARER || !SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing TEST_AUTH_BEARER, SUPABASE_URL, or SUPABASE_SERVICE_KEY — cannot run.");
    process.exit(1);
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Discover which business the bearer belongs to.
  const meRes = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${AUTH_BEARER}` } });
  if (!meRes.ok) {
    console.error("auth/me failed:", meRes.status);
    process.exit(1);
  }
  const me = (await meRes.json()) as { current_business_id?: string };
  const businessId = me?.current_business_id;
  if (!businessId) {
    console.error("no current_business_id from /auth/me");
    process.exit(1);
  }

  // Snapshot the current row so we can restore it at the end.
  const { data: snapshot } = await supa
    .from("business_configs")
    .select("twilio_phone_number, transfer_enabled, transfer_to_phone, transfer_conditions, transfer_wait_message, transfer_warm_message")
    .eq("business_id", businessId)
    .maybeSingle();
  const snap = (snapshot as any) || {};

  // Stamp a known twilio number for T4's loop guard.
  await supa.from("business_configs").update({ twilio_phone_number: KNOWN_TWILIO }).eq("business_id", businessId);
  // Start from a clean enabled=false baseline so T5's first-enable path
  // exercises the seeding.
  await supa.from("business_configs").update({
    transfer_enabled: false,
    transfer_to_phone: null,
    transfer_conditions: null,
    transfer_wait_message: null,
    transfer_warm_message: null,
  }).eq("business_id", businessId);

  try {
    // ----- T1: GET shape -----
    {
      const r = await getTransfer();
      const b = r.body as GetResp;
      const hasFields = r.http === 200
        && typeof b.transfer_enabled === "boolean"
        && "transfer_to_phone" in b
        && "transfer_conditions" in b
        && "transfer_wait_message" in b
        && "transfer_warm_message" in b
        && "twilio_phone_number" in b;
      const hasDefaults = !!b.defaults
        && typeof b.defaults.transfer_conditions === "string" && b.defaults.transfer_conditions.length > 0
        && typeof b.defaults.transfer_wait_message === "string" && b.defaults.transfer_wait_message.length > 0
        && typeof b.defaults.transfer_warm_message === "string" && b.defaults.transfer_warm_message.length > 0;
      if (hasFields && hasDefaults) {
        record("T1 GET shape (5 transfer fields + non-empty defaults)", true, `http=200`);
      } else {
        record("T1 GET shape", false, `http=${r.http} hasFields=${hasFields} hasDefaults=${hasDefaults} body=${r.text.slice(0, 300)}`);
      }
    }

    // ----- T2: round-trip PUT then GET preserves -----
    {
      const put = await putTransfer({
        transfer_enabled: true,
        transfer_to_phone: KNOWN_DESTINATION,
        transfer_conditions: KNOWN_CONDITIONS,
        transfer_wait_message: "Hold while I connect you.",
        transfer_warm_message: "Heads up: caller asked for the owner.",
      });
      const get = await getTransfer();
      const b = get.body as GetResp;
      if (put.http !== 200 || !put.body?.success) {
        record("T2 PUT happy", false, `PUT http=${put.http} body=${put.text.slice(0, 200)}`);
      } else if (get.http !== 200) {
        record("T2 GET after PUT", false, `GET http=${get.http} body=${get.text.slice(0, 200)}`);
      } else if (!b.transfer_enabled || b.transfer_to_phone !== KNOWN_DESTINATION || b.transfer_conditions !== KNOWN_CONDITIONS) {
        record("T2 round-trip preserves values", false, `got: ${JSON.stringify({ enabled: b.transfer_enabled, phone: b.transfer_to_phone, cond: b.transfer_conditions })}`);
      } else {
        record("T2 round-trip preserves values", true, "PUT echoed back via GET cleanly");
      }
    }

    // ----- T3: malformed phone -----
    {
      const r = await putTransfer({
        transfer_enabled: true,
        transfer_to_phone: "not-a-phone",
        transfer_conditions: KNOWN_CONDITIONS,
      });
      const err = r.body?.error;
      if (r.http === 400 && typeof err === "string" && err.length > 0) {
        record("T3 malformed phone → 400 with error string", true, `error="${err.slice(0, 80)}"`);
      } else {
        record("T3 malformed phone → 400 with error string", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
      }
    }

    // ----- T4: loop guard -----
    {
      const r = await putTransfer({
        transfer_enabled: true,
        transfer_to_phone: KNOWN_TWILIO,
        transfer_conditions: KNOWN_CONDITIONS,
      });
      const err: string = r.body?.error || "";
      if (r.http === 400 && /loop/i.test(err)) {
        record("T4 loop guard → 400 with 'loop' in error", true, `error="${err.slice(0, 80)}"`);
      } else {
        record("T4 loop guard → 400 with 'loop' in error", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
      }
    }

    // ----- T5: first-enable seeds defaults -----
    {
      // Reset baseline so this is genuinely a "first enable" transition.
      await supa.from("business_configs").update({
        transfer_enabled: false,
        transfer_to_phone: null,
        transfer_conditions: null,
        transfer_wait_message: null,
        transfer_warm_message: null,
      }).eq("business_id", businessId);

      const put = await putTransfer({
        transfer_enabled: true,
        transfer_to_phone: KNOWN_DESTINATION,
        // transfer_conditions intentionally omitted — server should seed default
      });
      const b = put.body as { success: boolean; transfer_conditions: string | null };
      if (put.http !== 200 || !b?.success) {
        record("T5 first-enable seeds defaults", false, `http=${put.http} body=${put.text.slice(0, 200)}`);
      } else if (!b.transfer_conditions || b.transfer_conditions.length < 10) {
        record("T5 first-enable seeds defaults", false, `conditions not seeded: "${b.transfer_conditions}"`);
      } else {
        record("T5 first-enable seeds defaults", true, `conditions seeded to "${b.transfer_conditions.slice(0, 60)}..."`);
      }
    }

    // ----- T6: disable preserves phone -----
    {
      // T5 left the row enabled with a known phone. Now flip to disabled
      // and confirm the phone is retained for the tab's "kept after
      // disable" UX.
      const put = await putTransfer({
        transfer_enabled: false,
        transfer_to_phone: KNOWN_DESTINATION,
        transfer_conditions: KNOWN_CONDITIONS,
      });
      const get = await getTransfer();
      const b = get.body as GetResp;
      if (put.http !== 200 || get.http !== 200) {
        record("T6 disable preserves phone", false, `PUT http=${put.http} GET http=${get.http}`);
      } else if (b.transfer_enabled !== false) {
        record("T6 disable preserves phone", false, `transfer_enabled is not false: ${JSON.stringify(b)}`);
      } else if (b.transfer_to_phone !== KNOWN_DESTINATION) {
        record("T6 disable preserves phone", false, `phone lost on disable: "${b.transfer_to_phone}"`);
      } else {
        record("T6 disable preserves phone", true, "enabled=false, phone retained");
      }
    }
  } finally {
    // Restore the original snapshot so we don't permanently mutate the
    // test business's state.
    await supa.from("business_configs").update({
      twilio_phone_number: snap.twilio_phone_number ?? null,
      transfer_enabled: snap.transfer_enabled ?? false,
      transfer_to_phone: snap.transfer_to_phone ?? null,
      transfer_conditions: snap.transfer_conditions ?? null,
      transfer_wait_message: snap.transfer_wait_message ?? null,
      transfer_warm_message: snap.transfer_warm_message ?? null,
    }).eq("business_id", businessId);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== ${passed}/${results.length} passed${failed > 0 ? `, ${failed} FAILED` : ""} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(1);
});
