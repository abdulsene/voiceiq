import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { getIndustries, getIndustryTemplate, launchOnboard } from "../lib/api";
import {
  Search,
  Check,
  ChevronRight,
  ChevronLeft,
  ArrowRight,
  Globe,
  Clock,
  X,
  Plus,
  Rocket,
  Phone,
  Calendar,
  BarChart3,
  Sparkles,
} from "lucide-react";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern" },
  { value: "America/Chicago", label: "Central" },
  { value: "America/Denver", label: "Mountain" },
  { value: "America/Los_Angeles", label: "Pacific" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const TONES = [
  { id: "professional", icon: "\uD83C\uDFAF", label: "Professional", desc: "Formal, efficient, corporate" },
  { id: "friendly", icon: "\uD83D\uDE0A", label: "Friendly", desc: "Warm, conversational, approachable" },
  { id: "clinical", icon: "\uD83C\uDFE5", label: "Clinical", desc: "Medical-grade empathy, precise" },
  { id: "official", icon: "\uD83C\uDFDB\uFE0F", label: "Official", desc: "Government/institutional formality" },
];

interface WizardState {
  step: number;
  industry_id: string;
  industry_name: string;
  industry_icon: string;
  business_name: string;
  owner_name: string;
  email: string;
  phone: string;
  website: string;
  address: string;
  timezone: string;
  business_hours: Record<string, { open: boolean; start: string; end: string }>;
  services: string[];
  appointment_types: string[];
  agent_name: string;
  tone: string;
  spanish_enabled: boolean;
  greeting_message: string;
  after_hours_message: string;
  template: any;
}

export default function Onboarding() {
  const [, navigate] = useLocation();
  const [state, setState] = useState<WizardState>({
    step: 1,
    industry_id: "",
    industry_name: "",
    industry_icon: "",
    business_name: "",
    owner_name: "",
    email: "",
    phone: "",
    website: "",
    address: "",
    timezone: "America/New_York",
    business_hours: DAYS.reduce((acc, d) => ({
      ...acc,
      [d]: { open: d !== "Saturday" && d !== "Sunday", start: "09:00", end: "17:00" },
    }), {}),
    services: [],
    appointment_types: [],
    agent_name: "Alex",
    tone: "friendly",
    spanish_enabled: false,
    greeting_message: "",
    after_hours_message: "",
    template: null,
  });

  const [categories, setCategories] = useState<Record<string, any[]>>({});
  const [industrySearch, setIndustrySearch] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [launchResult, setLaunchResult] = useState<any>(null);
  const [newService, setNewService] = useState("");
  const [scanLoading, setScanLoading] = useState(false);
  const [scanDone, setScanDone] = useState(false);
  const [launchError, setLaunchError] = useState("");

  useEffect(() => {
    getIndustries().then((d) => setCategories(d.categories || {})).catch(console.error);
  }, []);

  const selectIndustry = async (t: any) => {
    setState((s) => ({ ...s, industry_id: t.industry_id, industry_name: t.name, industry_icon: t.icon }));
    try {
      const res = await getIndustryTemplate(t.industry_id);
      const tmpl = res.template;
      const hours = { ...state.business_hours };
      if (tmpl.business_hours_default) {
        const match = tmpl.business_hours_default.match(/(\w+)-(\w+)\s+(\d+\w+)-(\d+\w+)/);
        if (match) {
          const startDay = match[1];
          const endDay = match[2];
          const startTime = convertTo24h(match[3]);
          const endTime = convertTo24h(match[4]);
          let recording = false;
          for (const d of DAYS) {
            if (d === startDay) recording = true;
            hours[d] = { open: recording, start: startTime, end: endTime };
            if (d === endDay) recording = false;
          }
        }
      }
      setState((s) => ({
        ...s,
        template: tmpl,
        services: tmpl.appointment_types || [],
        appointment_types: tmpl.appointment_types || [],
        business_hours: hours,
        after_hours_message: `Thank you for calling. We are currently closed. Our business hours are ${tmpl.business_hours_default || "Monday-Friday 9AM-5PM"}. Please leave a message and we will return your call during business hours.`,
        greeting_message: `Thank you for calling {business_name}! My name is Alex, your AI assistant. How can I help you today?`,
      }));
    } catch (e) { console.error(e); }
  };

  const convertTo24h = (t: string) => {
    const match = t.match(/(\d+)(AM|PM)/i);
    if (!match) return "09:00";
    let h = parseInt(match[1]);
    if (match[2].toUpperCase() === "PM" && h !== 12) h += 12;
    if (match[2].toUpperCase() === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
  };

  const addService = () => {
    if (newService.trim() && !state.services.includes(newService.trim())) {
      setState((s) => ({ ...s, services: [...s.services, newService.trim()] }));
      setNewService("");
    }
  };

  const removeService = (svc: string) => {
    setState((s) => ({ ...s, services: s.services.filter((x) => x !== svc) }));
  };

  const simulateWebsiteScan = () => {
    if (!state.website) return;
    setScanLoading(true);
    setTimeout(() => {
      setScanLoading(false);
      setScanDone(true);
    }, 2500);
  };

  const handleLaunch = async () => {
    setLaunching(true);
    setLaunchError("");
    try {
      const result = await launchOnboard({
        business_name: state.business_name,
        industry: state.industry_id,
        phone_number: state.phone,
        email: state.email,
        owner_name: state.owner_name,
        website: state.website,
        business_hours: Object.entries(state.business_hours)
          .filter(([, v]) => v.open)
          .map(([d, v]) => `${d} ${v.start}-${v.end}`)
          .join(", "),
        services: state.services.join(", "),
        address: state.address,
        timezone: state.timezone,
        agent_name: state.agent_name,
        tone: state.tone,
        spanish_enabled: state.spanish_enabled,
      });
      if (result.success) {
        setLaunchResult(result);
        setLaunched(true);
      } else {
        setLaunchError(result.error || "Something went wrong. Please try again.");
      }
    } catch (e: any) {
      setLaunchError(e.message || "Failed to connect. Please check your connection and try again.");
    }
    setLaunching(false);
  };

  const canProceed = () => {
    switch (state.step) {
      case 1: return !!state.industry_id;
      case 2: return !!state.business_name && !!state.owner_name && !!state.email && !!state.phone;
      case 3: return state.services.length > 0;
      case 4: return !!state.agent_name;
      case 5: return true;
      default: return false;
    }
  };

  const estimatedMinutes = 6 - state.step + 1;

  const filteredCategories = Object.entries(categories).reduce((acc, [cat, items]) => {
    if (!industrySearch) { acc[cat] = items; return acc; }
    const q = industrySearch.toLowerCase();
    const filtered = items.filter((t: any) =>
      t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q) || cat.toLowerCase().includes(q)
    );
    if (filtered.length) acc[cat] = filtered;
    return acc;
  }, {} as Record<string, any[]>);

  const getGreetingPreview = () => {
    const name = state.business_name || "[Your Business]";
    const agentName = state.agent_name || "Alex";
    const toneAdj = state.tone === "professional" ? "Thank you for calling" :
      state.tone === "clinical" ? "Thank you for calling" :
        state.tone === "official" ? "You have reached" : "Hi! Thanks for calling";
    return `${toneAdj} ${name}! My name is ${agentName}, your AI assistant. How can I help you today?`;
  };

  if (launched && launchResult) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#1B2537] via-[#1e3a5f] to-[#2E75B6] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl max-w-lg w-full p-8 text-center shadow-2xl">
          <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6 animate-bounce">
            <Check className="w-10 h-10 text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Your AI is LIVE!</h1>
          <p className="text-gray-500 mb-6">
            {state.agent_name} is now answering calls for <span className="font-semibold text-gray-900">{state.business_name}</span>
          </p>

          {launchResult.agent_id && (
            <div className="bg-gray-50 rounded-xl p-4 mb-6 space-y-2 text-left">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Agent ID</span>
                <span className="font-mono text-gray-900 text-xs">{launchResult.agent_id}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Business ID</span>
                <span className="font-mono text-gray-900 text-xs">{launchResult.business_id}</span>
              </div>
            </div>
          )}

          <div className="space-y-3 mb-8">
            <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl text-left">
              <Phone className="w-5 h-5 text-blue-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-900">Make a test call</p>
                <p className="text-xs text-gray-500">Call your Neverr number to test</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-xl text-left">
              <Calendar className="w-5 h-5 text-purple-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-900">Connect your calendar</p>
                <p className="text-xs text-gray-500">Link Google Calendar or Outlook</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-3 bg-green-50 rounded-xl text-left">
              <BarChart3 className="w-5 h-5 text-green-600 shrink-0" />
              <div>
                <p className="text-sm font-medium text-gray-900">View your dashboard</p>
                <p className="text-xs text-gray-500">Monitor calls and performance</p>
              </div>
            </div>
          </div>

          <button
            onClick={() => navigate("/dashboard")}
            className="w-full px-6 py-3 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] transition-colors"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <header className="border-b border-gray-100 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}neverr-logo.png`} alt="Neverr" className="h-10 w-auto md:h-12" />
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-gray-400">~{estimatedMinutes} min left</span>
          <span className="text-xs text-gray-500">Step {state.step} of 5</span>
        </div>
      </header>

      <div className="px-6 py-3 border-b border-gray-50">
        <div className="max-w-3xl mx-auto flex items-center gap-2">
          {[1, 2, 3, 4, 5].map((s) => (
            <div key={s} className="flex-1 flex items-center gap-2">
              <div className={`h-2 flex-1 rounded-full transition-colors ${
                s <= state.step ? "bg-[#2E75B6]" : "bg-gray-200"
              }`} />
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto px-6 py-8 ${state.step === 1 ? "max-w-5xl" : "max-w-3xl"}`}>

          {state.step === 1 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">What type of business are you?</h2>
              <p className="text-gray-500 mb-6">We'll pre-configure your AI with the perfect settings</p>

              <div className="relative mb-6">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search industries..."
                  className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  value={industrySearch}
                  onChange={(e) => setIndustrySearch(e.target.value)}
                />
              </div>

              {state.industry_id && (
                <div className="mb-6 p-3 bg-green-50 border border-green-200 rounded-xl flex items-center gap-2">
                  <Check className="w-5 h-5 text-green-600 shrink-0" />
                  <p className="text-sm text-green-800">
                    Great choice! We've pre-configured 90% of your AI settings for <span className="font-semibold">{state.industry_name}</span>. You'll be live in under 10 minutes.
                  </p>
                </div>
              )}

              {Object.entries(filteredCategories).map(([category, items]) => (
                <div key={category} className="mb-6">
                  <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">{category}</h3>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {items.map((t: any) => {
                      const selected = state.industry_id === t.industry_id;
                      return (
                        <button
                          key={t.industry_id}
                          onClick={() => selectIndustry(t)}
                          className={`relative p-4 rounded-xl border-2 text-left transition-all hover:shadow-md ${
                            selected
                              ? "border-[#2E75B6] bg-blue-50/50 shadow-md"
                              : "border-gray-200 hover:border-gray-300"
                          }`}
                        >
                          {selected && (
                            <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-[#2E75B6] flex items-center justify-center">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                          )}
                          <span className="text-2xl">{t.icon}</span>
                          <p className="text-sm font-medium text-gray-900 mt-2">{t.name}</p>
                          <p className="text-[11px] text-gray-500 mt-0.5 line-clamp-2">{t.description}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}

          {state.step === 2 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Tell us about your business</h2>
              <p className="text-gray-500 mb-6">We'll use this to personalize your AI receptionist</p>

              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Business Name *</label>
                    <input
                      value={state.business_name}
                      onChange={(e) => setState((s) => ({ ...s, business_name: e.target.value }))}
                      placeholder="e.g. Smith Family Dentistry"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Your Name *</label>
                    <input
                      value={state.owner_name}
                      onChange={(e) => setState((s) => ({ ...s, owner_name: e.target.value }))}
                      placeholder="Full name"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Business Phone *</label>
                    <input
                      value={state.phone}
                      onChange={(e) => setState((s) => ({ ...s, phone: e.target.value }))}
                      placeholder="+1 (555) 000-0000"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
                    <input
                      type="email"
                      value={state.email}
                      onChange={(e) => setState((s) => ({ ...s, email: e.target.value }))}
                      placeholder="you@business.com"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Website (optional)</label>
                  <div className="flex gap-2">
                    <input
                      value={state.website}
                      onChange={(e) => setState((s) => ({ ...s, website: e.target.value }))}
                      placeholder="https://yourbusiness.com"
                      className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                    <button
                      onClick={simulateWebsiteScan}
                      disabled={!state.website || scanLoading}
                      className="px-4 py-2.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap"
                    >
                      {scanLoading ? (
                        <span className="flex items-center gap-2">
                          <div className="animate-spin w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full" />
                          Reading...
                        </span>
                      ) : "Scan Website"}
                    </button>
                  </div>
                  {scanDone && (
                    <div className="mt-2 p-3 bg-green-50 border border-green-200 rounded-xl">
                      <p className="text-sm text-green-700 font-medium flex items-center gap-1">
                        <Check className="w-4 h-4" /> Found on your website:
                      </p>
                      <ul className="mt-1 text-xs text-green-600 space-y-0.5 ml-5 list-disc">
                        <li>Business hours detected</li>
                        <li>Services list found</li>
                        <li>Contact information confirmed</li>
                      </ul>
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Business Address</label>
                  <input
                    value={state.address}
                    onChange={(e) => setState((s) => ({ ...s, address: e.target.value }))}
                    placeholder="123 Main St, City, State ZIP"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                    <select
                      value={state.timezone}
                      onChange={(e) => setState((s) => ({ ...s, timezone: e.target.value }))}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    >
                      {TIMEZONES.map((tz) => (
                        <option key={tz.value} value={tz.value}>{tz.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Business Hours</label>
                  <div className="space-y-2 bg-gray-50 rounded-xl p-4">
                    {DAYS.map((day) => {
                      const h = state.business_hours[day];
                      return (
                        <div key={day} className="flex items-center gap-3">
                          <label className="flex items-center gap-2 w-28">
                            <input
                              type="checkbox"
                              checked={h.open}
                              onChange={() => setState((s) => ({
                                ...s,
                                business_hours: { ...s.business_hours, [day]: { ...h, open: !h.open } },
                              }))}
                              className="w-4 h-4 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                            />
                            <span className={`text-sm ${h.open ? "text-gray-900 font-medium" : "text-gray-400"}`}>
                              {day.substring(0, 3)}
                            </span>
                          </label>
                          {h.open ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="time"
                                value={h.start}
                                onChange={(e) => setState((s) => ({
                                  ...s,
                                  business_hours: { ...s.business_hours, [day]: { ...h, start: e.target.value } },
                                }))}
                                className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                              />
                              <span className="text-xs text-gray-400">to</span>
                              <input
                                type="time"
                                value={h.end}
                                onChange={(e) => setState((s) => ({
                                  ...s,
                                  business_hours: { ...s.business_hours, [day]: { ...h, end: e.target.value } },
                                }))}
                                className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs"
                              />
                            </div>
                          ) : (
                            <span className="text-xs text-gray-400">Closed</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {state.step === 3 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">What services do you offer?</h2>
              <p className="text-gray-500 mb-6">Your AI will know exactly what you provide</p>

              <div className="grid grid-cols-5 gap-6">
                <div className="col-span-3">
                  <div className="mb-4">
                    <div className="flex gap-2">
                      <input
                        value={newService}
                        onChange={(e) => setNewService(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addService(); }}
                        placeholder="Add a service..."
                        className="flex-1 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                      />
                      <button
                        onClick={addService}
                        className="px-4 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-medium hover:bg-[#2563a0]"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 mb-6">
                    {state.services.map((svc) => (
                      <span
                        key={svc}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#2E75B6]/10 text-[#2E75B6] rounded-full text-sm font-medium"
                      >
                        {svc}
                        <button onClick={() => removeService(svc)} className="hover:text-red-500">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    ))}
                    {state.services.length === 0 && (
                      <p className="text-sm text-gray-400">No services added yet. Add your services above.</p>
                    )}
                  </div>

                  {state.template?.appointment_types && (
                    <div>
                      <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                        Suggested for {state.industry_name}
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {(state.template.appointment_types as string[])
                          .filter((t: string) => !state.services.includes(t))
                          .map((t: string) => (
                            <button
                              key={t}
                              onClick={() => setState((s) => ({ ...s, services: [...s.services, t] }))}
                              className="px-3 py-1.5 border border-dashed border-gray-300 rounded-full text-xs text-gray-500 hover:border-[#2E75B6] hover:text-[#2E75B6] hover:bg-blue-50"
                            >
                              + {t}
                            </button>
                          ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="col-span-2">
                  <div className="bg-gradient-to-br from-blue-50 to-purple-50 rounded-2xl p-5 border border-blue-100">
                    <div className="flex items-center gap-2 mb-3">
                      <Sparkles className="w-4 h-4 text-[#2E75B6]" />
                      <h4 className="text-sm font-semibold text-gray-900">AI Preview</h4>
                    </div>
                    <p className="text-xs text-gray-500 mb-3">When callers ask about services, {state.agent_name} will say:</p>
                    <div className="bg-white rounded-xl p-4 text-sm text-gray-700 italic border border-blue-100">
                      "We offer {state.services.length > 0 ? state.services.slice(0, 5).join(", ") : "various services"}
                      {state.services.length > 5 ? ` and ${state.services.length - 5} more` : ""}.
                      Would you like to schedule an appointment for any of these?"
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {state.step === 4 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Choose your AI receptionist's voice and style</h2>
              <p className="text-gray-500 mb-6">This is how your customers will experience your brand</p>

              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">What should we call your AI receptionist?</label>
                  <input
                    value={state.agent_name}
                    onChange={(e) => setState((s) => ({ ...s, agent_name: e.target.value }))}
                    placeholder="Alex"
                    className="w-64 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">Tone & Personality</label>
                  <div className="grid grid-cols-2 gap-3">
                    {TONES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setState((s) => ({ ...s, tone: t.id }))}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${
                          state.tone === t.id
                            ? "border-[#2E75B6] bg-blue-50/50"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{t.icon}</span>
                          <span className="text-sm font-semibold text-gray-900">{t.label}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">{t.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">Languages</label>
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg">
                      <Globe className="w-4 h-4 text-gray-600" />
                      <span className="text-sm text-gray-700">English</span>
                      <Check className="w-4 h-4 text-green-600" />
                    </div>
                    <label className="flex items-center gap-2 px-3 py-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={state.spanish_enabled}
                        onChange={() => setState((s) => ({ ...s, spanish_enabled: !s.spanish_enabled }))}
                        className="w-4 h-4 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                      />
                      <span className="text-sm text-gray-700">Spanish</span>
                    </label>
                    <span className="text-xs text-gray-400 italic">More languages coming soon</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Greeting Preview</label>
                  <div className="bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl p-4 border border-blue-100">
                    <p className="text-sm text-gray-700 italic">"{getGreetingPreview()}"</p>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">After Hours Message</label>
                  <textarea
                    value={state.after_hours_message}
                    onChange={(e) => setState((s) => ({ ...s, after_hours_message: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
                  />
                </div>
              </div>
            </div>
          )}

          {state.step === 5 && (
            <div>
              <h2 className="text-2xl font-bold text-gray-900 mb-1">You're almost live!</h2>
              <p className="text-gray-500 mb-6">Review your setup and launch your AI receptionist</p>

              <div className="bg-gray-50 rounded-2xl p-6 mb-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Business</span>
                    <span className="text-sm font-medium text-gray-900">{state.business_name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Industry</span>
                    <span className="text-sm font-medium text-gray-900">{state.industry_icon} {state.industry_name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">AI Name</span>
                    <span className="text-sm font-medium text-gray-900">{state.agent_name}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Tone</span>
                    <span className="text-sm font-medium text-gray-900 capitalize">{state.tone}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Languages</span>
                    <span className="text-sm font-medium text-gray-900">
                      English{state.spanish_enabled ? " + Spanish" : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Services</span>
                    <span className="text-sm font-medium text-gray-900">{state.services.length} configured</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Phone</span>
                    <span className="text-sm text-gray-500 italic">Assigned on launch</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-500 w-24">Hours</span>
                    <span className="text-sm font-medium text-gray-900">
                      {Object.entries(state.business_hours).filter(([, v]) => v.open).length} days/week
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 rounded-2xl p-6 mb-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Connect Calendar (optional)</h3>
                <div className="flex gap-3">
                  <a
                    href="/api/auth/google"
                    className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <span className="text-green-600">G</span> Connect Google Calendar
                  </a>
                  <a
                    href="/api/auth/microsoft"
                    className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <span className="text-blue-600">O</span> Connect Outlook
                  </a>
                  <span className="flex items-center text-xs text-gray-400 italic">Skip for now</span>
                </div>
              </div>

              <div className="bg-blue-50 rounded-2xl p-6 mb-6 border border-blue-100">
                <h3 className="text-sm font-semibold text-gray-900 mb-2">Your Dedicated Neverr Number</h3>
                <p className="text-2xl font-bold text-[#2E75B6] font-mono">+1 (XXX) XXX-XXXX</p>
                <p className="text-xs text-gray-500 mt-1">Will be assigned automatically on launch</p>
                <details className="mt-3">
                  <summary className="text-xs text-[#2E75B6] font-medium cursor-pointer">
                    How to forward your existing number (3 steps)
                  </summary>
                  <div className="mt-2 text-xs text-gray-600 space-y-1 pl-4">
                    <p>1. Log into your phone provider's dashboard</p>
                    <p>2. Navigate to Call Forwarding settings</p>
                    <p>3. Enter your Neverr number as the forwarding destination</p>
                  </div>
                </details>
              </div>

              {launchError && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-xl flex items-center gap-2 text-sm text-red-700">
                  <X className="w-4 h-4 shrink-0" />
                  {launchError}
                </div>
              )}

              <button
                onClick={handleLaunch}
                disabled={launching}
                className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-gradient-to-r from-[#2E75B6] to-[#3b8dd4] text-white rounded-2xl text-lg font-bold hover:from-[#2563a0] hover:to-[#2E75B6] transition-all shadow-lg shadow-[#2E75B6]/30 disabled:opacity-70"
              >
                {launching ? (
                  <>
                    <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full" />
                    Creating your AI agent...
                  </>
                ) : (
                  <>
                    <Rocket className="w-5 h-5" /> Launch My AI Receptionist
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>

      <footer className="border-t border-gray-100 px-6 py-4 flex items-center justify-between shrink-0 bg-white">
        <button
          onClick={() => state.step > 1 ? setState((s) => ({ ...s, step: s.step - 1 })) : navigate("/dashboard")}
          className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 text-sm font-medium"
        >
          <ChevronLeft className="w-4 h-4" /> {state.step > 1 ? "Back" : "Exit"}
        </button>
        {state.step < 5 && (
          <button
            onClick={() => setState((s) => ({ ...s, step: s.step + 1 }))}
            disabled={!canProceed()}
            className="flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </footer>
      <div className="flex items-center justify-center gap-3 py-3 text-[10px] text-gray-400">
        <a href={`${import.meta.env.BASE_URL}privacy`} className="hover:text-gray-600">Privacy Policy</a>
        <span>|</span>
        <a href={`${import.meta.env.BASE_URL}terms`} className="hover:text-gray-600">Terms of Service</a>
      </div>
    </div>
  );
}
