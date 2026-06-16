/**
 * SegmentPreview — debounced POST /api/business/campaigns/preview.
 *
 * Shows a brand-blue lead count, parse/runtime error inline if any,
 * and a collapsible 10-row sample table. The parent (CampaignDetailPage)
 * passes both the segment_definition and the optional schedule_definition
 * so we can show scheduledFor in the sample when present.
 *
 * Receives a callback (onResponse) so the parent can stash the latest
 * preview response and reuse it for ScheduleBuilder's PreviewSampleTimes
 * — avoids two separate API calls.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";

import type { SegmentDefinition } from "./types";

export interface PreviewSampleRow {
  id: string;
  contact_name: string | null;
  contact_phone: string | null;
  scheduledFor?: string;
}

export interface PreviewResponse {
  count: number;
  sample: PreviewSampleRow[];
  segment_error?: string;
  schedule_error?: string;
}

interface SegmentPreviewProps {
  segment: SegmentDefinition;
  scheduleDefinition?: unknown;
  onResponse?: (response: PreviewResponse) => void;
}

const DEBOUNCE_MS = 300;

export default function SegmentPreview({
  segment,
  scheduleDefinition,
  onResponse,
}: SegmentPreviewProps) {
  const { t } = useTranslation();
  const [response, setResponse] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(async () => {
      setLoading(true);
      setErrorMsg(null);
      try {
        const body: Record<string, unknown> = { segment_definition: segment };
        if (scheduleDefinition !== undefined) body.schedule_definition = scheduleDefinition;
        const r = (await fetchApi("/business/campaigns/preview", {
          method: "POST",
          body: JSON.stringify(body),
        })) as PreviewResponse;
        setResponse(r);
        onResponse?.(r);
      } catch (e: any) {
        setErrorMsg(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(segment), JSON.stringify(scheduleDefinition)]);

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div className="flex items-center gap-3">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
        ) : (
          <div className="text-3xl font-semibold text-[#2E75B6] tabular-nums">
            {response?.count ?? 0}
          </div>
        )}
        <p className="text-sm text-gray-700">{t("campaigns.builder.segment.preview.leadsMatch")}</p>
      </div>
      {errorMsg && (
        <p className="text-xs text-red-600" role="alert">
          {errorMsg}
        </p>
      )}
      {response?.segment_error && (
        <p className="text-xs text-red-600" role="alert">
          {response.segment_error}
        </p>
      )}
      {response && response.sample.length > 0 && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="h-7 px-2 text-xs text-gray-600"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
            {t("campaigns.builder.segment.preview.showSample", { count: response.sample.length })}
          </Button>
          {expanded && (
            <div className="mt-2 rounded border border-gray-200 bg-white overflow-hidden">
              <table className="min-w-full text-xs">
                <thead className="bg-gray-50 text-left">
                  <tr>
                    <th className="px-3 py-1.5 font-medium text-gray-600">{t("campaigns.builder.segment.preview.colName")}</th>
                    <th className="px-3 py-1.5 font-medium text-gray-600">{t("campaigns.builder.segment.preview.colPhone")}</th>
                  </tr>
                </thead>
                <tbody>
                  {response.sample.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="px-3 py-1.5">{r.contact_name || "—"}</td>
                      <td className="px-3 py-1.5 font-mono">{r.contact_phone || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
