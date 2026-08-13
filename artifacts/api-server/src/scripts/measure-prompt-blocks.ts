/**
 * Phase 6.1 — per-block character-cost breakdown for a business's
 * rendered system prompt.
 *
 * READ-ONLY. Does not touch ElevenLabs, does not write to Supabase.
 * Safe to run against production.
 *
 * Reads business_configs + industry_templates the same way
 * scripts/resync-agent-prompt.ts does (Supabase-only; helium-pg
 * objection_handlers are skipped — matches the resync degradation
 * for parity of numbers). Renders via the current prompt-renderer,
 * then splits on SECTION_HEADERS and prints a table.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/measure-prompt-blocks.ts <business_id>
 *
 * Required env:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *
 * Output columns:
 *   block            — logical section name (see SECTION_HEADERS in prompt-renderer)
 *   chars            — character count for that block including its heading + trailing blank
 *   pct              — share of total prompt length
 *   gate             — which 6.1 gate governs the block (informational)
 *
 * Gate labels reported:
 *   websiteContext / painPoints_valueProps / callScripts_appointmentTypes / (none)
 *
 * Exit codes:
 *   0 — success
 *   1 — env / arg
 *   2 — business_configs row not found or missing required fields
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  renderPromptFromHelpers,
  measurePromptBlocks,
  type IndustryTemplate,
} from "../lib/prompt-renderer";

interface BusinessConfigRow {
  business_id: string;
  business_name: string | null;
  industry: string | null;
  owner_name: string | null;
  business_hours: string | null;
  services: string | null;
  website: string | null;
  phone_number: string | null;
  timezone: string | null;
  languages: string[] | null;
  spanish_enabled: boolean | null;
  french_enabled: boolean | null;
  custom_faqs: any;
  objection_handling: any;
  tone_preference: string | null;
  never_say_list: string[] | null;
  website_context_text: string | null;
  agent_id: string | null;
  transfer_enabled: boolean | null;
  record_appointment_enabled: boolean | null;
  departments: any;
}

const SELECT_COLUMNS =
  "business_id, business_name, industry, owner_name, business_hours, " +
  "services, website, phone_number, timezone, languages, spanish_enabled, " +
  "french_enabled, custom_faqs, objection_handling, tone_preference, " +
  "never_say_list, website_context_text, agent_id, transfer_enabled, " +
  "record_appointment_enabled, departments";

function requireEnv(): { supaUrl: string; supaKey: string } {
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) {
    console.error("[measure] missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    process.exit(1);
  }
  return { supaUrl, supaKey };
}

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
    console.warn("[measure] industry template direct lookup error:", directErr.message);
  } else if (direct) {
    return direct as unknown as IndustryTemplate;
  }
  const aliasJson = JSON.stringify([industryId]);
  const { data: aliased } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, pain_points, value_props, call_scripts, appointment_types")
    .filter("dedup_aliases", "cs", aliasJson)
    .maybeSingle();
  if (aliased) return aliased as unknown as IndustryTemplate;
  return null;
}

const GATE_BY_BLOCK: Record<string, string> = {
  website_context: "gated on faqs || services",
  pain_points: "gated on topics present",
  value_props: "gated on topics present",
  call_playbook: "each script gated on topic overlap",
  appointment_types: "each type gated on first-token topic overlap",
};

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

async function main(): Promise<void> {
  const businessId = process.argv[2];
  if (!businessId) {
    console.error("[measure] usage: tsx src/scripts/measure-prompt-blocks.ts <business_id>");
    process.exit(1);
  }

  const env = requireEnv();
  const supabase = createClient(env.supaUrl, env.supaKey);

  console.log(`[measure] business_id=${businessId}`);

  const { data: rowRaw, error: readErr } = await supabase
    .from("business_configs")
    .select(SELECT_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (readErr) {
    console.error(`[measure] business_configs read failed: ${readErr.message}`);
    process.exit(2);
  }
  if (!rowRaw) {
    console.error(`[measure] business_configs row not found for ${businessId}`);
    process.exit(2);
  }
  const row = rowRaw as unknown as BusinessConfigRow;

  const industryTemplate = await fetchIndustryTemplate(supabase, row.industry);

  const prompt = renderPromptFromHelpers({
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

  const blocks = measurePromptBlocks(prompt);
  const total = blocks.__total;

  const rows: Array<{ block: string; chars: number; pct: string; gate: string }> = [];
  for (const [k, v] of Object.entries(blocks)) {
    if (k === "__total") continue;
    rows.push({
      block: k,
      chars: v,
      pct: total > 0 ? ((v / total) * 100).toFixed(1) + "%" : "-",
      gate: GATE_BY_BLOCK[k] ?? "-",
    });
  }
  rows.sort((a, b) => b.chars - a.chars);

  console.log("");
  console.log(`Total prompt: ${total} chars`);
  console.log("");
  console.log(
    padRight("BLOCK", 24) +
      padLeft("CHARS", 8) +
      padLeft("PCT", 8) +
      "  GATE",
  );
  console.log("-".repeat(24 + 8 + 8 + 2 + 40));
  for (const r of rows) {
    console.log(
      padRight(r.block, 24) +
        padLeft(String(r.chars), 8) +
        padLeft(r.pct, 8) +
        "  " +
        r.gate,
    );
  }

  // Tenant-config signals — informational.
  console.log("");
  console.log("Tenant signals:");
  console.log(`  services present:  ${row.services && row.services.trim().length > 0 ? "yes" : "no"}`);
  const faqLen = Array.isArray(row.custom_faqs) ? row.custom_faqs.length : 0;
  console.log(`  custom_faqs count: ${faqLen}`);
  const topicLen = Array.isArray(row.departments) ? row.departments.length : 0;
  console.log(`  topics count:      ${topicLen}`);
  const scrapeLen = typeof row.website_context_text === "string" ? row.website_context_text.length : 0;
  console.log(`  website_context:   ${scrapeLen} chars (raw, pre-clean)`);
}

main().catch((err) => {
  console.error("[measure] unexpected:", err?.message || err);
  process.exit(1);
});
