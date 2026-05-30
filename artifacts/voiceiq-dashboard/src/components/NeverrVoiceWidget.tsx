import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, MicOff, X, Minus, Search, Star, Check, ArrowRight, ChevronUp, PhoneOff, Volume2 } from "lucide-react";
import { Conversation } from "@elevenlabs/client";

type ConversationInstance = Awaited<ReturnType<typeof Conversation.startSession>>;

const DENTAL_PLACEHOLDER = "agent_6801kky8ktepegyszgc4kgtxsvpx";

const CONNECTING_MESSAGES = [
  "Warming up your AI receptionist...",
  "Loading industry knowledge...",
  "Preparing voice and personality...",
  "Almost ready to take your call...",
  "Establishing secure connection...",
];

const TIPS = [
  "💡 Neverr answers calls in under 1 ring",
  "💡 Works in 32 languages automatically",
  "💡 Captures leads while you sleep",
  "💡 Books appointments 24/7 with no staff",
  "💡 Setup takes under 5 minutes",
];

type DemoTab = {
  id: string;
  label: string;
  shortLabel: string;
  emoji: string;
  agentId: string;
  businessName: string;
  tagline: string;
  accent: string;
  questions: [string, string, string];
  sample?: boolean;
};

const TABS: DemoTab[] = [
  { id: "nova", label: "Nova", shortLabel: "Nova", emoji: "✨", agentId: "agent_5001kpbmwnsge4r99x6yfz05m2mb", businessName: "Nova — Neverr AI", tagline: "Ask me anything about our product", accent: "#2E75B6", questions: ["What does Neverr do?", "How much does it cost?", "How do I get started?"] },
  { id: "dental", label: "Dental", shortLabel: "Dental", emoji: "🦷", agentId: "agent_6801kky8ktepegyszgc4kgtxsvpx", businessName: "Bright Smile Dental", tagline: "Book appointments, answer insurance questions", accent: "#06B6D4", questions: ["I need a cleaning", "Do you take insurance?", "How much is a crown?"] },
  { id: "law", label: "Law Firm", shortLabel: "Law", emoji: "⚖️", agentId: "agent_1701kpbz4t8aedk81bmsh5jbe3j0", businessName: "Smith & Associates Law", tagline: "Schedule free consultations, intake leads", accent: "#7C3AED", questions: ["I was in a car accident", "Do you offer free consults?", "What cases do you handle?"] },
  { id: "hvac", label: "HVAC", shortLabel: "HVAC", emoji: "🔧", agentId: "agent_0401kpbzb4h9fsy9xbpzja977rw0", businessName: "Premier HVAC Solutions", tagline: "Emergency repair dispatch and quoting", accent: "#F59E0B", questions: ["My AC isn't working", "Can I get a quote?", "Do you offer financing?"] },
  { id: "restaurant", label: "Restaurant", shortLabel: "Food", emoji: "🍽️", agentId: "agent_3801kpbzh586ebsttwabvjp2qwjp", businessName: "The Golden Fork", tagline: "Reservations, menu questions, hours", accent: "#DC2626", questions: ["I need a reservation for 4", "Do you have vegan options?", "What are your hours?"] },
  { id: "gov", label: "Government", shortLabel: "Gov", emoji: "🏛️", agentId: "agent_7901kpbzyx0jev1adg6ng1zc8q3b", businessName: "City Services Office", tagline: "License renewals, permits, info lookup", accent: "#1B2537", questions: ["I need to renew my license", "What documents do I need?", "How long is the wait?"] },
  { id: "medical", label: "Medical", shortLabel: "Med", emoji: "🏥", agentId: "agent_1901kpbzqs4degh9b4g5a5r76ykv", businessName: "Riverside Medical Center", tagline: "Appointments, insurance, same-day visits", accent: "#10B981", questions: ["I need to see a doctor", "Do you accept my insurance?", "Can I get a same-day appointment?"] },
  { id: "gym", label: "Gym", shortLabel: "Gym", emoji: "💪", agentId: DENTAL_PLACEHOLDER, businessName: "FitLife Fitness Center", tagline: "Memberships, classes, free trials", accent: "#EF4444", questions: ["How much is a membership?", "Do you have a free trial?", "What classes do you offer?"], sample: true },
  { id: "real-estate", label: "Real Estate", shortLabel: "Real Est.", emoji: "🏠", agentId: DENTAL_PLACEHOLDER, businessName: "Premier Properties Group", tagline: "Home valuations, listings, buyer inquiries", accent: "#0EA5E9", questions: ["I want to sell my home", "Can I get a free valuation?", "What is the market like?"], sample: true },
  { id: "vet", label: "Veterinary", shortLabel: "Vet", emoji: "🐕", agentId: DENTAL_PLACEHOLDER, businessName: "Happy Paws Animal Hospital", tagline: "Pet appointments, symptoms, vaccines", accent: "#84CC16", questions: ["My dog needs a checkup", "What vaccinations are required?", "Do you see cats too?"], sample: true },
  { id: "nail", label: "Nail Salon", shortLabel: "Nails", emoji: "💅", agentId: DENTAL_PLACEHOLDER, businessName: "Luxe Nail Studio", tagline: "Manicure bookings, pricing, services", accent: "#EC4899", questions: ["I want a gel manicure", "Do you do nail art?", "How much is a full set?"], sample: true },
  { id: "barber", label: "Barbershop", shortLabel: "Barber", emoji: "✂️", agentId: DENTAL_PLACEHOLDER, businessName: "The Classic Cut", tagline: "Walk-ins, appointments, pricing", accent: "#78716C", questions: ["I need a haircut today", "Do I need an appointment?", "How much is a fade?"], sample: true },
  { id: "auto", label: "Auto", shortLabel: "Auto", emoji: "🚘", agentId: "agent_5901kpe494mqf8sszqvhyam7n1py", businessName: "Premier Auto Group", tagline: "Car sales, service & trade-ins", accent: "#D97706", questions: ["I want to test drive a new SUV", "What is my trade-in worth?", "What financing options do you offer?"] },
  { id: "storage", label: "Storage", shortLabel: "Storage", emoji: "📦", agentId: "agent_0001kpe6n7xbftbajn5d4ekv2rpv", businessName: "SecureSpace Storage", tagline: "Unit availability & reservations", accent: "#0891B2", questions: ["What size units do you have?", "Do you have climate control?", "What is the monthly cost?"] },
  { id: "realty", label: "Realty", shortLabel: "Realty", emoji: "🏡", agentId: "agent_3201kpe6t9a7f12bmny3gqcr5jp8", businessName: "Premier Properties", tagline: "Buy, sell & home valuations", accent: "#059669", questions: ["I want to sell my home", "Can I get a free home valuation?", "I am looking to buy in this area"] },
];

const Z_MAX = 2147483647;

type CallStatus = "idle" | "permission" | "connecting" | "connected" | "error";

export default function NeverrVoiceWidget() {
  const [open, setOpen] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const [activeTab, setActiveTab] = useState<DemoTab>(TABS[0]);
  // SOURCE OF TRUTH for which agent startCall will use. Updated synchronously
  // on every tab switch BEFORE any await — so even if startCall is somehow
  // called with a stale closure, the ref is guaranteed to be current.
  const activeAgentIdRef = useRef<string>(TABS[0].agentId);
  const [query, setQuery] = useState("");
  const [pendingSwitch, setPendingSwitch] = useState<DemoTab | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const activatedAtRef = useRef<number | null>(null);

  const [micPermission, setMicPermission] = useState<PermissionState | "unknown">("unknown");
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const conversationRef = useRef<ConversationInstance | null>(null);

  const micStreamRef = useRef<MediaStream | null>(null);
  const [micReady, setMicReady] = useState(false);

  // ---------- Background music (self-hosted MP3 in /public/ambient.mp3) ----------
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const startAmbient = useCallback(() => {
    if (audioRef.current) return; // already playing

    // Absolute URL guarantees the file resolves to the production host
    // regardless of which subpath the dashboard is mounted under.
    const musicUrl = "https://neverr.ai/ambient.mp3";

    console.log("[Music] Loading from:", musicUrl);

    const audio = new Audio(musicUrl);
    audio.volume = 0.15; // higher for testing — tune down once confirmed audible
    audio.loop = true;
    audio.crossOrigin = "anonymous";

    audio.addEventListener("canplay", () => {
      console.log("[Music] File loaded, playing...");
      audio.play().catch((e) => console.log("[Music] Play failed:", e));
    });

    audio.addEventListener("error", () => {
      console.log("[Music] Load error event fired");
      console.log("[Music] Error code:", audio.error?.code);
      console.log("[Music] Error message:", audio.error?.message);
      console.log("[Music] networkState:", audio.networkState, "readyState:", audio.readyState);
    });

    audioRef.current = audio;
  }, []);

  const stopAmbient = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* noop */ }
      audioRef.current = null;
      console.log("[Music] Stopped");
    }
  }, []);

  const conversationActive = callStatus === "connected" || callStatus === "connecting";

  const [connectingMsgIdx, setConnectingMsgIdx] = useState(0);
  const [tipIdx, setTipIdx] = useState(0);

  // One-time confirmation that the right agent IDs are loaded in this build.
  useEffect(() => {
    console.log(
      "[Neverr] Loaded tabs:",
      TABS.map((t) => ({ id: t.id, agentId: t.agentId, sample: !!t.sample })),
    );
  }, []);

  // Cycle the "connecting" headline every 2s while connecting
  useEffect(() => {
    if (callStatus !== "connecting" && callStatus !== "permission") {
      setConnectingMsgIdx(0);
      return;
    }
    const interval = setInterval(() => {
      setConnectingMsgIdx((i) => (i + 1) % CONNECTING_MESSAGES.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [callStatus]);

  // Cycle the tip line every 3s while connecting
  useEffect(() => {
    if (callStatus !== "connecting" && callStatus !== "permission") {
      setTipIdx(0);
      return;
    }
    const interval = setInterval(() => {
      setTipIdx((i) => (i + 1) % TIPS.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [callStatus]);

  // Probe mic permission whenever the panel opens
  useEffect(() => {
    if (!open || minimized) return;
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") return;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((result: PermissionStatus) => {
        console.log("[Neverr] mic permission:", result.state);
        setMicPermission(result.state);
        result.onchange = () => {
          console.log("[Neverr] mic permission changed:", result.state);
          setMicPermission(result.state);
        };
      })
      .catch((e: unknown) => {
        console.warn("[Neverr] permissions.query failed", e);
      });
  }, [open, minimized]);

  // Pre-warm the agent connection when the panel opens or the active tab
  // changes. CORS will likely block the response but the DNS/TCP/TLS
  // handshake to ElevenLabs is still warmed, shaving ~200-500ms off the
  // real connection later.
  useEffect(() => {
    if (!open || minimized) return;
    const agentId = activeTab.agentId;
    if (!agentId) return;
    console.log("[Neverr] pre-warming agent:", agentId);
    fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}/config`, {
      method: "GET",
      mode: "no-cors",
    }).catch(() => { /* silent */ });
  }, [open, minimized, activeTab.agentId]);

  // Hover-based prewarm: if the user hovers an industry tab, start warming
  // that agent's connection so it's ready if they click it.
  const handleTabHover = useCallback((agentId: string | undefined) => {
    if (!agentId) return;
    fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}/config`, {
      method: "GET",
      mode: "no-cors",
    }).catch(() => { /* silent */ });
  }, []);

  // Pre-request the microphone as soon as the widget opens. Once granted,
  // we hold the stream so startCall can skip the getUserMedia round-trip.
  useEffect(() => {
    if (!open || minimized) return;
    if (micStreamRef.current) return; // already have it
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        micStreamRef.current = stream;
        setMicReady(true);
        console.log("[Neverr] mic pre-authorized");
      })
      .catch((err) => {
        console.warn("[Neverr] mic pre-auth failed", err);
        setMicReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, minimized]);

  // Release the pre-authorized mic stream when the widget fully closes.
  useEffect(() => {
    if (open && !minimized) return;
    const stream = micStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setMicReady(false);
      console.log("[Neverr] released pre-auth mic stream");
    }
  }, [open, minimized]);

  const startCall = useCallback(async () => {
    setCallError(null);

    // SOURCE OF TRUTH: read agent ID from the synchronously-updated ref, NOT
    // from the closed-over state. This makes it physically impossible to
    // start a call against the previous tab's agent.
    const currentAgentId = activeAgentIdRef.current;
    const tabFromState = TABS.find((t) => t.id === activeTab.id);
    console.log("[Neverr] === startCall ===");
    console.log("[Neverr] activeTab.id (state):", activeTab.id);
    console.log("[Neverr] agentId (REF — used for call):", currentAgentId);
    console.log("[Neverr] agentId (from state):", tabFromState?.agentId);
    console.log("[Neverr] match:", currentAgentId === tabFromState?.agentId);

    if (!currentAgentId) {
      setCallError("No agent configured for this demo.");
      setCallStatus("error");
      return;
    }

    // Belt-and-suspenders: ensure no stale convo lingers if we somehow got
    // here without a clean idle state.
    if (conversationRef.current) {
      console.warn("[Neverr] startCall found a lingering convo — ending it");
      try { await conversationRef.current.endSession(); } catch { /* noop */ }
      conversationRef.current = null;
    }

    // Skip the getUserMedia round-trip if we already pre-authorized the mic
    // when the widget opened. Saves ~300-1000ms off connect time.
    if (micStreamRef.current) {
      console.log("[Neverr] using pre-authorized mic stream");
      try {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
      } catch { /* noop */ }
      micStreamRef.current = null;
      setCallStatus("connecting");
      // Skip ahead to the connection callbacks below.
    } else {
    setCallStatus("permission");
    console.log("[Neverr] requesting mic permission…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Neverr] mic granted; tracks:", stream.getAudioTracks().length);
      // Release immediately — the SDK will request its own stream
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      console.error("[Neverr] mic getUserMedia failed", err);
      const name = err instanceof Error ? err.name : "Error";
      const msg =
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access denied. Please allow microphone access in your browser settings and refresh the page."
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
    } // end else (no pre-authorized mic)

    const callbacks = {
      onConnect: () => {
        const t = new Date().toISOString();
        console.log("[Neverr] Connected at:", t);
        console.log("[Neverr] connected agent:", currentAgentId);
        setCallStatus("connected");
        activatedAtRef.current = Date.now();
        startAmbient();
      },
      onDisconnect: (details?: unknown) => {
        const t = new Date().toISOString();
        const sinceConnect = activatedAtRef.current
          ? `${Date.now() - activatedAtRef.current}ms`
          : "n/a";
        console.log("[Neverr] Disconnected at:", t, "(time since connect:", sinceConnect, ")");
        try {
          console.log("[Neverr] Disconnect details (raw):", details);
          console.log("[Neverr] Disconnect details (json):", JSON.stringify(details));
        } catch (e) {
          console.log("[Neverr] Disconnect details could not be stringified:", e);
        }
        const d = (details ?? {}) as Record<string, unknown>;
        console.log("[Neverr] Disconnect reason:", d.reason);
        console.log("[Neverr] Disconnect code:", d.code);
        console.log("[Neverr] Disconnect message:", d.message);
        console.log("[Neverr] Disconnect context:", d.context);
        setCallStatus("idle");
        setIsAgentSpeaking(false);
        activatedAtRef.current = null;
        conversationRef.current = null;
        stopAmbient();
      },
      onError: (msg: string, ctx?: unknown) => {
        console.error("[Neverr] Error:", msg);
        console.error("[Neverr] Error type:", typeof msg);
        try {
          console.error("[Neverr] Error string:", JSON.stringify(msg));
          console.error("[Neverr] Error ctx:", JSON.stringify(ctx));
        } catch {
          console.error("[Neverr] Error ctx (raw):", ctx);
        }
        setCallError(msg || "Connection lost. Please try again.");
        setCallStatus("error");
      },
      onModeChange: ({ mode }: { mode: "speaking" | "listening" }) => {
        console.log("[Neverr] Mode changed to:", mode);
        setIsAgentSpeaking(mode === "speaking");
      },
    } as const;

    console.log("[Neverr] starting session (websocket) with agent:", currentAgentId);
    try {
      const convo = await Conversation.startSession({
        agentId: currentAgentId,
        connectionType: "websocket",
        ...callbacks,
      });
      conversationRef.current = convo;
      console.log("[Neverr] session started:", convo.getId(), "agent:", currentAgentId);
    } catch (err) {
      console.error("[Neverr] startSession failed", err);
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : typeof err === "string"
          ? err
          : "Could not start the call. Please check your network and try again.";
      setCallError(msg);
      setCallStatus("error");
    }
  }, [activeTab.agentId]);

  const endCall = useCallback(async () => {
    const convo = conversationRef.current;
    if (convo) {
      try {
        await convo.endSession();
      } catch (err) {
        console.error("[Neverr] endSession failed", err);
      }
    }
    conversationRef.current = null;
    setIsAgentSpeaking(false);
    setCallStatus("idle");
    activatedAtRef.current = null;
    stopAmbient();
  }, [stopAmbient]);

  // End the call when the panel closes / minimizes
  useEffect(() => {
    if ((!open || minimized) && conversationActive) {
      void endCall();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, minimized]);

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

  // Auto-dismiss feedback popup after 30s
  useEffect(() => {
    if (!feedbackOpen) return;
    const t = setTimeout(() => {
      setFeedbackOpen(false);
      setRating(null);
    }, 30000);
    return () => clearTimeout(t);
  }, [feedbackOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TABS;
    return TABS.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.businessName.toLowerCase().includes(q)
    );
  }, [query]);

  async function performTabSwitch(tab: DemoTab) {
    console.log("[Neverr] === tab switch ===");
    console.log("[Neverr] from:", activeTab.id, "→ to:", tab.id);
    console.log("[Neverr] new agentId:", tab.agentId);
    console.log("[Neverr] conversation active:", conversationActive);

    // STEP 1: update the agent-id ref SYNCHRONOUSLY before any await. Even if
    // the user clicks Start the very next millisecond, startCall will read
    // the new agent ID — not the old one.
    activeAgentIdRef.current = tab.agentId;
    console.log("[Neverr] activeAgentIdRef updated to:", activeAgentIdRef.current);

    // STEP 2: kill any active session (await endSession so the LiveKit room is
    // torn down server-side before any new session can be launched).
    if (conversationActive || conversationRef.current) {
      await endCall();
      await new Promise((r) => setTimeout(r, 250));
    }

    // STEP 3: swap UI state. The conversation block is keyed on activeTab.id,
    // so this also forces React to unmount + remount that subtree, guaranteeing
    // no stale callbacks or DOM state can survive the switch.
    setActiveTab(tab);
    setCallError(null);
    setIsAgentSpeaking(false);
  }

  function requestTabSwitch(tab: DemoTab) {
    if (tab.id === activeTab.id) return;
    // Ask before clobbering an actively-running conversation (>5s in)
    const activeDuration = activatedAtRef.current ? Date.now() - activatedAtRef.current : 0;
    if (conversationActive && activeDuration > 5000) {
      setPendingSwitch(tab);
      return;
    }
    void performTabSwitch(tab);
  }

  function confirmSwitch() {
    if (pendingSwitch) {
      const target = pendingSwitch;
      setPendingSwitch(null);
      void performTabSwitch(target);
    }
  }

  function dismissFeedback() {
    setFeedbackOpen(false);
    setRating(null);
  }

  return (
    <>
      <style>{`
        @keyframes neverr-pulse-ring {
          0% { transform: scale(1); opacity: 0.6; }
          80%, 100% { transform: scale(1.6); opacity: 0; }
        }
        @keyframes neverr-blob {
          0%, 100% { transform: scale(1) rotate(0deg); border-radius: 50%; }
          33% { transform: scale(1.05) rotate(120deg); border-radius: 45% 55% 50% 50%; }
          66% { transform: scale(0.97) rotate(240deg); border-radius: 55% 45% 50% 50%; }
        }
        @keyframes neverr-fadein {
          from { opacity: 0; transform: translateY(12px) scale(0.96); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes neverr-wave {
          0%   { height: 6px; }
          100% { height: 56px; }
        }
        @keyframes neverr-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40%           { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes neverr-progress {
          0%   { width: 0%; }
          30%  { width: 40%; }
          60%  { width: 70%; }
          85%  { width: 88%; }
          100% { width: 92%; }
        }
        .neverr-pulse-ring { animation: neverr-pulse-ring 2s cubic-bezier(0,0,0.2,1) infinite; }
        .neverr-blob { animation: neverr-blob 6s ease-in-out infinite; }
        .neverr-card { animation: neverr-fadein 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
      `}</style>

      {/* Floating launcher */}
      {!open && (
        <button
          onClick={() => { setOpen(true); setMinimized(false); }}
          aria-label="Open Neverr voice assistant"
          className="fixed bottom-5 right-5 group flex items-center gap-3"
          style={{ zIndex: Z_MAX }}
        >
          <span className="hidden sm:inline-block bg-white/95 backdrop-blur px-3 py-1.5 rounded-full text-xs font-semibold text-[#1B2537] shadow-lg border border-gray-200">
            Try Live Demo
          </span>
          <span className="relative">
            <span className="absolute inset-0 rounded-full bg-[#2E75B6] neverr-pulse-ring" />
            <span className="absolute inset-0 rounded-full bg-[#2E75B6] neverr-pulse-ring" style={{ animationDelay: "1s" }} />
            <span className="relative flex items-center justify-center w-16 h-16 rounded-full bg-[#1B2537] text-white shadow-2xl shadow-[#1B2537]/40 ring-4 ring-white/80 group-hover:scale-105 transition-transform">
              <Mic className="w-7 h-7" />
            </span>
            <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 rounded-full bg-emerald-500 ring-2 ring-white">
              <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
            </span>
          </span>
        </button>
      )}

      {/* Minimized header-only bar */}
      {open && minimized && (
        <div
          className="fixed bottom-5 right-5 left-5 sm:left-auto"
          style={{ zIndex: Z_MAX }}
        >
          <div className="w-full sm:w-[380px] mx-auto bg-[#1B2537] text-white rounded-xl shadow-2xl flex items-center px-3 h-11 gap-2">
            <button
              onClick={() => setMinimized(false)}
              className="flex items-center gap-2 flex-1 text-left hover:opacity-90"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <Mic className="w-4 h-4 shrink-0" />
              <span className="text-sm font-semibold truncate">Neverr AI Demo — {activeTab.shortLabel}</span>
            </button>
            <button
              onClick={() => setMinimized(false)}
              aria-label="Expand"
              className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center shrink-0"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
            <button
              onClick={() => { setOpen(false); setMinimized(false); }}
              aria-label="Close"
              className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Expanded card */}
      {open && !minimized && (
        <div
          className="fixed bottom-5 right-5 left-5 sm:left-auto neverr-card"
          style={{ zIndex: Z_MAX }}
        >
          <div
            className="w-full sm:w-[400px] bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden flex flex-col mx-auto"
            style={{ maxHeight: "85vh" }}
          >
            {/* Header */}
            <div className="bg-gradient-to-br from-[#1B2537] via-[#1B2537] to-[#0f1825] px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="relative w-8 h-8 rounded-lg bg-gradient-to-br from-[#2E75B6] to-[#1B2537] flex items-center justify-center shrink-0">
                  <Mic className="w-4 h-4 text-white" />
                </div>
                <div className="min-w-0">
                  <p className="text-white font-bold text-sm leading-tight truncate">Neverr AI</p>
                  <p className="text-gray-300 text-[10px] leading-tight truncate flex items-center gap-1">
                    {callStatus === "connected" ? (
                      <>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                        <span className="font-semibold text-white">Live:</span>
                      </>
                    ) : callStatus === "connecting" ? (
                      <>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
                        <span>Connecting:</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-400" />
                        <span>Ready:</span>
                      </>
                    )}
                    <span className="truncate">
                      {activeTab.id === "nova" ? "Nova" : activeTab.businessName}
                    </span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setMinimized(true)}
                  aria-label="Minimize"
                  title="Minimize"
                  className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setOpen(false); setFeedbackOpen(false); }}
                  aria-label="Close"
                  title="Close"
                  className="w-8 h-8 rounded-lg hover:bg-white/10 flex items-center justify-center text-white/80 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto">
              {/* Demo selector */}
              <div className="bg-[#F8FAFC] px-3 py-3 border-b border-gray-200">
                <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Choose a demo
                </p>
                <div className="relative mb-2.5">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search industries..."
                    className="w-full pl-8 pr-2.5 py-1.5 text-xs border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-[#2E75B6] focus:ring-1 focus:ring-[#2E75B6]/20"
                  />
                </div>
                {filtered.length === 0 ? (
                  <p className="text-center text-[11px] text-gray-400 py-3">No demos match "{query}"</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 mb-2.5">
                    {filtered.map((t) => {
                      const active = t.id === activeTab.id;
                      return (
                        <button
                          key={t.id}
                          onClick={() => requestTabSwitch(t)}
                          onMouseEnter={() => handleTabHover(t.agentId)}
                          onFocus={() => handleTabHover(t.agentId)}
                          className={`inline-flex items-center gap-1 px-2.5 h-7 rounded-full text-[11px] font-semibold transition-all ${
                            active
                              ? "bg-[#1B2537] text-white shadow-sm"
                              : "bg-white text-gray-700 border border-gray-200 hover:border-[#2E75B6]/50 hover:text-[#1B2537]"
                          }`}
                        >
                          <span>{t.emoji}</span>
                          <span>{t.shortLabel}</span>
                          {t.sample && !active && (
                            <span className="text-[9px] text-gray-400 ml-0.5">(demo)</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div
                  className="flex items-start gap-2 bg-white rounded-lg px-3 py-2 border-l-4 shadow-sm"
                  style={{ borderLeftColor: activeTab.accent }}
                >
                  <span className="text-lg leading-none mt-0.5">{activeTab.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-[#1B2537] leading-tight truncate">
                      {activeTab.businessName}
                    </p>
                    <p className="text-[11px] text-gray-500 leading-snug">{activeTab.tagline}</p>
                  </div>
                </div>
              </div>

              {/* Conversation subtree — keyed on activeTab.id so React fully
                   unmounts and remounts everything (avatar, status, start
                   button, connecting block, live block, error block) when
                   the user switches industries. NUCLEAR isolation: no stale
                   ElevenLabs callback or DOM state can survive a tab switch. */}
              <div key={`conv-${activeTab.id}`}>
              {/* Avatar + widget */}
              <div className="px-4 pt-4 pb-2 flex flex-col items-center text-center bg-white">
                <div className="relative w-16 h-16 mb-2">
                  <span className="absolute inset-0 rounded-full bg-gradient-to-br from-[#2E75B6] via-[#3b82f6] to-[#1B2537] neverr-blob shadow-lg shadow-[#2E75B6]/30" />
                  <span className="absolute inset-2 rounded-full bg-gradient-to-br from-white/30 to-transparent" />
                  <span className="absolute inset-0 flex items-center justify-center text-white text-xl">
                    {activeTab.emoji}
                  </span>
                </div>
                <p className="text-sm font-bold text-[#1B2537]">
                  {activeTab.id === "nova" ? "Nova — Neverr AI" : `${activeTab.businessName} AI`}
                </p>
              </div>

              {/* Headless ElevenLabs — 100% custom UI. No third-party DOM rendered. */}
              <div className="px-4 pb-4">
                {callStatus === "idle" && (
                  <>
                    <div className="mb-3">
                      <p className="text-[11px] font-semibold text-[#1B2537] mb-2">Try saying:</p>
                      <ul className="space-y-1.5">
                        {activeTab.questions.map((q) => (
                          <li
                            key={q}
                            className="flex items-start gap-1.5 text-[12px] text-gray-700 leading-snug bg-[#2E75B6]/5 border border-[#2E75B6]/15 rounded-md px-2.5 py-1.5"
                          >
                            <span className="text-[#2E75B6] font-bold leading-tight">"</span>
                            <span className="flex-1">{q}</span>
                            <span className="text-[#2E75B6] font-bold leading-tight">"</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {micPermission === "denied" ? (
                      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-left">
                        <div className="flex items-start gap-2 mb-1.5">
                          <MicOff className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                          <p className="text-[11px] font-semibold text-red-800 leading-snug">
                            Microphone access blocked. Please allow microphone access in your browser settings and refresh the page.
                          </p>
                        </div>
                        <a
                          href="https://support.google.com/chrome/answer/2693767"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] font-semibold text-red-700 hover:text-red-900 underline"
                        >
                          How to enable microphone →
                        </a>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={startCall}
                          className="w-full bg-[#2E75B6] hover:bg-[#2563a0] text-white font-semibold rounded-full py-3 px-4 flex items-center justify-center gap-2 shadow-lg shadow-[#2E75B6]/30 transition-colors"
                        >
                          <Mic className="w-5 h-5" />
                          Start Conversation
                        </button>
                        <p className="text-[10px] text-gray-500 text-center mt-2 leading-snug">
                          Your browser will ask for microphone access.
                        </p>
                      </>
                    )}
                  </>
                )}

                {(callStatus === "permission" || callStatus === "connecting") && (
                  <div className="flex flex-col items-center justify-center py-5 text-center">
                    <div className="flex items-center gap-1.5 mb-3">
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="w-2.5 h-2.5 rounded-full bg-[#2E75B6]"
                          style={{
                            animation: "neverr-bounce 0.9s ease-in-out infinite",
                            animationDelay: `${i * 0.12}s`,
                          }}
                        />
                      ))}
                    </div>
                    <p className="text-sm font-semibold text-[#1B2537] mb-1 min-h-[20px] transition-opacity">
                      {callStatus === "permission"
                        ? "Requesting microphone…"
                        : CONNECTING_MESSAGES[connectingMsgIdx]}
                    </p>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      Connecting to {activeTab.businessName}
                    </p>
                    <div
                      className="w-full max-w-[260px] h-1 rounded-full bg-gray-200 overflow-hidden mt-3 mb-1.5"
                      role="progressbar"
                      aria-label="Connecting"
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          background: "linear-gradient(90deg, #2E75B6, #60A5FA)",
                          animation: "neverr-progress 10s ease-in-out forwards",
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      This takes about 10 seconds on first connect.
                    </p>
                    <p className="text-[11px] text-gray-500 mt-3 min-h-[16px] transition-opacity">
                      {TIPS[tipIdx]}
                    </p>
                  </div>
                )}

                {callStatus === "connected" && (
                  <>
                    {/* BUG-20: load-bearing UX moment. Pre-fix the listening
                        state was a 14px gray "Listening to you" line — users
                        didn't know to start talking. Now: prominent emerald
                        banner with double-pulse Mic icon when listening,
                        solid blue banner with Volume2 icon when speaking. */}
                    {!isAgentSpeaking ? (
                      <div className="relative mb-3 rounded-xl border-2 border-emerald-400 bg-emerald-50 px-4 py-3 flex items-center gap-3 overflow-hidden">
                        <span className="absolute inset-0 rounded-xl bg-emerald-300/20 animate-pulse" aria-hidden />
                        <span className="relative flex items-center justify-center w-11 h-11 rounded-full bg-emerald-500 text-white shrink-0 shadow-md shadow-emerald-500/40">
                          <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-70" aria-hidden />
                          <Mic className="relative w-5 h-5" />
                        </span>
                        <div className="relative min-w-0 flex-1">
                          <p className="text-[14px] font-bold text-emerald-900 leading-tight">Listening — say something</p>
                          <p className="text-[11px] text-emerald-700 leading-snug mt-0.5">The agent is waiting for you to speak.</p>
                        </div>
                      </div>
                    ) : (
                      <div className="mb-3 rounded-xl border-2 border-[#2E75B6] bg-[#2E75B6]/10 px-4 py-3 flex items-center gap-3">
                        <span className="flex items-center justify-center w-11 h-11 rounded-full bg-[#2E75B6] text-white shrink-0 shadow-md shadow-[#2E75B6]/40">
                          <Volume2 className="w-5 h-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[14px] font-bold text-[#1B2537] leading-tight">Agent speaking…</p>
                          <p className="text-[11px] text-[#1B2537]/70 leading-snug mt-0.5 truncate">{activeTab.businessName}</p>
                        </div>
                      </div>
                    )}

                    <div className="flex items-end justify-center gap-1.5 h-16 mb-3">
                      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <span
                          key={i}
                          className="rounded-full"
                          style={{
                            width: 5,
                            background: isAgentSpeaking ? "#2E75B6" : "#10B981",
                            animation: isAgentSpeaking
                              ? `neverr-wave 0.8s ease-in-out ${i * 0.08}s infinite alternate`
                              : "none",
                            height: isAgentSpeaking ? undefined : 6,
                            transition: "height 0.2s ease, background 0.2s ease",
                          }}
                        />
                      ))}
                    </div>

                    {/* Re-show industry-specific suggested prompts during
                        listening so user has fresh ideas. Hidden when agent
                        is speaking (user is being responded to, not initiating). */}
                    {!isAgentSpeaking && (
                      <div className="mb-3 rounded-lg bg-emerald-50/60 border border-emerald-100 px-3 py-2">
                        <p className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wider mb-1.5">Try saying</p>
                        <ul className="space-y-1">
                          {activeTab.questions.map((q) => (
                            <li
                              key={q}
                              className="text-[11px] text-gray-700 leading-snug flex items-start gap-1.5"
                            >
                              <span className="text-emerald-600 font-bold">"</span>
                              <span className="flex-1">{q}</span>
                              <span className="text-emerald-600 font-bold">"</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center justify-center gap-2">
                      <button
                        type="button"
                        onClick={endCall}
                        className="flex-1 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-full py-2.5 px-4 flex items-center justify-center gap-2 transition-colors"
                      >
                        <PhoneOff className="w-4 h-4" />
                        End Call
                      </button>
                    </div>
                  </>
                )}

                {callStatus === "error" && (
                  <div className="flex flex-col items-center justify-center py-4 text-center">
                    <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center mb-2">
                      <MicOff className="w-5 h-5 text-red-600" />
                    </div>
                    <p className="text-sm font-semibold text-[#1B2537] mb-1">Couldn't start the call</p>
                    <p className="text-xs text-gray-500 mb-3 max-w-[260px]">
                      {callError ?? "Please try again."}
                    </p>
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
              </div>
              {/* /conversation subtree (key=conv-${activeTab.id}) */}
            </div>

            {/* Footer — navy Neverr bar flush with widget bottom */}
            <div className="px-3 py-2 flex items-center justify-center shrink-0 bg-[#1B2537] text-white">
              <p className="text-[10px] font-semibold tracking-wide">⚡ Powered by Neverr AI · neverr.ai</p>
            </div>
          </div>

          {/* Switch-confirmation overlay */}
          {pendingSwitch && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center rounded-2xl p-4">
              <div className="bg-white rounded-xl shadow-xl p-4 max-w-xs text-center">
                <p className="text-sm font-semibold text-[#1B2537] mb-1">
                  Switch to {pendingSwitch.shortLabel}?
                </p>
                <p className="text-xs text-gray-500 mb-4">
                  This will end your current conversation with {activeTab.businessName}. You'll need to start a new call on the {pendingSwitch.shortLabel} demo.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setPendingSwitch(null)}
                    className="flex-1 px-3 py-2 text-xs font-semibold text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                  >
                    Stay
                  </button>
                  <button
                    onClick={confirmSwitch}
                    className="flex-1 px-3 py-2 text-xs font-semibold text-white bg-[#1B2537] rounded-lg hover:bg-[#0f1825]"
                  >
                    Switch
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Feedback popup — positioned below header so close/minimize remain reachable */}
          {feedbackOpen && (
            <div className="absolute left-0 right-0 bottom-0 top-[56px] bg-black/40 flex items-end sm:items-center justify-center rounded-b-2xl p-3">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-bold text-[#1B2537]">How was that experience?</p>
                  <button
                    onClick={dismissFeedback}
                    aria-label="Close feedback"
                    className="w-7 h-7 rounded-full hover:bg-gray-100 flex items-center justify-center text-gray-500"
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
                      <p className="text-xs text-gray-500 mb-3">Start your trial and get this for your business:</p>
                    </div>
                  )}
                  {rating !== null && rating < 4 && (
                    <div className="text-center py-2">
                      <p className="text-sm font-semibold text-[#1B2537] mb-1">Thanks for the feedback.</p>
                      <p className="text-xs text-gray-500 mb-3">Our team is always improving. Try another demo:</p>
                    </div>
                  )}
                </div>
                <div className="px-4 pb-4 space-y-2">
                  <a
                    href={`/signup?utm_source=widget_feedback&utm_industry=${activeTab.id}`}
                    className="block w-full px-4 py-2.5 bg-[#2E75B6] text-white text-sm font-semibold rounded-lg hover:bg-[#2563a0] text-center flex items-center justify-center gap-1"
                  >
                    Start Free Trial <ArrowRight className="w-4 h-4" />
                  </a>
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
      )}
    </>
  );
}
