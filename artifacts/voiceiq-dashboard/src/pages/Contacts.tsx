import { useEffect, useState, useRef } from "react";
import { getContacts, getCallerHistory, setVipStatus, sendSms, updateContactNotes, fetchApi } from "../lib/api";
import {
  Search, Star, Phone, MessageSquare, Clock, X, Download, User,
  ChevronLeft, ChevronRight, Filter, Flame, Sun, Snowflake,
  Calendar, Send, Check, Pencil, Loader2, StickyNote, Users,
  AlertTriangle, TrendingUp, TrendingDown, Minus, Dna, DollarSign,
  MessageCircle, Zap, ShieldAlert,
} from "lucide-react";

function timeAgo(date: string) {
  if (!date) return "Never";
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function formatDate(date: string) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function LeadBadge({ score }: { score: string }) {
  if (score === "hot") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
        <Flame className="w-3 h-3" /> Hot
      </span>
    );
  }
  if (score === "warm") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
        <Sun className="w-3 h-3" /> Warm
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-700">
      <Snowflake className="w-3 h-3" /> Cold
    </span>
  );
}

function getOutcomeStyle(outcome: string) {
  switch (outcome) {
    case "appointment_booked": return { bg: "bg-blue-100", text: "text-blue-700", label: "Booked" };
    case "lead_captured": return { bg: "bg-green-100", text: "text-green-700", label: "Lead" };
    case "resolved": return { bg: "bg-emerald-100", text: "text-emerald-700", label: "Resolved" };
    case "follow_up": return { bg: "bg-amber-100", text: "text-amber-700", label: "Follow Up" };
    case "missed": return { bg: "bg-red-100", text: "text-red-700", label: "Missed" };
    default: return { bg: "bg-gray-100", text: "text-gray-600", label: outcome || "" };
  }
}

type FilterType = "all" | "hot" | "warm" | "cold" | "appointments";

export default function Contacts() {
  const [contacts, setContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);

  const [selectedContact, setSelectedContact] = useState<any>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [callHistory, setCallHistory] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [notes, setNotes] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesSaved, setNotesSaved] = useState(false);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsMsg, setSmsMsg] = useState("");
  const [smsPhone, setSmsPhone] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const loadContacts = () => {
    setLoading(true);
    getContacts({
      search: search || undefined,
      filter: filter !== "all" ? filter : undefined,
      page,
      limit: pageSize,
    })
      .then((d) => {
        setContacts(d.contacts || []);
        setTotal(d.total || 0);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const t = setTimeout(() => { setPage(1); loadContacts(); }, 300);
    return () => clearTimeout(t);
  }, [search, filter]);

  useEffect(() => { loadContacts(); }, [page]);

  const openPanel = async (contact: any) => {
    setSelectedContact(contact);
    setPanelOpen(true);
    setNotes(contact.notes || "");
    setNotesSaved(false);
    setHistoryLoading(true);
    setCallHistory(null);
    try {
      const h = await getCallerHistory(contact.caller_phone);
      setCallHistory(h);
    } catch (e) { console.error(e); }
    setHistoryLoading(false);
  };

  const closePanel = () => {
    setPanelOpen(false);
    setTimeout(() => setSelectedContact(null), 300);
  };

  const toggleVip = async (contact: any, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const newVip = !contact.is_vip;
    try {
      await setVipStatus(contact.caller_phone, newVip);
      setContacts((prev) => prev.map((c) => c.caller_phone === contact.caller_phone ? { ...c, is_vip: newVip } : c));
      if (selectedContact?.caller_phone === contact.caller_phone) {
        setSelectedContact({ ...selectedContact, is_vip: newVip });
      }
      showToast(newVip ? "Marked as VIP" : "Removed VIP status");
    } catch { showToast("Failed to update VIP status"); }
  };

  const saveNotes = async () => {
    if (!selectedContact) return;
    setNotesSaving(true);
    try {
      await updateContactNotes(selectedContact.caller_phone, notes);
      setNotesSaved(true);
      setContacts((prev) => prev.map((c) => c.caller_phone === selectedContact.caller_phone ? { ...c, notes } : c));
      setTimeout(() => setNotesSaved(false), 2000);
    } catch { showToast("Failed to save notes"); }
    setNotesSaving(false);
  };

  const startNameEdit = () => {
    setEditName(selectedContact?.caller_name || "");
    setEditingName(true);
  };

  const saveNameEdit = async () => {
    if (selectedContact && editName.trim()) {
      try {
        // fetchApi auto-injects Authorization + X-Active-Business so this
        // POST runs against the tenant the user is currently viewing,
        // not their oldest business.
        await fetchApi("/memory/update", {
          method: "POST",
          body: JSON.stringify({ caller_phone: selectedContact.caller_phone, caller_name: editName.trim() }),
        });
        setSelectedContact({ ...selectedContact, caller_name: editName.trim() });
        setContacts((prev) =>
          prev.map((c) => c.caller_phone === selectedContact.caller_phone ? { ...c, caller_name: editName.trim() } : c)
        );
        showToast("Name updated");
      } catch { showToast("Failed to update name"); }
    }
    setEditingName(false);
  };

  const openSmsModal = (phone: string) => {
    setSmsPhone(phone);
    setSmsMsg("");
    setSmsOpen(true);
  };

  const handleSendSms = async () => {
    if (!smsPhone || !smsMsg.trim()) return;
    try {
      await sendSms(smsPhone, smsMsg);
      showToast("SMS sent successfully");
      setSmsOpen(false);
    } catch { showToast("Failed to send SMS"); }
  };

  const exportCsv = () => {
    const headers = ["Name", "Phone", "Lead Score", "Times Called", "Last Call", "Appointments", "VIP", "Notes"];
    const rows = contacts.map((c) => [
      c.caller_name || "Unknown",
      c.caller_phone,
      c.lead_score || "cold",
      c.total_calls || 0,
      c.last_call_date ? new Date(c.last_call_date).toISOString() : "",
      c.appointments || 0,
      c.is_vip ? "Yes" : "No",
      (c.notes || "").replace(/"/g, '""'),
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v: any) => `"${v}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `neverr-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contacts</h1>
          <p className="text-sm text-gray-500 mt-1">{total.toLocaleString()} contact{total !== 1 ? "s" : ""}</p>
        </div>
        <button
          onClick={exportCsv}
          className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone number..."
            className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 bg-white"
          />
        </div>
        <div className="relative">
          <Filter className="w-4 h-4 text-gray-400 absolute left-3 top-3" />
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterType)}
            className="pl-10 pr-8 py-2.5 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 appearance-none cursor-pointer"
          >
            <option value="all">All Contacts</option>
            <option value="hot">Hot Leads</option>
            <option value="warm">Warm Leads</option>
            <option value="cold">Cold Leads</option>
            <option value="appointments">Appointments Booked</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" />
        </div>
      ) : contacts.length === 0 && !search && filter === "all" ? (
        <div className="flex flex-col items-center justify-center py-20 bg-white rounded-2xl border border-gray-200">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
            <Users className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 mb-2">No contacts yet</h3>
          <p className="text-sm text-gray-500 text-center max-w-md">
            Every caller becomes a contact automatically. Once your AI receptionist starts handling calls, your contacts will appear here.
          </p>
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 bg-white rounded-2xl border border-gray-200">
          <Search className="w-8 h-8 text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">No contacts match your search or filter</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Contact</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Lead Score</th>
                    <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Calls</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Last Call</th>
                    <th className="text-center text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Appts</th>
                    <th className="text-left text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Notes</th>
                    <th className="text-right text-xs font-semibold text-gray-500 uppercase tracking-wider px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => {
                    const initials = (c.caller_name || "?")[0].toUpperCase();
                    return (
                      <tr
                        key={c.id || c.caller_phone}
                        onClick={() => openPanel(c)}
                        className="border-b border-gray-50 hover:bg-blue-50/30 cursor-pointer transition-colors"
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1B2537] to-[#2E75B6] flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                              {initials}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5">
                                {c.caller_name || "Unknown"}
                                {(c.is_vip || c.profile?.is_vip) && <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-400 flex-shrink-0" title="VIP" />}
                                {c.profile?.is_at_risk && <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" title="At Risk" />}
                                {c.profile?.is_frequent && !c.profile?.is_vip && <Zap className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" title="Frequent Caller" />}
                              </p>
                              <p className="text-xs text-gray-500 truncate">{c.caller_phone}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <LeadBadge score={c.lead_score || "cold"} />
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-sm font-semibold text-gray-900">{c.total_calls || 0}</span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-sm text-gray-600">{timeAgo(c.last_call_date)}</span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className="text-sm font-medium text-gray-900">{c.appointments || 0}</span>
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-xs text-gray-500 truncate max-w-[160px]">{c.notes || ""}</p>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={(e) => { e.stopPropagation(); openPanel(c); }}
                              className="px-2.5 py-1.5 text-xs font-medium text-[#2E75B6] bg-blue-50 rounded-lg hover:bg-blue-100"
                            >
                              View
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); openPanel(c); }}
                              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                              title="Add Note"
                            >
                              <StickyNote className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-gray-500">
                Page {page} of {totalPages}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-4 h-4" /> Prev
                </button>
                <button
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}
                  className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Slide-in Side Panel */}
      {selectedContact && (
        <div
          className={`fixed inset-0 z-50 flex justify-end transition-opacity duration-300 ${panelOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <div className="absolute inset-0 bg-black/30" onClick={closePanel} />
          <div
            ref={panelRef}
            className={`relative w-full max-w-lg bg-white shadow-2xl overflow-y-auto transition-transform duration-300 ${panelOpen ? "translate-x-0" : "translate-x-full"}`}
          >
            <div className="bg-gradient-to-r from-[#1B2537] to-[#2E75B6] p-6">
              <button onClick={closePanel} className="absolute top-4 right-4 text-white/60 hover:text-white">
                <X className="w-5 h-5" />
              </button>
              <div className="flex items-center gap-4">
                <div className="relative">
                  <div className="w-14 h-14 rounded-full bg-white/20 backdrop-blur flex items-center justify-center text-white text-2xl font-bold">
                    {(selectedContact.caller_name || "?")[0].toUpperCase()}
                  </div>
                  {selectedContact.is_vip && (
                    <span className="absolute -top-1 -right-1 text-lg">
                      <Star className="w-5 h-5 text-yellow-400 fill-yellow-400" />
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {editingName ? (
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={saveNameEdit}
                      onKeyDown={(e) => { if (e.key === "Enter") saveNameEdit(); if (e.key === "Escape") setEditingName(false); }}
                      className="text-lg font-bold bg-white/20 text-white px-2 py-0.5 rounded border border-white/30 outline-none w-full"
                    />
                  ) : (
                    <h2
                      className="text-lg font-bold text-white flex items-center gap-2 cursor-pointer group"
                      onClick={startNameEdit}
                    >
                      {selectedContact.caller_name || "Unknown"}
                      <Pencil className="w-3.5 h-3.5 text-white/40 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </h2>
                  )}
                  <p className="text-white/70 text-sm">{selectedContact.caller_phone}</p>
                  <div className="mt-1.5">
                    <LeadBadge score={selectedContact.lead_score || "cold"} />
                  </div>
                </div>
              </div>

              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => openSmsModal(selectedContact.caller_phone)}
                  className="flex items-center gap-1.5 px-3 py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg text-sm font-medium backdrop-blur"
                >
                  <MessageSquare className="w-4 h-4" /> Send SMS
                </button>
                <button
                  onClick={() => toggleVip(selectedContact)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium backdrop-blur ${
                    selectedContact.is_vip
                      ? "bg-yellow-400/30 text-yellow-100 hover:bg-yellow-400/40"
                      : "bg-white/20 text-white hover:bg-white/30"
                  }`}
                >
                  <Star className={`w-4 h-4 ${selectedContact.is_vip ? "fill-yellow-300" : ""}`} />
                  {selectedContact.is_vip ? "VIP" : "Mark VIP"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 border-b border-gray-100">
              <div className="p-3 text-center border-r border-gray-100">
                <p className="text-xl font-bold text-gray-900">{selectedContact.total_calls || 0}</p>
                <p className="text-[10px] text-gray-500 uppercase">Calls</p>
              </div>
              <div className="p-3 text-center border-r border-gray-100">
                <p className="text-xl font-bold text-gray-900">{selectedContact.appointments || 0}</p>
                <p className="text-[10px] text-gray-500 uppercase">Appts</p>
              </div>
              <div className="p-3 text-center">
                <p className="text-sm font-medium text-gray-900">{timeAgo(selectedContact.last_call_date)}</p>
                <p className="text-[10px] text-gray-500 uppercase">Last Call</p>
              </div>
            </div>

            <div className="p-5 space-y-6">
              {selectedContact.profile && (
                <div>
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-3">
                    <Dna className="w-4 h-4 text-[#2E75B6]" /> Caller DNA
                  </h3>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-500 flex items-center gap-1.5">
                        <MessageCircle className="w-3.5 h-3.5" /> Communication Style
                      </span>
                      <span className="text-xs font-semibold text-gray-900 capitalize">{selectedContact.profile.communication_style || 'Unknown'}</span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-500 flex items-center gap-1.5">
                        <Star className="w-3.5 h-3.5" /> VIP Status
                      </span>
                      {selectedContact.profile.is_vip ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-100 text-yellow-700">VIP</span>
                      ) : (
                        <span className="text-xs text-gray-400">No</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-500 flex items-center gap-1.5">
                        {selectedContact.profile.sentiment_trend === 'improving' ? <TrendingUp className="w-3.5 h-3.5 text-green-500" /> :
                         selectedContact.profile.sentiment_trend === 'declining' ? <TrendingDown className="w-3.5 h-3.5 text-red-500" /> :
                         <Minus className="w-3.5 h-3.5" />} Sentiment Trend
                      </span>
                      <span className={`text-xs font-semibold capitalize ${
                        selectedContact.profile.sentiment_trend === 'improving' ? 'text-green-600' :
                        selectedContact.profile.sentiment_trend === 'declining' ? 'text-red-600' : 'text-gray-600'
                      }`}>
                        {selectedContact.profile.sentiment_trend || 'Stable'}
                        {selectedContact.profile.sentiment_trend === 'improving' ? ' ↑' : selectedContact.profile.sentiment_trend === 'declining' ? ' ↓' : ' →'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                      <span className="text-xs text-gray-500 flex items-center gap-1.5">
                        <DollarSign className="w-3.5 h-3.5" /> Lifetime Value
                      </span>
                      <span className="text-xs font-semibold text-gray-900">${parseFloat(selectedContact.profile.lifetime_value_estimate || 0).toLocaleString()}</span>
                    </div>
                    {selectedContact.profile.avg_satisfaction_rating && (
                      <div className="flex items-center justify-between p-2.5 bg-gray-50 rounded-lg">
                        <span className="text-xs text-gray-500 flex items-center gap-1.5">
                          <Star className="w-3.5 h-3.5" /> Avg Satisfaction
                        </span>
                        <span className="text-xs font-semibold text-gray-900">{selectedContact.profile.avg_satisfaction_rating}/5</span>
                      </div>
                    )}
                    {selectedContact.profile.is_at_risk && (
                      <div className="flex items-center gap-2 p-2.5 bg-red-50 rounded-lg">
                        <ShieldAlert className="w-4 h-4 text-red-500 flex-shrink-0" />
                        <span className="text-xs font-medium text-red-700">At Risk — Needs attention</span>
                      </div>
                    )}
                    {selectedContact.profile.common_topics?.length > 0 && (
                      <div className="p-2.5 bg-gray-50 rounded-lg">
                        <span className="text-xs text-gray-500 mb-1.5 block">Common Topics</span>
                        <div className="flex flex-wrap gap-1">
                          {selectedContact.profile.common_topics.map((t: string) => (
                            <span key={t} className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-[10px] font-medium capitalize">{t}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    {selectedContact.profile.ai_notes && (
                      <div className="p-2.5 bg-amber-50 rounded-lg">
                        <span className="text-xs text-gray-500 mb-1 block">AI Notes</span>
                        <p className="text-xs text-gray-700">{selectedContact.profile.ai_notes}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-3">
                  <Clock className="w-4 h-4 text-[#2E75B6]" /> Call History
                </h3>
                {historyLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-5 h-5 animate-spin text-[#2E75B6]" />
                  </div>
                ) : callHistory?.recent_calls?.length ? (
                  <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                    {callHistory.recent_calls.map((call: any) => {
                      const outcome = getOutcomeStyle(call.call_outcome || call.status);
                      return (
                        <div key={call.id} className="border border-gray-100 rounded-lg p-3 hover:border-[#2E75B6]/20 transition-colors">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${outcome.bg} ${outcome.text}`}>
                                {outcome.label}
                              </span>
                              {call.duration_seconds && (
                                <span className="text-[10px] text-gray-400">{formatDuration(call.duration_seconds)}</span>
                              )}
                            </div>
                            <span className="text-[10px] text-gray-400">{formatDate(call.created_at || call.start_time)}</span>
                          </div>
                          <p className="text-xs text-gray-600 line-clamp-2">
                            {call.summary || call.caller_intent?.replace(/_/g, " ") || "No summary"}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 text-center py-4">No call history found</p>
                )}
              </div>

              {callHistory?.recent_calls?.some((c: any) => c.call_outcome === "appointment_booked") && (
                <div>
                  <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-3">
                    <Calendar className="w-4 h-4 text-[#2E75B6]" /> Appointments
                  </h3>
                  <div className="space-y-2">
                    {callHistory.recent_calls
                      .filter((c: any) => c.call_outcome === "appointment_booked")
                      .map((call: any) => (
                        <div key={call.id} className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
                          <Calendar className="w-4 h-4 text-[#2E75B6] flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900">Appointment booked</p>
                            <p className="text-xs text-gray-500">{formatDate(call.created_at || call.start_time)}</p>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              <div>
                <h3 className="font-semibold text-gray-900 flex items-center gap-2 mb-2">
                  <StickyNote className="w-4 h-4 text-[#2E75B6]" /> Notes
                </h3>
                <textarea
                  value={notes}
                  onChange={(e) => { setNotes(e.target.value); setNotesSaved(false); }}
                  placeholder="Add notes about this contact..."
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
                />
                <div className="flex items-center justify-between mt-2">
                  <button
                    onClick={saveNotes}
                    disabled={notesSaving}
                    className="flex items-center gap-1.5 px-4 py-2 bg-[#2E75B6] text-white rounded-lg text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50"
                  >
                    {notesSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {notesSaving ? "Saving..." : "Save Note"}
                  </button>
                  {notesSaved && (
                    <span className="flex items-center gap-1 text-xs text-green-600 font-medium">
                      <Check className="w-3 h-3" /> Saved
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SMS Modal */}
      {smsOpen && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4" onClick={() => setSmsOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">Send SMS</h3>
                <p className="text-xs text-gray-500">To: {smsPhone}</p>
              </div>
              <button onClick={() => setSmsOpen(false)}><X className="w-5 h-5 text-gray-400" /></button>
            </div>
            <div className="p-5">
              <textarea
                value={smsMsg}
                onChange={(e) => setSmsMsg(e.target.value)}
                placeholder="Type your message..."
                rows={4}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
              />
              <div className="flex justify-end mt-3">
                <button
                  onClick={handleSendSms}
                  disabled={!smsMsg.trim()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50"
                >
                  <Send className="w-4 h-4" /> Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] px-4 py-3 bg-gray-900 text-white text-sm rounded-xl shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
