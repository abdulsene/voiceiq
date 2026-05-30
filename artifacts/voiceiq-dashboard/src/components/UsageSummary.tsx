import { useEffect, useState } from "react";
import { getUsage } from "../lib/api";
import { Phone, MessageSquare, TrendingUp, AlertTriangle } from "lucide-react";

interface UsageData {
  plan_id: string;
  included_minutes: number;
  included_sms: number;
  minutes_used_this_month: number;
  sms_sent_this_month: number;
  calls_this_month: number;
  minutes_pct: number;
  sms_pct: number;
  overage_minutes: number;
  overage_sms: number;
  estimated_overage_charge: number;
}

function getBarColor(pct: number) {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 70) return "bg-amber-500";
  return "bg-[#2E75B6]";
}

function getBarBg(pct: number) {
  if (pct >= 90) return "bg-red-50";
  if (pct >= 70) return "bg-amber-50";
  return "bg-gray-100";
}

const PLAN_NAMES: Record<string, string> = {
  essential: "Essential",
  starter: "Starter",
  professional: "Professional",
  growth: "Growth",
  business: "Business",
  enterprise: "Enterprise",
};

export default function UsageSummary() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const businessId = localStorage.getItem("neverr_active_business_id") || localStorage.getItem("neverr_business_id") || "demo-business";
    getUsage(businessId)
      .then((data) => setUsage(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm animate-pulse mb-5">
        <div className="h-4 w-32 bg-gray-100 rounded mb-4" />
        <div className="space-y-3">
          <div className="h-3 w-full bg-gray-100 rounded" />
          <div className="h-3 w-full bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  if (!usage) return null;

  const showUpgrade = usage.minutes_pct >= 80 || usage.sms_pct >= 80;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 shadow-sm mb-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-semibold text-gray-900">Usage This Month</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 bg-gray-50 px-2 py-0.5 rounded-full capitalize">
            {PLAN_NAMES[usage.plan_id] || usage.plan_id} Plan
          </span>
          <a href="#/pricing" className="text-[11px] text-[#2E75B6] hover:underline font-medium">
            Change plan →
          </a>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-600">Minutes</span>
            </div>
            <span className="text-xs font-semibold text-gray-700">
              {Math.round(usage.minutes_used_this_month)} / {usage.included_minutes.toLocaleString()} min
            </span>
          </div>
          <div className={`w-full h-2.5 rounded-full ${getBarBg(usage.minutes_pct)}`}>
            <div
              className={`h-full rounded-full transition-all duration-500 ${getBarColor(usage.minutes_pct)}`}
              style={{ width: `${Math.min(usage.minutes_pct, 100)}%` }}
            />
          </div>
          {usage.overage_minutes > 0 && (
            <p className="text-[10px] text-red-500 mt-1">
              {usage.overage_minutes} overage min × ${usage.plan_id === "essential" ? "0.15" : "0.12"}/min
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5 text-gray-400" />
              <span className="text-xs font-medium text-gray-600">SMS</span>
            </div>
            <span className="text-xs font-semibold text-gray-700">
              {usage.sms_sent_this_month.toLocaleString()} / {usage.included_sms.toLocaleString()}
            </span>
          </div>
          <div className={`w-full h-2.5 rounded-full ${getBarBg(usage.sms_pct)}`}>
            <div
              className={`h-full rounded-full transition-all duration-500 ${getBarColor(usage.sms_pct)}`}
              style={{ width: `${Math.min(usage.sms_pct, 100)}%` }}
            />
          </div>
          {usage.overage_sms > 0 && (
            <p className="text-[10px] text-red-500 mt-1">
              {usage.overage_sms} overage SMS
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-50">
        <span className="text-[11px] text-gray-400">
          {usage.calls_this_month} call{usage.calls_this_month !== 1 ? "s" : ""} handled
        </span>
        {usage.estimated_overage_charge > 0 && (
          <span className="text-[11px] font-medium text-red-500">
            Est. overage: ${usage.estimated_overage_charge.toFixed(2)}
          </span>
        )}
      </div>

      {showUpgrade && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span className="text-[11px] text-amber-700">
            You're approaching your plan limit.{" "}
            <a href="#/pricing" className="font-semibold text-amber-800 hover:underline">
              Upgrade your plan
            </a>
          </span>
        </div>
      )}
    </div>
  );
}
