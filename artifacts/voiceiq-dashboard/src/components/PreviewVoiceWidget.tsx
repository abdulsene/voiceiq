import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Volume2, PhoneOff } from "lucide-react";
import { Conversation } from "@elevenlabs/client";

type CallStatus = "idle" | "connecting" | "connected" | "disconnecting" | "error";
type CallMode = "speaking" | "listening" | null;

// BUG-20: PreviewVoiceWidget has no industry-aware TABS like NeverrVoiceWidget,
// so we surface a generic fallback prompt list. Brief explicitly approves these
// three as defensible defaults for any receptionist-style agent: bookings,
// hours, human-handoff are universal patterns.
const SUGGESTED_PROMPTS = [
  "Hi, I'd like to book an appointment",
  "What are your hours?",
  "Can I speak to someone?",
];

// Detect microphone-permission errors from the SDK error message so we can
// show the right error copy + Try-Again button. ElevenLabs / browser surface
// these as "Permission denied", "NotAllowedError", "microphone", etc.
function isMicError(msg: string | null): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("permission") ||
    m.includes("notallowed") ||
    m.includes("not allowed") ||
    m.includes("microphone") ||
    m.includes("denied") ||
    m.includes("getusermedia")
  );
}

/**
 * Shared voice-call widget used by both the public self-serve preview
 * (/try-your-agent, Phase 3d) and the persistent sales demo page
 * (/demo/:demoBusinessId, Phase 3g). Owns its own ElevenLabs websocket
 * session lifecycle and tears it down on unmount.
 */
export default function PreviewVoiceWidget({ agentId }: { agentId: string }) {
  const [status, setStatus] = useState<CallStatus>("idle");
  const [mode, setMode] = useState<CallMode>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const conversationRef = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);

  const isActive = status === "connected" || status === "disconnecting";

  async function startCall() {
    if (isActive) return;
    setStatus("connecting");
    setErrorMsg(null);
    setMode(null);

    try {
      console.log("[Preview] starting session (websocket) with agent:", agentId);

      const conversation = await Conversation.startSession({
        agentId,
        connectionType: "websocket",
        onConnect: ({ conversationId }: { conversationId: string }) => {
          console.log("[Preview] connected:", conversationId);
          setStatus("connected");
        },
        onDisconnect: (details: any) => {
          console.log("[Preview] disconnected:", details);
          setStatus("idle");
          setMode(null);
          conversationRef.current = null;
        },
        onError: (message: string) => {
          console.error("[Preview] error:", message);
          setErrorMsg(typeof message === "string" ? message : "Connection error");
          setStatus("error");
        },
        onModeChange: (newMode: { mode: string }) => {
          console.log("[Preview] mode:", newMode.mode);
          if (newMode.mode === "speaking" || newMode.mode === "listening") {
            setMode(newMode.mode as CallMode);
          }
        },
      });

      conversationRef.current = conversation;
      console.log("[Preview] session started:", conversation.getId(), "agent:", agentId);
    } catch (err: any) {
      console.error("[Preview] startCall failed:", err);
      setErrorMsg(err?.message || "Could not start the call. Check network and microphone permissions.");
      setStatus("error");
    }
  }

  async function endCall() {
    if (!conversationRef.current) return;
    setStatus("disconnecting");
    try {
      await conversationRef.current.endSession();
    } catch (err) {
      console.warn("[Preview] endSession failed:", err);
    }
    conversationRef.current = null;
    setStatus("idle");
    setMode(null);
  }

  useEffect(() => {
    return () => {
      if (conversationRef.current) {
        try {
          conversationRef.current.endSession();
        } catch {
          /* ignore */
        }
        conversationRef.current = null;
      }
    };
  }, []);

  if (!agentId) {
    return (
      <div className="p-8 text-center text-slate-500 bg-slate-50 rounded-xl border border-slate-200">
        Agent not ready yet. Try regenerating.
      </div>
    );
  }

  const micErrorDetected = status === "error" && isMicError(errorMsg);

  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-200">
      <div className="text-center mb-4">
        <h3 className="text-base font-bold text-slate-900 mb-1">Talk to Your Agent</h3>
        <p className="text-xs text-slate-600">
          Click below to start a live voice conversation. Your browser will ask for microphone access.
        </p>
      </div>

      {/* Pre-call suggested prompts — visible in idle so user has openings to read.
          Hidden during connecting/active/error to avoid clutter. */}
      {status === "idle" && (
        <div className="mb-4 bg-white/70 backdrop-blur rounded-lg border border-blue-100 px-3 py-2.5">
          <p className="text-[11px] font-semibold text-slate-700 mb-2">Try saying:</p>
          <ul className="space-y-1.5">
            {SUGGESTED_PROMPTS.map((q) => (
              <li
                key={q}
                className="flex items-start gap-1.5 text-xs text-slate-700 leading-snug"
              >
                <span className="text-blue-600 font-bold">"</span>
                <span className="flex-1">{q}</span>
                <span className="text-blue-600 font-bold">"</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex justify-center py-4">
        <div className="relative w-32 h-32">
          <div
            className={
              "absolute inset-0 rounded-full " +
              (status === "connected" && mode === "speaking"
                ? "bg-blue-400 animate-ping opacity-30"
                : status === "connected" && mode === "listening"
                ? "bg-emerald-400 animate-ping opacity-50"
                : status === "connecting"
                ? "bg-amber-400 animate-pulse opacity-30"
                : "bg-slate-300 opacity-20")
            }
          />
          <div
            className={
              "absolute inset-2 rounded-full flex items-center justify-center transition-colors " +
              (status === "connected" && mode === "speaking"
                ? "bg-gradient-to-br from-blue-500 to-indigo-600"
                : status === "connected" && mode === "listening"
                ? "bg-gradient-to-br from-emerald-500 to-teal-600"
                : status === "connecting"
                ? "bg-gradient-to-br from-amber-400 to-orange-500"
                : status === "error"
                ? "bg-gradient-to-br from-red-500 to-pink-600"
                : "bg-gradient-to-br from-slate-400 to-slate-600")
            }
          >
            {status === "connected" && mode === "speaking" ? (
              <Volume2 className="w-12 h-12 text-white" />
            ) : status === "error" ? (
              <MicOff className="w-12 h-12 text-white" />
            ) : (
              <Mic className="w-12 h-12 text-white" />
            )}
          </div>
        </div>
      </div>

      {/* BUG-20: prominent status banner replaces the tiny gray status text.
          Listening = emerald, large heading. Speaking = blue, large heading.
          Idle/connecting/error = simpler centered text. */}
      {status === "connected" && mode === "listening" && (
        <div className="mb-4 rounded-xl border-2 border-emerald-400 bg-emerald-50 px-4 py-3 flex items-center gap-3">
          <span className="relative flex items-center justify-center w-10 h-10 rounded-full bg-emerald-500 text-white shrink-0 shadow-md shadow-emerald-500/40">
            <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-70" aria-hidden />
            <Mic className="relative w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-emerald-900 leading-tight">Listening — say something</p>
            <p className="text-xs text-emerald-700 leading-snug mt-0.5">The agent is waiting for you to speak.</p>
          </div>
        </div>
      )}
      {status === "connected" && mode === "speaking" && (
        <div className="mb-4 rounded-xl border-2 border-blue-400 bg-blue-50 px-4 py-3 flex items-center gap-3">
          <span className="flex items-center justify-center w-10 h-10 rounded-full bg-blue-500 text-white shrink-0 shadow-md shadow-blue-500/40">
            <Volume2 className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-blue-900 leading-tight">Agent speaking…</p>
            <p className="text-xs text-blue-700 leading-snug mt-0.5">Listen for the response.</p>
          </div>
        </div>
      )}

      {/* Re-show prompts while listening so user has fresh ideas to try. */}
      {status === "connected" && mode === "listening" && (
        <div className="mb-4 rounded-lg bg-emerald-50/60 border border-emerald-100 px-3 py-2">
          <p className="text-[10px] font-semibold text-emerald-800 uppercase tracking-wider mb-1.5">Try saying</p>
          <ul className="space-y-1">
            {SUGGESTED_PROMPTS.map((q) => (
              <li
                key={q}
                className="text-[11px] text-slate-700 leading-snug flex items-start gap-1.5"
              >
                <span className="text-emerald-600 font-bold">"</span>
                <span className="flex-1">{q}</span>
                <span className="text-emerald-600 font-bold">"</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="text-center mb-4 h-5">
        {status === "idle" && <span className="text-xs text-slate-500">Ready to talk</span>}
        {status === "connecting" && <span className="text-xs text-amber-700 font-medium">Connecting...</span>}
        {status === "connected" && !mode && <span className="text-xs text-slate-600">Connected</span>}
        {status === "disconnecting" && <span className="text-xs text-slate-500">Ending call...</span>}
        {status === "error" && <span className="text-xs text-red-700 font-medium">Call failed</span>}
      </div>

      <div className="flex justify-center">
        {!isActive ? (
          <button
            onClick={startCall}
            disabled={status === "connecting"}
            className="px-8 py-3 bg-blue-600 text-white rounded-full font-semibold hover:bg-blue-700 transition-all shadow-md disabled:opacity-50 flex items-center gap-2"
          >
            <Mic className="w-4 h-4" />
            {status === "connecting" ? "Connecting..." : "Start Call"}
          </button>
        ) : (
          <button
            onClick={endCall}
            className="px-8 py-3 bg-red-600 text-white rounded-full font-semibold hover:bg-red-700 transition-all shadow-md flex items-center gap-2"
          >
            <PhoneOff className="w-4 h-4" />
            End Call
          </button>
        )}
      </div>

      {/* BUG-20: improved error copy + Try Again button. Mic-permission failures
          get specific guidance; other errors get generic + retry. */}
      {status === "error" && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-2 mb-2">
            <MicOff className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            <p className="text-xs text-red-800 font-medium leading-snug">
              {micErrorDetected
                ? "We couldn't access your microphone. To use the voice demo, allow microphone access in your browser settings."
                : "Something went wrong connecting."}
            </p>
          </div>
          <div className="flex justify-center mt-2">
            <button
              onClick={startCall}
              className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-full transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
