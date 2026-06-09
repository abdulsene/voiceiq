/**
 * Voice tab — extracted from AiSettingsPage.tsx as part of Stage 6
 * Phase 3B. Customer flow (/settings/ai) uses apiBase="business";
 * admin drill-in (/admin/businesses/:id) uses
 * apiBase=`admin/business/${id}`. Behavior is identical — the only
 * difference between the two surfaces is the URL prefix.
 *
 * Audio playback lifecycle (PRESERVED VERBATIM from the original
 * implementation — Sprint 4 bug fix 8069230 lives here):
 *
 *   - Create: new Audio(blob URL) after fetching /voices/preview
 *   - Play: audio.play() (may reject on mobile if no user gesture —
 *     caught and toasted)
 *   - Stop: stopAudio() sets audioRef.current.src = "" to release.
 *     Sets isManualStopRef.current = true BEFORE so audio.onerror
 *     skips the spurious "Couldn't play preview audio" toast. The
 *     src="" reset triggers an async MEDIA_ELEMENT_ERROR which the
 *     onerror handler then ignores.
 *   - Replace: same as Stop, then create new.
 *   - Unmount: useEffect return calls stopAudio() so navigating
 *     away with audio playing releases the audio context + revokes
 *     the blob URL.
 *
 * The dialog confirmation pendingVoiceRef pattern is also preserved:
 * AlertDialogAction reads from the ref, not the closure, because
 * Radix's close-on-action races with React 19's automatic batching
 * and would otherwise null-out the voice mid-click.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Volume2,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
// Component

export default function VoiceTab({
  apiBase = "business",
  onToast,
}: {
  apiBase?: string;
  onToast: (text: string, kind: "ok" | "err") => void;
}) {
  const [catalog, setCatalog] = useState<CatalogVoice[]>([]);
  const [currentState, setCurrentState] = useState<VoiceStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [previewingVoiceId, setPreviewingVoiceId] = useState<string | null>(null);
  const [selectingVoiceId, setSelectingVoiceId] = useState<string | null>(null);
  const [confirmVoice, setConfirmVoice] = useState<CatalogVoice | null>(null);

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

  // Extracted from the mount effect so the "Try again" button in the
  // error state can re-trigger the same fetch without a page reload.
  // Polish B: B2.
  async function loadAll(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      const [catalogRes, stateRes] = await Promise.all([
        fetchApi("/voices/catalog") as Promise<{ voices: CatalogVoice[] }>,
        fetchApi(`/${apiBase}/voice`) as Promise<VoiceStateResponse>,
      ]);
      setCatalog(catalogRes.voices);
      setCurrentState(stateRes);
    } catch (e: any) {
      setLoadError(e?.message ?? "Failed to load voice settings");
    } finally {
      setLoading(false);
    }
  }

  // Mount: fetch catalog + current voice state in parallel. Cleanup
  // stops any in-flight audio playback so we don't leak the audio
  // context across navigation.
  useEffect(() => {
    void loadAll();
    return () => {
      stopAudio();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

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
      // /voices/preview is a shared resource (TTS) — not business-scoped,
      // so apiBase doesn't apply here.
      const res = await fetch("/api/voices/preview", {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice_id: voice.voice_id }),
      });
      if (res.status === 429) {
        onToast("You're previewing fast — give it a moment and try again.", "err");
        setPreviewingVoiceId(null);
        return;
      }
      if (!res.ok) {
        onToast("Voice preview unavailable right now. Try again in a moment.", "err");
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
        onToast("Couldn't play preview audio.", "err");
        stopAudio();
      };
      audioRef.current = audio;
      await audio.play();
    } catch (e: any) {
      console.error("[VoiceTab] preview failed:", e);
      onToast("Couldn't load voice preview.", "err");
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
      const res = await fetch(`/api/${apiBase}/voice`, {
        method: "PATCH",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ voice_id: voice.voice_id }),
      });
      const body = (await res.json()) as PatchResponse | { error?: string } | Record<string, unknown>;

      if (!res.ok) {
        const msg = (body as { error?: string }).error ?? `HTTP ${res.status}`;
        onToast(`Couldn't switch voices: ${msg}`, "err");
        setSelectingVoiceId(null);
        return;
      }

      // Customer endpoint returns {ok, synced, new_voice_id, voice_name,
      // auditLogId}. Admin endpoint (Phase 1) returns the full
      // BusinessDetail shape {business, prompt, voice}. Branch on shape so
      // both surfaces refresh the local state correctly.
      if ("ok" in body && body.ok === true) {
        const okBody = body as PatchSuccess;
        onToast(`Now using ${okBody.voice_name}`, "ok");
        setCurrentState((prev) =>
          prev
            ? {
                ...prev,
                voice_id: okBody.new_voice_id,
                voice_last_synced_at: new Date().toISOString(),
                voice_sync_error: null,
                catalog_match: voice,
              }
            : prev,
        );
      } else if ("ok" in body && body.ok === false && (body as PatchSyncFail).savedToDb) {
        const failBody = body as PatchSyncFail;
        onToast(
          `Saved but couldn't sync to your AI: ${failBody.syncError}. Try again.`,
          "err",
        );
        setCurrentState((prev) =>
          prev
            ? {
                ...prev,
                voice_id: failBody.new_voice_id,
                voice_sync_error: failBody.syncError,
                catalog_match: voice,
              }
            : prev,
        );
      } else if ("voice" in body && (body as any).voice) {
        // Admin response shape from Phase 1: {business, prompt, voice}.
        // Use the nested voice section to refresh + assume catalog_match
        // is the just-selected voice.
        const admin = body as {
          voice: { voice_id: string | null; voice_last_synced_at: string | null; voice_sync_error: string | null };
        };
        onToast(`Now using ${voice.name}`, "ok");
        setCurrentState((prev) =>
          prev
            ? {
                ...prev,
                voice_id: admin.voice.voice_id,
                voice_last_synced_at: admin.voice.voice_last_synced_at,
                voice_sync_error: admin.voice.voice_sync_error,
                catalog_match: voice,
              }
            : prev,
        );
      } else {
        onToast("Unexpected response from server.", "err");
      }
    } catch (e: any) {
      console.error("[VoiceTab] switch failed:", e);
      onToast("Network error. Try again.", "err");
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
    <div className="space-y-6">
      {/* Load error */}
      {loadError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 flex items-start justify-between gap-3 flex-wrap">
            <p className="text-red-700 text-sm flex-1 min-w-0">
              Couldn't load voice settings: {loadError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadAll()}
              disabled={loading}
              className="shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
              Try again
            </Button>
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
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div
                className={`h-14 w-14 rounded-full bg-gray-900 text-white flex items-center justify-center shrink-0 ${
                  previewingVoiceId === currentVoiceMatch.voice_id ? "animate-pulse" : ""
                }`}
              >
                <Mic className="h-6 w-6" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl sm:text-2xl font-semibold">{currentVoiceMatch.name}</h2>
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
                <p className="text-xs text-gray-500 mt-1">
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
                className="shrink-0 w-full sm:w-auto mt-1 sm:mt-0"
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
            <div className="flex items-start gap-3 text-gray-500">
              <Volume2 className="h-5 w-5 mt-0.5 shrink-0" />
              <span className="text-sm">
                {currentState?.voice_id
                  ? "Your AI is using a custom voice not in this catalog. Pick one below to switch."
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
            Preview how each voice sounds on calls to your business.
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
        ) : galleryVoices.length === 0 ? (
          // Polish B: B1. Cheap fallback for the edge case where the curated
          // catalog ships empty or is filtered down to zero — keeps the
          // "Choose a Voice" heading from sitting over nothing.
          <Card>
            <CardContent className="pt-6 text-sm text-gray-500">
              No alternate voices available. Your current voice is the only
              one in the curated catalog.
            </CardContent>
          </Card>
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

        <p className="text-xs italic text-gray-500 pt-2">
          Voice changes apply immediately. Existing calls in progress will finish
          with the previous voice.
        </p>
      </div>

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
    </div>
  );
}
