/**
 * Phase 3.1b — On-duty header toggle.
 *
 * Small pill toggle in the dashboard header: green dot + "On duty"
 * when clocked in, gray dot + "Off duty" when clocked out. Click flips
 * optimistically (state updates immediately, reverts on API error).
 *
 * State hydration on mount reads GET /api/business/team/on-duty and
 * checks whether the caller's user_id is in the returned list. That's
 * cheaper than pulling the whole team just to look up one boolean, and
 * uses an endpoint we already ship.
 *
 * WebSocket presence signaling is Phase 3.3 (alongside softphone). For
 * pilot the polling in TeamPage (30s) + this component's optimistic
 * flip is enough — the team dashboard eventually sees on-duty changes
 * from other tabs / devices via the poll.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../lib/api";

type OnDutyMember = { user_id: string };

export default function OnDutyToggle() {
  const { t } = useTranslation();
  const [isOnDuty, setIsOnDuty] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Look up self's user_id, then check the on-duty snapshot.
        const [meRes, onDutyRes] = await Promise.all([
          fetch("/api/auth/me", { headers: getAuthHeaders() }).then((r) => (r.ok ? r.json() : null)),
          fetchApi("/business/team/on-duty").catch(() => ({ members: [] })),
        ]);
        if (cancelled) return;
        const myId = meRes?.user?.id;
        const list = (onDutyRes?.members as OnDutyMember[] | undefined) ?? [];
        setIsOnDuty(!!myId && list.some((m) => m.user_id === myId));
      } catch {
        if (!cancelled) setIsOnDuty(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (isOnDuty === null || pending) return;
    const next = !isOnDuty;
    // Optimistic flip.
    setIsOnDuty(next);
    setPending(true);
    try {
      const url = next ? "/api/business/team/me/on-duty" : "/api/business/team/me/off-duty";
      const res = await fetch(url, { method: "POST", headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Revert on error.
      setIsOnDuty(!next);
      toast.error(next ? t("onDuty.clockInError") : t("onDuty.clockOutError"));
    } finally {
      setPending(false);
    }
  }

  // While hydrating, render an invisible placeholder so the header
  // layout doesn't reflow when state arrives.
  if (isOnDuty === null) {
    return <div className="w-[110px] h-[34px]" aria-hidden />;
  }

  const label = isOnDuty ? t("onDuty.on") : t("onDuty.off");
  const dotClass = isOnDuty ? "bg-emerald-500" : "bg-slate-300";
  const buttonClass = isOnDuty
    ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={isOnDuty}
      aria-label={isOnDuty ? t("onDuty.clockOut") : t("onDuty.clockIn")}
      className={`inline-flex items-center gap-2 h-[34px] rounded-full border px-3 text-sm font-medium transition-colors disabled:opacity-70 ${buttonClass}`}
    >
      {pending ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
      )}
      <span>{label}</span>
    </button>
  );
}
