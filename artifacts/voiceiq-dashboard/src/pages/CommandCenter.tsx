import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { useTranslation } from "react-i18next";
import { getCallStats, getRecentCalls, getActionItems, callOutbound, sendSms, getLocationStats, getSurveyFollowups, getProfiles } from "../lib/api";
import UsageSummary from "../components/UsageSummary";
import { useLocation as useLocationCtx } from "../components/LocationContext";
// Phase 3.3c: softphone status alongside Alex / SMS / Calendar in the
// bottom system bar so ops can see at a glance whether the WebRTC
// device is reachable.
import { SoftphoneIndicator } from "../components/Softphone";
import {
  Phone,
  UserPlus,
  CalendarCheck,
  AlertCircle,
  Clock,
  PhoneOutgoing,
  MessageSquare,
  Eye,
  CheckCircle2,
  XCircle,
  Flame,
  TrendingUp,
  TrendingDown,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  Send,
  Bot,
  Calendar,
  Wifi,
  X,
  Check,
  Sparkles,
  PhoneCall,
  CircleDot,
  Loader2,
  Award,
  MapPin,
  Star,
  AlertTriangle,
  Dna,
  ShieldAlert,
} from "lucide-react";

// Internal QA numbers that should never count toward customer-facing
// metrics. Abdul's test phone (+12025732022) called into EZ Rentals'
// receptionist three times on 2026-06-04 to validate the agent; those
// calls dragged the customer's AI Score to "44 F" and front-paged a
// scary, meaningless grade. Filter test numbers out of the scoring
// path. Calls are still visible in the call list — only score is gated.
const TEST_CALLER_PHONES = new Set([
  "+12025732022",
]);
// Below this volume of real (non-test) calls, the score is too volatile
// to surface — a single missed call swings the grade two letters. Show
// a placeholder until the customer has enough signal.
const SCORE_MIN_CALLS = 10;

function calculateNeverrScore(calls: any[]) {
  const emptyFactors = [
    { name: "Answer Rate", value: 0, max: 20, pct: 0 },
    { name: "Lead Capture", value: 0, max: 20, pct: 0 },
    { name: "Booking Rate", value: 0, max: 20, pct: 0 },
    { name: "Follow-Up Rate", value: 0, max: 20, pct: 0 },
    { name: "Customer Sentiment", value: 0, max: 20, pct: 0 },
  ];
  if (!calls || calls.length === 0) return { score: 0, grade: "N/A", factors: emptyFactors };

  const total = calls.length;
  const answered = calls.filter((c) => c.status !== "missed").length;
  const leads = calls.filter((c) => c.caller_name && c.caller_name !== "Unknown").length;
  const booked = calls.filter((c) => c.call_outcome?.includes("book") || c.call_outcome?.includes("appoint")).length;
  const followedUp = calls.filter((c) => c.follow_up_required && c.status === "completed").length;
  const positive = calls.filter((c) => c.sentiment === "positive").length;

  const answerRate = total > 0 ? (answered / total) * 20 : 0;
  const leadCapture = total > 0 ? Math.min((leads / total) * 25, 20) : 0;
  const bookingRate = total > 0 ? Math.min((booked / total) * 40, 20) : 0;
  const followUpRate = followedUp > 0 ? Math.min(((total - followedUp) / total) * 25, 20) : 20;
  const sentimentScore = total > 0 ? (positive / total) * 20 : 10;

  const score = Math.round(answerRate + leadCapture + bookingRate + followUpRate + sentimentScore);

  let grade = "F";
  if (score >= 90) grade = "A+";
  else if (score >= 80) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 50) grade = "D";

  const factors = [
    { name: "Answer Rate", value: Math.round(answerRate), max: 20, pct: Math.round((answered / Math.max(total, 1)) * 100) },
    { name: "Lead Capture", value: Math.round(leadCapture), max: 20, pct: Math.round((leads / Math.max(total, 1)) * 100) },
    { name: "Booking Rate", value: Math.round(bookingRate), max: 20, pct: Math.round((booked / Math.max(total, 1)) * 100) },
    { name: "Follow-Up Rate", value: Math.round(followUpRate), max: 20, pct: Math.round(((total - followedUp) / Math.max(total, 1)) * 100) },
    { name: "Customer Sentiment", value: Math.round(sentimentScore), max: 20, pct: Math.round((positive / Math.max(total, 1)) * 100) },
  ];

  return { score, grade, factors };
}

function getScoreColor(score: number) {
  if (score >= 80) return { ring: "#22c55e", bg: "bg-green-50", text: "text-green-700", border: "border-green-200" };
  if (score >= 50) return { ring: "#f59e0b", bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
  return { ring: "#ef4444", bg: "bg-red-50", text: "text-red-700", border: "border-red-200" };
}

function getScoreInsightKey(score: number) {
  if (score >= 80) return "dashboard.scoreInsights.excellent";
  if (score >= 60) return "dashboard.scoreInsights.good";
  if (score >= 40) return "dashboard.scoreInsights.fair";
  return "dashboard.scoreInsights.poor";
}

const factorKeyMap: Record<string, string> = {
  "Answer Rate": "dashboard.answerRate",
  "Lead Capture": "dashboard.leadCapture",
  "Booking Rate": "dashboard.bookingRate",
  "Follow-Up Rate": "dashboard.followUpRate",
  "Customer Sentiment": "dashboard.customerSentiment",
};

function ScoreGauge({ score, grade }: { score: number; grade: string }) {
  const colors = getScoreColor(score);
  const circumference = 2 * Math.PI * 54;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative w-36 h-36">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="54" fill="none" stroke="#e5e7eb" strokeWidth="8" />
        <circle
          cx="60" cy="60" r="54" fill="none"
          stroke={colors.ring} strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-extrabold text-gray-900">{score}</span>
        <span className={`text-sm font-bold ${colors.text}`}>{grade}</span>
      </div>
    </div>
  );
}

function useTimeAgo() {
  const { t } = useTranslation();
  return (date: string) => {
    const diff = Date.now() - new Date(date).getTime();
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return t("dashboard.justNow");
    const mins = Math.floor(secs / 60);
    if (mins < 60) return t("dashboard.mAgo", { count: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t("dashboard.hAgo", { count: hrs });
    return t("dashboard.dAgo", { count: Math.floor(hrs / 24) });
  };
}

function formatDuration(s: number | null) {
  if (!s) return "—";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function getLeadScore(call: any): { score: number; color: string } {
  let score = 0;
  if (call.caller_name && call.caller_name !== "Unknown") score += 25;
  if (call.caller_number) score += 20;
  if (call.caller_intent && call.caller_intent !== "Unknown") score += 20;
  if (call.call_outcome === "lead_captured" || call.call_outcome === "appointment_booked") score += 25;
  if (call.call_outcome === "callback_requested") score += 30;
  if (call.duration_seconds && call.duration_seconds > 60) score += 10;
  score = Math.min(score, 100);
  if (score >= 70) return { score, color: "bg-green-100 text-green-700" };
  if (score >= 40) return { score, color: "bg-amber-100 text-amber-700" };
  return { score, color: "bg-gray-100 text-gray-500" };
}

function OutcomeBadge({ call }: { call: any }) {
  const { t } = useTranslation();
  if (call.status === "missed") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500"><Phone className="w-3 h-3" />{t("dashboard.missed")}</span>;
  if (call.call_outcome === "callback_requested") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-red-50 text-red-600"><Flame className="w-3 h-3" />{t("dashboard.hotLead")}</span>;
  if (call.call_outcome === "appointment_booked") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-purple-50 text-purple-600"><CalendarCheck className="w-3 h-3" />{t("dashboard.booked")}</span>;
  if (call.call_outcome === "lead_captured") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-600"><TrendingUp className="w-3 h-3" />{t("dashboard.warmLead")}</span>;
  if (call.follow_up_required) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-600"><AlertCircle className="w-3 h-3" />{t("dashboard.followUp")}</span>;
  if (call.status === "completed" && !call.follow_up_required) return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-600"><CheckCircle2 className="w-3 h-3" />{t("dashboard.resolved")}</span>;
  if (call.caller_name && call.caller_name !== "Unknown" && call.caller_intent && call.caller_intent !== "Unknown") return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-600"><TrendingUp className="w-3 h-3" />{t("dashboard.warmLead")}</span>;
  return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-sky-50 text-sky-600"><CircleDot className="w-3 h-3" />{t("dashboard.cold")}</span>;
}

function SkeletonCard() {
  return <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse"><div className="h-4 w-20 bg-gray-100 rounded mb-3" /><div className="h-8 w-16 bg-gray-100 rounded mb-2" /><div className="h-3 w-24 bg-gray-50 rounded" /></div>;
}

function SkeletonRow() {
  return <div className="px-5 py-4 animate-pulse flex items-center gap-4"><div className="w-9 h-9 rounded-full bg-gray-100" /><div className="flex-1 space-y-2"><div className="h-3 w-32 bg-gray-100 rounded" /><div className="h-2 w-20 bg-gray-50 rounded" /></div></div>;
}

function SmsModal({ call, onClose }: { call: any; onClose: () => void }) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const templates = [
    t("dashboard.smsTemplates.thanks"),
    t("dashboard.smsTemplates.confirmed"),
    t("dashboard.smsTemplates.missedCall"),
  ];

  const handleSend = async () => {
    if (!msg.trim() || !call.caller_number) return;
    setSending(true);
    try {
      await sendSms(call.caller_number, msg);
      setSent(true);
      setTimeout(() => { setSent(false); onClose(); }, 1500);
    } catch (e) { console.error(e); }
    setSending(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-[#2E75B6]" />
            <h3 className="font-semibold text-gray-900">{t("dashboard.sendSms")}</h3>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-400" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t("dashboard.to")}</label>
            <div className="px-3 py-2 bg-gray-50 rounded-lg text-sm font-medium text-gray-900">{call.caller_number || t("dashboard.noNumberAvailable")}</div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-500 mb-1 block">{t("dashboard.quickTemplates")}</label>
            <div className="flex flex-wrap gap-1.5">
              {templates.map((tmpl, i) => (
                <button key={i} onClick={() => setMsg(tmpl)} className="text-[11px] px-2.5 py-1.5 rounded-lg bg-gray-50 text-gray-600 hover:bg-[#2E75B6]/10 hover:text-[#2E75B6] transition-colors border border-gray-100">{tmpl}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-gray-500">{t("dashboard.message")}</label>
              <span className={`text-[10px] font-medium ${msg.length > 160 ? "text-red-500" : "text-gray-400"}`}>{msg.length}/160</span>
            </div>
            <textarea value={msg} onChange={(e) => setMsg(e.target.value)} className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6] resize-none h-24" placeholder={t("dashboard.typePlaceholder")} />
          </div>
          <button onClick={handleSend} disabled={sending || !msg.trim() || !call.caller_number || msg.length > 160} className="w-full py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#245d94] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2">
            {sent ? <><Check className="w-4 h-4" />{t("dashboard.sent")}</> : sending ? <><Loader2 className="w-4 h-4 animate-spin" />{t("dashboard.sending")}</> : <><Send className="w-4 h-4" />{t("dashboard.sendSms")}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function CallDetailModal({ call, onClose }: { call: any; onClose: () => void }) {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo();
  const [sending, setSending] = useState(false);

  const handleCallBack = async () => {
    if (!call.caller_number) return;
    setSending(true);
    try { await callOutbound(call.caller_number); } catch (e) { console.error(e); }
    setSending(false);
  };

  const transcriptLines = (call.transcript || "").split("\n").filter((l: string) => l.trim());

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#2E75B6] flex items-center justify-center text-white font-bold text-sm">
              {(call.caller_name || "?")[0].toUpperCase()}
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">{call.caller_name || t("dashboard.unknownCaller")}</h3>
              <p className="text-xs text-gray-500">{call.caller_number || t("dashboard.noNumber")} · {formatDuration(call.duration_seconds)} · {timeAgo(call.created_at)}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"><X className="w-5 h-5 text-gray-400" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex items-center gap-4">
            <OutcomeBadge call={call} />
            {(() => { const ls = getLeadScore(call); return <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${ls.color}`}>{ls.score}% {t("dashboard.lead")}</span>; })()}
            <span className="text-xs text-gray-400">{call.direction || t("dashboard.inbound")}</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">{t("dashboard.caller")}</p>
              <p className="text-sm font-semibold text-gray-900">{call.caller_name || t("dashboard.unknown")}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">{t("dashboard.phone")}</p>
              <p className="text-sm font-semibold text-gray-900">{call.caller_number || "N/A"}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">{t("dashboard.intent")}</p>
              <p className="text-sm font-semibold text-gray-900">{call.caller_intent || t("dashboard.notCaptured")}</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">{t("dashboard.urgency")}</p>
              <p className="text-sm font-semibold text-gray-900">{call.call_outcome === "callback_requested" ? t("dashboard.urgent") : t("dashboard.normal")}</p>
            </div>
          </div>

          {call.summary && (
            <div className="bg-[#2E75B6]/5 border border-[#2E75B6]/10 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-[#2E75B6]" />
                <p className="text-xs font-semibold text-[#2E75B6] uppercase tracking-wider">{t("dashboard.aiSummary")}</p>
              </div>
              <p className="text-sm text-gray-700 leading-relaxed">{call.summary}</p>
            </div>
          )}

          {call.follow_up_required && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="w-4 h-4 text-amber-600" />
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider">{t("dashboard.actionRequired")}</p>
              </div>
              <p className="text-sm text-amber-800">{call.caller_intent || call.summary || t("dashboard.followUpWithCaller")}</p>
            </div>
          )}

          {transcriptLines.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{t("dashboard.transcript")}</p>
              <div className="bg-gray-50 rounded-xl p-4 space-y-2.5 max-h-64 overflow-y-auto">
                {transcriptLines.map((line: string, i: number) => {
                  const isAI = line.startsWith("AI:") || line.startsWith("Alex:");
                  const isCaller = line.startsWith("Caller:");
                  const text = line.replace(/^(AI|Alex|Caller):\s*/, "");
                  return (
                    <div key={i} className={`flex gap-2 ${isAI ? "" : ""}`}>
                      <span className={`text-[10px] font-bold uppercase mt-0.5 shrink-0 w-12 ${isAI ? "text-[#2E75B6]" : isCaller ? "text-gray-600" : "text-gray-400"}`}>
                        {isAI ? "Alex" : isCaller ? t("dashboard.caller") : ""}
                      </span>
                      <p className="text-xs text-gray-600 leading-relaxed">{text}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex gap-2 shrink-0">
          <button onClick={handleCallBack} disabled={!call.caller_number || sending} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#245d94] disabled:opacity-40 transition-all">
            <PhoneOutgoing className="w-4 h-4" />{t("dashboard.callBack")}
          </button>
          <button onClick={() => { onClose(); }} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-semibold hover:bg-emerald-700 transition-all">
            <MessageSquare className="w-4 h-4" />{t("dashboard.sendSms")}
          </button>
          <button className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 text-white rounded-xl text-sm font-semibold hover:bg-purple-700 transition-all">
            <Calendar className="w-4 h-4" />{t("dashboard.bookAppt")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CommandCenter() {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo();
  const { selectedLocationId, hasMultipleLocations } = useLocationCtx();
  const [stats, setStats] = useState<any>(null);
  const [calls, setCalls] = useState<any[]>([]);
  const [actions, setActions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCall, setSelectedCall] = useState<any>(null);
  const [smsCall, setSmsCall] = useState<any>(null);
  const [completedActions, setCompletedActions] = useState<Set<string>>(new Set());
  const [locationStats, setLocationStats] = useState<any[]>([]);
  const [surveyFollowups, setSurveyFollowups] = useState<any[]>([]);
  const [vipProfiles, setVipProfiles] = useState<any[]>([]);
  const [atRiskProfiles, setAtRiskProfiles] = useState<any[]>([]);

  const locParam = selectedLocationId === "all" ? undefined : selectedLocationId;

  const loadData = useCallback(() => {
    const promises: Promise<any>[] = [getCallStats(locParam), getRecentCalls(500, locParam), getActionItems()];
    if (hasMultipleLocations && selectedLocationId === "all") {
      promises.push(getLocationStats());
    }
    const bid = localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "demo-business";
    Promise.all(promises)
      .then(([s, c, a, ls]) => {
        setStats(s.stats);
        const allCalls = Array.isArray(c) ? c : c?.calls || [];
        setCalls(allCalls);
        setActions(a?.actions || []);
        if (ls?.stats) setLocationStats(ls.stats);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    getSurveyFollowups(bid).then((d) => setSurveyFollowups(d?.needsFollowUp || [])).catch(() => {});
    getProfiles({ filter: "vip", limit: 5, sort: "total_calls" }).then(d => setVipProfiles(d?.profiles || [])).catch(() => {});
    getProfiles({ filter: "at_risk", limit: 5, sort: "last_call" }).then(d => setAtRiskProfiles(d?.profiles || [])).catch(() => {});
  }, [locParam, hasMultipleLocations, selectedLocationId]);

  useEffect(() => { loadData(); }, [loadData]);

  const toggleAction = (id: string) => {
    setCompletedActions((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (loading) return (
    <div className="p-6 lg:p-8 max-w-[1400px]">
      <div className="mb-6"><div className="h-7 w-48 bg-gray-100 rounded animate-pulse mb-2" /><div className="h-4 w-72 bg-gray-50 rounded animate-pulse" /></div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">{[...Array(4)].map((_, i) => <SkeletonCard key={i} />)}</div>
      <div className="bg-white rounded-xl border border-gray-100 p-4">{[...Array(5)].map((_, i) => <SkeletonRow key={i} />)}</div>
    </div>
  );

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const callsToday = calls.filter((c) => new Date(c.created_at) >= todayStart);
  const callsThisMonth = calls.filter((c) => new Date(c.created_at) >= monthStart);
  const callsLast30 = calls.filter((c) => new Date(c.created_at) >= thirtyDaysAgo);

  const leadsMonth = callsThisMonth.filter((c) => c.caller_name && c.caller_name !== "Unknown" && c.caller_number).length;
  const apptsMonth = callsThisMonth.filter((c) => c.call_outcome?.includes("book") || c.call_outcome?.includes("appoint")).length;
  const openActions = calls.filter((c) => c.follow_up_required && c.status !== "completed").length;

  // Scoring uses only non-test calls. Two things change:
  //   1. score is computed from real customer calls (no F-drag from QA).
  //   2. the panel is gated on nonTestCallsLast30.length, not score, so
  //      we don't keep showing a meaningless grade on tiny samples.
  const nonTestCallsLast30 = callsLast30.filter(
    (c) => !TEST_CALLER_PHONES.has(c.caller_number)
  );
  const scoreData = calculateNeverrScore(nonTestCallsLast30);

  const roiCallCount = callsLast30.length;
  const roiSavingsAmount = Math.round(roiCallCount * 8.35);

  const statCards = [
    {
      label: t("dashboard.callsToday"),
      value: callsToday.length,
      icon: Phone,
      color: "text-[#2E75B6]",
      bg: "bg-[#2E75B6]/8",
      iconBg: "bg-[#2E75B6]/10",
      trend: callsToday.length > 0 ? "up" : "flat",
    },
    {
      label: t("dashboard.leadsMonth"),
      value: leadsMonth,
      icon: UserPlus,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      iconBg: "bg-emerald-50",
      trend: leadsMonth > 0 ? "up" : "flat",
    },
    {
      label: t("dashboard.appointmentsMonth"),
      value: apptsMonth,
      icon: CalendarCheck,
      color: "text-purple-600",
      bg: "bg-purple-50",
      iconBg: "bg-purple-50",
      trend: apptsMonth > 0 ? "up" : "flat",
    },
    {
      label: t("dashboard.actionItems"),
      value: openActions,
      icon: AlertCircle,
      color: "text-amber-600",
      bg: "bg-amber-50",
      iconBg: "bg-amber-50",
      trend: openActions > 0 ? "down" : "flat",
    },
  ];

  const factorColors = ["#2E75B6", "#22c55e", "#8b5cf6", "#f59e0b", "#ef4444"];
  const colors = getScoreColor(scoreData.score);

  const sortedActions = [...actions].sort((a: any, b: any) => {
    if (completedActions.has(a.id) !== completedActions.has(b.id)) return completedActions.has(a.id) ? 1 : -1;
    if (a.urgency !== b.urgency) return a.urgency === "urgent" ? -1 : 1;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  const lastCallTime = calls.length > 0 ? timeAgo(calls[0].created_at) : "—";

  return (
    <div className="p-6 lg:p-8 max-w-[1400px]">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{t("dashboard.title")}</h1>
          <p className="text-sm text-gray-500 mt-0.5">{t("dashboard.subtitle")}</p>
        </div>
        <button onClick={loadData} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
          <Loader2 className="w-3 h-3" />{t("dashboard.refresh")}
        </button>
      </div>

      {surveyFollowups.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <Star className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-amber-900">{surveyFollowups.length} unhappy caller{surveyFollowups.length !== 1 ? "s" : ""} need{surveyFollowups.length === 1 ? "s" : ""} follow-up</p>
              <p className="text-xs text-amber-700 mt-0.5">Callers who rated their experience 1-2 stars in the last 7 days</p>
            </div>
          </div>
          <a href="/contacts?filter=low_satisfaction" className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-amber-800 bg-amber-100 rounded-lg hover:bg-amber-200 transition-colors">
            View & call back <ArrowUpRight className="w-3 h-3" />
          </a>
        </div>
      )}

      {calls.length === 0 && (
        <div className="bg-gradient-to-r from-[#2E75B6]/5 to-emerald-50 border border-[#2E75B6]/10 rounded-xl p-6 mb-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-6 h-6 text-[#2E75B6]" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Your AI receptionist is active</h3>
            <p className="text-xs text-gray-500 mt-0.5">Forward your business calls to get started. Once calls come in, your dashboard will populate with real-time analytics.</p>
          </div>
        </div>
      )}

      {(() => {
        // Gate on volume of non-test calls, not on score. Below the
        // minimum, the panel is replaced with a small placeholder so the
        // customer knows WHY the score is missing instead of seeing a
        // F-grade on three QA calls. The placeholder is intentionally
        // unstyled gauge-free — no half-empty ring, no fake percentages.
        if (nonTestCallsLast30.length < SCORE_MIN_CALLS) {
          return (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-5 flex items-center gap-3">
              <Award className="w-5 h-5 text-slate-400 shrink-0" />
              <p className="text-xs text-slate-600 leading-relaxed">
                Your AI Score will appear after {SCORE_MIN_CALLS}+ calls — currently {nonTestCallsLast30.length}.
                Keep handling calls and check back soon.
              </p>
            </div>
          );
        }
        return (
          <div className={`${colors.bg} border ${colors.border} rounded-xl p-5 mb-5`}>
            <div className="flex flex-col md:flex-row items-center gap-6">
              <div className="flex flex-col items-center shrink-0">
                <ScoreGauge score={scoreData.score} grade={scoreData.grade} />
                <p className="text-sm font-bold text-gray-900 mt-2">{t("dashboard.neverrScore")}</p>
                <p className="text-[11px] text-gray-500">{t("dashboard.basedOn30Days")}</p>
              </div>
              <div className="flex-1 w-full space-y-2.5">
                {scoreData.factors.map((f, i) => (
                  <div key={f.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-700">{t(factorKeyMap[f.name] || f.name)}</span>
                      <span className="text-xs text-gray-500">{f.value}/{f.max} pts <span className="text-gray-400">({f.pct}%)</span></span>
                    </div>
                    <div className="w-full h-2 bg-white/60 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(f.value / f.max) * 100}%`, backgroundColor: factorColors[i] }} />
                    </div>
                  </div>
                ))}
                <div className="flex items-start gap-2 mt-3 pt-3 border-t border-gray-200/60">
                  <Award className={`w-4 h-4 shrink-0 mt-0.5 ${colors.text}`} />
                  <p className="text-xs text-gray-600 leading-relaxed">{t(getScoreInsightKey(scoreData.score))}</p>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* "Customize your receptionist" quick-action — always visible so
          AiSettingsPage is discoverable from the dashboard regardless of
          call volume. Matches the gradient affordance used for the
          "Your AI receptionist is active" empty state above; uses Link
          (not <a>) so wouter intercepts the navigation instead of doing
          a full reload. */}
      <Link
        href="/settings/ai"
        className="bg-gradient-to-r from-[#2E75B6]/5 to-emerald-50 border border-[#2E75B6]/10 rounded-xl p-5 mb-5 flex items-center gap-4 hover:shadow-md transition-shadow cursor-pointer"
      >
        <div className="w-12 h-12 rounded-xl bg-[#2E75B6]/10 flex items-center justify-center shrink-0">
          <Bot className="w-6 h-6 text-[#2E75B6]" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-gray-900">Customize your receptionist</h3>
          <p className="text-xs text-gray-500 mt-0.5">Tune your AI's voice, prompts, and conversation style.</p>
        </div>
        <ArrowUpRight className="w-5 h-5 text-[#2E75B6] shrink-0" />
      </Link>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm hover:shadow-md transition-all group">
              <div className="flex items-center justify-between mb-3">
                <div className={`w-9 h-9 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                  <Icon className={`w-[18px] h-[18px] ${card.color}`} />
                </div>
                {card.trend === "up" && <ArrowUpRight className="w-4 h-4 text-emerald-500" />}
                {card.trend === "down" && <ArrowDownRight className="w-4 h-4 text-red-500" />}
              </div>
              <p className="text-2xl font-bold text-gray-900 mb-1">{card.value}</p>
              <p className="text-xs text-gray-500 font-medium">{card.label}</p>
            </div>
          );
        })}
      </div>

      <UsageSummary />

      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-gradient-to-r from-amber-50 to-amber-50/50 border border-amber-100 mb-5">
        <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0 z-10">
          <DollarSign className="w-5 h-5 text-amber-600" />
        </div>
        <p className="text-sm text-amber-900 z-10">
          {t("dashboard.roiMessage", { count: roiCallCount.toLocaleString(), amount: `$${roiSavingsAmount.toLocaleString()}` })}
        </p>
      </div>

      {hasMultipleLocations && selectedLocationId === "all" && locationStats.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-5">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
            <MapPin className="w-4 h-4 text-[#2E75B6]" />
            <h2 className="font-semibold text-gray-900 text-sm">Location Performance</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-gray-500">
                  <th className="text-left px-5 py-3 font-medium">Location</th>
                  <th className="text-center px-4 py-3 font-medium">Calls</th>
                  <th className="text-center px-4 py-3 font-medium">Leads</th>
                  <th className="text-center px-4 py-3 font-medium">Booked</th>
                  <th className="text-center px-4 py-3 font-medium">Score</th>
                </tr>
              </thead>
              <tbody>
                {locationStats.map((ls: any) => (
                  <tr key={ls.location_id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    <td className="px-5 py-3 font-medium text-gray-900">{ls.location_name}</td>
                    <td className="text-center px-4 py-3 text-gray-600">{ls.calls}</td>
                    <td className="text-center px-4 py-3 text-gray-600">{ls.leads}</td>
                    <td className="text-center px-4 py-3 text-gray-600">{ls.booked}</td>
                    <td className="text-center px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${ls.score >= 70 ? "bg-emerald-50 text-emerald-700" : ls.score >= 40 ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                        {ls.score}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-5">
        <div className="lg:col-span-3">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PhoneCall className="w-4 h-4 text-gray-400" />
                <h2 className="font-semibold text-gray-900 text-sm">{t("dashboard.recentCalls")}</h2>
              </div>
              <span className="text-[11px] text-gray-400 font-medium bg-gray-50 px-2 py-0.5 rounded-full">{t("dashboard.callsCount", { count: calls.length })}</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[10px] text-gray-400 uppercase tracking-wider font-semibold border-b border-gray-50">
                    <th className="px-5 py-2.5">{t("dashboard.caller")}</th>
                    <th className="px-3 py-2.5 hidden xl:table-cell">{t("dashboard.phone")}</th>
                    <th className="px-3 py-2.5">{t("dashboard.duration")}</th>
                    <th className="px-3 py-2.5">{t("dashboard.outcome")}</th>
                    <th className="px-3 py-2.5 hidden xl:table-cell">{t("dashboard.scoreLabel")}</th>
                    <th className="px-3 py-2.5">{t("dashboard.time")}</th>
                    <th className="px-3 py-2.5 text-right">{t("dashboard.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.length === 0 ? (
                    <tr><td colSpan={7} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <Phone className="w-8 h-8 text-gray-200 mb-3" />
                        <p className="text-sm text-gray-400">{t("dashboard.noCalls")}</p>
                        <p className="text-xs text-gray-300 mt-1">{t("dashboard.noCallsSubtitle")}</p>
                      </div>
                    </td></tr>
                  ) : (
                    calls.map((call: any) => {
                      const ls = getLeadScore(call);
                      return (
                        <tr key={call.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/70 transition-colors group/row">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#2E75B6] to-[#1B2537] flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                                {(call.caller_name || "?")[0].toUpperCase()}{(call.caller_name || "?").split(" ")[1]?.[0]?.toUpperCase() || ""}
                              </div>
                              <span className="text-sm font-medium text-gray-900 truncate max-w-[120px]">{call.caller_name || t("dashboard.unknown")}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-xs text-gray-500 hidden xl:table-cell font-mono">{call.caller_number || "—"}</td>
                          <td className="px-3 py-3 text-xs text-gray-900 font-medium">{formatDuration(call.duration_seconds)}</td>
                          <td className="px-3 py-3"><OutcomeBadge call={call} /></td>
                          <td className="px-3 py-3 hidden xl:table-cell">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${ls.color}`}>{ls.score}</span>
                          </td>
                          <td className="px-3 py-3">
                            <span className="text-[11px] text-gray-400 flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(call.created_at)}</span>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center justify-end gap-1 opacity-60 group-hover/row:opacity-100 transition-opacity">
                              <button
                                title={t("dashboard.callBack")}
                                className="w-7 h-7 rounded-lg hover:bg-[#2E75B6]/10 flex items-center justify-center transition-colors"
                                onClick={() => call.caller_number && callOutbound(call.caller_number)}
                              >
                                <PhoneOutgoing className="w-3.5 h-3.5 text-[#2E75B6]" />
                              </button>
                              <button
                                title={t("dashboard.sendSms")}
                                className="w-7 h-7 rounded-lg hover:bg-emerald-50 flex items-center justify-center transition-colors"
                                onClick={() => setSmsCall(call)}
                              >
                                <MessageSquare className="w-3.5 h-3.5 text-emerald-600" />
                              </button>
                              <button
                                title={t("dashboard.viewDetails")}
                                className="w-7 h-7 rounded-lg hover:bg-purple-50 flex items-center justify-center transition-colors"
                                onClick={() => setSelectedCall(call)}
                              >
                                <Eye className="w-3.5 h-3.5 text-purple-600" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500" />
              <h2 className="font-semibold text-gray-900 text-sm">{t("dashboard.needsAttention")}</h2>
              {sortedActions.length > 0 && <span className="ml-auto w-5 h-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{sortedActions.length}</span>}
            </div>
            <div className="divide-y divide-gray-50 max-h-[520px] overflow-y-auto">
              {sortedActions.length === 0 ? (
                <div className="p-10 text-center">
                  <CheckCircle2 className="w-8 h-8 text-emerald-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-400">{t("dashboard.allCaughtUp")}</p>
                  <p className="text-xs text-gray-300 mt-1">{t("dashboard.noPendingItems")}</p>
                </div>
              ) : (
                sortedActions.map((item: any) => (
                  <div key={item.id} className={`px-5 py-3.5 hover:bg-gray-50/70 transition-colors ${completedActions.has(item.id) ? "opacity-40" : ""}`}>
                    <div className="flex items-start gap-3">
                      <button onClick={() => toggleAction(item.id)} className="mt-0.5 shrink-0">
                        {completedActions.has(item.id) ? (
                          <CheckCircle2 className="w-4.5 h-4.5 text-emerald-500" />
                        ) : (
                          <div className={`w-4 h-4 rounded-full border-2 ${item.urgency === "urgent" ? "border-red-400" : "border-amber-400"}`}>
                            <div className={`w-2 h-2 rounded-full m-[2px] ${item.urgency === "urgent" ? "bg-red-400" : "bg-amber-400"}`} />
                          </div>
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-sm font-semibold text-gray-900">{item.caller_name}</span>
                          {item.urgency === "urgent" && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-50 text-red-600 uppercase tracking-wider">{t("dashboard.urgent")}</span>}
                        </div>
                        <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">{item.reason}</p>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            className="flex items-center gap-1 px-2 py-1 rounded-md bg-[#2E75B6]/10 text-[#2E75B6] text-[11px] font-semibold hover:bg-[#2E75B6]/20 transition-colors"
                            onClick={() => item.caller_number && callOutbound(item.caller_number)}
                          >
                            <PhoneOutgoing className="w-3 h-3" />{t("dashboard.callBack")}
                          </button>
                          <span className="text-[10px] text-gray-300">{timeAgo(item.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {(vipProfiles.length > 0 || atRiskProfiles.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {vipProfiles.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-5">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-3 text-sm">
                <Star className="w-4 h-4 text-yellow-500 fill-yellow-400" /> VIP Callers
              </h3>
              <div className="space-y-2">
                {vipProfiles.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between p-2.5 bg-yellow-50/50 rounded-lg">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-yellow-400 to-amber-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {(p.name || '?')[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{p.name || 'Unknown'}</p>
                        <p className="text-[10px] text-gray-500">{p.phone}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <p className="text-xs font-semibold text-gray-900">{p.total_calls} calls</p>
                      <p className="text-[10px] text-gray-400">{p.last_call_at ? timeAgo(p.last_call_at) : 'Never'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {atRiskProfiles.length > 0 && (
            <div className="bg-white rounded-xl border border-red-100 p-5">
              <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-3 text-sm">
                <ShieldAlert className="w-4 h-4 text-red-500" /> At Risk — Needs Attention
              </h3>
              <div className="space-y-2">
                {atRiskProfiles.map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between p-2.5 bg-red-50/50 rounded-lg">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-red-400 to-red-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                        {(p.name || '?')[0].toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{p.name || 'Unknown'}</p>
                        <p className="text-[10px] text-gray-500">{p.phone}</p>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-2">
                      <p className="text-xs font-medium text-red-600">Sentiment: {p.avg_sentiment_score}</p>
                      <p className="text-[10px] text-gray-400 capitalize">{p.sentiment_trend || 'stable'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 px-5 py-3 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <Bot className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-medium text-gray-600">Alex: <span className="text-emerald-600">{t("dashboard.live")}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-medium text-gray-600">SMS: <span className="text-emerald-600">{t("dashboard.active")}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <Calendar className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-medium text-gray-600">Google Calendar: <span className="text-emerald-600">{t("dashboard.connected")}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <Wifi className="w-3.5 h-3.5 text-gray-400" />
            <span className="text-[11px] font-medium text-gray-600">Outlook: <span className="text-emerald-600">{t("dashboard.connected")}</span></span>
          </div>
          {/* Phase 3.3c: softphone status. Real state (unlike the four
              above which are placeholders). Clicks navigate to /phone. */}
          <SoftphoneIndicator />
        </div>
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-[11px] text-gray-500">{t("dashboard.lastCall")}: <span className="font-medium text-gray-700">{lastCallTime}</span></span>
        </div>
      </div>

      {selectedCall && <CallDetailModal call={selectedCall} onClose={() => setSelectedCall(null)} />}
      {smsCall && <SmsModal call={smsCall} onClose={() => setSmsCall(null)} />}
    </div>
  );
}
