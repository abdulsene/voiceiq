/**
 * Phase 3.3c — softphone provider + always-mounted UI overlays.
 *
 * Provider exposes:
 *   • Device state (status, identity, incoming, active, isMuted, error)
 *   • Server-authoritative in_app_calling_enabled + optimistic setter
 *   • Reachability snapshot from /api/voice/reachability (used by the
 *     on-duty guard so a user can't clock in and go silently unreachable)
 *   • Ringtone mute state (persists to localStorage)
 *   • Call actions (dial / accept / reject / hangup / toggleMute)
 *
 * Renders three overlays:
 *   1. IncomingCallModal — centered, full-attention. Ringtone audio,
 *      tab title flash, Notification API prompt, countdown against the
 *      Dial timeout. Not a corner toast.
 *   2. ActiveCallStrip — top-center, compact, replaces the modal after
 *      accept. Mute + hangup + timer.
 *   3. DockPill — bottom-right, minimal. Status + link to /phone.
 *      Full dialpad + history + toggle live on the /phone page now.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation } from "wouter";
import { Phone, PhoneOff, Mic, MicOff, PhoneIncoming, Volume2, VolumeX } from "lucide-react";
import { useTwilioDevice, type SoftphoneStatus } from "../hooks/useTwilioDevice";
import { getAuthHeaders } from "../lib/api";

const ENABLED_CACHE_KEY = "neverr_softphone_enabled";
const RINGTONE_MUTED_KEY = "neverr_softphone_ringtone_muted";

// Twilio Dial timeout used by the Phase 3.2 routing engine (see
// dial-builder.ts `timeoutSecs` default). If we can't accept in this
// window the customer's leg falls through to the next candidate — the
// modal shows a countdown so the answerer knows how long they have.
const INCOMING_RING_TIMEOUT_SECS = 30;

// ── Data shapes ─────────────────────────────────────────────────────

export interface Reachability {
  in_app_calling_enabled: boolean;
  has_callback_ring_number: boolean;
  device_heartbeat_fresh: boolean;
  reachable: boolean;
  device_heartbeat_age_secs: number | null;
}

interface CallerId {
  twilioNumber: string;
}

/**
 * Phase 3.7 — distinguish "genuinely not provisioned" from "we failed
 * to load it." Pre-3.7 both rendered as "not configured" which sent
 * ops on a config chase when the actual bug was a frontend shape
 * mismatch against /business/configure.
 */
export type CallerIdState =
  | { status: "loading" }
  | { status: "provisioned"; twilioNumber: string; sid: string | null }
  | { status: "not_provisioned" }
  | { status: "error"; message: string };

export interface SoftphoneContextValue {
  enabled: boolean;
  serverEnabled: boolean | null;
  status: SoftphoneStatus;
  identity: string | null;
  callerId: CallerId | null;
  callerIdState: CallerIdState;
  isMuted: boolean;
  active: unknown | null;
  hasActiveCall: boolean;
  hasIncomingCall: boolean;
  activeStartedAt: number | null;
  ringtoneMuted: boolean;
  preferenceError: string | null;
  reachability: Reachability | null;
  /** Phase 3.4 — Chromium supports it, Firefox doesn't. */
  outputDeviceSelectionSupported: boolean;
  refreshReachability: () => Promise<void>;
  setEnabled: (v: boolean) => Promise<void> | void;
  setRingtoneMuted: (v: boolean) => void;
  callNumber: (to: string) => Promise<boolean>;
  hangup: () => void;
  toggleMute: () => void;
}

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

/**
 * Silent no-op fallback lets any component call useSoftphone() without
 * forcing the provider higher in the tree — the marketing pages, for
 * example, never mount the provider. Status stays 'idle', click-to-call
 * rejects.
 */
export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) {
    return {
      enabled: false,
      serverEnabled: null,
      status: "idle",
      identity: null,
      callerId: null,
      callerIdState: { status: "loading" },
      isMuted: false,
      active: null,
      hasActiveCall: false,
      hasIncomingCall: false,
      activeStartedAt: null,
      ringtoneMuted: false,
      preferenceError: null,
      reachability: null,
      outputDeviceSelectionSupported: false,
      refreshReachability: async () => {},
      setEnabled: () => {},
      setRingtoneMuted: () => {},
      callNumber: async () => false,
      hangup: () => {},
      toggleMute: () => {},
    };
  }
  return ctx;
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Phase 3.7 — dedicated /api/voice/caller-id endpoint. Previously read
 * /api/business/configure which returns { config: { ...row } } (nested);
 * the frontend read `response.twilio_phone_number` at the top level
 * instead of `response.config.twilio_phone_number`, so callerId was
 * always null even when the DB row was correctly populated. Two fixes:
 *
 *   1. New dedicated endpoint returns a flat { twilio_phone_number, ... }
 *      shape — no nesting to get wrong.
 *   2. Returns three DISTINCT states: provisioned (has a number),
 *      not_provisioned (row exists but no number), error (HTTP fail).
 *      Pre-3.7 all three rendered as "not configured" in the UI,
 *      which sent ops on a config chase when the actual bug was a
 *      response-shape mismatch.
 */
async function fetchOwnCallerId(): Promise<CallerIdState> {
  try {
    const res = await fetch("/api/voice/caller-id", {
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    });
    if (!res.ok) {
      return { status: "error", message: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      provisioned?: boolean;
      twilio_phone_number?: string | null;
      twilio_phone_sid?: string | null;
    };
    if (body.provisioned && body.twilio_phone_number) {
      return {
        status: "provisioned",
        twilioNumber: body.twilio_phone_number,
        sid: body.twilio_phone_sid ?? null,
      };
    }
    return { status: "not_provisioned" };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

/**
 * Ringtone via WebAudio — no external asset to bundle. A 480/620 Hz
 * two-tone loop approximating a landline ring. Started/stopped via
 * refs so React re-renders never restart the loop.
 */
function useRingtone(active: boolean, muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active || muted) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (ctxRef.current) {
        try {
          void ctxRef.current.close();
        } catch {}
        ctxRef.current = null;
      }
      return;
    }
    // Lazy AudioContext creation — browsers block until a user
    // gesture, but the incoming call was triggered by a device event
    // downstream of the user having enabled the softphone. If the
    // context stays suspended the ring is inaudible; not fatal.
    if (!ctxRef.current) {
      try {
        ctxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {
        return;
      }
    }
    const ctx = ctxRef.current;
    if (!ctx) return;

    const playBurst = () => {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.frequency.value = 480;
      osc2.frequency.value = 620;
      // ~2s ring, ~4s gap — approximates North-American landline cadence.
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.setValueAtTime(0.15, now + 1.9);
      gain.gain.linearRampToValueAtTime(0, now + 2);
      osc1.connect(gain).connect(ctx.destination);
      osc2.connect(gain);
      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 2);
      osc2.stop(now + 2);
    };
    playBurst();
    intervalRef.current = setInterval(playBurst, 4000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [active, muted]);
}

/**
 * Flashes the browser tab title while an incoming call rings. Restores
 * the original title on cleanup so navigating away doesn't leave the
 * flash sticking.
 */
function useTitleFlash(active: boolean, text: string) {
  useEffect(() => {
    if (!active) return;
    const original = document.title;
    let flipped = false;
    const id = setInterval(() => {
      flipped = !flipped;
      document.title = flipped ? text : original;
    }, 900);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [active, text]);
}

/**
 * Fires a browser Notification when an incoming call arrives (if the
 * user has already granted permission). We do NOT auto-request
 * permission — the user opts in from the /phone page. Suppresses when
 * the tab is already focused (the modal is sufficient there).
 */
function useIncomingNotification(active: boolean, title: string, body: string) {
  useEffect(() => {
    if (!active) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    if (document.hasFocus?.()) return;
    try {
      const n = new Notification(title, { body, requireInteraction: true });
      return () => {
        try {
          n.close();
        } catch {}
      };
    } catch {
      // Some browsers throw when constructing from insecure contexts.
      return;
    }
  }, [active, title, body]);
}

// ── Provider ────────────────────────────────────────────────────────

export function SoftphoneProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledRaw] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ENABLED_CACHE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [ringtoneMuted, setRingtoneMutedRaw] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RINGTONE_MUTED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [reachability, setReachability] = useState<Reachability | null>(null);

  const setRingtoneMuted = useCallback((v: boolean) => {
    setRingtoneMutedRaw(v);
    try {
      localStorage.setItem(RINGTONE_MUTED_KEY, v ? "1" : "0");
    } catch {}
  }, []);

  const refreshReachability = useCallback(async () => {
    try {
      const res = await fetch("/api/voice/reachability", {
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      if (!res.ok) return;
      const data = (await res.json()) as Reachability;
      setReachability(data);
    } catch {
      // Non-fatal — the guard degrades to "unknown" and warns.
    }
  }, []);

  // Initial preference reconciliation + reachability snapshot.
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
    void refreshReachability();
    // Refresh reachability every 30s so the on-duty guard sees stale
    // heartbeats without a full page reload.
    const id = setInterval(refreshReachability, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshReachability]);

  const setEnabled = useCallback(
    async (v: boolean) => {
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
        // Reachability may have flipped as a result of enabling in-app
        // calling (device still needs to register + heartbeat, but the
        // flag itself is now true).
        void refreshReachability();
      } catch (e) {
        setEnabledRaw(previous);
        setPreferenceError(
          `Could not save preference — routing will not ring your browser. ${(e as Error).message}`,
        );
      }
    },
    [enabled, refreshReachability],
  );

  const device = useTwilioDevice({ enabled });
  const [callerIdState, setCallerIdState] = useState<CallerIdState>({ status: "loading" });
  // Phase 3.7 — derived flat CallerId | null for backwards compat with
  // components that just want "the number." The rich state (loading /
  // provisioned / not_provisioned / error) is on callerIdState.
  const callerId: CallerId | null =
    callerIdState.status === "provisioned"
      ? { twilioNumber: callerIdState.twilioNumber }
      : null;
  const [activeStartedAt, setActiveStartedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setCallerIdState({ status: "loading" });
    void fetchOwnCallerId().then(setCallerIdState);
  }, [enabled]);

  useEffect(() => {
    if (device.active) setActiveStartedAt(Date.now());
    else setActiveStartedAt(null);
  }, [device.active]);

  // Bump the heartbeat freshness in reachability the moment we
  // register — routing needs a fresh HB before it will ring the
  // browser, and we can't wait 30s for the next refresh.
  useEffect(() => {
    if (device.status === "registered") void refreshReachability();
  }, [device.status, refreshReachability]);

  const callNumber = useCallback(
    async (to: string): Promise<boolean> => {
      if (device.status !== "registered") return false;
      if (!callerId) return false;
      const call = await device.dial(to, callerId.twilioNumber);
      return !!call;
    },
    [device, callerId],
  );

  const hasIncomingCall = !!device.incoming;
  const hasActiveCall = !!device.active;
  const incomingFrom = device.incoming?.parameters?.From || "";
  const incomingTopic = device.incoming?.customParameters?.get("topic_name") || "";

  useRingtone(hasIncomingCall, ringtoneMuted);
  useTitleFlash(hasIncomingCall, `📞 ${incomingFrom || "Incoming call"}`);
  useIncomingNotification(
    hasIncomingCall,
    incomingTopic ? `Incoming: ${incomingTopic}` : "Incoming call",
    incomingFrom || "Unknown caller",
  );

  const ctxValue = useMemo<SoftphoneContextValue>(
    () => ({
      enabled,
      serverEnabled,
      status: device.status,
      identity: device.identity,
      callerId,
      callerIdState,
      isMuted: device.isMuted,
      active: device.active,
      hasActiveCall,
      hasIncomingCall,
      activeStartedAt,
      ringtoneMuted,
      preferenceError,
      reachability,
      outputDeviceSelectionSupported: device.outputDeviceSelectionSupported,
      refreshReachability,
      setEnabled,
      setRingtoneMuted,
      callNumber,
      hangup: device.hangup,
      toggleMute: device.toggleMute,
    }),
    [
      enabled,
      serverEnabled,
      device.status,
      device.identity,
      device.isMuted,
      device.active,
      device.hangup,
      device.toggleMute,
      device.outputDeviceSelectionSupported,
      callerId,
      callerIdState,
      hasActiveCall,
      hasIncomingCall,
      activeStartedAt,
      ringtoneMuted,
      preferenceError,
      reachability,
      refreshReachability,
      setEnabled,
      setRingtoneMuted,
      callNumber,
    ],
  );

  return (
    <SoftphoneContext.Provider value={ctxValue}>
      {children}

      {device.incoming ? (
        <IncomingCallModal
          from={incomingFrom || "Incoming call"}
          topicName={incomingTopic}
          accept={device.accept}
          reject={device.reject}
          ringtoneMuted={ringtoneMuted}
          setRingtoneMuted={setRingtoneMuted}
        />
      ) : null}

      {device.active && activeStartedAt !== null ? (
        <ActiveCallStrip
          label={
            device.active.parameters.From ||
            device.active.parameters.To ||
            "Call in progress"
          }
          startedAt={activeStartedAt}
          isMuted={device.isMuted}
          toggleMute={device.toggleMute}
          hangup={device.hangup}
        />
      ) : null}

      {/* Dock — minimal pill, click navigates to /phone. Hidden while
          an active call strip is showing to keep the top-center focus. */}
      {!device.active && !device.incoming ? <DockPill /> : null}
    </SoftphoneContext.Provider>
  );
}

// ── Overlays ────────────────────────────────────────────────────────

/**
 * Unmissable full-attention incoming-call modal. Centered on the
 * viewport with a translucent backdrop, a large caller display, and
 * a countdown against the Dial timeout so the answerer knows the
 * customer isn't going to wait forever.
 */
function IncomingCallModal({
  from,
  topicName,
  accept,
  reject,
  ringtoneMuted,
  setRingtoneMuted,
}: {
  from: string;
  topicName: string;
  accept: () => void;
  reject: () => void;
  ringtoneMuted: boolean;
  setRingtoneMuted: (v: boolean) => void;
}) {
  const [remaining, setRemaining] = useState(INCOMING_RING_TIMEOUT_SECS);
  useEffect(() => {
    setRemaining(INCOMING_RING_TIMEOUT_SECS);
    const id = setInterval(() => {
      setRemaining((r) => Math.max(0, r - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[440px] max-w-[95vw] rounded-2xl bg-white shadow-2xl p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-full bg-green-100 p-3">
            <PhoneIncoming className="h-6 w-6 text-green-700 animate-pulse" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs uppercase tracking-wide text-neutral-500">
              Incoming call{topicName ? ` — ${topicName}` : ""}
            </div>
            <div className="text-xl font-semibold text-neutral-900 truncate">{from}</div>
          </div>
          <button
            type="button"
            onClick={() => setRingtoneMuted(!ringtoneMuted)}
            aria-label={ringtoneMuted ? "Unmute ringtone" : "Mute ringtone"}
            className="rounded-md p-2 bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
          >
            {ringtoneMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>

        <div className="mb-4">
          <div className="flex items-center justify-between text-xs text-neutral-500 mb-1">
            <span>Auto-declines in</span>
            <span className="tabular-nums font-medium text-neutral-700">{remaining}s</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-neutral-100 overflow-hidden">
            <div
              className={`h-full transition-all duration-1000 ease-linear ${
                remaining <= 5 ? "bg-red-500" : "bg-emerald-500"
              }`}
              style={{ width: `${(remaining / INCOMING_RING_TIMEOUT_SECS) * 100}%` }}
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            onClick={reject}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-3 text-sm font-semibold text-white hover:bg-red-700"
          >
            <PhoneOff className="h-5 w-5" /> Decline
          </button>
          <button
            type="button"
            onClick={accept}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white hover:bg-green-700"
          >
            <Phone className="h-5 w-5" /> Accept
          </button>
        </div>
      </div>
    </div>
  );
}

function CallTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, "0");
  const ss = String(secs % 60).padStart(2, "0");
  return (
    <span className="tabular-nums text-sm text-neutral-600">
      {mm}:{ss}
    </span>
  );
}

function ActiveCallStrip({
  label,
  startedAt,
  isMuted,
  toggleMute,
  hangup,
}: {
  label: string;
  startedAt: number;
  isMuted: boolean;
  toggleMute: () => void;
  hangup: () => void;
}) {
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-96 max-w-[95vw] rounded-lg border border-neutral-200 bg-white shadow-2xl p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-full bg-green-100 p-2">
          <Phone className="h-5 w-5 text-green-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-neutral-900 truncate">{label}</div>
          <CallTimer startedAt={startedAt} />
        </div>
        <button
          type="button"
          onClick={toggleMute}
          aria-label={isMuted ? "Unmute" : "Mute"}
          className={`rounded-md p-2 ${
            isMuted ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-700"
          } hover:opacity-80`}
        >
          {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={hangup}
          aria-label="Hang up"
          className="rounded-md bg-red-600 p-2 text-white hover:bg-red-700"
        >
          <PhoneOff className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Compact bottom-right pill — status only. Click navigates to /phone.
 * Full controls / dialpad / toggle live on the /phone page in 3.3c so
 * the dock cannot be the only place a user finds the softphone.
 */
function DockPill() {
  const sp = useSoftphone();
  const [, navigate] = useLocation();
  return (
    <div className="fixed bottom-4 right-4 z-[90]">
      <button
        type="button"
        onClick={() => navigate("/phone")}
        className="rounded-full bg-white shadow-lg border border-neutral-200 px-3 py-2 flex items-center gap-2 hover:bg-neutral-50"
      >
        <Phone className="h-4 w-4 text-neutral-700" />
        <StatusPill status={sp.status} serverEnabled={sp.serverEnabled} />
      </button>
    </div>
  );
}

/**
 * The pill is a joint function of Device.status AND the server-side
 * in_app_calling_enabled preference. A device that has successfully
 * registered locally but whose server preference is OFF MUST NOT show
 * green — routing will not ring it. Exported for the /phone page and
 * the system-bar SoftphoneIndicator so all three surfaces agree.
 */
export function StatusPill({
  status,
  serverEnabled,
}: {
  status: SoftphoneStatus;
  serverEnabled: boolean | null;
}) {
  const base: Record<SoftphoneStatus, { label: string; color: string }> = {
    idle: { label: "Off", color: "bg-neutral-200 text-neutral-700" },
    "requesting-permission": { label: "Mic prompt…", color: "bg-amber-100 text-amber-800" },
    "permission-denied": { label: "Mic blocked", color: "bg-red-100 text-red-800" },
    connecting: { label: "Connecting…", color: "bg-blue-100 text-blue-800" },
    registered: { label: "Ready", color: "bg-green-100 text-green-800" },
    unregistered: { label: "Offline", color: "bg-red-100 text-red-800" },
    error: { label: "Error", color: "bg-red-100 text-red-800" },
  };
  let label = base[status].label;
  let color = base[status].color;
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

/**
 * System-bar-shaped indicator — matches the "Alex: Live" / "SMS: Active"
 * visual language used inside CommandCenter's status strip. Click
 * navigates to /phone.
 *
 * Four visible states from the spec:
 *   Ready (green)  = registered + serverEnabled=true
 *   Not receiving  = registered + serverEnabled=false (device up, server off)
 *   Off (grey)     = idle
 *   Mic blocked    = permission-denied
 * Also handles: Connecting (amber), Offline (red), Error (red).
 */
export function SoftphoneIndicator() {
  const sp = useSoftphone();
  const [, navigate] = useLocation();
  const state = deriveIndicatorState(sp.status, sp.serverEnabled);
  return (
    <button
      type="button"
      onClick={() => navigate("/phone")}
      className="flex items-center gap-1.5 hover:opacity-70 transition-opacity"
      title="Open softphone"
    >
      <span className={`w-2 h-2 rounded-full ${state.dot}`} />
      <Phone className="w-3.5 h-3.5 text-gray-400" />
      <span className="text-[11px] font-medium text-gray-600">
        Softphone: <span className={state.text}>{state.label}</span>
      </span>
    </button>
  );
}

export function deriveIndicatorState(
  status: SoftphoneStatus,
  serverEnabled: boolean | null,
): { label: string; dot: string; text: string } {
  if (status === "permission-denied") {
    return { label: "Mic blocked", dot: "bg-red-500", text: "text-red-600" };
  }
  if (status === "error" || status === "unregistered") {
    return { label: "Offline", dot: "bg-red-500", text: "text-red-600" };
  }
  if (status === "connecting" || status === "requesting-permission") {
    return { label: "Connecting…", dot: "bg-amber-500", text: "text-amber-600" };
  }
  if (status === "registered") {
    return serverEnabled === true
      ? { label: "Ready", dot: "bg-emerald-500", text: "text-emerald-600" }
      : { label: "Not receiving", dot: "bg-amber-500", text: "text-amber-600" };
  }
  // idle
  return { label: "Off", dot: "bg-neutral-400", text: "text-neutral-500" };
}

// Re-export Link so the system-bar can render a clickable indicator
// without pulling wouter directly.
export { Link as SoftphoneLink };
