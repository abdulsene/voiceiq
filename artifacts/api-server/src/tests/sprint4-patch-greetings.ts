/**
 * Sprint 4 STEP D — batch-patch ElevenLabs first_message for all
 * production agents to the new "Hello, thank you for calling..." greeting
 * sourced from artifacts/api-server/src/data/greetings.ts.
 *
 * Per STEP A4 audit there are 11 business_configs rows with a non-null
 * agent_id (all internal/test rows — zero real customer agents). This
 * script:
 *   1. SELECTs business_id, business_name, industry, agent_id from
 *      business_configs WHERE agent_id IS NOT NULL.
 *   2. For each row: fetches the agent's current state via getAgent()
 *      (to log the OLD first_message and to PRESERVE the existing
 *      system_prompt — see safety note below), computes the new
 *      greeting via getGreeting(industry, business_name), and PATCHes
 *      via updateAgentPrompt() if and only if the new greeting differs.
 *   3. Reports a per-agent line and a final summary.
 *   4. STOPs after the first agent if that agent fails with what looks
 *      like a systemic error (auth / rate-limit / 5xx) — no point
 *      burning through retries on a broken setup.
 *
 * Safety note — why we read system_prompt before patching:
 *   updateAgentPrompt() requires `systemPrompt` and unconditionally sets
 *   `conversation_config.agent.prompt.prompt = systemPrompt` in the
 *   PATCH body. If we passed undefined, the resulting payload would be
 *   `{ prompt: {} }` which ElevenLabs may interpret as "clear the
 *   system prompt" — catastrophic across 11 live agents. We therefore
 *   fetch the existing system_prompt via getAgent() and pass it back
 *   unchanged, so this script is a true first_message-only update.
 *
 * Safety note — why we don't pass businessName:
 *   updateAgentPrompt() with a defined `businessName` also renames the
 *   ElevenLabs agent to "Neverr - <name>". That's out of scope for this
 *   batch (Abdul: "PATCH the first_message"). We omit businessName so
 *   `name` is dropped from the JSON body and the agent's display name
 *   is preserved. Existing call sites at routes/api.ts:2592 and :4059
 *   confirm ElevenLabs does field-level partial PATCH on
 *   conversation_config.agent, so unrelated fields stay intact.
 *
 * Idempotent — safe to re-run. If the agent's first_message already
 * matches the new greeting, the row is skipped (no API call).
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx ./src/tests/sprint4-patch-greetings.ts
 *
 * Required env vars (already set in the workspace shell):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY
 */
import { createClient } from "@supabase/supabase-js";
import { getAgent, updateAgentPrompt } from "../agents";
import { getGreeting } from "../data/greetings";

interface AgentRow {
  business_id: string;
  business_name: string;
  industry: string | null;
  agent_id: string;
}

interface Result {
  business_id: string;
  business_name: string;
  industry: string | null;
  agent_id: string;
  status: "updated" | "skipped" | "fail-getAgent" | "fail-update";
  oldGreeting?: string | null;
  newGreeting?: string;
  error?: string;
}

const EXPECTED_ROWS = 11;

function looksSystemic(errStr: string | undefined): boolean {
  const s = (errStr || "").toLowerCase();
  return (
    s.includes("unauthor") ||
    s.includes("invalid api key") ||
    s.includes("invalid_api_key") ||
    s.includes("missing api key") ||
    s.includes("rate") ||
    s.includes("forbidden") ||
    s.includes('"status":5') ||
    /5\d{2}/.test(s)
  );
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const xi = process.env.ELEVENLABS_API_KEY;
  if (!url || !key) {
    console.error("[FATAL] SUPABASE_URL / SUPABASE_SERVICE_KEY not set");
    process.exit(1);
  }
  if (!xi) {
    console.error("[FATAL] ELEVENLABS_API_KEY not set — would 401 on every PATCH");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  console.log("Sprint 4 STEP D — batch-patch ElevenLabs first_message");
  console.log("======================================================");
  console.log();

  const { data, error } = await supabase
    .from("business_configs")
    .select("business_id, business_name, industry, agent_id")
    .not("agent_id", "is", null)
    .order("business_name");

  if (error) {
    console.error("[FATAL] Supabase query failed:", error.message);
    process.exit(1);
  }
  const rows = (data || []) as AgentRow[];
  console.log(`Found ${rows.length} business_configs row(s) with non-null agent_id`);
  if (rows.length !== EXPECTED_ROWS) {
    console.warn(`[WARN] Expected ${EXPECTED_ROWS} per STEP A4 audit, got ${rows.length}`);
  }
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  console.log();

  const results: Result[] = [];
  let halted = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const idx = `[${i + 1}/${rows.length}]`;
    console.log(`${idx} ${row.business_name}`);
    console.log(`     business_id=${row.business_id}  industry=${row.industry || "(unset)"}  agent=${row.agent_id}`);

    const newGreeting = getGreeting(row.industry, row.business_name);
    console.log(`     new greeting: ${JSON.stringify(newGreeting)}`);

    // 1. Read current agent state — preserves system_prompt + logs old first_message
    let existing: any;
    try {
      existing = await getAgent(row.agent_id);
    } catch (e: any) {
      console.error(`     [FAIL] getAgent threw: ${e?.message || e}`);
      results.push({ ...row, status: "fail-getAgent", error: String(e?.message || e), newGreeting });
      if (i === 0 && looksSystemic(e?.message)) {
        console.error("     [STOP] First agent failed with systemic error. Halting.");
        halted = true;
        break;
      }
      console.log();
      continue;
    }

    // ElevenLabs error responses look like { detail: ... } or { error: ... }
    const errLike = existing?.detail || existing?.error;
    if (errLike) {
      const errStr = typeof errLike === "string" ? errLike : JSON.stringify(errLike);
      console.error(`     [FAIL] getAgent returned error: ${errStr.slice(0, 300)}`);
      results.push({ ...row, status: "fail-getAgent", error: errStr.slice(0, 500), newGreeting });
      if (i === 0 && looksSystemic(errStr)) {
        console.error("     [STOP] First agent failed with systemic error. Halting.");
        halted = true;
        break;
      }
      console.log();
      continue;
    }

    const existingFirst: string | null | undefined =
      existing?.conversation_config?.agent?.first_message;
    const existingPrompt: string | null | undefined =
      existing?.conversation_config?.agent?.prompt?.prompt;

    console.log(`     old greeting: ${JSON.stringify(existingFirst ?? null)}`);

    if (existingFirst === newGreeting) {
      console.log(`     [SKIP] already current`);
      results.push({ ...row, status: "skipped", oldGreeting: existingFirst, newGreeting });
      console.log();
      continue;
    }

    if (!existingPrompt) {
      console.warn(`     [WARN] existing system_prompt is empty/missing — proceeding anyway`);
    }

    // 2. PATCH first_message, preserving existing system_prompt verbatim.
    //    Intentionally NOT passing businessName (would also rename agent).
    //    Intentionally NOT passing languageDetection (preserves default).
    const r = await updateAgentPrompt({
      agentId: row.agent_id,
      systemPrompt: existingPrompt || "",
      firstMessage: newGreeting,
    });

    if (r.success) {
      console.log(`     [OK] patched`);
      results.push({ ...row, status: "updated", oldGreeting: existingFirst, newGreeting });
    } else {
      console.error(`     [FAIL] updateAgentPrompt: ${(r.error || "").slice(0, 300)}`);
      results.push({ ...row, status: "fail-update", error: r.error, oldGreeting: existingFirst, newGreeting });
      if (i === 0 && looksSystemic(r.error)) {
        console.error("     [STOP] First agent failed with systemic error. Halting.");
        halted = true;
        break;
      }
    }
    console.log();
  }

  // Final summary
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const updated = results.filter(r => r.status === "updated");
  const skipped = results.filter(r => r.status === "skipped");
  const failed = results.filter(r => r.status.startsWith("fail"));
  console.log(`  Updated: ${updated.length}`);
  console.log(`  Skipped (already current): ${skipped.length}`);
  console.log(`  Failed:  ${failed.length}`);
  console.log(`  Total processed: ${results.length} of ${rows.length}`);
  if (halted) {
    console.log(`  HALTED early after first agent (systemic failure detected)`);
  }
  if (updated.length > 0) {
    console.log();
    console.log("Updated agents:");
    for (const r of updated) {
      console.log(`  - ${r.business_name} [${r.industry || "(no industry)"}]`);
      console.log(`      old: ${JSON.stringify(r.oldGreeting ?? null)}`);
      console.log(`      new: ${JSON.stringify(r.newGreeting)}`);
    }
  }
  if (failed.length > 0) {
    console.log();
    console.log("Failures:");
    for (const r of failed) {
      console.log(`  - ${r.business_name} (${r.agent_id}) [${r.status}]: ${(r.error || "").slice(0, 200)}`);
    }
  }

  // Non-zero exit on any failure for CI / scripting
  if (failed.length > 0) process.exit(2);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
