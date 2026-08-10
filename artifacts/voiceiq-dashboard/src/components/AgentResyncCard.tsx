/**
 * Phase 3.3c — "Resync AI receptionist" card.
 *
 * Mounted at the top of /settings/ai (My Receptionist). Shows the
 * currently registered ElevenLabs tool names + a button that runs
 * updateAgentTools() server-side and re-fetches the resulting list.
 *
 * Rationale (from the incident report): EZ Rentals shipped without
 * route_to_topic attached because updateAgentTools only fires as a
 * side-effect of saving a business config, and there was no way to
 * inspect what tools an agent actually had without the ElevenLabs
 * console. This card makes both operations first-class in the
 * dashboard.
 */

import { useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import { getAuthHeaders } from "../lib/api";

const EXPECTED_TOOL_NAMES = [
  "request_callback",
  "route_to_topic",
  "record_appointment",
  "transfer_to_number",
] as const;

interface AgentToolsResponse {
  agent_id: string | null;
  registered_tools: string[];
}
interface ResyncResponse extends AgentToolsResponse {
  resync_ok: boolean;
  started_at: string;
  finished_at: string;
  // Phase 5.2 — resync now regenerates + pushes the system prompt
  // alongside the tools array. When the prompt path is skipped (e.g.
  // missing business_name/industry, or no agent yet), prompt_synced is
  // false and prompt_skipped_reason explains why.
  prompt_synced?: boolean;
  prompt_chars?: number | null;
  prompt_sync_error?: string | null;
  prompt_skipped_reason?: string | null;
  tools_sync_error?: string | null;
}

export default function AgentResyncCard() {
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<string[] | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resyncing, setResyncing] = useState(false);
  const [lastResyncAt, setLastResyncAt] = useState<string | null>(null);
  const [lastPromptStatus, setLastPromptStatus] = useState<
    | { synced: true; chars: number | null }
    | { synced: false; reason: string }
    | null
  >(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/business/agent/tools", {
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AgentToolsResponse;
      setTools(data.registered_tools);
      setAgentId(data.agent_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const resync = async () => {
    setResyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/business/agent/resync", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ResyncResponse;
      setTools(data.registered_tools);
      setAgentId(data.agent_id);
      setLastResyncAt(data.finished_at);
      if (data.prompt_synced) {
        setLastPromptStatus({ synced: true, chars: data.prompt_chars ?? null });
      } else if (data.prompt_sync_error) {
        setLastPromptStatus({ synced: false, reason: data.prompt_sync_error });
      } else if (data.prompt_skipped_reason) {
        setLastPromptStatus({ synced: false, reason: data.prompt_skipped_reason });
      } else {
        setLastPromptStatus(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResyncing(false);
    }
  };

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">AI receptionist sync</h2>
          <p className="text-xs text-neutral-500 mt-1 max-w-lg">
            Push your current tool + prompt configuration to ElevenLabs and see which tools your
            agent has registered. Run this after changing topics, transfer, or record-appointment
            settings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void resync()}
          disabled={resyncing}
          className="inline-flex items-center gap-2 rounded-md bg-neutral-900 text-white px-3 py-2 text-xs font-medium hover:bg-neutral-800 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${resyncing ? "animate-spin" : ""}`} />
          {resyncing ? "Resyncing…" : "Resync now"}
        </button>
      </div>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 p-2.5 text-xs text-red-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="mt-4">
        <div className="text-xs font-medium text-neutral-700 mb-2">Registered tools</div>
        {loading ? (
          <div className="text-xs text-neutral-500">Loading…</div>
        ) : tools === null ? (
          <div className="text-xs text-neutral-500">—</div>
        ) : tools.length === 0 ? (
          <div className="text-xs text-amber-800 bg-amber-50 rounded-md p-2.5 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              No tools registered — either the agent hasn't been created yet, or the last resync
              failed silently. Run a resync to attempt registration.
            </span>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {tools.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-800 text-[11px] font-medium px-2 py-0.5"
              >
                <CheckCircle2 className="h-3 w-3" />
                {t}
              </span>
            ))}
          </div>
        )}
        {/* Highlight expected tools that are MISSING — matters most for
            route_to_topic since that's what routes calls to the right
            staff member. */}
        {tools && tools.length > 0 ? (
          (() => {
            const missing = EXPECTED_TOOL_NAMES.filter((n) => !tools.includes(n));
            if (missing.length === 0) return null;
            return (
              <div className="mt-2 text-[11px] text-neutral-500">
                Expected but not registered:{" "}
                {missing.map((m) => (
                  <span key={m} className="text-amber-800 font-medium mr-2">
                    {m}
                  </span>
                ))}
                <span className="text-neutral-400">
                  (this can be normal — e.g. `route_to_topic` requires topics to be configured,
                  `transfer_to_number` requires a transfer number.)
                </span>
              </div>
            );
          })()
        ) : null}
      </div>

      {lastPromptStatus ? (
        lastPromptStatus.synced ? (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-50 p-2.5 text-xs text-emerald-800">
            <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              System prompt regenerated and pushed to ElevenLabs
              {typeof lastPromptStatus.chars === "number"
                ? ` (${lastPromptStatus.chars.toLocaleString()} chars)`
                : ""}
              .
            </span>
          </div>
        ) : (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 p-2.5 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Tools synced, but the system prompt was not pushed: {lastPromptStatus.reason}.
            </span>
          </div>
        )
      ) : null}

      <div className="mt-3 text-[11px] text-neutral-400 flex flex-wrap gap-3">
        {agentId ? <span>agent: <span className="font-mono">{agentId}</span></span> : <span>No agent provisioned yet</span>}
        {lastResyncAt ? <span>Last resync: {new Date(lastResyncAt).toLocaleString()}</span> : null}
      </div>
    </div>
  );
}
