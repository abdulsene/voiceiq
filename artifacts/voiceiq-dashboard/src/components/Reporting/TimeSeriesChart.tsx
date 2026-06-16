import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { format, parseISO } from "date-fns";
import { Bar, BarChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

import { STATE_COLORS, formatNumber, type CampaignMetricsTimeSeriesRow } from "./types";

interface TimeSeriesChartProps {
  data: CampaignMetricsTimeSeriesRow[];
}

// Order matters for the stack — earliest in the array = bottom of the
// stacked bar. Picked so successful outcomes anchor the bottom and
// noisy categories (skipped, voicemail) ride the top.
const SERIES_ORDER: Array<keyof Omit<CampaignMetricsTimeSeriesRow, "date">> = [
  "succeeded",
  "scheduled",
  "voicemail",
  "failed",
  "skipped",
];

export default function TimeSeriesChart({ data }: TimeSeriesChartProps) {
  const { t } = useTranslation();

  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    for (const key of SERIES_ORDER) {
      cfg[key] = {
        label: t(`campaigns.junctionState.${key}`, { defaultValue: key }),
        color: STATE_COLORS[key] ?? "#9ca3af",
      };
    }
    return cfg;
  }, [t]);

  const formatted = useMemo(
    () =>
      data.map((r) => ({
        ...r,
        // Pre-format the X label so recharts' tick formatter doesn't
        // have to re-parse on every redraw.
        label: (() => {
          try {
            return format(parseISO(r.date), "MMM d");
          } catch {
            return r.date;
          }
        })(),
      })),
    [data],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("campaigns.reporting.charts.timeSeries.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            {t("campaigns.reporting.charts.timeSeries.empty")}
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-[16/6] w-full max-h-80">
            <BarChart data={formatted} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
                formatter={(v: number, name: string) => [
                  formatNumber(v),
                  t(`campaigns.junctionState.${name}`, { defaultValue: name }),
                ]}
              />
              <Legend
                formatter={(v: string) => t(`campaigns.junctionState.${v}`, { defaultValue: v })}
              />
              {SERIES_ORDER.map((key) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId="a"
                  fill={STATE_COLORS[key] ?? "#9ca3af"}
                  radius={[0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
