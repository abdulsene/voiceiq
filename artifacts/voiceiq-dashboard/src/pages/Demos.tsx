import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, X, Phone, Sparkles, Globe, Clock, Headphones, Star, Check, Mic, MicOff, PhoneOff } from "lucide-react";
import { Conversation } from "@elevenlabs/client";
import LandingNav from "../components/LandingNav";

type ConversationInstance = Awaited<ReturnType<typeof Conversation.startSession>>;

const DEFAULT_AGENT = "agent_6801kky8ktepegyszgc4kgtxsvpx";

type Demo = {
  id: string;
  emoji: string;
  industry: string;
  business: string;
  questions: [string, string, string];
  agentId: string;
  hasDedicatedAgent: boolean;
  featured?: boolean;
  subtitle?: string;
};

const DEMOS: Demo[] = [
  {
    id: "dental",
    emoji: "🦷",
    industry: "Dental",
    business: "Bright Smile Dental",
    questions: ["I need a cleaning", "Do you take insurance?", "How much does it cost?"],
    agentId: "agent_6801kky8ktepegyszgc4kgtxsvpx",
    hasDedicatedAgent: true,
  },
  {
    id: "law",
    emoji: "⚖️",
    industry: "Law Firm",
    business: "Smith & Associates Law",
    questions: ["I was in an accident", "Do you offer free consultations?", "What types of cases do you handle?"],
    agentId: "agent_1701kpbz4t8aedk81bmsh5jbe3j0",
    hasDedicatedAgent: true,
  },
  {
    id: "hvac",
    emoji: "🔧",
    industry: "HVAC",
    business: "Premier HVAC Solutions",
    questions: ["My AC isn't working", "Can I get a quote?", "Do you offer financing?"],
    agentId: "agent_0401kpbzb4h9fsy9xbpzja977rw0",
    hasDedicatedAgent: true,
  },
  {
    id: "restaurant",
    emoji: "🍽️",
    industry: "Restaurant",
    business: "The Golden Fork",
    questions: ["I need a reservation for 4", "Do you have vegan options?", "What are your hours?"],
    agentId: "agent_3801kpbzh586ebsttwabvjp2qwjp",
    hasDedicatedAgent: true,
  },
  {
    id: "government",
    emoji: "🏛️",
    industry: "Government",
    business: "City Services Office",
    questions: ["I need to renew my license", "What documents do I need?", "What are your hours?"],
    agentId: "agent_7901kpbzyx0jev1adg6ng1zc8q3b",
    hasDedicatedAgent: true,
  },
  {
    id: "medical",
    emoji: "🏥",
    industry: "Medical",
    business: "Riverside Medical Center",
    questions: ["I need to see a doctor", "Do you accept my insurance?", "Can I get a same-day appointment?"],
    agentId: "agent_1901kpbzqs4degh9b4g5a5r76ykv",
    hasDedicatedAgent: true,
  },
  {
    id: "gym",
    emoji: "💪",
    industry: "Gym",
    business: "FitLife Fitness Center",
    questions: ["How much is a membership?", "Do you offer a free trial?", "What classes do you have?"],
    agentId: DEFAULT_AGENT,
    hasDedicatedAgent: false,
  },
  {
    id: "real-estate",
    emoji: "🏠",
    industry: "Real Estate",
    business: "Premier Properties Group",
    questions: ["I want to sell my home", "Can I get a free valuation?", "What's the market like right now?"],
    agentId: DEFAULT_AGENT,
    hasDedicatedAgent: false,
  },
  {
    id: "veterinary",
    emoji: "🐕",
    industry: "Veterinary",
    business: "Happy Paws Animal Hospital",
    questions: ["I need to book a checkup", "My dog seems sick", "What vaccinations does my pet need?"],
    agentId: DEFAULT_AGENT,
    hasDedicatedAgent: false,
  },
  {
    id: "nail-salon",
    emoji: "💅",
    industry: "Nail Salon",
    business: "Luxe Nail Studio",
    questions: ["I want to book a gel manicure", "Do you do nail art?", "How much is a full set?"],
    agentId: DEFAULT_AGENT,
    hasDedicatedAgent: false,
  },
  {
    id: "auto-repair",
    emoji: "🚗",
    industry: "Auto Repair",
    business: "ProAuto Service Center",
    questions: ["My check engine light is on", "Can I get a quote for brakes?", "How long will it take?"],
    agentId: DEFAULT_AGENT,
    hasDedicatedAgent: false,
  },
  {
    id: "auto",
    emoji: "🚘",
    industry: "Auto Dealership",
    business: "Premier Auto Group",
    subtitle: "Perfect for new & used car dealers",
    questions: ["I want to test drive a new SUV", "What is my trade-in worth?", "What financing options do you offer?"],
    agentId: "agent_5901kpe494mqf8sszqvhyam7n1py",
    hasDedicatedAgent: true,
    featured: true,
  },
  {
    id: "storage",
    emoji: "📦",
    industry: "Storage",
    business: "SecureSpace Storage",
    questions: ["What size units do you have?", "Do you have climate control?", "What is the monthly cost?"],
    agentId: "agent_0001kpe6n7xbftbajn5d4ekv2rpv",
    hasDedicatedAgent: true,
  },
  {
    id: "realty",
    emoji: "🏡",
    industry: "Realty",
    business: "Premier Properties",
    questions: ["I want to sell my home", "Can I get a free home valuation?", "I am looking to buy in this area"],
    agentId: "agent_3201kpe6t9a7f12bmny3gqcr5jp8",
    hasDedicatedAgent: true,
  },
];

type CallStatus = "idle" | "permission" | "connecting" | "connected" | "error";

function DemoModal({ demo, onClose }: { demo: Demo; onClose: () => void }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const wasConnectedRef = useRef(false);
  const conversationRef = useRef<ConversationInstance | null>(null);

  const conversationActive = callStatus === "connected" || callStatus === "connecting";

  const startCall = useCallback(async () => {
    setCallError(null);
    setCallStatus("permission");
    console.log("[DemoModal] requesting mic permission…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[DemoModal] mic granted");
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      console.error("[DemoModal] mic getUserMedia failed", err);
      const name = err instanceof Error ? err.name : "Error";
      const msg =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access denied. Please allow microphone in your browser settings and refresh."
          : name === "NotFoundError"
          ? "No microphone detected. Please connect a microphone and try again."
          : err instanceof Error
          ? `${err.name}: ${err.message}`
          : "Microphone access required. Please allow microphone and try again.";
      setCallError(msg);
      setCallStatus("error");
      return;
    }
    setCallStatus("connecting");

    const callbacks = {
      onConnect: () => {
        console.log("[DemoModal] connected");
        setCallStatus("connected");
        wasConnectedRef.current = true;
      },
      onDisconnect: () => {
        console.log("[DemoModal] disconnected");
        setCallStatus("idle");
        setIsAgentSpeaking(false);
        conversationRef.current = null;
        if (wasConnectedRef.current) {
          wasConnectedRef.current = false;
          setFeedbackOpen(true);
        }
      },
      onError: (msg: string, ctx?: unknown) => {
        console.error("[DemoModal] conversation error", msg, ctx);
        setCallError(msg || "Connection lost. Please try again.");
        setCallStatus("error");
      },
      onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => {
        setIsAgentSpeaking(mode === "speaking");
      },
    } as const;

    console.log("[DemoModal] starting session (websocket) with agent:", demo.agentId);
    try {
      const convo = await Conversation.startSession({
        agentId: demo.agentId,
        connectionType: "websocket",
        ...callbacks,
      });
      conversationRef.current = convo;
      console.log("[DemoModal] session started:", convo.getId());
    } catch (err) {
      console.error("[DemoModal] startSession failed", err);
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : typeof err === "string"
          ? err
          : "Could not start the call. Please check your network and try again.";
      setCallError(msg);
      setCallStatus("error");
    }
  }, [demo.agentId]);

  const endCall = useCallback(async () => {
    const convo = conversationRef.current;
    if (convo) {
      try {
        await convo.endSession();
      } catch (err) {
        console.error("[DemoModal] endSession failed", err);
      }
    }
    conversationRef.current = null;
    setIsAgentSpeaking(false);
    setCallStatus("idle");
  }, []);

  // End call on unmount
  useEffect(() => {
    return () => {
      const convo = conversationRef.current;
      if (convo) {
        try {
          void convo.endSession();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (feedbackOpen) {
        setFeedbackOpen(false);
        setRating(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose, feedbackOpen]);

  // Auto-dismiss feedback after 30s
  useEffect(() => {
    if (!feedbackOpen) return;
    const t = setTimeout(() => {
      setFeedbackOpen(false);
      setRating(null);
    }, 30000);
    return () => clearTimeout(t);
  }, [feedbackOpen]);

  const trialUrl = `/signup?utm_source=demo&utm_industry=${encodeURIComponent(demo.id)}`;

  function dismissFeedback() {
    setFeedbackOpen(false);
    setRating(null);
  }

  return (
    <div
      className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-white flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{demo.emoji}</span>
            <span className="text-sm font-semibold text-gray-700">{demo.industry}</span>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors shrink-0"
            aria-label="Close demo"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-6 pb-4 text-center">
          <div className="flex items-center justify-center gap-1.5 mb-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" style={{ animationDelay: "150ms" }} />
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" style={{ animationDelay: "300ms" }} />
          </div>
          <h3 className="text-xl font-bold text-[#1B2537]">{demo.business}</h3>
          <p className="text-sm text-gray-500">AI Receptionist</p>
        </div>

        <div className="px-6 pb-4 min-h-[180px]">
          {callStatus === "idle" && (
            <>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Try asking</p>
              <ul className="space-y-1.5 mb-4">
                {demo.questions.map((q) => (
                  <li key={q} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-[#2E75B6] mt-0.5">•</span>
                    <span>"{q}"</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={startCall}
                className="w-full bg-[#2E75B6] hover:bg-[#2563a0] text-white font-semibold rounded-full py-3 px-4 flex items-center justify-center gap-2 shadow-lg shadow-[#2E75B6]/30 transition-colors"
              >
                <Mic className="w-5 h-5" />
                Start Conversation
              </button>
            </>
          )}

          {(callStatus === "permission" || callStatus === "connecting") && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="flex items-center gap-1.5 mb-3">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="w-2.5 h-2.5 rounded-full bg-[#2E75B6]"
                    style={{
                      animation: "neverr-bounce 1.2s ease-in-out infinite",
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </div>
              <p className="text-sm font-semibold text-[#1B2537]">
                {callStatus === "permission" ? "Requesting microphone…" : "Connecting…"}
              </p>
            </div>
          )}

          {callStatus === "connected" && (
            <>
              <div className="flex items-end justify-center gap-1.5 h-16 mb-3">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <span
                    key={i}
                    className="rounded-full"
                    style={{
                      width: 5,
                      background: "#2E75B6",
                      animation: isAgentSpeaking
                        ? `neverr-wave 0.8s ease-in-out ${i * 0.08}s infinite alternate`
                        : "none",
                      height: isAgentSpeaking ? undefined : 6,
                      transition: "height 0.2s ease",
                    }}
                  />
                ))}
              </div>
              <p className="text-center text-[11px] text-gray-500 mb-3">
                {isAgentSpeaking ? `${demo.business} is speaking…` : "Listening… speak now"}
              </p>
              <button
                type="button"
                onClick={endCall}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold rounded-full py-2.5 px-4 flex items-center justify-center gap-2 transition-colors"
              >
                <PhoneOff className="w-4 h-4" />
                End Call
              </button>
            </>
          )}

          {callStatus === "error" && (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mb-2">
                <MicOff className="w-5 h-5 text-red-600" />
              </div>
              <p className="text-sm font-semibold text-[#1B2537] mb-1">Couldn't start the call</p>
              <p className="text-xs text-gray-500 mb-3 max-w-[260px]">{callError ?? "Please try again."}</p>
              <button
                type="button"
                onClick={startCall}
                className="bg-[#2E75B6] hover:bg-[#2563a0] text-white text-sm font-semibold rounded-full py-2 px-4"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        <div className="px-6 pb-6 pt-4 border-t border-gray-100 bg-gray-50">
          <p className="text-sm font-semibold text-[#1B2537] mb-3">Want this for your business?</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <Link
              href={trialUrl}
              className="flex-1 px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg hover:bg-[#2563a0] transition-colors text-center flex items-center justify-center gap-1"
            >
              Start Free Trial <ArrowRight className="w-4 h-4" />
            </Link>
            <a
              href="/#book-demo"
              className="flex-1 px-4 py-2.5 border-2 border-gray-200 text-gray-700 text-sm font-semibold rounded-lg hover:border-[#2E75B6] hover:text-[#2E75B6] transition-colors text-center"
            >
              Book a Demo Call
            </a>
          </div>
        </div>

        {feedbackOpen && (
          <div
            className="absolute inset-0 bg-black/50 flex items-center justify-center p-4 z-20"
            onClick={dismissFeedback}
          >
            <div
              className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-bold text-[#1B2537]">How was that experience?</p>
                <button
                  onClick={dismissFeedback}
                  aria-label="Close feedback"
                  className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500 shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-4 py-4">
                {rating === null && (
                  <>
                    <div className="flex items-center justify-center gap-1.5 mb-3">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button
                          key={n}
                          onClick={() => setRating(n)}
                          className="w-9 h-9 rounded-lg hover:bg-amber-50 flex items-center justify-center transition-colors group"
                          aria-label={`Rate ${n} stars`}
                        >
                          <Star className="w-6 h-6 text-gray-300 group-hover:text-amber-400 group-hover:fill-amber-400 transition-colors" />
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-gray-600 text-center leading-relaxed">
                      That's what your customers hear when they call your business 24/7.
                    </p>
                  </>
                )}
                {rating !== null && rating >= 4 && (
                  <div className="text-center py-2">
                    <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-2">
                      <Check className="w-5 h-5 text-emerald-600" />
                    </div>
                    <p className="text-sm font-semibold text-[#1B2537] mb-1">So glad you liked it!</p>
                    <p className="text-xs text-gray-500 mb-3">Start your trial:</p>
                  </div>
                )}
                {rating !== null && rating < 4 && (
                  <div className="text-center py-2">
                    <p className="text-sm font-semibold text-[#1B2537] mb-1">Thanks for the feedback.</p>
                    <p className="text-xs text-gray-500 mb-3">Our team is always improving. Try another demo.</p>
                  </div>
                )}
              </div>
              <div className="px-4 pb-4 space-y-2">
                <Link
                  href={trialUrl}
                  className="block w-full px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg hover:bg-[#2563a0] text-center flex items-center justify-center gap-1"
                >
                  Start Free Trial <ArrowRight className="w-4 h-4" />
                </Link>
                <button
                  onClick={dismissFeedback}
                  className="block w-full text-center text-xs text-gray-500 hover:text-gray-700 py-1"
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Demos() {
  const [activeDemo, setActiveDemo] = useState<Demo | null>(null);

  useEffect(() => {
    document.title = "Live AI Receptionist Demos | Neverr AI";
    let meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.appendChild(meta);
    }
    meta.content =
      "Try a live AI receptionist demo for your industry. Hear exactly what your customers experience. Dental, legal, HVAC, restaurant, government and more. No signup required.";
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f7f9fc] to-white">
      {/* Sprint 2 STEP 2 (BUG-13): replaced the Demos-specific custom nav
          (logo + Home/Demos/Partners links + "Get Started Free" CTA) with
          the standard public LandingNav so /demos matches the rest of the
          marketing surface and gets the new mobile hamburger for free. */}
      <LandingNav />

      <section className="pt-16 pb-10 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#2E75B6]/10 text-[#2E75B6] text-xs font-semibold rounded-full mb-5">
            <Sparkles className="w-3.5 h-3.5" /> Live conversations · No signup required
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-[#1B2537] mb-4 leading-tight">
            Hear Neverr in Action
          </h1>
          <p className="text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed">
            Click any industry to have a real conversation with an AI receptionist trained for that
            business type. No signup required.
          </p>
        </div>
      </section>

      <section className="px-6 mb-10">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white border border-gray-200 rounded-2xl shadow-sm px-4 sm:px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
            <div>
              <div className="flex items-center justify-center gap-1.5 text-[#2E75B6] mb-1">
                <Headphones className="w-4 h-4" />
                <p className="text-xl font-bold text-[#1B2537]">2,400+</p>
              </div>
              <p className="text-xs text-gray-500">businesses</p>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1.5 text-[#2E75B6] mb-1">
                <Phone className="w-4 h-4" />
                <p className="text-xl font-bold text-[#1B2537]">1.2M</p>
              </div>
              <p className="text-xs text-gray-500">calls handled</p>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1.5 text-[#2E75B6] mb-1">
                <Globe className="w-4 h-4" />
                <p className="text-xl font-bold text-[#1B2537]">32</p>
              </div>
              <p className="text-xs text-gray-500">languages</p>
            </div>
            <div>
              <div className="flex items-center justify-center gap-1.5 text-[#2E75B6] mb-1">
                <Clock className="w-4 h-4" />
                <p className="text-xl font-bold text-[#1B2537]">24/7</p>
              </div>
              <p className="text-xs text-gray-500">availability</p>
            </div>
          </div>
        </div>
      </section>

      <section className="px-6 pb-20">
        <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {DEMOS.map((demo) => (
            <button
              key={demo.id}
              onClick={() => setActiveDemo(demo)}
              className={
                demo.featured
                  ? "group relative text-left bg-gradient-to-br from-amber-50 to-white border-2 border-amber-400 hover:border-amber-500 rounded-2xl p-7 shadow-lg shadow-amber-200/40 hover:shadow-xl hover:shadow-amber-300/50 transition-all flex flex-col md:scale-[1.02] ring-1 ring-amber-300/30"
                  : "group text-left bg-white border border-gray-200 hover:border-[#2E75B6] rounded-2xl p-6 shadow-sm hover:shadow-lg transition-all flex flex-col"
              }
            >
              {demo.featured && (
                <span className="absolute -top-3 right-4 text-[11px] font-bold text-white bg-gradient-to-r from-amber-500 to-orange-500 px-3 py-1 rounded-full shadow-md">
                  ⭐ Most Popular
                </span>
              )}
              <div className="flex items-start justify-between mb-4">
                <span className={demo.featured ? "text-5xl" : "text-4xl"}>{demo.emoji}</span>
                {!demo.hasDedicatedAgent && !demo.featured && (
                  <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                    Sample
                  </span>
                )}
              </div>
              <h3 className={`font-bold text-[#1B2537] mb-1 ${demo.featured ? "text-xl" : "text-lg"}`}>
                {demo.industry}
              </h3>
              <p className="text-sm text-gray-500 mb-1">{demo.business}</p>
              {demo.subtitle && (
                <p className="text-xs font-semibold text-amber-700 mb-3">{demo.subtitle}</p>
              )}
              <div className={`space-y-1.5 flex-1 ${demo.subtitle ? "mt-2 mb-5" : "mb-5"}`}>
                {demo.questions.map((q) => (
                  <div key={q} className="flex items-start gap-2 text-xs text-gray-600">
                    <span className={demo.featured ? "text-amber-600 mt-0.5" : "text-[#2E75B6] mt-0.5"}>•</span>
                    <span className="leading-snug">"{q}"</span>
                  </div>
                ))}
              </div>
              <div
                className={
                  demo.featured
                    ? "w-full px-4 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-sm font-bold rounded-lg group-hover:from-amber-600 group-hover:to-orange-600 transition-all flex items-center justify-center gap-1 shadow-md"
                    : "w-full px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg group-hover:bg-[#2563a0] transition-colors flex items-center justify-center gap-1"
                }
              >
                Try Demo <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="px-6 pb-20">
        <div className="max-w-4xl mx-auto bg-gradient-to-br from-[#1B2537] to-[#2E75B6] rounded-3xl p-10 md:p-12 text-center text-white shadow-xl">
          <h2 className="text-3xl md:text-4xl font-bold mb-3">Ready to never miss another call?</h2>
          <p className="text-white/80 max-w-xl mx-auto mb-8">
            Set up your own AI receptionist in under 10 minutes. Trained on your business, in any
            language your customers speak.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/signup?utm_source=demos_footer"
              className="px-7 py-3.5 bg-white text-[#1B2537] text-base font-bold rounded-xl hover:bg-gray-100 transition-colors flex items-center gap-2"
            >
              Start Your Free 14-Day Trial <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              href="/pricing"
              className="px-7 py-3.5 border-2 border-white/30 text-white text-base font-semibold rounded-xl hover:bg-white/10 transition-colors"
            >
              See Pricing
            </Link>
          </div>
          <p className="text-xs text-white/60 mt-4">No credit card required</p>
        </div>
      </section>

      <footer className="border-t border-gray-100 py-8 text-center text-xs text-gray-500">
        <p>
          © {new Date().getFullYear()} Neverr AI ·{" "}
          <Link href="/privacy" className="hover:text-gray-700">Privacy</Link> ·{" "}
          <Link href="/terms" className="hover:text-gray-700">Terms</Link>
        </p>
      </footer>

      {activeDemo && <DemoModal demo={activeDemo} onClose={() => setActiveDemo(null)} />}
    </div>
  );
}
