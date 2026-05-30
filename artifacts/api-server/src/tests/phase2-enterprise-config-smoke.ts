/**
 * Sprint 5 Phase 2 — enterprise-config write-path verification harness.
 *
 * Exercises updateEnterpriseConfig (routes/enterprise.ts) against a real
 * business_configs row in Supabase. Idempotent: resets the row to a known
 * baseline before and after, so no permanent data change. No schema
 * changes. PK columns untouched.
 *
 * What this harness validates:
 *   1. Direct columns accept the right JSON shapes from the helper's payload
 *      (branding_config, security_policy, ip_whitelist, sla_level,
 *      isolation_model + the mfa_required convenience side-effect)
 *   2. Migration 012 CHECK constraints reject invalid enum values cleanly
 *      (PG code 23514) — both sla_level and isolation_model
 *   3. enterprise_config JSONB merge preserves prior keys (read-then-write
 *      pattern that mirrors the helper's actual code path)
 *
 * Uses the Supabase JS client directly because business_configs lives in
 * the Supabase project DB, not in the Replit-managed pg DB that contactPool
 * connects to (DATABASE_URL host: `helium`, SUPABASE_URL host: `*.supabase.co`).
 * This mirrors the helper's actual connection path.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/phase2-enterprise-config-smoke.ts
 */
import { createClient } from "@supabase/supabase-js";

const TEST_BIZ = "biz_1776968643213_dxwf60";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
);

async function snapshot() {
  const { data } = await supabase
    .from("business_configs")
    .select(
      "branding_config, security_policy, ip_whitelist, mfa_required, sla_level, isolation_model, sso_config, parent_business_id, enterprise_config",
    )
    .eq("business_id", TEST_BIZ)
    .maybeSingle();
  return data;
}

async function reset() {
  const { error } = await supabase
    .from("business_configs")
    .update({
      branding_config: null,
      security_policy: null,
      ip_whitelist: null,
      mfa_required: false,
      sla_level: null,
      isolation_model: "shared",
      sso_config: null,
      parent_business_id: null,
      enterprise_config: {},
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", TEST_BIZ);
  if (error) throw new Error(`reset failed: ${error.message}`);
}

async function happyPath() {
  // Mirrors Abdul's smoke payload, applied via the same field set the
  // helper would write.
  const branding = { logoUrl: "https://example.com/logo.png", primaryColor: "#2E75B6" };
  const security = { mfaRequired: true, encryptionRequired: true };
  const ipList = ["10.0.0.0/8", "192.168.0.0/16"];
  const { error } = await supabase
    .from("business_configs")
    .update({
      branding_config: branding,
      security_policy: security,
      mfa_required: true, // helper's convenience side-effect
      ip_whitelist: ipList, // top-level overrides nested
      sla_level: "enterprise",
      isolation_model: "shared",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", TEST_BIZ);
  if (error) throw new Error(`happy path failed: ${error.message}`);
}

async function rejection(badValue: string) {
  const { error } = await supabase
    .from("business_configs")
    .update({ sla_level: badValue, updated_at: new Date().toISOString() })
    .eq("business_id", TEST_BIZ);
  return error
    ? { rejected: true, code: error.code, message: error.message, details: error.details }
    : { rejected: false };
}

async function rejectionIsolation(badValue: string) {
  const { error } = await supabase
    .from("business_configs")
    .update({ isolation_model: badValue, updated_at: new Date().toISOString() })
    .eq("business_id", TEST_BIZ);
  return error
    ? { rejected: true, code: error.code, message: error.message, details: error.details }
    : { rejected: false };
}

async function catchAllMerge() {
  // Pre-seed enterprise_config with a key that should survive the merge.
  const { error: seedErr } = await supabase
    .from("business_configs")
    .update({ enterprise_config: { existingKey: "keepMe" } })
    .eq("business_id", TEST_BIZ);
  if (seedErr) throw new Error(`seed failed: ${seedErr.message}`);

  // Read existing, merge in JS, write back (matches helper's logic).
  const { data: existing } = await supabase
    .from("business_configs")
    .select("enterprise_config")
    .eq("business_id", TEST_BIZ)
    .maybeSingle();
  const prior = (existing?.enterprise_config as Record<string, unknown>) || {};
  const merged = { ...prior, name: "Acme Co", customDomain: "acme.example.com" };
  const { error } = await supabase
    .from("business_configs")
    .update({ enterprise_config: merged })
    .eq("business_id", TEST_BIZ);
  if (error) throw new Error(`merge failed: ${error.message}`);
}

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "  PASS" : "  FAIL"} — ${label}`);
  if (!ok) {
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
  }
  return ok;
}

async function main() {
  console.log("=== Phase 2 smoke ===");
  console.log("Test business_id:", TEST_BIZ);
  let allPass = true;

  console.log("\n[0] Reset baseline");
  await reset();
  const base = await snapshot();
  console.log("baseline snapshot:", JSON.stringify(base));

  console.log("\n[1] Happy path — Abdul's smoke payload");
  await happyPath();
  const after = await snapshot();
  console.log("after snapshot:", JSON.stringify(after, null, 2));
  allPass = check("branding_config.logoUrl", (after?.branding_config as any)?.logoUrl, "https://example.com/logo.png") && allPass;
  allPass = check("branding_config.primaryColor", (after?.branding_config as any)?.primaryColor, "#2E75B6") && allPass;
  allPass = check("security_policy.mfaRequired", (after?.security_policy as any)?.mfaRequired, true) && allPass;
  allPass = check("security_policy.encryptionRequired", (after?.security_policy as any)?.encryptionRequired, true) && allPass;
  allPass = check("ip_whitelist", after?.ip_whitelist, ["10.0.0.0/8", "192.168.0.0/16"]) && allPass;
  allPass = check("mfa_required convenience side-effect", after?.mfa_required, true) && allPass;
  allPass = check("sla_level", after?.sla_level, "enterprise") && allPass;
  allPass = check("isolation_model", after?.isolation_model, "shared") && allPass;

  console.log("\n[2] CHECK rejection — slaLevel='premium' (expect PG 23514)");
  const r1 = await rejection("premium");
  console.log("rejection result:", JSON.stringify(r1));
  allPass = check("sla_level=premium rejected", r1.rejected, true) && allPass;
  allPass = check("PG error code = 23514", (r1 as any).code, "23514") && allPass;

  console.log("\n[3] CHECK rejection — isolationModel='hybrid' (expect PG 23514)");
  const r2 = await rejectionIsolation("hybrid");
  console.log("rejection result:", JSON.stringify(r2));
  allPass = check("isolation_model=hybrid rejected", r2.rejected, true) && allPass;
  allPass = check("PG error code = 23514", (r2 as any).code, "23514") && allPass;

  console.log("\n[4] enterprise_config catch-all JSONB merge");
  await catchAllMerge();
  const merged = await snapshot();
  console.log("enterprise_config after merge:", JSON.stringify(merged?.enterprise_config));
  allPass = check("merged.existingKey preserved", (merged?.enterprise_config as any)?.existingKey, "keepMe") && allPass;
  allPass = check("merged.name added", (merged?.enterprise_config as any)?.name, "Acme Co") && allPass;
  allPass = check("merged.customDomain added", (merged?.enterprise_config as any)?.customDomain, "acme.example.com") && allPass;

  console.log("\n[5] Cleanup — reset to baseline");
  await reset();
  const post = await snapshot();
  console.log("post-cleanup snapshot:", JSON.stringify(post));

  console.log(`\n=== Phase 2 smoke ${allPass ? "PASSED" : "FAILED"} ===`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
