/**
 * Single-business prompt resync — re-render system_prompt from
 * business_configs helpers, PATCH the ElevenLabs agent, persist
 * sync-state columns, and write a prompt_audit_log row tagged
 * source='leads_capture_repair'.
 *
 * Built for the leads-capture-repair sweep (Slice 1 was non-functional
 * because the rendered prompt named save_lead / check_availability —
 * neither registered as a tool. Renderer now names request_callback
 * explicitly; this script makes the fix land on a specific business
 * without waiting for the customer to touch their settings).
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/resync-agent-prompt.ts <business_id>
 *
 * Required env:
 *   ELEVENLABS_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * Required migration:
 *   023_extend_prompt_audit_log_source.sql (extends the source CHECK
 *   to include 'leads_capture_repair'). Without it, the audit insert
 *   fails the CHECK and the script exits non-zero AFTER the prompt is
 *   already updated server-side — re-running is idempotent.
 *
 * Design notes:
 *   - Imports stay narrow (lib/prompt-renderer, lib/elevenlabs-agent,
 *     @supabase/supabase-js) so the script doesn't drag in routes/api.ts
 *     and its module-load side effects (Twilio, Google, contactPool, etc).
 *   - fetchIndustryTemplate is inlined from routes/api.ts (Supabase-only).
 *   - objection_handlers table lives on the helium-pg DATABASE_URL pool —
 *     intentionally NOT loaded here. The rendered prompt may therefore
 *     omit objection-response pairs from that table. JSONB
 *     business_configs.objection_handling IS included. Acceptable
 *     degradation for the repair sweep; the next /regenerate touches
 *     by the owner restore full fidelity.
 *
 * Exit codes:
 *   0 — success (prompt re-rendered, PATCH ok, DB columns + audit row updated)
 *   1 — env var missing OR business_id arg missing
 *   2 — business_configs row not found, no agent_id, or read error
 *   3 — render produced an empty prompt / safety check failed
 *   4 — ElevenLabs PATCH failed
 *   5 — Supabase write failed (system_prompt / sync-state)
 *   6 — audit row insert failed (prompt was still synced; review manually)
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  renderPromptFromHelpers,
  type IndustryTemplate,
} from "../lib/prompt-renderer";
import { updateAgentPrompt } from "../lib/elevenlabs-agent";

function requireEnv(): { supaUrl: string; supaKey: string } {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  const elKey = process.env.ELEVENLABS_API_KEY;
  if (!supaUrl || !supaKey || !elKey) {
    console.error(
      "[resync] missing env: SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY all required.",
    );
    process.exit(1);
  }
  return { supaUrl, supaKey };
}

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
}

const SELECT_COLUMNS =
  "business_id, business_name, industry, business_hours, timezone, " +
  "owner_name, services, website, phone_number, languages, " +
  "spanish_enabled, french_enabled, custom_faqs, objection_handling, " +
  "tone_preference, never_say_list, website_context_text, agent_id";

async function fetchIndustryTemplate(
  supabase: SupabaseClient,
  industryId: string | null | undefined,
): Promise<IndustryTemplate | null> {
  if (!industryId) return null;
  const { data: direct, error: directErr } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, pain_points, value_props, call_scripts, appointment_types")
    .eq("industry_id", industryId)
    .maybeSingle();
  if (directErr) {
    console.warn("[resync] industry template direct lookup error:", directErr.message);
  } else if (direct) {
    return direct as unknown as IndustryTemplate;
  }
  const aliasJson = JSON.stringify([industryId]);
  const { data: aliased, error: aliasErr } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, pain_points, value_props, call_scripts, appointment_types")
    .filter("dedup_aliases", "cs", aliasJson)
    .maybeSingle();
  if (aliasErr) {
    console.warn("[resync] industry template alias lookup error:", aliasErr.message);
    return null;
  }
  if (aliased) {
    console.log("[resync] industry template alias resolved:", industryId, "->", (aliased as any).industry_id);
    return aliased as unknown as IndustryTemplate;
  }
  return null;
}

async function main(): Promise<void> {
  const businessId = process.argv[2];
  if (!businessId) {
    console.error("[resync] usage: tsx src/scripts/resync-agent-prompt.ts <business_id>");
    process.exit(1);
  }

  const env = requireEnv();
  const supabase = createClient(env.supaUrl, env.supaKey);

  console.log(`[resync] starting for business_id=${businessId}`);

  // 1. Read business_configs.
  const { data: rowRaw, error: readErr } = await supabase
    .from("business_configs")
    .select(SELECT_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (readErr) {
    console.error(`[resync] business_configs read failed: ${readErr.message}`);
    process.exit(2);
  }
  if (!rowRaw) {
    console.error(`[resync] business_configs row not found for ${businessId}`);
    process.exit(2);
  }
  const row = rowRaw as unknown as BusinessConfigRow;
  if (!row.agent_id) {
    console.error(`[resync] no agent_id on business_configs for ${businessId} — nothing to sync`);
    process.exit(2);
  }

  // 2. Fetch industry template (Supabase). Objection-handlers from
  //    helium-pg are intentionally skipped here — see header.
  const industryTemplate = await fetchIndustryTemplate(supabase, row.industry);

  // 3. Re-render prompt with the (now fixed) renderer.
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
  });
  const mentionsRequestCallback = newPrompt.includes("request_callback");
  const mentionsSaveLead = newPrompt.includes("save_lead");
  console.log(
    `[resync] rendered prompt length=${newPrompt.length} mentions_request_callback=${mentionsRequestCallback} mentions_save_lead=${mentionsSaveLead}`,
  );
  if (!mentionsRequestCallback || mentionsSaveLead) {
    console.error(
      "[resync] safety check failed — renderer output does not contain request_callback or still contains save_lead. aborting before PATCH.",
    );
    process.exit(3);
  }

  // 4. PATCH ElevenLabs. Uses the Stage-4 verify-after-write client.
  const syncResult = await updateAgentPrompt(row.agent_id, "en", newPrompt);
  if (!syncResult.ok) {
    console.error(
      `[resync] elevenlabs PATCH failed: ${(syncResult as any).error || JSON.stringify(syncResult)}`,
    );
    process.exit(4);
  }
  console.log(
    `[resync] elevenlabs PATCH ok: agent=${row.agent_id} chars=${syncResult.charsWritten}`,
  );

  // 5. Persist to business_configs.
  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from("business_configs")
    .update({
      system_prompt: newPrompt,
      prompt_updated_at: nowIso,
      prompt_last_synced_at: nowIso,
      prompt_sync_error: null,
    })
    .eq("business_id", businessId);
  if (updErr) {
    console.error(`[resync] business_configs write failed: ${updErr.message}`);
    process.exit(5);
  }

  // 6. Audit row. NON-FATAL on failure since the prompt already synced;
  //    just log loudly and exit 6 so an ops sweep can re-emit the row.
  const { error: auditErr } = await supabase
    .from("prompt_audit_log")
    .insert({
      business_id: businessId,
      changed_by_user_id: null,
      language: "en",
      source: "leads_capture_repair",
      old_prompt: "(pre-repair prompt — see business_configs.system_prompt history)",
      new_prompt: newPrompt.slice(0, 50_000),
      sync_to_elevenlabs_ok: true,
      elevenlabs_error: null,
      ip_address: null,
      user_agent: "scripts/resync-agent-prompt.ts",
    });
  if (auditErr) {
    console.error(
      `[resync] audit insert failed (prompt is already synced server-side): ${auditErr.message}`,
    );
    console.error(
      "[resync] check that migration 023_extend_prompt_audit_log_source.sql has been applied.",
    );
    process.exit(6);
  }

  console.log(`[resync] done business_id=${businessId} prompt_len=${newPrompt.length}`);
}

main().catch((err) => {
  console.error("[resync] unexpected error:", err);
  process.exit(1);
});
