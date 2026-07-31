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
import { PhoneOutgoing, PhoneIncoming, PhoneMissed } from "lucide-react";
// Phase 3.9 — reuse the phone-input helpers from the transfer-settings
// UI. Same parse/format contract; server-side re-normalizes so any
// gap here fails safely with a clear error rather than a doomed dial.
import { parsePhoneToE164, formatPhoneAsTyped, formatPhoneForDisplay } from "../lib/phone";

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

  // Phase 3.9 — parse the current input into E.164 iff possible.
  // Used both by the dial button (disabled until parseable) and the
  // inline error message. Only surface an error once the user has
  // typed enough that the input CAN'T be an in-progress phone —
  // 4+ digits — so a fresh input doesn't flash red.
  const parsedE164 = parsePhoneToE164(dialpadDigits);
  const digitCount = dialpadDigits.replace(/\D+/g, "").length;
  const inputError =
    digitCount >= 4 && !parsedE164
      ? digitCount < 10
        ? "Enter a 10-digit US phone number."
        : digitCount === 10 || (digitCount === 11 && dialpadDigits.replace(/\D+/g, "").startsWith("1"))
        ? "Couldn't parse that number."
        : "US phone numbers only for now (10 digits or +1)."
      : null;

  const dial = async () => {
    if (!parsedE164) return;
    const ok = await sp.callNumber(parsedE164);
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
              Calling from{" "}
              <span className="font-medium text-neutral-800">
                {formatPhoneForDisplay(sp.callerIdState.twilioNumber) || sp.callerIdState.twilioNumber}
              </span>
              {sp.callerIdState.sid ? (
                <span className="ml-2 text-neutral-400">({sp.callerIdState.sid})</span>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={dialpadDigits}
                onChange={(e) =>
                  // Phase 3.9 — format as-typed. formatPhoneAsTyped
                  // preserves ordering and the leading '+', so the
                  // caret placement is stable enough for most typing
                  // patterns. Users pasting a raw string also see the
                  // formatted result immediately.
                  setDialpadDigits(formatPhoneAsTyped(e.target.value))
                }
                placeholder="(443) 449-0863"
                className={`flex-1 rounded-md border px-3 py-2 text-sm ${
                  inputError ? "border-red-300 bg-red-50" : "border-neutral-300"
                }`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && parsedE164) void dial();
                }}
              />
              <button
                type="button"
                onClick={() => void dial()}
                disabled={sp.hasActiveCall || !parsedE164}
                className="inline-flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-green-700"
              >
                <PhoneIcon className="h-4 w-4" /> Call
              </button>
            </div>
            {inputError ? (
              <div className="mt-1 text-xs text-red-700">{inputError}</div>
            ) : parsedE164 ? (
              <div className="mt-1 text-xs text-neutral-500">
                Will dial <span className="font-mono">{parsedE164}</span>
              </div>
            ) : (
              <div className="mt-1 text-xs text-neutral-400">
                10-digit US number, or +1XXXXXXXXXX
              </div>
            )}
          </div>
        )}
      </section>

      <RecentInAppCallsPanel refreshKey={sp.hasActiveCall ? "active" : "idle"} />

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

interface RecentCall {
  id: string;
  twilio_call_sid: string | null;
  direction: string | null;
  caller_number: string | null;
  answered_via: string | null;
  status: string | null;
  call_outcome: string | null;
  duration_seconds: number | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string | null;
  // Phase 3.12 — staff disposition (nullable). Distinct from
  // call_outcome. Panel shows disposition when set + flags rows that
  // could have been dispositioned but weren't.
  disposition: string | null;
  dispositioned_at: string | null;
}

/**
 * Phase 3.8 — reads GET /api/voice/recent-calls (browser-only calls
 * for the current user's active business). Auto-refreshes when the
 * softphone transitions from active back to idle so a just-completed
 * call appears without a manual reload.
 */
function RecentInAppCallsPanel({ refreshKey }: { refreshKey: string }) {
  const [calls, setCalls] = useState<RecentCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/voice/recent-calls?limit=20", {
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { calls?: RecentCall[] };
      setCalls(data.calls ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-neutral-500" />
          <h2 className="text-sm font-semibold text-neutral-900">Recent in-app calls</h2>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs text-blue-600 hover:underline disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <div className="text-xs text-red-700 rounded-md bg-red-50 p-2">
          Couldn't load recent calls: {error}
        </div>
      ) : calls === null ? (
        <div className="text-xs text-neutral-500">Loading…</div>
      ) : calls.length === 0 ? (
        <div className="text-xs text-neutral-500">
          No calls yet. Answered inbound calls + calls you place from the dialpad above will
          appear here. See{" "}
          <Link className="text-blue-600 hover:underline" href="/calls">
            Calls &amp; Leads
          </Link>{" "}
          for the full transcript view.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {calls.map((c) => (
            <RecentCallRow key={c.id} call={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Phase 3.9 — outcome taxonomy rendering. Pre-3.9 every completed
 * call read as "answered" even when the row was actually a voicemail
 * (Twilio reports DialCallStatus=completed for voicemails). The new
 * mapDialOutcome enum + this display map keep the panel honest.
 *
 * Keep in sync with mapDialOutcome in routes/voice.ts. The API stores
 * the string form; a mapping bug here just shows the raw enum which
 * is grep-able.
 */
const OUTCOME_DISPLAY: Record<string, { label: string; tone: "answered" | "missed" | "neutral" }> = {
  answered_human: { label: "Answered", tone: "answered" },
  voicemail: { label: "Voicemail", tone: "missed" },
  no_answer: { label: "No answer", tone: "missed" },
  busy: { label: "Busy", tone: "missed" },
  failed: { label: "Failed", tone: "missed" },
  canceled: { label: "Canceled", tone: "neutral" },
  caller_hung_up_during_ring: { label: "You hung up", tone: "neutral" },
  // Pre-3.9 rows keep their existing values — don't hide them.
  answered: { label: "Answered", tone: "answered" },
  completed: { label: "Answered", tone: "answered" },
};

function displayOutcome(call: RecentCall): { label: string; tone: "answered" | "missed" | "neutral" } {
  const key = call.call_outcome || call.status || "";
  return (
    OUTCOME_DISPLAY[key] ||
    (key === "initiated"
      ? { label: "In progress", tone: "neutral" }
      : { label: key || "unknown", tone: "neutral" })
  );
}

/**
 * Phase 3.12 — human-readable disposition labels. Keep in sync with
 * the server's whitelist (CALL_DISPOSITIONS in routes/voice.ts).
 * Mismatch just falls through to the raw enum which is grep-able,
 * matching the OUTCOME_DISPLAY escape hatch.
 */
const DISPOSITION_DISPLAY: Record<string, { label: string; tone: "answered" | "missed" | "neutral" }> = {
  reached_person: { label: "Reached person", tone: "answered" },
  voicemail_left_message: { label: "Voicemail — left message", tone: "missed" },
  voicemail_no_message: { label: "Voicemail — no message", tone: "missed" },
  wrong_number: { label: "Wrong number", tone: "missed" },
  no_answer_bad_line: { label: "No answer / bad line", tone: "missed" },
};

/**
 * Phase 3.12 — is this a call we WOULD have shown the disposition
 * modal for (i.e., it connected and is outbound)? Used to render an
 * "Not dispositioned" hint on undispositioned rows that COULD have
 * been dispositioned — distinct from calls that never connected
 * (no_answer / busy / failed / caller_hung_up_during_ring), which
 * have accurate inferred outcomes and don't need staff input.
 */
function isDispositionableRow(call: RecentCall): boolean {
  if (call.direction !== "outbound") return false;
  const inferred = call.call_outcome || call.status || "";
  return inferred === "answered_human" || inferred === "answered" || inferred === "completed" || inferred === "voicemail";
}

function RecentCallRow({ call }: { call: RecentCall }) {
  const outbound = call.direction === "outbound";
  const inferred = displayOutcome(call);
  // Phase 3.12 — disposition wins over inferred outcome for display.
  // We render BOTH pieces of info so a viewer can see disagreement
  // (e.g. Twilio said 'voicemail' but staff dispositioned
  // 'reached_person' — that difference is the signal).
  const dispositionMeta = call.disposition ? DISPOSITION_DISPLAY[call.disposition] : null;
  const tone = dispositionMeta?.tone ?? inferred.tone;
  const Icon = outbound
    ? PhoneOutgoing
    : tone === "answered"
    ? PhoneIncoming
    : PhoneMissed;
  const iconColor = outbound
    ? "text-blue-600"
    : tone === "answered"
    ? "text-emerald-600"
    : tone === "missed"
    ? "text-red-500"
    : "text-neutral-400";
  const when = call.created_at
    ? new Date(call.created_at).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "";
  const duration =
    typeof call.duration_seconds === "number" && call.duration_seconds > 0
      ? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, "0")}`
      : null;
  const undispositioned = isDispositionableRow(call) && !call.disposition;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <Icon className={`h-4 w-4 shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-neutral-900 truncate">
          {formatPhoneForDisplay(call.caller_number) || call.caller_number || "(unknown)"}
        </div>
        <div className="text-xs text-neutral-500 flex flex-wrap items-center gap-x-1.5">
          <span>{outbound ? "Outbound" : "Inbound"}</span>
          <span>·</span>
          {dispositionMeta ? (
            // Disposition is the primary display when set.
            <>
              <span className="font-medium text-neutral-700">{dispositionMeta.label}</span>
              {dispositionMeta.label !== inferred.label ? (
                <span className="text-neutral-400">(Twilio: {inferred.label})</span>
              ) : null}
            </>
          ) : (
            <>
              <span>{inferred.label}</span>
              {undispositioned ? (
                <span className="rounded-full bg-amber-50 text-amber-800 text-[10px] font-medium px-1.5 py-0.5 border border-amber-200">
                  Not dispositioned
                </span>
              ) : null}
            </>
          )}
          {duration ? (
            <>
              <span>·</span>
              <span>{duration}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="text-xs text-neutral-400 shrink-0">{when}</div>
    </li>
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
