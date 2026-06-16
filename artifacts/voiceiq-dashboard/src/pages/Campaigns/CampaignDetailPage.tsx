/**
 * Phase 2.6b — Campaign detail/edit page.
 *
 * Flat scroll layout: basic info → segment (SegmentBuilder) → schedule
 * (ScheduleBuilder) → limits → materialization counters → activity
 * table → footer actions.
 *
 * Live-preview integration: SegmentPreview triggers the debounced POST
 * to /api/business/campaigns/preview and reports the response upward
 * via onResponse. We pass that response to ScheduleBuilder's
 * PreviewSampleTimes so we get sample scheduledFor times without a
 * second API round-trip.
 *
 * Save = PATCH /api/business/campaigns/:id with the editable fields.
 * Activate/Pause = PATCH with { status }. Delete = DELETE → server
 * returns canceled_call_count + deleted_junction_count via the
 * delete_campaign_with_cancellations RPC; we surface those in the
 * success toast.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, Link } from "wouter";
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Play,
  Pause,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SegmentBuilder,
  SegmentPreview,
  defaultSegment,
  type SegmentDefinition,
  type PreviewResponse,
} from "@/components/SegmentBuilder";
import {
  ScheduleBuilder,
  PreviewSampleTimes,
  defaultBulkSchedule,
  type ScheduleDefinition,
} from "@/components/ScheduleBuilder";
import { fetchApi } from "@/lib/api";

interface Campaign {
  id: string;
  business_id: string;
  name: string;
  call_objective: string;
  status: string;
  agent_id: string | null;
  target_count: number | null;
  scheduled_count: number | null;
  completed_count: number | null;
  succeeded_count: number | null;
  failed_count: number | null;
  voicemail_count: number | null;
  daily_cap: number | null;
  voicemail_text_override: string | null;
  segment_definition: SegmentDefinition | null;
  schedule_definition: ScheduleDefinition | null;
  schedule_strategy: string | null;
  last_expansion_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CampaignDetailPageProps {
  campaignId: string;
}

const OBJECTIVES = ["appointment_reminder", "winback", "follow_up", "review_request", "general"];
const STATUSES = ["draft", "queued", "active", "paused", "completed", "cancelled"];

function fmtRelative(iso: string | null, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return t("leads.relative.justNow");
  const min = Math.round(diffSec / 60);
  if (min < 60) return t("leads.relative.minutesAgo", { count: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("leads.relative.hoursAgo", { count: hr });
  const day = Math.round(hr / 24);
  if (day < 30) return t("leads.relative.daysAgo", { count: day });
  const mo = Math.round(day / 30);
  return t("leads.relative.monthsAgo", { count: mo });
}

export default function CampaignDetailPage({ campaignId }: CampaignDetailPageProps) {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [original, setOriginal] = useState<Campaign | null>(null);

  // Editable working state. Initialised after fetch.
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("appointment_reminder");
  const [status, setStatus] = useState("draft");
  const [voicemailOverride, setVoicemailOverride] = useState("");
  const [segment, setSegment] = useState<SegmentDefinition>(defaultSegment());
  const [schedule, setSchedule] = useState<ScheduleDefinition>(defaultBulkSchedule());
  const [dailyCapEnabled, setDailyCapEnabled] = useState(false);
  const [dailyCap, setDailyCap] = useState<number>(50);
  const [agentId, setAgentId] = useState("");

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Activity table state.
  const [leadsRows, setLeadsRows] = useState<any[]>([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [leadsOffset, setLeadsOffset] = useState(0);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const LEADS_PAGE = 20;

  const fetchSeqRef = useRef(0);

  // ── Load campaign ─────────────────────────────────────────────────
  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const data = (await fetchApi(`/business/campaigns/${campaignId}`)) as { campaign: Campaign };
        if (cancelled || seq !== fetchSeqRef.current) return;
        const c = data.campaign;
        setOriginal(c);
        setName(c.name);
        setObjective(c.call_objective);
        setStatus(c.status);
        setVoicemailOverride(c.voicemail_text_override || "");
        setSegment(c.segment_definition || defaultSegment());
        setSchedule(c.schedule_definition || defaultBulkSchedule());
        setDailyCapEnabled(c.daily_cap !== null && c.daily_cap !== undefined);
        setDailyCap(c.daily_cap ?? 50);
        setAgentId(c.agent_id || "");
      } catch (e: any) {
        if (cancelled || seq !== fetchSeqRef.current) return;
        setLoadError(e?.message || String(e));
      } finally {
        if (!cancelled && seq === fetchSeqRef.current) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId]);

  // ── Load campaign-leads (activity) ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLeadsLoading(true);
    (async () => {
      try {
        const p = new URLSearchParams();
        p.set("offset", String(leadsOffset));
        p.set("limit", String(LEADS_PAGE));
        const data = (await fetchApi(`/business/campaigns/${campaignId}/leads?${p.toString()}`)) as {
          rows: any[];
          total: number;
        };
        if (cancelled) return;
        setLeadsRows(data.rows || []);
        setLeadsTotal(data.total ?? 0);
      } catch {
        if (cancelled) return;
        // Non-fatal — leave previous state.
      } finally {
        if (!cancelled) setLeadsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, leadsOffset]);

  // ── Save (PATCH) ──────────────────────────────────────────────────
  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {
        name,
        call_objective: objective,
        status,
        voicemail_text_override: voicemailOverride.trim() === "" ? null : voicemailOverride,
        agent_id: agentId.trim() === "" ? null : agentId,
        segment_definition: segment,
        schedule_definition: schedule,
        schedule_strategy: schedule.strategy,
        daily_cap: dailyCapEnabled ? dailyCap : null,
      };
      const resp = (await fetchApi(`/business/campaigns/${campaignId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })) as { campaign: Campaign };
      setOriginal(resp.campaign);
      toast.success(t("campaigns.detail.toast.saved"));
    } catch (e: any) {
      setSaveError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── Activate / Pause ──────────────────────────────────────────────
  async function handleActivateToggle() {
    if (activating) return;
    const nextStatus = status === "active" ? "paused" : "active";
    setActivating(true);
    try {
      const resp = (await fetchApi(`/business/campaigns/${campaignId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: nextStatus }),
      })) as { campaign: Campaign };
      setStatus(resp.campaign.status);
      setOriginal(resp.campaign);
      toast.success(
        nextStatus === "active"
          ? t("campaigns.detail.toast.activated")
          : t("campaigns.detail.toast.paused"),
      );
    } catch (e: any) {
      toast.error(e?.message || String(e));
    } finally {
      setActivating(false);
    }
  }

  // ── Delete ────────────────────────────────────────────────────────
  async function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      const resp = (await fetchApi(`/business/campaigns/${campaignId}`, {
        method: "DELETE",
      })) as { canceled_call_count: number; deleted_junction_count: number };
      toast.success(
        t("campaigns.detail.toast.deleted", {
          canceled: resp.canceled_call_count ?? 0,
        }),
      );
      setLocation("/campaigns");
    } catch (e: any) {
      toast.error(e?.message || String(e));
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  // ── Computed ──────────────────────────────────────────────────────
  const counters = useMemo(() => {
    if (!original) return null;
    return [
      { key: "target", value: original.target_count ?? 0 },
      { key: "scheduled", value: original.scheduled_count ?? 0 },
      { key: "completed", value: original.completed_count ?? 0 },
      { key: "succeeded", value: original.succeeded_count ?? 0 },
      { key: "failed", value: original.failed_count ?? 0 },
      { key: "voicemail", value: original.voicemail_count ?? 0 },
    ];
  }, [original]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-6 space-y-4">
        <div className="h-8 w-64 bg-gray-100 animate-pulse rounded" />
        <div className="h-32 bg-gray-50 animate-pulse rounded-xl" />
        <div className="h-64 bg-gray-50 animate-pulse rounded-xl" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-5xl mx-auto p-6">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{loadError}</span>
        </div>
        <div className="mt-4">
          <Link href="/campaigns" className="text-sm text-[#2E75B6] hover:underline">
            <ArrowLeft className="inline h-3.5 w-3.5 mr-1" />
            {t("campaigns.detail.backToList")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/campaigns" className="text-sm text-gray-600 hover:text-gray-900 flex items-center">
          <ArrowLeft className="h-4 w-4 mr-1" />
          {t("campaigns.detail.backToList")}
        </Link>
        <span className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full border bg-gray-50 text-gray-700 border-gray-200 ml-auto">
          {t(`campaigns.status.${status}`, status)}
        </span>
      </div>
      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-2xl md:text-3xl font-bold tracking-tight border-0 px-0 shadow-none focus-visible:ring-0 h-auto py-1"
          placeholder={t("campaigns.detail.namePlaceholder")}
        />
      </div>

      {/* 1. Basic info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.basic.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="objective">{t("campaigns.detail.basic.objective")}</Label>
              <Select value={objective} onValueChange={setObjective}>
                <SelectTrigger id="objective"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OBJECTIVES.map((o) => (
                    <SelectItem key={o} value={o}>{t(`campaigns.objective.${o}`, o)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="status">{t("campaigns.detail.basic.status")}</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{t(`campaigns.status.${s}`, s)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent">{t("campaigns.detail.basic.agentId")}</Label>
              <Input id="agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder={t("campaigns.detail.basic.agentIdPlaceholder")} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="voicemail">{t("campaigns.detail.basic.voicemailOverride")}</Label>
            <Textarea
              id="voicemail"
              value={voicemailOverride}
              onChange={(e) => setVoicemailOverride(e.target.value)}
              placeholder={t("campaigns.detail.basic.voicemailPlaceholder")}
              rows={3}
            />
            <p className="text-xs text-gray-500">{t("campaigns.detail.basic.voicemailHint")}</p>
          </div>
        </CardContent>
      </Card>

      {/* 2. Targeting */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.targeting.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <SegmentBuilder value={segment} onChange={setSegment} />
          <SegmentPreview
            segment={segment}
            scheduleDefinition={schedule}
            onResponse={setPreview}
          />
        </CardContent>
      </Card>

      {/* 3. Timing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.timing.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ScheduleBuilder value={schedule} onChange={setSchedule} />
          <PreviewSampleTimes preview={preview} />
        </CardContent>
      </Card>

      {/* 4. Limits */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.limits.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <Switch checked={dailyCapEnabled} onCheckedChange={setDailyCapEnabled} />
            <Label className="text-sm">
              {dailyCapEnabled
                ? t("campaigns.detail.limits.capEnabled")
                : t("campaigns.detail.limits.unlimited")}
            </Label>
          </div>
          {dailyCapEnabled && (
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                step={1}
                className="w-32"
                value={dailyCap}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  setDailyCap(Number.isNaN(n) ? 0 : Math.max(0, n));
                }}
              />
              <span className="text-sm text-gray-600">{t("campaigns.detail.limits.callsPerDay")}</span>
            </div>
          )}
          <p className="text-xs text-gray-500">{t("campaigns.detail.limits.hint")}</p>
        </CardContent>
      </Card>

      {/* 5. Materialization */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.materialization.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-center">
            {counters?.map((c) => (
              <div key={c.key} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                <div className="text-xl font-semibold tabular-nums text-gray-900">{c.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">
                  {t(`campaigns.detail.materialization.counters.${c.key}`)}
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-3">
            {t("campaigns.detail.materialization.lastExpansion")}:{" "}
            <span className="font-medium">{fmtRelative(original?.last_expansion_at ?? null, t)}</span>
          </p>
        </CardContent>
      </Card>

      {/* 6. Activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("campaigns.detail.activity.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {leadsLoading && leadsRows.length === 0 ? (
            <div className="h-24 bg-gray-50 animate-pulse rounded" />
          ) : leadsRows.length === 0 ? (
            <p className="text-sm text-gray-500">{t("campaigns.detail.activity.empty")}</p>
          ) : (
            <div className="overflow-hidden rounded border border-gray-200">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.detail.activity.col.lead")}</th>
                    <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.detail.activity.col.phone")}</th>
                    <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.detail.activity.col.state")}</th>
                    <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.detail.activity.col.skipReason")}</th>
                    <th className="px-3 py-2 font-medium text-gray-600">{t("campaigns.detail.activity.col.scheduledFor")}</th>
                  </tr>
                </thead>
                <tbody>
                  {leadsRows.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="px-3 py-1.5">{r.leads?.contact_name || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{r.leads?.contact_phone || "—"}</td>
                      <td className="px-3 py-1.5">{t(`campaigns.junctionState.${r.state}`, { defaultValue: r.state })}</td>
                      <td className="px-3 py-1.5">{r.skip_reason ? t(`campaigns.skipReason.${r.skip_reason}`, { defaultValue: r.skip_reason }) : "—"}</td>
                      <td className="px-3 py-1.5">{r.scheduled_for ? new Date(r.scheduled_for).toLocaleString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {leadsTotal > LEADS_PAGE && (
            <div className="flex items-center justify-between mt-3 text-xs text-gray-600">
              <span>
                {t("campaigns.list.showingRange", {
                  from: leadsOffset + 1,
                  to: Math.min(leadsOffset + LEADS_PAGE, leadsTotal),
                  total: leadsTotal,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={leadsOffset === 0}
                  onClick={() => setLeadsOffset(Math.max(0, leadsOffset - LEADS_PAGE))}
                >
                  {t("campaigns.list.prev")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={leadsOffset + LEADS_PAGE >= leadsTotal}
                  onClick={() => setLeadsOffset(leadsOffset + LEADS_PAGE)}
                >
                  {t("campaigns.list.next")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Footer actions */}
      {saveError && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{saveError}</div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-gray-200">
        <Button
          type="button"
          variant="outline"
          onClick={() => setDeleteOpen(true)}
          className="text-red-600 hover:bg-red-50 mr-auto"
        >
          <Trash2 className="h-4 w-4 mr-1" />
          {t("campaigns.detail.actions.delete")}
        </Button>
        <Button type="button" variant="outline" onClick={handleActivateToggle} disabled={activating}>
          {activating ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : status === "active" ? (
            <Pause className="h-4 w-4 mr-1" />
          ) : (
            <Play className="h-4 w-4 mr-1" />
          )}
          {status === "active"
            ? t("campaigns.detail.actions.pause")
            : t("campaigns.detail.actions.activate")}
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="bg-[#2E75B6] hover:bg-[#256094]"
        >
          {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {t("campaigns.detail.actions.save")}
        </Button>
      </div>

      {/* Delete confirmation */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("campaigns.detail.deleteConfirm.title")}</DialogTitle>
            <DialogDescription>
              {t("campaigns.detail.deleteConfirm.body", {
                scheduled: original?.scheduled_count ?? 0,
                target: original?.target_count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t("campaigns.detail.deleteConfirm.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              {t("campaigns.detail.deleteConfirm.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
