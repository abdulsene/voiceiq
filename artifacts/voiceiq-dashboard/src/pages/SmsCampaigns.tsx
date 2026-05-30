import { useEffect, useState, useCallback, useRef } from "react";
import {
  getCampaigns,
  sendCampaign,
  getSmsRecipients,
  getSmsUsageCheck,
  getSmsOptOuts,
  getSmsReplies,
  getSmsConversations,
  getSmsThread,
  sendSmsReply,
  getBusinessConfig,
  getRecoveryCampaigns,
  createRecoveryCampaign,
  updateRecoveryCampaign,
  deleteRecoveryCampaign,
  launchRecoveryCampaign,
  getRecoveryEstimate,
} from "../lib/api";
import {
  MessageSquare,
  Plus,
  Send,
  Clock,
  CheckCircle,
  XCircle,
  Users,
  X,
  Copy,
  BarChart3,
  Inbox,
  Megaphone,
  ChevronRight,
  AlertCircle,
  Smartphone,
  Eye,
  Flame,
  Sun,
  CalendarOff,
  UserCheck,
  Loader2,
  ArrowUpRight,
  Ban,
  Reply,
  ExternalLink,
  ArrowLeft,
  Lock,
  Zap,
  DollarSign,
  Target,
  Star,
  Pause,
  Play,
  Trash2,
  TrendingUp,
  RefreshCw,
} from "lucide-react";
import SequencesTab from "../components/SequencesTab";

type Campaign = {
  campaign_id: string;
  campaign_name: string;
  message: string;
  status: string;
  total_contacts: number;
  recipient_count: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  scheduled_at: string | null;
  created_at: string;
  completed_at: string | null;
  audience: string;
};

const AUDIENCE_OPTIONS = [
  { id: "all", label: "All Contacts", icon: Users, desc: "Send to every contact in your list" },
  { id: "hot", label: "Hot Leads Only", icon: Flame, desc: "Contacts with appointments or strong interest" },
  { id: "warm", label: "Warm Leads Only", icon: Sun, desc: "Contacts showing some interest" },
  { id: "no_appointments", label: "Without Appointments", icon: CalendarOff, desc: "Contacts who haven't booked yet" },
  { id: "custom", label: "Custom — Paste Numbers", icon: UserCheck, desc: "Manually enter phone numbers" },
];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; text: string; label: string; animate?: boolean }> = {
    draft: { bg: "bg-gray-100", text: "text-gray-600", label: "Draft" },
    scheduled: { bg: "bg-amber-100", text: "text-amber-700", label: "Scheduled" },
    sending: { bg: "bg-blue-100", text: "text-blue-700", label: "Sending", animate: true },
    completed: { bg: "bg-green-100", text: "text-green-700", label: "Completed" },
    sent: { bg: "bg-green-100", text: "text-green-700", label: "Completed" },
    failed: { bg: "bg-red-100", text: "text-red-700", label: "Failed" },
  };
  const s = map[status] || map.draft;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase ${s.bg} ${s.text}`}>
      {s.animate && <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse" />}
      {s.label}
    </span>
  );
}

function PhonePreview({ message }: { message: string }) {
  const preview = message
    .replace(/\{name\}/g, "Sarah")
    .replace(/\{business\}/g, "Your Business")
    .replace(/\{date\}/g, "April 15");
  const fullMsg = preview + "\n\nReply STOP to unsubscribe";

  return (
    <div className="flex justify-center">
      <div className="w-[220px] bg-gray-900 rounded-[28px] p-2 shadow-xl">
        <div className="bg-white rounded-[22px] overflow-hidden">
          <div className="bg-gray-100 px-3 py-2 flex items-center justify-between">
            <span className="text-[10px] font-medium text-gray-500">Messages</span>
            <Smartphone className="w-3 h-3 text-gray-400" />
          </div>
          <div className="p-3 min-h-[160px] flex flex-col justify-end">
            <div className="bg-[#2E75B6] text-white rounded-2xl rounded-br-md px-3 py-2 text-[11px] leading-relaxed whitespace-pre-line">
              {fullMsg}
            </div>
            <p className="text-[8px] text-gray-400 text-right mt-1">Just now</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const d = new Date(dateStr).getTime();
  const diff = now - d;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(dateStr).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function SmsCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("campaigns");
  const [showCreate, setShowCreate] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null);

  const [campaignName, setCampaignName] = useState("");
  const [campaignMessage, setCampaignMessage] = useState("");
  const [audience, setAudience] = useState("all");
  const [customPhones, setCustomPhones] = useState("");
  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [recipientLoading, setRecipientLoading] = useState(false);
  const [usageCheck, setUsageCheck] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<any>(null);
  const [createStep, setCreateStep] = useState(1);

  const [replies, setReplies] = useState<any[]>([]);
  const [optOuts, setOptOuts] = useState<any[]>([]);
  const [repliesLoading, setRepliesLoading] = useState(false);

  const [threads, setThreads] = useState<any[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [activeThreadName, setActiveThreadName] = useState<string | null>(null);
  const [threadMessages, setThreadMessages] = useState<any[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [userPlan, setUserPlan] = useState<string>("starter");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [toast, setToast] = useState("");
  const [recoveryCampaigns, setRecoveryCampaigns] = useState<any[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [showRecoveryCreate, setShowRecoveryCreate] = useState(false);
  const [recoveryStep, setRecoveryStep] = useState(1);
  const [rcName, setRcName] = useState("");
  const [rcDormantDays, setRcDormantDays] = useState(180);
  const [rcSegment, setRcSegment] = useState("all");
  const [rcMessage, setRcMessage] = useState("");
  const [rcSendTime, setRcSendTime] = useState("09:00");
  const [rcMaxPerDay, setRcMaxPerDay] = useState(50);
  const [rcEstimate, setRcEstimate] = useState<number | null>(null);
  const [rcEstimateLoading, setRcEstimateLoading] = useState(false);
  const [rcSaving, setRcSaving] = useState(false);

  const recoveryAllowed = ["growth", "business", "enterprise"].includes(userPlan);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const loadCampaigns = useCallback(async () => {
    try {
      const data = await getCampaigns();
      setCampaigns(data.campaigns || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  useEffect(() => {
    getBusinessConfig()
      .then((d) => { if (d?.config?.plan) setUserPlan(d.config.plan); })
      .catch(() => {});
  }, []);

  const conversationAllowed = ["growth", "business", "enterprise"].includes(userPlan);

  const loadThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const data = await getSmsConversations();
      setThreads(data.threads || []);
    } catch { setThreads([]); }
    setThreadsLoading(false);
  }, []);

  const openThread = async (phone: string, contactName?: string | null) => {
    setActiveThread(phone);
    setActiveThreadName(contactName || null);
    setThreadLoading(true);
    setReplyText("");
    try {
      const data = await getSmsThread(phone);
      setThreadMessages(data.messages || []);
      if (data.contact_name) setActiveThreadName(data.contact_name);
      setThreads((prev) => prev.map((t) => t.phone === phone ? { ...t, unread_count: 0 } : t));
    } catch { setThreadMessages([]); }
    setThreadLoading(false);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  };

  const handleSendReply = async () => {
    if (!replyText.trim() || !activeThread || replySending) return;
    setReplySending(true);
    try {
      const result = await sendSmsReply(activeThread, replyText.trim());
      if (result.success) {
        setReplyText("");
        await openThread(activeThread, activeThreadName);
        showToast("Message sent!");
      } else {
        showToast(result.error || "Failed to send");
      }
    } catch (e: any) {
      showToast(e.message || "Failed to send message");
    }
    setReplySending(false);
  };

  useEffect(() => {
    if (tab === "conversations" && conversationAllowed) {
      loadThreads();
      const interval = setInterval(async () => {
        try {
          const data = await getSmsConversations();
          setThreads(data.threads || []);
          if (activeThread) {
            const threadData = await getSmsThread(activeThread);
            setThreadMessages(threadData.messages || []);
          }
        } catch {}
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [tab, conversationAllowed, loadThreads, activeThread]);

  const totalUnreadConversations = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);

  useEffect(() => {
    if (tab === "inbox") {
      setRepliesLoading(true);
      Promise.all([getSmsReplies(), getSmsOptOuts()])
        .then(([r, o]) => {
          setReplies(r.replies || []);
          setOptOuts(o.opt_outs || []);
        })
        .catch(console.error)
        .finally(() => setRepliesLoading(false));
    }
    if (tab === "analytics") {
      getSmsOptOuts().then((o) => setOptOuts(o.opt_outs || [])).catch(console.error);
    }
    if (tab === "recovery" && recoveryAllowed) {
      setRecoveryLoading(true);
      getRecoveryCampaigns()
        .then((d) => setRecoveryCampaigns(d.campaigns || []))
        .catch(console.error)
        .finally(() => setRecoveryLoading(false));
    }
  }, [tab, recoveryAllowed]);

  useEffect(() => {
    if (!showCreate) return;
    if (audience === "custom") {
      const phones = customPhones.split("\n").map((p) => p.trim()).filter(Boolean);
      setRecipientCount(phones.length);
      return;
    }
    setRecipientLoading(true);
    getSmsRecipients(audience)
      .then((data) => setRecipientCount(data.count ?? 0))
      .catch(() => setRecipientCount(0))
      .finally(() => setRecipientLoading(false));
  }, [audience, showCreate, customPhones]);

  const charCount = campaignMessage.length;
  const segments = charCount === 0 ? 0 : charCount <= 160 ? 1 : Math.ceil(charCount / 153);

  useEffect(() => {
    if (createStep === 4 && recipientCount && recipientCount > 0) {
      getSmsUsageCheck(recipientCount, segments || 1)
        .then(setUsageCheck)
        .catch(() => setUsageCheck(null));
    }
  }, [createStep, recipientCount, segments]);

  const resetForm = () => {
    setCampaignName(""); setCampaignMessage(""); setAudience("all");
    setCustomPhones(""); setScheduleMode("now"); setScheduleDate("");
    setScheduleTime("09:00"); setRecipientCount(null); setUsageCheck(null);
    setSendResult(null); setCreateStep(1);
  };

  const handleSend = async () => {
    if (!campaignName || !campaignMessage) return;
    setSending(true);
    try {
      const payload: any = {
        campaign_name: campaignName,
        message: campaignMessage,
        audience,
      };
      if (audience === "custom") {
        payload.custom_phones = customPhones.split("\n").map((p) => p.trim()).filter(Boolean);
      }
      if (scheduleMode === "later" && scheduleDate) {
        payload.scheduled_at = `${scheduleDate}T${scheduleTime}:00`;
      }
      const result = await sendCampaign(payload);
      setSendResult(result);
      await loadCampaigns();
      showToast(result.status === "scheduled" ? "Campaign scheduled!" : "Campaign sent!");
    } catch (e: any) {
      showToast(e.message || "Failed to send campaign");
    }
    setSending(false);
  };

  const totalSent = campaigns.reduce((sum, c) => sum + (c.sent_count || 0), 0);
  const totalDelivered = campaigns.reduce((sum, c) => sum + (c.delivered_count || c.sent_count || 0), 0);
  const totalFailed = campaigns.reduce((sum, c) => sum + (c.failed_count || 0), 0);
  const deliveryRate = totalSent > 0 ? Math.round((totalDelivered / totalSent) * 1000) / 10 : 0;
  const totalOptOuts = optOuts.length;

  const tabs = [
    { id: "campaigns", label: "Campaigns", icon: Megaphone },
    { id: "sequences", label: "Sequences", icon: Zap },
    { id: "conversations", label: "Conversations", icon: MessageSquare, badge: totalUnreadConversations || undefined },
    { id: "recovery", label: "Recovery", icon: RefreshCw },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
    { id: "inbox", label: "Inbox", icon: Inbox, badge: replies.filter((r) => !r.read).length || undefined },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-[#2E75B6] animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6">
      {toast && (
        <div className="fixed top-4 right-4 z-[60] bg-gray-900 text-white px-4 py-2.5 rounded-xl text-sm shadow-lg animate-in slide-in-from-top-2">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">SMS Campaigns</h1>
          <p className="text-sm text-gray-500 mt-1">Send campaigns, view replies, and track performance</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowCreate(true); }}
          className="flex items-center gap-2 px-5 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
        >
          <Plus className="w-4 h-4" /> New Campaign
        </button>
      </div>

      <div className="flex gap-1 mb-6">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all relative ${
                tab === t.id
                  ? "bg-[#2E75B6] text-white shadow-md"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              <Icon className="w-4 h-4" /> {t.label}
              {t.badge && t.badge > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "campaigns" && (
        <div className="bg-white rounded-2xl border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900">Campaign History</h2>
            <span className="text-xs text-gray-400">{campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  {["Name", "Status", "Sent", "Delivered", "Failed", "Scheduled", "Actions"].map((h) => (
                    <th key={h} className="text-left text-xs font-medium text-gray-500 px-5 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <span className="text-4xl mb-3">💬</span>
                        <p className="text-sm font-medium text-gray-500">No campaigns yet</p>
                        <p className="text-xs text-gray-400 mt-1 max-w-xs">
                          Send SMS campaigns to your contacts — appointment reminders, promotions, follow-ups.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  campaigns.map((c) => (
                    <>
                      <tr
                        key={c.campaign_id}
                        className="border-t border-gray-50 hover:bg-gray-50/50 cursor-pointer transition-colors"
                        onClick={() => setExpandedCampaign(expandedCampaign === c.campaign_id ? null : c.campaign_id)}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <Send className="w-4 h-4 text-[#2E75B6]" />
                            <span className="text-sm font-medium text-gray-900">{c.campaign_name}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3"><StatusBadge status={c.status} /></td>
                        <td className="px-5 py-3 text-sm text-gray-700">{c.sent_count || 0}</td>
                        <td className="px-5 py-3">
                          <span className="px-2 py-0.5 bg-green-50 text-green-700 rounded-full text-xs font-medium">
                            {c.delivered_count || c.sent_count || 0}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            (c.failed_count || 0) > 0 ? "bg-red-50 text-red-600" : "bg-gray-50 text-gray-400"
                          }`}>
                            {c.failed_count || 0}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-500">
                          {c.scheduled_at
                            ? new Date(c.scheduled_at).toLocaleString()
                            : new Date(c.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-5 py-3">
                          <button className="text-xs text-[#2E75B6] hover:underline flex items-center gap-1">
                            <Eye className="w-3 h-3" /> View
                          </button>
                        </td>
                      </tr>
                      {expandedCampaign === c.campaign_id && (
                        <tr key={`exp-${c.campaign_id}`} className="bg-gray-50/80">
                          <td colSpan={7} className="px-5 py-4">
                            <div className="grid grid-cols-3 gap-4">
                              <div>
                                <p className="text-xs font-medium text-gray-500 mb-1">Message</p>
                                <p className="text-sm text-gray-700 whitespace-pre-line">{c.message || "—"}</p>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-gray-500 mb-1">Timeline</p>
                                <div className="text-xs text-gray-600 space-y-1">
                                  <p>Created: {new Date(c.created_at).toLocaleString()}</p>
                                  {c.completed_at && <p>Completed: {new Date(c.completed_at).toLocaleString()}</p>}
                                </div>
                              </div>
                              <div>
                                <p className="text-xs font-medium text-gray-500 mb-1">Delivery Summary</p>
                                <div className="text-xs text-gray-600 space-y-1">
                                  <p>Recipients: {c.recipient_count || c.total_contacts || 0}</p>
                                  <p>Delivered: {c.delivered_count || c.sent_count || 0}</p>
                                  <p>Failed: {c.failed_count || 0}</p>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "analytics" && (
        <div className="space-y-6">
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: "Total Sent", value: totalSent.toLocaleString(), icon: Send, color: "blue" },
              { label: "Delivery Rate", value: `${deliveryRate}%`, icon: CheckCircle, color: "green" },
              { label: "Total Failed", value: totalFailed.toLocaleString(), icon: XCircle, color: "red" },
              { label: "Opt-outs", value: totalOptOuts.toString(), icon: Ban, color: "amber" },
            ].map((s) => {
              const Icon = s.icon;
              const colors: Record<string, { bg: string; icon: string }> = {
                blue: { bg: "bg-blue-100", icon: "text-blue-600" },
                green: { bg: "bg-green-100", icon: "text-green-600" },
                red: { bg: "bg-red-100", icon: "text-red-600" },
                amber: { bg: "bg-amber-100", icon: "text-amber-600" },
              };
              const c = colors[s.color] || colors.blue;
              return (
                <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${c.bg}`}>
                      <Icon className={`w-5 h-5 ${c.icon}`} />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">{s.label}</p>
                      <p className="text-xl font-bold text-gray-900">{s.value}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="text-sm font-semibold text-gray-900">Campaign Performance</h3>
            </div>
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  {["Campaign", "Sent", "Delivered", "Failed", "Date"].map((h) => (
                    <th key={h} className="text-left text-xs font-medium text-gray-500 px-5 py-3">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campaigns.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-8 text-center text-sm text-gray-400">
                      No campaign data yet
                    </td>
                  </tr>
                ) : (
                  campaigns.slice(0, 10).map((c) => (
                    <tr key={c.campaign_id} className="border-t border-gray-50 hover:bg-gray-50">
                      <td className="px-5 py-3 text-sm font-medium text-gray-900">{c.campaign_name}</td>
                      <td className="px-5 py-3 text-sm text-gray-600">{c.sent_count || 0}</td>
                      <td className="px-5 py-3">
                        <span className="text-sm font-medium text-green-600">{c.delivered_count || c.sent_count || 0}</span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`text-sm font-medium ${(c.failed_count || 0) > 0 ? "text-red-600" : "text-gray-400"}`}>
                          {c.failed_count || 0}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-xs text-gray-500">
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Opt-out List</h3>
              <span className="text-xs text-gray-400">{optOuts.length} number{optOuts.length !== 1 ? "s" : ""}</span>
            </div>
            {optOuts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">No opt-outs yet</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {optOuts.map((o: any) => (
                  <div key={o.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-mono text-gray-900">{o.phone}</p>
                      <p className="text-xs text-gray-400">Opted out: {new Date(o.opted_out_at).toLocaleDateString()}</p>
                    </div>
                    <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded-full text-[10px] font-medium">Unsubscribed</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "inbox" && (
        <div>
          {repliesLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" />
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Inbound Replies</h2>
                <span className="text-xs text-gray-400">{replies.length} repl{replies.length !== 1 ? "ies" : "y"}</span>
              </div>
              {replies.length === 0 ? (
                <div className="px-5 py-16 text-center">
                  <Inbox className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-500">No replies yet</p>
                  <p className="text-xs text-gray-400 mt-1">When contacts reply to your campaigns, their messages will appear here.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        {["From", "Message", "Date", "Contact"].map((h) => (
                          <th key={h} className="text-left text-xs font-medium text-gray-500 px-5 py-3">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {replies.map((r: any) => (
                        <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50">
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <Reply className="w-4 h-4 text-gray-400" />
                              <span className="text-sm font-mono text-gray-900">{r.from_phone}</span>
                            </div>
                          </td>
                          <td className="px-5 py-3 text-sm text-gray-700 max-w-xs truncate">{r.message}</td>
                          <td className="px-5 py-3 text-xs text-gray-500">
                            {new Date(r.received_at).toLocaleString()}
                          </td>
                          <td className="px-5 py-3">
                            {r.contact_name ? (
                              <a href="/contacts" className="text-xs text-[#2E75B6] hover:underline flex items-center gap-1">
                                {r.contact_name} <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-xs text-gray-400">Unknown</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "sequences" && <SequencesTab />}

      {tab === "recovery" && (
        <div>
          {!recoveryAllowed ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Revenue Recovery</h3>
              <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
                Revenue Recovery is available on Growth plan and above. Re-engage dormant customers automatically and recover lost revenue.
              </p>
              <a href="/settings?tab=billing" className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20">
                <ArrowUpRight className="w-4 h-4" /> Upgrade to Growth
              </a>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold text-gray-900">Revenue Recovery Campaigns</h2>
                  <p className="text-xs text-gray-500 mt-0.5">Re-engage dormant customers with targeted SMS</p>
                </div>
                <button onClick={() => { setShowRecoveryCreate(true); setRecoveryStep(1); setRcName(""); setRcMessage(""); setRcDormantDays(180); setRcSegment("all"); setRcSendTime("09:00"); setRcMaxPerDay(50); setRcEstimate(null); }} className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0]">
                  <Plus className="w-4 h-4" /> New Recovery Campaign
                </button>
              </div>

              {recoveryCampaigns.length > 0 && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-blue-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-[#2E75B6]">{recoveryCampaigns.reduce((s, c) => s + (c.total_sent || 0), 0)}</p>
                    <p className="text-xs text-gray-500 mt-1">Total Sent</p>
                  </div>
                  <div className="bg-green-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-green-700">{recoveryCampaigns.reduce((s, c) => s + (c.total_responded || 0), 0)}</p>
                    <p className="text-xs text-gray-500 mt-1">Responded</p>
                  </div>
                  <div className="bg-amber-50 rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-amber-700">{recoveryCampaigns.reduce((s, c) => s + (c.total_booked || 0), 0)}</p>
                    <p className="text-xs text-gray-500 mt-1">Booked</p>
                  </div>
                </div>
              )}

              {recoveryLoading ? (
                <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" /></div>
              ) : recoveryCampaigns.length === 0 ? (
                <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
                  <div className="w-14 h-14 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <DollarSign className="w-7 h-7 text-green-600" />
                  </div>
                  <h3 className="text-base font-semibold text-gray-900 mb-2">No recovery campaigns yet</h3>
                  <p className="text-sm text-gray-500 max-w-sm mx-auto">Create your first campaign to re-engage customers who haven't called in a while.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {recoveryCampaigns.map((c) => {
                    const responseRate = c.total_sent > 0 ? Math.round((c.total_responded / c.total_sent) * 100) : 0;
                    return (
                      <div key={c.id} className="bg-white rounded-xl border border-gray-200 p-4">
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-sm font-semibold text-gray-900">{c.name}</h3>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${c.status === "active" ? "bg-green-100 text-green-700" : c.status === "paused" ? "bg-yellow-100 text-yellow-700" : c.status === "completed" ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                                {c.status}
                              </span>
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">Inactive {c.dormant_days}+ days · {c.target_segment === "all" ? "All past callers" : c.target_segment === "vip" ? "VIP callers" : c.target_segment === "hot_leads" ? "Hot leads" : "Past appointments"}</p>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {c.status === "draft" && (
                              <button onClick={async () => { try { await launchRecoveryCampaign(c.id); showToast("Campaign launched!"); const d = await getRecoveryCampaigns(); setRecoveryCampaigns(d.campaigns || []); } catch { showToast("Failed to launch"); } }} className="p-1.5 rounded-lg hover:bg-green-50 text-green-600"><Play className="w-4 h-4" /></button>
                            )}
                            {c.status === "active" && (
                              <button onClick={async () => { try { await updateRecoveryCampaign(c.id, { status: "paused" }); const d = await getRecoveryCampaigns(); setRecoveryCampaigns(d.campaigns || []); showToast("Campaign paused"); } catch { showToast("Failed"); } }} className="p-1.5 rounded-lg hover:bg-yellow-50 text-yellow-600"><Pause className="w-4 h-4" /></button>
                            )}
                            {c.status === "paused" && (
                              <button onClick={async () => { try { await updateRecoveryCampaign(c.id, { status: "active" }); const d = await getRecoveryCampaigns(); setRecoveryCampaigns(d.campaigns || []); showToast("Campaign resumed"); } catch { showToast("Failed"); } }} className="p-1.5 rounded-lg hover:bg-green-50 text-green-600"><Play className="w-4 h-4" /></button>
                            )}
                            <button onClick={async () => { if (!confirm("Delete this campaign?")) return; try { await deleteRecoveryCampaign(c.id); setRecoveryCampaigns(prev => prev.filter(x => x.id !== c.id)); showToast("Campaign deleted"); } catch { showToast("Failed"); } }} className="p-1.5 rounded-lg hover:bg-red-50 text-red-400"><Trash2 className="w-4 h-4" /></button>
                          </div>
                        </div>
                        <div className="grid grid-cols-4 gap-2">
                          <div className="text-center p-2 bg-gray-50 rounded-lg">
                            <p className="text-sm font-bold text-gray-900">{c.total_sent || 0}</p>
                            <p className="text-[10px] text-gray-500">Sent</p>
                          </div>
                          <div className="text-center p-2 bg-gray-50 rounded-lg">
                            <p className="text-sm font-bold text-green-700">{c.total_responded || 0}</p>
                            <p className="text-[10px] text-gray-500">Responded</p>
                          </div>
                          <div className="text-center p-2 bg-gray-50 rounded-lg">
                            <p className="text-sm font-bold text-amber-700">{c.total_booked || 0}</p>
                            <p className="text-[10px] text-gray-500">Booked</p>
                          </div>
                          <div className="text-center p-2 bg-gray-50 rounded-lg">
                            <p className="text-sm font-bold text-[#2E75B6]">{responseRate}%</p>
                            <p className="text-[10px] text-gray-500">Response Rate</p>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {showRecoveryCreate && recoveryAllowed && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowRecoveryCreate(false)}>
              <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="p-5 border-b border-gray-100 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-gray-900">Create Recovery Campaign</h2>
                    <p className="text-xs text-gray-500">Step {recoveryStep} of 4</p>
                  </div>
                  <button onClick={() => setShowRecoveryCreate(false)} className="p-1.5 rounded-lg hover:bg-gray-100"><X className="w-4 h-4" /></button>
                </div>

                <div className="p-5 space-y-4">
                  {recoveryStep === 1 && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Campaign Name</label>
                        <input value={rcName} onChange={(e) => setRcName(e.target.value)} placeholder="e.g. Spring Re-engagement" className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#2E75B6]/30 focus:border-[#2E75B6] outline-none" />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-2">Re-engage customers inactive for:</label>
                        <div className="flex flex-wrap gap-2">
                          {[30, 60, 90, 180, 365].map((d) => (
                            <button key={d} onClick={() => setRcDormantDays(d)} className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all ${rcDormantDays === d ? "bg-[#2E75B6] text-white border-[#2E75B6]" : "bg-white text-gray-600 border-gray-200 hover:border-[#2E75B6]"}`}>
                              {d} days
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-2">Target Segment</label>
                        <div className="space-y-2">
                          {[
                            { id: "all", label: "All past callers", icon: Users },
                            { id: "vip", label: "VIP callers only", icon: Star },
                            { id: "hot_leads", label: "Hot leads only", icon: Flame },
                            { id: "appointment_holders", label: "Past appointment holders", icon: CalendarOff },
                          ].map((s) => {
                            const SIcon = s.icon;
                            return (
                              <button key={s.id} onClick={() => setRcSegment(s.id)} className={`w-full flex items-center gap-3 p-3 rounded-xl border text-sm text-left transition-all ${rcSegment === s.id ? "border-[#2E75B6] bg-blue-50" : "border-gray-200 hover:border-gray-300"}`}>
                                <SIcon className={`w-4 h-4 ${rcSegment === s.id ? "text-[#2E75B6]" : "text-gray-400"}`} />
                                <span className={rcSegment === s.id ? "font-medium text-gray-900" : "text-gray-600"}>{s.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}

                  {recoveryStep === 2 && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Message Template</label>
                        <textarea value={rcMessage} onChange={(e) => { if (e.target.value.length <= 280) setRcMessage(e.target.value); }} rows={4} placeholder="Hi [Name]! It's been a while since your last visit at [Business]..." className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm resize-none focus:ring-2 focus:ring-[#2E75B6]/30 focus:border-[#2E75B6] outline-none" />
                        <div className="flex justify-between mt-1">
                          <p className="text-[10px] text-gray-400">Variables: [Name], [Business], [Phone]</p>
                          <p className={`text-[10px] ${rcMessage.length > 260 ? "text-red-500" : "text-gray-400"}`}>{rcMessage.length}/280</p>
                        </div>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-gray-700 mb-2">Quick Templates</p>
                        <div className="space-y-2">
                          {[
                            { emoji: "🦷", label: "Dental", msg: "Hi [Name]! It's been a while since your last visit at [Business]. We miss you! We have some great openings next week. Would you like to schedule a cleaning? Call us at [Phone]" },
                            { emoji: "⚖️", label: "Legal", msg: "Hi [Name], this is [Business]. We wanted to check in — has your legal situation been fully resolved? If you need any follow-up assistance, we're here to help with a free consultation. Call [Phone]" },
                            { emoji: "🔧", label: "HVAC", msg: "Hi [Name]! [Business] wants to make sure your AC is ready for the season. We're offering priority tune-up appointments for past customers. Want to grab a slot? Call [Phone]" },
                            { emoji: "🍽️", label: "Restaurant", msg: "Hi [Name]! We've missed seeing you at [Business]. We have exciting new menu items and a special returning guest offer just for you. Come see us soon!" },
                          ].map((t) => (
                            <button key={t.label} onClick={() => setRcMessage(t.msg)} className="w-full text-left p-3 rounded-xl border border-gray-200 hover:border-[#2E75B6] transition-all">
                              <p className="text-xs font-medium text-gray-900">{t.emoji} {t.label}</p>
                              <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{t.msg}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                      {rcMessage && (
                        <div>
                          <p className="text-xs font-medium text-gray-700 mb-1">Preview</p>
                          <div className="bg-green-50 rounded-xl p-3 border border-green-200">
                            <p className="text-xs text-gray-800">{rcMessage.replace(/\[Name\]/g, "Sarah").replace(/\[Business\]/g, "Acme Dental").replace(/\[Phone\]/g, "(555) 123-4567")}</p>
                            <p className="text-[10px] text-gray-400 mt-1.5">Reply STOP to unsubscribe.</p>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {recoveryStep === 3 && (
                    <>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Send Time (daily)</label>
                        <input type="time" value={rcSendTime} onChange={(e) => setRcSendTime(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#2E75B6]/30 focus:border-[#2E75B6] outline-none" />
                        <p className="text-[10px] text-gray-400 mt-1">Messages will be sent at this time in your business timezone</p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">Max contacts per day</label>
                        <input type="number" min={1} max={200} value={rcMaxPerDay} onChange={(e) => setRcMaxPerDay(parseInt(e.target.value) || 50)} className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-[#2E75B6]/30 focus:border-[#2E75B6] outline-none" />
                        <p className="text-[10px] text-gray-400 mt-1">Rate limiting to avoid spam flags</p>
                      </div>
                    </>
                  )}

                  {recoveryStep === 4 && (
                    <>
                      <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Campaign</span><span className="font-medium text-gray-900">{rcName}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Inactive period</span><span className="font-medium text-gray-900">{rcDormantDays}+ days</span></div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Segment</span><span className="font-medium text-gray-900">{rcSegment === "all" ? "All past callers" : rcSegment === "vip" ? "VIP callers" : rcSegment === "hot_leads" ? "Hot leads" : "Past appointments"}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Send time</span><span className="font-medium text-gray-900">{rcSendTime}</span></div>
                        <div className="flex justify-between text-sm"><span className="text-gray-500">Max/day</span><span className="font-medium text-gray-900">{rcMaxPerDay}</span></div>
                        {rcEstimate !== null && (
                          <div className="flex justify-between text-sm"><span className="text-gray-500">Est. recipients</span><span className="font-bold text-[#2E75B6]">{rcEstimate} contacts</span></div>
                        )}
                        {rcEstimateLoading && <div className="flex justify-center"><Loader2 className="w-4 h-4 animate-spin text-[#2E75B6]" /></div>}
                      </div>
                      <div className="bg-blue-50 rounded-xl p-3 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 text-[#2E75B6] flex-shrink-0 mt-0.5" />
                        <p className="text-xs text-gray-600">Only sent to customers who have previously contacted your business. TCPA compliant based on existing business relationship.</p>
                      </div>
                    </>
                  )}
                </div>

                <div className="p-5 border-t border-gray-100 flex justify-between">
                  <button onClick={() => recoveryStep > 1 ? setRecoveryStep(recoveryStep - 1) : setShowRecoveryCreate(false)} className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900">
                    {recoveryStep > 1 ? "Back" : "Cancel"}
                  </button>
                  {recoveryStep < 4 ? (
                    <button onClick={() => {
                      setRecoveryStep(recoveryStep + 1);
                      if (recoveryStep === 3) {
                        setRcEstimateLoading(true);
                        getRecoveryEstimate(rcDormantDays, rcSegment).then(d => setRcEstimate(d.count || 0)).catch(() => setRcEstimate(0)).finally(() => setRcEstimateLoading(false));
                      }
                    }} disabled={recoveryStep === 1 ? !rcName : recoveryStep === 2 ? !rcMessage : false} className="px-6 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50 flex items-center gap-1">
                      Next <ChevronRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <button onClick={async () => {
                      setRcSaving(true);
                      try {
                        const res = await createRecoveryCampaign({ name: rcName, message_template: rcMessage, dormant_days: rcDormantDays, target_segment: rcSegment, send_time: rcSendTime, max_per_day: rcMaxPerDay });
                        if (res.success && res.campaign) {
                          await launchRecoveryCampaign(res.campaign.id);
                          showToast("Campaign created and launched!");
                          setShowRecoveryCreate(false);
                          const d = await getRecoveryCampaigns();
                          setRecoveryCampaigns(d.campaigns || []);
                        }
                      } catch { showToast("Failed to create campaign"); }
                      setRcSaving(false);
                    }} disabled={rcSaving} className="px-6 py-2 bg-green-600 text-white rounded-xl text-sm font-medium hover:bg-green-700 disabled:opacity-50 flex items-center gap-2">
                      {rcSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      Launch Campaign
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "conversations" && (
        <div>
          {!conversationAllowed ? (
            <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center">
              <div className="w-16 h-16 bg-gray-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-8 h-8 text-gray-400" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Two-way SMS Conversations</h3>
              <p className="text-sm text-gray-500 max-w-md mx-auto mb-6">
                Two-way SMS is available on Growth plan and above. This lets you reply to callers directly from your dashboard.
              </p>
              <a
                href="/settings?tab=billing"
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] shadow-md shadow-[#2E75B6]/20"
              >
                <ArrowUpRight className="w-4 h-4" /> Upgrade to Growth
              </a>
            </div>
          ) : activeThread ? (
            <div className="bg-white rounded-2xl border border-gray-200 flex flex-col" style={{ height: "calc(100vh - 220px)" }}>
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-3">
                <button
                  onClick={() => { setActiveThread(null); setThreadMessages([]); loadThreads(); }}
                  className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <ArrowLeft className="w-4 h-4 text-gray-500" />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {activeThreadName || activeThread}
                  </p>
                  {activeThreadName && (
                    <p className="text-xs text-gray-500 font-mono">{activeThread}</p>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {threadLoading ? (
                  <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" />
                  </div>
                ) : threadMessages.length === 0 ? (
                  <div className="text-center py-16">
                    <MessageSquare className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                    <p className="text-sm text-gray-400">No messages yet</p>
                  </div>
                ) : (
                  threadMessages.map((msg: any) => (
                    <div
                      key={msg.id}
                      className={`flex ${msg.direction === "outbound" ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                          msg.direction === "outbound"
                            ? "bg-[#2E75B6] text-white rounded-br-md"
                            : "bg-gray-100 text-gray-900 rounded-bl-md"
                        }`}
                      >
                        <p className="text-sm whitespace-pre-wrap break-words">{msg.message}</p>
                        <div className={`flex items-center gap-1.5 mt-1 ${msg.direction === "outbound" ? "justify-end" : ""}`}>
                          <span className={`text-[10px] ${msg.direction === "outbound" ? "text-white/60" : "text-gray-400"}`}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          {msg.direction === "outbound" && (
                            <span className={`text-[10px] ${msg.status === "failed" ? "text-red-300" : "text-white/60"}`}>
                              {msg.status === "failed" ? "Failed" : msg.status === "delivered" ? "Delivered" : "Sent"}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="px-5 py-3 border-t border-gray-100">
                <div className="flex gap-2">
                  <input
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendReply(); } }}
                    placeholder="Type a message..."
                    className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    disabled={replySending}
                    maxLength={1600}
                  />
                  <button
                    onClick={handleSendReply}
                    disabled={!replyText.trim() || replySending}
                    className="px-4 py-2.5 bg-[#2E75B6] text-white rounded-xl hover:bg-[#2563a0] disabled:opacity-50 flex items-center gap-1.5 text-sm font-medium"
                  >
                    {replySending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    Send
                  </button>
                </div>
                <p className="text-[10px] text-gray-400 mt-1.5">
                  {replyText.length}/1600 characters
                </p>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-gray-200">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Conversations</h2>
                <span className="text-xs text-gray-400">
                  {threads.length} thread{threads.length !== 1 ? "s" : ""}
                </span>
              </div>
              {threadsLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" />
                </div>
              ) : threads.length === 0 ? (
                <div className="px-5 py-16 text-center">
                  <MessageSquare className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-500">No conversations yet</p>
                  <p className="text-xs text-gray-400 mt-1 max-w-xs mx-auto">
                    When callers reply to your SMS messages, conversations will appear here. You can reply directly from your dashboard.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {threads.map((t: any) => (
                    <button
                      key={t.phone}
                      onClick={() => openThread(t.phone, t.contact_name)}
                      className="w-full px-5 py-3.5 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                    >
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                        t.unread_count > 0 ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-500"
                      }`}>
                        <MessageSquare className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className={`text-sm truncate ${t.unread_count > 0 ? "font-bold text-gray-900" : "font-medium text-gray-700"}`}>
                            {t.contact_name || t.phone}
                          </p>
                          <span className="text-[10px] text-gray-400 shrink-0 ml-2">
                            {formatTimeAgo(t.last_message_at)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between mt-0.5">
                          <p className={`text-xs truncate ${t.unread_count > 0 ? "text-gray-700 font-medium" : "text-gray-500"}`}>
                            {t.last_direction === "outbound" && <span className="text-gray-400">You: </span>}
                            {t.last_message}
                          </p>
                          {t.unread_count > 0 && (
                            <span className="w-5 h-5 bg-[#2E75B6] text-white text-[10px] font-bold rounded-full flex items-center justify-center shrink-0 ml-2">
                              {t.unread_count}
                            </span>
                          )}
                        </div>
                        {t.contact_name && (
                          <p className="text-[10px] text-gray-400 font-mono mt-0.5">{t.phone}</p>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white rounded-t-2xl z-10">
              <div>
                <h3 className="font-semibold text-lg">New Campaign</h3>
                <p className="text-xs text-gray-500">Step {createStep} of 4</p>
              </div>
              <button onClick={() => setShowCreate(false)}>
                <X className="w-5 h-5 text-gray-400 hover:text-gray-600" />
              </button>
            </div>

            <div className="flex gap-1 px-5 pt-3">
              {[1, 2, 3, 4].map((s) => (
                <div key={s} className={`h-1.5 flex-1 rounded-full transition-colors ${s <= createStep ? "bg-[#2E75B6]" : "bg-gray-200"}`} />
              ))}
            </div>

            <div className="p-5">
              {createStep === 1 && (
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">Campaign Details</h4>
                  <div>
                    <label className="text-xs font-medium text-gray-700 mb-1 block">Campaign Name</label>
                    <input
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                      placeholder="Spring Checkup Reminder"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-700 mb-1 block">Message</label>
                    <textarea
                      value={campaignMessage}
                      onChange={(e) => setCampaignMessage(e.target.value)}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm h-28 resize-none focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                      placeholder="Hi {name}, we have a special offer just for you..."
                    />
                    <div className="flex items-center justify-between mt-1">
                      <div className="flex gap-1">
                        {["name", "business", "date"].map((v) => (
                          <button
                            key={v}
                            onClick={() => setCampaignMessage((m) => m + `{${v}}`)}
                            className="px-2 py-0.5 bg-blue-50 text-[#2E75B6] rounded text-[10px] font-medium hover:bg-blue-100"
                          >
                            {`{${v}}`}
                          </button>
                        ))}
                      </div>
                      <div className="text-right">
                        <span className={`text-[10px] ${charCount > 160 ? "text-amber-600 font-medium" : "text-gray-400"}`}>
                          {charCount}/160
                        </span>
                        {segments > 0 && (
                          <span className="text-[10px] text-gray-400 ml-1">
                            ({segments} SMS segment{segments !== 1 ? "s" : ""})
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-1 italic">
                      "Reply STOP to unsubscribe" will be auto-appended
                    </p>
                  </div>
                  {campaignMessage && <PhonePreview message={campaignMessage} />}
                </div>
              )}

              {createStep === 2 && (
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">Recipients</h4>
                  <div className="space-y-2">
                    {AUDIENCE_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      return (
                        <label
                          key={opt.id}
                          className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-colors ${
                            audience === opt.id ? "border-[#2E75B6] bg-blue-50/50" : "border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          <input
                            type="radio"
                            name="audience"
                            checked={audience === opt.id}
                            onChange={() => setAudience(opt.id)}
                            className="text-[#2E75B6]"
                          />
                          <Icon className={`w-5 h-5 ${audience === opt.id ? "text-[#2E75B6]" : "text-gray-400"}`} />
                          <div>
                            <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                            <p className="text-xs text-gray-500">{opt.desc}</p>
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {audience === "custom" && (
                    <div className="mt-3">
                      <label className="text-xs font-medium text-gray-700 mb-1 block">Phone Numbers (one per line)</label>
                      <textarea
                        value={customPhones}
                        onChange={(e) => setCustomPhones(e.target.value)}
                        className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm h-28 resize-none font-mono focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                        placeholder={"+12125551234\n+13105559876\n+14155553456"}
                      />
                    </div>
                  )}

                  <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-xl">
                    <Users className="w-4 h-4 text-[#2E75B6]" />
                    {recipientLoading ? (
                      <span className="text-sm text-[#2E75B6]">Counting recipients...</span>
                    ) : (
                      <span className="text-sm text-[#2E75B6] font-medium">
                        {recipientCount ?? 0} estimated recipient{recipientCount !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {createStep === 3 && (
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">Schedule</h4>
                  <div className="space-y-2">
                    <label className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer ${scheduleMode === "now" ? "border-[#2E75B6] bg-blue-50/50" : "border-gray-200"}`}>
                      <input type="radio" name="schedule" checked={scheduleMode === "now"} onChange={() => setScheduleMode("now")} className="text-[#2E75B6]" />
                      <div>
                        <p className="text-sm font-medium text-gray-900">Send Now</p>
                        <p className="text-xs text-gray-500">Messages will be sent immediately</p>
                      </div>
                    </label>
                    <label className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer ${scheduleMode === "later" ? "border-[#2E75B6] bg-blue-50/50" : "border-gray-200"}`}>
                      <input type="radio" name="schedule" checked={scheduleMode === "later"} onChange={() => setScheduleMode("later")} className="text-[#2E75B6]" />
                      <div className="flex-1">
                        <p className="text-sm font-medium text-gray-900">Schedule for Later</p>
                        <p className="text-xs text-gray-500">Pick a specific date and time</p>
                        {scheduleMode === "later" && (
                          <div className="flex gap-2 mt-2">
                            <input type="date" value={scheduleDate} onChange={(e) => setScheduleDate(e.target.value)} className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                            <input type="time" value={scheduleTime} onChange={(e) => setScheduleTime(e.target.value)} className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                          </div>
                        )}
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {createStep === 4 && !sendResult && (
                <div className="space-y-4">
                  <h4 className="text-sm font-semibold text-gray-900">Review & Send</h4>

                  {usageCheck && !usageCheck.allowed && (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-xl">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-red-800">SMS Limit Exceeded</p>
                          <p className="text-xs text-red-700 mt-1">
                            This campaign would send {usageCheck.requested} SMS but you only have {usageCheck.remaining} remaining this month.
                            Upgrade your plan or reduce recipients.
                          </p>
                          <a href="/settings" className="text-xs text-red-800 font-medium underline mt-1 inline-flex items-center gap-1">
                            Upgrade Plan <ArrowUpRight className="w-3 h-3" />
                          </a>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="bg-gray-50 rounded-xl p-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Campaign</span>
                      <span className="font-medium text-gray-900">{campaignName}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Recipients</span>
                      <span className="font-medium text-gray-900">{recipientCount ?? 0} contacts</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Audience</span>
                      <span className="font-medium text-gray-900">
                        {AUDIENCE_OPTIONS.find((o) => o.id === audience)?.label || audience}
                      </span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">SMS Segments</span>
                      <span className="font-medium text-gray-900">{segments}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-500">Schedule</span>
                      <span className="font-medium text-gray-900">
                        {scheduleMode === "now" ? "Send Now" : `${scheduleDate} ${scheduleTime}`}
                      </span>
                    </div>
                    {usageCheck && (
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">SMS Remaining (this month)</span>
                        <span className="font-medium text-gray-900">{usageCheck.remaining}</span>
                      </div>
                    )}
                    <div className="pt-2 border-t border-gray-200">
                      <p className="text-xs text-gray-500 mb-1">Message Preview:</p>
                      <p className="text-sm text-gray-700 whitespace-pre-line">
                        {campaignMessage.replace(/\{name\}/g, "Sarah").replace(/\{business\}/g, "Your Business").replace(/\{date\}/g, "April 15")}
                      </p>
                      <p className="text-[10px] text-gray-400 italic mt-1">+ "Reply STOP to unsubscribe"</p>
                    </div>
                  </div>

                  <button
                    onClick={handleSend}
                    disabled={sending || (usageCheck && !usageCheck.allowed)}
                    className="w-full py-3 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {sending ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /> Sending...</>
                    ) : scheduleMode === "later" ? (
                      <><Clock className="w-4 h-4" /> Schedule Campaign</>
                    ) : (
                      <><Send className="w-4 h-4" /> Send Campaign</>
                    )}
                  </button>
                </div>
              )}

              {createStep === 4 && sendResult && (
                <div className="space-y-4 text-center">
                  <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto">
                    <CheckCircle className="w-8 h-8 text-green-600" />
                  </div>
                  <h4 className="text-lg font-bold text-gray-900">
                    {sendResult.status === "scheduled" ? "Campaign Scheduled!" : "Campaign Sent!"}
                  </h4>
                  {sendResult.results && (
                    <div className="flex justify-center gap-6">
                      <div className="text-center">
                        <p className="text-2xl font-bold text-green-600">{sendResult.results.sent || 0}</p>
                        <p className="text-xs text-gray-500">Sent</p>
                      </div>
                      <div className="text-center">
                        <p className="text-2xl font-bold text-red-500">{sendResult.results.failed || 0}</p>
                        <p className="text-xs text-gray-500">Failed</p>
                      </div>
                    </div>
                  )}
                  {sendResult.recipient_count && !sendResult.results && (
                    <p className="text-sm text-gray-600">{sendResult.recipient_count} messages scheduled</p>
                  )}
                  <button
                    onClick={() => { setShowCreate(false); resetForm(); }}
                    className="w-full py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>

            {!sendResult && (
              <div className="p-5 border-t border-gray-100 flex justify-between sticky bottom-0 bg-white rounded-b-2xl">
                <button
                  onClick={() => createStep > 1 ? setCreateStep(createStep - 1) : setShowCreate(false)}
                  className="px-4 py-2 text-gray-600 text-sm font-medium hover:text-gray-900"
                >
                  {createStep > 1 ? "Back" : "Cancel"}
                </button>
                {createStep < 4 && (
                  <button
                    onClick={() => setCreateStep(createStep + 1)}
                    disabled={
                      createStep === 1 ? !campaignName || !campaignMessage :
                      createStep === 2 ? (audience === "custom" ? !customPhones.trim() : recipientCount === 0) :
                      createStep === 3 ? (scheduleMode === "later" && !scheduleDate) :
                      false
                    }
                    className="px-6 py-2 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50 flex items-center gap-1"
                  >
                    Next <ChevronRight className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
