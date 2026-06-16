/**
 * ScheduleBuilder — top-level composition. Tabs between "Fire all at
 * once" (bulk) and "Per appointment" (time_relative). Stores both
 * branches' working state locally so users can flip between them
 * without losing input; only one is emitted upward at a time.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import BulkPicker from "./BulkPicker";
import TimeRelativePicker from "./TimeRelativePicker";
import {
  defaultBulkSchedule,
  defaultTimeRelativeSchedule,
  type BulkScheduleDefinition,
  type ScheduleDefinition,
  type TimeRelativeScheduleDefinition,
} from "./types";

export interface ScheduleBuilderProps {
  value: ScheduleDefinition;
  onChange: (next: ScheduleDefinition) => void;
  serverErrors?: string[];
  disabled?: boolean;
}

export default function ScheduleBuilder({
  value,
  onChange,
  serverErrors,
  disabled,
}: ScheduleBuilderProps) {
  const { t } = useTranslation();
  // Cache the off-strategy state so flipping tabs back and forth doesn't
  // discard user input.
  const [bulkCache, setBulkCache] = useState<BulkScheduleDefinition>(
    value.strategy === "bulk" ? value : defaultBulkSchedule(),
  );
  const [trCache, setTrCache] = useState<TimeRelativeScheduleDefinition>(
    value.strategy === "time_relative" ? value : defaultTimeRelativeSchedule(),
  );

  function handleTabChange(nextStrategy: string) {
    if (nextStrategy === "bulk") {
      onChange(bulkCache);
    } else if (nextStrategy === "time_relative") {
      onChange(trCache);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-gray-900">{t("campaigns.builder.schedule.title")}</h3>
        <p className="text-xs text-gray-500">{t("campaigns.builder.schedule.description")}</p>
      </div>
      <Tabs value={value.strategy} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="bulk" disabled={disabled}>
            {t("campaigns.builder.schedule.tabs.bulk")}
          </TabsTrigger>
          <TabsTrigger value="time_relative" disabled={disabled}>
            {t("campaigns.builder.schedule.tabs.timeRelative")}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {value.strategy === "bulk" && (
        <BulkPicker
          value={value}
          onChange={(next) => {
            setBulkCache(next);
            onChange(next);
          }}
          disabled={disabled}
        />
      )}
      {value.strategy === "time_relative" && (
        <TimeRelativePicker
          value={value}
          onChange={(next) => {
            setTrCache(next);
            onChange(next);
          }}
          disabled={disabled}
        />
      )}
      {serverErrors && serverErrors.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 space-y-1">
          {serverErrors.map((e, i) => (
            <p key={i}>{e}</p>
          ))}
        </div>
      )}
    </div>
  );
}
