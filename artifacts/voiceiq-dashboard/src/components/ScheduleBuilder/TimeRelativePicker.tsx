import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import type { TimeRelativeScheduleDefinition } from "./types";

type Unit = "minutes" | "hours" | "days";

interface TimeRelativePickerProps {
  value: TimeRelativeScheduleDefinition;
  onChange: (next: TimeRelativeScheduleDefinition) => void;
  disabled?: boolean;
}

function minutesToParts(offsetMinutes: number): { value: number; unit: Unit } {
  // offset_minutes is negative when X-before semantics apply.
  const abs = Math.abs(offsetMinutes);
  if (abs >= 1440 && abs % 1440 === 0) return { value: abs / 1440, unit: "days" };
  if (abs >= 60 && abs % 60 === 0) return { value: abs / 60, unit: "hours" };
  return { value: abs, unit: "minutes" };
}

function partsToMinutes(value: number, unit: Unit): number {
  const factor = unit === "minutes" ? 1 : unit === "hours" ? 60 : 1440;
  return -1 * Math.abs(value) * factor;
}

export default function TimeRelativePicker({ value, onChange, disabled }: TimeRelativePickerProps) {
  const { t } = useTranslation();
  const parts = useMemo(() => minutesToParts(value.offset_minutes), [value.offset_minutes]);
  const [offsetValue, setOffsetValue] = useState<number>(parts.value);
  const [offsetUnit, setOffsetUnit] = useState<Unit>(parts.unit);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function emit(nextValue: number, nextUnit: Unit) {
    onChange({ ...value, offset_minutes: partsToMinutes(nextValue, nextUnit) });
  }

  const nonPositive = offsetValue <= 0;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-gray-900">{t("campaigns.builder.schedule.timeRelative.label")}</p>
        <p className="text-xs text-gray-500">{t("campaigns.builder.schedule.timeRelative.hint")}</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-gray-700">{t("campaigns.builder.schedule.timeRelative.sendCall")}</span>
        <Input
          type="number"
          min={1}
          step={1}
          className="w-24"
          disabled={disabled}
          value={offsetValue}
          onChange={(e) => {
            const raw = e.target.value;
            const n = raw === "" ? 0 : parseInt(raw, 10);
            const next = Number.isNaN(n) ? 0 : n;
            setOffsetValue(next);
            if (next > 0) emit(next, offsetUnit);
          }}
        />
        <Select
          value={offsetUnit}
          onValueChange={(u: string) => {
            const next = u as Unit;
            setOffsetUnit(next);
            if (offsetValue > 0) emit(offsetValue, next);
          }}
          disabled={disabled}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">{t("campaigns.builder.segment.units.minutes")}</SelectItem>
            <SelectItem value="hours">{t("campaigns.builder.segment.units.hours")}</SelectItem>
            <SelectItem value="days">{t("campaigns.builder.segment.units.days")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-gray-700">{t("campaigns.builder.schedule.timeRelative.beforeAppointment")}</span>
      </div>
      {nonPositive && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {t("campaigns.builder.schedule.timeRelative.warningNonPositive")}
        </p>
      )}

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          disabled={disabled}
          className="h-7 px-2 text-xs text-gray-600"
        >
          {advancedOpen ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
          {t("campaigns.builder.schedule.timeRelative.advanced")}
        </Button>
        {advancedOpen && (
          <div className="mt-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 space-y-1">
            <div>
              <span className="font-medium">{t("campaigns.builder.schedule.timeRelative.anchorSource")}:</span>{" "}
              <code className="text-[10px]">appointments.appointment_datetime</code>
            </div>
            <div>
              <span className="font-medium">{t("campaigns.builder.schedule.timeRelative.anchorFilter")}:</span>{" "}
              <code className="text-[10px]">status = confirmed</code>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
