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
import { Loader2, UsersRound, PhoneCall, Circle, AlertTriangle } from "lucide-react";
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
  // Phase 3.15 — device presence for the "on duty but silently
  // unreachable" flag. Owner-visible so they can nudge someone whose
  // heartbeat has been stale for hours.
  in_app_calling_enabled: boolean;
  voice_device_last_seen_at: string | null;
  device_heartbeat_fresh: boolean;
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

/**
 * Phase 3.15 — a row is "silently unreachable" when they're on duty
 * with in-app calling ON, no callback number, and their heartbeat
 * has gone stale (or never arrived). Routing since 3.15 will still
 * TRY to ring the browser (fail-fast rather than silent-drop), but
 * the owner should see the risk on the team page and decide whether
 * to reach out to the staff member. We do NOT auto-clock out.
 *
 * Rows with a callback number are NOT flagged — the callback is a
 * reliable fallback path, so silent unreachability doesn't apply.
 */
function isSilentlyUnreachable(m: TeamMember): boolean {
  if (!m.is_on_duty) return false;
  if (m.callback_ring_number) return false;
  if (!m.in_app_calling_enabled) return true;
  return !m.device_heartbeat_fresh;
}

function formatUnreachableTitle(m: TeamMember): string {
  if (!m.in_app_calling_enabled) {
    return "On duty with in-app calling off and no callback number. Routing has nothing to ring.";
  }
  if (!m.voice_device_last_seen_at) {
    return "On duty with in-app calling on, but this device has never checked in. No callback number configured.";
  }
  const ageSecs = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(m.voice_device_last_seen_at)) / 1000),
  );
  const label = ageSecs >= 3600
    ? `${Math.floor(ageSecs / 3600)}h`
    : ageSecs >= 60
    ? `${Math.floor(ageSecs / 60)}m`
    : `${ageSecs}s`;
  return `On duty, in-app calling on, but no heartbeat for ${label}. Routing will still try but the browser may not answer.`;
}

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

// Phase 3.17 — pending invites from GET /business/invites. Rendered
// as a separate table above active members so the "who hasn't
// accepted yet" state is scannable at a glance. Aligns with the
// audit finding that pending members were previously indistinguishable
// from active ones.
interface PendingInvite {
  id: string;
  email: string;
  role: string;
  callback_ring_number: string | null;
  topics: string[];
  invited_by_user_id: string | null;
  expires_at: string;
  created_at: string;
}

export default function TeamPage() {
  const { t } = useTranslation();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [inviteActionId, setInviteActionId] = useState<string | null>(null);
  const [selfUserId, setSelfUserId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [membersData, invitesData] = await Promise.all([
        fetchApi("/business/team"),
        fetchApi("/business/invites").catch(() => ({ invites: [] })),
      ]);
      setMembers((membersData?.members as TeamMember[] | undefined) ?? []);
      setPendingInvites((invitesData?.invites as PendingInvite[] | undefined) ?? []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load failed");
    }
  }, []);

  const handleResendInvite = useCallback(
    async (inv: PendingInvite) => {
      setInviteActionId(inv.id);
      try {
        const res = await fetch(`/api/business/invites/${encodeURIComponent(inv.id)}/resend`, {
          method: "POST",
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(`Fresh invite sent to ${inv.email}`);
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Could not resend invite");
      } finally {
        setInviteActionId(null);
      }
    },
    [load],
  );

  const handleRevokeInvite = useCallback(
    async (inv: PendingInvite) => {
      if (!window.confirm(`Revoke pending invite for ${inv.email}? The link in their email will stop working immediately.`)) return;
      setInviteActionId(inv.id);
      try {
        const res = await fetch(`/api/business/invites/${encodeURIComponent(inv.id)}`, {
          method: "DELETE",
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        toast.success(`Invite for ${inv.email} revoked`);
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Could not revoke invite");
      } finally {
        setInviteActionId(null);
      }
    },
    [load],
  );

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

      {/* Phase 3.17 — pending invites section. Rendered ABOVE the
          active members table so ops can immediately see who hasn't
          accepted yet. Only shows when there are outstanding
          invites; disappears otherwise. */}
      {pendingInvites && pendingInvites.length > 0 ? (
        <div className="mb-6 bg-white rounded-2xl border border-amber-200 overflow-hidden">
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-700" />
            <h2 className="text-sm font-semibold text-amber-900">
              Pending invites ({pendingInvites.length})
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-white border-b border-amber-100 text-left text-xs uppercase tracking-wide text-slate-700">
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Sent</th>
                  <th className="px-4 py-3 font-semibold">Expires</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingInvites.map((inv) => {
                  const expiresIn = Math.max(
                    0,
                    Math.floor((Date.parse(inv.expires_at) - Date.now()) / (24 * 3600 * 1000)),
                  );
                  const sentAgo = formatOnDutySince(inv.created_at);
                  const isBusy = inviteActionId === inv.id;
                  return (
                    <tr key={inv.id} className="border-b border-amber-50 last:border-0">
                      <td className="px-4 py-3 font-medium text-slate-900">{inv.email}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-md bg-slate-100 text-slate-700 text-[11px] font-medium px-2 py-0.5">
                          {ROLE_LABEL[inv.role] || inv.role}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs">
                        {sentAgo || "just now"} ago
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {expiresIn > 0 ? (
                          <span className="text-slate-600">in {expiresIn}d</span>
                        ) : (
                          <span className="text-red-700 font-medium">today</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleResendInvite(inv)}
                          disabled={isBusy}
                          className="text-xs px-2.5 py-1 text-blue-700 hover:bg-blue-50 rounded-md disabled:opacity-50"
                        >
                          {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Resend"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevokeInvite(inv)}
                          disabled={isBusy}
                          className="text-xs px-2.5 py-1 text-red-600 hover:bg-red-50 rounded-md disabled:opacity-50 ml-1"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

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
                          <div className="flex flex-col gap-1">
                            <span className="inline-flex items-center gap-1.5 text-emerald-700">
                              <Circle className="w-2 h-2 fill-emerald-500 stroke-emerald-500" />
                              <span className="font-medium">{t("onDuty.on")}</span>
                              {m.on_duty_since && (
                                <span className="text-slate-400 text-xs">
                                  · {t("team.onDutySince", { time: formatOnDutySince(m.on_duty_since) })}
                                </span>
                              )}
                            </span>
                            {/* Phase 3.15 — surface the specific
                                operational problem the phase brief
                                calls out: on duty with no fresh
                                heartbeat AND no callback number. This
                                is the "silently unreachable" case.
                                We do NOT auto-clock out — the flag
                                is a signal, the owner decides. */}
                            {isSilentlyUnreachable(m) ? (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                                title={formatUnreachableTitle(m)}
                              >
                                <AlertTriangle className="w-3 h-3" />
                                <span>Routing may miss</span>
                              </span>
                            ) : null}
                          </div>
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
