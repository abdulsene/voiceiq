/**
 * Sprint 3 Stage 5 Session 1 / Phase 3 — /settings/ai page.
 *
 * Voice picker UI for the AI receptionist. Surfaces the customer's
 * currently-configured ElevenLabs voice, lets them preview alternates
 * (live business-name personalized TTS), and one-click switch.
 *
 * Tabs strip is scaffolded with Prompt + History tabs disabled
 * ("Coming soon" badges); only Voice is interactive tonight.
 *
 * Toast pattern matches Appointments.tsx (hand-rolled local state +
 * setTimeout) — App.tsx doesn't mount a global Toaster.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Check,
  Mic,
  Pause,
  Play,
  Volume2,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { fetchApi, getAuthHeaders } from "@/lib/api";
import PromptEditor from "./AiSettings/PromptEditor";

// ───────────────────────────────────────────────────────────────────────
// Types

interface CatalogVoice {
  voice_id: string;
  name: string;
  gender: "male" | "female";
  accent: "American" | "British" | "Australian" | "Swedish";
  descriptor: string;
  personality_tag: string;
}

interface VoiceStateResponse {
  business_id: string;
  voice_id: string | null;
  voice_last_synced_at: string | null;
  voice_sync_error: string | null;
  agent_id: string | null;
  catalog_match: CatalogVoice | null;
}

interface PatchSuccess {
  ok: true;
  synced: true;
  new_voice_id: string;
  voice_name: string;
  auditLogId: string | null;
}

interface PatchSyncFail {
  ok: false;
  savedToDb: true;
  syncError: string;
  new_voice_id: string;
  voice_name: string;
  auditLogId: string | null;
}

type PatchResponse = PatchSuccess | PatchSyncFail;

// ───────────────────────────────────────────────────────────────────────
// Helpers

function formatRelative(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  const mo = Math.round(day / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

// ───────────────────────────────────────────────────────────────────────
// Page

export default function AiSettingsPage() {
  const [catalog, setCatalog] = useState<CatalogVoice[]>([]);
  const [currentState, setCurrentState] = useState<VoiceStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [selectingVoiceId, setSelectingVoiceId] = useState<string | null>(null);
  const [confirmVoice, setConfirmVoice] = useState<CatalogVoice | null>(null);

  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  // Controlled Tabs so we can hoist the active tab if we ever need to
  // intercept switches. Tab-switch confirmation was cut from scope for
  // this session — beforeunload is the only guard for dirty prompt edits.
  const [tab, setTab] = useState<"voice" | "prompt" | "history">("voice");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  // Holds the voice the user is confirming, independent of React state, so
  // the AlertDialogAction's onClick reads a stable value even if the dialog's
  // close-on-click logic has already begun unmounting/resetting state.
  const pendingVoiceRef = useRef<CatalogVoice | null>(null);
  // Set true right before we yank an audio element down (pause + src="").
  // Clearing the src fires HTMLAudioElement.onerror with an empty-src error,
  // which would otherwise toast "Couldn't play preview audio" on every Pause.
  const isManualStopRef = useRef(false);

  // Mount: fetch catalog + current voice state in parallel.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [catalogRes, stateRes] = await Promise.all([
          fetchApi("/voices/catalog") as Promise<{ voices: CatalogVoice[] }>,
          fetchApi("/business/voice") as Promise<VoiceStateResponse>,
        ]);
        if (cancelled) return;
        setCatalog(catalogRes.voices);
        setCurrentState(stateRes);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message ?? "Failed to load voice settings");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      stopAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(text: string, kind: "ok" | "err"): void {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 3500);
  }

  function stopAudio(): void {
    if (audioRef.current) {
      isManualStopRef.current = true;
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    setPreviewingVoiceId(null);
  }

  async function handlePreview(voice: CatalogVoice): Promise<void> {
    // Toggle off if already playing this voice
    if (previewingVoiceId === voice.voice_id) {
      stopAudio();
      return;
    }
    // Stop any previous preview
    stopAudio();
    setPreviewingVoiceId(voice.voice_id);
    try {
      const res = await fetch("/api/voices/preview", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice_id: voice.voice_id }),
      });
      if (res.status === 429) {
        showToast("You're previewing fast — give it a moment and try again.", "err");
        setPreviewingVoiceId(null);
        return;
      }
      if (!res.ok) {
        showToast("Voice preview unavailable right now. Try again in a moment.", "err");
        setPreviewingVoiceId(null);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => {
        stopAudio();
      };
      audio.onerror = () => {
        // stopAudio() sets src="" to release the blob, which fires onerror
        // with MEDIA_ELEMENT_ERROR. Treat that as user-initiated and skip
        // the toast; the flag self-resets on next use.
        if (isManualStopRef.current) {
          isManualStopRef.current = false;
          return;
        }
        showToast("Couldn't play preview audio.", "err");
        stopAudio();
      };
      audioRef.current = audio;
      await audio.play();
    } catch (e: any) {
      console.error("[AiSettingsPage] preview failed:", e);
      showToast("Couldn't load voice preview.", "err");
      setPreviewingVoiceId(null);
    }
  }

  async function handleConfirmSwitch(voice: CatalogVoice): Promise<void> {
    stopAudio();
    setSelectingVoiceId(voice.voice_id);
    // Don't setConfirmVoice(null) here — Radix's AlertDialogAction closes
    // the dialog itself, which fires onOpenChange(false) below. Racing both
    // paths previously left React rendering an inconsistent dialog state and
    // swallowed this onClick on subsequent opens.
    try {
      const res = await fetch("/api/business/voice", {
        method: "PATCH",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice_id: voice.voice_id }),
      });
      const body = (await res.json()) as PatchResponse | { error?: string };

      if (!res.ok) {
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        showToast(`Couldn't switch voices: ${msg}`, "err");
        setSelectingVoiceId(null);
        return;
      }

      if ("ok" in body && body.ok === true) {
        showToast(`Now using ${body.voice_name}`, "ok");
        // Refresh local state with the new voice; surface fresh
        // last_synced_at without a full refetch round-trip.
        setCurrentState((prev) =>
          prev
            ? {
                ...prev,
                voice_id: body.new_voice_id,
                voice_last_synced_at: new Date().toISOString(),
                voice_sync_error: null,
                catalog_match: voice,
              }
            : prev,
        );
      } else if ("ok" in body && body.ok === false && body.savedToDb) {
        showToast(
          `Saved but couldn't sync to your AI: ${body.syncError}. Try again.`,
          "err",
        );
        setCurrentState((prev) =>
          prev
            ? {
                ...prev,
                voice_id: body.new_voice_id,
                voice_sync_error: body.syncError,
                catalog_match: voice,
              }
            : prev,
        );
      } else {
        showToast("Unexpected response from server.", "err");
      }
    } catch (e: any) {
      console.error("[AiSettingsPage] switch failed:", e);
      showToast("Network error. Try again.", "err");
    } finally {
      setSelectingVoiceId(null);
    }
  }

  const currentVoiceMatch = currentState?.catalog_match ?? null;
  const lastSyncedRelative = useMemo(
    () => formatRelative(currentState?.voice_last_synced_at ?? null),
    [currentState?.voice_last_synced_at],
  );

  // Voices to surface in the gallery: everything except the current.
  const galleryVoices = useMemo(
    () =>
      catalog.filter(
        (v) => !currentVoiceMatch || v.voice_id !== currentVoiceMatch.voice_id,
      ),
    [catalog, currentVoiceMatch],
  );

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="space-y-1">
        <Link
          href="/settings"
          className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Settings
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">AI Receptionist</h1>
        <p className="text-gray-500">Customize how your AI sounds on every call.</p>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "voice" | "prompt" | "history")}>
        <TabsList>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="history" disabled>
            History <Badge variant="secondary" className="ml-2 text-[10px]">Soon</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="voice" className="space-y-6 mt-6">
      {/* Load error */}
      {loadError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-red-700 text-sm">
              Couldn't load voice settings: {loadError}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Section A — Current Voice */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-gray-500 font-medium">
            Currently Using
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-4">
              <Skeleton className="h-14 w-14 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-64" />
              </div>
            </div>
          ) : currentVoiceMatch ? (
            <div className="flex items-center gap-4">
              <div
                className={`h-14 w-14 rounded-full bg-gray-900 text-white flex items-center justify-center ${
                  previewingVoiceId === currentVoiceMatch.voice_id ? "animate-pulse" : ""
                }`}
              >
                <Mic className="h-6 w-6" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-2xl font-semibold">{currentVoiceMatch.name}</h2>
                  <Badge variant="outline" className="text-xs">
                    {currentVoiceMatch.gender}
                  </Badge>
                  <Badge variant="outline" className="text-xs">
                    {currentVoiceMatch.accent}
                  </Badge>
                </div>
                <p className="text-gray-500 text-sm">
                  {currentVoiceMatch.descriptor}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  {lastSyncedRelative
                    ? `Last changed: ${lastSyncedRelative}`
                    : "This is your AI's voice from when your account was created."}
                </p>
                {currentState?.voice_sync_error && (
                  <p className="text-xs text-red-600 mt-1">
                    Sync error: {currentState.voice_sync_error}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handlePreview(currentVoiceMatch)}
                className="shrink-0"
              >
                {previewingVoiceId === currentVoiceMatch.voice_id ? (
                  <>
                    <Pause className="h-4 w-4 mr-1.5" /> Pause
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-1.5" /> Preview
                  </>
                )}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-gray-500">
              <Volume2 className="h-5 w-5" />
              <span className="text-sm">
                {currentState?.voice_id
                  ? `Your AI is using voice "${currentState.voice_id}", which isn't in the curated catalog. Pick one below to switch.`
                  : "Your AI has no voice configured yet. Pick one below."}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section B — Voice Gallery */}
      <div className="space-y-3">
        <div>
          <h2 className="text-xl font-semibold">Choose a Voice</h2>
          <p className="text-sm text-gray-500">
            Click preview to hear how each voice sounds when calling your business.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="pt-6 space-y-3">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-full" />
                  <div className="flex gap-2">
                    <Skeleton className="h-9 w-24" />
                    <Skeleton className="h-9 w-32" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {galleryVoices.map((voice) => {
              const isPreviewing = previewingVoiceId === voice.voice_id;
              const isSelecting = selectingVoiceId === voice.voice_id;
              return (
                <Card key={voice.voice_id} className="hover:shadow-md transition-shadow">
                  <CardContent className="pt-6 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1">
                        <h3 className="font-semibold text-lg">{voice.name}</h3>
                        <p className="text-sm text-gray-500">{voice.descriptor}</p>
                      </div>
                      <div
                        className={`h-10 w-10 rounded-full bg-gray-100 text-gray-700 flex items-center justify-center shrink-0 ${
                          isPreviewing ? "bg-gray-900 text-white animate-pulse" : ""
                        }`}
                      >
                        <Mic className="h-4 w-4" />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className="text-xs">
                        {voice.gender}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {voice.accent}
                      </Badge>
                      <Badge variant="secondary" className="text-xs">
                        {voice.personality_tag}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePreview(voice)}
                        disabled={isSelecting}
                      >
                        {isPreviewing ? (
                          <>
                            <Pause className="h-4 w-4 mr-1.5" /> Pause
                          </>
                        ) : (
                          <>
                            <Play className="h-4 w-4 mr-1.5" /> Preview
                          </>
                        )}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          pendingVoiceRef.current = voice;
                          setConfirmVoice(voice);
                        }}
                        disabled={isSelecting}
                      >
                        {isSelecting ? (
                          "Switching..."
                        ) : (
                          <>
                            <Check className="h-4 w-4 mr-1.5" />
                            Use this voice
                          </>
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <p className="text-xs italic text-gray-400 pt-2">
          Voice changes apply immediately. Existing calls in progress will finish
          with the previous voice.
        </p>
      </div>
        </TabsContent>

        <TabsContent value="prompt" className="mt-6">
          <PromptEditor onToast={showToast} />
        </TabsContent>
      </Tabs>

      {/* Confirmation dialog */}
      <AlertDialog
        open={!!confirmVoice}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmVoice(null);
            pendingVoiceRef.current = null;
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch your AI to {confirmVoice?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your next phone call will use {confirmVoice?.name}. Existing calls
              in progress will finish with the previous voice.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // Read from ref, not the confirmVoice closure: by the time
                // the click is delivered Radix may already be tearing down
                // the dialog and confirmVoice can be stale-null.
                const voice = pendingVoiceRef.current ?? confirmVoice;
                if (voice) void handleConfirmSwitch(voice);
              }}
            >
              Yes, switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 text-sm rounded-lg shadow-lg ${
            toast.kind === "ok"
              ? "bg-gray-900 text-white"
              : "bg-red-600 text-white"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
