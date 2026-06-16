import { useTranslation } from "react-i18next";

import type { PreviewResponse } from "@/components/SegmentBuilder";

interface PreviewSampleTimesProps {
  preview: PreviewResponse | null;
}

const MAX = 5;

function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // Locale-aware, includes timezone abbreviation when available.
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export default function PreviewSampleTimes({ preview }: PreviewSampleTimesProps) {
  const { t } = useTranslation();
  if (!preview) return null;
  if (preview.schedule_error) {
    return (
      <p className="text-xs text-red-600 mt-2" role="alert">
        {preview.schedule_error}
      </p>
    );
  }
  const rows = preview.sample.filter((r) => r.scheduledFor).slice(0, MAX);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-gray-500 mt-2">
        {t("campaigns.builder.schedule.preview.noMatches")}
      </p>
    );
  }
  return (
    <div className="mt-3 rounded border border-gray-200 bg-white">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 text-left">
          <tr>
            <th className="px-3 py-1.5 font-medium text-gray-600">{t("campaigns.builder.schedule.preview.colLead")}</th>
            <th className="px-3 py-1.5 font-medium text-gray-600">{t("campaigns.builder.schedule.preview.colWhen")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-gray-100">
              <td className="px-3 py-1.5">{r.contact_name || r.contact_phone || r.id}</td>
              <td className="px-3 py-1.5 tabular-nums">{r.scheduledFor ? fmtLocal(r.scheduledFor) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
