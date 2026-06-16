import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

import { formatNumber } from "./types";

interface SkipReasonParetoProps {
  data: Array<{ reason: string; count: number }>;
}

const BAR_COLOR = "#f59e0b";

export default function SkipReasonPareto({ data }: SkipReasonParetoProps) {
  const { t } = useTranslation();

  // Map raw reason → translated label for the y-axis. Defaults to the
  // raw key so an unknown reason (new backend addition) still renders
  // rather than vanishing.
  const labelled = useMemo(
    () =>
      data.map((r) => ({
        reason: r.reason,
        label: t(`campaigns.skipReason.${r.reason}`, { defaultValue: r.reason }),
        count: r.count,
      })),
    [data, t],
  );

  const chartConfig: ChartConfig = {
    count: { label: t("campaigns.reporting.charts.skipPareto.countLabel"), color: BAR_COLOR },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("campaigns.reporting.charts.skipPareto.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            {t("campaigns.reporting.charts.skipPareto.empty")}
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="aspect-[16/10] max-h-80 w-full">
            <BarChart
              data={labelled}
              layout="vertical"
              margin={{ top: 8, right: 16, bottom: 8, left: 16 }}
            >
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="label"
                width={140}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <Tooltip
                cursor={{ fill: "rgba(0,0,0,0.04)" }}
                formatter={(v: number) => [formatNumber(v), t("campaigns.reporting.charts.skipPareto.countLabel")]}
              />
              <Bar dataKey="count" fill={BAR_COLOR} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
