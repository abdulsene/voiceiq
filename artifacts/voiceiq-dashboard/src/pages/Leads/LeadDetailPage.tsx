/**
 * Lead detail — Slice 2A adds verified-callback accountability on top of
 * the Slice 1 read-only foundation.
 *
 * What this page renders:
 *   1. Header card with the "Call customer" button. Click → confirm
 *      modal → POST /api/business/leads/:id/call → live status overlay
 *      that polls /calls/:sid/status every 2s until terminal (completed
 *      | failed | canceled). Stop polling on terminal state per spec.
 *   2. Banner when the user has NO callback ring number saved — points
 *      to /settings/callback.
 *   3. Lead Info (unchanged from Slice 1).
 *   4. Activity timeline with rich rendering for call_initiated +
 *      call_completed + call_failed entries. The call_completed entry
 *      shows the audio player + summary inline (NO extra click required
 *      per spec) and a transcript modal trigger.
 *
 * Recording playback uses the proxy endpoint
 * GET /api/business/leads/:id/call-recording/:sid which fetches Twilio's
 * basic-auth URL server-side. The browser receives MP3 bytes; we wrap
 * the fetch with the user's JWT (via fetchApi) and build a blob URL for
 * the <audio> element. Blob URL is revoked on unmount.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CornerDownRight,
  Cog,
  FileText,
  Headphones,
  Loader2,
  Mail,
  MessageSquare,
  Phone as PhoneIcon,
  PhoneCall,
  PhoneOff,
  PhoneOutgoing,
  User,
  X,
  XCircle,
} from "lucide-react";

import { fetchApi, getAuthHeaders } from "@/lib/api";
import { formatPhoneForDisplay } from "@/lib/phone";

type Lead = {
  id: string;
  business_id: string;
  source: string;
  source_call_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  preferred_channel: string | null;
  reason: string;
  urgency: string;
  status: string;
  assigned_to: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  dismissed_reason: string | null;
  created_at: string;
  updated_at: string;
};

type Activity = {
  id: string;
  lead_id: string;
  actor_id: string | null;
  actor_type: "ai" | "staff" | "system" | string;
  action: string;
  metadata: any;
  note: string | null;
  created_at: string;
};

type DetailResponse = {
  lead: Lead;
  activities: Activity[];
};

type LeadCallStatus = {
  id: string;
  call_sid: string | null;
  status: string;
  customer_answered: boolean | null;
  end_reason: string | null;
  duration_secs: number | null;
  started_at: string | null;
  ended_at: string | null;
  transcription_status: string;
  summary_text: string | null;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

function urgencyStyle(urgency: string): { pill: string; dot: string } {
  switch (urgency) {
    case "emergency":
      return { pill: "bg-red-50 text-red-700 border-red-200", dot: "bg-red-500" };
    case "high":
      return { pill: "bg-amber-50 text-amber-700 border-amber-200", dot: "bg-amber-500" };
    case "low":
      return { pill: "bg-gray-50 text-gray-500 border-gray-200", dot: "bg-gray-400" };
    case "medium":
    default:
      return { pill: "bg-slate-50 text-slate-600 border-slate-200", dot: "bg-slate-400" };
  }
}

function statusStyle(status: string): string {
  switch (status) {
    case "new":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "claimed":
      return "bg-indigo-50 text-indigo-700 border-indigo-200";
    case "in_progress":
      return "bg-yellow-50 text-yellow-800 border-yellow-200";
    case "resolved":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "dismissed":
      return "bg-gray-100 text-gray-500 border-gray-200";
    default:
      return "bg-gray-50 text-gray-600 border-gray-200";
  }
}

function channelIcon(channel: string | null) {
  switch (channel) {
    case "text":
      return MessageSquare;
    case "call":
      return PhoneIcon;
    case "email":
      return Mail;
    case "voice_callback":
      return PhoneCall;
    default:
      return MessageSquare;
  }
}

function ActorBadge({ actor_type, t }: { actor_type: string; t: (k: string) => string }) {
  if (actor_type === "ai") {
    return (
      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shrink-0" aria-label={t("leads.activity.actor.ai")}>
        <Bot className="h-4 w-4 text-white" />
      </div>
    );
  }
  if (actor_type === "system") {
    return (
      <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center shrink-0" aria-label={t("leads.activity.actor.system")}>
        <Cog className="h-4 w-4 text-gray-500" />
      </div>
    );
  }
  return (
    <div className="h-8 w-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0" aria-label={t("leads.activity.actor.staff")}>
      <User className="h-4 w-4 text-emerald-700" />
    </div>
  );
}

function ActionIcon({ action }: { action: string }) {
  switch (action) {
    case "captured":
      return <CornerDownRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
    case "call_initiated":
      return <PhoneOutgoing className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    case "call_completed":
      return <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
    case "call_failed":
      return <PhoneOff className="h-3.5 w-3.5 text-red-500" aria-hidden="true" />;
    case "resolved":
      return <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />;
    case "dismissed":
      return <XCircle className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
    case "sms_sent":
      return <MessageSquare className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    case "email_sent":
      return <Mail className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />;
    default:
      return <CornerDownRight className="h-3.5 w-3.5 text-gray-400" aria-hidden="true" />;
  }
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// Authed audio player: fetches the recording from our proxy endpoint with
// the user's JWT, builds a blob URL, and feeds it to <audio>. We revoke
// the blob URL on unmount so the browser frees the buffer.
function AuthedAudioPlayer({
  apiBase,
  leadId,
  recordingSid,
}: {
  apiBase: string;
  leadId: string;
  recordingSid: string;
}) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (blobUrl || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/${apiBase}/leads/${leadId}/call-recording/${recordingSid}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);
    } catch (e: any) {
      setError(e?.message || "Could not load recording");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [blobUrl]);

  if (!blobUrl && !loading) {
    return (
      <button
        type="button"
        onClick={load}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2E75B6] hover:underline"
      >
        <Headphones className="h-3.5 w-3.5" />
        {t("leads.call.activity.loadRecording")}
      </button>
    );
  }
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("leads.call.activity.loadingRecording")}
      </span>
    );
  }
  if (error) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-600">
        <AlertTriangle className="h-3.5 w-3.5" />
        {error}
      </span>
    );
  }
  return (
    <audio
      controls
      src={blobUrl || undefined}
      className="w-full max-w-md mt-1"
      preload="auto"
    />
  );
}

// Transcript modal — full-screen on mobile, centered on desktop.
function TranscriptModal({
  transcript,
  onClose,
}: {
  transcript: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-2xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">{t("leads.call.transcriptModal.title")}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md hover:bg-gray-100 text-gray-500"
            aria-label={t("leads.call.transcriptModal.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="flex-1 overflow-auto p-4 text-sm text-gray-800 whitespace-pre-wrap font-sans leading-relaxed">
{transcript || t("leads.call.transcriptModal.empty")}
        </pre>
      </div>
    </div>
  );
}

// Confirm-then-call modal.
function CallCustomerModal({
  customerName,
  customerPhone,
  ringNumber,
  saving,
  serverError,
  onCancel,
  onConfirm,
}: {
  customerName: string;
  customerPhone: string;
  ringNumber: string;
  saving: boolean;
  serverError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-[#2E75B6]/10 flex items-center justify-center">
            <PhoneCall className="h-5 w-5 text-[#2E75B6]" />
          </div>
          <h2 className="text-lg font-semibold text-gray-900">{t("leads.call.modal.title")}</h2>
        </div>
        <p className="text-sm text-gray-600 leading-relaxed">
          {t("leads.call.modal.description", { customerName })}
        </p>
        <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">{t("leads.call.modal.ringNumberLabel")}</span>
            <span className="font-mono text-gray-900">{formatPhoneForDisplay(ringNumber) || ringNumber}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">{t("leads.call.modal.customerLabel")}</span>
            <span className="font-mono text-gray-900">{formatPhoneForDisplay(customerPhone) || customerPhone}</span>
          </div>
        </div>
        <p className="text-xs text-gray-500">{t("leads.call.modal.disclosureNote")}</p>
        {serverError && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 flex items-start gap-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{serverError}</span>
          </div>
        )}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 disabled:opacity-50"
          >
            {t("leads.call.modal.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="px-4 py-2 text-sm font-semibold bg-[#2E75B6] text-white rounded-lg hover:bg-[#2563a0] disabled:opacity-50"
          >
            {saving ? t("leads.call.modal.connecting") : t("leads.call.modal.callNow")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Live status banner — shows during a call in progress. Polls every 2s
// until terminal status. Renders below the header card.
function CallLiveStatus({
  apiBase,
  leadId,
  callSid,
  onTerminal,
}: {
  apiBase: string;
  leadId: string;
  callSid: string;
  onTerminal: () => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LeadCallStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const terminalRef = useRef(false);

  useEffect(() => {
    let active = true;
    terminalRef.current = false;
    async function tick() {
      if (!active || terminalRef.current) return;
      try {
        const data = (await fetchApi(`/${apiBase}/leads/${leadId}/calls/${callSid}/status`)) as LeadCallStatus;
        if (!active) return;
        setStatus(data);
        setPollError(null);
        if (TERMINAL_STATUSES.has(data.status)) {
          terminalRef.current = true;
          // Notify the parent so it can refresh the lead detail (which
          // will reveal the new call_completed activity row).
          onTerminal();
        }
      } catch (e: any) {
        if (!active) return;
        setPollError(e?.message || "Status check failed");
      }
    }
    void tick();
    const interval = setInterval(tick, 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [apiBase, leadId, callSid, onTerminal]);

  if (!status && !pollError) {
    return (
      <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 flex items-center gap-2 text-sm text-blue-800">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("leads.call.live.starting")}</span>
      </div>
    );
  }
  if (pollError && !status) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-2 text-sm text-amber-800">
        <AlertTriangle className="h-4 w-4" />
        <span>{pollError}</span>
      </div>
    );
  }
  const s = status!;
  let label = t("leads.call.live.starting");
  let icon = <Loader2 className="h-4 w-4 animate-spin" />;
  let cls = "border-blue-200 bg-blue-50 text-blue-800";
  if (s.status === "initiated" || s.status === "ringing") {
    label = t("leads.call.live.ringing");
  } else if (s.status === "in_progress") {
    label = t("leads.call.live.connected");
    cls = "border-emerald-200 bg-emerald-50 text-emerald-800";
    icon = <PhoneCall className="h-4 w-4" />;
  } else if (s.status === "completed") {
    label = t("leads.call.live.ended", { duration: formatDuration(s.duration_secs) });
    cls = "border-gray-200 bg-gray-50 text-gray-700";
    icon = <Check className="h-4 w-4 text-emerald-600" />;
  } else if (s.status === "failed" || s.status === "canceled") {
    label = t(`leads.call.live.failed.${s.end_reason || "unknown"}`, { defaultValue: t("leads.call.live.failed.unknown") });
    cls = "border-red-200 bg-red-50 text-red-700";
    icon = <PhoneOff className="h-4 w-4" />;
  }
  return (
    <div className={`rounded-xl border px-4 py-3 flex items-center gap-2 text-sm ${cls}`} role="status" aria-live="polite">
      {icon}
      <span>{label}</span>
    </div>
  );
}

// Rich call_completed timeline entry. Renders header line + stats +
// summary inline + audio player + transcript modal trigger. Per spec,
// everything visible at first glance — no extra clicks.
function CallCompletedEntry({
  apiBase,
  leadId,
  activity,
  callRow,
  t,
}: {
  apiBase: string;
  leadId: string;
  activity: Activity;
  callRow: LeadCallStatus | null;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [showTranscript, setShowTranscript] = useState(false);
  const [fullRow, setFullRow] = useState<(LeadCallStatus & { recording_sid?: string | null; transcript_text?: string | null }) | null>(null);

  // Pull the full row (recording_sid + transcript text) lazily; the
  // /leads/:id endpoint returns activities with metadata but not the
  // lead_calls row inline. We fetch via the status endpoint which
  // returns the rich fields. Trigger on mount once.
  useEffect(() => {
    let cancelled = false;
    const callSid = (activity.metadata?.call_sid || callRow?.call_sid) as string | undefined;
    if (!callSid) return;
    (async () => {
      try {
        // The status endpoint returns transcription_status + summary_text
        // but NOT transcript_text or recording_sid. To keep Slice 2A's
        // backend surface small, we deref the lead_call_id from
        // activity.metadata and call a path that exists today: the same
        // status endpoint, joined with a fresh /leads/:id fetch by the
        // caller, gives us summary; recording playback uses recording_sid
        // which we ALSO need. We extend the status response below in
        // routes/lead-calls.ts to include recording_sid + transcript_text;
        // for v1 here we trust the metadata blob.
        const data = (await fetchApi(`/${apiBase}/leads/${leadId}/calls/${callSid}/status`)) as LeadCallStatus & { recording_sid?: string | null; transcript_text?: string | null };
        if (!cancelled) setFullRow(data);
      } catch {
        // best-effort; UI degrades to "no recording yet" view
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase, leadId, activity, callRow]);

  const metadata = activity.metadata || {};
  const duration = (fullRow?.duration_secs ?? metadata.recording_duration_secs ?? null) as number | null;
  const summary = fullRow?.summary_text ?? null;
  const transcript = fullRow?.transcript_text ?? null;
  const recordingSid = fullRow?.recording_sid ?? null;
  const transcriptionStatus = fullRow?.transcription_status ?? "pending";

  return (
    <div className="space-y-2">
      <div className="text-xs text-gray-600">
        {t("leads.call.activity.completedDescription")}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600">
        <span className="inline-flex items-center gap-1">
          <Loader2 className="h-3 w-3 text-transparent" aria-hidden="true" />
          <strong className="text-gray-900">{t("leads.call.activity.durationLabel")}</strong>
          <span>{formatDuration(duration)}</span>
        </span>
      </div>
      {summary && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-800 leading-relaxed">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 mb-1">{t("leads.call.activity.summaryLabel")}</p>
          <p>{summary}</p>
        </div>
      )}
      {!summary && transcriptionStatus === "pending" && (
        <div className="text-xs text-gray-500 inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("leads.call.activity.transcribing")}
        </div>
      )}
      {!summary && transcriptionStatus === "failed" && (
        <div className="text-xs text-amber-700 inline-flex items-center gap-1.5">
          <AlertTriangle className="h-3 w-3" />
          {t("leads.call.activity.transcriptionFailed")}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        {recordingSid && (
          <AuthedAudioPlayer apiBase={apiBase} leadId={leadId} recordingSid={recordingSid} />
        )}
        {transcript && (
          <button
            type="button"
            onClick={() => setShowTranscript(true)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2E75B6] hover:underline"
          >
            <FileText className="h-3.5 w-3.5" />
            {t("leads.call.activity.viewTranscript")}
          </button>
        )}
      </div>
      {showTranscript && transcript && (
        <TranscriptModal transcript={transcript} onClose={() => setShowTranscript(false)} />
      )}
    </div>
  );
}

export default function LeadDetailPage() {
  const apiBase = "business";
  const { t } = useTranslation();
  const [, params] = useRoute<{ id: string }>("/leads/:id");
  const leadId = params?.id || "";

  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ringPreference, setRingPreference] = useState<string | null>(null);
  const [ringPrefLoaded, setRingPrefLoaded] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [callSaving, setCallSaving] = useState(false);
  const [callServerError, setCallServerError] = useState<string | null>(null);
  const [activeCallSid, setActiveCallSid] = useState<string | null>(null);

  // Reloads the detail data; called after a call enters a terminal state
  // so the new call_completed activity row appears.
  async function refreshDetail() {
    try {
      const r = (await fetchApi(`/${apiBase}/leads/${leadId}`)) as DetailResponse;
      setData(r);
    } catch (e: any) {
      console.warn("[LeadDetailPage] refresh failed:", e?.message || e);
    }
  }

  useEffect(() => {
    if (!leadId) {
      setLoadError("No lead specified");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = (await fetchApi(`/${apiBase}/leads/${leadId}`)) as DetailResponse;
        if (cancelled) return;
        setData(r);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message || "Failed to load lead");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leadId]);

  // Load the user's saved ring number on mount so we can pre-fill the
  // modal AND decide whether to show the "set your number first" banner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await fetchApi(`/business/me/callback-preference`)) as { callback_ring_number: string | null };
        if (!cancelled) setRingPreference(r.callback_ring_number);
      } catch {
        // Treat as unset on error; the banner will surface it.
      } finally {
        if (!cancelled) setRingPrefLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Map lead_call rows from activity metadata for the call_completed
  // rendering — index by call_sid for quick lookup.
  const callRowsByActivity = useMemo(() => {
    const map: Record<string, LeadCallStatus | null> = {};
    if (!data) return map;
    for (const a of data.activities) {
      if (a.action === "call_completed" && a.metadata?.lead_call_id) {
        map[a.id] = null; // populated lazily by CallCompletedEntry
      }
    }
    return map;
  }, [data]);

  async function handleConfirmCall() {
    if (!ringPreference || !data) return;
    setCallSaving(true);
    setCallServerError(null);
    try {
      const r = await fetch(`/api/${apiBase}/leads/${leadId}/call`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await r.json().catch(() => ({}))) as { success?: boolean; call_sid?: string; error?: string };
      if (!r.ok) {
        setCallServerError(body.error || `HTTP ${r.status}`);
        return;
      }
      if (body.call_sid) {
        setActiveCallSid(body.call_sid);
        setModalOpen(false);
        // Refresh detail so the new call_initiated activity row appears.
        await refreshDetail();
      } else {
        setCallServerError("Unexpected response");
      }
    } catch (e: any) {
      setCallServerError(e?.message || "Network error");
    } finally {
      setCallSaving(false);
    }
  }

  function handleClickCall() {
    setCallServerError(null);
    if (!ringPreference) {
      // No saved ring number → don't open the call modal; the banner
      // already prompts the user to set one.
      return;
    }
    setModalOpen(true);
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <div className="h-6 w-32 rounded bg-gray-100 animate-pulse" />
        <div className="h-40 rounded-2xl bg-gray-100 animate-pulse" />
        <div className="h-60 rounded-2xl bg-gray-100 animate-pulse" />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-4">
        <Link href="/leads" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("leads.detail.backToList")}
        </Link>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError || t("leads.detail.notFound")}</span>
        </div>
      </div>
    );
  }

  const { lead, activities } = data;
  const u = urgencyStyle(lead.urgency);
  const ChannelIcon = channelIcon(lead.preferred_channel);
  const canCall = !!lead.contact_phone;
  const showRingBanner = ringPrefLoaded && !ringPreference && canCall;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-6 pb-12">
      <div>
        <Link href="/leads" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("leads.detail.backToList")}
        </Link>
      </div>

      {/* Header card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
        <div className="flex items-start gap-4">
          <div className="relative shrink-0">
            <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center">
              <ChannelIcon className="h-6 w-6 text-gray-500" />
            </div>
            <span
              className={`absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${u.dot}`}
              aria-label={t(`leads.urgency.${lead.urgency}`)}
            />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl md:text-2xl font-bold text-gray-900 leading-tight">
              {lead.contact_name || t("leads.unknownCaller")}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              {lead.contact_phone && (
                <a
                  href={`tel:${lead.contact_phone}`}
                  className="inline-flex items-center gap-1 text-[#2E75B6] hover:underline font-mono"
                >
                  <PhoneOutgoing className="h-3.5 w-3.5" />
                  {lead.contact_phone}
                </a>
              )}
              {lead.contact_email && (
                <a
                  href={`mailto:${lead.contact_email}`}
                  className="inline-flex items-center gap-1 text-[#2E75B6] hover:underline truncate"
                >
                  <Mail className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{lead.contact_email}</span>
                </a>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {t("leads.detail.capturedAt", { when: formatTimestamp(lead.created_at) })}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-1.5 shrink-0">
            <span className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border ${u.pill}`}>
              {t(`leads.urgency.${lead.urgency}`)}
            </span>
            <span className={`inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-full border ${statusStyle(lead.status)}`}>
              {t(`leads.status.${lead.status}`)}
            </span>
          </div>
        </div>

        {/* Call customer action */}
        {canCall && (
          <div className="mt-5 pt-5 border-t border-gray-100">
            <button
              type="button"
              onClick={handleClickCall}
              disabled={!ringPreference || !!activeCallSid}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <PhoneCall className="h-4 w-4" />
              {t("leads.call.button.callCustomer")}
            </button>
            {ringPreference && (
              <p className="mt-2 text-xs text-gray-500">
                {t("leads.call.button.willRing", { number: formatPhoneForDisplay(ringPreference) || ringPreference })}
              </p>
            )}
          </div>
        )}
      </div>

      {showRingBanner && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-2 text-sm text-amber-900">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">{t("leads.call.ringBanner.title")}</p>
            <p className="text-xs mt-0.5">{t("leads.call.ringBanner.hint")}</p>
          </div>
          <Link
            href="/settings/callback"
            className="shrink-0 text-xs font-semibold text-amber-900 hover:underline whitespace-nowrap"
          >
            {t("leads.call.ringBanner.cta")} →
          </Link>
        </div>
      )}

      {activeCallSid && (
        <CallLiveStatus
          apiBase={apiBase}
          leadId={leadId}
          callSid={activeCallSid}
          onTerminal={() => {
            void refreshDetail();
          }}
        />
      )}

      {/* Lead info */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 space-y-4">
        <h2 className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
          {t("leads.detail.leadInfo")}
        </h2>
        <div>
          <p className="text-xs text-gray-500 uppercase font-medium tracking-wide">
            {t("leads.detail.reason")}
          </p>
          <p className="text-sm text-gray-900 mt-1 leading-relaxed whitespace-pre-wrap">{lead.reason}</p>
        </div>
        {lead.preferred_channel && (
          <div>
            <p className="text-xs text-gray-500 uppercase font-medium tracking-wide">
              {t("leads.detail.preferredChannel")}
            </p>
            <p className="text-sm text-gray-900 mt-1">
              {t(`leads.preferredChannelExplain.${lead.preferred_channel}`)}
            </p>
          </div>
        )}
      </div>

      {/* Activity timeline */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
        <h2 className="text-sm font-semibold tracking-wide text-gray-600 uppercase mb-4">
          {t("leads.detail.activity")}
        </h2>
        <ol className="space-y-5">
          {activities.map((a) => (
            <li key={a.id} className="flex items-start gap-3">
              <ActorBadge actor_type={a.actor_type} t={t} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 text-sm text-gray-900">
                  <ActionIcon action={a.action} />
                  <span className="font-medium">{t(`leads.activity.action.${a.action}`)}</span>
                  <span className="text-gray-400">·</span>
                  <span className="text-xs text-gray-500">{formatTimestamp(a.created_at)}</span>
                </div>

                {/* Rich rendering for the 'captured' seed entry — Slice 1 */}
                {a.action === "captured" && (
                  <div className="mt-1.5 text-xs text-gray-600 space-y-1">
                    <p>{t("leads.activity.capturedDescription")}</p>
                    {(() => {
                      const md = (a.metadata || {}) as { conversation_id?: string; source_call_id?: string };
                      if (md.source_call_id) {
                        return (
                          <p>
                            {t("leads.activity.linkedCallPrefix")}{" "}
                            <Link
                              href={`/calls/${md.source_call_id}`}
                              className="text-[#2E75B6] hover:underline font-medium"
                            >
                              {t("leads.activity.viewSourceCall")}
                            </Link>
                          </p>
                        );
                      }
                      if (md.conversation_id) {
                        return (
                          <p className="text-gray-500">
                            {t("leads.activity.conversationRef")}{" "}
                            <span className="font-mono text-[11px] bg-gray-100 px-1.5 py-0.5 rounded">{md.conversation_id}</span>
                          </p>
                        );
                      }
                      return null;
                    })()}
                  </div>
                )}

                {/* Slice 2A — call_initiated rendering */}
                {a.action === "call_initiated" && (
                  <p className="mt-1 text-xs text-gray-600">
                    {t("leads.call.activity.initiated", {
                      ring: formatPhoneForDisplay(a.metadata?.ring_number || "") || a.metadata?.ring_number || "your number",
                      customer: formatPhoneForDisplay(a.metadata?.customer_phone || "") || a.metadata?.customer_phone || "the customer",
                    })}
                  </p>
                )}

                {/* Slice 2A — call_completed rich rendering (per spec: no
                    extra clicks; everything visible at first glance) */}
                {a.action === "call_completed" && (
                  <div className="mt-2">
                    <CallCompletedEntry
                      apiBase={apiBase}
                      leadId={leadId}
                      activity={a}
                      callRow={callRowsByActivity[a.id] || null}
                      t={t}
                    />
                  </div>
                )}

                {/* Slice 2A — call_failed rendering */}
                {a.action === "call_failed" && (
                  <p className="mt-1 text-xs text-gray-600">
                    {t(`leads.call.activity.failed.${a.metadata?.end_reason || "unknown"}`, {
                      defaultValue: t("leads.call.activity.failed.unknown"),
                    })}
                  </p>
                )}

                {a.note && (
                  <p className="mt-1.5 text-xs text-gray-700 leading-relaxed bg-gray-50 border border-gray-100 rounded-md p-2">{a.note}</p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Footer: actions other than call still coming */}
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-500 text-center">
        {t("leads.detail.moreActionsComingSoon")}
      </div>

      {modalOpen && data && ringPreference && (
        <CallCustomerModal
          customerName={data.lead.contact_name || t("leads.unknownCaller")}
          customerPhone={data.lead.contact_phone || ""}
          ringNumber={ringPreference}
          saving={callSaving}
          serverError={callServerError}
          onCancel={() => setModalOpen(false)}
          onConfirm={() => { void handleConfirmCall(); }}
        />
      )}
    </div>
  );
}
