import { useState, useEffect } from "react";
import {
  Search,
  Check,
  ArrowRight,
  Building2,
  MapPin,
  Phone,
  Globe,
  Clock,
  Sparkles,
  PartyPopper,
  Loader2,
  PhoneForwarded,
} from "lucide-react";
import { fetchApi } from "../lib/api";

const FALLBACK_INDUSTRIES = [
  { industry_id: "dental", name: "Dental Office", icon: "🦷", category: "Healthcare" },
  { industry_id: "medical", name: "Medical Office", icon: "🏥", category: "Healthcare" },
  { industry_id: "veterinary", name: "Veterinary", icon: "🐾", category: "Healthcare" },
  { industry_id: "legal", name: "Law Firm", icon: "⚖️", category: "Professional Services" },
  { industry_id: "accounting", name: "Accounting", icon: "📊", category: "Professional Services" },
  { industry_id: "insurance", name: "Insurance", icon: "🛡️", category: "Professional Services" },
  { industry_id: "real_estate", name: "Real Estate", icon: "🏠", category: "Professional Services" },
  { industry_id: "hvac", name: "HVAC Services", icon: "❄️", category: "Home Services" },
  { industry_id: "plumbing", name: "Plumbing", icon: "🔧", category: "Home Services" },
  { industry_id: "electrical", name: "Electrical", icon: "⚡", category: "Home Services" },
  { industry_id: "restaurant", name: "Restaurant", icon: "🍽️", category: "Hospitality" },
  { industry_id: "hotel", name: "Hotel", icon: "🏨", category: "Hospitality" },
  { industry_id: "salon", name: "Salon & Spa", icon: "💇", category: "Lifestyle" },
  { industry_id: "fitness", name: "Gym & Fitness", icon: "💪", category: "Lifestyle" },
  { industry_id: "automotive", name: "Auto Dealership", icon: "🚗", category: "Automotive" },
  { industry_id: "funeral", name: "Funeral Home", icon: "🕊️", category: "Other" },
  { industry_id: "government", name: "Government", icon: "🏛️", category: "Other" },
  { industry_id: "general", name: "General Business", icon: "🏢", category: "Other" },
];

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface OnboardingData {
  industry: string;
  industryName: string;
  industryIcon: string;
  businessName: string;
  cityState: string;
  phone: string;
  website: string;
  businessHours: string;
}

interface Props {
  onComplete: () => void;
}

export default function FirstTimeOnboarding({ onComplete }: Props) {
  const [step, setStep] = useState(1);
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [userName, setUserName] = useState("");
  const [industries, setIndustries] = useState<any[]>([]);
  const [industriesLoading, setIndustriesLoading] = useState(true);
  const [neverrPhone, setNeverrPhone] = useState("");
  const [data, setData] = useState<OnboardingData>({
    industry: "",
    industryName: "",
    industryIcon: "",
    businessName: "",
    cityState: "",
    phone: "",
    website: "",
    businessHours: "Mon-Fri 9:00 AM - 5:00 PM",
  });

  const [hourStart, setHourStart] = useState("09:00");
  const [hourEnd, setHourEnd] = useState("17:00");
  const [activeDays, setActiveDays] = useState(["Mon", "Tue", "Wed", "Thu", "Fri"]);

  useEffect(() => {
    const token = localStorage.getItem("neverr_token");
    if (token) {
      // fetchApi auto-injects Authorization + X-Active-Business so a
      // user mid-tenant-switch sees the right name pre-filled.
      fetchApi("/auth/me")
        .then((d) => {
          if (d?.user?.email) {
            const name = d.user.user_metadata?.full_name || d.user.email.split("@")[0];
            setUserName(name);
          }
        })
        .catch(() => {});
    }

    // /onboard/industries is public; using fetchApi just for consistency.
    fetchApi("/onboard/industries")
      .then((d) => {
        const cats = d.categories || {};
        const flat: any[] = [];
        Object.entries(cats).forEach(([category, items]: [string, any]) => {
          (items || []).forEach((item: any) => {
            flat.push({ ...item, category });
          });
        });
        setIndustries(flat.length > 0 ? flat : FALLBACK_INDUSTRIES);
      })
      .catch(() => {
        setIndustries(FALLBACK_INDUSTRIES);
      })
      .finally(() => setIndustriesLoading(false));
  }, []);

  useEffect(() => {
    const dayStr = activeDays.length === 7
      ? "Every day"
      : activeDays.length === 5 && !activeDays.includes("Sat") && !activeDays.includes("Sun")
        ? "Mon-Fri"
        : activeDays.join(", ");
    const formatTime = (t: string) => {
      const [h, m] = t.split(":").map(Number);
      const ampm = h >= 12 ? "PM" : "AM";
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
    };
    setData(d => ({ ...d, businessHours: `${dayStr} ${formatTime(hourStart)} - ${formatTime(hourEnd)}` }));
  }, [activeDays, hourStart, hourEnd]);

  const filteredIndustries = industries.filter(i =>
    i.name.toLowerCase().includes(search.toLowerCase()) ||
    (i.description || "").toLowerCase().includes(search.toLowerCase()) ||
    (i.category || "").toLowerCase().includes(search.toLowerCase())
  );

  const toggleDay = (day: string) => {
    setActiveDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  };

  async function handleComplete() {
    setError("");
    setSubmitting(true);
    try {
      // fetchApi targets the active tenant via X-Active-Business — so if
      // the user is partway through onboarding a second business they
      // just added, the wizard writes to that one, not their oldest.
      // It throws on !res.ok, so the inline error response shape that
      // the old code expected is now produced by parsing message text.
      let result: any;
      try {
        result = await fetchApi("/auth/complete-onboarding", {
          method: "POST",
          body: JSON.stringify({
            industry: data.industry,
            business_name: data.businessName,
            city_state: data.cityState,
            phone_number: data.phone,
            website: data.website,
            business_hours: data.businessHours,
          }),
        });
      } catch (apiErr: any) {
        result = { success: false, error: apiErr?.message || "Setup failed" };
      }
      // Restore the `res.ok` semantics the surrounding code expects.
      const res = { ok: result?.success !== false } as { ok: boolean };
      if (!res.ok) {
        setError(result.error || "Something went wrong");
        setSubmitting(false);
        return;
      }
      if (result.neverr_phone) {
        setNeverrPhone(result.neverr_phone);
      }
      setStep(4);
      setSubmitting(false);
    } catch {
      setError("Connection error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[640px] mx-4 max-h-[90vh] overflow-y-auto">
        {step < 4 && (
          <div className="px-8 pt-6">
            <div className="flex items-center gap-2 mb-1">
              {[1, 2, 3].map(s => (
                <div key={s} className="flex-1 flex items-center gap-2">
                  <div className={`h-1.5 flex-1 rounded-full transition-all ${s <= step ? "bg-[#2E75B6]" : "bg-gray-200"}`} />
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 text-right">Step {step} of 4</p>
          </div>
        )}

        <div className="px-8 py-6">
          {step === 1 && (
            <div className="text-center py-8">
              <div className="text-5xl mb-4">👋</div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                Welcome to Neverr{userName ? `, ${userName}` : ""}
              </h2>
              <p className="text-gray-500 mb-8 max-w-md mx-auto">
                Let's set up your AI receptionist in just a few steps. It only takes about 2 minutes.
              </p>
              <div className="flex flex-col gap-3 max-w-sm mx-auto mb-8">
                <div className="flex items-center gap-3 text-left p-3 bg-blue-50 rounded-xl">
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-[#2E75B6] shrink-0">
                    <Building2 className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Choose your industry</p>
                    <p className="text-xs text-gray-500">We'll pre-configure your AI</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-left p-3 bg-blue-50 rounded-xl">
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-[#2E75B6] shrink-0">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Add your business info</p>
                    <p className="text-xs text-gray-500">Name, location, hours</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-left p-3 bg-blue-50 rounded-xl">
                  <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center text-[#2E75B6] shrink-0">
                    <Phone className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">Go live instantly</p>
                    <p className="text-xs text-gray-500">Your AI starts answering calls</p>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setStep(2)}
                className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-8 py-3 rounded-xl font-semibold hover:bg-[#2563a0] transition-colors text-base"
              >
                Let's get started <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-1">Choose your industry</h2>
              <p className="text-sm text-gray-500 mb-4">We'll pre-configure your AI with the best settings for your business type.</p>
              <div className="relative mb-4">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search industries..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                />
              </div>
              {industriesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 text-[#2E75B6] animate-spin" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2 max-h-[400px] overflow-y-auto pr-1">
                  {filteredIndustries.map(ind => (
                    <button
                      key={ind.industry_id || ind.id}
                      onClick={() => setData(d => ({
                        ...d,
                        industry: ind.industry_id || ind.id,
                        industryName: ind.name,
                        industryIcon: ind.icon || "",
                      }))}
                      className={`flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-all ${
                        data.industry === (ind.industry_id || ind.id)
                          ? "border-[#2E75B6] bg-blue-50"
                          : "border-gray-100 hover:border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <span className="text-2xl">{ind.icon || "🏢"}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">{ind.name}</p>
                        {ind.description && (
                          <p className="text-xs text-gray-400 truncate">{ind.description}</p>
                        )}
                      </div>
                      {data.industry === (ind.industry_id || ind.id) && (
                        <Check className="w-4 h-4 text-[#2E75B6] ml-auto shrink-0" />
                      )}
                    </button>
                  ))}
                </div>
              )}
              {data.industry && (
                <div className="mt-4 p-3 bg-green-50 rounded-xl border border-green-100">
                  <p className="text-sm text-green-800">
                    <span className="font-medium">Great choice!</span> We'll pre-configure your AI for <strong>{data.industryIcon} {data.industryName}</strong>.
                  </p>
                </div>
              )}
              <div className="flex justify-between mt-6">
                <button
                  onClick={() => setStep(1)}
                  className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700"
                >
                  Back
                </button>
                <button
                  onClick={() => setStep(3)}
                  disabled={!data.industry}
                  className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-6 py-2.5 rounded-xl font-semibold hover:bg-[#2563a0] disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  Continue <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-xl font-bold text-gray-900 mb-1">Business information</h2>
              <p className="text-sm text-gray-500 mb-5">Tell us about your business so your AI receptionist sounds professional.</p>
              {error && (
                <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
              )}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Business name <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="e.g. Bright Smile Dental"
                      value={data.businessName}
                      onChange={e => setData(d => ({ ...d, businessName: e.target.value }))}
                      className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    City / State <span className="text-red-400">*</span>
                  </label>
                  <div className="relative">
                    <MapPin className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      placeholder="e.g. Austin, TX"
                      value={data.cityState}
                      onChange={e => setData(d => ({ ...d, cityState: e.target.value }))}
                      className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Business phone <span className="text-xs text-gray-400 font-normal">(your existing number)</span>
                  </label>
                  <div className="relative">
                    <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="tel"
                      placeholder="(555) 123-4567"
                      value={data.phone}
                      onChange={e => setData(d => ({ ...d, phone: e.target.value }))}
                      className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Website <span className="text-xs text-gray-400 font-normal">(optional)</span>
                  </label>
                  <div className="relative">
                    <Globe className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="url"
                      placeholder="https://yourbusiness.com"
                      value={data.website}
                      onChange={e => setData(d => ({ ...d, website: e.target.value }))}
                      className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                </div>
                <div>
                  <label className="flex items-center gap-1.5 text-sm font-medium text-gray-700 mb-2">
                    <Clock className="w-4 h-4" />
                    Business hours
                  </label>
                  <div className="flex gap-1.5 mb-3">
                    {DAYS.map(day => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                          activeDays.includes(day)
                            ? "bg-[#2E75B6] text-white"
                            : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                        }`}
                      >
                        {day}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={hourStart}
                      onChange={e => setHourStart(e.target.value)}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                    <span className="text-gray-400 text-sm">to</span>
                    <input
                      type="time"
                      value={hourEnd}
                      onChange={e => setHourEnd(e.target.value)}
                      className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/20"
                    />
                  </div>
                  <p className="text-xs text-gray-400 mt-1.5">{data.businessHours}</p>
                </div>
              </div>
              <p className="text-xs text-[#64748B] leading-relaxed mt-4">
                By entering your phone number, you agree to receive call summaries, hot lead alerts, and daily briefing SMS from Neverr.ai. Reply STOP to unsubscribe at any time. Message and data rates may apply.
              </p>
              <div className="flex justify-between mt-6">
                <button
                  onClick={() => { setStep(2); setError(""); }}
                  className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700"
                >
                  Back
                </button>
                <button
                  onClick={handleComplete}
                  disabled={!data.businessName || !data.cityState || submitting}
                  className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-6 py-2.5 rounded-xl font-semibold hover:bg-[#2563a0] disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-sm"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Setting up...
                    </>
                  ) : (
                    <>
                      Set up my AI <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="text-center py-10">
              <div className="relative inline-block mb-6">
                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center animate-bounce">
                  <PartyPopper className="w-10 h-10 text-green-600" />
                </div>
                <div className="absolute -top-2 -right-2 text-2xl animate-pulse">✨</div>
                <div className="absolute -bottom-1 -left-3 text-xl animate-pulse delay-300">🎉</div>
              </div>
              <h2 className="text-2xl font-bold text-gray-900 mb-2">You're all set!</h2>
              <p className="text-gray-500 mb-6 max-w-md mx-auto">
                Your AI receptionist is active for <strong>{data.businessName}</strong>.
              </p>

              {neverrPhone && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-6 text-left max-w-sm mx-auto">
                  <div className="flex items-center gap-2 mb-3">
                    <PhoneForwarded className="w-5 h-5 text-[#2E75B6]" />
                    <p className="text-sm font-semibold text-gray-900">Your Neverr phone number</p>
                  </div>
                  <p className="text-xl font-mono font-bold text-[#2E75B6] mb-3">{neverrPhone}</p>
                  <p className="text-xs text-gray-600">
                    Forward your calls to this number to go live instantly. Your AI receptionist will answer every call.
                  </p>
                </div>
              )}

              {!neverrPhone && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-5 mb-6 text-left max-w-sm mx-auto">
                  <p className="text-sm text-gray-700">
                    Your AI receptionist is being configured. We'll send you a text when your number is ready.
                  </p>
                </div>
              )}

              <button
                onClick={onComplete}
                className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-8 py-3 rounded-xl font-semibold hover:bg-[#2563a0] transition-colors text-base"
              >
                Go to Dashboard <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
