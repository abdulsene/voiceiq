/**
 * Sprint 3 Stage 5 Session 2 — Prompt editor for /settings/ai.
 *
 * Two views over the same business_configs row:
 *   - Structured: five sections of helper fields (tone, FAQs, never-say,
 *     objections, after-hours). Saves via PATCH /business/prompt/helpers
 *     then chains POST /business/prompt/regenerate to re-render + sync to
 *     ElevenLabs. Two-call flow has visible "Saved → Updating your AI…"
 *     progression and handles either phase failing.
 *   - Raw: full system_prompt textarea. Saves via PATCH /business/prompt
 *     (direct save + sync, no regen). After save we refresh state since
 *     a raw write doesn't touch helpers but invalidates the rendered
 *     view of "what would regenerate produce."
 *
 * Snapshot pattern: on mount and after every successful save we stash a
 * helpersSnapshot + rawSnapshot. "Discard changes" reverts to those.
 * "Dirty" is JSON.stringify inequality vs the snapshot.
 *
 * beforeunload guard fires when either dirty flag is true so the browser
 * prompts before closing the tab. Tab-switch confirmation (Voice ↔
 * Prompt) was explicitly cut from scope this session.
 *
 * Toasts bubble up to AiSettingsPage's hand-rolled toast (the dashboard
 * doesn't mount a global Toaster) via the onToast prop.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Code,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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

interface Faq {
  question: string;
  answer: string;
}

interface Objection {
  objection: string;
  response: string;
}

interface Helpers {
  tone_preference: string;
  custom_faqs: Faq[];
  never_say_list: string[];
  objection_handling: Objection[];
  after_hours_message: string;
}

interface PromptState {
  business_id: string;
  business_name: string | null;
  industry: string | null;
  agent_id: string | null;
  system_prompt: string | null;
  prompt_updated_at: string | null;
  prompt_updated_by: string | null;
  prompt_last_synced_at: string | null;
  prompt_sync_error: string | null;
  prompt_helpers_dirty_at: string | null;
  tone_preference: string | null;
  custom_faqs: Faq[] | null;
  never_say_list: string[] | null;
  objection_handling: Objection[] | null;
  after_hours_message: string | null;
}

type SaveSyncResult =
  | { ok: true; charsWritten: number; syncedAt: string; auditLogId: string | null }
  | { ok: false; savedToDb: true; syncError: string; auditLogId: string | null };

// ───────────────────────────────────────────────────────────────────────
// Limits — mirror routes/prompt.ts validateHelpersBody().

const PROMPT_MAX = 50_000;
const TONE_MAX = 500;
const AFTER_HOURS_MAX = 1000;
const FAQ_MAX = 50;
const NEVER_SAY_MAX = 100;
const OBJECTION_MAX = 50;

// ───────────────────────────────────────────────────────────────────────
// Helpers

function emptyHelpers(): Helpers {
  return {
    tone_preference: "",
    custom_faqs: [],
    never_say_list: [],
    objection_handling: [],
    after_hours_message: "",
  };
}

function helpersFromState(s: PromptState): Helpers {
  return {
    tone_preference: s.tone_preference ?? "",
    custom_faqs: Array.isArray(s.custom_faqs) ? s.custom_faqs : [],
    never_say_list: Array.isArray(s.never_say_list) ? s.never_say_list : [],
    objection_handling: Array.isArray(s.objection_handling) ? s.objection_handling : [],
    after_hours_message: s.after_hours_message ?? "",
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Strip empty rows + trim before sending. The helpers endpoint 400s on
 * any empty-string entry inside an array, so dropping incomplete rows
 * here avoids surfacing those errors back to the customer. Empty
 * tone_preference / after_hours_message are valid as "".
 */
function helpersForSave(h: Helpers): Helpers {
  return {
    tone_preference: h.tone_preference,
    custom_faqs: h.custom_faqs
      .map((f) => ({ question: f.question.trim(), answer: f.answer.trim() }))
      .filter((f) => f.question.length > 0 && f.answer.length > 0),
    never_say_list: h.never_say_list.map((s) => s.trim()).filter((s) => s.length > 0),
    objection_handling: h.objection_handling
      .map((o) => ({ objection: o.objection.trim(), response: o.response.trim() }))
      .filter((o) => o.objection.length > 0 && o.response.length > 0),
    after_hours_message: h.after_hours_message,
  };
}

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

export default function PromptEditor({
  onToast,
}: {
  onToast: (text: string, kind: "ok" | "err") => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<PromptState | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [mode, setMode] = useState<"structured" | "raw">("structured");
  const [helpers, setHelpers] = useState<Helpers>(emptyHelpers());
  const [helpersSnapshot, setHelpersSnapshot] = useState<Helpers>(emptyHelpers());
  const [rawPrompt, setRawPrompt] = useState<string>("");
  const [rawSnapshot, setRawSnapshot] = useState<string>("");

  const [saving, setSaving] = useState(false);
  // Footer status while saving — drives "Saving…" vs "Updating your AI…".
  const [savePhase, setSavePhase] = useState<"" | "helpers" | "regen" | "raw">("");
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [modeSwitchConfirm, setModeSwitchConfirm] = useState(false);

  const helpersDirty = useMemo(
    () => !deepEqual(helpers, helpersSnapshot),
    [helpers, helpersSnapshot],
  );
  const rawDirty = useMemo(() => rawPrompt !== rawSnapshot, [rawPrompt, rawSnapshot]);
  const dirty = mode === "structured" ? helpersDirty : rawDirty;

  // Extracted from the mount effect so the "Try again" button in the
  // error state can re-trigger without a page reload. Polish B: B4.
  async function loadState(): Promise<void> {
    setLoading(true);
    setLoadError(null);
    try {
      // /auth/me runs in parallel just to identify the current user UUID
      // so we can render "You saved X ago" vs anonymized "Saved X ago"
      // when the last write came from a teammate.
      const [promptRes, meRes] = await Promise.all([
        fetchApi("/business/prompt") as Promise<PromptState>,
        fetchApi("/auth/me").catch(() => null) as Promise<{ user?: { id?: string } } | null>,
      ]);
      setState(promptRes);
      const h = helpersFromState(promptRes);
      setHelpers(h);
      setHelpersSnapshot(h);
      const raw = promptRes.system_prompt ?? "";
      setRawPrompt(raw);
      setRawSnapshot(raw);
      setCurrentUserId(meRes?.user?.id ?? null);
    } catch (e: any) {
      setLoadError(e?.message ?? "Failed to load prompt");
    } finally {
      setLoading(false);
    }
  }

  // ── Initial load ──────────────────────────────────────────────────────
  useEffect(() => {
    void loadState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // beforeunload guard — browser confirms before closing tab when dirty.
  useEffect(() => {
    if (!helpersDirty && !rawDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [helpersDirty, rawDirty]);

  // ── Refresh state from server (after successful saves) ────────────────
  async function refreshState(): Promise<void> {
    try {
      const fresh = (await fetchApi("/business/prompt")) as PromptState;
      setState(fresh);
      const h = helpersFromState(fresh);
      setHelpers(h);
      setHelpersSnapshot(h);
      const refreshedRaw = fresh.system_prompt ?? "";
      setRawPrompt(refreshedRaw);
      setRawSnapshot(refreshedRaw);
    } catch {
      // Non-fatal — save already succeeded; UI just won't reflect the
      // freshest server timestamps until the next page load.
    }
  }

  // ── Save: structured (helpers PATCH → regenerate POST) ────────────────
  async function saveStructured(): Promise<void> {
    if (!state) return;
    setSaving(true);
    setSavePhase("helpers");

    const payload = helpersForSave(helpers);
    try {
      const r1 = await fetch("/api/business/prompt/helpers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify(payload),
      });
      if (!r1.ok) {
        const errBody = await r1.json().catch(() => ({}));
        onToast(`Couldn't save: ${errBody.error ?? `HTTP ${r1.status}`}`, "err");
        setSaving(false);
        setSavePhase("");
        return;
      }

      // Phase 1 locked in. Sync local snapshot to the cleaned payload so
      // any blank rows the user added vanish from "dirty" comparisons.
      setHelpers(payload);
      setHelpersSnapshot(payload);
      // "Edits saved" (vs the final "Saved and applied to your AI" in
      // Phase 2) makes the two-step nature visible — the brief flash
      // between toasts reads as progress, not a swallowed message.
      onToast("Edits saved", "ok");

      // Phase 2 — regenerate.
      setSavePhase("regen");
      const r2 = await fetch("/api/business/prompt/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });
      const body2 = await r2.json().catch(() => null);

      if (r2.status === 409) {
        const err = (body2 as { error?: string })?.error ?? "missing required business info";
        onToast(`Saved your edits, but couldn't apply them: ${err}`, "err");
      } else if (!r2.ok) {
        const err = (body2 as { error?: string })?.error ?? `HTTP ${r2.status}`;
        onToast(`Saved, but couldn't apply to your AI: ${err}`, "err");
      } else if (body2 && typeof body2 === "object" && "ok" in body2) {
        const result = body2 as SaveSyncResult;
        if (result.ok) {
          onToast("Saved and applied to your AI", "ok");
        } else if (result.savedToDb) {
          onToast(
            `Saved but couldn't update your AI yet: ${result.syncError}. Save again to retry.`,
            "err",
          );
        }
      }

      await refreshState();
    } catch (e: any) {
      onToast(`Network error: ${e?.message ?? "unknown"}`, "err");
    } finally {
      setSaving(false);
      setSavePhase("");
    }
  }

  // ── Save: raw (PATCH /business/prompt — direct sync, no regen) ────────
  async function saveRaw(): Promise<void> {
    if (!state) return;
    setSaving(true);
    setSavePhase("raw");
    try {
      const r = await fetch("/api/business/prompt", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ system_prompt: rawPrompt }),
      });
      const body = await r.json().catch(() => null);

      if (r.status === 409) {
        const err = (body as { error?: string })?.error ?? "no AI agent configured";
        onToast(`Couldn't save: ${err}`, "err");
        return;
      }
      if (!r.ok) {
        const err = (body as { error?: string })?.error ?? `HTTP ${r.status}`;
        onToast(`Couldn't save: ${err}`, "err");
        return;
      }

      if (body && typeof body === "object" && "ok" in body) {
        const result = body as SaveSyncResult;
        if (result.ok) {
          onToast("Saved and applied to your AI", "ok");
        } else if (result.savedToDb) {
          onToast(
            `Saved but couldn't update your AI yet: ${result.syncError}. Save again to retry.`,
            "err",
          );
        }
      }
      // Refresh — the saved raw text becomes the new system_prompt, and
      // helpers are unchanged but their "dirty since regen" flag clears.
      await refreshState();
    } catch (e: any) {
      onToast(`Network error: ${e?.message ?? "unknown"}`, "err");
    } finally {
      setSaving(false);
      setSavePhase("");
    }
  }

  // ── Discard ───────────────────────────────────────────────────────────
  function doDiscard(): void {
    if (mode === "structured") {
      setHelpers(helpersSnapshot);
    } else {
      setRawPrompt(rawSnapshot);
    }
    setDiscardConfirm(false);
  }

  // ── Mode switch (raw → structured prompts if rawDirty) ────────────────
  function requestModeSwitchToStructured(): void {
    if (rawDirty) {
      setModeSwitchConfirm(true);
    } else {
      setMode("structured");
    }
  }

  // ── Render: loading / error gates ─────────────────────────────────────
  if (loading) {
    // Polish B: B3. Render one skeleton card per real Section (5 total) so
    // the page doesn't suddenly grow when content swaps in.
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-64" />
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i}>
            <CardContent className="pt-6 space-y-3">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  if (loadError) {
    return (
      <Card className="border-red-200 bg-red-50">
        <CardContent className="pt-6 flex items-start justify-between gap-3 flex-wrap">
          <p className="text-red-700 text-sm flex-1 min-w-0">
            Couldn't load prompt: {loadError}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadState()}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!state) return null;

  const isCurrentUserAuthor =
    state.prompt_updated_by !== null &&
    currentUserId !== null &&
    state.prompt_updated_by === currentUserId;
  const updatedRel = formatRelative(state.prompt_updated_at);
  // Helpers were touched after the last regen — surface a hint so the
  // customer knows their edits aren't live on the AI yet.
  const helpersChangedSinceRegen =
    state.prompt_helpers_dirty_at !== null &&
    (!state.prompt_updated_at ||
      new Date(state.prompt_helpers_dirty_at).getTime() >
        new Date(state.prompt_updated_at).getTime());

  return (
    <div className="space-y-4">
      {/* Header + mode toggle */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-semibold">
            {mode === "raw" ? "Raw Prompt" : "Editing your AI's behavior"}
          </h2>
          {mode === "raw" && (
            <p className="text-sm text-gray-500 mt-0.5">
              Direct prompt override. The structured settings still exist
              underneath but won't update your AI until you save them again.
            </p>
          )}
        </div>
        {mode === "structured" ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMode("raw")}
            disabled={saving}
            className="shrink-0 self-start sm:self-auto"
          >
            <Code className="h-4 w-4 mr-1.5" />
            Advanced: Edit raw prompt
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={requestModeSwitchToStructured}
            disabled={saving}
            className="shrink-0 self-start sm:self-auto"
          >
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to structured view
          </Button>
        )}
      </div>

      {/* Helpers-changed-since-regen hint (structured only) */}
      {mode === "structured" && helpersChangedSinceRegen && !helpersDirty && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
          You have helper changes that haven't been applied to your AI yet.
          Save again to apply them now.
        </div>
      )}

      {/* Body */}
      {mode === "structured" ? (
        <>
          {/* Section 1 — Tone */}
          <Section
            title="How your AI sounds"
            hint="Describe how you want your AI to sound on calls. This guides the personality, not the script."
          >
            <Textarea
              value={helpers.tone_preference}
              onChange={(e) =>
                setHelpers((h) => ({
                  ...h,
                  tone_preference: e.target.value.slice(0, TONE_MAX),
                }))
              }
              placeholder="Warm and welcoming. Speak conversationally, not formally."
              maxLength={TONE_MAX}
              rows={3}
              disabled={saving}
            />
            <CharCount n={helpers.tone_preference.length} max={TONE_MAX} />
          </Section>

          {/* Section 2 — Custom FAQs */}
          <Section
            title="Custom FAQs"
            hint="Your AI will answer these naturally, not robotically."
            countLabel={`${helpers.custom_faqs.length} / ${FAQ_MAX}`}
            emptyState={
              helpers.custom_faqs.length === 0
                ? "No custom FAQs yet. Add the questions your callers ask most so your AI can answer them perfectly."
                : null
            }
          >
            {helpers.custom_faqs.map((faq, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 space-y-2">
                  <Input
                    value={faq.question}
                    placeholder="Question (e.g. Do you offer same-day appointments?)"
                    onChange={(e) =>
                      setHelpers((h) => ({
                        ...h,
                        custom_faqs: h.custom_faqs.map((f, idx) =>
                          idx === i ? { ...f, question: e.target.value } : f,
                        ),
                      }))
                    }
                    disabled={saving}
                  />
                  <Textarea
                    value={faq.answer}
                    placeholder="Answer"
                    rows={2}
                    onChange={(e) =>
                      setHelpers((h) => ({
                        ...h,
                        custom_faqs: h.custom_faqs.map((f, idx) =>
                          idx === i ? { ...f, answer: e.target.value } : f,
                        ),
                      }))
                    }
                    disabled={saving}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setHelpers((h) => ({
                      ...h,
                      custom_faqs: h.custom_faqs.filter((_, idx) => idx !== i),
                    }))
                  }
                  disabled={saving}
                  className="shrink-0 text-gray-400 hover:text-red-600"
                  aria-label="Remove FAQ"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {helpers.custom_faqs.length < FAQ_MAX && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setHelpers((h) => ({
                    ...h,
                    custom_faqs: [...h.custom_faqs, { question: "", answer: "" }],
                  }))
                }
                disabled={saving}
              >
                <Plus className="h-4 w-4 mr-1.5" /> Add FAQ
              </Button>
            )}
          </Section>

          {/* Section 3 — Never say */}
          <Section
            title="Never say"
            hint="These are absolute prohibitions. The AI will never say these things, even if asked directly."
            countLabel={`${helpers.never_say_list.length} / ${NEVER_SAY_MAX}`}
            emptyState={
              helpers.never_say_list.length === 0
                ? "No restrictions. Add words or topics your AI should never bring up — like prices for custom quotes, or specific competitor names."
                : null
            }
          >
            {helpers.never_say_list.map((s, i) => (
              <div key={i} className="flex gap-2 items-center">
                <Input
                  value={s}
                  placeholder="e.g. Specific pricing"
                  onChange={(e) =>
                    setHelpers((h) => ({
                      ...h,
                      never_say_list: h.never_say_list.map((x, idx) =>
                        idx === i ? e.target.value : x,
                      ),
                    }))
                  }
                  disabled={saving}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setHelpers((h) => ({
                      ...h,
                      never_say_list: h.never_say_list.filter((_, idx) => idx !== i),
                    }))
                  }
                  disabled={saving}
                  className="shrink-0 text-gray-400 hover:text-red-600"
                  aria-label="Remove restriction"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {helpers.never_say_list.length < NEVER_SAY_MAX && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setHelpers((h) => ({
                    ...h,
                    never_say_list: [...h.never_say_list, ""],
                  }))
                }
                disabled={saving}
              >
                <Plus className="h-4 w-4 mr-1.5" /> Add restriction
              </Button>
            )}
          </Section>

          {/* Section 4 — Common objections */}
          <Section
            title="Common objections"
            hint="How you want your AI to respond when callers raise common pushback."
            countLabel={`${helpers.objection_handling.length} / ${OBJECTION_MAX}`}
            emptyState={
              helpers.objection_handling.length === 0
                ? "Add objections customers often raise (price, timing, comparing to competitors) and how you want your AI to respond."
                : null
            }
          >
            {helpers.objection_handling.map((o, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1 space-y-2">
                  <Input
                    value={o.objection}
                    placeholder="Objection (e.g. Your prices are too high)"
                    onChange={(e) =>
                      setHelpers((h) => ({
                        ...h,
                        objection_handling: h.objection_handling.map((x, idx) =>
                          idx === i ? { ...x, objection: e.target.value } : x,
                        ),
                      }))
                    }
                    disabled={saving}
                  />
                  <Textarea
                    value={o.response}
                    placeholder="Response"
                    rows={2}
                    onChange={(e) =>
                      setHelpers((h) => ({
                        ...h,
                        objection_handling: h.objection_handling.map((x, idx) =>
                          idx === i ? { ...x, response: e.target.value } : x,
                        ),
                      }))
                    }
                    disabled={saving}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    setHelpers((h) => ({
                      ...h,
                      objection_handling: h.objection_handling.filter((_, idx) => idx !== i),
                    }))
                  }
                  disabled={saving}
                  className="shrink-0 text-gray-400 hover:text-red-600"
                  aria-label="Remove objection"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {helpers.objection_handling.length < OBJECTION_MAX && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setHelpers((h) => ({
                    ...h,
                    objection_handling: [
                      ...h.objection_handling,
                      { objection: "", response: "" },
                    ],
                  }))
                }
                disabled={saving}
              >
                <Plus className="h-4 w-4 mr-1.5" /> Add objection
              </Button>
            )}
          </Section>

          {/* Section 5 — After-hours message */}
          <Section
            title="After-hours message"
            hint="What your AI says when callers reach you outside business hours."
          >
            <Textarea
              value={helpers.after_hours_message}
              onChange={(e) =>
                setHelpers((h) => ({
                  ...h,
                  after_hours_message: e.target.value.slice(0, AFTER_HOURS_MAX),
                }))
              }
              placeholder="Hi! Our office is currently closed. Leave your name, number, and a brief message and we'll call you back during business hours."
              maxLength={AFTER_HOURS_MAX}
              rows={4}
              disabled={saving}
            />
            <CharCount n={helpers.after_hours_message.length} max={AFTER_HOURS_MAX} />
          </Section>
        </>
      ) : (
        // ── Raw view ────────────────────────────────────────────────────
        <>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
            You're editing your AI's full prompt directly. This overrides the
            structured settings until you save them again. Be careful — a
            broken prompt means a broken AI.
          </div>
          <Textarea
            value={rawPrompt}
            onChange={(e) => setRawPrompt(e.target.value.slice(0, PROMPT_MAX))}
            rows={30}
            maxLength={PROMPT_MAX}
            disabled={saving}
            className="font-mono text-xs min-h-[600px]"
            placeholder="The full system prompt sent to your AI on every call."
          />
          <CharCount n={rawPrompt.length} max={PROMPT_MAX} />
        </>
      )}

      {/* Sticky footer */}
      <div className="sticky bottom-0 bg-white border-t pt-3 pb-3 flex items-center justify-between gap-3 -mx-4 px-4 md:-mx-6 md:px-6">
        <div className="text-xs text-gray-500 flex-1 min-w-0 truncate">
          {saving ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {savePhase === "regen"
                ? "Updating your AI…"
                : savePhase === "helpers" || savePhase === "raw"
                ? "Saving…"
                : "Working…"}
            </span>
          ) : dirty ? (
            <span className="text-amber-700">Unsaved changes</span>
          ) : updatedRel ? (
            <>
              <span>
                {isCurrentUserAuthor ? "You saved" : "Saved"} {updatedRel}
              </span>
              {state.prompt_sync_error && (
                <span className="text-red-600 ml-2">
                  · sync error: {state.prompt_sync_error}
                </span>
              )}
            </>
          ) : (
            <span className="text-gray-400">Not saved yet</span>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDiscardConfirm(true)}
            disabled={saving || !dirty}
          >
            Discard changes
          </Button>
          <Button
            size="sm"
            onClick={mode === "raw" ? saveRaw : saveStructured}
            disabled={saving || !dirty}
          >
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                {savePhase === "regen" ? "Updating…" : "Saving…"}
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </div>

      {/* Discard confirm */}
      <AlertDialog
        open={discardConfirm}
        onOpenChange={(o) => {
          if (!o) setDiscardConfirm(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits will revert to the last saved state. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={doDiscard}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mode-switch confirm (raw → structured with dirty raw) */}
      <AlertDialog
        open={modeSwitchConfirm}
        onOpenChange={(o) => {
          if (!o) setModeSwitchConfirm(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your raw prompt changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching back to the structured view will lose any unsaved edits
              to the raw prompt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setRawPrompt(rawSnapshot);
                setMode("structured");
                setModeSwitchConfirm(false);
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Subcomponents

function Section({
  title,
  hint,
  countLabel,
  emptyState,
  children,
}: {
  title: string;
  hint?: string;
  countLabel?: string;
  emptyState?: string | null;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="pt-6 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="font-semibold">{title}</h3>
          {countLabel && (
            <span className="text-xs text-gray-400 shrink-0">{countLabel}</span>
          )}
        </div>
        {hint && <p className="text-xs text-gray-500 -mt-2">{hint}</p>}
        {emptyState && (
          <p className="text-sm text-gray-400 italic py-1">{emptyState}</p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function CharCount({ n, max }: { n: number; max: number }) {
  const close = n > max * 0.9;
  return (
    <p
      className={`text-xs ${close ? "text-amber-600" : "text-gray-400"} -mt-1 text-right`}
    >
      {n} / {max}
    </p>
  );
}
