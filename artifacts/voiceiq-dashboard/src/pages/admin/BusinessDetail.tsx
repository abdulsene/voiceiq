/**
 * Stage 6 Phase 3B — admin drill-in at /admin/businesses/:business_id.
 *
 * Reuses VoiceTab + PromptEditor + HistoryViewer via the apiBase prop
 * (=`admin/business/${businessId}`). The three components do their
 * own initial fetches via apiBase; this page only fetches the
 * combined GET /api/admin/business/:businessId for the header
 * (business_name, plan, owner_email, agent_id status).
 *
 * Permission UX mirrors AdminAuditLogs / BusinessesList: nav visible
 * to all, server-side 403 → "Admin access required" empty state on
 * the page itself.
 *
 * Red banner: "ADMIN OVERRIDE — Editing {business_name} on behalf of
 * customer. All changes audit-logged as 'admin_raw'." The banner is
 * the visual anchor that distinguishes the admin override surface
 * from the customer self-edit at /settings/ai.
 */

import { useEffect, useState } from "react";
import { Link, useRoute } from "wouter";
import {
  ArrowLeft,
  Briefcase,
  Mail,
  RefreshCw,
  Shield,
  ShieldAlert,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { getAuthHeaders } from "@/lib/api";

import VoiceTab from "../AiSettings/VoiceTab";
import PromptEditor from "../AiSettings/PromptEditor";
import HistoryViewer from "../AiSettings/HistoryViewer";

// ───────────────────────────────────────────────────────────────────────
// Types — mirror the Phase 1 combined GET response shape

interface BusinessSummary {
  business_id: string;
  business_name: string | null;
  plan_id: string | null;
  subscription_status: string | null;
  agent_id: string | null;
  voice_id: string | null;
  voice_last_synced_at: string | null;
  voice_sync_error: string | null;
  prompt_updated_at: string | null;
  prompt_sync_error: string | null;
  created_at: string | null;
  owner_email: string | null;
}

interface BusinessDetailResponse {
  business: BusinessSummary;
}

type TabKey = "voice" | "prompt" | "history";

function planLabel(planId: string | null): string {
  if (!planId) return "—";
  return planId.charAt(0).toUpperCase() + planId.slice(1);
}

// ───────────────────────────────────────────────────────────────────────
// Component

export default function BusinessDetail() {
  const [, params] = useRoute<{ businessId: string }>("/admin/businesses/:businessId");
  const businessId = params?.businessId ?? "";
  const apiBase = `admin/business/${businessId}`;

  const [business, setBusiness] = useState<BusinessSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const [toast, setToast] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [tab, setTab] = useState<TabKey>("voice");

  function showToast(text: string, kind: "ok" | "err"): void {
    setToast({ text, kind });
    setTimeout(() => setToast(null), 3500);
  }

  async function loadHeader(): Promise<void> {
    setLoading(true);
    setError(null);
    setBlocked(false);
    setNotFound(false);
    try {
      const res = await fetch(`/api/admin/business/${businessId}`, {
        headers: getAuthHeaders(),
      });
      if (res.status === 403) {
        setBlocked(true);
        setLoading(false);
        return;
      }
      if (res.status === 404) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as BusinessDetailResponse;
      setBusiness(data.business);
      setLoading(false);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!businessId) return;
    void loadHeader();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // ── Admin blocked gate ────────────────────────────────────────────────
  if (blocked) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
        <BackLink />
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="pt-10 pb-10 text-center space-y-3">
            <Shield className="h-10 w-10 mx-auto text-amber-600" />
            <h2 className="text-lg font-semibold text-gray-900">
              Admin access required
            </h2>
            <p className="text-sm text-gray-600 max-w-md mx-auto">
              Your account doesn't have permission to view customer
              businesses. Contact a super_admin to request access.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── 404 ───────────────────────────────────────────────────────────────
  if (notFound) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
        <BackLink />
        <Card>
          <CardContent className="pt-10 pb-10 text-center space-y-3">
            <Briefcase className="h-10 w-10 mx-auto text-gray-500" />
            <h2 className="text-lg font-semibold text-gray-900">
              Business not found
            </h2>
            <p className="text-sm text-gray-600 max-w-md mx-auto">
              No business with ID{" "}
              <span className="font-mono text-xs">{businessId}</span>{" "}
              exists. It may have been deleted, or the URL may be wrong.
            </p>
            <Link href="/admin/businesses">
              <a>
                <Button variant="outline" size="sm">
                  Back to list
                </Button>
              </a>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Error (non-403, non-404) ──────────────────────────────────────────
  if (error) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
        <BackLink />
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 flex items-start justify-between gap-3 flex-wrap">
            <p className="text-red-700 text-sm flex-1 min-w-0">
              Couldn't load business: {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadHeader()}
              disabled={loading}
              className="shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
              />
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <BackLink />

      {/* Red admin-override banner */}
      <div
        role="note"
        className="bg-red-50 border border-red-200 rounded-lg p-3 md:p-4 flex items-start gap-3"
      >
        <ShieldAlert
          className="h-5 w-5 text-red-700 shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-red-800">
            ADMIN OVERRIDE
          </p>
          <p className="text-xs text-red-700 mt-0.5">
            {loading || !business
              ? "Editing this business on behalf of the customer. "
              : `Editing ${business.business_name ?? "this business"} on behalf of the customer. `}
            All changes audit-logged as <span className="font-mono">admin_raw</span>.
          </p>
        </div>
      </div>

      {/* Header */}
      {loading || !business ? (
        <HeaderSkeleton />
      ) : (
        <Header business={business} />
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="prompt">Prompt</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>

        <TabsContent
          value="voice"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <VoiceTab apiBase={apiBase} onToast={showToast} />
        </TabsContent>

        <TabsContent
          value="prompt"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <PromptEditor apiBase={apiBase} onToast={showToast} />
        </TabsContent>

        <TabsContent
          value="history"
          className="mt-6 data-[state=active]:motion-safe:animate-in data-[state=active]:motion-safe:fade-in-0 data-[state=active]:motion-safe:duration-150 data-[state=active]:motion-safe:ease-out"
        >
          <HistoryViewer apiBase={apiBase} onSwitchTab={(t) => setTab(t)} />
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

// ───────────────────────────────────────────────────────────────────────
// Subcomponents

function BackLink() {
  return (
    <Link
      href="/admin/businesses"
      className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
    >
      <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
      Customer Businesses
    </Link>
  );
}

function HeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-64" />
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-48" />
      </div>
    </div>
  );
}

function Header({ business }: { business: BusinessSummary }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">
            {business.business_name ?? "(unnamed)"}
          </h1>
          <p className="font-mono text-xs text-gray-500 mt-1 break-all">
            {business.business_id}
          </p>
        </div>
        <Badge variant="outline" className="shrink-0">
          {planLabel(business.plan_id)}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
        {business.owner_email && (
          <a
            href={`mailto:${business.owner_email}`}
            className="inline-flex items-center gap-1 text-[#2E75B6] hover:underline"
            aria-label={`Email ${business.owner_email}`}
          >
            <Mail className="h-3 w-3" aria-hidden="true" />
            {business.owner_email}
          </a>
        )}
        {business.agent_id ? (
          <span>
            agent{" "}
            <span className="font-mono text-[11px]">{business.agent_id}</span>
          </span>
        ) : (
          <span className="text-amber-700">no agent configured</span>
        )}
      </div>
    </div>
  );
}
