/**
 * Phase 3.3 — softphone UI.
 *
 * Mounts once at App-level, wires the useTwilioDevice hook, and exposes:
 *   • A floating incoming-call banner (accept / decline / mute / hangup
 *     + a call timer + topic name from the <Client> CustomParameter)
 *   • A collapsible bottom-right dock (registration state indicator +
 *     mic permission / error surface + outbound dialpad)
 *   • A SoftphoneContext consumers can pull `dial(number)` from — used
 *     by the leads and calls pages for click-to-call.
 *
 * Boot posture:
 *   - Off by default. A toggle in the dock (persisted to localStorage)
 *     enables the Device. We do NOT auto-fire the mic prompt on load
 *     — that would train users to click "Block" and permanently lose
 *     the ability to use the softphone.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Phone, PhoneOff, Mic, MicOff, X, PhoneCall, PhoneIncoming, AlertCircle } from "lucide-react";
import { useTwilioDevice, type SoftphoneStatus } from "../hooks/useTwilioDevice";
import { getAuthHeaders } from "../lib/api";

// Phase 3.3a — the server (user_businesses.in_app_calling_enabled) is
// authoritative for whether routing will ring this device. localStorage
// only caches the last-known value so the dock has something to render
// before the initial GET /voice/preferences resolves.
const ENABLED_CACHE_KEY = "neverr_softphone_enabled";

interface SoftphoneContextValue {
  enabled: boolean;
  status: SoftphoneStatus;
  identity: string | null;
  setEnabled: (v: boolean) => Promise<void> | void;
  /**
   * Place an outbound call to the given E.164 number. Returns true if
   * the call was initiated, false if the device isn't registered.
   */
  callNumber: (to: string) => Promise<boolean>;
}

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) {
    // Silent no-op fallback lets pages call useSoftphone() without
    // forcing every render tree to mount the provider. Reflects
    // status='idle' and rejects click-to-call.
    return {
      enabled: false,
      status: "idle",
      identity: null,
      setEnabled: () => {},
      callNumber: async () => false,
    };
  }
  return ctx;
}

interface CallerId {
  twilioNumber: string;
}

async function fetchOwnCallerId(): Promise<CallerId | null> {
  // The outbound TwiML webhook enforces callerId matches the business's
  // twilio_phone_number — we fetch it here so the SDK's connect() can
  // present the correct one. Falls back to null if the business config
  // hasn't provisioned a number yet (the webhook will hang up cleanly
  // rather than dialing from a random line).
  try {
    const res = await fetch("/api/business/configure", {
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    });
    if (!res.ok) return null;
    const cfg = await res.json();
    const num = cfg?.twilio_phone_number || cfg?.phone_number;
    return num ? { twilioNumber: num } : null;
  } catch {
    return null;
  }
}

interface CallTimerProps {
  startedAt: number;
}
function CallTimer({ startedAt }: CallTimerProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return <span className="tabular-nums text-sm text-neutral-600">{mm}:{ss}</span>;
}

/**
 * Phase 3.3a — the pill is a joint function of Device.status AND the
 * server-side in_app_calling_enabled preference. A device that has
 * successfully registered locally but whose server preference is OFF
 * MUST NOT show a green "Ready" — routing will not ring it. Show
 * "Enabled locally, not receiving" (amber) instead so the user knows
 * to click Save / retry.
 */
function StatusPill({
  status,
  serverEnabled,
}: {
  status: SoftphoneStatus;
  serverEnabled: boolean | null;
}) {
  const baseMap: Record<SoftphoneStatus, { label: string; color: string }> = {
    idle: { label: "Off", color: "bg-neutral-200 text-neutral-700" },
    "requesting-permission": { label: "Mic prompt…", color: "bg-amber-100 text-amber-800" },
    "permission-denied": { label: "Mic blocked", color: "bg-red-100 text-red-800" },
    connecting: { label: "Connecting…", color: "bg-blue-100 text-blue-800" },
    registered: { label: "Ready", color: "bg-green-100 text-green-800" },
    unregistered: { label: "Offline", color: "bg-red-100 text-red-800" },
    error: { label: "Error", color: "bg-red-100 text-red-800" },
  };
  let label = baseMap[status].label;
  let color = baseMap[status].color;
  // The critical override — never a green light on an unreachable device.
  if (status === "registered" && serverEnabled !== true) {
    label = "Not receiving";
    color = "bg-amber-100 text-amber-800";
  }
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {label}
    </span>
  );
}

export function SoftphoneProvider({ children }: { children: ReactNode }) {
  // Optimistic initial state from the last-known cached value; the GET
  // below reconciles against the server. Never trust localStorage
  // exclusively — routing gates on the server-side flag.
  const [enabled, setEnabledRaw] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ENABLED_CACHE_KEY) === "1";
    } catch {
      return false;
    }
  });
  // serverEnabled = the source of truth (last successful GET/PATCH
  // response). enabled = the local UI intent while a PATCH is in
  // flight. On mount serverEnabled starts null (unknown) and we treat
  // the device as OFF until the GET resolves — no green "Ready" pill
  // for a device the server hasn't confirmed is enabled.
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  // Initial reconciliation.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/voice/preferences", {
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        });
        if (!res.ok) throw new Error(`GET /voice/preferences ${res.status}`);
        const data = (await res.json()) as { in_app_calling_enabled?: boolean };
        if (cancelled) return;
        const truth = !!data.in_app_calling_enabled;
        setServerEnabled(truth);
        setEnabledRaw(truth);
        try {
          localStorage.setItem(ENABLED_CACHE_KEY, truth ? "1" : "0");
        } catch {}
      } catch (e) {
        if (!cancelled) setPreferenceError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback(async (v: boolean) => {
    // Optimistic UI. If the PATCH fails we roll back and surface an
    // error — otherwise the pill would show Ready while the server
    // still routes to the user's cell only.
    const previous = enabled;
    setEnabledRaw(v);
    setPreferenceError(null);
    try {
      const res = await fetch("/api/voice/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ in_app_calling_enabled: v }),
      });
      if (!res.ok) throw new Error(`PATCH /voice/preferences ${res.status}`);
      const data = (await res.json()) as { in_app_calling_enabled?: boolean };
      const truth = !!data.in_app_calling_enabled;
      setServerEnabled(truth);
      setEnabledRaw(truth);
      try {
        localStorage.setItem(ENABLED_CACHE_KEY, truth ? "1" : "0");
      } catch {}
    } catch (e) {
      setEnabledRaw(previous);
      setPreferenceError(
        `Could not save preference — routing will not ring your browser. ${(e as Error).message}`,
      );
    }
  }, [enabled]);

  const device = useTwilioDevice({ enabled });
  const [callerId, setCallerId] = useState<CallerId | null>(null);
  const [activeStartedAt, setActiveStartedAt] = useState<number | null>(null);
  const [dialpadDigits, setDialpadDigits] = useState("");
  const [dockOpen, setDockOpen] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    void fetchOwnCallerId().then(setCallerId);
  }, [enabled]);

  useEffect(() => {
    if (device.active) setActiveStartedAt(Date.now());
    else setActiveStartedAt(null);
  }, [device.active]);

  const callNumber = useCallback(
    async (to: string): Promise<boolean> => {
      if (device.status !== "registered") return false;
      if (!callerId) return false;
      const call = await device.dial(to, callerId.twilioNumber);
      return !!call;
    },
    [device, callerId],
  );

  const ctxValue = useMemo<SoftphoneContextValue>(
    () => ({
      enabled,
      status: device.status,
      identity: device.identity,
      setEnabled,
      callNumber,
    }),
    [enabled, device.status, device.identity, setEnabled, callNumber],
  );

  const dialpadDial = async () => {
    const num = dialpadDigits.trim();
    if (!num) return;
    // Nudge users to E.164 format — the outbound webhook rejects
    // anything that doesn't match /^\+[1-9]\d{6,14}$/ so no point
    // attempting.
    const normalized = num.startsWith("+") ? num : `+${num.replace(/[^0-9]/g, "")}`;
    const ok = await callNumber(normalized);
    if (ok) setDialpadDigits("");
  };

  return (
    <SoftphoneContext.Provider value={ctxValue}>
      {children}

      {/* Floating incoming-call banner (top center) */}
      {device.incoming ? (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-96 max-w-[95vw] rounded-lg border border-neutral-200 bg-white shadow-2xl p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-green-100 p-2">
              <PhoneIncoming className="h-5 w-5 text-green-700 animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-900 truncate">
                {device.incoming.parameters.From || "Incoming call"}
              </div>
              {device.incoming.customParameters.get("topic_name") ? (
                <div className="text-xs text-neutral-500 truncate">
                  {device.incoming.customParameters.get("topic_name")}
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={device.accept}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-700"
            >
              <Phone className="h-4 w-4" /> Accept
            </button>
            <button
              type="button"
              onClick={device.reject}
              className="flex-1 inline-flex items-center justify-center gap-1 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              <PhoneOff className="h-4 w-4" /> Decline
            </button>
          </div>
        </div>
      ) : null}

      {/* Active-call panel (top center, replaces incoming once accepted) */}
      {device.active && activeStartedAt !== null ? (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-96 max-w-[95vw] rounded-lg border border-neutral-200 bg-white shadow-2xl p-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-green-100 p-2">
              <Phone className="h-5 w-5 text-green-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-neutral-900 truncate">
                {device.active.parameters.From ||
                  device.active.parameters.To ||
                  "Call in progress"}
              </div>
              <CallTimer startedAt={activeStartedAt} />
            </div>
            <button
              type="button"
              onClick={device.toggleMute}
              aria-label={device.isMuted ? "Unmute" : "Mute"}
              className={`rounded-md p-2 ${
                device.isMuted ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-700"
              } hover:opacity-80`}
            >
              {device.isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={device.hangup}
              aria-label="Hang up"
              className="rounded-md bg-red-600 p-2 text-white hover:bg-red-700"
            >
              <PhoneOff className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      {/* Dock (bottom right) — always visible, click to expand */}
      <div className="fixed bottom-4 right-4 z-[90]">
        {dockOpen ? (
          <div className="w-72 rounded-lg border border-neutral-200 bg-white shadow-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <PhoneCall className="h-4 w-4 text-neutral-600" />
                <span className="text-sm font-medium">Softphone</span>
                <StatusPill status={device.status} serverEnabled={serverEnabled} />
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setDockOpen(false)}
                className="text-neutral-400 hover:text-neutral-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="flex items-center gap-2 text-sm py-1">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
                  void setEnabled(e.target.checked);
                }}
              />
              <span>Take in-app calls</span>
            </label>

            {device.error ? (
              <div className="mt-2 flex items-start gap-1 rounded-md bg-red-50 p-2 text-xs text-red-800">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{device.error}</span>
              </div>
            ) : null}
            {preferenceError ? (
              <div className="mt-2 flex items-start gap-1 rounded-md bg-red-50 p-2 text-xs text-red-800">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>{preferenceError}</span>
              </div>
            ) : null}
            {enabled && device.status === "registered" && serverEnabled === false ? (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                Enabled locally but the server hasn't recorded it — routing
                will not ring your browser until the preference saves.
              </div>
            ) : null}
            {enabled && device.status === "unregistered" ? (
              <div className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                Your device isn't registered. Routing will not ring your browser
                until this shows Ready.
              </div>
            ) : null}
            {enabled && device.status === "permission-denied" ? (
              <div className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-800">
                Microphone blocked. Enable it in your browser's site
                settings to answer calls.
              </div>
            ) : null}

            {enabled && device.status === "registered" && callerId ? (
              <div className="mt-3">
                <div className="text-xs text-neutral-500 mb-1">
                  Calling from {callerId.twilioNumber}
                </div>
                <div className="flex gap-2">
                  <input
                    type="tel"
                    value={dialpadDigits}
                    onChange={(e) => setDialpadDigits(e.target.value)}
                    placeholder="+15551234567"
                    className="flex-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
                  />
                  <button
                    type="button"
                    onClick={dialpadDial}
                    disabled={!!device.active}
                    className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1 text-sm font-medium text-white disabled:opacity-50 hover:bg-green-700"
                  >
                    <Phone className="h-3.5 w-3.5" /> Call
                  </button>
                </div>
              </div>
            ) : null}

            {device.identity ? (
              <div className="mt-3 text-[10px] text-neutral-400 truncate">
                identity: {device.identity}
              </div>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setDockOpen(true)}
            className="rounded-full bg-white shadow-lg border border-neutral-200 px-3 py-2 flex items-center gap-2 hover:bg-neutral-50"
          >
            <PhoneCall className="h-4 w-4 text-neutral-700" />
            <StatusPill status={device.status} serverEnabled={serverEnabled} />
          </button>
        )}
      </div>
    </SoftphoneContext.Provider>
  );
}
