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
import {
  useTwilioDevice,
  type SoftphoneStatus,
  type CallPhase,
  type FailureKind,
} from "../hooks/useTwilioDevice";
// Phase 3.12 — staff disposition types shared client-side.
export type CallDisposition =
  | "reached_person"
  | "voicemail_left_message"
  | "voicemail_no_message"
  | "wrong_number"
  | "no_answer_bad_line";

export const CALL_DISPOSITIONS: readonly CallDisposition[] = [
  "reached_person",
  "voicemail_left_message",
  "voicemail_no_message",
  "wrong_number",
  "no_answer_bad_line",
] as const;

export const DISPOSITION_LABEL: Record<CallDisposition, string> = {
  reached_person: "Reached person",
  voicemail_left_message: "Voicemail — left message",
  voicemail_no_message: "Voicemail — no message",
  wrong_number: "Wrong number",
  no_answer_bad_line: "No answer / bad line",
};
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

/**
 * Phase 3.12 — a call that just ended, was connected, was outbound,
 * and could/should be dispositioned. Non-null triggers the modal.
 * Cleared when the modal writes or is dismissed. Only outbound calls
 * that actually connected surface here — no_answer / busy / failed /
 * canceled-during-ring go straight to the recent-calls panel with
 * the inferred outcome (asking staff to disposition a call that
 * never connected is noise).
 */
/**
 * Phase 3.14 — disposition write event stream.
 *
 * The recent-calls panel subscribes to these so it can update the
 * relevant row in place — no refetch to learn a value we just sent.
 *
 *  - 'optimistic' fires the instant the user clicks Save. Panel
 *    applies immediately; user never watches a spinner.
 *  - 'confirmed' fires once the PATCH returns 2xx. Panel no-op
 *    (already applied); useful for other future subscribers.
 *  - 'revert' fires if the PATCH fails. Panel rolls the row back
 *    to its pre-optimistic snapshot and surfaces the error inline.
 *
 * The error is delivered on the revert event because the modal is
 * gone by then — closing it immediately is the whole point of
 * optimistic UX.
 */
export type DispositionEvent =
  | { kind: "optimistic"; rowId: string; disposition: CallDisposition }
  | { kind: "confirmed"; rowId: string; disposition: CallDisposition }
  | { kind: "revert"; rowId: string; error: string };

export interface DispositionCandidate {
  /** Row UUID from GET /voice/calls/by-twilio-sid/:sid. */
  callRowId: string;
  /** For the modal header — the number the staff dialed. */
  calleeNumber: string;
  /** For diagnosability if the modal errors. */
  twilioCallSid: string;
}

/**
 * Phase 3.15 — computed reason the current user is unreachable to
 * routing. `null` = reachable (or off-duty, so the question is moot).
 * The banner + StatusPill switch on this to render specific messages;
 * different reasons demand different actions.
 *
 *   mic-blocked           — browser mic permission denied. Cannot boot
 *                           the Device without it. Fix: enable in
 *                           browser site settings.
 *   signed-out            — dashboard session expired (401 from
 *                           /voice/token). Fix: sign in again.
 *   network-offline       — navigator.onLine === false, or token
 *                           refresh keeps failing on network errors.
 *                           Fix: reconnect. Auto-recovers on 'online'.
 *   device-unregistered   — Twilio Device is not registered right
 *                           now (unregister event, error event, or
 *                           still connecting/idle after long enough).
 *                           Fix: usually self-heals on visibilitychange.
 *   stale-heartbeat       — Device is registered but the server
 *                           thinks we're stale. Should be transient
 *                           post Phase 3.15 (visibility trigger pings
 *                           immediately); if persistent, something is
 *                           blocking the fetch to /voice/heartbeat.
 *   no-endpoint           — on duty with in-app calling off AND no
 *                           callback number. Never was reachable.
 */
export type UnreachableReason =
  | "mic-blocked"
  | "signed-out"
  | "network-offline"
  | "device-unregistered"
  | "stale-heartbeat"
  | "no-endpoint"
  | null;

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
  /** Phase 3.9 — ringing → connected → ended lifecycle. */
  callPhase: CallPhase;
  activeStartedAt: number | null;
  ringtoneMuted: boolean;
  preferenceError: string | null;
  reachability: Reachability | null;
  /** Phase 3.4 — Chromium supports it, Firefox doesn't. */
  outputDeviceSelectionSupported: boolean;
  /** Phase 3.15 — see FailureKind in useTwilioDevice. */
  failureKind: FailureKind;
  /**
   * Phase 3.15 — the caller's own on-duty state, hydrated on mount
   * and updated via OnDutyToggle. Needed by the unreachable banner
   * (only render when on-duty — being unreachable off-duty is fine).
   * Nullable while loading; provider treats null as "unknown, don't
   * render banner yet."
   */
  isOnDuty: boolean | null;
  setIsOnDuty: (v: boolean) => void;
  /**
   * Phase 3.15 — computed unreachability reason. Null when reachable
   * (or off-duty). Non-null → the banner renders. See
   * UnreachableReason for the enum + fixes.
   */
  unreachableReason: UnreachableReason;
  refreshReachability: () => Promise<void>;
  setEnabled: (v: boolean) => Promise<void> | void;
  setRingtoneMuted: (v: boolean) => void;
  callNumber: (to: string) => Promise<boolean>;
  hangup: () => void;
  toggleMute: () => void;
  /** Phase 3.12 — see DispositionCandidate. */
  pendingDisposition: DispositionCandidate | null;
  dismissPendingDisposition: () => void;
  /**
   * Phase 3.14 — fire-and-forget. Emits an 'optimistic' event
   * synchronously and closes the modal immediately; the caller does
   * NOT need to await this. PATCH result (success or failure) is
   * delivered via the disposition event stream (subscribeDisposition).
   */
  writePendingDisposition: (d: CallDisposition) => void;
  /**
   * Phase 3.14 — subscribe to disposition write events. Returns an
   * unsubscribe function. Callers MUST call the returned function on
   * unmount, otherwise the listener leaks and re-fires on stale state.
   */
  subscribeDisposition: (cb: (ev: DispositionEvent) => void) => () => void;
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
      callPhase: "none",
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
      failureKind: null,
      isOnDuty: null,
      setIsOnDuty: () => {},
      unreachableReason: null,
      pendingDisposition: null,
      dismissPendingDisposition: () => {},
      writePendingDisposition: () => {},
      subscribeDisposition: () => () => {},
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
  // Phase 3.15 — on-duty state lifted into the provider so the
  // unreachable banner (mounted app-wide) can gate on it. Hydrated
  // once on mount from /business/team/on-duty vs /auth/me. The
  // OnDutyToggle keeps ownership of the toggle click; it calls
  // setIsOnDuty via the context after each optimistic flip so the
  // banner reflects reality without a page reload.
  const [isOnDuty, setIsOnDuty] = useState<boolean | null>(null);

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

  // Phase 3.15 — hydrate on-duty state once. This duplicates the
  // fetch that OnDutyToggle already does, but the toggle lives
  // inside this provider tree so we can't reference its state.
  // The toggle calls setIsOnDuty via the context after every flip
  // so the two views stay in sync without a race.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, onDutyRes] = await Promise.all([
          fetch("/api/auth/me", {
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          }).then((r) => (r.ok ? r.json() : null)),
          fetch("/api/business/team/on-duty", {
            headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          }).then((r) => (r.ok ? r.json() : { members: [] })),
        ]);
        if (cancelled) return;
        const myId = meRes?.user?.id;
        const list = (onDutyRes?.members as Array<{ user_id: string }> | undefined) ?? [];
        setIsOnDuty(!!myId && list.some((m) => m.user_id === myId));
      } catch {
        if (!cancelled) setIsOnDuty(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Phase 3.15 — classify unreachability into an actionable reason.
   * Priority matters: the first matching cause wins so the banner
   * doesn't render "stale heartbeat" when the real problem is that
   * the user is signed out.
   *
   * We only compute a reason when the user is ON DUTY. Being
   * unreachable off-duty is fine — the whole point of off-duty is
   * "don't ring me."
   */
  const unreachableReason = useMemo<UnreachableReason>(() => {
    if (isOnDuty !== true) return null;
    // 1. Signed out. Nothing else can proceed until the user signs in.
    if (device.status === "signed-out" || device.failureKind === "auth") return "signed-out";
    // 2. Network offline. navigator.onLine can lag but we defer to it
    //    plus repeated network-kind refresh failures.
    if (typeof navigator !== "undefined" && navigator.onLine === false) return "network-offline";
    // 3. Mic blocked — the hook set permission-denied.
    if (device.status === "permission-denied") return "mic-blocked";
    // 4. Server thinks we're unreachable → decide by why.
    //    reachability endpoint aggregates: has_callback_ring_number,
    //    in_app_calling_enabled, device_heartbeat_fresh. When
    //    reachable=true, no banner even if the device state looks
    //    weird (callback covers us).
    if (!reachability) return null; // don't shout while unknown
    if (reachability.reachable) return null;
    if (!reachability.has_callback_ring_number && !reachability.in_app_calling_enabled) {
      return "no-endpoint";
    }
    // In-app calling is on but heartbeat is stale (or device isn't
    // registered locally). If the local device is fully un/reg'd,
    // that's a strictly worse signal than "stale-heartbeat" (we know
    // we can't ping).
    if (
      device.status === "unregistered" ||
      device.status === "error" ||
      device.status === "connecting" ||
      device.status === "requesting-permission" ||
      device.status === "idle"
    ) {
      return "device-unregistered";
    }
    return "stale-heartbeat";
  }, [
    isOnDuty,
    device.status,
    device.failureKind,
    reachability,
  ]);
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

  // Phase 3.12 — disposition candidate detection. Track the
  // most-recently active OUTBOUND call that made it to 'connected'.
  // When it transitions to 'ended', look up its row id via the new
  // /voice/calls/by-twilio-sid endpoint and surface a modal. Skips
  // calls that never connected (staff hangup while ringing, etc.)
  // — those already have accurate inferred outcomes.
  //
  // Phase 3.13 — SDK accessor bugs fixed. Evidence for the fix:
  //  1. `Call.direction` is a GETTER (call.d.ts:32), NOT a method.
  //     Calling it as `direction?.()` throws / returns undefined, so
  //     the isOutbound guard always fell through.
  //  2. `Call.parameters` is populated by Twilio only for incoming
  //     calls (call.d.ts:52 JSDoc). For outbound, `parameters` is
  //     `{}` UNTIL `_setCallSid` writes `parameters.CallSid` on the
  //     answer signalling flow (call.js:1284). There is never a
  //     `parameters.Direction` key on outbound.
  //  3. `outboundConnectionId` is a locally-generated *temporary*
  //     SID ("TJS...", call.js:577) — it does NOT match the
  //     `twilio_call_sid` stored server-side (that's the real
  //     "CA..." SID Twilio sent us at /voice/outbound). We must
  //     NOT fall back to it for the row lookup.
  const [pendingDisposition, setPendingDisposition] = useState<DispositionCandidate | null>(null);
  const lastConnectedOutboundRef = useRef<{
    twilioCallSid: string;
    calleeNumber: string;
  } | null>(null);
  useEffect(() => {
    if (device.callPhase !== "connected") return;
    const active = device.active as any;
    if (!active) {
      console.debug("[softphone/disposition] connected phase but no active call");
      return;
    }
    // Property access — `direction` is a getter, not a method.
    const direction = String(active.direction || "").toUpperCase();
    if (direction !== "OUTGOING") {
      console.debug("[softphone/disposition] non-outbound; direction=", direction);
      return;
    }
    // `_setCallSid` fires inside `_onAnswer` BEFORE the 'accept'
    // event is emitted (call.js:224 sequence), and 'accept' is what
    // promotes callPhase to 'connected' (useTwilioDevice:437). So by
    // this point, parameters.CallSid is populated with the real
    // "CA..." SID that matches our server-side row.
    const twilioCallSid: string | undefined = active.parameters?.CallSid;
    if (!twilioCallSid || !twilioCallSid.startsWith("CA")) {
      console.debug(
        "[softphone/disposition] no real CallSid yet; parameters.CallSid=",
        twilioCallSid,
        "outboundConnectionId=",
        active.outboundConnectionId,
      );
      return;
    }
    // `customParameters` is the Map of twimlParams we passed to
    // device.connect({ params: { To, callerId } }) — always set on
    // outbound.
    const calleeNumber = active.customParameters?.get?.("To") || "";
    lastConnectedOutboundRef.current = { twilioCallSid, calleeNumber };
    console.debug(
      "[softphone/disposition] captured outbound CallSid=",
      twilioCallSid,
      "callee=",
      calleeNumber,
    );
  }, [device.callPhase, device.active]);

  useEffect(() => {
    if (device.callPhase !== "ended") return;
    const lastConnected = lastConnectedOutboundRef.current;
    if (!lastConnected) {
      console.debug("[softphone/disposition] ended phase; no captured outbound");
      return;
    }
    // Consumed — clear the ref so we don't re-fire on stale state.
    lastConnectedOutboundRef.current = null;
    (async () => {
      // Small delay so the /voice/outbound row insert (synchronous
      // in the handler) has definitely landed before we look it up.
      await new Promise((r) => setTimeout(r, 300));
      try {
        const res = await fetch(
          `/api/voice/calls/by-twilio-sid/${encodeURIComponent(lastConnected.twilioCallSid)}`,
          { headers: { "Content-Type": "application/json", ...getAuthHeaders() } },
        );
        if (!res.ok) {
          console.debug(
            "[softphone/disposition] lookup failed status=",
            res.status,
            "sid=",
            lastConnected.twilioCallSid,
          );
          return; // silent — modal is opt-in UX, not a failure surface
        }
        const body = (await res.json()) as {
          call?: { id: string; disposition: string | null; caller_number: string | null };
        };
        if (!body.call || !body.call.id) {
          console.debug("[softphone/disposition] lookup returned no call");
          return;
        }
        // If the row is already dispositioned (rare — modal was already
        // shown and written), don't reopen.
        if (body.call.disposition) {
          console.debug("[softphone/disposition] already dispositioned=", body.call.disposition);
          return;
        }
        console.debug("[softphone/disposition] opening modal for call id=", body.call.id);
        setPendingDisposition({
          callRowId: body.call.id,
          twilioCallSid: lastConnected.twilioCallSid,
          calleeNumber: body.call.caller_number || lastConnected.calleeNumber,
        });
      } catch (err) {
        console.debug("[softphone/disposition] lookup threw", err);
        // Non-fatal; the modal is a UX assist, not a required flow.
      }
    })();
  }, [device.callPhase]);

  const dismissPendingDisposition = useCallback(() => {
    setPendingDisposition(null);
  }, []);

  // Phase 3.14 — disposition write event stream. Ref-backed listener
  // set so the subscribe helper's identity is stable (does not
  // re-run subscriber useEffects). Listeners must unsubscribe on
  // unmount; the returned function from subscribeDisposition does that.
  const dispositionListenersRef = useRef(new Set<(ev: DispositionEvent) => void>());
  const subscribeDisposition = useCallback(
    (cb: (ev: DispositionEvent) => void): (() => void) => {
      dispositionListenersRef.current.add(cb);
      return () => {
        dispositionListenersRef.current.delete(cb);
      };
    },
    [],
  );
  const emitDispositionEvent = useCallback((ev: DispositionEvent) => {
    // Snapshot to a local array first — a listener that unsubscribes
    // itself during dispatch (or that another listener removes) must
    // not corrupt the iteration.
    const snapshot = Array.from(dispositionListenersRef.current);
    for (const cb of snapshot) {
      try {
        cb(ev);
      } catch (err) {
        console.error("[softphone/disposition] listener threw", err);
      }
    }
  }, []);

  const writePendingDisposition = useCallback(
    (disposition: CallDisposition): void => {
      const pending = pendingDisposition;
      if (!pending) return;
      const rowId = pending.callRowId;
      // 1. Optimistic: notify subscribers and close the modal in the
      //    same tick. From the user's perspective the write is done.
      emitDispositionEvent({ kind: "optimistic", rowId, disposition });
      setPendingDisposition(null);
      // 2. PATCH in the background. Success/failure comes back via
      //    the same event stream (confirmed / revert). Callers do
      //    NOT await this — the return type is void.
      void (async () => {
        try {
          const res = await fetch(
            `/api/voice/calls/${encodeURIComponent(rowId)}/disposition`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json", ...getAuthHeaders() },
              body: JSON.stringify({ disposition }),
            },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            const error = (body as any)?.error || `HTTP ${res.status}`;
            emitDispositionEvent({ kind: "revert", rowId, error });
            return;
          }
          emitDispositionEvent({ kind: "confirmed", rowId, disposition });
        } catch (e) {
          emitDispositionEvent({ kind: "revert", rowId, error: (e as Error).message });
        }
      })();
    },
    [pendingDisposition, emitDispositionEvent],
  );

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
      callPhase: device.callPhase,
      activeStartedAt,
      ringtoneMuted,
      preferenceError,
      reachability,
      outputDeviceSelectionSupported: device.outputDeviceSelectionSupported,
      failureKind: device.failureKind,
      isOnDuty,
      setIsOnDuty,
      unreachableReason,
      refreshReachability,
      setEnabled,
      setRingtoneMuted,
      callNumber,
      hangup: device.hangup,
      toggleMute: device.toggleMute,
      pendingDisposition,
      dismissPendingDisposition,
      writePendingDisposition,
      subscribeDisposition,
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
      device.callPhase,
      device.failureKind,
      callerId,
      callerIdState,
      hasActiveCall,
      hasIncomingCall,
      activeStartedAt,
      ringtoneMuted,
      preferenceError,
      reachability,
      isOnDuty,
      unreachableReason,
      refreshReachability,
      setEnabled,
      setRingtoneMuted,
      callNumber,
      pendingDisposition,
      dismissPendingDisposition,
      writePendingDisposition,
      subscribeDisposition,
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
          callPhase={device.callPhase}
        />
      ) : null}

      {/* Dock — minimal pill, click navigates to /phone. Hidden while
          an active call strip is showing to keep the top-center focus. */}
      {!device.active && !device.incoming ? <DockPill /> : null}

      {/* Phase 3.12 — disposition modal after a connected outbound
          call ends. NO pre-selection (silent-default would recreate
          the exact bad-data problem this replaces). Auto-dismisses
          after 20s and clears the candidate. */}
      {pendingDisposition ? (
        <DispositionModal
          candidate={pendingDisposition}
          onDismiss={dismissPendingDisposition}
          onSubmit={writePendingDisposition}
        />
      ) : null}
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
  callPhase,
}: {
  label: string;
  startedAt: number;
  isMuted: boolean;
  toggleMute: () => void;
  hangup: () => void;
  callPhase: CallPhase;
}) {
  // Phase 3.9 — audio + UI agree. The staff caller heard silence
  // pre-3.9 during the ringing window and the strip read as
  // "connected" the moment device.active became non-null. Now:
  //   ringing   — amber pulsing icon, "Ringing…" label instead of
  //               a call timer (which was misleading — the seconds
  //               shown were pre-answer)
  //   connected — green icon, running call timer
  //   ended     — grey, "Call ended"
  const isRinging = callPhase === "ringing";
  const isConnected = callPhase === "connected";
  const isEnded = callPhase === "ended";
  const iconBg = isConnected
    ? "bg-green-100"
    : isRinging
    ? "bg-amber-100"
    : "bg-neutral-100";
  const iconColor = isConnected
    ? "text-green-700"
    : isRinging
    ? "text-amber-700"
    : "text-neutral-500";
  const iconAnim = isRinging ? "animate-pulse" : "";
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-96 max-w-[95vw] rounded-lg border border-neutral-200 bg-white shadow-2xl p-4">
      <div className="flex items-center gap-3">
        <div className={`rounded-full p-2 ${iconBg}`}>
          <Phone className={`h-5 w-5 ${iconColor} ${iconAnim}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-neutral-900 truncate">{label}</div>
          {isRinging ? (
            <span className="text-sm text-amber-700">Ringing…</span>
          ) : isEnded ? (
            <span className="text-sm text-neutral-500">Call ended</span>
          ) : (
            <CallTimer startedAt={startedAt} />
          )}
        </div>
        <button
          type="button"
          onClick={toggleMute}
          aria-label={isMuted ? "Unmute" : "Mute"}
          disabled={!isConnected}
          className={`rounded-md p-2 ${
            isMuted ? "bg-amber-100 text-amber-800" : "bg-neutral-100 text-neutral-700"
          } hover:opacity-80 disabled:opacity-40`}
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

/**
 * Phase 3.12 — post-call disposition modal.
 *
 * Design principles from the phase brief:
 *   - NO pre-selection. A pre-selected default silently writes
 *     "reached_person" on every skipped call, which recreates the
 *     exact bad-data problem this replaces.
 *   - Skippable. Auto-dismisses after 20s. Skipping leaves the row
 *     with no disposition (call_outcome stays as the Twilio-inferred
 *     value). Reporting must render "not dispositioned" for those.
 *   - Only shown after a CONNECTED outbound call — not for
 *     no_answer / busy / failed / canceled_during_ring which
 *     already have accurate inferred outcomes.
 */
function DispositionModal({
  candidate,
  onDismiss,
  onSubmit,
}: {
  candidate: DispositionCandidate;
  onDismiss: () => void;
  // Phase 3.14 — fire-and-forget. Provider closes the modal
  // synchronously on click; failures surface via the disposition
  // event stream (revert), NOT back through this callback.
  onSubmit: (d: CallDisposition) => void;
}) {
  const [selected, setSelected] = useState<CallDisposition | null>(null);
  const [remaining, setRemaining] = useState(20);

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          onDismiss();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [onDismiss]);

  const submit = () => {
    if (!selected) return;
    // No await, no spinner, no error state — provider closes us in
    // the same tick. Any downstream PATCH failure is caught by the
    // panel's revert handler.
    onSubmit(selected);
  };

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-[460px] max-w-[95vw] rounded-2xl bg-white shadow-2xl p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Call ended</div>
            <div className="text-lg font-semibold text-neutral-900 mt-0.5">
              How did that call with{" "}
              <span className="font-mono text-neutral-700">
                {candidate.calleeNumber || "the customer"}
              </span>{" "}
              go?
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Skip"
            className="text-neutral-400 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>

        <div className="space-y-1.5 mb-4">
          {CALL_DISPOSITIONS.map((opt) => (
            <label
              key={opt}
              className={`flex items-center gap-3 rounded-md border p-2.5 cursor-pointer text-sm hover:bg-neutral-50 ${
                selected === opt
                  ? "border-blue-400 bg-blue-50 text-blue-900"
                  : "border-neutral-200 text-neutral-800"
              }`}
            >
              <input
                type="radio"
                name="disposition"
                value={opt}
                checked={selected === opt}
                onChange={() => setSelected(opt)}
                className="h-3.5 w-3.5"
              />
              <span>{DISPOSITION_LABEL[opt]}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-neutral-400 tabular-nums">
            Auto-dismisses in {remaining}s (leaves undispositioned)
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!selected}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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
    // Phase 3.15 — session gone. Red, not amber, because the fix is
    // an explicit user action (sign in), not "wait and see."
    "signed-out": { label: "Signed out", color: "bg-red-100 text-red-800" },
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
  // Phase 3.15 — when on duty and unreachable, this indicator MUST
  // read red so it's impossible to miss (per phase brief #4). The
  // reason enum comes from the provider and already accounts for
  // "off-duty → don't shout." Fall back to the derived state
  // otherwise.
  const state =
    sp.unreachableReason && sp.isOnDuty === true
      ? { label: "Unreachable", dot: "bg-red-500", text: "text-red-600" }
      : deriveIndicatorState(sp.status, sp.serverEnabled);
  return (
    <button
      type="button"
      onClick={() => navigate("/phone")}
      className="flex items-center gap-1.5 hover:opacity-70 transition-opacity"
      title={sp.unreachableReason ? "Unreachable — click for details" : "Open softphone"}
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
  // Phase 3.15 — signed-out shows in-band with other red states so the
  // user notices immediately, but with distinct copy so the fix is
  // obvious ("Signed out" ≠ "Offline"). The banner carries the CTA.
  if (status === "signed-out") {
    return { label: "Signed out", dot: "bg-red-500", text: "text-red-600" };
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

/**
 * Phase 3.15 — the LOUD unreachable banner.
 *
 * Mounted app-wide in App.tsx so it appears on every dashboard page,
 * not just /phone. Renders only when the user is on duty AND has a
 * non-null unreachableReason.
 *
 * Distinguished causes render distinct copy + CTAs (per phase brief
 * #4). Also fires a browser Notification once per session when the
 * reason first appears (best-effort — needs prior permission) and
 * flashes the tab title so a backgrounded tab can't hide it.
 *
 * NOT dismissable. Dismissing a banner about "you cannot receive
 * calls" defeats the point — either fix it or clock out.
 */
export function UnreachableBanner() {
  const sp = useSoftphone();
  const [, navigate] = useLocation();
  const reason = sp.unreachableReason;
  const shouldShow = sp.isOnDuty === true && reason !== null;

  // Fire a Notification once per (mount, reason) so a hidden tab can
  // audibly / visually alert the user. Best-effort; requires prior
  // permission (we do NOT auto-request from the banner). Tracked in
  // a ref so re-renders don't spam.
  const notifiedForReasonRef = useRef<UnreachableReason>(null);
  useEffect(() => {
    if (!shouldShow || reason === notifiedForReasonRef.current) return;
    notifiedForReasonRef.current = reason;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    try {
      new Notification("Neverr — you can't receive calls", {
        body: bannerCopyFor(reason).headline,
        requireInteraction: true,
      });
    } catch {}
  }, [shouldShow, reason]);

  // Tab title flash — pulls the same channel as the ringing flash but
  // stays on until unreachability is resolved. Restores original
  // title on cleanup.
  useEffect(() => {
    if (!shouldShow) return;
    const original = document.title;
    let flipped = false;
    const id = setInterval(() => {
      flipped = !flipped;
      document.title = flipped ? `⚠️ Can't receive calls` : original;
    }, 900);
    return () => {
      clearInterval(id);
      document.title = original;
    };
  }, [shouldShow]);

  if (!shouldShow) return null;
  const copy = bannerCopyFor(reason);
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="w-full bg-red-600 text-white text-sm px-4 py-2 flex items-center gap-3 shadow-md"
    >
      <span className="text-lg leading-none" aria-hidden>
        ⚠
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold">{copy.headline}</div>
        <div className="text-red-100 text-xs">{copy.body}</div>
      </div>
      {copy.cta ? (
        <button
          type="button"
          onClick={() => {
            if (copy.cta!.href === "signout") {
              window.location.assign("/auth");
              return;
            }
            navigate(copy.cta!.href);
          }}
          className="rounded-md bg-white text-red-700 text-xs font-semibold px-3 py-1.5 hover:bg-red-50"
        >
          {copy.cta.label}
        </button>
      ) : null}
    </div>
  );
}

function bannerCopyFor(reason: UnreachableReason): {
  headline: string;
  body: string;
  cta: { label: string; href: string } | null;
} {
  switch (reason) {
    case "signed-out":
      return {
        headline: "Signed out — you cannot receive calls",
        body: "Your dashboard session expired. Sign back in to keep receiving calls.",
        cta: { label: "Sign in", href: "signout" },
      };
    case "network-offline":
      return {
        headline: "Offline — you cannot receive calls",
        body: "Your network dropped. Calls will resume as soon as you're back online.",
        cta: null,
      };
    case "mic-blocked":
      return {
        headline: "Microphone blocked — you cannot receive calls",
        body:
          "Grant microphone access to this site in your browser settings, then reload the page.",
        cta: { label: "Open Phone", href: "/phone" },
      };
    case "device-unregistered":
      return {
        headline: "Softphone not connected — you cannot receive calls",
        body: "Open the Phone page to reconnect your browser device, or add a callback number.",
        cta: { label: "Open Phone", href: "/phone" },
      };
    case "stale-heartbeat":
      return {
        headline: "Softphone unreachable — calls may miss you",
        body:
          "This tab hasn't checked in with the server. Bringing it to the foreground usually fixes it; if it persists, open the Phone page.",
        cta: { label: "Open Phone", href: "/phone" },
      };
    case "no-endpoint":
      return {
        headline: "No way to reach you — you cannot receive calls",
        body:
          "You're on duty with in-app calling off and no callback number. Enable in-app calling on the Phone page, or add a callback number in Team settings.",
        cta: { label: "Open Phone", href: "/phone" },
      };
    case null:
      return { headline: "", body: "", cta: null };
  }
}
