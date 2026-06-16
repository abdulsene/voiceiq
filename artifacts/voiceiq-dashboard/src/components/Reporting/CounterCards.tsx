import { useTranslation } from "react-i18next";

import { MetricCard } from "@/components/ui/metric-card";

import { formatNumber, formatPct, type CampaignMetricsCounters, type CampaignMetricsRates } from "./types";

interface CounterCardsProps {
  counters: CampaignMetricsCounters;
  rates: CampaignMetricsRates;
}

export default function CounterCards({ counters, rates }: CounterCardsProps) {
  const { t } = useTranslation();

  // Row 1 — rate tiles. Tooltips spell out the formula so the meaning
  // doesn't drift from intuition; each label key resolves a default-
  // value fallback so a missing translation surfaces as the raw key
  // rather than crashing the layout.
  const rateCards = [
    {
      key: "connect_rate",
      label: t("campaigns.reporting.rates.connect"),
      value: formatPct(rates.connect_rate),
      tooltip: t("campaigns.reporting.rates.connect_tooltip"),
      accent: "success" as const,
    },
    {
      key: "voicemail_rate",
      label: t("campaigns.reporting.rates.voicemail"),
      value: formatPct(rates.voicemail_rate),
      tooltip: t("campaigns.reporting.rates.voicemail_tooltip"),
      accent: "default" as const,
    },
    {
      key: "skip_rate",
      label: t("campaigns.reporting.rates.skip"),
      value: formatPct(rates.skip_rate),
      tooltip: t("campaigns.reporting.rates.skip_tooltip"),
      accent: "warning" as const,
    },
    {
      key: "completion_rate",
      label: t("campaigns.reporting.rates.completion"),
      value: formatPct(rates.completion_rate),
      tooltip: t("campaigns.reporting.rates.completion_tooltip"),
      accent: "default" as const,
    },
  ];

  const counterCards = [
    { key: "target", value: counters.target },
    { key: "pending", value: counters.pending },
    { key: "scheduled", value: counters.scheduled },
    { key: "completed", value: counters.completed },
    { key: "succeeded", value: counters.succeeded },
    { key: "failed", value: counters.failed },
    { key: "voicemail", value: counters.voicemail },
    { key: "skipped", value: counters.skipped },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {rateCards.map((c) => (
          <MetricCard
            key={c.key}
            label={c.label}
            value={c.value}
            tooltip={c.tooltip}
            accent={c.accent}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {counterCards.map((c) => (
          <MetricCard
            key={c.key}
            label={t(`campaigns.reporting.counters.${c.key}`)}
            value={formatNumber(c.value)}
          />
        ))}
      </div>
    </div>
  );
}
