import { useEffect, useState, useMemo } from "react";
import { getAnalytics } from "../lib/api";
import { useLocation } from "wouter";
import { useLocation as useLocationCtx } from "../components/LocationContext";
import {
  Phone,
  TrendingUp,
  TrendingDown,
  CalendarCheck,
  Flame,
  CheckCircle,
  BarChart3,
  Download,
  PhoneForwarded,
  Brain,
  Star,
  MessageSquare,
  Swords,
  Dna,
  ShieldAlert,
  RefreshCw,
  DollarSign,
  Headphones,
  Globe,
  Languages,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  CartesianGrid,
  Legend,
} from "recharts";

type RangeKey = "7" | "30" | "90" | "year";
const RANGES: { key: RangeKey; label: string }[] = [
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "90", label: "Last 90 days" },
  { key: "year", label: "This year" },
];

function getDateRange(range: RangeKey): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  if (range === "year") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(start.getDate() - Number(range));
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

function pctChange(cur: number, prev: number) {
  if (prev === 0) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 100);
}

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_LABELS = [
  "12am", "", "", "3am", "", "", "6am", "", "", "9am", "", "",
  "12pm", "", "", "3pm", "", "", "6pm", "", "", "9pm", "", "",
];

function fmtHour(h: number) {
  if (h === 0) return "12am";
  if (h < 12) return `${h}am`;
  if (h === 12) return "12pm";
  return `${h - 12}pm`;
}

const LEAD_COLORS = {
  hot: "#DC2626",
  warm: "#D97706",
  cold: "#2E75B6",
  unscored: "#9CA3AF",
};

interface AnalyticsData {
  totalCalls: number;
  totalCallsPrev: number;
  appointmentsBooked: number;
  appointmentsBookedPrev: number;
  hotLeads: number;
  hotLeadsPrev: number;
  leadDistribution: { hot: number; warm: number; cold: number; unscored: number };
  callsByDay: { date: string; count: number }[];
  callsByHour: { hour: number; day: number; count: number }[];
  neverrScoreByDay: { date: string; score: number }[];
  topCallers: { name: string; phone: string; count: number; lastCall: string; leadScore: string }[];
  callOutcomes: { outcome: string; count: number }[];
  transferStats?: {
    totalTransfers: number;
    transferRate: number;
    transferAnswerRate: number;
    topTransferReasons: { reason: string; count: number }[];
  };
  objectionStats?: {
    totalTriggered: number;
    totalConverted: number;
    conversionRate: number;
    byCategory: { category: string; triggered: number; converted: number }[];
  };
  satisfactionStats?: {
    sent: number;
    responded: number;
    responseRate: number;
    averageRating: number;
    distribution: Record<number, number>;
    lowRatings: number;
  } | null;
  competitorStats?: {
    totalMentions: number;
    totalCompetitors: number;
    callsWithMentions: number;
    mentionRate: number;
    topCompetitors: { name: string; mentions: number }[];
    mentionsByDay: { date: string; count: number }[];
  } | null;
  callerIntelligence?: {
    totalProfiles: number;
    vipCount: number;
    frequentCount: number;
    atRiskCount: number;
    avgLifetimeValue: number;
    returningCallers: number;
    returningRate: number;
    communicationStyles: { style: string; count: number }[];
    topVipCallers: { name: string; phone: string; total_calls: number; avg_satisfaction_rating: number; last_call_at: string }[];
    atRiskCallers: { name: string; phone: string; avg_sentiment_score: number; sentiment_trend: string; total_calls: number; last_call_at: string }[];
  } | null;
  recoveryStats?: {
    totalCampaigns: number;
    activeCampaigns: number;
    totalDormant: number;
    totalSent: number;
    totalResponded: number;
    responseRate: number;
    totalBooked: number;
    bookingRate: number;
    totalOptedOut: number;
    bestCampaign: { name: string; responseRate: number } | null;
  } | null;
  coachingStats?: {
    totalSessions: number;
    activeSessions: number;
    totalTips: number;
    avgDuration: number;
    topTrigger: string | null;
    triggerBreakdown: { type: string; count: number }[];
  } | null;
  culturalStats?: {
    diversityScore: number;
    languageCount: number;
    totalCallersWithCulture: number;
    culturalProfiles: { code: string; name: string; count: number }[];
    languageBreakdown: { code: string; name: string; count: number; percentage: number }[];
  } | null;
}

function scoreColor(score: number) {
  if (score >= 80) return { text: "text-green-600", bg: "bg-green-100", border: "border-green-300" };
  if (score >= 60) return { text: "text-amber-600", bg: "bg-amber-100", border: "border-amber-300" };
  return { text: "text-red-600", bg: "bg-red-100", border: "border-red-300" };
}

function scoreLineColor(score: number) {
  if (score >= 80) return "#16a34a";
  if (score >= 60) return "#d97706";
  return "#dc2626";
}

export default function Analytics() {
  const [range, setRange] = useState<RangeKey>("30");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();
  const { selectedLocationId } = useLocationCtx();
  const locParam = selectedLocationId === "all" ? undefined : selectedLocationId;

  useEffect(() => {
    setLoading(true);
    const { start, end } = getDateRange(range);
    getAnalytics(start, end, locParam)
      .then((res: any) => setData(res))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [range, locParam]);

  const heatmapData = useMemo(() => {
    if (!data) return [];
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    data.callsByHour.forEach(({ hour, day, count }) => {
      if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
        grid[day][hour] += count;
      }
    });
    return grid;
  }, [data]);

  const maxHeat = useMemo(() => Math.max(1, ...heatmapData.flat()), [heatmapData]);

  const currentScore = useMemo(() => {
    if (!data?.neverrScoreByDay?.length) return null;
    return data.neverrScoreByDay[data.neverrScoreByDay.length - 1].score;
  }, [data]);

  const leadDonutData = useMemo(() => {
    if (!data) return [];
    return [
      { name: "Hot", value: data.leadDistribution.hot, color: LEAD_COLORS.hot },
      { name: "Warm", value: data.leadDistribution.warm, color: LEAD_COLORS.warm },
      { name: "Cold", value: data.leadDistribution.cold, color: LEAD_COLORS.cold },
      { name: "Unscored", value: data.leadDistribution.unscored, color: LEAD_COLORS.unscored },
    ].filter((d) => d.value > 0);
  }, [data]);

  const totalLeads = useMemo(() => leadDonutData.reduce((a, b) => a + b.value, 0), [leadDonutData]);

  function exportCSV() {
    if (!data) return;
    const rows = [
      ["Metric", "Value"],
      ["Total Calls", String(data.totalCalls)],
      ["Appointments Booked", String(data.appointmentsBooked)],
      ["Hot Leads", String(data.hotLeads)],
      ["Lead Distribution - Hot", String(data.leadDistribution.hot)],
      ["Lead Distribution - Warm", String(data.leadDistribution.warm)],
      ["Lead Distribution - Cold", String(data.leadDistribution.cold)],
      ["Lead Distribution - Unscored", String(data.leadDistribution.unscored)],
      [""],
      ["Date", "Call Count"],
      ...data.callsByDay.map((d) => [d.date, String(d.count)]),
      [""],
      ["Outcome", "Count"],
      ...data.callOutcomes.map((o) => [o.outcome, String(o.count)]),
      [""],
      ["Date", "Neverr Score"],
      ...data.neverrScoreByDay.map((s) => [s.date, String(s.score)]),
      [""],
      ["Caller Name", "Phone", "Times Called", "Last Call", "Lead Score"],
      ...data.topCallers.map((c) => [c.name, c.phone, String(c.count), c.lastCall, c.leadScore]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `neverr-analytics-${range}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#2E75B6]" />
      </div>
    );
  }

  if (!data || data.totalCalls === 0) {
    return (
      <div className="p-6">
        <div className="flex items-center justify-between flex-wrap gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
            <p className="text-sm text-gray-500 mt-1">Your AI receptionist performance</p>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center max-w-lg mx-auto mt-12">
          <div className="text-5xl mb-4">📊</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No data yet</h3>
          <p className="text-sm text-gray-500">
            Your analytics will appear here once your AI receptionist starts handling calls.
          </p>
        </div>
      </div>
    );
  }

  const totalCallsChange = pctChange(data.totalCalls, data.totalCallsPrev);
  const apptsChange = pctChange(data.appointmentsBooked, data.appointmentsBookedPrev);
  const hotLeadsChange = pctChange(data.hotLeads, data.hotLeadsPrev);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">Your AI receptionist performance</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-white rounded-xl border border-gray-200 p-1">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  range === r.key ? "bg-[#2E75B6] text-white shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={exportCSV}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Download className="w-4 h-4" /> Export Report
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          {
            label: "Total Calls",
            value: data.totalCalls.toLocaleString(),
            change: totalCallsChange,
            icon: Phone,
            color: "blue",
            sub: "vs previous period",
          },
          {
            label: "Answer Rate",
            value: "100%",
            change: 0,
            icon: CheckCircle,
            color: "green",
            sub: "Every call answered instantly",
            hideChange: true,
          },
          {
            label: "Appointments Booked",
            value: data.appointmentsBooked.toLocaleString(),
            change: apptsChange,
            icon: CalendarCheck,
            color: "purple",
            sub: "vs previous period",
          },
          {
            label: "Hot Leads Captured",
            value: data.hotLeads.toLocaleString(),
            change: hotLeadsChange,
            icon: Flame,
            color: "red",
            sub: "vs previous period",
          },
        ].map((kpi) => {
          const Icon = kpi.icon;
          const up = kpi.change >= 0;
          const bgMap: Record<string, string> = {
            blue: "bg-blue-50",
            green: "bg-green-50",
            purple: "bg-purple-50",
            red: "bg-red-50",
          };
          const txtMap: Record<string, string> = {
            blue: "text-blue-600",
            green: "text-green-600",
            purple: "text-purple-600",
            red: "text-red-600",
          };
          return (
            <div key={kpi.label} className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bgMap[kpi.color]}`}>
                  <Icon className={`w-5 h-5 ${txtMap[kpi.color]}`} />
                </div>
                {!kpi.hideChange && (
                  <span
                    className={`flex items-center gap-0.5 text-xs font-medium ${
                      up ? "text-green-600" : "text-red-500"
                    }`}
                  >
                    {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {Math.abs(kpi.change)}%
                  </span>
                )}
              </div>
              <p className="text-2xl font-bold text-gray-900">{kpi.value}</p>
              <p className="text-xs text-gray-500 mt-1">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Call Volume Chart */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-4">Call Volume Over Time</h3>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.callsByDay}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
              />
              <Tooltip
                labelFormatter={(label) => {
                  const d = new Date(label);
                  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                }}
                contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "12px" }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#2E75B6"
                strokeWidth={2}
                dot={data.callsByDay.length <= 14}
                activeDot={{ r: 5, fill: "#2E75B6" }}
                name="Calls"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Lead Distribution + Call Outcomes side by side */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Lead Score Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Lead Score Distribution</h3>
          <div className="flex items-center gap-6">
            <div className="w-44 h-44 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={leadDonutData}
                    cx="50%"
                    cy="50%"
                    innerRadius={45}
                    outerRadius={70}
                    dataKey="value"
                    strokeWidth={0}
                  >
                    {leadDonutData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      `${value} (${totalLeads > 0 ? Math.round((value / totalLeads) * 100) : 0}%)`,
                      name,
                    ]}
                    contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "12px" }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-2.5">
              {[
                { label: "Hot Leads", value: data.leadDistribution.hot, color: LEAD_COLORS.hot },
                { label: "Warm Leads", value: data.leadDistribution.warm, color: LEAD_COLORS.warm },
                { label: "Cold Leads", value: data.leadDistribution.cold, color: LEAD_COLORS.cold },
                { label: "Unscored", value: data.leadDistribution.unscored, color: LEAD_COLORS.unscored },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="text-xs text-gray-700">{item.label}</span>
                  </div>
                  <div className="text-xs">
                    <span className="font-medium text-gray-900">{item.value}</span>
                    <span className="text-gray-400 ml-1">
                      ({totalLeads > 0 ? Math.round((item.value / totalLeads) * 100) : 0}%)
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Call Outcomes */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Call Outcomes</h3>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.callOutcomes} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" horizontal={false} />
                <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: "#6b7280" }} />
                <YAxis
                  dataKey="outcome"
                  type="category"
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                  width={130}
                  tickLine={false}
                />
                <Tooltip contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "12px" }} />
                <Bar dataKey="count" fill="#2E75B6" radius={[0, 4, 4, 0]} barSize={18} name="Calls" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {data.transferStats && data.transferStats.totalTransfers > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <PhoneForwarded className="w-4 h-4 text-[#2E75B6]" />
            <h3 className="text-sm font-semibold text-gray-900">Call Transfers</h3>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-[#2E75B6]">{data.transferStats.totalTransfers}</p>
              <p className="text-xs text-gray-500 mt-1">Total Transfers</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-[#2E75B6]">{data.transferStats.transferRate}%</p>
              <p className="text-xs text-gray-500 mt-1">Transfer Rate</p>
            </div>
            <div className="bg-green-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{data.transferStats.transferAnswerRate}%</p>
              <p className="text-xs text-gray-500 mt-1">Answer Rate</p>
            </div>
          </div>
          {data.transferStats.topTransferReasons.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Top Transfer Reasons</p>
              <div className="space-y-1.5">
                {data.transferStats.topTransferReasons.slice(0, 5).map((r) => (
                  <div key={r.reason} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                    <span className="text-xs text-gray-700">{r.reason}</span>
                    <span className="text-xs font-semibold text-gray-900">{r.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {data.objectionStats && data.objectionStats.totalTriggered > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Brain className="w-4 h-4 text-purple-600" />
            <h3 className="text-sm font-semibold text-gray-900">Objection Intelligence</h3>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-purple-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-purple-700">{data.objectionStats.totalTriggered}</p>
              <p className="text-xs text-gray-500 mt-1">Objections Handled</p>
            </div>
            <div className="bg-green-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-green-600">{data.objectionStats.totalConverted}</p>
              <p className="text-xs text-gray-500 mt-1">Converted</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-[#2E75B6]">{data.objectionStats.conversionRate}%</p>
              <p className="text-xs text-gray-500 mt-1">Conversion Rate</p>
            </div>
          </div>
          {data.objectionStats.byCategory.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">By Category</p>
              <div className="space-y-1.5">
                {data.objectionStats.byCategory.slice(0, 6).map((c) => {
                  const rate = c.triggered > 0 ? Math.round((c.converted / c.triggered) * 100) : 0;
                  return (
                    <div key={c.category} className="flex items-center justify-between px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-700 capitalize">{c.category}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-gray-400">{c.triggered} handled</span>
                        <span className="text-xs font-semibold text-green-600">{rate}% converted</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {data.satisfactionStats && data.satisfactionStats.sent > 0 && (() => {
        const s = data.satisfactionStats!;
        const ratingColor = s.averageRating >= 4.0 ? "text-green-600" : s.averageRating >= 3.0 ? "text-amber-600" : "text-red-600";
        const ratingBg = s.averageRating >= 4.0 ? "bg-green-50" : s.averageRating >= 3.0 ? "bg-amber-50" : "bg-red-50";
        const maxDist = Math.max(...Object.values(s.distribution), 1);
        const starLabels: Record<number, string> = { 5: "Excellent", 4: "Good", 3: "OK", 2: "Poor", 1: "Bad" };
        return (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Star className="w-4 h-4 text-amber-500" />
              <h3 className="text-sm font-semibold text-gray-900">Customer Satisfaction</h3>
            </div>

            <div className="flex items-center gap-6 mb-5">
              <div className={`${ratingBg} rounded-2xl p-5 text-center min-w-[120px]`}>
                <p className={`text-4xl font-extrabold ${ratingColor}`}>{s.averageRating.toFixed(1)}</p>
                <div className="flex items-center justify-center gap-0.5 mt-1">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Star key={i} className={`w-3.5 h-3.5 ${i <= Math.round(s.averageRating) ? "text-amber-400 fill-amber-400" : "text-gray-300"}`} />
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-1">out of 5.0</p>
              </div>
              <div className="grid grid-cols-2 gap-3 flex-1">
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">{s.sent}</p>
                  <p className="text-xs text-gray-500">Surveys Sent</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-[#2E75B6]">{s.responseRate}%</p>
                  <p className="text-xs text-gray-500">Response Rate</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className="text-lg font-bold text-gray-900">{s.responded}</p>
                  <p className="text-xs text-gray-500">Responses</p>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 text-center">
                  <p className={`text-lg font-bold ${s.lowRatings > 0 ? "text-red-600" : "text-green-600"}`}>{s.lowRatings}</p>
                  <p className="text-xs text-gray-500">Low Ratings (1-2)</p>
                </div>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Rating Distribution</p>
              <div className="space-y-1.5">
                {[5, 4, 3, 2, 1].map((star) => {
                  const count = s.distribution[star] || 0;
                  const pct = s.responded > 0 ? Math.round((count / s.responded) * 100) : 0;
                  const barWidth = maxDist > 0 ? Math.round((count / maxDist) * 100) : 0;
                  const barColor = star >= 4 ? "bg-green-400" : star === 3 ? "bg-amber-400" : "bg-red-400";
                  return (
                    <div key={star} className="flex items-center gap-2">
                      <div className="flex items-center gap-0.5 w-16 shrink-0">
                        <span className="text-xs font-medium text-gray-700">{star}</span>
                        <Star className="w-3 h-3 text-amber-400 fill-amber-400" />
                        <span className="text-[10px] text-gray-400">{starLabels[star]}</span>
                      </div>
                      <div className="flex-1 bg-gray-100 rounded-full h-4 relative overflow-hidden">
                        <div className={`${barColor} h-full rounded-full transition-all`} style={{ width: `${barWidth}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-12 text-right">{count} ({pct}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {data.competitorStats && data.competitorStats.totalMentions > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Swords className="w-4 h-4 text-orange-600" />
            <h3 className="text-sm font-semibold text-gray-900">Competitive Intelligence</h3>
          </div>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-orange-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-orange-700">{data.competitorStats.totalMentions}</p>
              <p className="text-xs text-gray-500 mt-1">Total Mentions</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-[#2E75B6]">{data.competitorStats.callsWithMentions}</p>
              <p className="text-xs text-gray-500 mt-1">Calls with Mentions</p>
            </div>
            <div className="bg-amber-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-amber-700">{data.competitorStats.mentionRate}%</p>
              <p className="text-xs text-gray-500 mt-1">Mention Rate</p>
            </div>
          </div>
          {data.competitorStats.topCompetitors.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-2">Most Mentioned Competitors</p>
              <div className="space-y-1.5">
                {data.competitorStats.topCompetitors.map((c, i) => {
                  const maxMentions = data.competitorStats!.topCompetitors[0]?.mentions || 1;
                  const pct = Math.round((c.mentions / maxMentions) * 100);
                  return (
                    <div key={c.name} className="relative">
                      <div className="flex items-center justify-between px-3 py-2.5 bg-gray-50 rounded-lg relative z-10">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-gray-400 w-4">#{i + 1}</span>
                          <span className="text-xs font-medium text-gray-700">{c.name}</span>
                        </div>
                        <span className="text-xs font-semibold text-orange-700">{c.mentions} mention{c.mentions !== 1 ? "s" : ""}</span>
                      </div>
                      <div
                        className="absolute inset-y-0 left-0 bg-orange-100/50 rounded-lg"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {data.callerIntelligence && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Dna className="w-4 h-4 text-[#2E75B6]" />
            <h3 className="text-sm font-semibold text-gray-900">Caller Intelligence</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-[#2E75B6]">{data.callerIntelligence.totalProfiles}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Unique Callers</p>
            </div>
            <div className="bg-yellow-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-yellow-700">{data.callerIntelligence.vipCount}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">VIP Callers ({data.callerIntelligence.totalProfiles > 0 ? Math.round((data.callerIntelligence.vipCount / data.callerIntelligence.totalProfiles) * 100) : 0}%)</p>
            </div>
            <div className="bg-red-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-red-600">{data.callerIntelligence.atRiskCount}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">At Risk</p>
            </div>
            <div className="bg-green-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-green-700">{data.callerIntelligence.returningRate}%</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Returning Callers</p>
            </div>
          </div>

          {data.callerIntelligence.communicationStyles.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-medium text-gray-500 mb-2">Communication Style Distribution</p>
              <div className="flex gap-1.5 flex-wrap">
                {data.callerIntelligence.communicationStyles
                  .filter(s => s.style !== 'Unknown')
                  .map(s => {
                    const total = data.callerIntelligence!.totalProfiles;
                    const pct = total > 0 ? Math.round((s.count / total) * 100) : 0;
                    const colors: Record<string, string> = {
                      Direct: 'bg-blue-100 text-blue-700',
                      Chatty: 'bg-purple-100 text-purple-700',
                      Formal: 'bg-slate-100 text-slate-700',
                      Rushed: 'bg-red-100 text-red-700',
                      Casual: 'bg-green-100 text-green-700',
                    };
                    return (
                      <span key={s.style} className={`px-2.5 py-1 rounded-lg text-xs font-medium ${colors[s.style] || 'bg-gray-100 text-gray-700'}`}>
                        {s.style}: {s.count} ({pct}%)
                      </span>
                    );
                  })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {data.callerIntelligence.topVipCallers.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1.5">
                  <Star className="w-3 h-3 text-yellow-500" /> Top VIP Callers
                </p>
                <div className="space-y-1.5">
                  {data.callerIntelligence.topVipCallers.map(c => (
                    <div key={c.phone} className="flex items-center justify-between p-2 bg-yellow-50/50 rounded-lg">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">{c.name || 'Unknown'}</p>
                        <p className="text-[10px] text-gray-400">{c.phone}</p>
                      </div>
                      <span className="text-[10px] font-semibold text-gray-600 flex-shrink-0 ml-2">{c.total_calls} calls</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.callerIntelligence.atRiskCallers.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 mb-2 flex items-center gap-1.5">
                  <ShieldAlert className="w-3 h-3 text-red-500" /> At-Risk Callers
                </p>
                <div className="space-y-1.5">
                  {data.callerIntelligence.atRiskCallers.map(c => (
                    <div key={c.phone} className="flex items-center justify-between p-2 bg-red-50/50 rounded-lg">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">{c.name || 'Unknown'}</p>
                        <p className="text-[10px] text-gray-400">{c.phone}</p>
                      </div>
                      <span className="text-[10px] font-medium text-red-600 flex-shrink-0 ml-2">Score: {c.avg_sentiment_score}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {data.recoveryStats && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <RefreshCw className="w-4 h-4 text-green-600" />
            <h3 className="text-sm font-semibold text-gray-900">Revenue Recovery</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-[#2E75B6]">{data.recoveryStats.totalDormant}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Dormant Identified</p>
            </div>
            <div className="bg-purple-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-purple-700">{data.recoveryStats.totalSent}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Messages Sent</p>
            </div>
            <div className="bg-green-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-green-700">{data.recoveryStats.totalResponded}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Re-engaged ({data.recoveryStats.responseRate}%)</p>
            </div>
            <div className="bg-amber-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-amber-700">{data.recoveryStats.totalBooked}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Booked ({data.recoveryStats.bookingRate}%)</p>
            </div>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500">{data.recoveryStats.totalCampaigns} campaign{data.recoveryStats.totalCampaigns !== 1 ? "s" : ""} ({data.recoveryStats.activeCampaigns} active)</span>
            {data.recoveryStats.bestCampaign && (
              <span className="text-gray-500">Best: <span className="font-medium text-gray-700">{data.recoveryStats.bestCampaign.name}</span> ({data.recoveryStats.bestCampaign.responseRate}% response)</span>
            )}
          </div>
        </div>
      )}

      {data.coachingStats && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Headphones className="w-4 h-4 text-indigo-600" />
            <h3 className="text-sm font-semibold text-gray-900">Coaching Performance</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <div className="bg-indigo-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-indigo-700">{data.coachingStats.totalSessions}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Sessions This Month</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-[#2E75B6]">{data.coachingStats.totalTips}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Tips Sent</p>
            </div>
            <div className="bg-purple-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-purple-700">{data.coachingStats.topTrigger ? data.coachingStats.topTrigger.replace(/_/g, " ") : "—"}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Most Common Trigger</p>
            </div>
            <div className="bg-green-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-green-700">{data.coachingStats.avgDuration > 0 ? `${Math.floor(data.coachingStats.avgDuration / 60)}m` : "—"}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Avg Session Duration</p>
            </div>
          </div>
          {data.coachingStats.triggerBreakdown.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-gray-700 mb-2">Tips by Trigger Type</p>
              {data.coachingStats.triggerBreakdown.map((t) => {
                const maxCount = Math.max(...data.coachingStats!.triggerBreakdown.map(b => b.count));
                return (
                  <div key={t.type} className="flex items-center gap-2">
                    <span className="text-xs text-gray-600 w-28 truncate">{t.type.replace(/_/g, " ")}</span>
                    <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                      <div className="bg-indigo-500 h-2.5 rounded-full" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                    </div>
                    <span className="text-xs font-medium text-gray-700 w-8 text-right">{t.count}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <WidgetAnalyticsSection />

      {data.culturalStats && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-gray-900">Language & Cultural Intelligence</h3>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-emerald-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-emerald-700">{data.culturalStats.diversityScore}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Cultural Diversity Score</p>
            </div>
            <div className="bg-blue-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-blue-700">{data.culturalStats.languageCount}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Languages Served</p>
            </div>
            <div className="bg-purple-50 rounded-xl p-3 text-center">
              <p className="text-xl font-bold text-purple-700">{data.culturalStats.totalCallersWithCulture}</p>
              <p className="text-[10px] text-gray-500 mt-0.5">Callers Profiled</p>
            </div>
          </div>
          {data.culturalStats.languageBreakdown.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-medium text-gray-700 mb-2">Languages Served</p>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.culturalStats.languageBreakdown.map(l => ({ name: l.name, value: l.count }))}
                      cx="50%"
                      cy="50%"
                      innerRadius={35}
                      outerRadius={65}
                      dataKey="value"
                      label={({ name, percentage }: any) => {
                        const lang = data.culturalStats!.languageBreakdown.find(l => l.name === name);
                        return `${name} ${lang?.percentage || 0}%`;
                      }}
                    >
                      {data.culturalStats.languageBreakdown.map((_, i) => (
                        <Cell key={i} fill={["#10b981", "#3b82f6", "#8b5cf6", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"][i % 8]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
          {data.culturalStats.culturalProfiles.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-700 mb-2">Cultural Profiles Detected</p>
              <div className="space-y-1.5">
                {data.culturalStats.culturalProfiles.map((p) => {
                  const maxCount = Math.max(...data.culturalStats!.culturalProfiles.map(x => x.count));
                  return (
                    <div key={p.code} className="flex items-center gap-2">
                      <span className="text-xs text-gray-600 w-40 truncate" title={p.name}>{p.name}</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                        <div className="bg-emerald-500 h-2.5 rounded-full" style={{ width: `${(p.count / maxCount) * 100}%` }} />
                      </div>
                      <span className="text-xs font-medium text-gray-700 w-8 text-right">{p.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {data.culturalStats.diversityScore >= 3 && (
            <div className="mt-3 p-2.5 bg-emerald-50 rounded-lg border border-emerald-100">
              <p className="text-xs text-emerald-800">
                You serve callers from <strong>{data.culturalStats.diversityScore}</strong> cultural backgrounds across{" "}
                <strong>{data.culturalStats.languageCount}</strong> languages. Neverr automatically adapts communication style for each caller.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Busiest Hours Heatmap */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-900 mb-1">Busiest Call Hours</h3>
        <p className="text-xs text-gray-400 mb-4">Call volume by hour and day of week — darker = more calls</p>
        <div className="overflow-x-auto">
          <div className="min-w-[700px]">
            <div className="flex mb-1 ml-10">
              {HOUR_LABELS.map((label, i) => (
                <div key={i} className="flex-1 text-center text-[10px] text-gray-400">
                  {label}
                </div>
              ))}
            </div>
            {[1, 2, 3, 4, 5, 6, 0].map((dayIdx) => (
              <div key={dayIdx} className="flex items-center gap-1 mb-0.5">
                <div className="w-9 text-xs text-gray-500 font-medium text-right pr-1 shrink-0">
                  {DOW[dayIdx]}
                </div>
                <div className="flex flex-1 gap-0.5">
                  {Array.from({ length: 24 }, (_, hour) => {
                    const v = heatmapData[dayIdx]?.[hour] || 0;
                    const intensity = v / maxHeat;
                    let bg = "bg-gray-50";
                    if (v > 0) {
                      if (intensity < 0.25) bg = "bg-blue-100";
                      else if (intensity < 0.5) bg = "bg-blue-200";
                      else if (intensity < 0.75) bg = "bg-blue-400";
                      else bg = "bg-blue-600";
                    }
                    return (
                      <div
                        key={hour}
                        className={`flex-1 h-7 rounded-sm ${bg} flex items-center justify-center cursor-default`}
                        title={`${DOW[dayIdx]} ${fmtHour(hour)}: ${v} calls`}
                      >
                        {v > 0 && (
                          <span
                            className={`text-[9px] font-medium ${intensity >= 0.5 ? "text-white" : "text-blue-700"}`}
                          >
                            {v}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Neverr Score Trend */}
      {data.neverrScoreByDay.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Your Neverr Score Over Time</h3>
              <p className="text-xs text-gray-400 mt-0.5">
                Based on answer rate, lead capture, booking rate, and caller sentiment
              </p>
            </div>
            {currentScore !== null && (
              <div className="flex items-center gap-2">
                <span className={`text-3xl font-extrabold ${scoreColor(currentScore).text}`}>{currentScore}</span>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${scoreColor(currentScore).bg} ${scoreColor(currentScore).text} border ${scoreColor(currentScore).border}`}
                >
                  {currentScore >= 80 ? "Excellent" : currentScore >= 60 ? "Good" : "Needs Work"}
                </span>
              </div>
            )}
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.neverrScoreByDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: 11, fill: "#6b7280" }}
                  tickLine={false}
                />
                <Tooltip
                  labelFormatter={(label) => new Date(label).toLocaleDateString()}
                  formatter={(value: number) => [`${value}/100`, "Score"]}
                  contentStyle={{ borderRadius: "8px", border: "1px solid #e5e7eb", fontSize: "12px" }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  stroke={currentScore !== null ? scoreLineColor(currentScore) : "#2E75B6"}
                  strokeWidth={2}
                  dot={data.neverrScoreByDay.length <= 14}
                  activeDot={{ r: 5 }}
                  name="Score"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Top Callers Table */}
      {data.topCallers.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Most Frequent Callers</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Caller Name
                  </th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Phone
                  </th>
                  <th className="text-center py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Times Called
                  </th>
                  <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Last Call
                  </th>
                  <th className="text-center py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Lead Score
                  </th>
                  <th className="text-right py-2 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.topCallers.map((caller, i) => {
                  const scoreBadge =
                    caller.leadScore === "hot"
                      ? { bg: "bg-red-100", text: "text-red-700", label: "Hot" }
                      : caller.leadScore === "warm"
                        ? { bg: "bg-amber-100", text: "text-amber-700", label: "Warm" }
                        : { bg: "bg-blue-100", text: "text-blue-700", label: "Cold" };
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-3 font-medium text-gray-900">{caller.name}</td>
                      <td className="py-3 px-3 text-gray-600">{caller.phone}</td>
                      <td className="py-3 px-3 text-center font-semibold text-gray-900">{caller.count}</td>
                      <td className="py-3 px-3 text-gray-500">
                        {new Date(caller.lastCall).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${scoreBadge.bg} ${scoreBadge.text}`}
                        >
                          {scoreBadge.label}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right">
                        <button
                          onClick={() => navigate(`/contacts?search=${encodeURIComponent(caller.phone)}`)}
                          className="text-xs text-[#2E75B6] font-medium hover:underline"
                        >
                          View History
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function WidgetAnalyticsSection() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const businessId = localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "";
    const token = localStorage.getItem("neverr_token") || "";
    if (!businessId) { setLoading(false); return; }
    fetch(`/api/widget/analytics/${businessId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { setStats(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return null;
  if (!stats || (stats.opens === 0 && stats.conversations === 0)) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-center gap-2 mb-4">
        <Globe className="w-4 h-4 text-[#2E75B6]" />
        <h3 className="text-sm font-semibold text-gray-900">Website Widget</h3>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          { label: "Opens", value: stats.opens, color: "bg-blue-50 text-blue-700" },
          { label: "Conversations", value: stats.conversations, color: "bg-emerald-50 text-emerald-700" },
          { label: "Leads", value: stats.leads, color: "bg-amber-50 text-amber-700" },
          { label: "Bookings", value: stats.bookings, color: "bg-purple-50 text-purple-700" },
        ].map(s => (
          <div key={s.label} className={`${s.color} rounded-xl p-3 text-center`}>
            <p className="text-xl font-bold">{s.value}</p>
            <p className="text-[10px] mt-0.5 opacity-80">{s.label}</p>
          </div>
        ))}
      </div>
      {stats.avgDuration > 0 && (
        <p className="text-xs text-gray-500 mb-3">Avg conversation: {Math.floor(stats.avgDuration / 60)}m {stats.avgDuration % 60}s</p>
      )}
      {stats.topPages?.length > 0 && (
        <div className="mt-3">
          <p className="text-[11px] font-semibold text-gray-500 uppercase mb-2">Top pages</p>
          <ul className="space-y-1">
            {stats.topPages.slice(0, 5).map((p: any, i: number) => (
              <li key={i} className="text-xs text-gray-700 flex justify-between">
                <span className="truncate max-w-md">{p.page_url}</span>
                <span className="font-semibold ml-2">{p.n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
