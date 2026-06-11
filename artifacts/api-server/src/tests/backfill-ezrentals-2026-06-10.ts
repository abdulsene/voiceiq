/**
 * One-shot backfill for the EZ Rentals call lost on 2026-06-10 22:32 UTC.
 *
 * Re-runs the same ingestion logic the polling sync at api.ts:720 uses,
 * but scoped to a single agent_id and time window. Specifically:
 *   1. List ElevenLabs conversations for agent_1201ks2y3etqf6pv7w32f05nq7bb
 *      created in the [start, end] window.
 *   2. Filter to conversations whose conversation_id is NOT already in
 *      calls.call_sid for biz_1779288494109_z4z979.
 *   3. For each missing one, fetch the full detail (transcript + analysis
 *      + metadata) and insert into calls.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx ./src/tests/backfill-ezrentals-2026-06-10.ts
 *
 * Requires (env): SUPABASE_URL, SUPABASE_SERVICE_KEY, ELEVENLABS_API_KEY.
 *
 * This script does NOT call the /api/lead endpoint — it goes directly to
 * Supabase + ElevenLabs to avoid double-ingestion races with the live
 * polling sync. Idempotent: re-runnable; existing call_sid rows are
 * skipped.
 */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";

const TARGET_BUSINESS_ID = "biz_1779288494109_z4z979";
const TARGET_AGENT_ID = "agent_1201ks2y3etqf6pv7w32f05nq7bb";
// Window: 2026-06-10 22:00 UTC → 23:30 UTC (covers the 22:32 missing
// call plus a 30-min buffer on each side in case my clock is off).
const WINDOW_START_UNIX = Math.floor(new Date("2026-06-10T22:00:00Z").getTime() / 1000);
const WINDOW_END_UNIX = Math.floor(new Date("2026-06-10T23:30:00Z").getTime() / 1000);

async function main() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    process.exit(1);
  }
  if (!ELEVENLABS_API_KEY) {
    console.error("Missing ELEVENLABS_API_KEY.");
    process.exit(1);
  }
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 1. List conversations from ElevenLabs filtered by agent_id. The
  // public list endpoint doesn't accept a time range, so we filter
  // client-side on metadata.start_time_unix_secs.
  console.log("[backfill] listing ElevenLabs conversations for agent:", TARGET_AGENT_ID);
  const listRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversations?agent_id=${encodeURIComponent(TARGET_AGENT_ID)}`, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });
  if (!listRes.ok) {
    console.error("[backfill] ElevenLabs list failed:", listRes.status, await listRes.text());
    process.exit(1);
  }
  const listJson: any = await listRes.json();
  const conversations: any[] = listJson.conversations || listJson || [];
  console.log(`[backfill] found ${conversations.length} total conversations for this agent`);

  const inWindow = conversations.filter((c: any) => {
    const t = c.metadata?.start_time_unix_secs || c.start_time_unix_secs || 0;
    return t >= WINDOW_START_UNIX && t <= WINDOW_END_UNIX;
  });
  console.log(`[backfill] ${inWindow.length} conversations in the [22:00, 23:30 UTC] window`);

  if (inWindow.length === 0) {
    console.log("[backfill] nothing to backfill. exiting.");
    process.exit(0);
  }

  // 2. Skip any conversation_id that already exists in calls.call_sid for
  // this business.
  const convIds = inWindow.map((c: any) => c.conversation_id).filter(Boolean);
  const { data: existing } = await supa
    .from("calls")
    .select("call_sid")
    .eq("business_id", TARGET_BUSINESS_ID)
    .in("call_sid", convIds);
  const existingSet = new Set((existing || []).map((r: any) => r.call_sid));
  const missing = inWindow.filter((c: any) => c.conversation_id && !existingSet.has(c.conversation_id));
  console.log(`[backfill] ${missing.length} missing; ${existingSet.size} already present`);

  // 3. For each missing conversation, fetch detail and insert.
  for (const conv of missing) {
    const convId = conv.conversation_id;
    try {
      const detailRes = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${convId}`, {
        headers: { "xi-api-key": ELEVENLABS_API_KEY },
      });
      if (!detailRes.ok) {
        console.error("[backfill] detail fetch failed:", convId, detailRes.status);
        continue;
      }
      const detail: any = await detailRes.json();

      const transcriptText = (detail.transcript || [])
        .map((t: any) => (t.role === "agent" ? "AI" : "Caller") + ": " + (t.message || t.text || ""))
        .join("\n");

      const dataResults = detail.analysis?.data_collection_results || {};
      const callerName = dataResults.caller_name?.value || null;
      const callerPhone = dataResults.caller_phone?.value
        || detail.metadata?.phone_call?.external_number
        || detail.user_id
        || null;
      const reason = dataResults.reason?.value || null;
      const duration = detail.metadata?.call_duration_secs || 0;
      const startUnix = detail.metadata?.start_time_unix_secs;
      const startTime = startUnix ? new Date(startUnix * 1000).toISOString() : new Date().toISOString();

      const { data: inserted, error: insertErr } = await supa
        .from("calls")
        .upsert({
          call_sid: convId,
          business_id: TARGET_BUSINESS_ID,
          caller_name: callerName,
          caller_number: callerPhone,
          caller_intent: reason,
          summary: reason || "Call via ElevenLabs (backfill 2026-06-10)",
          transcript: transcriptText,
          status: "completed",
          call_outcome: "lead_captured",
          follow_up_required: true,
          direction: "inbound",
          start_time: startTime,
          end_time: new Date(startUnix ? (startUnix + duration) * 1000 : Date.now()).toISOString(),
          duration_seconds: duration,
          lead_data: detail,
        }, { onConflict: "call_sid" })
        .select()
        .single();

      if (insertErr) {
        console.error("[backfill] insert failed:", convId, insertErr.message);
        continue;
      }
      console.log("[backfill] inserted:", convId, "→ row:", inserted?.id, "duration:", duration, "s");
    } catch (err: any) {
      console.error("[backfill] error processing:", convId, err.message);
    }
  }

  console.log("[backfill] done.");
}

main().catch((err) => {
  console.error("[backfill] crashed:", err);
  process.exit(1);
});
