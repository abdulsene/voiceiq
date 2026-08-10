/**
 * Fleet-wide prompt resync for the leads-capture repair.
 *
 * Loops over SELECT business_id FROM business_configs WHERE agent_id
 * IS NOT NULL and runs the same per-business resync logic as
 * src/scripts/resync-agent-prompt.ts for each. Idempotent: rows whose
 * system_prompt ALREADY mentions request_callback are skipped — safe
 * to re-run after partial failures.
 *
 * Usage:
 *   Dry run (no PATCH, no DB write — just lists what WOULD change):
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/backfill-agent-prompts.ts --dry-run
 *
 *   Live run:
 *     pnpm --filter @workspace/api-server exec tsx \
 *       src/scripts/backfill-agent-prompts.ts
 *
 *   Limit scope (optional):
 *     --limit=N        only touch the first N eligible businesses
 *     --start-after=ID resume after a specific business_id (alphabetical sort)
 *
 * Required env:
 *   ELEVENLABS_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * Required migration:
 *   023_extend_prompt_audit_log_source.sql — extends source CHECK to
 *   include 'leads_capture_backfill'. Without it, audit inserts fail
 *   the CHECK but the prompt PATCH already happened (idempotent rerun
 *   re-emits the audit row once the migration is applied).
 *
 * Throttle: 300ms between businesses to keep ElevenLabs happy. Twilio
 * is NOT involved (this is a prompt-only resync, no recordings or
 * calls). One retry after 5s on a 429.
 *
 * Exit codes:
 *   0 — completed; zero failures
 *   1 — env missing OR arg parse error
 *   2 — initial SELECT failed
 *   3 — completed but at least one per-business failure
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  renderPromptFromHelpers,
  type IndustryTemplate,
} from "../lib/prompt-renderer";
import { updateAgentPrompt } from "../lib/elevenlabs-agent";

const SLEEP_BETWEEN_MS = 300;
const RATE_LIMIT_RETRY_DELAY_MS = 5_000;

interface CliArgs {
  dryRun: boolean;
  limit: number | null;
  startAfter: string | null;
}

function parseArgs(): CliArgs {
  const args: CliArgs = { dryRun: false, limit: null, startAfter: null };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--dry-run") args.dryRun = true;
    else if (raw.startsWith("--limit=")) {
      const n = parseInt(raw.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`[backfill] invalid --limit value: ${raw}`);
        process.exit(1);
      }
      args.limit = n;
    } else if (raw.startsWith("--start-after=")) {
      args.startAfter = raw.slice("--start-after=".length);
    } else {
      console.error(`[backfill] unknown arg: ${raw}`);
      process.exit(1);
    }
  }
  return args;
}

function requireEnv(): { supaUrl: string; supaKey: string } {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  const elKey = process.env.ELEVENLABS_API_KEY;
  if (!supaUrl || !supaKey || !elKey) {
    console.error("[backfill] missing env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY all required.");
    process.exit(1);
  }
  return { supaUrl, supaKey };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface BusinessConfigRow {
  business_id: string;
  business_name: string | null;
  industry: string | null;
  business_hours: string | null;
  timezone: string | null;
  owner_name: string | null;
  services: string | null;
  website: string | null;
  phone_number: string | null;
  languages: string[] | null;
  spanish_enabled: boolean | null;
  french_enabled: boolean | null;
  custom_faqs: Array<{ question: string; answer: string }> | null;
  objection_handling: Array<{ objection: string; response: string }> | null;
  tone_preference: string | null;
  never_say_list: string[] | null;
  website_context_text: string | null;
  agent_id: string | null;
  system_prompt: string | null;
  // Phase 5.3 — tool flags passed to the renderer so tool references
  // are gated on actual registration state.
  transfer_enabled: boolean | null;
  record_appointment_enabled: boolean | null;
  departments: unknown;
}

const SELECT_COLUMNS =
  "business_id, business_name, industry, business_hours, timezone, " +
  "owner_name, services, website, phone_number, languages, " +
  "spanish_enabled, french_enabled, custom_faqs, objection_handling, " +
  "tone_preference, never_say_list, website_context_text, agent_id, " +
  "system_prompt, transfer_enabled, record_appointment_enabled, departments";

async function fetchIndustryTemplate(
  supabase: SupabaseClient,
  industryId: string | null | undefined,
): Promise<IndustryTemplate | null> {
  if (!industryId) return null;
  const { data: direct } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, pain_points, value_props, call_scripts, appointment_types")
    .eq("industry_id", industryId)
    .maybeSingle();
  if (direct) return direct as unknown as IndustryTemplate;
  const aliasJson = JSON.stringify([industryId]);
  const { data: aliased } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, pain_points, value_props, call_scripts, appointment_types")
    .filter("dedup_aliases", "cs", aliasJson)
    .maybeSingle();
  return aliased ? (aliased as unknown as IndustryTemplate) : null;
}

type ProcessOutcome =
  | { kind: "skipped_already_repaired" }
  | { kind: "would_repair" }
  | { kind: "repaired" }
  | { kind: "failed"; stage: string; error: string };

async function processBusiness(
  supabase: SupabaseClient,
  row: BusinessConfigRow,
  dryRun: boolean,
): Promise<ProcessOutcome> {
  if (!row.agent_id) {
    return { kind: "failed", stage: "guard", error: "no_agent_id" };
  }
  // Idempotency: skip rows whose system_prompt already mentions
  // request_callback. A re-run after a partial failure should not
  // re-PATCH agents that are already correct.
  if (row.system_prompt && row.system_prompt.includes("request_callback")) {
    return { kind: "skipped_already_repaired" };
  }

  const industryTemplate = await fetchIndustryTemplate(supabase, row.industry);
  const newPrompt = renderPromptFromHelpers({
    business_name: row.business_name || "your business",
    industry: row.industry || "general",
    owner_name: row.owner_name ?? undefined,
    business_hours: row.business_hours || "Monday-Friday 9AM-5PM",
    services: row.services ?? undefined,
    website: row.website ?? undefined,
    phone_number: row.phone_number ?? undefined,
    timezone: row.timezone || "America/New_York",
    languages: row.languages ?? undefined,
    spanish_enabled: row.spanish_enabled ?? undefined,
    french_enabled: row.french_enabled ?? undefined,
    industryTemplate,
    websiteContext: row.website_context_text,
    customFaqs: row.custom_faqs,
    objectionHandling: row.objection_handling,
    objectionHandlersFromTable: null,
    tonePreference: row.tone_preference,
    neverSayList: row.never_say_list,
    topics: Array.isArray(row.departments)
      ? (row.departments as any[]).filter(
          (t) => t && typeof t === "object" && typeof t.slug === "string" && typeof t.name === "string",
        )
      : null,
    toolsAvailable: {
      transfer: !!row.transfer_enabled,
      record_appointment: !!row.record_appointment_enabled,
    },
  });

  if (!newPrompt.includes("request_callback") || newPrompt.includes("save_lead")) {
    return { kind: "failed", stage: "render", error: "safety_check_failed" };
  }

  if (dryRun) return { kind: "would_repair" };

  // ElevenLabs PATCH with one retry on 429. Anything else returns
  // structured failure.
  let sync = await updateAgentPrompt(row.agent_id, "en", newPrompt);
  if (!sync.ok && (sync as any).httpStatus === 429) {
    console.warn(`[backfill] 429 for ${row.business_id} — retrying in ${RATE_LIMIT_RETRY_DELAY_MS}ms`);
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    sync = await updateAgentPrompt(row.agent_id, "en", newPrompt);
  }
  if (!sync.ok) {
    return { kind: "failed", stage: "elevenlabs", error: (sync as any).error || "unknown" };
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("business_configs")
    .update({
      system_prompt: newPrompt,
      prompt_updated_at: nowIso,
      prompt_last_synced_at: nowIso,
      prompt_sync_error: null,
    })
    .eq("business_id", row.business_id);
  if (updErr) {
    return { kind: "failed", stage: "db_write", error: updErr.message };
  }

  const { error: auditErr } = await supabase
    .from("prompt_audit_log")
    .insert({
      business_id: row.business_id,
      changed_by_user_id: null,
      language: "en",
      source: "leads_capture_backfill",
      old_prompt: row.system_prompt ?? "(no pre-repair prompt stored)",
      new_prompt: newPrompt.slice(0, 50_000),
      sync_to_elevenlabs_ok: true,
      elevenlabs_error: null,
      ip_address: null,
      user_agent: "scripts/backfill-agent-prompts.ts",
    });
  if (auditErr) {
    return { kind: "failed", stage: "audit", error: auditErr.message };
  }

  return { kind: "repaired" };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const env = requireEnv();
  const supabase = createClient(env.supaUrl, env.supaKey);

  console.log(
    `[backfill] mode=${args.dryRun ? "DRY-RUN" : "LIVE"} ` +
    `limit=${args.limit ?? "none"} start_after=${args.startAfter ?? "none"}`,
  );

  let q = supabase
    .from("business_configs")
    .select(SELECT_COLUMNS)
    .not("agent_id", "is", null)
    .order("business_id", { ascending: true });
  if (args.startAfter) q = q.gt("business_id", args.startAfter);
  if (args.limit) q = q.limit(args.limit);

  const { data, error: readErr } = await q;
  if (readErr) {
    console.error(`[backfill] initial SELECT failed: ${readErr.message}`);
    process.exit(2);
  }
  const rows = (data as unknown as BusinessConfigRow[]) || [];
  console.log(`[backfill] ${rows.length} eligible business(es) with agent_id`);

  const tally = { repaired: 0, would_repair: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const outcome = await processBusiness(supabase, row, args.dryRun);
    switch (outcome.kind) {
      case "skipped_already_repaired":
        tally.skipped += 1;
        console.log(`  ✓ skip       ${row.business_id} (already mentions request_callback)`);
        break;
      case "would_repair":
        tally.would_repair += 1;
        console.log(`  → would repair ${row.business_id} (agent=${row.agent_id})`);
        break;
      case "repaired":
        tally.repaired += 1;
        console.log(`  ✓ repaired   ${row.business_id} (agent=${row.agent_id})`);
        break;
      case "failed":
        tally.failed += 1;
        console.error(`  ✗ failed     ${row.business_id} stage=${outcome.stage} error=${outcome.error}`);
        break;
    }
    await sleep(SLEEP_BETWEEN_MS);
  }

  console.log(`[backfill] done. repaired=${tally.repaired} would_repair=${tally.would_repair} skipped=${tally.skipped} failed=${tally.failed}`);
  process.exit(tally.failed === 0 ? 0 : 3);
}

main().catch((err) => {
  console.error("[backfill] unexpected error:", err);
  process.exit(1);
});
