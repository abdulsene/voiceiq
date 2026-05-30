import { useEffect, useState, useMemo } from "react";
import { getRecentCalls, getCoachingForCall } from "../lib/api";
import { useLocation as useLocationCtx } from "../components/LocationContext";
import {
  Search,
  Phone,
  Clock,
  Flame,
  XCircle,
  Download,
  Filter,
  Headphones,
} from "lucide-react";

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function calcScore(call: any): number {
  let score = 0;
  const dur = call.duration_seconds || 0;
  if (dur > 120) score += 30;
  else if (dur > 60) score += 20;
  else if (dur > 30) score += 10;
  if (call.caller_name && call.caller_name !== "Unknown") score += 20;
  const outcome = (call.call_outcome || "").toLowerCase();
  if (outcome.includes("book") || outcome.includes("appoint")) score += 20;
  else if (outcome.includes("lead")) score += 15;
  if (call.follow_up_required) score += 10;
  return Math.min(100, score);
}

function ScoreBadge({ score }: { score: number }) {
  if (score >= 70) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: "#dc2626" }}>
        🔥 Hot
      </span>
    );
  }
  if (score >= 40) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: "#ea580c" }}>
        🌡️ Warm
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold text-white" style={{ background: "#2563eb" }}>
      ❄️ Cold
    </span>
  );
}

export default function CallsLeads() {
  const { selectedLocationId } = useLocationCtx();
  const [calls, setCalls] = useState<any[]>([]);
  const [filtered, setFiltered] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedCall, setSelectedCall] = useState<any>(null);
  const [coachingData, setCoachingData] = useState<any>(null);

  const locParam = selectedLocationId === "all" ? undefined : selectedLocationId;

  useEffect(() => {
    setLoading(true);
    getRecentCalls(100, locParam)
      .then((d) => { setCalls(d.calls); setFiltered(d.calls); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [locParam]);

  useEffect(() => {
    let result = calls;
    if (search) {
      const s = search.toLowerCase();
      result = result.filter((c: any) =>
        (c.caller_name || "").toLowerCase().includes(s) ||
        (c.caller_number || "").includes(s)
      );
    }
    if (statusFilter !== "all") {
      result = result.filter((c: any) => c.status === statusFilter);
    }
    setFiltered(result);
  }, [search, statusFilter, calls]);

  const scoreSummary = useMemo(() => {
    let hot = 0, warm = 0, cold = 0;
    for (const c of filtered) {
      const s = calcScore(c);
      if (s >= 70) hot++;
      else if (s >= 40) warm++;
      else cold++;
    }
    return { hot, warm, cold };
  }, [filtered]);

  const exportCsv = () => {
    const headers = "Name,Phone,Status,Outcome,Score,Duration,Date\n";
    const rows = filtered.map((c: any) =>
      `"${c.caller_name || ""}","${c.caller_number || ""}","${c.status}","${c.call_outcome || ""}","${calcScore(c)}","${c.duration_seconds || 0}","${c.created_at}"`
    ).join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neverr-calls.csv";
    a.click();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" /></div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Calls & Leads</h1>
          <p className="text-sm text-gray-500 mt-1">{calls.length} total calls</p>
        </div>
        <button onClick={exportCsv} className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      <div className="flex items-center gap-4 mb-4 bg-white rounded-xl border border-gray-200 px-5 py-3">
        <span className="text-sm font-medium text-gray-600">Lead Scores:</span>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "#dc2626" }}>
          🔥 {scoreSummary.hot} Hot
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "#ea580c" }}>
          🌡️ {scoreSummary.warm} Warm
        </span>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: "#2563eb" }}>
          ❄️ {scoreSummary.cold} Cold
        </span>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-4 border-b border-gray-100 flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search by name or phone..."
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 focus:border-[#2E75B6]"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            {["all", "completed", "missed", "initiated"].map((s) => (
              <button
                key={s}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${statusFilter === s ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
                onClick={() => setStatusFilter(s)}
              >
                {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-5 py-3 font-medium">Caller</th>
                <th className="px-5 py-3 font-medium">Phone</th>
                <th className="px-5 py-3 font-medium">Score</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Outcome</th>
                <th className="px-5 py-3 font-medium">Duration</th>
                <th className="px-5 py-3 font-medium">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.length === 0 ? (
                <tr><td colSpan={7} className="px-5 py-16 text-center">
                  <div className="flex flex-col items-center">
                    <Phone className="w-10 h-10 text-gray-200 mb-3" />
                    <p className="text-sm font-medium text-gray-500">No calls yet</p>
                    <p className="text-xs text-gray-400 mt-1">Your AI receptionist is ready. Once calls come in they'll appear here.</p>
                  </div>
                </td></tr>
              ) : (
                filtered.map((call: any) => {
                  const score = calcScore(call);
                  return (
                    <tr key={call.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => {
                      setSelectedCall(call);
                      setCoachingData(null);
                      if (call.call_sid) {
                        getCoachingForCall(call.call_sid).then(d => {
                          if (d.coached) setCoachingData(d);
                        }).catch(() => {});
                      }
                    }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                            <Phone className="w-3.5 h-3.5 text-gray-400" />
                          </div>
                          <span className="text-sm font-medium text-gray-900">{call.caller_name || "Unknown"}</span>
                          {call.coaching_session && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-100 text-indigo-700">
                              <Headphones className="w-2.5 h-2.5" />Coached
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">{call.caller_number || "N/A"}</td>
                      <td className="px-5 py-3">
                        <ScoreBadge score={score} />
                      </td>
                      <td className="px-5 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${call.status === "completed" ? "bg-green-100 text-green-700" : call.status === "missed" ? "bg-red-100 text-red-700" : "bg-yellow-100 text-yellow-700"}`}>
                          {call.status}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        {call.call_outcome === "callback_requested" ? (
                          <span className="flex items-center gap-1 text-[11px] font-medium text-red-600"><Flame className="w-3 h-3" />Hot Lead</span>
                        ) : call.call_outcome === "lead_captured" ? (
                          <span className="text-[11px] font-medium text-orange-600">Lead</span>
                        ) : call.call_outcome === "appointment_booked" ? (
                          <span className="text-[11px] font-medium text-blue-600">Booked</span>
                        ) : (
                          <span className="text-[11px] text-gray-400">{call.call_outcome || "—"}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-sm text-gray-500">
                        {call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}:${String(call.duration_seconds % 60).padStart(2, "0")}` : "—"}
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" />{timeAgo(call.created_at)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedCall && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelectedCall(null)}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-lg">Call Details</h3>
              <button onClick={() => setSelectedCall(null)}><XCircle className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><p className="text-xs text-gray-500">Caller</p><p className="font-medium">{selectedCall.caller_name || "Unknown"}</p></div>
                <div><p className="text-xs text-gray-500">Phone</p><p className="font-medium">{selectedCall.caller_number || "N/A"}</p></div>
                <div><p className="text-xs text-gray-500">Status</p><p className="font-medium">{selectedCall.status}</p></div>
                <div><p className="text-xs text-gray-500">Outcome</p><p className="font-medium">{selectedCall.call_outcome || "N/A"}</p></div>
                <div><p className="text-xs text-gray-500">Lead Score</p><p className="font-medium"><ScoreBadge score={calcScore(selectedCall)} /></p></div>
                <div><p className="text-xs text-gray-500">Score Value</p><p className="font-medium">{calcScore(selectedCall)}/100</p></div>
              </div>
              {selectedCall.transfer_status && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-3">
                  <p className="text-xs font-medium text-blue-700 mb-1.5">Call Transfer</p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div><span className="text-gray-500">Status:</span> <span className="font-medium text-gray-900">{selectedCall.transfer_status}</span></div>
                    <div><span className="text-gray-500">Reason:</span> <span className="font-medium text-gray-900">{(selectedCall.transfer_reason || "N/A").replace(/_/g, " ")}</span></div>
                    <div><span className="text-gray-500">Answered:</span> <span className={`font-medium ${selectedCall.transfer_answered ? "text-green-600" : "text-red-500"}`}>{selectedCall.transfer_answered ? "Yes" : "No"}</span></div>
                  </div>
                </div>
              )}
              {coachingData && coachingData.coached && (
                <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Headphones className="w-3.5 h-3.5 text-indigo-700" />
                    <p className="text-xs font-medium text-indigo-700">Live Coaching Session</p>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                    <div><span className="text-gray-500">Tips Sent:</span> <span className="font-medium text-gray-900">{coachingData.session.tips_sent}</span></div>
                    <div><span className="text-gray-500">Duration:</span> <span className="font-medium text-gray-900">{coachingData.session.duration ? `${Math.floor(coachingData.session.duration / 60)}m ${coachingData.session.duration % 60}s` : "Active"}</span></div>
                    <div><span className="text-gray-500">Status:</span> <span className={`font-medium ${coachingData.session.status === "active" ? "text-green-600" : "text-gray-600"}`}>{coachingData.session.status}</span></div>
                  </div>
                  {coachingData.tips && coachingData.tips.length > 0 && (
                    <div className="space-y-1 mt-2 border-t border-indigo-200 pt-2">
                      <p className="text-[10px] font-medium text-indigo-600 uppercase">Tips Sent During Call</p>
                      {coachingData.tips.map((tip: any, i: number) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className="text-indigo-400 whitespace-nowrap">{new Date(tip.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                          <span className="px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 text-[10px] font-medium whitespace-nowrap">{tip.trigger_type.replace(/_/g, " ")}</span>
                          <span className="text-gray-700">{tip.tip_text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {selectedCall.summary && (
                <div><p className="text-xs text-gray-500 mb-1">Summary</p><p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3">{selectedCall.summary}</p></div>
              )}
              {selectedCall.transcript && (
                <div><p className="text-xs text-gray-500 mb-1">Transcript</p><pre className="text-xs bg-gray-50 rounded-lg p-3 whitespace-pre-wrap max-h-60 overflow-y-auto">{selectedCall.transcript}</pre></div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
