/**
 * Sprint 3 Stage 1 — one-off backfill of business_configs.system_prompt
 * from each business's existing ElevenLabs agent.
 *
 * For every row in business_configs with a non-NULL agent_id and a
 * NULL system_prompt, fetches the agent's current prompt from
 * ElevenLabs, persists it to business_configs.system_prompt, and
 * writes a prompt_audit_log entry tagged source='backfill'.
 *
 * Idempotent: rows whose system_prompt is already populated are
 * skipped — re-running the script is safe.
 *
 * Usage on Replit production:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/backfill-prompts.ts
 *
 * Required environment:
 *   - ELEVENLABS_API_KEY
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_KEY
 *
 * Depends on migrations 020 (prompt columns) and 021 (prompt_audit_log)
 * being applied first. Running this before either migration will
 * surface a clear PostgREST error and exit non-zero.
 *
 * Network cost: one GET per eligible agent. Zero Twilio charges.
 *
 * Exit codes:
 *   0 — completed; no failures
 *   1 — env var missing
 *   2 — initial SELECT failed
 *   3 — completed, but at least one per-agent failure (rate_limited
 *       or error)
 *   4 — unexpected error caught by the outer handler
 */

import { createClient } from "@supabase/supabase-js";

const ELEVENLABS_AGENT_API = "https://api.elevenlabs.io/v1/convai/agents";
const DELAY_BETWEEN_AGENTS_MS = 200; // polite throttle between calls
const RATE_LIMIT_RETRY_DELAY_MS = 5_000; // one retry after 429

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required");
  }
  return createClient(url, key);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AgentResponse {
  conversation_config?: {
    agent?: {
      prompt?: {
        prompt?: string;
      };
    };
  };
}

type FetchStatus =
  | "success"
  | "skipped_404"
  | "skipped_empty"
  | "skipped_shape"
  | "rate_limited"
  | "error";

interface FetchResult {
  status: FetchStatus;
  prompt?: string;
  errorMessage?: string;
}

async function fetchAgentPrompt(
  agentId: string,
  apiKey: string,
): Promise<FetchResult> {
  const url = `${ELEVENLABS_AGENT_API}/${agentId}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { "xi-api-key": apiKey } });
  } catch (err: any) {
    return { status: "error", errorMessage: `Network error: ${err?.message ?? err}` };
  }

  // 404 → agent was deleted from ElevenLabs even though the DB row
  // still references it. Skip cleanly; ops can decide later whether
  // to null out the orphan agent_id.
  if (response.status === 404) {
    return { status: "skipped_404" };
  }

  // 429 → one polite retry after a pause, then bail if still rate-
  // limited.
  if (response.status === 429) {
    console.warn(`[backfill] 429 for agent ${agentId} — retrying in ${RATE_LIMIT_RETRY_DELAY_MS}ms`);
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    try {
      response = await fetch(url, { headers: { "xi-api-key": apiKey } });
    } catch (err: any) {
      return { status: "error", errorMessage: `Network error on retry: ${err?.message ?? err}` };
    }
    if (response.status === 429) {
      return { status: "rate_limited", errorMessage: "429 after one retry" };
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      status: "error",
      errorMessage: `HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  let json: AgentResponse;
  try {
    json = (await response.json()) as AgentResponse;
  } catch (err: any) {
    return { status: "error", errorMessage: `JSON parse: ${err?.message ?? err}` };
  }

  const promptText = json?.conversation_config?.agent?.prompt?.prompt;
  if (typeof promptText !== "string") {
    return {
      status: "skipped_shape",
      errorMessage:
        "Unexpected agent response shape — conversation_config.agent.prompt.prompt missing",
    };
  }
  if (promptText.length === 0) {
    return { status: "skipped_empty" };
  }

  return { status: "success", prompt: promptText };
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("[backfill] ELEVENLABS_API_KEY not set");
    process.exit(1);
  }

  const supabase = getSupabase();

  console.log(
    "[backfill] Fetching candidate businesses (agent_id NOT NULL, any system_prompt state)...",
  );
  const { data: candidates, error: selectErr } = await supabase
    .from("business_configs")
    .select("business_id, agent_id, system_prompt")
    .not("agent_id", "is", null);

  if (selectErr) {
    console.error("[backfill] SELECT failed:", selectErr.message);
    process.exit(2);
  }

  if (!candidates || candidates.length === 0) {
    console.log("[backfill] No candidates with agent_id found — nothing to do.");
    process.exit(0);
  }

  // Idempotency filter: only rows that still need their prompt
  // populated. Done in JS rather than via Supabase's .is("system_prompt",
  // null) to keep the SELECT simple and the skipped-count visible.
  const eligible = candidates.filter(
    (c) => !(c as { system_prompt?: string | null }).system_prompt,
  );
  const alreadyDone = candidates.length - eligible.length;
  console.log(
    `[backfill] Found ${candidates.length} agent-attached rows; ${eligible.length} need backfill, ${alreadyDone} already populated (skipped)`,
  );

  const counts: Record<FetchStatus, number> = {
    success: 0,
    skipped_404: 0,
    skipped_empty: 0,
    skipped_shape: 0,
    rate_limited: 0,
    error: 0,
  };

  for (const row of eligible) {
    const businessId = (row as { business_id: string }).business_id;
    const agentId = (row as { agent_id: string }).agent_id;

    const result = await fetchAgentPrompt(agentId, apiKey);

    if (result.status === "success" && result.prompt) {
      const promptText = result.prompt;

      // Intentionally NOT setting prompt_updated_at — the prompt was
      // genuinely last edited months ago in the ElevenLabs UI during
      // onboarding, not at this backfill moment. Leaving it NULL gives
      // the dashboard a meaningful "has the customer customized this
      // since import?" signal: NULL = never; NOT NULL = at least once.
      // The audit log entry with source='backfill' already records
      // this run.
      const { error: updErr } = await supabase
        .from("business_configs")
        .update({
          system_prompt: promptText,
        })
        .eq("business_id", businessId);

      if (updErr) {
        console.error(
          `[backfill] ${businessId} (agent ${agentId}) → DB update failed: ${updErr.message}`,
        );
        counts.error++;
        await sleep(DELAY_BETWEEN_AGENTS_MS);
        continue;
      }

      const { error: auditErr } = await supabase
        .from("prompt_audit_log")
        .insert({
          business_id: businessId,
          changed_by_user_id: null,
          language: "en",
          source: "backfill",
          old_prompt: null,
          new_prompt: promptText,
          sync_to_elevenlabs_ok: true,
        });

      if (auditErr) {
        // Audit insert failure is non-fatal — the customer's prompt
        // IS persisted. Log loudly so ops can backfill the audit row
        // manually if needed; do not undo the business_configs write.
        console.error(
          `[backfill] ${businessId} audit log insert failed (non-fatal): ${auditErr.message}`,
        );
      }

      console.log(
        `[backfill] ${businessId} (agent ${agentId}) → ${promptText.length} chars persisted`,
      );
      counts.success++;
    } else {
      const reason = result.status;
      const detail = result.errorMessage ? ` (${result.errorMessage})` : "";
      console.log(`[backfill] ${businessId} (agent ${agentId}) → ${reason}${detail}`);
      counts[reason]++;
    }

    await sleep(DELAY_BETWEEN_AGENTS_MS);
  }

  console.log("");
  console.log("[backfill] Summary:");
  console.log(`  success:        ${counts.success}`);
  console.log(`  skipped_404:    ${counts.skipped_404}`);
  console.log(`  skipped_empty:  ${counts.skipped_empty}`);
  console.log(`  skipped_shape:  ${counts.skipped_shape}`);
  console.log(`  rate_limited:   ${counts.rate_limited}`);
  console.log(`  error:          ${counts.error}`);
  console.log(`  already done:   ${alreadyDone}`);

  if (counts.error > 0 || counts.rate_limited > 0) {
    console.error("[backfill] Completed with failures — see counts above.");
    process.exit(3);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] UNEXPECTED ERROR:", err);
  process.exit(4);
});
