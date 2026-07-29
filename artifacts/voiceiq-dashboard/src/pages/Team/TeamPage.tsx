/**
 * Phase 3.1b — Team management page.
 *
 * Table of team members with on-duty state, assigned topics, and
 * callback ring number. Live-refreshed via 30-second poll (WebSocket
 * presence signaling lands with the softphone in 3.3+).
 *
 * Auth is inherited from AuthGuard in App.tsx; all fetches go through
 * fetchApi which auto-injects Authorization + X-Active-Business.
 *
 * The invite path opens InviteMemberDialog. On success we invalidate
 * (re-fetch) the team list so the new row appears immediately.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, UsersRound, PhoneCall, Circle } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../../lib/api";
import InviteMemberDialog from "../../components/InviteMemberDialog";

type TeamMember = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_on_duty: boolean;
  on_duty_since: string | null;
  callback_ring_number: string | null;
  assigned_topics: string[];
  created_at: string | null;
};

const POLL_MS = 30_000;

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  team_lead: "Team lead",
  agent_manager: "Agent manager",
  analyst: "Analyst",
  user: "User",
  readonly: "Read-only",
};

function formatOnDutySince(iso: string | null): string {
  if (!iso) return "";
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return "";
  const diff = Date.now() - started;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

export default function TeamPage() {
  const { t } = useTranslation();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [selfUserId, setSelfUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchApi("/business/team");
      setMembers((data?.members as TeamMember[] | undefined) ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load failed");
    }
  }, []);

  // Resolve the caller's own user_id once so the row for "me" hides
  // the Remove action (backend also blocks self-remove with 403, but
  // hiding the button is friendlier UX than clicking → error toast).
  useEffect(() => {
    fetch("/api/auth/me", { headers: getAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.user?.id) setSelfUserId(d.user.id);
      })
      .catch(() => {});
  }, []);

  // Initial load + 30s poll for on-duty snapshot updates. WebSocket
  // presence signaling is Phase 3.3 (alongside softphone).
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const handleRemove = useCallback(
    async (m: TeamMember) => {
      if (m.user_id === selfUserId) {
        toast.error(t("team.cannotRemoveSelf"));
        return;
      }
      if (!window.confirm(t("team.removeConfirm", { name: m.full_name || m.email || m.user_id }))) return;
      setRemovingId(m.user_id);
      try {
        const res = await fetch(`/api/business/team/${encodeURIComponent(m.user_id)}`, {
          method: "DELETE",
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(t("team.removeSuccess"));
        await load();
      } catch {
        toast.error(t("team.removeError"));
      } finally {
        setRemovingId(null);
      }
    },
    [load, selfUserId, t],
  );

  const rows = useMemo(() => members ?? [], [members]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <UsersRound className="w-6 h-6 text-[#2E75B6]" />
            {t("team.title")}
          </h1>
          <p className="text-sm text-gray-500 mt-1">{t("team.subtitle")}</p>
        </div>
        <button
          onClick={() => setInviteOpen(true)}
          className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-[#1e5a8f] transition-colors"
        >
          {t("team.invite")}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {t("team.loadError")}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
        {members === null ? (
          <div className="p-12 flex items-center justify-center text-sm text-gray-500 gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            {t("team.loading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-12 text-center text-sm text-gray-500">{t("team.empty")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-left text-xs uppercase tracking-wide text-slate-700">
                  <th className="px-4 py-3 font-semibold">{t("team.columns.name")}</th>
                  <th className="px-4 py-3 font-semibold">{t("team.columns.email")}</th>
                  <th className="px-4 py-3 font-semibold">{t("team.columns.role")}</th>
                  <th className="px-4 py-3 font-semibold">{t("team.columns.onDuty")}</th>
                  <th className="px-4 py-3 font-semibold">{t("team.columns.topics")}</th>
                  <th className="px-4 py-3 font-semibold">{t("team.columns.callbackRingNumber")}</th>
                  <th className="px-4 py-3 font-semibold text-right">{t("team.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => {
                  const isSelf = m.user_id === selfUserId;
                  return (
                    <tr key={m.user_id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900">
                          {m.full_name || <span className="text-slate-400">—</span>}
                          {isSelf && <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-400">(you)</span>}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{m.email || <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-md bg-slate-100 text-slate-700 text-[11px] font-medium px-2 py-0.5">
                          {ROLE_LABEL[m.role] || m.role}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {m.is_on_duty ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700">
                            <Circle className="w-2 h-2 fill-emerald-500 stroke-emerald-500" />
                            <span className="font-medium">{t("onDuty.on")}</span>
                            {m.on_duty_since && (
                              <span className="text-slate-400 text-xs">
                                · {t("team.onDutySince", { time: formatOnDutySince(m.on_duty_since) })}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-500">
                            <Circle className="w-2 h-2 fill-slate-300 stroke-slate-300" />
                            <span>{t("onDuty.off")}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {m.assigned_topics.length === 0 ? (
                          <span className="text-xs text-slate-400">{t("team.noTopics")}</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {m.assigned_topics.map((slug) => (
                              <span
                                key={slug}
                                className="inline-flex items-center rounded-md bg-blue-50 text-blue-700 text-[11px] font-medium px-1.5 py-0.5"
                              >
                                {slug}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {m.callback_ring_number ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs">
                            <PhoneCall className="w-3 h-3 text-slate-400" />
                            {m.callback_ring_number}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">{t("team.noCallback")}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isSelf ? (
                          <span className="text-xs text-slate-400 italic">—</span>
                        ) : (
                          <button
                            onClick={() => handleRemove(m)}
                            disabled={removingId === m.user_id}
                            className="text-xs px-2.5 py-1 text-red-600 hover:bg-red-50 rounded-md disabled:opacity-50"
                          >
                            {removingId === m.user_id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              t("team.remove")
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {inviteOpen && (
        <InviteMemberDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            setInviteOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
