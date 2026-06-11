/**
 * Leads epic Slice 1 — capture + read smoke harness.
 *
 *   T1 — POST /api/leads/capture with valid Bearer + payload → 200,
 *        leads row exists with all fields propagated, lead_activities
 *        has the seed row (action='captured', actor_type='ai', metadata
 *        carries conversation_id).
 *   T2 — POST with wrong Bearer → 401 (no insert).
 *   T3 — POST missing a required field → 400 (no insert).
 *   T4 — GET /api/business/leads as the fixture business's authenticated
 *        user returns the captured lead.
 *   T5 — GET /api/business/leads/:id returns lead + activities array in
 *        chronological order.
 *   T6 — A second business's lead is NOT returned to the first
 *        business's user (cross-tenant isolation).
 *   T7 — Admin GET /api/admin/business/:bid/leads returns leads for that
 *        business (informational — skipped if no admin bearer).
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/017-leads-capture-smoke.ts
 *
 * Requires (env):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY  — fixture setup
 *   TEST_API_BASE                       — default http://localhost:8080
 *   TEST_AUTH_BEARER                    — JWT for a customer user of the
 *                                          fixture business (required for
 *                                          T4-T6)
 *   ELEVENLABS_TOOL_SECRET              — same value the api-server has;
 *                                          required for T1's Bearer auth
 *   TEST_ADMIN_BEARER                   — optional; JWT for a staff user
 *                                          with customers:read. Skips T7
 *                                          if absent.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const API = process.env.TEST_API_BASE || "http://localhost:8080";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const AUTH_BEARER = process.env.TEST_AUTH_BEARER || "";
const ADMIN_BEARER = process.env.TEST_ADMIN_BEARER || "";
const TOOL_SECRET = process.env.ELEVENLABS_TOOL_SECRET || "";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function setupFixtureBusiness(supa: SupabaseClient, suffix: string): Promise<{ businessId: string; agentId: string }> {
  const businessId = `biz_test_leads_${Date.now()}_${suffix}`;
  const agentId = `agent_test_leads_${Date.now()}_${suffix}`;
  const { error } = await supa.from("business_configs").insert({
    business_id: businessId,
    business_name: `Leads Smoke ${suffix}`,
    industry: "general",
    phone_number: "+15555550000",
    email: `leads-${suffix}@neverr.test`,
    timezone: "America/New_York",
    business_hours: "Monday-Friday 9AM-5PM",
    status: "active",
    subscription_status: "trialing",
    agent_id: agentId,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`fixture insert failed: ${error.message}`);
  return { businessId, agentId };
}

async function teardownFixtureBusiness(supa: SupabaseClient, businessId: string) {
  try {
    // FK from lead_activities → leads has ON DELETE CASCADE, so deleting
    // leads also drops activities.
    await supa.from("leads").delete().eq("business_id", businessId);
    await supa.from("business_configs").delete().eq("business_id", businessId);
  } catch (err) {
    console.warn(`cleanup: teardownFixtureBusiness(${businessId}) failed`, err);
  }
}

function buildCapturePayload(businessId: string, suffix: string) {
  return {
    business_id: businessId,
    conversation_id: `conv_${suffix}_${crypto.randomBytes(4).toString("hex")}`,
    contact_name: "Jordan Tester",
    contact_phone: "+14105550001",
    contact_email: `jordan-${suffix}@neverr.test`,
    reason: "Wants a quote on a 26-foot truck rental for next Saturday.",
    urgency: "medium",
    preferred_channel: "text",
  };
}

async function postJson(path: string, body: any, headers: Record<string, string> = {}): Promise<{ http: number; json: any; text: string }> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { http: r.status, json, text };
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<{ http: number; json: any; text: string }> {
  const r = await fetch(`${API}${path}`, { headers });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { http: r.status, json, text };
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — cannot run.");
    process.exit(1);
  }
  if (!TOOL_SECRET) {
    console.error("Missing ELEVENLABS_TOOL_SECRET — capture endpoint won't authenticate without it.");
    process.exit(1);
  }
  const supa = adminClient();

  const sfx1 = crypto.randomBytes(3).toString("hex");
  const fixture = await setupFixtureBusiness(supa, sfx1);

  // T6 needs a second business so we can confirm tenant isolation.
  const sfx2 = crypto.randomBytes(3).toString("hex");
  const otherFixture = await setupFixtureBusiness(supa, sfx2);

  let firstLeadId: string | null = null;

  try {
    // ----- T1: happy capture -----
    try {
      const payload = buildCapturePayload(fixture.businessId, "t1");
      const r = await postJson("/api/leads/capture", payload, { Authorization: `Bearer ${TOOL_SECRET}` });
      if (r.http !== 200 || !r.json?.success || !r.json?.lead_id) {
        record("T1 capture happy → 200 + lead_id", false, `http=${r.http} body=${r.text.slice(0, 300)}`);
      } else {
        firstLeadId = r.json.lead_id;
        const { data: leadRow } = await supa.from("leads").select("id, business_id, contact_name, contact_phone, contact_email, reason, urgency, preferred_channel, status, source").eq("id", firstLeadId).single();
        const { data: activities } = await supa.from("lead_activities").select("action, actor_type, metadata").eq("lead_id", firstLeadId).order("created_at", { ascending: true });
        const lead = leadRow as any;
        const acts = (activities as any[]) || [];
        const seed = acts[0];
        const allRight =
          lead?.business_id === fixture.businessId
          && lead?.contact_phone === payload.contact_phone
          && lead?.urgency === payload.urgency
          && lead?.preferred_channel === payload.preferred_channel
          && lead?.status === "new"
          && lead?.source === "ai_callback"
          && seed?.action === "captured"
          && seed?.actor_type === "ai"
          && seed?.metadata?.conversation_id === payload.conversation_id;
        if (allRight) {
          record("T1 capture happy + seed activity", true, `lead.id=${firstLeadId}, activities=${acts.length}`);
        } else {
          record("T1 capture happy + seed activity", false, `lead=${JSON.stringify(lead)} seed=${JSON.stringify(seed)}`);
        }
      }
    } catch (err: any) {
      record("T1 capture happy", false, `threw: ${err.message}`);
    }

    // ----- T2: wrong Bearer -----
    try {
      const r = await postJson("/api/leads/capture", buildCapturePayload(fixture.businessId, "t2"), { Authorization: `Bearer wrong-token-${crypto.randomBytes(4).toString("hex")}` });
      if (r.http === 401) {
        record("T2 wrong Bearer → 401", true, "http=401");
      } else {
        record("T2 wrong Bearer → 401", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
      }
    } catch (err: any) {
      record("T2 wrong Bearer → 401", false, `threw: ${err.message}`);
    }

    // ----- T3: missing required field (reason) -----
    try {
      const bad = buildCapturePayload(fixture.businessId, "t3");
      delete (bad as any).reason;
      const r = await postJson("/api/leads/capture", bad, { Authorization: `Bearer ${TOOL_SECRET}` });
      if (r.http === 400 && typeof r.json?.error === "string") {
        record("T3 missing required field → 400", true, `error="${r.json.error.slice(0, 80)}"`);
      } else {
        record("T3 missing required field → 400", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
      }
    } catch (err: any) {
      record("T3 missing required field → 400", false, `threw: ${err.message}`);
    }

    // ----- T4/T5/T6 need the authenticated customer JWT. Skip gracefully
    // if absent so T1-T3 still run unblocked in dev.
    if (!AUTH_BEARER) {
      record("T4 customer GET /leads (skipped)", true, "no TEST_AUTH_BEARER");
      record("T5 customer GET /leads/:id (skipped)", true, "no TEST_AUTH_BEARER");
      record("T6 cross-tenant isolation (skipped)", true, "no TEST_AUTH_BEARER");
    } else {
      // Confirm the authenticated user actually belongs to the fixture
      // business — otherwise T4 is testing the wrong thing. We can't
      // swap the auth user mid-test, so we INSERT a fixture lead onto
      // whatever business the JWT's user is currently on, and assert
      // that one comes back. Cross-tenant assertion (T6) uses a SECOND
      // fixture business explicitly.
      const meRes = await fetch(`${API}/api/auth/me`, { headers: { Authorization: `Bearer ${AUTH_BEARER}` } });
      const me = await meRes.json() as { current_business_id?: string };
      const callerBusinessId = me?.current_business_id;
      if (!callerBusinessId) {
        record("T4/T5/T6 prep — auth/me", false, "no current_business_id");
      } else {
        // Insert a lead directly attached to the caller's actual
        // business (NOT our fixture) so it WILL show up in their
        // /business/leads list.
        const { data: callerLeadInsert } = await supa.from("leads").insert({
          business_id: callerBusinessId,
          source: "ai_callback",
          contact_name: "T4 Caller",
          contact_phone: "+14105550004",
          reason: "Smoke test T4 — direct insert under caller's business.",
          urgency: "low",
          preferred_channel: "email",
          status: "new",
        }).select("id").single();
        const callerLeadId = (callerLeadInsert as { id?: string } | null)?.id;
        await supa.from("lead_activities").insert({
          lead_id: callerLeadId,
          actor_type: "system",
          action: "captured",
          metadata: { synthetic: "t4_prep" },
        });

        // T4: list contains our seeded lead
        try {
          const r = await getJson(`/api/business/leads?limit=100`, { Authorization: `Bearer ${AUTH_BEARER}` });
          const found = ((r.json?.leads as any[]) || []).some((l) => l.id === callerLeadId);
          if (r.http === 200 && found) {
            record("T4 customer GET /business/leads → contains seeded lead", true, `total=${r.json?.total}`);
          } else {
            record("T4 customer GET /business/leads → contains seeded lead", false, `http=${r.http} found=${found} body=${r.text.slice(0, 200)}`);
          }
        } catch (err: any) {
          record("T4 customer GET /business/leads", false, `threw: ${err.message}`);
        }

        // T5: detail returns lead + activities chronologically
        try {
          const r = await getJson(`/api/business/leads/${callerLeadId}`, { Authorization: `Bearer ${AUTH_BEARER}` });
          const ok = r.http === 200 && r.json?.lead?.id === callerLeadId && Array.isArray(r.json?.activities) && r.json.activities.length >= 1 && r.json.activities[0]?.action === "captured";
          if (ok) {
            record("T5 customer GET /business/leads/:id → lead + activities", true, `activity_count=${r.json.activities.length}`);
          } else {
            record("T5 customer GET /business/leads/:id → lead + activities", false, `http=${r.http} body=${r.text.slice(0, 200)}`);
          }
        } catch (err: any) {
          record("T5 customer GET /business/leads/:id", false, `threw: ${err.message}`);
        }

        // T6: lead on otherFixture business is NOT returned. Insert a
        // lead onto otherFixture, list from the caller's session, assert
        // not present.
        try {
          const { data: otherLeadInsert } = await supa.from("leads").insert({
            business_id: otherFixture.businessId,
            source: "ai_callback",
            contact_name: "T6 Other",
            contact_phone: "+14105550006",
            reason: "Should NOT appear to the other business's user.",
            urgency: "medium",
            preferred_channel: "text",
            status: "new",
          }).select("id").single();
          const otherLeadId = (otherLeadInsert as { id?: string } | null)?.id;

          const list = await getJson(`/api/business/leads?limit=200`, { Authorization: `Bearer ${AUTH_BEARER}` });
          const leaked = ((list.json?.leads as any[]) || []).some((l) => l.id === otherLeadId);
          const detail = await getJson(`/api/business/leads/${otherLeadId}`, { Authorization: `Bearer ${AUTH_BEARER}` });

          if (!leaked && detail.http === 404) {
            record("T6 cross-tenant isolation", true, "other-tenant lead absent from list AND 404 on detail");
          } else {
            record("T6 cross-tenant isolation", false, `leaked=${leaked} detail.http=${detail.http}`);
          }
        } catch (err: any) {
          record("T6 cross-tenant isolation", false, `threw: ${err.message}`);
        }

        // Cleanup the synthetic lead we inserted under callerBusinessId.
        if (callerLeadId) {
          try { await supa.from("leads").delete().eq("id", callerLeadId); } catch { /* best effort */ }
        }
      }
    }

    // ----- T7: admin endpoint -----
    if (!ADMIN_BEARER) {
      record("T7 admin GET /admin/business/:bid/leads (skipped)", true, "no TEST_ADMIN_BEARER");
    } else {
      try {
        const r = await getJson(`/api/admin/business/${fixture.businessId}/leads`, { Authorization: `Bearer ${ADMIN_BEARER}` });
        const containsOurT1Lead = firstLeadId
          ? ((r.json?.leads as any[]) || []).some((l) => l.id === firstLeadId)
          : false;
        if (r.http === 200 && containsOurT1Lead) {
          record("T7 admin GET /admin/business/:bid/leads → contains T1 lead", true, `total=${r.json?.total}`);
        } else {
          record("T7 admin GET /admin/business/:bid/leads → contains T1 lead", false, `http=${r.http} found=${containsOurT1Lead} body=${r.text.slice(0, 200)}`);
        }
      } catch (err: any) {
        record("T7 admin GET /admin/business/:bid/leads", false, `threw: ${err.message}`);
      }
    }
  } finally {
    await teardownFixtureBusiness(supa, fixture.businessId);
    await teardownFixtureBusiness(supa, otherFixture.businessId);
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
