import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  Phone,
  ArrowRight,
  BarChart3,
  Headphones,
  Sparkles,
  ExternalLink,
} from "lucide-react";
import NeverrVoiceWidget from "../components/NeverrVoiceWidget";
import LandingNav from "../components/LandingNav";

const API = "/api";

interface DemoAccount {
  industry_id: string;
  industry_name: string;
  business_name: string;
  phone_number: string;
  category: string;
  icon: string;
  tagline: string;
  is_active: boolean;
}

function DemoContent() {
  const [categories, setCategories] = useState<Record<string, DemoAccount[]>>({});
  const [loading, setLoading] = useState(true);
  const [loginLoading, setLoginLoading] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API}/demo/industries`)
      .then(r => r.json())
      .then(d => {
        if (d.success) setCategories(d.categories || {});
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const handleDemoLogin = async (industryId: string) => {
    setLoginLoading(industryId);
    try {
      const r = await fetch(`${API}/demo/${industryId}/login`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const d = await r.json();
      if (d.success && d.session) {
        localStorage.setItem("neverr_token", d.session.access_token);
        localStorage.setItem("neverr_refresh", d.session.refresh_token);
        localStorage.setItem("neverr_business_id", d.business_id);
        localStorage.setItem("neverr_active_business_id", d.business_id);
        window.location.href = "/dashboard";
      } else {
        alert(d.error || "Demo login not available for this industry yet. Check back soon!");
      }
    } catch {
      alert("Connection error. Please try again.");
    }
    setLoginLoading(null);
  };

  const totalDemos = Object.values(categories).flat().length;

  return (
    <div className="min-h-screen bg-white">
      {/* Sprint 2 BUG-04 + BUG-13: replaced the dark
          bg-[#1B2537] header (which used `brightness-0 invert` on the
          colour PNG and rendered as a white blob) with the standard
          public LandingNav so /demo matches /features, /pricing, /roi.
          This single change closes BUG-04 (broken logo) and BUG-13
          (missing nav on /demo). The hero gradient below is unchanged. */}
      <LandingNav />

      <section className="bg-gradient-to-b from-[#1B2537] to-[#2a3f5f] text-white py-20">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-white/10 rounded-full text-sm mb-6">
            <Sparkles className="w-4 h-4 text-yellow-400" />
            <span>Live AI Demo — No signup required</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4 leading-tight">
            Experience Neverr Live
          </h1>
          <p className="text-lg text-gray-300 max-w-2xl mx-auto mb-8">
            Call any number below and talk to a real AI receptionist. Then log into the dashboard to see your call analyzed in real time.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-8 mt-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#2E75B6]/20 flex items-center justify-center">
                <Phone className="w-5 h-5 text-[#2E75B6]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold">Step 1</p>
                <p className="text-xs text-gray-400">Pick your industry below</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-500 hidden md:block" />
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#2E75B6]/20 flex items-center justify-center">
                <Headphones className="w-5 h-5 text-[#2E75B6]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold">Step 2</p>
                <p className="text-xs text-gray-400">Call the number — talk to AI</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-gray-500 hidden md:block" />
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#2E75B6]/20 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-[#2E75B6]" />
              </div>
              <div className="text-left">
                <p className="text-sm font-semibold">Step 3</p>
                <p className="text-xs text-gray-400">View Dashboard — see call analyzed</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 bg-gray-50">
        <div className="max-w-6xl mx-auto px-6">
          {loading ? (
            <div className="text-center py-20">
              <div className="animate-spin w-8 h-8 border-3 border-[#2E75B6] border-t-transparent rounded-full mx-auto mb-4" />
              <p className="text-gray-500">Loading demo accounts...</p>
            </div>
          ) : totalDemos === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-500 text-lg">Demo accounts are being set up. Check back soon!</p>
            </div>
          ) : (
            Object.entries(categories).map(([category, demos]) => (
              <div key={category} className="mb-10">
                <h2 className="text-sm font-bold text-gray-400 uppercase tracking-wider mb-4">{category}</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {demos.map(demo => (
                    <div
                      key={demo.industry_id}
                      className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-lg hover:border-[#2E75B6]/30 transition-all group"
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <span className="text-3xl">{demo.icon}</span>
                          <div>
                            <h3 className="text-base font-bold text-gray-900">{demo.business_name}</h3>
                            <p className="text-xs text-gray-500">{demo.industry_name}</p>
                          </div>
                        </div>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#2E75B6]/10 text-[#2E75B6]">
                          {demo.category}
                        </span>
                      </div>

                      <p className="text-sm text-gray-600 mb-4">{demo.tagline}</p>

                      {demo.phone_number ? (
                        // Sprint 2 BUG-21: defensive E.164 normalisation
                        // for the tel: href. The displayed number is
                        // kept as the human-readable string the API
                        // returns (e.g. "(978) 963-8377"). Some Android
                        // dialers reject tel: URLs with parens / dashes
                        // / spaces, so we strip non-digits and prepend
                        // "+" before handing it to the dialer.
                        <a
                          href={`tel:+${demo.phone_number.replace(/\D/g, "")}`}
                          className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg mb-3 hover:bg-green-100 transition-colors"
                        >
                          <Phone className="w-4 h-4 text-green-600" />
                          <span className="text-base font-bold text-green-800 font-mono">{demo.phone_number}</span>
                        </a>
                      ) : (
                        <div className="flex items-center gap-2 p-3 bg-gray-50 border border-gray-200 rounded-lg mb-3">
                          <Phone className="w-4 h-4 text-gray-400" />
                          <span className="text-sm text-gray-400 italic">Phone number coming soon</span>
                        </div>
                      )}

                      <div className="flex gap-2">
                        {demo.phone_number && (
                          // Sprint 2 BUG-21: same E.164 normalisation as
                          // the inline phone-number link above.
                          <a
                            href={`tel:+${demo.phone_number.replace(/\D/g, "")}`}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 transition-colors"
                          >
                            <Phone className="w-4 h-4" />
                            Call Now
                          </a>
                        )}
                        <button
                          onClick={() => handleDemoLogin(demo.industry_id)}
                          disabled={loginLoading === demo.industry_id}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg hover:bg-[#2563a0] transition-colors disabled:opacity-60"
                        >
                          {loginLoading === demo.industry_id ? (
                            <>
                              <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" />
                              Loading...
                            </>
                          ) : (
                            <>
                              <ExternalLink className="w-4 h-4" />
                              View Dashboard
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <h2 className="text-2xl font-bold text-gray-900 mb-3">Ready to get started?</h2>
          <p className="text-gray-500 mb-8">Set up your own AI receptionist in under 10 minutes. No credit card required.</p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 px-8 py-3 bg-[#2E75B6] text-white text-base font-semibold rounded-xl hover:bg-[#2563a0] transition-colors shadow-lg shadow-[#2E75B6]/20"
          >
            Create Your Account <ArrowRight className="w-5 h-5" />
          </Link>
        </div>
      </section>

      <footer className="bg-[#1B2537] text-gray-400 py-8">
        <div className="max-w-6xl mx-auto px-6 flex items-center justify-between text-xs">
          <p>Powered by ElevenLabs + Anthropic Claude</p>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-white transition-colors">Privacy</Link>
            <Link href="/terms" className="hover:text-white transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default function Demo() {
  return (
    <>
      <DemoContent />
      <NeverrVoiceWidget />
    </>
  );
}
