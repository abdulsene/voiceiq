import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { BulkScheduleDefinition } from "./types";

interface BulkPickerProps {
  value: BulkScheduleDefinition;
  onChange: (next: BulkScheduleDefinition) => void;
  disabled?: boolean;
}

// 15-minute increments, "HH:mm" strings.
const TIME_OPTIONS = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) {
      out.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return out;
})();

export default function BulkPicker({ value, onChange, disabled }: BulkPickerProps) {
  const { t } = useTranslation();
  const initialDate = useMemo(() => {
    const d = new Date(value.fire_at);
    return isNaN(d.getTime()) ? new Date() : d;
  }, [value.fire_at]);

  const [date, setDate] = useState<Date>(initialDate);
  const [time, setTime] = useState<string>(
    `${String(initialDate.getHours()).padStart(2, "0")}:${String(initialDate.getMinutes()).padStart(2, "0")}`,
  );
  const [open, setOpen] = useState(false);

  function emit(nextDate: Date, nextTime: string) {
    const [hh, mm] = nextTime.split(":").map((x) => parseInt(x, 10));
    const merged = new Date(nextDate);
    merged.setHours(hh || 0, mm || 0, 0, 0);
    onChange({ ...value, fire_at: merged.toISOString() });
  }

  const isPast = useMemo(() => {
    const d = new Date(value.fire_at);
    return !isNaN(d.getTime()) && d.getTime() <= Date.now();
  }, [value.fire_at]);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium text-gray-900">{t("campaigns.builder.schedule.bulk.label")}</p>
        <p className="text-xs text-gray-500">{t("campaigns.builder.schedule.bulk.hint")}</p>
      </div>
      <div className="flex gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className={cn("flex-1 justify-start text-left font-normal")}
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {format(date, "yyyy-MM-dd")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={date}
              onSelect={(d) => {
                if (!d) return;
                setDate(d);
                emit(d, time);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <Select
          value={time}
          onValueChange={(nextTime) => {
            setTime(nextTime);
            emit(date, nextTime);
          }}
          disabled={disabled}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {TIME_OPTIONS.map((tval) => (
              <SelectItem key={tval} value={tval}>
                {tval}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isPast && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          {t("campaigns.builder.schedule.bulk.warningPast")}
        </p>
      )}
    </div>
  );
}
