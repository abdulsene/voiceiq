import { useEffect, useState } from "react";
import { Sparkles, Loader2, Phone, Clock, ArrowRight } from "lucide-react";
import PreviewVoiceWidget from "../components/PreviewVoiceWidget";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

type Industry = { industry_id: string; name: string; category: string };

type PreviewResult = {
  success: boolean;
  demo_business_id: string;
  demo_agent_id: string | null;
  agent_ready: boolean;
  system_prompt: string;
  expires_at: string;
  industry_name: string;
  business_name?: string;
};

export default function TryYourAgent() {
  const [step, setStep] = useState<"form" | "generating" | "preview">("form");
  const [industries, setIndustries] = useState<Record<string, Industry[]>>({});
  const [loadingIndustries, setLoadingIndustries] = useState(true);

  const [industry, setIndustry] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [website, setWebsite] = useState("");
  const [tone, setTone] = useState("");
  const [language, setLanguage] = useState<string>("en");
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [callActive, setCallActive] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const r = await fetch(`${API}/onboard/industries`);
        const d = await r.json();
        if (d.success && d.categories) {
          setIndustries(d.categories);
        }
      } catch (e) {
        console.warn("Failed to load industries", e);
      }
      setLoadingIndustries(false);
    }
    load();
  }, []);

  // Phase 3h: when the user lands here from the /industries/:slug modal
  // ("Try this agent live"), the industry (and optionally business name)
  // come in as URL query params — pre-fill the form so they can hit
  // "Generate" without re-picking what they already chose.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const industryParam = params.get("industry");
    const businessNameParam = params.get("business_name");
    const languageParam = params.get("language");
    if (industryParam) setIndustry(industryParam);
    if (businessNameParam) setBusinessName(businessNameParam);
    // Phase 3l: /multilingual deep-links land here with ?language=es etc.
    if (languageParam && ["en", "es", "fr", "pt", "zh", "ar", "de"].includes(languageParam)) {
      setLanguage(languageParam);
    }
  }, []);

  useEffect(() => {
    if (!preview) return;
    const tick = () => {
      const ms = new Date(preview.expires_at).getTime() - Date.now();
      setTimeRemaining(Math.max(0, Math.floor(ms / 1000)));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [preview]);

  async function handleGenerate() {
    setError(null);
    if (!industry || !businessName.trim()) {
      setError("Please pick an industry and enter your business name");
      return;
    }
    setStep("generating");

    try {
      const r = await fetch(`${API}/preview/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          industry,
          business_name: businessName.trim(),
          website: website.trim() || undefined,
          tone: tone.trim() || undefined,
          language,
        }),
      });

      if (r.status === 429) {
        const d = await r.json();
        setError(`Too many previews generated. Try again in ${Math.ceil(d.retry_after_seconds / 60)} minutes.`);
        setStep("form");
        return;
      }

      const d: PreviewResult & { error?: string } = await r.json();
      if (!d.success) {
        setError(d.error || "Failed to generate preview");
        setStep("form");
        return;
      }

      setPreview(d);
      setStep("preview");
    } catch (e: any) {
      setError(e.message || "Network error");
      setStep("form");
    }
  }

  function startCall() {
    if (!preview?.demo_agent_id || !preview.agent_ready) return;
    setCallActive(true);
  }

  function formatTime(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  if (step === "form" || step === "generating") {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
        <LandingNav />
        <div className="max-w-3xl mx-auto px-6 py-16">
          <div className="text-center mb-10">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-blue-50 text-blue-700 rounded-full text-sm font-medium mb-6">
              <Sparkles className="w-4 h-4" />
              Try before you sign up
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
              Meet your AI receptionist —<br />
              calibrated for your industry.
            </h1>
            <p className="text-lg text-slate-600 max-w-xl mx-auto">
              Pick your industry, tell us about your business, and talk to your agent live. No signup required.
            </p>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-lg p-8">
            <div className="space-y-6">
              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-2">
                  What industry are you in?
                </label>
                <select
                  className="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  disabled={loadingIndustries || step === "generating"}
                >
                  <option value="">Select your industry...</option>
                  {Object.entries(industries).sort().map(([category, items]) => (
                    <optgroup key={category} label={category}>
                      {items.map((i) => (
                        <option key={i.industry_id} value={i.industry_id}>{i.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-2">
                  Your business name
                </label>
                <input
                  type="text"
                  className="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Acme Plumbing, Inc."
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  disabled={step === "generating"}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-2">
                  Your website <span className="font-normal text-slate-400">(optional — we'll pull details from it)</span>
                </label>
                <input
                  type="url"
                  className="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="https://acmeplumbing.com"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  disabled={step === "generating"}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-2">
                  How should your AI sound? <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <textarea
                  className="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  rows={2}
                  placeholder="Warm and professional, slightly casual, use humor occasionally"
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  disabled={step === "generating"}
                  maxLength={500}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-1.5">
                  Conversation language
                  <span className="ml-2 text-xs font-normal text-slate-500">
                    (32 languages supported · 7 featured below)
                  </span>
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                  {[
                    { code: "en", flag: "\uD83C\uDDFA\uD83C\uDDF8", name: "English" },
                    { code: "es", flag: "\uD83C\uDDF2\uD83C\uDDFD", name: "Spanish" },
                    { code: "fr", flag: "\uD83C\uDDE8\uD83C\uDDE6", name: "French" },
                    { code: "pt", flag: "\uD83C\uDDE7\uD83C\uDDF7", name: "Portuguese" },
                    { code: "zh", flag: "\uD83C\uDDE8\uD83C\uDDF3", name: "Mandarin" },
                    { code: "ar", flag: "\uD83C\uDDEA\uD83C\uDDEC", name: "Arabic" },
                    { code: "de", flag: "\uD83C\uDDE9\uD83C\uDDEA", name: "German" },
                  ].map((lang) => (
                    <button
                      key={lang.code}
                      type="button"
                      onClick={() => setLanguage(lang.code)}
                      disabled={step === "generating"}
                      className={`flex flex-col items-center justify-center gap-1 px-2 py-3 rounded-lg border-2 transition-all disabled:opacity-50 ${
                        language === lang.code
                          ? "border-blue-600 bg-blue-50"
                          : "border-slate-200 hover:border-slate-300 bg-white"
                      }`}
                    >
                      <span className="text-xl" aria-hidden="true">{lang.flag}</span>
                      <span className="text-xs font-medium text-slate-700">{lang.name}</span>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-slate-500 mt-2">
                  Need a different language? Neverr supports 32 total — pick English here, then specify in your customer prompt.
                </p>
              </div>

              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
                  {error}
                </div>
              )}

              <button
                onClick={handleGenerate}
                disabled={step === "generating" || !industry || !businessName.trim()}
                className="w-full px-6 py-3.5 bg-blue-600 text-white rounded-lg font-semibold text-base hover:bg-blue-700 transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {step === "generating" ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Building your agent... (~15 seconds)
                  </>
                ) : (
                  <>
                    Generate My Agent
                    <ArrowRight className="w-5 h-5" />
                  </>
                )}
              </button>

              <p className="text-xs text-slate-500 text-center">
                Your demo agent will be available for 30 minutes. No account or credit card required.
              </p>
            </div>
          </div>
        </div>
        <LandingFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <LandingNav />
      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-50 text-emerald-700 rounded-full text-xs font-medium mb-2">
              <Sparkles className="w-3.5 h-3.5" />
              Live Preview
            </div>
            <h1 className="text-2xl font-bold text-slate-900">
              {preview?.business_name} — {preview?.industry_name}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 text-amber-800 rounded-lg text-sm font-medium">
              <Clock className="w-4 h-4" />
              Expires in {formatTime(timeRemaining)}
            </div>
            <a
              href="/signup"
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Keep This Agent →
            </a>
          </div>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600" />
              Your Agent's Instructions
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              This is the exact system prompt your AI uses. Notice how it's calibrated for {preview?.industry_name}, not generic.
            </p>
            <div className="bg-slate-50 rounded-lg p-4 max-h-[600px] overflow-y-auto">
              <pre className="text-xs text-slate-800 whitespace-pre-wrap font-mono leading-relaxed">
                {preview?.system_prompt}
              </pre>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
            <h2 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
              <Phone className="w-4 h-4 text-blue-600" />
              Talk to Your Agent
            </h2>
            <p className="text-xs text-slate-500 mb-4">
              Click the button below to start a live voice conversation. Ask anything a real customer might ask.
            </p>

            {!callActive && preview?.agent_ready && preview?.demo_agent_id && (
              <div className="flex flex-col items-center justify-center py-16 bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl border border-blue-100">
                <div className="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mb-4 shadow-lg">
                  <Phone className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 mb-2">Ready to talk</h3>
                <p className="text-sm text-slate-600 mb-6 text-center max-w-xs">
                  Click below to start a voice conversation with your AI receptionist.
                </p>
                <button
                  onClick={startCall}
                  className="px-8 py-3 bg-blue-600 text-white rounded-full font-semibold hover:bg-blue-700 transition-all shadow-md"
                >
                  Start Live Call
                </button>
                <p className="text-xs text-slate-400 mt-4">Browser microphone access required</p>
              </div>
            )}

            {!callActive && (!preview?.agent_ready || !preview?.demo_agent_id) && (
              <div className="py-16 text-center">
                <p className="text-sm text-slate-500">
                  Voice agent is still being created. Try regenerating in a moment.
                </p>
              </div>
            )}

            {callActive && preview?.demo_agent_id && (
              <div>
                <PreviewVoiceWidget agentId={preview.demo_agent_id} />

                <div className="mt-4 flex justify-center">
                  <button
                    onClick={() => setCallActive(false)}
                    className="text-sm text-slate-600 hover:text-slate-900 underline"
                  >
                    Close widget
                  </button>
                </div>
              </div>
            )}

            <div className="mt-6">
              <p className="text-xs font-semibold text-slate-700 mb-2">Try asking your agent:</p>
              <ul className="text-xs text-slate-600 space-y-1">
                <li>• "What services do you offer?"</li>
                <li>• "Do you have emergency availability?"</li>
                <li>• "Can I book an appointment for tomorrow?"</li>
                <li>• "What are your pricing and payment options?"</li>
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-8 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-8 text-center text-white">
          <h2 className="text-2xl font-bold mb-2">Like what you hear?</h2>
          <p className="text-blue-100 mb-5">
            Sign up now and keep this agent. Your configuration carries over automatically.
          </p>
          <a
            href={`/signup?industry=${encodeURIComponent(industry)}&business_name=${encodeURIComponent(businessName)}&website=${encodeURIComponent(website)}`}
            className="inline-flex items-center gap-2 px-6 py-3 bg-white text-blue-700 rounded-lg font-semibold hover:bg-blue-50 transition-colors shadow-md"
          >
            Create My Account
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
      <LandingFooter />
    </div>
  );
}

