import { useEffect, useState } from "react";
import { getBenchmarkReport, generateBenchmarks } from "../lib/api";
import {
  Phone,
  Target,
  Calendar,
  Clock,
  Star,
  Flame,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  Loader2,
  RefreshCw,
  Award,
  AlertTriangle,
  Lightbulb,
  BarChart3,
  UserX,
} from "lucide-react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  Legend,
  ResponsiveContainer,
} from "recharts";

type MetricData = {
  label: string;
  mine: number;
  industry_avg: number;
  industry_top: number;
  rank: number;
  lower_is_better?: boolean;
};

type BenchmarkReport = {
  period: string;
  industry: string;
  business_name: string;
  sample_size: number;
  metrics: MetricData[];
  insights: string[];
  recommendations: string[];
  generated_at: string;
};

function formatIndustry(id: string): string {
  return id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function getMonthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function getPeriodOptions(): { value: string; label: string }[] {
  const opts = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    opts.push({ value: val, label: getMonthLabel(val) });
  }
  return opts;
}

const METRIC_ICONS: Record<string, any> = {
  "Monthly Call Volume": Phone,
  "Lead Capture Rate": Target,
  "Appointment Booking Rate": Calendar,
  "No-Show Rate": UserX,
  "Avg Call Duration": Clock,
  "Satisfaction Rating": Star,
  "Hot Lead Percentage": Flame,
};

const METRIC_COLORS: Record<string, string> = {
  "Monthly Call Volume": "blue",
  "Lead Capture Rate": "purple",
  "Appointment Booking Rate": "green",
  "No-Show Rate": "red",
  "Avg Call Duration": "amber",
  "Satisfaction Rating": "yellow",
  "Hot Lead Percentage": "orange",
};

function formatMetricValue(label: string, value: number): string {
  if (label.includes("Rate") || label.includes("Percentage")) return `${value}%`;
  if (label.includes("Duration")) return `${value}s`;
  if (label.includes("Satisfaction")) return `${value}/5`;
  return String(value);
}

export default function Benchmarks() {
  const periods = getPeriodOptions();
  const [period, setPeriod] = useState(periods[0]?.value || "");
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [noData, setNoData] = useState(false);

  useEffect(() => {
    if (!period) return;
    setLoading(true);
    setNoData(false);
    getBenchmarkReport(period)
      .then((d) => {
        if (d.report) {
          setReport(d.report);
          setNoData(false);
        } else {
          setReport(null);
          setNoData(true);
        }
      })
      .catch(() => { setReport(null); setNoData(true); })
      .finally(() => setLoading(false));
  }, [period]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const d = await generateBenchmarks(period);
      if (d.report) { setReport(d.report); setNoData(false); }
    } catch {}
    setGenerating(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-[#2E75B6] animate-spin" />
      </div>
    );
  }

  const radarData = report?.metrics.map(m => ({
    metric: m.label.replace("Appointment ", "").replace("Monthly ", "").replace("Avg ", "").replace(" Percentage", " %"),
    you: m.lower_is_better ? (m.industry_avg > 0 ? Math.round(((m.industry_avg * 2 - m.mine) / (m.industry_avg * 2)) * 100) : 50) : (m.industry_avg > 0 ? Math.round((m.mine / (m.industry_avg * 2)) * 100) : 50),
    industry: 50,
  })) || [];

  const wins = report?.metrics.filter(m => m.lower_is_better ? m.mine < m.industry_avg : m.mine > m.industry_avg) || [];
  const winsCount = wins.length;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Industry Benchmarks</h1>
          <p className="text-sm text-gray-500 mt-1">
            {report ? (
              <>See how <span className="font-medium text-gray-700">{report.business_name}</span> compares to other <span className="font-medium text-gray-700">{formatIndustry(report.industry)}</span> businesses</>
            ) : "Compare your performance to industry peers"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="appearance-none bg-white border border-gray-200 rounded-xl px-4 py-2 pr-8 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-[#2E75B6]/30 focus:border-[#2E75B6] outline-none"
            >
              {periods.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50"
          >
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Generate
          </button>
        </div>
      </div>

      {report && report.sample_size > 0 && (
        <p className="text-xs text-gray-400 -mt-4">{formatIndustry(report.industry)} · {report.sample_size} businesses compared · Data anonymized</p>
      )}

      {noData && !report && (
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <BarChart3 className="w-8 h-8 text-[#2E75B6]" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No benchmark data yet</h3>
          <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
            Benchmarks require at least 3 businesses in your industry with 10+ calls. Click Generate to calculate now, or data will auto-calculate on the 1st of each month.
          </p>
          <button onClick={handleGenerate} disabled={generating} className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Generate Benchmarks
          </button>
        </div>
      )}

      {report && (
        <>
          {winsCount > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 flex items-center gap-3">
              <Award className="w-5 h-5 text-green-600 flex-shrink-0" />
              <p className="text-sm text-green-800">
                You're outperforming the industry average on <span className="font-bold">{winsCount} out of {report.metrics.length}</span> metrics this month!
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {report.metrics.map((m) => {
              const Icon = METRIC_ICONS[m.label] || TrendingUp;
              const color = METRIC_COLORS[m.label] || "blue";
              const isWin = m.lower_is_better ? m.mine < m.industry_avg : m.mine > m.industry_avg;
              const barMax = Math.max(m.mine, m.industry_avg, m.industry_top) || 1;

              return (
                <div key={m.label} className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon className={`w-4 h-4 text-${color}-600`} />
                    <h3 className="text-sm font-semibold text-gray-900">{m.label}</h3>
                    {isWin && <span className="ml-auto text-[10px] font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">Top {100 - m.rank}%</span>}
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-24 flex-shrink-0">You</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                        <div className={`h-full rounded-full ${isWin ? "bg-green-500" : "bg-amber-500"}`} style={{ width: `${Math.min(100, (m.mine / barMax) * 100)}%` }} />
                      </div>
                      <span className="text-sm font-bold text-gray-900 w-14 text-right">{formatMetricValue(m.label, m.mine)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-24 flex-shrink-0">Industry avg</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                        <div className="h-full rounded-full bg-gray-400" style={{ width: `${Math.min(100, (m.industry_avg / barMax) * 100)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-14 text-right">{formatMetricValue(m.label, m.industry_avg)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-24 flex-shrink-0">Top 25%</span>
                      <div className="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                        <div className="h-full rounded-full bg-[#2E75B6]" style={{ width: `${Math.min(100, (m.industry_top / barMax) * 100)}%` }} />
                      </div>
                      <span className="text-xs text-gray-500 w-14 text-right">{formatMetricValue(m.label, m.industry_top)}</span>
                    </div>
                  </div>

                  {m.lower_is_better && (
                    <p className="text-[10px] text-gray-400 mt-2 italic">Lower is better</p>
                  )}
                </div>
              );
            })}
          </div>

          {radarData.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-4">Performance Overview</h3>
              <ResponsiveContainer width="100%" height={350}>
                <RadarChart data={radarData}>
                  <PolarGrid stroke="#e5e7eb" />
                  <PolarAngleAxis dataKey="metric" tick={{ fontSize: 11, fill: "#6b7280" }} />
                  <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar name="You" dataKey="you" stroke="#2E75B6" fill="#2E75B6" fillOpacity={0.2} strokeWidth={2} />
                  <Radar name="Industry Avg" dataKey="industry" stroke="#9ca3af" fill="#9ca3af" fillOpacity={0.1} strokeWidth={1} strokeDasharray="4 4" />
                  <Legend iconSize={10} wrapperStyle={{ fontSize: 12 }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          )}

          {report.insights.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb className="w-4 h-4 text-amber-500" />
                <h3 className="text-sm font-semibold text-gray-900">Insights</h3>
              </div>
              <div className="space-y-2">
                {report.insights.map((insight, i) => (
                  <div key={i} className="flex items-start gap-2.5 p-2.5 bg-amber-50/50 rounded-lg">
                    <TrendingUp className="w-3.5 h-3.5 text-amber-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-gray-700">{insight}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report.recommendations.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-4 h-4 text-orange-500" />
                <h3 className="text-sm font-semibold text-gray-900">Recommendations</h3>
              </div>
              <div className="space-y-2">
                {report.recommendations.map((rec, i) => (
                  <div key={i} className="flex items-start gap-2.5 p-2.5 bg-orange-50/50 rounded-lg">
                    <TrendingDown className="w-3.5 h-3.5 text-orange-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-gray-700">{rec}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
