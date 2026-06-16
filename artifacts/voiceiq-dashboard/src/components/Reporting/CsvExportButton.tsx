/**
 * Phase 2.7b — client-side CSV export for a single campaign's junction
 * rows.
 *
 * Server-side streaming was ruled out in 2.7-A: `window.location.href`
 * navigation can't carry the Authorization: Bearer header the backend
 * requires, so fetch + Blob is the only path that keeps auth working.
 * The Analytics.tsx precedent inspired the shape (Blob → ObjectURL →
 * <a download> → revoke) but its rows aren't escaped — we tighten that
 * here so contact names with commas or quotes don't poison the CSV.
 *
 * Pagination strategy:
 *   - Loop GET /api/business/campaigns/:id/leads?offset=N&limit=200
 *     accumulating into one array
 *   - Stop when either response.rows.length < limit (last page) OR
 *     total accumulated >= HARD_CAP_ROWS
 *   - Hard cap protects the browser from blowing up its memory on a
 *     mistaken multi-million-row export
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Download, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { fetchApi } from "@/lib/api";

interface CsvExportButtonProps {
  campaignId: string;
  /** Used to construct the download filename. */
  campaignName: string;
}

interface ActivityRow {
  id: string;
  lead_id: string | null;
  state: string;
  skip_reason: string | null;
  scheduled_call_id: string | null;
  scheduled_for: string | null;
  created_at: string;
  updated_at: string;
  leads?: { contact_name: string | null; contact_phone: string | null } | null;
}

interface ListResponse {
  rows: ActivityRow[];
  total: number;
}

const PAGE_SIZE = 200;
const HARD_CAP_ROWS = 2000;

const CSV_COLUMNS = [
  "campaign_id",
  "junction_id",
  "lead_id",
  "contact_name",
  "contact_phone",
  "state",
  "skip_reason",
  "scheduled_for",
  "scheduled_call_id",
  "created_at",
  "updated_at",
] as const;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  // RFC 4180 — wrap if contains comma, quote, CR, or LF; double-quote
  // any internal quotes.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function safeFilenameSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "campaign"
  );
}

export default function CsvExportButton({ campaignId, campaignName }: CsvExportButtonProps) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const accumulated: ActivityRow[] = [];
      let offset = 0;
      let hitCap = false;
      // Up to ceil(HARD_CAP_ROWS / PAGE_SIZE) iterations — at 2000/200
      // that's 10 trips. Bounded explicitly so a buggy backend returning
      // count: 0, rows: [] in a loop can't spin forever.
      const MAX_ITERATIONS = Math.ceil(HARD_CAP_ROWS / PAGE_SIZE) + 1;
      for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
        const data = (await fetchApi(
          `/business/campaigns/${campaignId}/leads?offset=${offset}&limit=${PAGE_SIZE}`,
        )) as ListResponse;
        const page = data.rows || [];
        if (page.length === 0) break;
        for (const r of page) {
          if (accumulated.length >= HARD_CAP_ROWS) {
            hitCap = true;
            break;
          }
          accumulated.push(r);
        }
        if (hitCap || page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      if (hitCap) {
        toast.warning(t("campaigns.reporting.export.capped"));
      }

      const lines: string[] = [];
      lines.push(CSV_COLUMNS.join(","));
      for (const r of accumulated) {
        lines.push(
          [
            csvEscape(campaignId),
            csvEscape(r.id),
            csvEscape(r.lead_id ?? ""),
            csvEscape(r.leads?.contact_name ?? ""),
            csvEscape(r.leads?.contact_phone ?? ""),
            csvEscape(r.state),
            csvEscape(r.skip_reason ?? ""),
            csvEscape(r.scheduled_for ?? ""),
            csvEscape(r.scheduled_call_id ?? ""),
            csvEscape(r.created_at),
            csvEscape(r.updated_at),
          ].join(","),
        );
      }
      const csv = lines.join("\r\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const today = new Date().toISOString().slice(0, 10);
      const filename = `campaign-${safeFilenameSlug(campaignName)}-${today}.csv`;
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e?.message || t("campaigns.reporting.export.failed"));
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={handleExport} disabled={exporting}>
      {exporting ? (
        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
      ) : (
        <Download className="h-4 w-4 mr-1.5" />
      )}
      {exporting ? t("campaigns.reporting.export.loading") : t("campaigns.reporting.export.button")}
    </Button>
  );
}
