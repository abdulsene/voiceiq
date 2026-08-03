/**
 * Phase 0 Commit 0-C — compliance gates smoke.
 *
 *   DNC (T1-T4)
 *     T1 — leads.do_not_call=TRUE blocks via blocked_by='lead_marked'
 *     T2 — dnc_list row blocks via blocked_by='tenant_dnc_list', with
 *          source captured
 *     T3 — neither match → allowed
 *     T4 — DB error fails closed (allowed=false, blocked_by='tenant_dnc_list',
 *          no dnc_record)
 *
 *   Calling hours (T5-T9)
 *     T5 — outbound_voice_enabled=FALSE → tenant_disabled
 *     T6 — Monday 10:00 in 08:00-21:00 window with days [1..7] → allowed
 *     T7 — 07:30 → outside_hours (before start)
 *     T8 — 21:00 → outside_hours (end is exclusive)
 *     T9 — Sunday when days=[1..5] → wrong_day
 *
 *   Voice consent (T10-T13)
 *     T10 — explicit grant with revoked_at IS NULL → allowed with
 *           consent_record_id
 *     T11 — explicit grant with revoked_at SET → blocked_by='revoked',
 *           still surfaces consent_record_id for audit
 *     T12 — no record but voice_consent_default=TRUE → allowed
 *           with via_tenant_default=true
 *     T13 — no record + voice_consent_default=FALSE → blocked_by='no_record'
 *
 *   Orchestrator (T14-T15)
 *     T14 — DNC + calling_hours both fail → blocked_by='dnc' (priority)
 *           AND all three check results surfaced
 *     T15 — all three pass → allowed with consent_record_id propagated
 *
 * Strategy: FakeSupabaseClient implements the maybeSingle / order / eq
 * chain for the specific selects used by the helpers. Each test
 * configures the fake's response table BEFORE invoking the helper.
 * No real DB, no real network.
 *
 * Time determinism: every calling-hours test passes a fixed `now`
 * (UTC instant) + recipientTimezone so the result doesn't drift with
 * the machine clock or DST changes.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx \
 *        ./src/tests/023-outbound-voice-compliance-smoke.ts
 */

import { checkDnc } from "../lib/dnc-check";
import { checkCallingHours } from "../lib/calling-hours";
import { checkVoiceConsent } from "../lib/voice-consent";
import { checkCompliance, enforceOutboundEligibility } from "../lib/outbound-voice/compliance";
import type { SupabaseClient } from "@supabase/supabase-js";

interface TestResult { name: string; pass: boolean; details: string; }
const results: TestResult[] = [];
function record(name: string, pass: boolean, details: string) {
  results.push({ name, pass, details });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${details}`);
}

// ── Fake Supabase client ──────────────────────────────────────────────
// Captures the (table, filters) sequence and returns a programmable
// response. Each helper does exactly one ".from(table).select(...).eq(...)
// [.eq(...)][.order(...)][.limit(...)].maybeSingle()" call; the fake
// matches the first response whose `match` predicate returns true.

type FakeResponse = {
  match: (call: FakeCall) => boolean;
  data?: any;
  error?: { message: string } | null;
  throwOnAccess?: boolean;
};
type FakeCall = {
  table: string;
  selectColumns: string;
  eqFilters: Array<{ column: string; value: any }>;
};

class FakeBuilder {
  constructor(
    private fake: FakeSupabaseClient,
    private call: FakeCall,
  ) {}
  select(cols: string) {
    this.call.selectColumns = cols;
    return this;
  }
  eq(col: string, val: any) {
    this.call.eqFilters.push({ column: col, value: val });
    return this;
  }
  // Phase 5.1 — voice-opt-out check uses .is('resubscribed_at', null).
  // Treat as an eqFilter marker for test purposes; consumers only key
  // on table + eqFilters when matching a fake response.
  is(col: string, val: any) {
    this.call.eqFilters.push({ column: col, value: val });
    return this;
  }
  order(_col: string, _opts?: any) { return this; }
  limit(_n: number) { return this; }
  async maybeSingle(): Promise<{ data: any; error: { message: string } | null }> {
    return this.fake.resolveCall(this.call);
  }
}

class FakeSupabaseClient {
  private responses: FakeResponse[] = [];
  public calls: FakeCall[] = [];

  on(match: FakeResponse["match"], spec: Omit<FakeResponse, "match">) {
    this.responses.push({ match, ...spec });
  }

  reset() {
    this.responses = [];
    this.calls = [];
  }

  from(table: string) {
    const call: FakeCall = {
      table,
      selectColumns: "",
      eqFilters: [],
    };
    this.calls.push(call);
    return new FakeBuilder(this, call);
  }

  async resolveCall(call: FakeCall): Promise<{ data: any; error: { message: string } | null }> {
    const r = this.responses.find((rr) => rr.match(call));
    if (!r) return { data: null, error: null };
    if (r.throwOnAccess) throw new Error("simulated DB exception");
    return { data: r.data ?? null, error: r.error ?? null };
  }
}

// Helpers
function asClient(fake: FakeSupabaseClient): SupabaseClient {
  return fake as unknown as SupabaseClient;
}
const BIZ = "biz_test_023";
const PHONE = "+12025557777";
const LEAD = "00000000-0000-0000-0000-000000000023";

// ── DNC tests ──────────────────────────────────────────────────────────

async function runDncTests() {
  // T1
  {
    const fake = new FakeSupabaseClient();
    fake.on(
      (c) => c.table === "leads" && c.eqFilters.some((f) => f.column === "id" && f.value === LEAD),
      { data: { do_not_call: true } },
    );
    const r = await checkDnc(asClient(fake), { businessId: BIZ, phone: PHONE, leadId: LEAD });
    const ok = !r.allowed && r.blocked_by === "lead_marked";
    record("T1 leads.do_not_call=TRUE blocks", ok, JSON.stringify(r));
  }
  // T2
  {
    const fake = new FakeSupabaseClient();
    fake.on(
      (c) => c.table === "leads",
      { data: { do_not_call: false } },
    );
    fake.on(
      (c) => c.table === "dnc_list",
      {
        data: { source: "voice_optout", reason: "customer_request", created_at: "2026-06-10T12:00:00Z" },
      },
    );
    const r = await checkDnc(asClient(fake), { businessId: BIZ, phone: PHONE, leadId: LEAD });
    const ok =
      !r.allowed &&
      r.blocked_by === "tenant_dnc_list" &&
      r.dnc_record?.source === "voice_optout" &&
      r.dnc_record?.reason === "customer_request";
    record("T2 dnc_list match blocks with source", ok, JSON.stringify(r));
  }
  // T3
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    const r = await checkDnc(asClient(fake), { businessId: BIZ, phone: PHONE, leadId: LEAD });
    record("T3 neither blocks → allowed", r.allowed === true && !r.blocked_by, JSON.stringify(r));
  }
  // T4
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null, error: { message: "connection refused" } });
    const r = await checkDnc(asClient(fake), { businessId: BIZ, phone: PHONE, leadId: LEAD });
    const ok = !r.allowed && r.blocked_by === "tenant_dnc_list" && !r.dnc_record;
    record("T4 DB error fails closed (no dnc_record)", ok, JSON.stringify(r));
  }
}

// ── Calling-hours tests ───────────────────────────────────────────────

function bizConfigResponse(overrides: {
  enabled?: boolean;
  start?: string;
  end?: string;
  days?: number[];
}) {
  return {
    data: {
      outbound_voice_enabled: overrides.enabled ?? true,
      outbound_calling_hours_start: overrides.start ?? "08:00:00",
      outbound_calling_hours_end: overrides.end ?? "21:00:00",
      outbound_calling_hours_days: overrides.days ?? [1, 2, 3, 4, 5, 6, 7],
    },
  };
}

async function runCallingHoursTests() {
  // T5
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "business_configs", bizConfigResponse({ enabled: false }));
    const r = await checkCallingHours(asClient(fake), {
      businessId: BIZ,
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    record("T5 outbound_voice_enabled=FALSE → tenant_disabled", !r.allowed && r.blocked_by === "tenant_disabled", JSON.stringify(r));
  }
  // T6 — 2026-06-15 is a Monday; 15:00 UTC = 11:00 EDT
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "business_configs", bizConfigResponse({}));
    const r = await checkCallingHours(asClient(fake), {
      businessId: BIZ,
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    const ok = r.allowed && r.recipient_local_time === "11:00" && r.recipient_local_weekday === 1;
    record("T6 Mon 11:00 EDT in 08-21 → allowed", ok, JSON.stringify(r));
  }
  // T7 — 11:30 UTC = 07:30 EDT
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "business_configs", bizConfigResponse({}));
    const r = await checkCallingHours(asClient(fake), {
      businessId: BIZ,
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T11:30:00Z"),
    });
    const ok = !r.allowed && r.blocked_by === "outside_hours" && r.recipient_local_time === "07:30";
    record("T7 07:30 EDT (before 08:00) → outside_hours", ok, JSON.stringify(r));
  }
  // T8 — 01:00 UTC = 21:00 EDT day prior; use 2026-06-16T01:00:00Z which is Mon 21:00 EDT
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "business_configs", bizConfigResponse({}));
    const r = await checkCallingHours(asClient(fake), {
      businessId: BIZ,
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-16T01:00:00Z"),
    });
    const ok = !r.allowed && r.blocked_by === "outside_hours" && r.recipient_local_time === "21:00";
    record("T8 21:00 EDT at exclusive end → outside_hours", ok, JSON.stringify(r));
  }
  // T9 — Sunday 2026-06-14T16:00:00Z = Sun 12:00 EDT; days=[1..5] Mon-Fri
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "business_configs", bizConfigResponse({ days: [1, 2, 3, 4, 5] }));
    const r = await checkCallingHours(asClient(fake), {
      businessId: BIZ,
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-14T16:00:00Z"),
    });
    const ok = !r.allowed && r.blocked_by === "wrong_day" && r.recipient_local_weekday === 7;
    record("T9 Sun with days=[1..5] → wrong_day", ok, JSON.stringify(r));
  }
}

// ── Voice consent tests ───────────────────────────────────────────────

async function runVoiceConsentTests() {
  // T10
  {
    const fake = new FakeSupabaseClient();
    fake.on(
      (c) => c.table === "voice_consent_records",
      { data: { id: "consent_a", revoked_at: null } },
    );
    const r = await checkVoiceConsent(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      consentType: "appointment_reminder",
    });
    record(
      "T10 explicit grant unrevoked → allowed",
      r.allowed && r.consent_record_id === "consent_a" && !r.via_tenant_default,
      JSON.stringify(r),
    );
  }
  // T11
  {
    const fake = new FakeSupabaseClient();
    fake.on(
      (c) => c.table === "voice_consent_records",
      { data: { id: "consent_b", revoked_at: "2026-06-10T00:00:00Z" } },
    );
    const r = await checkVoiceConsent(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      consentType: "appointment_reminder",
    });
    record(
      "T11 explicit grant revoked → blocked_by=revoked + id surfaced",
      !r.allowed && r.blocked_by === "revoked" && r.consent_record_id === "consent_b",
      JSON.stringify(r),
    );
  }
  // T12 (Phase 5.1) — no record, tenant default TRUE → STILL BLOCKED.
  // The Phase 5.1 retirement of the voice_consent_default bypass
  // means the tenant-wide flag is no longer consulted. Even if
  // an ops user flipped voice_consent_default=true on a business,
  // consent must now be per-phone in voice_consent_records.
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "voice_consent_records", { data: null });
    // Deliberately still stub business_configs to prove the code
    // does NOT read the column anymore — if it did, this test's
    // `voice_consent_default: true` would flip the assertion.
    fake.on((c) => c.table === "business_configs", { data: { voice_consent_default: true } });
    const r = await checkVoiceConsent(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      consentType: "appointment_reminder",
    });
    record(
      "T12 (Phase 5.1) no record + tenant default TRUE → STILL blocked_by=no_record (bypass retired)",
      !r.allowed && r.blocked_by === "no_record" && !r.via_tenant_default,
      JSON.stringify(r),
    );
  }
  // T13
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "voice_consent_records", { data: null });
    fake.on((c) => c.table === "business_configs", { data: { voice_consent_default: false } });
    const r = await checkVoiceConsent(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      consentType: "appointment_reminder",
    });
    record(
      "T13 no record + tenant default FALSE → blocked_by=no_record",
      !r.allowed && r.blocked_by === "no_record" && !r.consent_record_id,
      JSON.stringify(r),
    );
  }
}

// ── Orchestrator tests ────────────────────────────────────────────────

async function runOrchestratorTests() {
  // T14: DNC + calling_hours both fail → blocked_by='dnc'
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on(
      (c) => c.table === "dnc_list",
      { data: { source: "manual", reason: null, created_at: "2026-06-01T00:00:00Z" } },
    );
    fake.on((c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({ enabled: false }));
    fake.on((c) => c.table === "voice_consent_records", { data: { id: "consent_x", revoked_at: null } });
    // Phase 5.1: voice_opt_outs stub (empty).
    fake.on((c) => c.table === "voice_opt_outs", { data: null });
    const r = await checkCompliance(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      leadId: LEAD,
      consentType: "appointment_reminder",
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    const ok =
      !r.allowed &&
      r.blocked_by === "dnc" &&
      r.checks.dnc.allowed === false &&
      r.checks.calling_hours.allowed === false &&
      r.checks.consent.allowed === true &&
      r.checks.voice_opt_out.allowed === true;
    record("T14 DNC priority over calling_hours, full checks surfaced", ok, JSON.stringify({
      blocked_by: r.blocked_by, dnc: r.checks.dnc.allowed, ch: r.checks.calling_hours.allowed, c: r.checks.consent.allowed, oo: r.checks.voice_opt_out.allowed,
    }));
  }
  // T15: all pass → allowed, consent_record_id propagated
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    fake.on(
      (c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({}),
    );
    fake.on(
      (c) => c.table === "voice_consent_records",
      { data: { id: "consent_z", revoked_at: null } },
    );
    fake.on((c) => c.table === "voice_opt_outs", { data: null });
    const r = await checkCompliance(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      leadId: LEAD,
      consentType: "appointment_reminder",
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    const ok = r.allowed && !r.blocked_by && r.checks.consent.consent_record_id === "consent_z";
    record("T15 all pass → allowed with consent_record_id", ok, JSON.stringify({ allowed: r.allowed, cid: r.checks.consent.consent_record_id }));
  }
  // T16 (Phase 5.1) — voice_opt_out hit → highest priority, blocks everything else
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    fake.on((c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({}));
    fake.on((c) => c.table === "voice_consent_records",
      { data: { id: "consent_q", revoked_at: null } });
    fake.on((c) => c.table === "voice_opt_outs",
      { data: { id: "opt_out_1", source: "mid_call_verbal", resubscribed_at: null } });
    const r = await checkCompliance(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      leadId: LEAD,
      consentType: "appointment_reminder",
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    const ok =
      !r.allowed &&
      r.blocked_by === "voice_opt_out" &&
      r.checks.voice_opt_out.opt_out_id === "opt_out_1";
    record("T16 (Phase 5.1) voice_opt_out beats DNC + consent + hours", ok, JSON.stringify({
      blocked_by: r.blocked_by, oo_id: r.checks.voice_opt_out.opt_out_id,
    }));
  }
  // T17 (Phase 5.1) — staff_manual_dial bypasses ONLY consent.
  // In-hours + no opt-out + no DNC → allowed even with no consent record.
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    fake.on((c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({}));
    // NO consent record — would normally block. staff_manual_dial bypass allows it.
    fake.on((c) => c.table === "voice_consent_records", { data: null });
    fake.on((c) => c.table === "voice_opt_outs", { data: null });
    const r = await checkCompliance(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      leadId: LEAD,
      consentType: "staff_manual_dial",   // <-- the exemption
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"), // 11am ET Mon — inside default 08-21
    });
    const ok = r.allowed && !r.blocked_by;
    record("T17 (Phase 5.1) staff_manual_dial bypasses consent (person-to-person, not autodialer)", ok, JSON.stringify({
      allowed: r.allowed, blocked_by: r.blocked_by,
    }));
  }
  // T17b (Phase 5.1) — staff_manual_dial does NOT bypass voice_opt_out.
  // A customer who explicitly asked to be removed means it, even for a
  // person-to-person dial. This is the strongest "no" — no exceptions.
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    fake.on((c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({}));
    fake.on((c) => c.table === "voice_consent_records", { data: null });
    // Customer has an ACTIVE opt-out on file.
    fake.on((c) => c.table === "voice_opt_outs",
      { data: { id: "opt_out_manual_block", source: "mid_call_verbal", resubscribed_at: null } });
    const r = await checkCompliance(asClient(fake), {
      businessId: BIZ,
      phone: PHONE,
      leadId: LEAD,
      consentType: "staff_manual_dial",   // manual dial — bypass consent only
      recipientTimezone: "America/New_York",
      now: new Date("2026-06-15T15:00:00Z"),
    });
    const ok = !r.allowed && r.blocked_by === "voice_opt_out" && r.checks.voice_opt_out.opt_out_id === "opt_out_manual_block";
    record("T17b (Phase 5.1) staff_manual_dial STILL blocked by voice_opt_out (no exceptions)", ok, JSON.stringify({
      allowed: r.allowed, blocked_by: r.blocked_by, oo_id: r.checks.voice_opt_out.opt_out_id,
    }));
  }
  // T18 (Phase 5.1) — enforceOutboundEligibility throws on block
  {
    const fake = new FakeSupabaseClient();
    fake.on((c) => c.table === "leads", { data: { do_not_call: false } });
    fake.on((c) => c.table === "dnc_list", { data: null });
    fake.on((c) => c.table === "business_configs" && c.selectColumns.includes("outbound_voice_enabled"),
      bizConfigResponse({}));
    fake.on((c) => c.table === "voice_consent_records", { data: null });
    fake.on((c) => c.table === "voice_opt_outs", { data: null });
    let threw = false;
    let attachedDecision: any = null;
    try {
      await enforceOutboundEligibility(asClient(fake), {
        businessId: BIZ,
        phone: PHONE,
        leadId: LEAD,
        consentType: "marketing",  // will fail consent check
        recipientTimezone: "America/New_York",
        now: new Date("2026-06-15T15:00:00Z"),
      });
    } catch (e: any) {
      threw = true;
      attachedDecision = e.decision;
    }
    const ok = threw && attachedDecision?.blocked_by === "consent";
    record("T18 (Phase 5.1) enforceOutboundEligibility THROWS on block with decision attached", ok,
      JSON.stringify({ threw, blocked_by: attachedDecision?.blocked_by }));
  }
}

async function main() {
  await runDncTests();
  await runCallingHoursTests();
  await runVoiceConsentTests();
  await runOrchestratorTests();

  const fails = results.filter((r) => !r.pass);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke harness crashed:", err);
  process.exit(2);
});
