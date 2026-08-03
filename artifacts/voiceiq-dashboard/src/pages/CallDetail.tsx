/**
 * Phase 4.4 — canonical call detail page.
 *
 * Routed at /calls/:callId (calls.id UUID). This is the ONLY place
 * in the app that renders full call state. Every list surface
 * navigates here — no more modals, no more per-page rendering
 * divergence.
 *
 * Design principles from the phase brief:
 *
 *   1. Field order is stable across directions. Inbound-only fields
 *      (handoff_reason, transfer_status, rung_user_ids, topic_slug,
 *      answered_via) render as "n/a" on outbound rather than being
 *      omitted. Predictable order matters more than compactness.
 *
 *   2. Disposition (staff-entered) is the PRIMARY outcome line when
 *      set, with the Twilio-inferred value in parens when they
 *      disagree. Same DISPOSITION_DISPLAY reused via lib/call-
 *      display.ts.
 *
 *   3. When analysis_skipped_reason IS NOT NULL the analysis block
 *      renders an explicit "Too short to analyze" / "No transcript"
 *      state. Never blanks, never zeros. Per Phase 4.6, 32/45 real
 *      prod rows are in this state — if it looked like a bug the
 *      page would read as broken.
 *
 *   4. Recording block: nothing rendered. No "coming soon" placeholder
 *      (per brief). Arrives when Phase 4.2 Item 2 lands.
 *
 *   5. Dead fields (cultural_profile / was_coached /
 *      coaching_session_id / competitor_mentioned) are NOT rendered.
 *      Reviving requires a live ingest path.
 *
 *   6. "Other party" replaces "Caller" as the label for
 *      caller_number — on outbound softphone calls the caller is
 *      the staff member, so the old label was misleading.
 */

import { useEffect, useState } from "react";
import { useRoute, useLocation } from "wouter";
import {
  Loader2,
  AlertTriangle,
  ArrowLeft,
  PhoneOutgoing,
  PhoneIncoming,
  Sparkles,
  AlertCircle,
  MessageSquare,
  FileText,
} from "lucide-react";
import { getAuthHeaders } from "../lib/api";
import {
  DISPOSITION_DISPLAY,
  displayOutcome,
  SKIP_REASON_DISPLAY,
  otherPartyLabel,
  type OutcomeTone,
} from "../lib/call-display";

interface CallDetail {
  id: string;
  business_id: string;
  call_sid: string | null;
  twilio_call_sid: string | null;
  direction: "inbound" | "outbound" | string | null;
  caller_number: string | null;
  caller_name: string | null;
  created_at: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_seconds: number | null;
  status: string | null;
  call_outcome: string | null;
  disposition: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  topic_slug: string | null;
  handoff_reason: string | null;
  transfer_status: string | null;
  handled_by_user_id: string | null;
  handled_at: string | null;
  answered_via: string | null;
  answered_by: string | null;
  rung_user_ids: string[] | null;
  transcript: string | null;
  summary: string | null;
  caller_intent: string | null;
  sentiment: string | null;
  sentiment_score: number | null;
  dominant_emotion: string | null;
  emotion_journey: Array<{ turn: number; emotion: string }> | null;
  urgency: string | null;
  satisfaction_inferred: number | null;
  analyzed_at: string | null;
  analysis_skipped_reason: string | null;
  follow_up_required: boolean | null;
  lead_data: unknown;
}

type PageState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ok"; call: CallDetail };

export default function CallDetailPage() {
  const [, params] = useRoute<{ callId: string }>("/calls/:callId");
  const [, navigate] = useLocation();
  const callId = params?.callId || "";
  const [state, setState] = useState<PageState>({ kind: "loading" });

  useEffect(() => {
    if (!callId) {
      setState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/calls/${encodeURIComponent(callId)}`, {
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        });
        if (cancelled) return;
        if (res.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: `HTTP ${res.status}` });
          return;
        }
        const body = (await res.json()) as { call?: CallDetail };
        if (!body.call) {
          setState({ kind: "not_found" });
          return;
        }
        setState({ kind: "ok", call: body.call });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <button
        type="button"
        onClick={() => history.length > 1 ? history.back() : navigate("/calls")}
        className="mb-4 inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      {state.kind === "loading" ? (
        <LoadingCard />
      ) : state.kind === "not_found" ? (
        <NotFoundCard />
      ) : state.kind === "error" ? (
        <ErrorCard message={state.message} onRetry={() => setState({ kind: "loading" })} />
      ) : (
        <DetailBody call={state.call} />
      )}
    </div>
  );
}

function LoadingCard() {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
      <Loader2 className="w-8 h-8 text-slate-400 animate-spin mx-auto mb-2" />
      <p className="text-sm text-slate-500">Loading call…</p>
    </div>
  );
}

function NotFoundCard() {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
      <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
      <h1 className="text-lg font-bold text-slate-900 mb-1">Call not found</h1>
      <p className="text-sm text-slate-500">
        This call doesn't exist or belongs to a different business.
      </p>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
      <AlertTriangle className="w-10 h-10 text-red-500 mx-auto mb-3" />
      <h1 className="text-lg font-bold text-slate-900 mb-1">Couldn't load call</h1>
      <p className="text-sm text-slate-500 mb-4">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-semibold hover:bg-slate-700"
      >
        Try again
      </button>
    </div>
  );
}

function DetailBody({ call }: { call: CallDetail }) {
  const outbound = call.direction === "outbound";
  const DirIcon = outbound ? PhoneOutgoing : PhoneIncoming;
  const inferred = displayOutcome(call);
  const dispositionMeta = call.disposition ? DISPOSITION_DISPLAY[call.disposition] : null;

  const when = call.created_at
    ? new Date(call.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "—";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-start gap-3">
          <div className={`rounded-full p-2 ${outbound ? "bg-blue-50" : "bg-emerald-50"}`}>
            <DirIcon className={`w-5 h-5 ${outbound ? "text-blue-600" : "text-emerald-600"}`} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-slate-900">
              {call.caller_name || "(unknown)"}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {call.caller_number || "no number"} · {formatDuration(call.duration_seconds)} · {when}
            </p>
          </div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500 border border-slate-200 rounded-full px-2 py-0.5">
            {outbound ? "Outbound" : "Inbound"}
          </span>
        </div>
      </div>

      {/* Outcome block — disposition primary when set, inferred fallback */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <SectionHeader>Outcome</SectionHeader>
        {dispositionMeta ? (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2">
              <span className={`text-base font-semibold ${toneToText(dispositionMeta.tone)}`}>
                {dispositionMeta.label}
              </span>
              {dispositionMeta.label !== inferred.label ? (
                <span className="text-xs text-slate-500">(Twilio: {inferred.label})</span>
              ) : null}
            </div>
            <p className="text-[11px] text-slate-500">Dispositioned by staff</p>
          </div>
        ) : (
          <div>
            <span className={`text-base font-semibold ${toneToText(inferred.tone)}`}>
              {inferred.label}
            </span>
            <p className="text-[11px] text-slate-500 mt-0.5">Twilio-inferred</p>
          </div>
        )}
      </div>

      {/* Identity + attribution grid. Inbound-only fields render "n/a"
          on outbound so field order stays stable across directions. */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <SectionHeader>Details</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label={otherPartyLabel()} value={call.caller_number || "—"} />
          <Field label="Caller name" value={call.caller_name || "—"} />
          <Field label="Status" value={call.status || "—"} />
          <Field label="Duration" value={formatDuration(call.duration_seconds)} />
          {/* Inbound-only routing fields */}
          <Field
            label="Topic"
            value={call.topic_slug || (outbound ? "n/a" : "—")}
          />
          <Field
            label="Handoff"
            value={call.handoff_reason || (outbound ? "n/a" : "—")}
          />
          <Field
            label="Transfer status"
            value={call.transfer_status || (outbound ? "n/a" : "—")}
          />
          <Field
            label="Answered via"
            value={call.answered_via || (outbound ? "n/a" : "—")}
          />
        </div>
      </div>

      {/* Analysis block — the 4.6 skip states are the KEY UX here */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <SectionHeader>
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[#2E75B6]" /> Analysis
          </span>
        </SectionHeader>
        {call.analysis_skipped_reason ? (
          <SkippedAnalysisState reason={call.analysis_skipped_reason} />
        ) : call.analyzed_at ? (
          <AnalysisFields call={call} />
        ) : (
          <div className="text-sm text-slate-500 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Analysis pending — the analyzer hasn't reached this call yet.
          </div>
        )}
      </div>

      {/* Transcript */}
      {call.transcript && call.transcript.trim().length > 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <SectionHeader>
            <span className="inline-flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-slate-500" /> Transcript
            </span>
          </SectionHeader>
          <TranscriptView text={call.transcript} />
        </div>
      ) : null}

      {/* Follow-up flag */}
      {call.follow_up_required ? (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Follow-up required</p>
            <p className="text-xs text-amber-800">
              {call.caller_intent || call.summary || "This call was flagged for staff follow-up."}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SkippedAnalysisState({ reason }: { reason: string }) {
  const meta = SKIP_REASON_DISPLAY[reason] || {
    headline: "Analysis skipped",
    body: `Skipped for reason: ${reason}`,
  };
  return (
    <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
      <p className="text-sm font-medium text-slate-700">{meta.headline}</p>
      <p className="text-xs text-slate-500 mt-1">{meta.body}</p>
    </div>
  );
}

function AnalysisFields({ call }: { call: CallDetail }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Sentiment"
          value={
            call.sentiment
              ? `${prettyEnum(call.sentiment)}${call.sentiment_score !== null ? ` (${call.sentiment_score}/5)` : ""}`
              : "—"
          }
        />
        <Field label="Dominant emotion" value={call.dominant_emotion ? prettyEnum(call.dominant_emotion) : "—"} />
        <Field label="Urgency" value={call.urgency ? prettyEnum(call.urgency) : "—"} />
        <Field
          label="Inferred satisfaction"
          value={call.satisfaction_inferred !== null ? `${call.satisfaction_inferred}/5` : "—"}
        />
      </div>
      {call.summary ? (
        <div className="rounded-lg bg-[#2E75B6]/5 border border-[#2E75B6]/10 p-3">
          <p className="text-[11px] font-semibold text-[#2E75B6] uppercase tracking-wider mb-1">Summary</p>
          <p className="text-sm text-slate-700 leading-relaxed">{call.summary}</p>
        </div>
      ) : null}
      {call.caller_intent ? (
        <div>
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Intent</p>
          <p className="text-sm text-slate-700">{call.caller_intent}</p>
        </div>
      ) : null}
    </div>
  );
}

function TranscriptView({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim());
  return (
    <div className="bg-slate-50 rounded-lg p-3 space-y-2 max-h-96 overflow-y-auto">
      {lines.map((line, i) => {
        const m = line.match(/^(AI|Alex|Caller|\[assistant\]|\[caller\]):\s*(.*)$/i);
        const role = m ? m[1].toLowerCase() : "";
        const body = m ? m[2] : line;
        const isAI = role === "ai" || role === "alex" || role === "[assistant]";
        const isCaller = role === "caller" || role === "[caller]";
        return (
          <div key={i} className="flex gap-2">
            <span
              className={`text-[10px] font-bold uppercase mt-0.5 shrink-0 w-14 ${
                isAI ? "text-[#2E75B6]" : isCaller ? "text-slate-600" : "text-slate-400"
              }`}
            >
              {isAI ? "Alex" : isCaller ? "Caller" : ""}
            </span>
            <p className="text-xs text-slate-700 leading-relaxed">{body}</p>
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-slate-50 rounded-lg p-3">
      <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1">{label}</p>
      <p className="text-sm font-semibold text-slate-900">{value ?? "—"}</p>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-3">
      {children}
    </h2>
  );
}

function formatDuration(secs: number | null): string {
  if (secs == null || secs < 0) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s}s`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function prettyEnum(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, " ");
}

function toneToText(tone: OutcomeTone): string {
  if (tone === "answered") return "text-emerald-700";
  if (tone === "missed") return "text-red-600";
  return "text-slate-700";
}
