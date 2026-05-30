// ===========================================================================
// ChatWidget — Sprint 5 Alex Phase 2 + Sunday Voice Mode (Shape A + B).
//
// What this is:
//   Floating "Chat with Alex" button bottom-right of every public marketing
//   page. Click → 400×600 panel (or fullscreen on mobile) with a thread
//   view + composer. Conversation persists across page reloads via
//   localStorage; visitor identity persists across sessions via the
//   HttpOnly `neverr_visitor_id` cookie set by POST /api/chat/conversation.
//
// Sunday additions (Voice Mode):
//   Shape A — Push-to-talk: mic button next to Send. Click toggles Web
//     Speech recognition; final transcript fills the textarea so the user
//     can review/edit before hitting Send. Always visible when the
//     browser supports SpeechRecognition; hidden otherwise.
//
//   Shape B — Voice conversation: header toggle flips speechMode from
//     'text' to 'voice'. Composer is replaced by a large circular
//     indicator driven by a state machine:
//
//                    ┌──────────┐
//                    │   IDLE   │◀───────── (initial / explicit stop)
//                    └────┬─────┘
//                         │ click / auto-start
//                         ▼
//        ┌───────► ┌──────────────┐
//        │         │  LISTENING   │ Web Speech transcribing
//        │         └──────┬───────┘
//        │                │ final transcript
//        │                ▼
//        │         ┌──────────────┐
//        │         │   THINKING   │ POST /chat/.../message
//        │         └──────┬───────┘
//        │                │ Alex reply
//        │                ▼
//        │         ┌──────────────┐
//        │         │   SPEAKING   │ HTMLAudio playing /api/chat/tts
//        │         └──────┬───────┘
//        │  audio onended │  (or user click to interrupt)
//        └────────────────┘
//
// What this is NOT (yet):
//   - Server-side STT (we use the browser's free Web Speech API; iOS
//     Safari has limited support → graceful degradation to text-only).
//   - Tool-using Alex (responses are pure text; TTS reads them verbatim).
//   - Voice activity detection / interruption-while-speaking — clicking
//     the mic during SPEAKING DOES cancel playback and start listening,
//     but we don't auto-listen for "stop" keywords.
//
// Design notes (existing — preserved verbatim):
//   - One instance mounted at the App level inside <WouterRouter> so state
//     survives client-side navigations.
//   - localStorage key `neverr_chat_conversation_id` is the single source
//     of truth for "which conversation am I resuming?".
//   - Every fetch uses `credentials: "include"`.
//   - Errors categorise into offline / transient / stale-conv-id.
//   - z-index: z-50 keeps us above content but below NeverrVoiceWidget.
// ===========================================================================
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "wouter";
// 2026-05-03 Calendly swap: single source of truth for the
// discovery-call CTA URL. See src/lib/cta.ts for the resolution rules.
import { getDiscoveryCallUrl } from "../lib/cta";
import {
  MessageCircle,
  X,
  Send,
  RotateCw,
  Sparkles,
  Loader2,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Headphones,
} from "lucide-react";

const STORAGE_KEY = "neverr_chat_conversation_id";

// ---------------------------------------------------------------------------
// Hide rules. Two buckets:
//   - HIDE_EXACT  : exact path match (auth/contact forms)
//   - HIDE_PREFIX : path === p || path.startsWith(p + "/")
// ---------------------------------------------------------------------------
const HIDE_EXACT = new Set<string>(["/signup", "/login", "/contact"]);
const HIDE_PREFIX: string[] = [
  "/dashboard",
  "/calls",
  "/contacts",
  "/appointments",
  "/sms",
  "/analytics",
  "/benchmarks",
  "/admin",
  "/settings",
  "/mfa-setup",
  "/mfa-verify",
];
function isHiddenPath(path: string): boolean {
  if (HIDE_EXACT.has(path)) return true;
  return HIDE_PREFIX.some((p) => path === p || path.startsWith(p + "/"));
}

// ---------------------------------------------------------------------------
// 2026-05-05 visual hierarchy fix:
//   The collapsed launcher sits at `bottom-28 right-6` (was `bottom-24`)
//   to give clear vertical separation from NeverrVoiceWidget's mic button
//   on routes where both render bottom-right. The full "Chat with Alex"
//   label is preserved on every route — the spacing alone is enough to
//   break the previous cluster, and stripping the label was found to make
//   the chat affordance too anonymous.
//
//   Architectural reference — routes where NeverrVoiceWidget ALSO renders
//   bottom-right (verified 2026-05-05 via `rg -l "NeverrVoiceWidget"
//   src/pages`):
//     - src/pages/Landing.tsx  → "/"
//     - src/pages/Demo.tsx     → "/demo"
//   /demos, /try-your-agent, and /demo/:demoBusinessId do NOT mount it.
//   If route-aware variants are ever needed again, this is the set to
//   gate on.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// API types — match the JSON shapes returned by api-server/src/routes/chat.ts
// ---------------------------------------------------------------------------
type Role = "user" | "assistant" | "system";
type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  created_at?: string;
};
type ApiInitResponse = {
  conversation_id: string;
  visitor_id: string;
  initial_message: string;
};
type ApiSendResponse = {
  message: ChatMessage;
  conversation: {
    id: string;
    industry?: string | null;
    cta_signaled?: boolean;
  };
};
type ApiHistoryResponse = {
  conversation: {
    id: string;
    industry?: string | null;
    cta_signaled?: boolean;
  };
  messages: ChatMessage[];
};

// ---------------------------------------------------------------------------
// Web Speech API minimal type surface (lib.dom.d.ts ships these on most
// targets but @types/web behind Vite is conservative; declare locally so
// we don't have to ship a tsconfig change).
// ---------------------------------------------------------------------------
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionErrorEventLike = {
  error: string;
  message?: string;
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((e: Event) => void) | null;
  onstart: ((e: Event) => void) | null;
};
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

// ---------------------------------------------------------------------------
// Tiny fetch wrapper. ALWAYS sends cookies; ALWAYS sends JSON content-type
// for the bodies we send. Returns the raw Response so callers can branch on
// status code (we need 503 / 404 / 5xx differentiation).
// ---------------------------------------------------------------------------
async function chatFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    ...init,
  });
}

// Synthetic message id so optimistic-render rows can be replaced with the
// server-canonical row when the POST resolves.
function tempId(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type SpeechMode = "text" | "voice";
type VoiceState = "idle" | "listening" | "thinking" | "speaking";

export default function ChatWidget() {
  const [location] = useLocation();
  const hidden = isHiddenPath(location);

  // open === panel expanded.
  // bootstrapped === we've successfully loaded or created a conversation.
  const [open, setOpen] = useState(false);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [sending, setSending] = useState(false);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");

  // Error UX:
  //   error   = transient banner shown above composer
  //   offline = persistent "Alex is offline" state (503 from backend)
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  // ---- Voice mode state ---------------------------------------------------
  // speechMode: 'text' is the existing widget; 'voice' replaces composer
  //   with the circular indicator and runs the LISTENING→THINKING→
  //   SPEAKING→LISTENING loop.
  // voiceState: drives the indicator's visual + ARIA state.
  // micActive (Shape A): true while push-to-talk recognition is running
  //   in TEXT mode (transcript flows into the textarea).
  // voiceSupported: cached browser-capability check.
  // micPermissionDenied: shown after a NotAllowedError from start().
  // ttsAvailable: false after we observe a 502/503 from /api/chat/tts so
  //   we stop trying and fall back to text-only mid-conversation.
  // ---------------------------------------------------------------------------
  const [speechMode, setSpeechMode] = useState<SpeechMode>("text");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [micActive, setMicActive] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [micPermissionDenied, setMicPermissionDenied] = useState(false);
  const [ttsAvailable, setTtsAvailable] = useState(true);

  const voiceSupported = useMemo(() => getSpeechRecognitionCtor() !== null, []);

  // Refs for objects that don't drive rendering.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  // Holds the resolver of the in-flight speakText() promise so that any
  // out-of-band stop (mode toggle, widget close, user-interrupt click)
  // can resolve(false) and unblock the sendMessage() finally — otherwise
  // `sending` latches true and locks every subsequent send (architect
  // CRITICAL #1).
  // Resolver type widened to "ok" | "rate_limited" | "fail" so an
  // out-of-band stop (mode toggle, widget close, user-interrupt click)
  // can resolve with "fail" and the caller's status-enum branching
  // still type-checks. 2026-05-03 TTS rate limiting.
  const activeSpeakResolveRef = useRef<
    ((result: "ok" | "rate_limited" | "fail") => void) | null
  >(null);
  // mode tracking (read inside async handlers without re-triggering effects)
  const speechModeRef = useRef<SpeechMode>("text");
  useEffect(() => {
    speechModeRef.current = speechMode;
  }, [speechMode]);
  // open tracking — used by setTimeout restart guards to avoid waking up
  // listening after the user closed the widget (architect MEDIUM #3).
  const openRef = useRef<boolean>(false);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // -------------------------------------------------------------------------
  // bootstrap(): the "what conversation am I in?" decision tree.
  // (Logic unchanged from Phase 2 — preserved verbatim.)
  // -------------------------------------------------------------------------
  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    setError(null);
    setOffline(false);

    const stored =
      typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;

    try {
      if (stored) {
        const res = await chatFetch(`/api/chat/conversation/${stored}`);
        if (res.ok) {
          const data: ApiHistoryResponse = await res.json();
          setConversationId(data.conversation.id);
          setMessages(data.messages || []);
          setBootstrapped(true);
          return;
        }
        if (res.status === 404 || res.status === 403) {
          localStorage.removeItem(STORAGE_KEY);
        } else if (res.status === 503) {
          setOffline(true);
          return;
        } else {
          throw new Error(`GET history HTTP ${res.status}`);
        }
      }

      const res2 = await chatFetch("/api/chat/conversation", {
        method: "POST",
        body: "{}",
      });
      if (res2.status === 503) {
        setOffline(true);
        return;
      }
      if (!res2.ok) throw new Error(`POST conversation HTTP ${res2.status}`);
      const init: ApiInitResponse = await res2.json();
      localStorage.setItem(STORAGE_KEY, init.conversation_id);
      setConversationId(init.conversation_id);
      setMessages([
        {
          id: "alex_initial_greeting",
          role: "assistant",
          content: init.initial_message,
        },
      ]);
      setBootstrapped(true);
    } catch (err: any) {
      console.error("[ChatWidget] bootstrap failed:", err?.message || err);
      setError("Alex hit a snag — try again");
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    if (open && !bootstrapped && !bootstrapping) {
      void bootstrap();
    }
  }, [open, bootstrapped, bootstrapping, bootstrap]);

  // Auto-scroll the message list to bottom on every new message OR when the
  // panel opens.
  useLayoutEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, messages, sending]);

  // Esc key collapses the panel.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  // Focus the input when panel opens AND bootstrap is complete (text mode only).
  useEffect(() => {
    if (open && bootstrapped && speechMode === "text" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open, bootstrapped, speechMode]);

  // -------------------------------------------------------------------------
  // Audio playback helpers. We keep ONE HTMLAudioElement across renders
  // and revoke each ObjectURL when its clip ends or a new one starts.
  // -------------------------------------------------------------------------
  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch {
        /* ignore */
      }
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    // Resolve any pending speakText() promise so its caller's finally
    // runs and `sending` clears. Without this, a user who interrupts
    // SPEAKING (or switches modes mid-playback) would deadlock the
    // widget with sending=true forever — architect CRITICAL #1.
    const pending = activeSpeakResolveRef.current;
    if (pending) {
      activeSpeakResolveRef.current = null;
      pending("fail");
    }
  }, []);

  // Returns a status enum so the caller can distinguish:
  //   "ok"           — playback completed normally
  //   "rate_limited" — server returned 429 (per-visitor TTS budget hit).
  //                    TRANSIENT — do NOT flip ttsAvailable=false; the
  //                    user can keep going after the window resets.
  //   "fail"         — any other failure (network, 5xx, audio error).
  //                    Permanent for this session if 502/503: ttsAvailable
  //                    flips false so we stop hammering the endpoint.
  //
  // 2026-05-03 TTS rate limiting: the 429 branch is the new transient
  // case, distinct from "voice is offline" (502/503) and from a fetch
  // throw. The voice-mode tail uses this to skip the auto-listen-after-
  // speak loop without permanently disabling voice mode.
  type SpeakResult = "ok" | "rate_limited" | "fail";
  const speakText = useCallback(
    async (text: string): Promise<SpeakResult> => {
      if (!ttsAvailable) return "fail";
      if (!text || !text.trim()) return "fail";

      let res: Response;
      try {
        res = await chatFetch("/api/chat/tts", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
      } catch (err: any) {
        console.warn("[ChatWidget] TTS fetch failed:", err?.message || err);
        setTtsAvailable(false);
        return "fail";
      }
      if (!res.ok) {
        console.warn("[ChatWidget] TTS HTTP", res.status);
        if (res.status === 429) return "rate_limited";
        if (res.status === 502 || res.status === 503) setTtsAvailable(false);
        return "fail";
      }

      const blob = await res.blob();
      stopPlayback();
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;

      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      const audio = audioRef.current;
      audio.src = url;

      return new Promise<SpeakResult>((resolve) => {
        // Register this resolver so stopPlayback() can unblock us on
        // out-of-band interrupt (CRITICAL #1).
        activeSpeakResolveRef.current = resolve;
        const cleanup = () => {
          audio.onended = null;
          audio.onerror = null;
        };
        const finish = (result: SpeakResult) => {
          cleanup();
          if (audioUrlRef.current === url) {
            URL.revokeObjectURL(url);
            audioUrlRef.current = null;
          }
          if (activeSpeakResolveRef.current === resolve) {
            activeSpeakResolveRef.current = null;
          }
          resolve(result);
        };
        audio.onended = () => finish("ok");
        audio.onerror = () => finish("fail");
        void audio.play().catch(() => finish("fail"));
      });
    },
    [stopPlayback, ttsAvailable],
  );

  // -------------------------------------------------------------------------
  // sendMessage(): backend round-trip. Used by both:
  //   - submit handler (text mode, content from `input` state)
  //   - voice handler (content from final SpeechRecognition transcript)
  //
  // Voice-mode tail: after Alex replies, hand off to TTS playback then
  // restart listening. If anything fails the loop falls back to IDLE so
  // the user can re-engage with the mic.
  // -------------------------------------------------------------------------
  const startListening = useCallback(() => {
    // forward declaration — defined below; React doesn't mind because
    // sendMessage references it via a closure that resolves at call-time
    // through this stable wrapper.
    voiceLoopStartListeningRef.current?.();
  }, []);
  const voiceLoopStartListeningRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback(
    async (rawContent: string, opts: { fromVoice?: boolean } = {}) => {
      const trimmed = rawContent.trim();
      if (!trimmed || sending || !conversationId) return;

      setError(null);
      setInterimTranscript("");

      const optimistic: ChatMessage = {
        id: tempId(),
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, optimistic]);
      setSending(true);
      if (opts.fromVoice) setVoiceState("thinking");

      try {
        const res = await chatFetch(
          `/api/chat/conversation/${conversationId}/message`,
          {
            method: "POST",
            body: JSON.stringify({ content: trimmed }),
          },
        );

        if (res.status === 404) {
          // Conv was deleted out-from-under us — clear pointer + restart.
          localStorage.removeItem(STORAGE_KEY);
          setConversationId(null);
          setBootstrapped(false);
          setMessages([]);
          await bootstrap();
          if (opts.fromVoice) setVoiceState("idle");
          return;
        }
        if (res.status === 503) {
          setOffline(true);
          setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
          if (opts.fromVoice) setVoiceState("idle");
          return;
        }
        if (!res.ok) throw new Error(`POST message HTTP ${res.status}`);

        const data: ApiSendResponse = await res.json();
        setMessages((prev) => [...prev, data.message]);

        // Voice-mode tail: speak Alex's reply, then auto-restart listening.
        // We re-check speechModeRef here because the user may have
        // toggled back to text mode while the request was in flight.
        if (opts.fromVoice && speechModeRef.current === "voice") {
          setVoiceState("speaking");
          const result = await speakText(data.message.content || "");
          if (result === "rate_limited") {
            // 2026-05-03 TTS rate limiting: server returned 429.
            // Transient — voice mode stays available but we MUST NOT
            // auto-restart listening or the loop just re-spams TTS the
            // moment the next user utterance comes in. Drop to IDLE so
            // the user has to actively re-engage by tapping the mic.
            setError(
              "Slow down — Alex needs a sec. Try again in a moment.",
            );
            setVoiceState("idle");
            return;
          }
          if (result === "fail") {
            // TTS failed — surface inline note, drop back to IDLE so the
            // user can hit the mic to retry. The text reply is already
            // visible in the thread.
            setError(
              ttsAvailable
                ? "Alex's voice hiccupped — tap the mic to keep going."
                : "Alex's voice is offline right now — read above & tap the mic to continue.",
            );
            setVoiceState("idle");
            return;
          }
          // result === "ok" — only auto-restart if still in voice mode.
          if (speechModeRef.current === "voice") {
            startListening();
          } else {
            setVoiceState("idle");
          }
        }
      } catch (err: any) {
        console.error("[ChatWidget] send failed:", err?.message || err);
        setError("Alex hit a snag — try again");
        if (opts.fromVoice) setVoiceState("idle");
      } finally {
        setSending(false);
      }
    },
    [
      sending,
      conversationId,
      bootstrap,
      speakText,
      startListening,
      ttsAvailable,
    ],
  );

  // Form submit (text mode): consume `input` state, fire-and-forget.
  const send = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || sending || !conversationId) return;
    setInput("");
    void sendMessage(trimmed);
  }, [input, sending, conversationId, sendMessage]);

  // -------------------------------------------------------------------------
  // SpeechRecognition setup. We lazily create a single instance per widget
  // mount and re-bind handlers when speechMode changes (since the result
  // handler's behaviour differs between text-fill and voice-loop modes).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!voiceSupported) return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recognitionRef.current) return;
    try {
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      recognitionRef.current = rec;
    } catch (err: any) {
      console.warn(
        "[ChatWidget] SpeechRecognition init failed:",
        err?.message || err,
      );
    }
  }, [voiceSupported]);

  // (Re)bind handlers any time the mode/state machine inputs change.
  useEffect(() => {
    const rec = recognitionRef.current;
    if (!rec) return;

    rec.onresult = (e: SpeechRecognitionEventLike) => {
      let interim = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0]?.transcript || "";
        if (r.isFinal) finalText += t;
        else interim += t;
      }
      if (interim) setInterimTranscript(interim);

      if (!finalText) return;

      if (speechModeRef.current === "text") {
        // Shape A: append to the textarea so the user can review/edit.
        setInput((prev) => {
          const sep = prev && !prev.endsWith(" ") ? " " : "";
          return prev + sep + finalText.trim();
        });
        setInterimTranscript("");
      } else {
        // Shape B: ship straight to Alex.
        setInterimTranscript("");
        void sendMessage(finalText.trim(), { fromVoice: true });
      }
    };

    rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
      console.warn("[ChatWidget] recognition error:", e.error, e.message);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setMicPermissionDenied(true);
      }
      setMicActive(false);
      if (speechModeRef.current === "voice") setVoiceState("idle");
    };

    rec.onend = () => {
      setMicActive(false);
      // In voice mode, if we ended without a final transcript (e.g. silence
      // timeout) and we're still in LISTENING, drop to IDLE — the user can
      // tap to restart.
      if (
        speechModeRef.current === "voice" &&
        // we are NOT mid-thinking/speaking (those would have updated state)
        true
      ) {
        setVoiceState((s) => (s === "listening" ? "idle" : s));
      }
    };

    rec.onstart = () => {
      setMicActive(true);
      setInterimTranscript("");
    };
  }, [sendMessage]);

  // Concrete startListening implementation — wired into the ref the
  // sendMessage callback closes over.
  useEffect(() => {
    voiceLoopStartListeningRef.current = () => {
      const rec = recognitionRef.current;
      if (!rec) return;
      stopPlayback();
      try {
        rec.start();
        setVoiceState("listening");
      } catch (err: any) {
        // start() throws if already running — abort + restart.
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          // Guard against waking up after user toggled away from voice
          // mode or closed the widget (architect MEDIUM #3).
          if (!openRef.current || speechModeRef.current !== "voice") {
            setVoiceState("idle");
            return;
          }
          try {
            rec.start();
            setVoiceState("listening");
          } catch (err2: any) {
            console.warn(
              "[ChatWidget] recognition restart failed:",
              err2?.message || err2,
            );
            setVoiceState("idle");
          }
        }, 100);
      }
    };
  }, [stopPlayback]);

  // Push-to-talk (Shape A): mic button toggles recognition.
  const togglePushToTalk = useCallback(() => {
    if (!voiceSupported) return;
    const rec = recognitionRef.current;
    if (!rec) return;
    if (micActive) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    setError(null);
    setMicPermissionDenied(false);
    try {
      rec.start();
    } catch (err: any) {
      console.warn(
        "[ChatWidget] push-to-talk start failed:",
        err?.message || err,
      );
    }
  }, [voiceSupported, micActive]);

  // Voice-mode toggle (Shape B): flip mode + clean up any in-flight state.
  const toggleVoiceMode = useCallback(() => {
    setSpeechMode((prev) => {
      const next: SpeechMode = prev === "text" ? "voice" : "text";
      // Tearing DOWN voice mode — stop everything.
      if (next === "text") {
        const rec = recognitionRef.current;
        if (rec) {
          try {
            rec.abort();
          } catch {
            /* ignore */
          }
        }
        stopPlayback();
        setVoiceState("idle");
        setMicActive(false);
        setInterimTranscript("");
      } else {
        // Entering voice mode: reset error banner; user explicitly
        // initiates listening by tapping the indicator.
        setError(null);
        setMicPermissionDenied(false);
        setVoiceState("idle");
      }
      return next;
    });
  }, [stopPlayback]);

  // Voice-mode click handler on the big circle — toggles between
  // listen/stop and interrupts SPEAKING for early re-listen.
  const onVoiceCircleClick = useCallback(() => {
    if (sending && voiceState === "thinking") return; // can't interrupt API call
    if (voiceState === "speaking") {
      stopPlayback();
      startListening();
      return;
    }
    if (voiceState === "listening") {
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }
      setVoiceState("idle");
      return;
    }
    // IDLE → start
    startListening();
  }, [voiceState, sending, stopPlayback, startListening]);

  // -------------------------------------------------------------------------
  // start over: DELETE conv → clear localStorage → re-bootstrap.
  // -------------------------------------------------------------------------
  const startOver = useCallback(async () => {
    if (!conversationId || sending || bootstrapping) return;
    // Tear down voice state too.
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    stopPlayback();
    setVoiceState("idle");
    setMicActive(false);
    setInterimTranscript("");

    try {
      await chatFetch(`/api/chat/conversation/${conversationId}`, {
        method: "DELETE",
      });
    } catch (err) {
      console.warn("[ChatWidget] startOver delete failed; resetting locally");
    }
    localStorage.removeItem(STORAGE_KEY);
    setConversationId(null);
    setMessages([]);
    setBootstrapped(false);
    setError(null);
    setOffline(false);
    await bootstrap();
  }, [conversationId, sending, bootstrapping, bootstrap, stopPlayback]);

  // -------------------------------------------------------------------------
  // Close-widget teardown (architect HIGH #2): if the panel is closed
  // while listening / speaking we must abort recognition + stop audio
  // immediately. The component stays mounted so a useEffect on `open`
  // is the right hook (an unmount cleanup wouldn't fire on collapse).
  // Conversation state (messages, conversationId) is intentionally
  // preserved so re-opening resumes seamlessly.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (open) return;
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    }
    stopPlayback();
    setVoiceState("idle");
    setMicActive(false);
    setInterimTranscript("");
  }, [open, stopPlayback]);

  // -------------------------------------------------------------------------
  // Cleanup on unmount: kill recognition, kill any playing audio.
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        try {
          rec.abort();
        } catch {
          /* ignore */
        }
      }
      const audio = audioRef.current;
      if (audio) {
        try {
          audio.pause();
        } catch {
          /* ignore */
        }
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
    };
  }, []);

  // Filter out the system row before rendering — the persona prompt is for
  // Claude, not for the user.
  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system"),
    [messages],
  );

  if (hidden) return null;

  // ===========================================================================
  // RENDER
  // ===========================================================================

  // Collapsed state: floating "Chat with Alex" pill at bottom-28 right-6.
  // The bottom-28 offset (vs the prior bottom-24) gives clear vertical
  // separation from NeverrVoiceWidget's mic button on routes where both
  // render. Label is preserved on every route — see the "2026-05-05
  // visual hierarchy fix" comment block near the top of this file for
  // the architectural rationale and the list of mic-mounting routes.
  if (!open) {
    return (
      <button
        type="button"
        aria-label="Chat with Alex"
        onClick={() => setOpen(true)}
        className="fixed bottom-28 right-6 z-50 flex items-center gap-2 rounded-full bg-slate-900 px-5 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:bg-slate-800 hover:shadow-xl active:scale-95"
      >
        <MessageCircle className="h-5 w-5" aria-hidden="true" />
        <span className="hidden sm:inline">Chat with Alex</span>
      </button>
    );
  }

  // Expanded panel.
  return (
    <div
      role="dialog"
      aria-label="Chat with Alex from Neverr"
      aria-modal="false"
      className="fixed z-50 inset-0 sm:inset-auto sm:bottom-6 sm:right-6 sm:h-[600px] sm:max-h-[calc(100vh-3rem)] sm:w-[400px] flex flex-col bg-white sm:rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
    >
      {/* HEADER */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 bg-slate-50">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-white"
          aria-hidden="true"
        >
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900 leading-tight">
            Alex {speechMode === "voice" && (
              <span className="ml-1 text-[10px] font-medium text-slate-500 uppercase tracking-wide">
                voice
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 leading-tight">
            Neverr AI assistant
          </div>
        </div>

        {/* Voice mode toggle (Shape B). Hidden if browser lacks Web Speech.
            Disabled (with tooltip) if TTS has been observed unavailable. */}
        {voiceSupported && (
          <button
            type="button"
            onClick={toggleVoiceMode}
            disabled={!bootstrapped || bootstrapping}
            aria-label={
              speechMode === "voice"
                ? "Switch to text chat"
                : "Switch to voice chat"
            }
            aria-pressed={speechMode === "voice"}
            title={
              speechMode === "voice"
                ? "Switch to text chat"
                : "Switch to voice chat"
            }
            className={`flex items-center justify-center h-8 w-8 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              speechMode === "voice"
                ? "bg-slate-900 text-white hover:bg-slate-800"
                : "text-slate-500 hover:bg-slate-200 hover:text-slate-900"
            }`}
          >
            {speechMode === "voice" ? (
              <Headphones className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Volume2 className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}

        <button
          type="button"
          onClick={startOver}
          disabled={!bootstrapped || sending || bootstrapping}
          aria-label="Start a new conversation"
          title="Start over"
          className="text-xs text-slate-500 hover:text-slate-900 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1 px-2 py-1 rounded transition-colors"
        >
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden sm:inline">Start over</span>
        </button>
        <button
          ref={closeBtnRef}
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close chat"
          className="text-slate-500 hover:text-slate-900 p-1 rounded transition-colors"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>

      {/* MESSAGE LIST — always visible, voice mode just hides the composer */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-white"
      >
        {offline ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="text-base font-semibold text-slate-900 mb-2">
              Alex is offline right now
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Our team is on it. In the meantime, drop us a note via the
              contact form and we'll get back to you within one business day.
            </p>
            <a
              href={getDiscoveryCallUrl()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition-colors"
            >
              Open contact form →
            </a>
          </div>
        ) : bootstrapping ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : (
          <>
            {visibleMessages.map((m) => (
              <MessageBubble key={m.id} role={m.role} content={m.content} />
            ))}
            {sending && <TypingIndicator />}
          </>
        )}
      </div>

      {/* INLINE error banner sits between messages and composer */}
      {error && !offline && (
        <div
          className="px-4 py-2 text-xs text-red-700 bg-red-50 border-t border-red-100"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Mic-permission-denied inline message (text-mode push-to-talk) */}
      {micPermissionDenied && !offline && (
        <div
          className="px-4 py-2 text-xs text-amber-700 bg-amber-50 border-t border-amber-100"
          role="alert"
        >
          Mic access needed for voice — enable in your browser settings.
        </div>
      )}

      {/* COMPOSER (text mode) OR VOICE INDICATOR (voice mode) */}
      {!offline && speechMode === "text" && (
        <form
          className="border-t border-slate-200 bg-white px-3 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              maxLength={4000}
              disabled={!bootstrapped || sending}
              placeholder={
                bootstrapped
                  ? micActive
                    ? "Listening…"
                    : "Ask Alex anything…"
                  : "Loading…"
              }
              aria-label="Type your message"
              className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-slate-900 disabled:bg-slate-50 disabled:cursor-not-allowed max-h-32"
              style={{ minHeight: "38px" }}
            />

            {/* Push-to-talk mic (Shape A). Only rendered when supported. */}
            {voiceSupported && (
              <button
                type="button"
                onClick={togglePushToTalk}
                disabled={!bootstrapped || sending}
                aria-label={micActive ? "Stop listening" : "Start voice input"}
                aria-pressed={micActive}
                title={micActive ? "Stop listening" : "Speak your message"}
                className={`shrink-0 flex items-center justify-center h-[38px] w-[38px] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  micActive
                    ? "bg-red-500 text-white hover:bg-red-600 animate-pulse"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {micActive ? (
                  <MicOff className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Mic className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}

            <button
              type="submit"
              disabled={!input.trim() || sending || !bootstrapped}
              aria-label="Send message"
              className="shrink-0 flex items-center justify-center h-[38px] w-[38px] rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          </div>

          {/* Live interim transcript — visible while push-to-talk is running */}
          {micActive && interimTranscript && (
            <p
              className="mt-1.5 text-xs text-slate-500 italic px-1 truncate"
              aria-live="polite"
            >
              {interimTranscript}
            </p>
          )}

          <p className="mt-2 text-[10px] text-slate-400 leading-tight">
            Alex is an AI assistant. Conversations are stored to improve
            service.{" "}
            {voiceSupported && (
              <span>
                Voice mode uses your browser&apos;s speech recognition; audio
                is processed by your browser, not Neverr.
              </span>
            )}
          </p>
        </form>
      )}

      {/* VOICE MODE UI — replaces composer when speechMode === 'voice' */}
      {!offline && speechMode === "voice" && (
        <VoiceComposer
          voiceState={voiceState}
          interimTranscript={interimTranscript}
          ttsAvailable={ttsAvailable}
          micPermissionDenied={micPermissionDenied}
          onCircleClick={onVoiceCircleClick}
          onSwitchToText={toggleVoiceMode}
          bootstrapped={bootstrapped}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — kept inline (single file) per the spec's "match existing
// component patterns" + to keep the diff small.
// ---------------------------------------------------------------------------
function MessageBubble({ role, content }: { role: Role; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? "bg-slate-900 text-white rounded-br-sm"
            : "bg-slate-100 text-slate-900 rounded-bl-sm"
        }`}
      >
        {content}
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-label="Alex is typing">
      <div className="bg-slate-100 rounded-2xl rounded-bl-sm px-3.5 py-2.5 flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400 animate-bounce" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VoiceComposer — Shape B "voice conversation" UI. Replaces the textarea
// composer when speechMode === 'voice'. Big circular indicator that
// pulses + colour-shifts based on voiceState. Tap toggles between
// listen / stop / interrupt-and-listen.
//
// Colour map:
//   IDLE      slate     "Tap to start"
//   LISTENING green     "Listening…" + interim transcript
//   THINKING  blue      "Thinking…" + spinner
//   SPEAKING  amber     "Alex is speaking" + tap-to-interrupt
// ---------------------------------------------------------------------------
function VoiceComposer({
  voiceState,
  interimTranscript,
  ttsAvailable,
  micPermissionDenied,
  onCircleClick,
  onSwitchToText,
  bootstrapped,
}: {
  voiceState: VoiceState;
  interimTranscript: string;
  ttsAvailable: boolean;
  micPermissionDenied: boolean;
  onCircleClick: () => void;
  onSwitchToText: () => void;
  bootstrapped: boolean;
}) {
  const stateLabel: Record<VoiceState, string> = {
    idle: "Tap to start talking",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Alex is speaking — tap to interrupt",
  };

  const ring: Record<VoiceState, string> = {
    idle: "bg-slate-100 text-slate-700 ring-4 ring-slate-200",
    listening:
      "bg-emerald-500 text-white ring-4 ring-emerald-300 animate-pulse",
    thinking: "bg-sky-500 text-white ring-4 ring-sky-300",
    speaking: "bg-amber-500 text-white ring-4 ring-amber-300 animate-pulse",
  };

  return (
    <div className="border-t border-slate-200 bg-white px-4 py-5 flex flex-col items-center">
      <button
        type="button"
        onClick={onCircleClick}
        disabled={!bootstrapped || (voiceState === "thinking")}
        aria-label={stateLabel[voiceState]}
        aria-live="polite"
        className={`relative flex h-24 w-24 items-center justify-center rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 ${ring[voiceState]}`}
      >
        {voiceState === "thinking" ? (
          <Loader2 className="h-9 w-9 animate-spin" aria-hidden="true" />
        ) : voiceState === "speaking" ? (
          <Volume2 className="h-9 w-9" aria-hidden="true" />
        ) : voiceState === "listening" ? (
          <Mic className="h-9 w-9" aria-hidden="true" />
        ) : (
          <Mic className="h-9 w-9" aria-hidden="true" />
        )}
      </button>

      <p
        className="mt-3 text-sm font-medium text-slate-700 text-center"
        aria-live="polite"
      >
        {stateLabel[voiceState]}
      </p>

      {voiceState === "listening" && interimTranscript && (
        <p
          className="mt-1 text-xs text-slate-500 italic text-center max-w-[280px] truncate"
          aria-live="polite"
        >
          {interimTranscript}
        </p>
      )}

      {!ttsAvailable && (
        <p className="mt-2 text-xs text-amber-600 text-center max-w-[300px]">
          <VolumeX className="inline h-3 w-3 mr-1" aria-hidden="true" />
          Alex's voice is offline — replies will appear above as text.
        </p>
      )}

      {micPermissionDenied && (
        <p className="mt-2 text-xs text-amber-600 text-center max-w-[300px]">
          Mic access needed — enable in your browser settings.
        </p>
      )}

      <button
        type="button"
        onClick={onSwitchToText}
        className="mt-4 text-xs text-slate-500 hover:text-slate-900 underline underline-offset-2"
      >
        Switch back to text chat
      </button>

      <p className="mt-3 text-[10px] text-slate-400 leading-tight text-center max-w-[320px]">
        Voice mode uses your browser&apos;s speech recognition; audio is
        processed by your browser, not Neverr. Alex&apos;s spoken replies are
        generated by a partner TTS service.
      </p>
    </div>
  );
}
