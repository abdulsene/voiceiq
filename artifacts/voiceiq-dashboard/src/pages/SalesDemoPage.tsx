import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Sparkles } from "lucide-react";
import PreviewVoiceWidget from "../components/PreviewVoiceWidget";
import LandingNav from "../components/LandingNav";
import LandingFooter from "../components/LandingFooter";

const API = window.location.origin + "/api";

type DemoData = {
  success: boolean;
  demo_business_id: string;
  demo_agent_id: string | null;
  industry: string;
  business_name: string;
  expires_at: string;
  expired: boolean;
  call_count?: number;
  error?: string;
};

/**
 * Public landing page for a persistent sales demo created by an admin via
 * Settings → Sales Demos. Loaded at /demo/:demoBusinessId. Reuses the same
 * GET /api/preview/:id endpoint that powers /try-your-agent (Phase 3d), so
 * revoked / expired demos surface a clean "unavailable" screen.
 */
export default function SalesDemoPage() {
  const [, params] = useRoute<{ demoBusinessId: string }>("/demo/:demoBusinessId");
  const demoBusinessId = params?.demoBusinessId || "";

  const [demo, setDemo] = useState<DemoData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!demoBusinessId) {
      setLoading(false);
      setError("No demo specified");
      return;
    }
    fetch(`${API}/preview/${demoBusinessId}`)
      .then((r) => r.json())
      .then((d: DemoData) => {
        if (d.success && !d.expired) {
          setDemo(d);
        } else {
          setError(d.error || "This demo is no longer available");
        }
      })
      .catch(() => setError("Could not load demo"))
      .finally(() => setLoading(false));
  }, [demoBusinessId]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <LandingNav />
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full" />
        </div>
        <LandingFooter />
      </div>
    );
  }

  if (error || !demo) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-50">
        <LandingNav />
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-lg p-8 max-w-md text-center">
            <h1 className="text-xl font-bold text-slate-900 mb-2">Demo Unavailable</h1>
            <p className="text-sm text-slate-600 mb-4">
              {error || "This demo link has expired or been revoked."}
            </p>
            <a href="/" className="text-sm text-blue-600 hover:underline">
              Visit Neverr →
            </a>
          </div>
        </div>
        <LandingFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <LandingNav />
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-50 text-emerald-700 rounded-full text-sm font-medium mb-6">
            <Sparkles className="w-4 h-4" />
            Personal Demo
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
            Meet your AI receptionist —<br />
            calibrated for {demo.business_name}.
          </h1>
          <p className="text-lg text-slate-600 max-w-xl mx-auto">
            This is a live preview built specifically for your business. Click below to talk to it.
          </p>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-lg p-8 max-w-md mx-auto">
          {demo.demo_agent_id ? (
            <PreviewVoiceWidget agentId={demo.demo_agent_id} />
          ) : (
            <div className="p-8 text-center text-slate-500">
              The voice agent for this demo is still warming up. Please refresh in a moment.
            </div>
          )}
        </div>

        <div className="mt-12 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-2xl p-8 text-center text-white max-w-2xl mx-auto">
          <p className="text-sm font-mono text-blue-200 uppercase tracking-wider mb-3">
            Never miss a call. Never miss a client. Neverr.
          </p>
          <h2 className="text-2xl font-bold mb-2">Ready to set this up for your business?</h2>
          <p className="text-blue-100 mb-5">
            Get your own AI receptionist live in 30 seconds. No credit card required for trial.
          </p>
          <a
            href="/signup"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white text-blue-700 rounded-lg font-semibold hover:bg-blue-50 transition-colors shadow-md"
          >
            Start Free Trial →
          </a>
        </div>

        <p className="text-center text-xs text-slate-400 mt-8">
          Powered by Neverr AI • This is a personalized demo
        </p>
      </div>
      <LandingFooter />
    </div>
  );
}
