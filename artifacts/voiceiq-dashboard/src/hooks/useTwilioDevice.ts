/**
 * Phase 3.3 — Twilio Voice WebRTC softphone hook.
 *
 * Fetches an AccessToken from POST /api/voice/token, boots a
 * `@twilio/voice-sdk` Device under that token, keeps it registered,
 * and refreshes the token BEFORE it expires (not after — waiting for
 * `tokenExpired` means missing a call while the token is invalid).
 *
 * Exposes:
 *   status:    'idle' | 'requesting-permission' | 'permission-denied'
 *              | 'connecting' | 'registered' | 'unregistered' | 'error'
 *   identity:  the Twilio Client identity the server derived from the JWT
 *   incoming:  the current inbound Call (from device.on('incoming')),
 *              or null. Accept / decline via accept() / reject().
 *   active:    the currently-connected Call (post-accept OR post-connect
 *              for outbound), or null.
 *   error:     last non-fatal error message (for surfacing in UI)
 *   accept():  answer the incoming call
 *   reject():  decline the incoming call
 *   hangup():  disconnect the active call
 *   toggleMute()
 *   dial(to):  place an outbound call via device.connect({params:{To}})
 *
 * Lifecycle safety:
 *   - Cleans up device + timers on unmount (React 19 dev double-mount safe)
 *   - Silent reconnect on tokenWillExpire — no dead-endpoint window
 *   - Heartbeat posts to /api/voice/heartbeat every 30s while registered
 *     so the Phase 3.2 routing engine can treat a stale heartbeat as
 *     "device offline, do not ring"
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { getAuthHeaders } from "../lib/api";

export type SoftphoneStatus =
  | "idle"
  | "requesting-permission"
  | "permission-denied"
  | "connecting"
  | "registered"
  | "unregistered"
  | "error";

/**
 * Phase 3.9 — explicit lifecycle for the ACTIVE call, independent of
 * device registration. Audio and UI need to agree: pre-3.9 the UI
 * jumped from "no call" straight to "connected" the moment `active`
 * became non-null, so the ringing seconds (up to 30s) rendered as
 * silence + fake "connected." Now:
 *   none       — no call in progress
 *   ringing    — outbound only, Twilio has started ringing the far end
 *                (via Call 'ringing' event)
 *   connected  — the far end (or AMD) picked up (Call 'accept' event)
 *   ended      — the call terminated (Call 'disconnect' event); UI
 *                stays here for one render cycle before returning to
 *                'none' so a brief "call ended" state is visible.
 */
export type CallPhase = "none" | "ringing" | "connected" | "ended";

interface TokenPayload {
  token: string;
  identity: string;
  expires_at: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

// Refresh the token 5 minutes before it expires. The AccessToken TTL is
// 3600s server-side; refreshing at 3300s leaves a safety margin for
// network latency + clock skew and keeps the SDK from ever seeing an
// expired token (which would trigger a full unregister/reregister
// during which incoming calls would fail).
const REFRESH_LEAD_TIME_MS = 5 * 60 * 1000;

async function fetchToken(): Promise<TokenPayload> {
  const res = await fetch("/api/voice/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
  });
  if (!res.ok) throw new Error(`token fetch failed: ${res.status}`);
  return res.json();
}

async function postHeartbeat(): Promise<void> {
  try {
    await fetch("/api/voice/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    });
  } catch {
    // Non-fatal — the next heartbeat retry will hit; if we lose
    // registration for >90s the routing engine drops us as a candidate.
  }
}

export interface UseTwilioDeviceOptions {
  /**
   * When false, the hook does nothing — no permission prompt, no
   * network, no device. Use this to defer boot until the user opts in
   * via a toggle so we don't burn a mic prompt at page load.
   */
  enabled: boolean;
  /**
   * Called with the calling number when Twilio emits 'incoming'. Lets
   * callers ring a bell, show a toast, etc. before the returned
   * `incoming` prop settles.
   */
  onIncoming?: (info: { from: string; topicName?: string }) => void;
}

export interface UseTwilioDeviceResult {
  status: SoftphoneStatus;
  identity: string | null;
  incoming: Call | null;
  active: Call | null;
  /** Phase 3.9 — see CallPhase docs. */
  callPhase: CallPhase;
  isMuted: boolean;
  error: string | null;
  /**
   * Phase 3.4 — true iff the browser implements HTMLAudioElement
   * .setSinkId (Chromium yes, Firefox no as of FF 141). Feature
   * detection surfaced to the UI so the Phone page can render a
   * warning explaining why the speaker picker isn't available.
   */
  outputDeviceSelectionSupported: boolean;
  accept: () => void;
  reject: () => void;
  hangup: () => void;
  toggleMute: () => void;
  dial: (to: string, callerId: string) => Promise<Call | null>;
}

/**
 * Phase 3.4 — persistent hidden <audio> element for remote audio.
 * We manage this ourselves (rather than relying on the SDK's default
 * routing) because Firefox one-way audio was traced to the SDK's
 * built-in attach path not always kicking in when setSinkId is
 * unavailable. Explicit srcObject + .play() inside a user-gesture
 * handler (accept / dial) works cross-browser.
 */
let remoteAudioEl: HTMLAudioElement | null = null;
function getRemoteAudioEl(): HTMLAudioElement {
  if (typeof document === "undefined") {
    throw new Error("remote audio requires DOM");
  }
  if (remoteAudioEl) return remoteAudioEl;
  const el = document.createElement("audio");
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  el.style.display = "none";
  el.setAttribute("data-neverr-softphone-remote", "1");
  document.body.appendChild(el);
  remoteAudioEl = el;
  return el;
}

/**
 * Attach the call's remote MediaStream to the persistent <audio>
 * element and .play() it. MUST be invoked from a user-gesture handler
 * (accept click or dial click) so Firefox / Safari autoplay policies
 * don't block. Safe to call more than once — sets srcObject each time.
 */
function attachRemoteAudio(call: Call): void {
  try {
    const el = getRemoteAudioEl();
    const stream = (call as any).getRemoteStream?.() as MediaStream | undefined;
    if (stream) el.srcObject = stream;
    const p = el.play();
    // Some browsers return a promise; swallow rejections rather than
    // logging (the SDK also retries internally).
    if (p && typeof (p as Promise<void>).catch === "function") {
      (p as Promise<void>).catch(() => {});
    }
  } catch {
    // getRemoteStream is available on Voice SDK v2 Call. If a future
    // SDK removes it we still don't want to crash — the SDK's
    // default routing will attempt to play in that case.
  }
}

/**
 * Feature-detect HTMLAudioElement.setSinkId. Firefox does not
 * implement this API, so calling Device.audio.speakerDevices.set()
 * would throw / no-op. We use this to (a) skip that call, (b) warn
 * on the Phone page.
 */
function detectOutputDeviceSelectionSupport(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const el = document.createElement("audio");
    return typeof (el as any).setSinkId === "function";
  } catch {
    return false;
  }
}

export function useTwilioDevice(opts: UseTwilioDeviceOptions): UseTwilioDeviceResult {
  const { enabled, onIncoming } = opts;
  const [status, setStatus] = useState<SoftphoneStatus>("idle");
  const [identity, setIdentity] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [active, setActive] = useState<Call | null>(null);
  const [callPhase, setCallPhase] = useState<CallPhase>("none");
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 3.4 — snapshot at mount; the value can't change over the
  // lifetime of a page.
  const outputDeviceSelectionSupported = detectOutputDeviceSelectionSupport();

  const deviceRef = useRef<Device | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disposedRef = useRef(false);

  const clearTimers = () => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  };

  const scheduleRefresh = useCallback((expiresAt: string) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const expiresMs = Date.parse(expiresAt);
    const delayMs = Math.max(30_000, expiresMs - Date.now() - REFRESH_LEAD_TIME_MS);
    refreshTimerRef.current = setTimeout(async () => {
      const dev = deviceRef.current;
      if (!dev || disposedRef.current) return;
      try {
        const fresh = await fetchToken();
        dev.updateToken(fresh.token);
        scheduleRefresh(fresh.expires_at);
      } catch (e) {
        setError(`token refresh failed: ${(e as Error).message}`);
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    disposedRef.current = false;

    (async () => {
      setStatus("requesting-permission");
      try {
        // Explicit permission prompt. Doing this BEFORE Device creation
        // gives us a clear error state to render if the user denies —
        // otherwise the SDK would surface a cryptic error later.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Immediately stop the tracks; Device will request its own
        // when a call connects. We only used getUserMedia here to
        // trigger the permission dialog.
        stream.getTracks().forEach((t) => t.stop());
      } catch (e) {
        setStatus("permission-denied");
        setError("Microphone permission denied. Enable in your browser to answer calls.");
        return;
      }
      if (disposedRef.current) return;

      setStatus("connecting");
      let payload: TokenPayload;
      try {
        payload = await fetchToken();
      } catch (e) {
        setStatus("error");
        setError(`Could not fetch voice token: ${(e as Error).message}`);
        return;
      }
      if (disposedRef.current) return;

      setIdentity(payload.identity);
      const device = new Device(payload.token, {
        logLevel: "error",
        // Codec preference: Opus first (better quality) then PCMU
        // fallback. Matches Twilio's docs for browser WebRTC.
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });
      deviceRef.current = device;

      device.on("registered", () => {
        setStatus("registered");
        setError(null);
        void postHeartbeat();
        if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = setInterval(postHeartbeat, HEARTBEAT_INTERVAL_MS);
      });
      device.on("unregistered", () => {
        setStatus("unregistered");
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
      });
      device.on("error", (err: any) => {
        setError(err?.message || "Device error");
        setStatus("error");
      });
      device.on("tokenWillExpire", async () => {
        try {
          const fresh = await fetchToken();
          device.updateToken(fresh.token);
          scheduleRefresh(fresh.expires_at);
        } catch (e) {
          setError(`token refresh failed: ${(e as Error).message}`);
        }
      });
      device.on("incoming", (call: Call) => {
        setIncoming(call);
        const params = call.customParameters;
        const topic = params.get("topic_name") || undefined;
        onIncoming?.({ from: call.parameters.From || "unknown", topicName: topic });
        // Phase 3.4 — attach remote MediaStream to our persistent
        // <audio> element as soon as the SDK emits 'accept'. This is
        // what fixes Firefox one-way audio: setSinkId is Chromium-only,
        // so the SDK's default output routing may not activate. Doing
        // srcObject + play() ourselves is cross-browser.
        call.on("accept", () => {
          attachRemoteAudio(call);
          // Phase 3.9 — inbound accept transitions phase to connected.
          setCallPhase("connected");
        });
        call.on("cancel", () => {
          setIncoming(null);
          setCallPhase("ended");
        });
        call.on("disconnect", () => {
          setIncoming(null);
          setActive(null);
          setCallPhase("ended");
        });
      });

      try {
        await device.register();
        scheduleRefresh(payload.expires_at);
      } catch (e) {
        setError(`register failed: ${(e as Error).message}`);
        setStatus("error");
      }
    })();

    return () => {
      disposedRef.current = true;
      clearTimers();
      const dev = deviceRef.current;
      if (dev) {
        try {
          dev.destroy();
        } catch {}
        deviceRef.current = null;
      }
    };
    // onIncoming is intentionally NOT in deps — a fresh reference on
    // every parent render would tear the Device down and re-register
    // (~2s reg latency, missed calls). Wrap in useCallback upstream if
    // stable identity matters; we accept a stale closure here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scheduleRefresh]);

  const accept = useCallback(() => {
    if (!incoming) return;
    // Phase 3.4 — pre-touch the persistent <audio> element FROM this
    // click handler so the user-gesture chain includes .play(). Some
    // browsers otherwise refuse to start audio playback later when
    // the SDK attaches the stream. attachRemoteAudio also runs from
    // the SDK's 'accept' event as a belt-and-braces second attempt.
    try {
      const el = getRemoteAudioEl();
      const p = el.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {});
      }
    } catch {}
    incoming.accept();
    setActive(incoming);
    setIncoming(null);
    setIsMuted(false);
    setCallPhase("connected");
  }, [incoming]);

  const reject = useCallback(() => {
    if (!incoming) return;
    incoming.reject();
    setIncoming(null);
  }, [incoming]);

  const hangup = useCallback(() => {
    if (active) {
      active.disconnect();
      setActive(null);
      setIsMuted(false);
    }
  }, [active]);

  const toggleMute = useCallback(() => {
    if (!active) return;
    const next = !isMuted;
    active.mute(next);
    setIsMuted(next);
  }, [active, isMuted]);

  const dial = useCallback(
    async (to: string, callerId: string): Promise<Call | null> => {
      const dev = deviceRef.current;
      if (!dev || status !== "registered") return null;
      // Phase 3.4 — same user-gesture pre-touch as accept(). The dial
      // click is a legitimate user gesture; call .play() on the
      // persistent <audio> from THIS callback so the browser's
      // autoplay policy authorises subsequent audio playback when the
      // remote stream arrives.
      try {
        const el = getRemoteAudioEl();
        const p = el.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {});
        }
      } catch {}
      const call = await dev.connect({
        params: { To: to, callerId },
      });
      setActive(call);
      setIsMuted(false);
      // Phase 3.9 — explicit lifecycle. Start in ringing on outbound
      // (Twilio's 'ringing' event may or may not fire depending on
      // carrier; we default to ringing at connect() time to guarantee
      // the UI reflects "not yet connected" state immediately). The
      // 'accept' event promotes to connected; disconnect ends.
      setCallPhase("ringing");
      call.on("ringing", () => setCallPhase("ringing"));
      call.on("accept", () => {
        attachRemoteAudio(call);
        setCallPhase("connected");
      });
      call.on("disconnect", () => {
        setActive(null);
        setIsMuted(false);
        setCallPhase("ended");
      });
      call.on("cancel", () => {
        setActive(null);
        setCallPhase("ended");
      });
      return call;
    },
    [status],
  );

  return {
    status,
    identity,
    incoming,
    active,
    callPhase,
    isMuted,
    error,
    outputDeviceSelectionSupported,
    accept,
    reject,
    hangup,
    toggleMute,
    dial,
  };
}
