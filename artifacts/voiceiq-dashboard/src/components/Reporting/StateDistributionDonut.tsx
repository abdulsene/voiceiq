import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Cell, Legend, Pie, PieChart, Tooltip } from "recharts";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, type ChartConfig } from "@/components/ui/chart";

import { STATE_COLORS, formatNumber } from "./types";

interface StateDistributionDonutProps {
  data: Array<{ state: string; count: number }>;
}

export default function StateDistributionDonut({ data }: StateDistributionDonutProps) {
  const { t } = useTranslation();

  const total = useMemo(() => data.reduce((sum, r) => sum + r.count, 0), [data]);

  const chartConfig = useMemo<ChartConfig>(() => {
    const cfg: ChartConfig = {};
    for (const r of data) {
      cfg[r.state] = {
        label: t(`campaigns.junctionState.${r.state}`, { defaultValue: r.state }),
        color: STATE_COLORS[r.state] ?? "#6b7280",
      };
    }
    return cfg;
  }, [data, t]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("campaigns.reporting.charts.distribution.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className="text-sm text-gray-500 py-6 text-center">
            {t("campaigns.reporting.charts.distribution.empty")}
          </p>
        ) : (
          <div className="relative">
            <ChartContainer config={chartConfig} className="aspect-square max-h-72 w-full">
              <PieChart>
                <Tooltip
                  cursor={false}
                  formatter={(value: number, name: string) => [
                    formatNumber(value),
                    t(`campaigns.junctionState.${name}`, { defaultValue: name }),
                  ]}
                />
                <Pie
                  data={data}
                  dataKey="count"
                  nameKey="state"
                  innerRadius={60}
                  outerRadius={90}
                  strokeWidth={2}
                  stroke="#fff"
                >
                  {data.map((entry) => (
                    <Cell key={entry.state} fill={STATE_COLORS[entry.state] ?? "#6b7280"} />
                  ))}
                </Pie>
                <Legend
                  verticalAlign="bottom"
                  formatter={(v: string) => t(`campaigns.junctionState.${v}`, { defaultValue: v })}
                />
              </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center mt-[-2rem]">
              <span className="text-2xl font-semibold tabular-nums text-gray-900">
                {formatNumber(total)}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-gray-500">
                {t("campaigns.reporting.charts.distribution.totalLabel")}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
