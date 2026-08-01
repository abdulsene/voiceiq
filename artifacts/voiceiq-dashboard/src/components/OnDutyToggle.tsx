/**
 * Phase 3.1b — On-duty header toggle.
 * Phase 3.3c — reachability guard: block/warn if the user turns
 *   on-duty with neither a callback number nor a live browser device.
 *   Never let someone be on-duty and silently unreachable — that's
 *   the exact bug the first EZ Rentals attempt hit.
 *
 * Small pill toggle in the dashboard header: green dot + "On duty"
 * when clocked in, gray dot + "Off duty" when clocked out. Click flips
 * optimistically (state updates immediately, reverts on API error).
 *
 * State hydration on mount reads GET /api/business/team/on-duty and
 * checks whether the caller's user_id is in the returned list.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "wouter";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { getAuthHeaders } from "../lib/api";
import { useSoftphone } from "./Softphone";

export default function OnDutyToggle() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const sp = useSoftphone();
  // Phase 3.15 — on-duty state lives in the softphone provider so the
  // app-wide banner can gate on it. The toggle keeps a local pending
  // flag but delegates the truth to context. `sp.isOnDuty` is `null`
  // while hydrating; treat that as "unknown" (button skeleton).
  const isOnDuty = sp.isOnDuty;
  const [pending, setPending] = useState(false);
  const [unreachableWarning, setUnreachableWarning] = useState<string | null>(null);

  // Phase 3.3c — while on-duty, re-evaluate reachability whenever the
  // softphone state changes and surface a warning if we're unreachable.
  // A user can be clocked in with is_on_duty=true, no callback number,
  // and no registered browser — routing would silently drop them. This
  // block prevents that from being a silent failure.
  useEffect(() => {
    if (isOnDuty !== true) {
      setUnreachableWarning(null);
      return;
    }
    if (!sp.reachability) return;
    if (sp.reachability.reachable) {
      setUnreachableWarning(null);
      return;
    }
    // Compose the specific message based on what's missing.
    if (!sp.reachability.has_callback_ring_number && !sp.reachability.in_app_calling_enabled) {
      setUnreachableWarning(
        "You're on duty but routing can't reach you: no callback number AND in-app calling is off. Enable in-app calling in Phone, or add a callback number in Team settings.",
      );
    } else if (sp.reachability.in_app_calling_enabled && !sp.reachability.device_heartbeat_fresh) {
      setUnreachableWarning(
        "In-app calling is on but this browser hasn't registered a device recently. Open the Phone page to register, or add a callback number.",
      );
    } else {
      setUnreachableWarning(
        "You're on duty but routing can't reach you. Open the Phone page to fix.",
      );
    }
  }, [isOnDuty, sp.reachability]);

  async function toggle() {
    if (isOnDuty === null || pending) return;
    const next = !isOnDuty;

    // Phase 3.3c — pre-flight guard when going ON duty. If we already
    // know the caller has no reachable endpoint, refuse the transition
    // with an actionable message rather than clocking them in silently.
    if (next && sp.reachability && !sp.reachability.reachable) {
      const hasCallback = sp.reachability.has_callback_ring_number;
      const hasFreshDevice =
        sp.reachability.in_app_calling_enabled && sp.reachability.device_heartbeat_fresh;
      if (!hasCallback && !hasFreshDevice) {
        toast.error(
          "Can't clock in — no way for calls to reach you. Enable in-app calling on the Phone page or add a callback number.",
          {
            action: { label: "Open Phone", onClick: () => navigate("/phone") },
          },
        );
        return;
      }
    }

    // Auto-nudge: if the user is enabling on-duty with in-app calling
    // available (but currently off), prompt them to opt in on the same
    // gesture. Toast is non-blocking — they can dismiss and use their
    // cell only.
    if (next && sp.reachability && !sp.reachability.in_app_calling_enabled && !sp.reachability.has_callback_ring_number) {
      toast.message("Want to answer calls in this browser?", {
        description: "Open the Phone page to enable in-app calling and grant mic permission.",
        action: { label: "Open Phone", onClick: () => navigate("/phone") },
      });
    }

    // Optimistic flip via context — the banner watches this.
    sp.setIsOnDuty(next);
    setPending(true);
    try {
      const url = next ? "/api/business/team/me/on-duty" : "/api/business/team/me/off-duty";
      const res = await fetch(url, { method: "POST", headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh reachability so the warning line reflects reality
      // immediately (matters when clocking IN with a callback number
      // but no device — no warning should show).
      void sp.refreshReachability();
    } catch {
      sp.setIsOnDuty(!next);
      toast.error(next ? t("onDuty.clockInError") : t("onDuty.clockOutError"));
    } finally {
      setPending(false);
    }
  }

  if (isOnDuty === null) {
    return <div className="w-[110px] h-[34px]" aria-hidden />;
  }

  const label = isOnDuty ? t("onDuty.on") : t("onDuty.off");
  const dotClass = isOnDuty ? "bg-emerald-500" : "bg-slate-300";
  const buttonClass = isOnDuty
    ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50";

  return (
    <div className="flex items-center gap-2">
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
      {/* Phase 3.3c — the warning lives on the control itself, not
          buried in the dock, so it's impossible to miss. Click →
          /phone where the user can fix it. */}
      {unreachableWarning ? (
        <Link
          href="/phone"
          title={unreachableWarning}
          aria-label="Unreachable — click to fix"
          className="inline-flex items-center gap-1 h-[34px] rounded-full border border-amber-300 bg-amber-50 text-amber-900 px-2.5 text-xs font-medium hover:bg-amber-100 max-w-[280px] truncate"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Unreachable</span>
        </Link>
      ) : null}
    </div>
  );
}
