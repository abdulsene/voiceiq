import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { getIndustries, getIndustryTemplate, launchOnboard } from "../lib/api";
import {
  X,
  Search,
  Check,
  ChevronRight,
  ChevronLeft,
  Globe,
  Clock,
  Phone,
  PhoneForwarded,
  PhoneOff,
  Sparkles,
  Rocket,
  Building2,
  Calendar,
  Mic,
  CheckCircle2,
} from "lucide-react";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HT)" },
  { value: "Europe/London", label: "London (GMT)" },
  { value: "Europe/Paris", label: "Paris (CET)" },
  { value: "Asia/Dubai", label: "Dubai (GST)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const HOUR_PRESETS = [
  { id: "9to5", label: "Mon-Fri 9-5", apply: (h: any) => { DAYS.forEach(d => { h[d] = { open: ["Saturday","Sunday"].indexOf(d) === -1, start: "09:00", end: "17:00" }; }); return h; }},
  { id: "8to6", label: "Mon-Sat 8-6", apply: (h: any) => { DAYS.forEach(d => { h[d] = { open: d !== "Sunday", start: "08:00", end: "18:00" }; }); return h; }},
  { id: "247", label: "24/7", apply: (h: any) => { DAYS.forEach(d => { h[d] = { open: true, start: "00:00", end: "23:59" }; }); return h; }},
  { id: "custom", label: "Custom", apply: (h: any) => h },
];

const VOICE_STYLES = [
  { id: "professional", label: "Professional", desc: "Formal, efficient, corporate", icon: "🎯" },
  { id: "friendly", label: "Friendly", desc: "Warm, conversational, approachable", icon: "😊" },
  { id: "formal", label: "Formal", desc: "Polished, precise, authoritative", icon: "👔" },
  { id: "warm", label: "Warm", desc: "Caring, patient, empathetic", icon: "💛" },
  { id: "energetic", label: "Energetic", desc: "Upbeat, enthusiastic, dynamic", icon: "⚡" },
];

const TOP_LANGUAGES = [
  { code: "en", name: "English", flag: "🇺🇸", locked: true },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "pt", name: "Portuguese", flag: "🇧🇷" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "zh", name: "Mandarin", flag: "🇨🇳" },
  { code: "de", name: "German", flag: "🇩🇪" },
];

const STEP_LABELS = [
  "Business Info",
  "Business Hours",
  "AI Receptionist",
  "Connect Phone",
  "All Set!",
];

interface WizardState {
  business_name: string;
  industry_id: string;
  industry_name: string;
  industry_icon: string;
  phone: string;
  address: string;
  website: string;
  timezone: string;
  business_hours: Record<string, { open: boolean; start: string; end: string }>;
  hours_preset: string;
  after_hours_enabled: boolean;
  agent_name: string;
  voice_style: string;
  greeting_message: string;
  languages: string[];
  phone_option: "new" | "forward" | "skip" | "";
  existing_phone: string;
  template: any;
  owner_name: string;
  email: string;
  services: string[];
}

interface Props {
  onClose: () => void;
  prefillBusinessName?: string;
  prefillEmail?: string;
}

export default function OnboardingWizard({ onClose, prefillBusinessName, prefillEmail }: Props) {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(1);
  const [state, setState] = useState<WizardState>({
    business_name: prefillBusinessName || "",
    industry_id: "",
    industry_name: "",
    industry_icon: "",
    phone: "",
    address: "",
    website: "",
    timezone: "America/New_York",
    business_hours: DAYS.reduce((acc, d) => ({
      ...acc,
      [d]: { open: d !== "Saturday" && d !== "Sunday", start: "09:00", end: "17:00" },
    }), {} as Record<string, { open: boolean; start: string; end: string }>),
    hours_preset: "9to5",
    after_hours_enabled: true,
    agent_name: "Alex",
    voice_style: "friendly",
    greeting_message: "",
    languages: ["en"],
    phone_option: "",
    existing_phone: "",
    template: null,
    owner_name: "",
    email: prefillEmail || "",
    services: [],
  });

  const [categories, setCategories] = useState<Record<string, any[]>>({});
  const [industrySearch, setIndustrySearch] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [launchResult, setLaunchResult] = useState<any>(null);
  const [launchError, setLaunchError] = useState("");
  const [agentCreating, setAgentCreating] = useState(false);
  const [agentCreated, setAgentCreated] = useState(false);

  useEffect(() => {
    getIndustries().then((d) => setCategories(d.categories || {})).catch(console.error);
  }, []);

  useEffect(() => {
    if (!state.business_name) return;
    const name = state.business_name;
    const agent = state.agent_name || "Alex";
    if (!state.greeting_message || state.greeting_message.includes("your AI assistant")) {
      setState(s => ({
        ...s,
        greeting_message: `Thank you for calling ${name}! My name is ${agent}, your AI assistant. How can I help you today?`,
      }));
    }
  }, [state.business_name, state.agent_name]);

  const convertTo24h = (t: string) => {
    const match = t.match(/(\d+)(AM|PM)/i);
    if (!match) return "09:00";
    let h = parseInt(match[1]);
    if (match[2].toUpperCase() === "PM" && h !== 12) h += 12;
    if (match[2].toUpperCase() === "AM" && h === 12) h = 0;
    return `${String(h).padStart(2, "0")}:00`;
  };

  const selectIndustry = async (t: any) => {
    setState(s => ({ ...s, industry_id: t.industry_id, industry_name: t.name, industry_icon: t.icon }));
    try {
      const res = await getIndustryTemplate(t.industry_id);
      const tmpl = res.template;
      const hours = { ...state.business_hours };
      if (tmpl.business_hours_default) {
        const match = tmpl.business_hours_default.match(/(\w+)-(\w+)\s+(\d+\w+)-(\d+\w+)/);
        if (match) {
          let recording = false;
          for (const d of DAYS) {
            if (d === match[1]) recording = true;
            hours[d] = { open: recording, start: convertTo24h(match[3]), end: convertTo24h(match[4]) };
            if (d === match[2]) recording = false;
          }
        }
      }
      setState(s => ({
        ...s,
        template: tmpl,
        services: tmpl.appointment_types || [],
        business_hours: hours,
      }));
    } catch (e) { console.error(e); }
  };

  const filteredCategories = Object.entries(categories).reduce((acc, [cat, items]) => {
    if (!industrySearch) { acc[cat] = items; return acc; }
    const q = industrySearch.toLowerCase();
    const filtered = items.filter((t: any) =>
      t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q) || cat.toLowerCase().includes(q)
    );
    if (filtered.length) acc[cat] = filtered;
    return acc;
  }, {} as Record<string, any[]>);

  const canProceed = () => {
    switch (step) {
      case 1: return !!state.business_name && !!state.industry_id && !!state.phone && !!state.email;
      case 2: return Object.values(state.business_hours).some(h => h.open);
      case 3: return !!state.agent_name && !!state.greeting_message;
      case 4: return state.phone_option !== "";
      default: return true;
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    setAgentCreating(true);
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
        tone: state.voice_style,
        languages: state.languages,
        spanish_enabled: state.languages.includes("es"),
        greeting_message: state.greeting_message,
        after_hours_enabled: state.after_hours_enabled,
        phone_option: state.phone_option,
        existing_phone: state.existing_phone,
      });
      if (result.success) {
        setLaunchResult(result);
        setLaunched(true);
        setTimeout(() => { setAgentCreating(false); setAgentCreated(true); }, 2000);
      } else {
        setLaunchError(result.error || "Something went wrong.");
        setAgentCreating(false);
      }
    } catch (e: any) {
      setLaunchError(e.message || "Failed to connect.");
      setAgentCreating(false);
    }
    setLaunching(false);
  };

  const goNext = () => {
    if (step === 4) {
      setStep(5);
      handleLaunch();
    } else {
      setStep(s => Math.min(s + 1, 5));
    }
  };

  const goBack = () => setStep(s => Math.max(s - 1, 1));

  const applyPreset = (presetId: string) => {
    const preset = HOUR_PRESETS.find(p => p.id === presetId);
    if (preset) {
      const hours = preset.apply({ ...state.business_hours });
      setState(s => ({ ...s, business_hours: hours, hours_preset: presetId }));
    }
  };

  const toggleLanguage = (code: string) => {
    setState(s => ({
      ...s,
      languages: s.languages.includes(code) ? s.languages.filter(l => l !== code) : [...s.languages, code],
    }));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center">
      <div className="bg-white w-full h-full md:w-[900px] md:h-[92vh] md:rounded-2xl md:shadow-2xl flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#2E75B6] flex items-center justify-center">
              <Rocket className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-lg text-gray-900">Setup Wizard</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-xs text-gray-400">Step {step} of 5</span>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors">
              <X className="w-5 h-5 text-gray-400" />
            </button>
          </div>
        </header>

        <div className="px-6 py-3 border-b border-gray-50 shrink-0">
          <div className="flex items-center gap-1">
            {STEP_LABELS.map((label, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className={`h-1.5 w-full rounded-full transition-all ${
                  i + 1 <= step ? "bg-[#2E75B6]" : "bg-gray-200"
                }`} />
                <span className={`text-[10px] ${i + 1 <= step ? "text-[#2E75B6] font-medium" : "text-gray-400"}`}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {step === 1 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Tell us about your business</h2>
              <p className="text-gray-500 text-sm mb-6">We'll pre-configure your AI with the perfect settings</p>

              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Business Name *</label>
                    <input
                      value={state.business_name}
                      onChange={(e) => setState(s => ({ ...s, business_name: e.target.value }))}
                      placeholder="e.g. Smith Family Dentistry"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Your Name</label>
                    <input
                      value={state.owner_name}
                      onChange={(e) => setState(s => ({ ...s, owner_name: e.target.value }))}
                      placeholder="Full name"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Work Email *</label>
                  <input
                    type="email"
                    value={state.email}
                    onChange={(e) => setState(s => ({ ...s, email: e.target.value }))}
                    placeholder="you@business.com"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Industry *</label>
                  <div className="relative mb-3">
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
                    <div className="mb-3 p-2.5 bg-green-50 border border-green-200 rounded-xl flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-600 shrink-0" />
                      <p className="text-xs text-green-800">
                        Selected: <span className="font-semibold">{state.industry_icon} {state.industry_name}</span>
                      </p>
                    </div>
                  )}

                  <div className="max-h-[240px] overflow-y-auto border border-gray-100 rounded-xl p-3 space-y-4">
                    {Object.entries(filteredCategories).map(([category, items]) => (
                      <div key={category}>
                        <h3 className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{category}</h3>
                        <div className="grid grid-cols-3 gap-2">
                          {items.map((t: any) => {
                            const selected = state.industry_id === t.industry_id;
                            return (
                              <button
                                key={t.industry_id}
                                onClick={() => selectIndustry(t)}
                                className={`relative p-2.5 rounded-lg border text-left transition-all text-xs ${
                                  selected
                                    ? "border-[#2E75B6] bg-blue-50/50 shadow-sm"
                                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                                }`}
                              >
                                {selected && (
                                  <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[#2E75B6] flex items-center justify-center">
                                    <Check className="w-2.5 h-2.5 text-white" />
                                  </div>
                                )}
                                <span className="text-lg">{t.icon}</span>
                                <p className="font-medium text-gray-900 mt-1 leading-tight">{t.name}</p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Business Phone *</label>
                    <input
                      value={state.phone}
                      onChange={(e) => setState(s => ({ ...s, phone: e.target.value }))}
                      placeholder="+1 (555) 000-0000"
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
                    <select
                      value={state.timezone}
                      onChange={(e) => setState(s => ({ ...s, timezone: e.target.value }))}
                      className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 bg-white"
                    >
                      {TIMEZONES.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Business Address</label>
                  <input
                    value={state.address}
                    onChange={(e) => setState(s => ({ ...s, address: e.target.value }))}
                    placeholder="123 Main St, City, State ZIP"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Website (optional)</label>
                  <input
                    value={state.website}
                    onChange={(e) => setState(s => ({ ...s, website: e.target.value }))}
                    placeholder="https://yourbusiness.com"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Set your business hours</h2>
              <p className="text-gray-500 text-sm mb-6">Your AI will know when you're open and handle after-hours calls</p>

              <div className="flex flex-wrap gap-2 mb-5">
                {HOUR_PRESETS.map(p => (
                  <button
                    key={p.id}
                    onClick={() => applyPreset(p.id)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                      state.hours_preset === p.id
                        ? "bg-[#2E75B6] text-white shadow-sm"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <div className="bg-gray-50 rounded-xl p-4 space-y-2 mb-5">
                {DAYS.map(day => {
                  const h = state.business_hours[day];
                  return (
                    <div key={day} className="flex items-center gap-3">
                      <label className="flex items-center gap-2 w-28 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={h.open}
                          onChange={() => {
                            setState(s => ({
                              ...s,
                              hours_preset: "custom",
                              business_hours: { ...s.business_hours, [day]: { ...h, open: !h.open } },
                            }));
                          }}
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
                            onChange={e => setState(s => ({
                              ...s,
                              hours_preset: "custom",
                              business_hours: { ...s.business_hours, [day]: { ...h, start: e.target.value } },
                            }))}
                            className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                          />
                          <span className="text-xs text-gray-400">to</span>
                          <input
                            type="time"
                            value={h.end}
                            onChange={e => setState(s => ({
                              ...s,
                              hours_preset: "custom",
                              business_hours: { ...s.business_hours, [day]: { ...h, end: e.target.value } },
                            }))}
                            className="px-2 py-1.5 border border-gray-200 rounded-lg text-xs bg-white"
                          />
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">Closed</span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
                <div>
                  <p className="text-sm font-medium text-gray-900">Take messages after hours</p>
                  <p className="text-xs text-gray-500 mt-0.5">AI will answer and take messages when you're closed</p>
                </div>
                <button
                  onClick={() => setState(s => ({ ...s, after_hours_enabled: !s.after_hours_enabled }))}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    state.after_hours_enabled ? "bg-[#2E75B6]" : "bg-gray-300"
                  }`}
                >
                  <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                    state.after_hours_enabled ? "left-[22px]" : "left-0.5"
                  }`} />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Configure your AI receptionist</h2>
              <p className="text-gray-500 text-sm mb-6">Personalize how your AI answers the phone</p>

              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Agent Name</label>
                  <input
                    value={state.agent_name}
                    onChange={e => setState(s => ({ ...s, agent_name: e.target.value }))}
                    placeholder="Alex"
                    className="w-64 px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                  />
                  <p className="text-xs text-gray-400 mt-1">This is the name your AI will use when answering calls</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">Voice Style</label>
                  <div className="grid grid-cols-5 gap-2">
                    {VOICE_STYLES.map(v => (
                      <button
                        key={v.id}
                        onClick={() => setState(s => ({ ...s, voice_style: v.id }))}
                        className={`p-3 rounded-xl border-2 text-center transition-all ${
                          state.voice_style === v.id
                            ? "border-[#2E75B6] bg-blue-50/50 shadow-sm"
                            : "border-gray-200 hover:border-gray-300"
                        }`}
                      >
                        <span className="text-xl block mb-1">{v.icon}</span>
                        <p className="text-xs font-semibold text-gray-900">{v.label}</p>
                        <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">{v.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-sm font-medium text-gray-700">Greeting Message</label>
                    <span className="text-xs text-gray-400">{state.greeting_message.length}/300</span>
                  </div>
                  <textarea
                    value={state.greeting_message}
                    onChange={e => setState(s => ({ ...s, greeting_message: e.target.value.slice(0, 300) }))}
                    rows={3}
                    placeholder="Thank you for calling! How can I help you today?"
                    className="w-full px-3 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20 resize-none"
                  />
                  <div className="mt-2 p-3 bg-gradient-to-r from-blue-50 to-purple-50 rounded-xl border border-blue-100">
                    <div className="flex items-center gap-2 mb-1">
                      <Sparkles className="w-3.5 h-3.5 text-[#2E75B6]" />
                      <span className="text-[10px] font-semibold text-gray-500 uppercase">Live Preview</span>
                    </div>
                    <p className="text-sm text-gray-700 italic">
                      "{ state.greeting_message || `Thank you for calling ${state.business_name || "your business"}! How can I help you today?` }"
                    </p>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    <Globe className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                    Languages
                  </label>
                  <div className="grid grid-cols-4 gap-2">
                    {TOP_LANGUAGES.map(lang => {
                      const enabled = lang.code === "en" || state.languages.includes(lang.code);
                      return (
                        <label
                          key={lang.code}
                          className={`flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-all text-sm ${
                            enabled ? "bg-[#2E75B6]/10 border border-[#2E75B6]/30" : "bg-gray-50 border border-gray-100 hover:bg-gray-100"
                          } ${lang.locked ? "cursor-default" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={enabled}
                            disabled={lang.locked}
                            onChange={() => !lang.locked && toggleLanguage(lang.code)}
                            className="w-3.5 h-3.5 rounded border-gray-300 text-[#2E75B6] focus:ring-[#2E75B6]"
                          />
                          <span className="text-base leading-none">{lang.flag}</span>
                          <span className="text-xs font-medium text-gray-900">{lang.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-gray-900 mb-1">Connect your phone</h2>
              <p className="text-gray-500 text-sm mb-6">Choose how you want to receive AI-answered calls</p>

              <div className="space-y-4">
                <button
                  onClick={() => setState(s => ({ ...s, phone_option: "new" }))}
                  className={`w-full p-5 rounded-xl border-2 text-left transition-all ${
                    state.phone_option === "new"
                      ? "border-[#2E75B6] bg-blue-50/50 shadow-md"
                      : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                      state.phone_option === "new" ? "bg-[#2E75B6]" : "bg-gray-100"
                    }`}>
                      <Phone className={`w-6 h-6 ${state.phone_option === "new" ? "text-white" : "text-gray-400"}`} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-gray-900">I want a new number</h3>
                      <p className="text-sm text-gray-500 mt-1">We'll assign a new dedicated Neverr phone number for your business</p>
                      {state.phone_option === "new" && (
                        <div className="mt-3 p-3 bg-white rounded-lg border border-blue-100">
                          <p className="text-xs text-gray-500">A dedicated number will be provisioned and assigned to your AI agent after setup.</p>
                          <p className="text-sm font-mono font-bold text-[#2E75B6] mt-2">+1 (XXX) XXX-XXXX</p>
                          <p className="text-[10px] text-gray-400 mt-1">Number assigned on launch</p>
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setState(s => ({ ...s, phone_option: "forward" }))}
                  className={`w-full p-5 rounded-xl border-2 text-left transition-all ${
                    state.phone_option === "forward"
                      ? "border-[#2E75B6] bg-blue-50/50 shadow-md"
                      : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                      state.phone_option === "forward" ? "bg-[#2E75B6]" : "bg-gray-100"
                    }`}>
                      <PhoneForwarded className={`w-6 h-6 ${state.phone_option === "forward" ? "text-white" : "text-gray-400"}`} />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-base font-semibold text-gray-900">I have an existing number — set up forwarding</h3>
                      <p className="text-sm text-gray-500 mt-1">Forward your current business number to your Neverr AI agent</p>
                      {state.phone_option === "forward" && (
                        <div className="mt-3 space-y-3" onClick={e => e.stopPropagation()}>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Your existing number</label>
                            <input
                              value={state.existing_phone}
                              onChange={e => setState(s => ({ ...s, existing_phone: e.target.value }))}
                              placeholder="+1 (555) 000-0000"
                              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                            />
                          </div>
                          <div className="p-3 bg-white rounded-lg border border-blue-100">
                            <p className="text-xs font-semibold text-gray-900 mb-2">Forward to your Neverr number:</p>
                            <p className="text-sm font-mono font-bold text-[#2E75B6]">+1 (XXX) XXX-XXXX</p>
                            <p className="text-[10px] text-gray-400 mt-1">Number assigned on launch</p>
                            <div className="mt-3 space-y-1.5">
                              <p className="text-[11px] font-semibold text-gray-700">How to forward your calls:</p>
                              <p className="text-[11px] text-gray-500">1. Log into your phone provider's dashboard</p>
                              <p className="text-[11px] text-gray-500">2. Navigate to Call Forwarding settings</p>
                              <p className="text-[11px] text-gray-500">3. Enter your Neverr number as the forwarding destination</p>
                              <p className="text-[11px] text-gray-500">4. Enable forwarding and save changes</p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </button>

                <button
                  onClick={() => setState(s => ({ ...s, phone_option: "skip" }))}
                  className={`w-full p-5 rounded-xl border-2 text-left transition-all ${
                    state.phone_option === "skip"
                      ? "border-[#2E75B6] bg-blue-50/50 shadow-md"
                      : "border-gray-200 hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${
                      state.phone_option === "skip" ? "bg-[#2E75B6]" : "bg-gray-100"
                    }`}>
                      <PhoneOff className={`w-6 h-6 ${state.phone_option === "skip" ? "text-white" : "text-gray-400"}`} />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-gray-900">Skip for now</h3>
                      <p className="text-sm text-gray-500 mt-1">I'll set up my phone connection later from Settings</p>
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="max-w-lg mx-auto text-center py-6">
              {!launched ? (
                <div className="space-y-6">
                  <div className="w-16 h-16 rounded-full bg-[#2E75B6]/10 flex items-center justify-center mx-auto">
                    <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900">Setting up your AI agent...</h2>
                    <p className="text-gray-500 text-sm mt-2">This only takes a moment</p>
                  </div>
                  {launchError && (
                    <div className="p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 text-left">
                      {launchError}
                      <button
                        onClick={handleLaunch}
                        className="mt-2 px-4 py-2 bg-red-100 rounded-lg text-xs font-medium hover:bg-red-200"
                      >
                        Try Again
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto animate-bounce">
                    <CheckCircle2 className="w-10 h-10 text-green-600" />
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold text-gray-900">You're all set!</h2>
                    <p className="text-gray-500 text-sm mt-2">
                      {state.agent_name} is ready to answer calls for <span className="font-semibold text-gray-900">{state.business_name}</span>
                    </p>
                  </div>

                  <div className="bg-gray-50 rounded-xl p-5 text-left space-y-3">
                    <h3 className="text-sm font-semibold text-gray-900">Setup Summary</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center gap-2">
                        <Building2 className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">Business</p>
                          <p className="text-xs font-medium text-gray-900">{state.business_name}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Mic className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">AI Agent</p>
                          <p className="text-xs font-medium text-gray-900">{state.agent_name}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">Hours</p>
                          <p className="text-xs font-medium text-gray-900">
                            {Object.values(state.business_hours).filter(h => h.open).length} days/week
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">Languages</p>
                          <p className="text-xs font-medium text-gray-900">{state.languages.length} enabled</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Phone className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">Phone</p>
                          <p className="text-xs font-medium text-gray-900">
                            {state.phone_option === "new" ? "New number (assigned)" : state.phone_option === "forward" ? "Forwarding" : "Setup later"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Calendar className="w-4 h-4 text-gray-400" />
                        <div>
                          <p className="text-[10px] text-gray-400">Industry</p>
                          <p className="text-xs font-medium text-gray-900">{state.industry_icon} {state.industry_name}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {agentCreating && !agentCreated && (
                    <div className="flex items-center justify-center gap-3 p-3 bg-blue-50 rounded-xl">
                      <div className="animate-spin w-4 h-4 border-2 border-[#2E75B6] border-t-transparent rounded-full" />
                      <span className="text-sm text-[#2E75B6] font-medium">Creating your AI agent...</span>
                    </div>
                  )}
                  {agentCreated && (
                    <div className="flex items-center justify-center gap-3 p-3 bg-green-50 rounded-xl">
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                      <span className="text-sm text-green-700 font-medium">AI agent created successfully!</span>
                    </div>
                  )}

                  {launchResult?.agent_id && (
                    <div className="text-left bg-gray-50 rounded-xl p-4">
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-500">Agent ID</span>
                        <span className="font-mono text-gray-700">{launchResult.agent_id}</span>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3">
                    <button
                      onClick={() => { onClose(); navigate("/dashboard"); }}
                      className="flex-1 px-6 py-3 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] transition-colors"
                    >
                      Go to Dashboard
                    </button>
                    <button
                      onClick={() => { onClose(); navigate("/settings"); }}
                      className="flex-1 px-6 py-3 bg-gray-100 text-gray-700 rounded-xl text-sm font-semibold hover:bg-gray-200 transition-colors"
                    >
                      Make a Test Call
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {step < 5 && (
          <footer className="border-t border-gray-100 px-6 py-4 flex items-center justify-between shrink-0 bg-white">
            <button
              onClick={step === 1 ? onClose : goBack}
              className="flex items-center gap-2 px-4 py-2 text-gray-600 hover:text-gray-900 text-sm font-medium transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              {step === 1 ? "Cancel" : "Back"}
            </button>
            <button
              onClick={goNext}
              disabled={!canProceed()}
              className="flex items-center gap-2 px-6 py-2.5 bg-[#2E75B6] text-white rounded-xl text-sm font-semibold hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {step === 4 ? "Launch" : "Next"}
              <ChevronRight className="w-4 h-4" />
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
