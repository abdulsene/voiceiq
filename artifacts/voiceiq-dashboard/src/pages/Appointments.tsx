import { useEffect, useState } from "react";
import { getAppointments, sendSms, getCalendarAvailability, bookAppointment } from "../lib/api";
import { useLocation as useLocationCtx } from "../components/LocationContext";
import {
  Calendar,
  Clock,
  Phone,
  MessageSquare,
  ChevronLeft,
  ChevronRight,
  X,
  Send,
  Plus,
  List,
  CalendarDays,
  Search,
  ArrowUpDown,
  Ban,
  RefreshCw,
  UserX,
  CheckCircle2,
  AlertCircle,
  XCircle,
  BarChart3,
  TrendingUp,
} from "lucide-react";

function formatAppointmentDate(dateStr: string) {
  if (!dateStr) return "—";
  try {
    if (dateStr.match(/[A-Za-z]+day,/)) return dateStr;
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }) +
      " at " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  } catch { return dateStr; }
}

function timeAgo(date: string) {
  if (!date) return "—";
  const diff = Date.now() - new Date(date).getTime();
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return "Just now";
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function parseAppointmentDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
  } catch {}
  try {
    const match = dateStr.match(/(\w+),\s+(\w+)\s+(\d+)/);
    if (match) {
      const monthNames: Record<string, number> = {
        January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
        July: 6, August: 7, September: 8, October: 9, November: 10, December: 11,
      };
      const monthNum = monthNames[match[2]];
      if (monthNum !== undefined) {
        return new Date(new Date().getFullYear(), monthNum, parseInt(match[3]));
      }
    }
  } catch {}
  return null;
}

type ViewMode = "calendar" | "list";
type SortField = "date" | "name" | "status";

export default function Appointments() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>("calendar");
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsPhone, setSmsPhone] = useState("");
  const [smsMsg, setSmsMsg] = useState("");
  const [smsName, setSmsName] = useState("");
  const [bookOpen, setBookOpen] = useState(false);
  const [bookForm, setBookForm] = useState({ caller_name: "", caller_phone: "", reason: "", calendar_provider: "google" });
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [booking, setBooking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [listSearch, setListSearch] = useState("");
  const [listSort, setListSort] = useState<SortField>("date");

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const { selectedLocationId } = useLocationCtx();
  const locParam = selectedLocationId === "all" ? undefined : selectedLocationId;

  useEffect(() => {
    setLoading(true);
    getAppointments(locParam)
      .then((d) => setAppointments(d.appointments || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [locParam]);

  const getDaysInMonth = (date: Date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return { firstDay, daysInMonth, year, month };
  };

  const { firstDay, daysInMonth, year, month } = getDaysInMonth(currentMonth);

  const getAppointmentsForDay = (day: number) => {
    return appointments.filter((a: any) => {
      const d = parseAppointmentDate(a.date_time || a.created_at);
      if (!d) return false;
      return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
    });
  };

  const openReminderSms = (apt: any) => {
    const phone = apt.caller_number || apt.caller_phone || "";
    const name = apt.caller_name || "there";
    const time = apt.date_time || "your scheduled time";
    setSmsPhone(phone);
    setSmsName(name);
    setSmsMsg(`Hi ${name}! Reminder: your appointment is tomorrow at ${time}. Reply CANCEL to cancel or call us to reschedule.`);
    setSmsOpen(true);
  };

  const handleSendSms = async () => {
    if (!smsPhone || !smsMsg.trim()) return;
    try {
      await sendSms(smsPhone, smsMsg);
      showToast("Reminder SMS sent");
      setSmsOpen(false);
    } catch { showToast("Failed to send SMS"); }
  };

  const fetchSlots = async () => {
    setSlotsLoading(true);
    setAvailableSlots([]);
    try {
      const data = await getCalendarAvailability(bookForm.calendar_provider);
      setAvailableSlots(data.slots || []);
    } catch { showToast("Failed to fetch availability"); }
    setSlotsLoading(false);
  };

  const handleBook = async () => {
    if (!selectedSlot || !bookForm.caller_name) return;
    setBooking(true);
    try {
      await bookAppointment({
        caller_name: bookForm.caller_name,
        caller_phone: bookForm.caller_phone,
        appointment_datetime: selectedSlot,
        reason: bookForm.reason,
        calendar_provider: bookForm.calendar_provider,
      });
      showToast("Appointment booked!");
      setBookOpen(false);
      setBookForm({ caller_name: "", caller_phone: "", reason: "", calendar_provider: "google" });
      setSelectedSlot("");
      setAvailableSlots([]);
      const d = await getAppointments();
      setAppointments(d.appointments || []);
    } catch { showToast("Failed to book appointment"); }
    setBooking(false);
  };

  const getStatusStyle = (status: string) => {
    switch (status?.toLowerCase()) {
      case "confirmed": return { bg: "bg-green-100", text: "text-green-700", icon: CheckCircle2 };
      case "cancelled": return { bg: "bg-red-100", text: "text-red-700", icon: XCircle };
      case "no-show": return { bg: "bg-gray-100", text: "text-gray-700", icon: UserX };
      default: return { bg: "bg-amber-100", text: "text-amber-700", icon: AlertCircle };
    }
  };

  const getProviderBadge = (provider: string) => {
    if (provider === "outlook") return { color: "bg-blue-100 text-blue-700", label: "🔵 Outlook" };
    return { color: "bg-green-100 text-green-700", label: "🟢 Google" };
  };

  const monthName = currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const filteredAppointments = appointments
    .filter((a) => {
      if (!listSearch) return true;
      const q = listSearch.toLowerCase();
      return (a.caller_name || "").toLowerCase().includes(q) ||
        (a.caller_number || "").includes(q) ||
        (a.reason || "").toLowerCase().includes(q);
    })
    .sort((a, b) => {
      if (listSort === "name") return (a.caller_name || "").localeCompare(b.caller_name || "");
      if (listSort === "status") return (a.status || "").localeCompare(b.status || "");
      return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    });

  const stats = {
    thisMonth: appointments.filter((a) => {
      const d = parseAppointmentDate(a.date_time || a.created_at);
      if (!d) return false;
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length,
    noShowRate: appointments.length > 0
      ? Math.round((appointments.filter((a) => a.status === "no-show").length / appointments.length) * 100)
      : 0,
    popularDay: (() => {
      const days: Record<string, number> = {};
      appointments.forEach((a) => {
        const d = parseAppointmentDate(a.date_time || a.created_at);
        if (d) {
          const day = d.toLocaleDateString("en-US", { weekday: "long" });
          days[day] = (days[day] || 0) + 1;
        }
      });
      return Object.entries(days).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    })(),
    popularTime: (() => {
      const times: Record<string, number> = {};
      appointments.forEach((a) => {
        const match = (a.date_time || "").match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
        if (match) times[match[1]] = (times[match[1]] || 0) + 1;
      });
      return Object.entries(times).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";
    })(),
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Appointments</h1>
          <p className="text-sm text-gray-500 mt-1">Scheduled appointments across Google Calendar + Outlook</p>
        </div>
        <button
          onClick={() => { setBookOpen(true); setAvailableSlots([]); setSelectedSlot(""); }}
          className="flex items-center gap-2 px-4 py-2 bg-[#2E75B6] text-white rounded-lg text-sm font-medium hover:bg-[#2563a0]"
        >
          <Plus className="w-4 h-4" /> Book Appointment
        </button>
      </div>

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("calendar")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              viewMode === "calendar" ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            <CalendarDays className="w-4 h-4" /> Calendar View
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              viewMode === "list" ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            <List className="w-4 h-4" /> List View
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-green-700 font-medium">
            🟢 Google Calendar
          </span>
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 font-medium">
            🔵 Outlook
          </span>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <>
          <div className="bg-white rounded-xl border border-gray-200 mb-6">
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
              <button
                onClick={() => setCurrentMonth(new Date(year, month - 1))}
                className="p-1.5 hover:bg-gray-100 rounded-lg"
              >
                <ChevronLeft className="w-5 h-5 text-gray-600" />
              </button>
              <h2 className="font-semibold text-gray-900">{monthName}</h2>
              <button
                onClick={() => setCurrentMonth(new Date(year, month + 1))}
                className="p-1.5 hover:bg-gray-100 rounded-lg"
              >
                <ChevronRight className="w-5 h-5 text-gray-600" />
              </button>
            </div>
            <div className="grid grid-cols-7">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                <div key={d} className="px-2 py-2 text-center text-[11px] font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                  {d}
                </div>
              ))}
              {Array.from({ length: firstDay }).map((_, i) => (
                <div key={`empty-${i}`} className="px-2 py-3 border-b border-r border-gray-50 min-h-[90px]" />
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const day = i + 1;
                const dayApts = getAppointmentsForDay(day);
                const isToday = new Date().getDate() === day && new Date().getMonth() === month && new Date().getFullYear() === year;
                const isSelected = selectedDay === day;
                return (
                  <div
                    key={day}
                    onClick={() => setSelectedDay(isSelected ? null : day)}
                    className={`px-2 py-1.5 border-b border-r border-gray-50 min-h-[90px] cursor-pointer transition-colors ${
                      isToday ? "border-2 border-[#2E75B6] bg-blue-50/30" : ""
                    } ${isSelected ? "bg-blue-50" : "hover:bg-gray-50/50"}`}
                  >
                    <span className={`text-xs font-medium inline-flex items-center justify-center w-6 h-6 rounded-full ${
                      isToday ? "bg-[#2E75B6] text-white" : "text-gray-600"
                    }`}>
                      {day}
                    </span>
                    {dayApts.slice(0, 3).map((a: any, idx: number) => (
                      <div
                        key={idx}
                        className={`mt-1 px-1.5 py-0.5 rounded text-[10px] truncate ${
                          (a.calendar_provider || a.event_id?.includes("outlook") ? false : true)
                            ? "bg-green-100 text-green-700"
                            : "bg-blue-100 text-blue-700"
                        }`}
                      >
                        {a.caller_name || "Appointment"}
                      </div>
                    ))}
                    {dayApts.length > 3 && (
                      <div className="mt-0.5 text-[10px] text-gray-400 font-medium">+{dayApts.length - 3} more</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {selectedDay && (
            <div className="bg-white rounded-xl border border-gray-200 mb-6 p-4">
              <h3 className="font-semibold text-gray-900 mb-3">
                {new Date(year, month, selectedDay).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              </h3>
              {getAppointmentsForDay(selectedDay).length === 0 ? (
                <p className="text-sm text-gray-400">No appointments on this day</p>
              ) : (
                <div className="space-y-2">
                  {getAppointmentsForDay(selectedDay).map((apt: any) => {
                    const provider = getProviderBadge(apt.calendar_provider || "google");
                    return (
                      <div key={apt.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 text-sm font-semibold">
                            {(apt.caller_name || "?")[0].toUpperCase()}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{apt.caller_name || "Unknown"}</p>
                            <p className="text-xs text-gray-500">{apt.date_time || "—"}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${provider.color}`}>
                            {provider.label}
                          </span>
                          <button
                            onClick={() => openReminderSms(apt)}
                            className="p-1.5 rounded-lg hover:bg-gray-200 text-gray-400 hover:text-green-600"
                            title="Send Reminder"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900">Upcoming Appointments</h2>
              <span className="text-xs text-gray-400">{appointments.length} total</span>
            </div>
            <div className="divide-y divide-gray-50">
              {appointments.length === 0 ? (
                <div className="p-12 text-center">
                  <Calendar className="w-10 h-10 text-gray-200 mx-auto mb-3" />
                  <p className="text-sm font-medium text-gray-500">No appointments booked yet</p>
                  <p className="text-xs text-gray-400 mt-1">When your AI books appointments they'll show up here.</p>
                </div>
              ) : (
                appointments.map((apt: any) => {
                  const status = getStatusStyle(apt.status || "confirmed");
                  const provider = getProviderBadge(apt.calendar_provider || "google");
                  const StatusIcon = status.icon;
                  return (
                    <div key={apt.id} className="px-5 py-4 flex items-center justify-between hover:bg-gray-50/50 group transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-100 to-purple-50 flex items-center justify-center text-purple-700 font-semibold text-sm">
                          {(apt.caller_name || "?")[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-900">{apt.caller_name || "Unknown"}</p>
                          <div className="flex items-center gap-3 text-xs text-gray-500 mt-0.5">
                            <span className="flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {apt.caller_number || "—"}
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatAppointmentDate(apt.date_time || apt.created_at)}
                            </span>
                          </div>
                          {apt.reason && apt.reason !== "appointment_booking" && (
                            <p className="text-xs text-gray-400 mt-0.5">{apt.reason}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${provider.color}`}>
                          {provider.label}
                        </span>
                        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${status.bg} ${status.text}`}>
                          <StatusIcon className="w-3 h-3" />
                          {(apt.status || "confirmed").charAt(0).toUpperCase() + (apt.status || "confirmed").slice(1)}
                        </span>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openReminderSms(apt)}
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-green-600"
                            title="Send Reminder SMS"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-500"
                            title="Cancel"
                          >
                            <Ban className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-[#2E75B6]"
                            title="Reschedule"
                          >
                            <RefreshCw className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-amber-500"
                            title="Mark No-Show"
                          >
                            <UserX className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="p-4 border-b border-gray-100 flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search appointments..."
                className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                value={listSearch}
                onChange={(e) => setListSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1">
              {(["date", "name", "status"] as SortField[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setListSort(s)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    listSort === s ? "bg-[#2E75B6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-100">
                  <th className="px-5 py-3 font-medium">Caller</th>
                  <th className="px-5 py-3 font-medium">Phone</th>
                  <th className="px-5 py-3 font-medium">Date & Time</th>
                  <th className="px-5 py-3 font-medium">Reason</th>
                  <th className="px-5 py-3 font-medium text-center">Source</th>
                  <th className="px-5 py-3 font-medium text-center">Status</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredAppointments.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-5 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <Calendar className="w-10 h-10 text-gray-200 mb-3" />
                        <p className="text-sm font-medium text-gray-500">No appointments booked yet</p>
                        <p className="text-xs text-gray-400 mt-1">When your AI books appointments they'll show up here.</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredAppointments.map((apt: any) => {
                    const status = getStatusStyle(apt.status || "confirmed");
                    const provider = getProviderBadge(apt.calendar_provider || "google");
                    const StatusIcon = status.icon;
                    return (
                      <tr key={apt.id} className="hover:bg-gray-50/70 transition-colors">
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-700 text-sm font-semibold">
                              {(apt.caller_name || "?")[0].toUpperCase()}
                            </div>
                            <span className="text-sm font-medium text-gray-900">{apt.caller_name || "Unknown"}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-sm text-gray-500 font-mono">{apt.caller_number || "—"}</td>
                        <td className="px-5 py-3 text-sm text-gray-700">{formatAppointmentDate(apt.date_time || apt.created_at)}</td>
                        <td className="px-5 py-3 text-xs text-gray-500">{apt.reason === "appointment_booking" ? "Booking" : apt.reason || "—"}</td>
                        <td className="px-5 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${provider.color}`}>
                            {provider.label}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-center">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${status.bg} ${status.text}`}>
                            <StatusIcon className="w-3 h-3" />
                            {(apt.status || "confirmed").charAt(0).toUpperCase() + (apt.status || "confirmed").slice(1)}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openReminderSms(apt)}
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-green-600"
                              title="Send Reminder"
                            >
                              <MessageSquare className="w-4 h-4" />
                            </button>
                            <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-red-500" title="Cancel">
                              <Ban className="w-4 h-4" />
                            </button>
                            <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-[#2E75B6]" title="Reschedule">
                              <RefreshCw className="w-4 h-4" />
                            </button>
                            <button className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-amber-500" title="No-Show">
                              <UserX className="w-4 h-4" />
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
      )}

      <div className="grid grid-cols-4 gap-4 mt-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center mx-auto mb-2">
            <Calendar className="w-4 h-4 text-purple-600" />
          </div>
          <p className="text-2xl font-bold text-gray-900">{stats.thisMonth}</p>
          <p className="text-xs text-gray-500">This Month</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center mx-auto mb-2">
            <UserX className="w-4 h-4 text-red-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900">{stats.noShowRate}%</p>
          <p className="text-xs text-gray-500">No-Show Rate</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center mx-auto mb-2">
            <CalendarDays className="w-4 h-4 text-blue-600" />
          </div>
          <p className="text-lg font-bold text-gray-900">{stats.popularDay}</p>
          <p className="text-xs text-gray-500">Popular Day</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center mx-auto mb-2">
            <Clock className="w-4 h-4 text-amber-600" />
          </div>
          <p className="text-lg font-bold text-gray-900">{stats.popularTime}</p>
          <p className="text-xs text-gray-500">Popular Time</p>
        </div>
      </div>

      {bookOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setBookOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Book Appointment</h3>
              <button onClick={() => setBookOpen(false)}>
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Caller Name</label>
                <input
                  value={bookForm.caller_name}
                  onChange={(e) => setBookForm({ ...bookForm, caller_name: e.target.value })}
                  placeholder="Full name"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                <input
                  value={bookForm.caller_phone}
                  onChange={(e) => setBookForm({ ...bookForm, caller_phone: e.target.value })}
                  placeholder="+1 (555) 000-0000"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Reason / Service</label>
                <input
                  value={bookForm.reason}
                  onChange={(e) => setBookForm({ ...bookForm, reason: e.target.value })}
                  placeholder="e.g. Initial consultation"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Calendar</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setBookForm({ ...bookForm, calendar_provider: "google" })}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      bookForm.calendar_provider === "google"
                        ? "bg-green-50 border-green-200 text-green-700"
                        : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    🟢 Google Calendar
                  </button>
                  <button
                    onClick={() => setBookForm({ ...bookForm, calendar_provider: "outlook" })}
                    className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                      bookForm.calendar_provider === "outlook"
                        ? "bg-blue-50 border-blue-200 text-blue-700"
                        : "bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    🔵 Outlook
                  </button>
                </div>
              </div>
              <button
                onClick={fetchSlots}
                disabled={slotsLoading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border border-[#2E75B6] text-[#2E75B6] rounded-lg text-sm font-medium hover:bg-[#2E75B6]/5 disabled:opacity-50"
              >
                {slotsLoading ? (
                  <div className="animate-spin w-4 h-4 border-2 border-[#2E75B6] border-t-transparent rounded-full" />
                ) : (
                  <Calendar className="w-4 h-4" />
                )}
                Fetch Available Slots
              </button>
              {availableSlots.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Available Slots</label>
                  <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                    {availableSlots.map((slot) => (
                      <button
                        key={slot}
                        onClick={() => setSelectedSlot(slot)}
                        className={`px-3 py-2 rounded-lg text-xs font-medium border transition-colors text-left ${
                          selectedSlot === slot
                            ? "bg-[#2E75B6] text-white border-[#2E75B6]"
                            : "bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100"
                        }`}
                      >
                        {slot}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={handleBook}
                disabled={!selectedSlot || !bookForm.caller_name || booking}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white rounded-lg text-sm font-medium hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {booking ? (
                  <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                Book Appointment
              </button>
            </div>
          </div>
        </div>
      )}

      {smsOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSmsOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-gray-100 flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">Send Reminder SMS</h3>
                <p className="text-xs text-gray-500">To: {smsName} ({smsPhone})</p>
              </div>
              <button onClick={() => setSmsOpen(false)}>
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex gap-2 flex-wrap">
                {[
                  `Hi ${smsName}! Reminder: your appointment is tomorrow. Reply CANCEL to cancel or call us to reschedule.`,
                  `Hi ${smsName}! Just confirming your upcoming appointment. See you soon!`,
                  `Hi ${smsName}! We look forward to seeing you. Please arrive 10 minutes early.`,
                ].map((t, i) => (
                  <button
                    key={i}
                    onClick={() => setSmsMsg(t)}
                    className="px-2.5 py-1 rounded-full bg-gray-100 text-xs text-gray-600 hover:bg-gray-200"
                  >
                    {t.substring(0, 35)}...
                  </button>
                ))}
              </div>
              <div className="relative">
                <textarea
                  value={smsMsg}
                  onChange={(e) => setSmsMsg(e.target.value.slice(0, 160))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
                />
                <span className="absolute bottom-2 right-2 text-[10px] text-gray-400">{smsMsg.length}/160</span>
              </div>
              <button
                onClick={handleSendSms}
                disabled={!smsMsg.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" /> Send Reminder
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-gray-900 text-white text-sm rounded-lg shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
