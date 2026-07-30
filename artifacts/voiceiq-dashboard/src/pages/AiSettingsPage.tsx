/**
 * /settings/ai — customer AI Receptionist settings page.
 *
 * Stage 6 Phase 3B: this file is now a thin shell. All Voice/Prompt/
 * History logic lives in the three tab components, which accept an
 * apiBase prop so the admin drill-in at /admin/businesses/:id can
 * reuse them with a different URL prefix.
 *
 * Stays here: tabs strip + 3 panels + shared toast + ?tab= URL
 * initializer.
 */

// TODO(a11y): Pre-existing motion handling gaps not fixed in Polish E:
//   1. shadcn Dialog/AlertDialog entrance animations ignore
//      prefers-reduced-motion (tw-animate-css v1.4.0 has no
//      motion-reduce guards)
//   2. animate-pulse skeletons + animate-spin spinners ignore it too
//   Fix path: add to src/index.css:
//     @media (prefers-reduced-motion: reduce) {
//       .animate-pulse, .animate-spin, .animate-in {
//         animation: none !important;
//       }
//     }
//   Out of scope for /settings/ai-specific Polish E.

import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTabQueryState } from "@/hooks/use-tab-query-state";

import VoiceTab from "./AiSettings/VoiceTab";
import PromptEditor from "./AiSettings/PromptEditor";
import TransferTab from "./AiSettings/TransferTab";
import HistoryViewer from "./AiSettings/HistoryViewer";
// Phase 3.3c: explicit AI-receptionist resync + tool inspector.
import AgentResyncCard from "../components/AgentResyncCard";

// Order is Voice / Prompt / Transfer / History per the operator-transfer
// spec — Transfer is more relevant than History for daily-driver use, so
// it sits before History but after the foundational Voice + Prompt tabs.
type TabKey = "voice" | "prompt" | "transfer" | "history";

const AI_SETTINGS_TABS = ["voice", "prompt", "transfer", "history"] as const;

export default function AiSettingsPage() {
  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  // Phase 2.7b: switched from a one-way ?tab= read-on-mount to the
  // shared useTabQueryState hook so tab clicks now replaceState back
  // into the URL — reload-resilient and back/forward-aware. Same
  // external behavior; URL now stays in sync.
  const [tab, setTab] = useTabQueryState<TabKey>(AI_SETTINGS_TABS, "voice");

  function showToast(text: string, kind: "ok" | "err"): void {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 3500);
  }

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

      {/* Phase 3.3c: explicit resync + tool list, above the tabs so it
          reads as an ops action (not a settings tab). Answers "is
          route_to_topic actually attached?" without the ElevenLabs
          console. */}
      <AgentResyncCard />

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="transfer">Transfer</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent
          value="voice"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <VoiceTab onToast={showToast} />
        </TabsContent>

        <TabsContent
          value="prompt"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <PromptEditor onToast={showToast} />
        </TabsContent>

        <TabsContent
          value="transfer"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <TransferTab onToast={showToast} />
        </TabsContent>

        <TabsContent
          value="history"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <HistoryViewer onSwitchTab={(t) => setTab(t)} />
        </TabsContent>
      </Tabs>

      {/* Toast */}
      {toast && (
        <div
          role={toast.kind === "ok" ? "status" : "alert"}
          aria-live={toast.kind === "ok" ? "polite" : "assertive"}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 text-sm rounded-lg shadow-lg max-w-[calc(100vw-2rem)] sm:max-w-md motion-safe:animate-in motion-safe:slide-in-from-bottom-4 motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:ease-out ${
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
