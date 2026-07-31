/**
 * Phase 3.3c — /phone page.
 *
 * The softphone as a first-class dashboard destination, not a corner
 * dock. Contains:
 *   • Device status + mic permission state + registration diagnostics
 *   • Reachability panel (does routing actually reach me right now?)
 *   • The primary in-app-calling toggle (writes through the same
 *     PATCH /api/voice/preferences as the dock — single source of
 *     truth is the SoftphoneProvider context)
 *   • Ringtone mute + browser notification permission opt-in
 *   • Dialpad (E.164 or free-form; normalises to E.164 before dialing)
 *   • Recent in-app call history (currently placeholder — pulls from
 *     /api/calls when we wire it in a follow-up; the page structure
 *     stays now so users have somewhere obvious to look)
 *   • Deploy info footer so users can tell whether a republish
 *     actually rebuilt (Phase 3.3c also added __BUILD_COMMIT__ / TIME
 *     via Vite `define` and api_started_at via /api/config).
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Phone as PhoneIcon,
  PhoneCall,
  Mic,
  MicOff,
  Bell,
  BellOff,
  Info,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { useSoftphone, StatusPill } from "../components/Softphone";
import { getAuthHeaders } from "../lib/api";

export default function PhonePage() {
  const sp = useSoftphone();
  const [dialpadDigits, setDialpadDigits] = useState("");
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );
  const [apiInfo, setApiInfo] = useState<{ version?: string; api_started_at?: string } | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setApiInfo(d))
      .catch(() => {});
  }, []);

  const requestNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const p = await Notification.requestPermission();
    setNotifPermission(p);
  };

  const dial = async () => {
    const num = dialpadDigits.trim();
    if (!num) return;
    const normalised = num.startsWith("+") ? num : `+${num.replace(/[^0-9]/g, "")}`;
    const ok = await sp.callNumber(normalised);
    if (ok) setDialpadDigits("");
  };

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Phone</h1>
          <p className="text-sm text-neutral-500 mt-0.5">
            Answer routed calls in the browser and dial customers from the same page.
          </p>
        </div>
        <StatusPill status={sp.status} serverEnabled={sp.serverEnabled} />
      </header>

      {/* Primary toggle — server-authoritative. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm font-medium text-neutral-900">Take in-app calls in this browser</div>
            <p className="text-xs text-neutral-500 mt-1 max-w-md">
              When on, routing will ring this browser alongside (or instead of) your
              cell. You still need to be on duty AND the device must be registered
              with a fresh heartbeat to actually receive calls.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sp.enabled}
              onChange={(e) => void sp.setEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            <span className="text-sm">{sp.enabled ? "On" : "Off"}</span>
          </label>
        </div>

        {sp.preferenceError ? (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 p-3 text-xs text-red-800">
            <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{sp.preferenceError}</span>
          </div>
        ) : null}
      </section>

      {/* Reachability panel — the same predicate the routing engine uses. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-neutral-900">Reachability</h2>
          <button
            type="button"
            onClick={() => void sp.refreshReachability()}
            className="text-xs text-blue-600 hover:underline"
          >
            Refresh
          </button>
        </div>
        {sp.reachability ? (
          <div className="space-y-2">
            <ReachRow
              ok={sp.reachability.reachable}
              label={sp.reachability.reachable ? "Routing will reach you" : "Routing will NOT reach you"}
              hint={
                sp.reachability.reachable
                  ? "You have at least one working endpoint (browser or cell)."
                  : "Enable in-app calling above, OR set a callback number in Team settings."
              }
            />
            <ReachRow
              ok={sp.reachability.has_callback_ring_number}
              label="Callback ring number set"
              hint={
                sp.reachability.has_callback_ring_number
                  ? "Your cell will ring for routed calls."
                  : "No cell number on file — routing has to use your browser device."
              }
            />
            <ReachRow
              ok={sp.reachability.in_app_calling_enabled && sp.reachability.device_heartbeat_fresh}
              label="Browser device active"
              hint={
                !sp.reachability.in_app_calling_enabled
                  ? "In-app calling is off. Turn on above to route to this browser."
                  : sp.reachability.device_heartbeat_fresh
                  ? `Last heartbeat: ${sp.reachability.device_heartbeat_age_secs}s ago`
                  : sp.reachability.device_heartbeat_age_secs === null
                  ? "This browser has never registered a device."
                  : `Stale heartbeat: ${sp.reachability.device_heartbeat_age_secs}s ago (routing drops after 90s).`
              }
            />
          </div>
        ) : (
          <div className="text-xs text-neutral-500">Loading…</div>
        )}
      </section>

      {/* Phase 3.4 — surface the Firefox-vs-Chromium output-device
          gap so a user staring at a missing speaker picker on Firefox
          understands why. */}
      {!sp.outputDeviceSelectionSupported ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2 text-xs text-amber-900">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold text-sm">Speaker selection unavailable</div>
              <p className="mt-1">
                Your browser doesn't expose <code className="font-mono">HTMLAudioElement.setSinkId</code>
                {" "}(this is a known Firefox limitation). Call audio still plays through your
                default audio output, but you cannot pick a specific speaker from within Neverr.
                If two-way audio fails on this browser, check the system-level output device.
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* Device diagnostics. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-neutral-900 mb-3">Device</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <DevRow label="Twilio Client status" value={sp.status} />
          <DevRow label="Server preference" value={sp.serverEnabled === null ? "…" : sp.serverEnabled ? "on" : "off"} />
          <DevRow
            label="Mic permission"
            value={
              sp.status === "permission-denied"
                ? "blocked — enable in browser site settings"
                : sp.status === "requesting-permission"
                ? "prompting…"
                : "granted (or not yet requested)"
            }
          />
          <DevRow
            label="Caller ID"
            value={
              sp.callerIdState.status === "provisioned"
                ? sp.callerIdState.twilioNumber
                : sp.callerIdState.status === "loading"
                ? "loading…"
                : sp.callerIdState.status === "not_provisioned"
                ? "no Twilio number provisioned"
                : `load failed: ${sp.callerIdState.message}`
            }
          />
          <DevRow
            label="Identity"
            value={sp.identity || "—"}
            mono
          />
        </div>
      </section>

      {/* Notifications opt-in. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-neutral-900">Alerts</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm text-neutral-900">
              {sp.ringtoneMuted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
              Ringtone
            </div>
            <p className="text-xs text-neutral-500 mt-1">Plays when a call comes in. Muted per-browser.</p>
            <button
              type="button"
              onClick={() => sp.setRingtoneMuted(!sp.ringtoneMuted)}
              className="mt-2 inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50"
            >
              {sp.ringtoneMuted ? "Unmute ringtone" : "Mute ringtone"}
            </button>
          </div>
          <div>
            <div className="flex items-center gap-2 text-sm text-neutral-900">
              <Bell className="h-4 w-4" />
              Browser notifications
            </div>
            <p className="text-xs text-neutral-500 mt-1">
              Fires a notification when the tab isn't focused. Requires browser permission.
            </p>
            <div className="mt-2">
              {notifPermission === "granted" ? (
                <span className="text-xs text-emerald-700">Enabled</span>
              ) : notifPermission === "denied" ? (
                <span className="text-xs text-red-700">Blocked in browser settings</span>
              ) : notifPermission === "unsupported" ? (
                <span className="text-xs text-neutral-500">Not supported in this browser</span>
              ) : (
                <button
                  type="button"
                  onClick={requestNotifications}
                  className="inline-flex items-center gap-2 rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50"
                >
                  Enable notifications
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Dialpad. */}
      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-neutral-900 mb-3">Dial</h2>
        {sp.status !== "registered" ? (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              Your softphone isn't Ready yet. Turn on "Take in-app calls" above and grant mic
              permission when prompted.
            </span>
          </div>
        ) : sp.callerIdState.status === "loading" ? (
          <div className="text-xs text-neutral-500">Looking up your business's caller ID…</div>
        ) : sp.callerIdState.status === "error" ? (
          // Phase 3.7 — DISTINCT from "not provisioned." Pre-3.7 a
          // 200 with a nested body shape the frontend didn't read
          // rendered identically to a genuine "no number on file,"
          // sending ops on a config chase. Now: an actual load
          // failure says so and shows the error.
          <div className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-xs text-red-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Couldn't load your caller ID</div>
              <div className="mt-1">
                {sp.callerIdState.message} — try refreshing this page. If it persists after a
                reload, your session may have expired.
              </div>
            </div>
          </div>
        ) : sp.callerIdState.status === "not_provisioned" ? (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">No Twilio number provisioned for this business</div>
              <div className="mt-1">
                Outbound calls need a business number to appear as the caller ID. Visit{" "}
                <Link href="/settings/ai" className="text-blue-600 hover:underline">
                  Settings → My Receptionist
                </Link>{" "}
                to provision one.
              </div>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs text-neutral-500 mb-2">
              Calling from <span className="font-medium text-neutral-800">{sp.callerIdState.twilioNumber}</span>
              {sp.callerIdState.sid ? (
                <span className="ml-2 text-neutral-400">({sp.callerIdState.sid})</span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                type="tel"
                value={dialpadDigits}
                onChange={(e) => setDialpadDigits(e.target.value)}
                placeholder="+15551234567"
                className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void dial();
                }}
              />
              <button
                type="button"
                onClick={() => void dial()}
                disabled={sp.hasActiveCall}
                className="inline-flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-green-700"
              >
                <PhoneIcon className="h-4 w-4" /> Call
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-neutral-200 bg-white p-5">
        <div className="flex items-center gap-2 mb-2">
          <PhoneCall className="h-4 w-4 text-neutral-500" />
          <h2 className="text-sm font-semibold text-neutral-900">Recent in-app calls</h2>
        </div>
        <div className="text-xs text-neutral-500">
          A rolling history of calls that landed on this browser device will appear here as
          they happen. See <Link className="text-blue-600 hover:underline" href="/calls">Calls &amp; Leads</Link> for the full transcript view.
        </div>
      </section>

      {/* Deploy verification footer — Phase 3.3c "was the bundle actually rebuilt?" */}
      <footer className="text-[11px] text-neutral-400 flex items-center gap-2 justify-between border-t border-neutral-200 pt-3">
        <span className="inline-flex items-center gap-1">
          <Info className="h-3 w-3" />
          Bundle: <span className="font-mono">{__BUILD_COMMIT__}</span> ·
          built {formatIso(__BUILD_TIME__)}
        </span>
        {apiInfo ? (
          <span>
            API v{apiInfo.version ?? "?"} · started{" "}
            {apiInfo.api_started_at ? formatIso(apiInfo.api_started_at) : "?"}
          </span>
        ) : null}
      </footer>
    </div>
  );
}

function ReachRow({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600 mt-0.5 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="font-medium text-neutral-900">{label}</div>
        <div className="text-xs text-neutral-500">{hint}</div>
      </div>
    </div>
  );
}

function DevRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-xs">
      <div className="text-neutral-500">{label}</div>
      <div className={`text-neutral-900 truncate ${mono ? "font-mono" : ""}`}>{value}</div>
    </div>
  );
}

function formatIso(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}
