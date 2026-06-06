/**
 * Sprint 3 Stage 5 Session 1 / Phase 1 — voice_id backfill.
 *
 * The business_configs.voice_id column historically stored OpenAI voice
 * names ('alloy', 'nova') that were never used to drive ElevenLabs. We
 * repurpose the column to hold the actual ElevenLabs voice_id that each
 * agent is configured with on ElevenLabs' side.
 *
 * For each business with agent_id NOT NULL:
 *   1. GET https://api.elevenlabs.io/v1/convai/agents/:agent_id
 *   2. Extract conversation_config.tts.voice_id
 *   3. If different from DB: UPDATE business_configs.voice_id +
 *      INSERT prompt_audit_log row with source='backfill'
 *   4. If 404 on the agent: log WARN, NULL out the DB voice_id, AND
 *      write a sentinel audit row so the event is grep-able later
 *      (new_prompt = 'AGENT_NOT_FOUND').
 *
 * Audit row mapping (the prompt_audit_log table has new_prompt NOT NULL
 * which we co-opt for the voice_id string — simpler than a metadata
 * column or a separate audit table):
 *   - source       = 'backfill'
 *   - old_prompt   = previous voice_id (might be 'alloy' / 'nova';
 *                    set to the literal string 'NULL' when the column
 *                    was actually NULL pre-backfill — keeps grep simple)
 *   - new_prompt   = newly persisted ElevenLabs voice_id, OR the
 *                    sentinel 'AGENT_NOT_FOUND' for the 404 path
 *   - language     = 'en' (CHECK constraint requires one of en/fr/es)
 *   - sync_to_elevenlabs_ok = true (we're aligning DB with what's
 *                             already on ElevenLabs, not pushing)
 *   - user_agent   = 'backfill-voice-ids.ts' so audit consumers can
 *                    distinguish backfill rows from runtime ones
 *
 * Idempotent: re-running produces "unchanged" lines and zero writes.
 *
 * Network errors: one retry after 2s, then mark the row as ERR and
 * continue. Aggregate counts in the final summary.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx \
 *     src/scripts/backfill-voice-ids.ts [--dry-run]
 *
 * Required env (all present in Replit production):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *   - ELEVENLABS_API_KEY
 *
 * Depends on migration 023 having been applied (the audit-source
 * CHECK constraint must allow 'voice_change'; 'backfill' was already
 * permitted by migration 021).
 *
 * Exit codes:
 *   0 — completed; zero per-row errors
 *   1 — env var missing
 *   2 — initial SELECT failed
 *   3 — completed but at least one per-row error or 404
 *   4 — uncaught exception
 */

import { createClient } from "@supabase/supabase-js";

const ELEVENLABS_AGENT_API = "https://api.elevenlabs.io/v1/convai/agents";
const RETRY_DELAY_MS = 2_000;
const DELAY_BETWEEN_AGENTS_MS = 150;

const DRY_RUN = process.argv.includes("--dry-run");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

interface AgentResponse {
  conversation_config?: {
    tts?: {
      voice_id?: unknown;
    };
  };
}

type FetchOutcome =
  | { kind: "ok"; voiceId: string }
  | { kind: "not_found" }
  | { kind: "missing_voice_id" }
  | { kind: "error"; message: string };

async function fetchAgentVoiceId(
  agentId: string,
  apiKey: string,
): Promise<FetchOutcome> {
  const url = `${ELEVENLABS_AGENT_API}/${agentId}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers: { "xi-api-key": apiKey } });

      if (response.status === 404) {
        return { kind: "not_found" };
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 0) {
          console.warn(
            `  [backfill] HTTP ${response.status} for ${agentId} — retrying in ${RETRY_DELAY_MS}ms`,
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        const body = await response.text().catch(() => "");
        return {
          kind: "error",
          message: `HTTP ${response.status} after retry: ${body.slice(0, 200)}`,
        };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          kind: "error",
          message: `HTTP ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      const json = (await response.json()) as AgentResponse;
      const voiceId = json?.conversation_config?.tts?.voice_id;
      if (typeof voiceId !== "string" || voiceId.length === 0) {
        return { kind: "missing_voice_id" };
      }
      return { kind: "ok", voiceId };
    } catch (err: any) {
      if (attempt === 0) {
        console.warn(
          `  [backfill] network error for ${agentId}: ${err?.message ?? err} — retrying`,
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return {
        kind: "error",
        message: `network: ${err?.message ?? String(err)}`,
      };
    }
  }
  return { kind: "error", message: "exhausted retries" };
}

interface Counts {
  total: number;
  updated: number;
  unchanged: number;
  notFound: number;
  missingVoiceField: number;
  errors: number;
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[backfill] ELEVENLABS_API_KEY not set");
    process.exit(1);
  }

  console.log("");
  console.log("=".repeat(72));
  console.log(
    `  Backfill voice_id from ElevenLabs → business_configs${DRY_RUN ? "  (DRY RUN)" : ""}`,
  );
  console.log("=".repeat(72));
  console.log("");
  if (DRY_RUN) {
    console.log(
      "  [backfill] --dry-run: no UPDATE or INSERT statements will execute.",
    );
    console.log("");
  }

  const supabase = getSupabase();

  console.log(
    "[backfill] fetching candidates (agent_id IS NOT NULL)...",
  );
  const { data: candidates, error: selectErr } = await supabase
    .from("business_configs")
    .select("business_id, business_name, agent_id, voice_id")
    .not("agent_id", "is", null)
    .order("business_id", { ascending: true });

  if (selectErr) {
    console.error("[backfill] SELECT failed:", selectErr.message);
    process.exit(2);
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
    unchanged: 0,
    notFound: 0,
    missingVoiceField: 0,
    errors: 0,
  };

  for (const row of candidates) {
    const r = row as {
      business_id: string;
      business_name: string | null;
      agent_id: string;
      voice_id: string | null;
    };
    const tag = `${r.business_id} (${(r.business_name ?? "—").slice(0, 32)})`;
    process.stdout.write(`  ${tag}: `);

    const result = await fetchAgentVoiceId(r.agent_id, apiKey);

    if (result.kind === "not_found") {
      console.log(`AGENT 404 — would set voice_id NULL`);
      counts.notFound++;
      if (!DRY_RUN) {
        const { error: updErr } = await supabase
          .from("business_configs")
          .update({ voice_id: null })
          .eq("business_id", r.business_id);
        if (updErr) {
          console.error(`    UPDATE failed: ${updErr.message}`);
          counts.errors++;
        } else {
          // Sentinel audit row so the 404 event is grep-able later via
          // `SELECT * FROM prompt_audit_log WHERE new_prompt =
          //  'AGENT_NOT_FOUND'`. Without this, the only trail is a
          // console.log that nobody reads after the run completes.
          const { error: auditErr } = await supabase
            .from("prompt_audit_log")
            .insert({
              business_id: r.business_id,
              changed_by_user_id: null,
              language: "en",
              source: "backfill",
              old_prompt: r.voice_id ?? "NULL",
              new_prompt: "AGENT_NOT_FOUND",
              sync_to_elevenlabs_ok: true,
              elevenlabs_error: null,
              user_agent: "backfill-voice-ids.ts",
            });
          if (auditErr) {
            console.error(
              `    audit insert failed (non-fatal): ${auditErr.message}`,
            );
          }
        }
      }
      await sleep(DELAY_BETWEEN_AGENTS_MS);
      continue;
    }

    if (result.kind === "missing_voice_id") {
      console.log("MISSING voice_id in conversation_config.tts — skipped");
      counts.missingVoiceField++;
      await sleep(DELAY_BETWEEN_AGENTS_MS);
      continue;
    }

    if (result.kind === "error") {
      console.log(`ERROR: ${result.message}`);
      counts.errors++;
      await sleep(DELAY_BETWEEN_AGENTS_MS);
      continue;
    }

    const newVoiceId = result.voiceId;
    const oldVoiceId = r.voice_id;

    if (oldVoiceId === newVoiceId) {
      console.log(`unchanged (${newVoiceId})`);
      counts.unchanged++;
      await sleep(DELAY_BETWEEN_AGENTS_MS);
      continue;
    }

    // Update + audit (or dry-run log only).
    const fromTag = oldVoiceId ?? "NULL";
    console.log(`${fromTag} → ${newVoiceId}`);
    counts.updated++;

    if (!DRY_RUN) {
      const { error: updErr } = await supabase
        .from("business_configs")
        .update({ voice_id: newVoiceId })
        .eq("business_id", r.business_id);
      if (updErr) {
        console.error(`    UPDATE failed: ${updErr.message}`);
        counts.errors++;
        counts.updated--; // didn't actually persist
        await sleep(DELAY_BETWEEN_AGENTS_MS);
        continue;
      }

      const { error: auditErr } = await supabase
        .from("prompt_audit_log")
        .insert({
          business_id: r.business_id,
          changed_by_user_id: null,
          language: "en",
          source: "backfill",
          old_prompt: oldVoiceId ?? "NULL",
          new_prompt: newVoiceId,
          sync_to_elevenlabs_ok: true,
          elevenlabs_error: null,
          user_agent: "backfill-voice-ids.ts",
        });
      if (auditErr) {
        // Non-fatal: the voice_id IS persisted; log loudly so ops can
        // backfill the audit row manually if it ever matters.
        console.error(
          `    audit insert failed (non-fatal): ${auditErr.message}`,
        );
      }
    }

    await sleep(DELAY_BETWEEN_AGENTS_MS);
  }

  // Summary --------------------------------------------------------------
  console.log("");
  console.log("=".repeat(72));
  console.log(`  Summary${DRY_RUN ? "  (DRY RUN — no writes)" : ""}`);
  console.log("=".repeat(72));
  const fmt = (label: string, n: number) =>
    `    ${label.padEnd(28, " ")} ${n.toString().padStart(6)}`;
  console.log(fmt("total candidates", counts.total));
  console.log(fmt("updated", counts.updated));
  console.log(fmt("unchanged", counts.unchanged));
  console.log(fmt("agent not found (404)", counts.notFound));
  console.log(fmt("missing voice_id field", counts.missingVoiceField));
  console.log(fmt("errors", counts.errors));
  console.log("");

  const exitCode =
    counts.errors > 0 || counts.notFound > 0 || counts.missingVoiceField > 0
      ? 3
      : 0;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("[backfill] UNCAUGHT:", err);
  process.exit(4);
});
