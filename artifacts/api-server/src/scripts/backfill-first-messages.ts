/**
 * Sprint 4 — first_message disclosure backfill.
 *
 * Pushes the universal recording-disclosure greeting (rendered by
 * lib/first-message-renderer.renderFirstMessage) onto every production
 * ElevenLabs agent we manage. Idempotent: a re-run with all agents
 * already current produces zero PATCHes and zero audit rows.
 *
 * Why this script: Sprint 4 Phase 2 changed every NEW agent creation
 * site to render with disclosure, but existing agents (12+ live
 * customers as of this commit) still speak the legacy greeting. EZ
 * Rentals was manually patched pre-deploy this morning to unblock
 * Maryland two-party-consent compliance; this script catches the rest.
 *
 * For each business_configs row with agent_id NOT NULL:
 *   1. GET first_message via lib/elevenlabs-agent.fetchAgentFirstMessage
 *   2. Render target via renderFirstMessage({ business_name })
 *   3. If equal → SKIPPED (e.g. EZ Rentals, or any re-run)
 *   4. Else → PATCH via updateAgentFirstMessage (which does verify-
 *      after-write internally) and INSERT a prompt_audit_log row
 *      with source='first_message_backfill'
 *   5. On any error (404, network, PATCH non-2xx, verify mismatch,
 *      missing business_name) → log FAILED, write audit row with
 *      sync_to_elevenlabs_ok=false + the helper's error message
 *
 * Audit row mapping:
 *   - source                   = 'first_message_backfill'
 *   - changed_by_user_id       = null  (system, not a user)
 *   - language                 = 'en'
 *   - old_prompt               = previous first_message (or 'NULL'
 *                                literal when ElevenLabs had no value)
 *   - new_prompt               = newly written first_message text, OR
 *                                the sentinel 'AGENT_NOT_FOUND' for
 *                                the 404 path
 *   - sync_to_elevenlabs_ok    = true on PATCH success, false on
 *                                PATCH/verify failure
 *   - elevenlabs_error         = helper's error message on failure
 *   - user_agent               = 'backfill-first-messages.ts' so
 *                                HistoryViewer can flag these rows
 *                                as scripted writes (Code icon in the
 *                                diff dialog)
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/backfill-first-messages.ts [--dry-run]
 *
 * Required env (all present in Replit production):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - ELEVENLABS_API_KEY
 *
 * Depends on migration 024 (extends prompt_audit_log.source CHECK to
 * accept 'first_message_change' and 'first_message_backfill').
 *
 * Exit codes:
 *   0 — all candidates succeeded or were SKIPPED (already current)
 *   1 — at least one FAILED (network, 404, PATCH error, audit-insert
 *       error, or missing business_name); see per-row output + summary
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  fetchAgentFirstMessage,
  updateAgentFirstMessage,
} from "../lib/elevenlabs-agent";
import { renderFirstMessage } from "../lib/first-message-renderer";

const DELAY_BETWEEN_AGENTS_MS = 150;

const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

interface Candidate {
  business_id: string;
  business_name: string | null;
  agent_id: string;
}

interface Counts {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
}

type RowOutcome = "UPDATED" | "SKIPPED" | "FAILED";

// Output format per Sprint 4 Phase 3 spec:
//   BUSINESS_ID | name (40-char truncated) | STATUS | detail
function logRow(
  businessId: string,
  businessName: string | null,
  status: RowOutcome,
  detail: string,
): void {
  const name = (businessName ?? "—").slice(0, 40).padEnd(40);
  const statusPadded = status.padEnd(8);
  console.log(`  ${businessId.padEnd(36)} | ${name} | ${statusPadded} | ${detail}`);
}

/**
 * Write the audit row. Best-effort: on insert failure we log loudly
 * but the PATCH is already persisted on ElevenLabs, so we don't fail
 * the whole row. Returns true on success, false on insert error.
 */
async function writeAuditRow(
  supabase: SupabaseClient,
  args: {
    business_id: string;
    old_prompt: string;
    new_prompt: string;
    sync_ok: boolean;
    elevenlabs_error: string | null;
  },
): Promise<boolean> {
  const { error } = await supabase.from("prompt_audit_log").insert({
    business_id: args.business_id,
    changed_by_user_id: null,
    language: "en",
    source: "first_message_backfill",
    old_prompt: args.old_prompt,
    new_prompt: args.new_prompt,
    sync_to_elevenlabs_ok: args.sync_ok,
    elevenlabs_error: args.elevenlabs_error,
    user_agent: "backfill-first-messages.ts",
  });
  if (error) {
    console.error(`    audit insert failed (non-fatal): ${error.message}`);
    return false;
  }
  return true;
}

async function processRow(
  supabase: SupabaseClient,
  row: Candidate,
): Promise<RowOutcome> {
  // Step 0: render the target greeting. Empty business_name throws —
  // catch loudly so the operator sees which row needs a name backfilled.
  let target: string;
  try {
    target = renderFirstMessage({
      business_name: row.business_name ?? "",
    });
  } catch (err: any) {
    logRow(
      row.business_id,
      row.business_name,
      "FAILED",
      `cannot render greeting: ${err?.message ?? err}`,
    );
    return "FAILED";
  }

  // Step 1: fetch current first_message.
  const current = await fetchAgentFirstMessage(row.agent_id);

  if (!current.ok) {
    // 404 specifically: agent doesn't exist on ElevenLabs. Write a
    // sentinel audit row so the event is grep-able later (matches the
    // voice backfill's AGENT_NOT_FOUND pattern).
    if (current.httpStatus === 404) {
      logRow(
        row.business_id,
        row.business_name,
        "FAILED",
        `agent not found on ElevenLabs (${row.agent_id})`,
      );
      if (!DRY_RUN) {
        await writeAuditRow(supabase, {
          business_id: row.business_id,
          old_prompt: "NULL",
          new_prompt: "AGENT_NOT_FOUND",
          sync_ok: false,
          elevenlabs_error: current.error,
        });
      }
      return "FAILED";
    }
    logRow(
      row.business_id,
      row.business_name,
      "FAILED",
      `fetch failed: ${current.error}`,
    );
    return "FAILED";
  }

  const oldMessage = current.firstMessage; // string | null

  // Step 2: compare. Identical → SKIPPED, no PATCH, no audit row.
  if (oldMessage === target) {
    logRow(
      row.business_id,
      row.business_name,
      "SKIPPED",
      "already current",
    );
    return "SKIPPED";
  }

  // Step 3: PATCH (or dry-run announce).
  if (DRY_RUN) {
    const fromTag =
      oldMessage === null
        ? "(no first_message set)"
        : `"${oldMessage.slice(0, 60)}${oldMessage.length > 60 ? "…" : ""}"`;
    logRow(
      row.business_id,
      row.business_name,
      "UPDATED",
      `would patch — from ${fromTag}`,
    );
    return "UPDATED";
  }

  const patch = await updateAgentFirstMessage(row.agent_id, target);

  if (!patch.ok) {
    logRow(
      row.business_id,
      row.business_name,
      "FAILED",
      `PATCH failed (${patch.stage}): ${patch.error}`,
    );
    await writeAuditRow(supabase, {
      business_id: row.business_id,
      old_prompt: oldMessage ?? "NULL",
      new_prompt: target,
      sync_ok: false,
      elevenlabs_error: patch.error,
    });
    return "FAILED";
  }

  logRow(row.business_id, row.business_name, "UPDATED", "patched + verified");
  await writeAuditRow(supabase, {
    business_id: row.business_id,
    old_prompt: oldMessage ?? "NULL",
    new_prompt: target,
    sync_ok: true,
    elevenlabs_error: null,
  });
  return "UPDATED";
}

async function main(): Promise<void> {
  if (!process.env.ELEVENLABS_API_KEY) {
    console.error("[backfill] ELEVENLABS_API_KEY not set");
    process.exit(1);
  }

  console.log("");
  console.log("=".repeat(96));
  console.log(
    `  Backfill first_message disclosure → ElevenLabs${DRY_RUN ? "  (DRY RUN)" : ""}`,
  );
  console.log("=".repeat(96));
  console.log("");
  if (DRY_RUN) {
    console.log(
      "  [backfill] --dry-run: no ElevenLabs PATCHes, no audit-log writes.",
    );
    console.log("");
  }

  const supabase = getSupabase();

  console.log(
    "[backfill] fetching candidates (agent_id IS NOT NULL)...",
  );
  const { data: candidates, error: selectErr } = await supabase
    .from("business_configs")
    .select("business_id, business_name, agent_id")
    .not("agent_id", "is", null)
    .order("business_id", { ascending: true });

  if (selectErr) {
    console.error("[backfill] SELECT failed:", selectErr.message);
    process.exit(1);
  }
  if (!candidates || candidates.length === 0) {
    console.log("[backfill] no candidates with agent_id. Done.");
    process.exit(0);
  }

  console.log(`[backfill] ${candidates.length} candidate(s)`);
  console.log("");

  const counts: Counts = {
    total: candidates.length,
    updated: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of candidates) {
    const outcome = await processRow(supabase, row as Candidate);
    if (outcome === "UPDATED") counts.updated++;
    else if (outcome === "SKIPPED") counts.skipped++;
    else counts.failed++;

    // Gentle pacing so ElevenLabs doesn't rate-limit us mid-run. The
    // helper already retries 429/5xx once internally — this is just
    // surface-level politeness.
    await sleep(DELAY_BETWEEN_AGENTS_MS);
  }

  // Summary --------------------------------------------------------------
  console.log("");
  console.log("=".repeat(96));
  console.log(`  Summary${DRY_RUN ? "  (DRY RUN — no writes)" : ""}`);
  console.log("=".repeat(96));
  const fmt = (label: string, n: number) =>
    `    ${label.padEnd(20, " ")} ${n.toString().padStart(6)}`;
  console.log(fmt("total candidates", counts.total));
  console.log(fmt("updated", counts.updated));
  console.log(fmt("skipped", counts.skipped));
  console.log(fmt("failed", counts.failed));
  console.log("");

  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] UNCAUGHT:", err);
  process.exit(1);
});
