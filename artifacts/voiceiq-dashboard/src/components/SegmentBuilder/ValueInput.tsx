/**
 * ValueInput — dispatches the editor for a clause's value based on
 * (fieldType, op). Responsible for converting between UI state and the
 * canonical wire format documented in segment-resolver.ts:
 *
 *   text + (eq|neq)            → string
 *   text + (in|not_in)         → string[]
 *   text + (exists|not_exists) → undefined (renders nothing)
 *   boolean + (eq|neq)         → boolean (Switch)
 *   integer + scalar           → number
 *   timestamp + (older|newer)  → duration string "Nd" / "Nh" / etc.
 *   timestamp + (lt|lte|gt|gte) → ISO 8601 string (date picker)
 *   timestamp + (exists|not)   → undefined
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import { FIELD_DISPLAY_INFO, type Op } from "./types";

interface ValueInputProps {
  field: string;
  op: Op | "";
  value: unknown;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}

const DURATION_RE = /^(\d+)(s|m|h|d|w)$/;

export default function ValueInput({ field, op, value, onChange, disabled }: ValueInputProps) {
  const { t } = useTranslation();
  const info = FIELD_DISPLAY_INFO[field];
  if (!info || !op) return <div className="h-9" aria-hidden />;
  const { type } = info;

  if (op === "exists" || op === "not_exists") {
    return <div className="text-xs italic text-muted-foreground self-center px-2">{t("campaigns.builder.segment.value.noValueNeeded")}</div>;
  }

  // ── text ──────────────────────────────────────────────────────────
  if (type === "text") {
    if (op === "in" || op === "not_in") {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      if (info.enumValues) {
        const opts: MultiSelectOption[] = info.enumValues.map((v) => ({
          value: v,
          label: t(`campaigns.builder.segment.enum.${field.replace(/\./g, "_")}.${v}`, v),
        }));
        return (
          <MultiSelect
            options={opts}
            value={arr}
            onChange={(next) => onChange(next)}
            placeholder={t("campaigns.builder.segment.value.selectOne")}
            disabled={disabled}
          />
        );
      }
      // Free-form: comma-separated input.
      return (
        <Input
          value={arr.join(", ")}
          disabled={disabled}
          placeholder={t("campaigns.builder.segment.value.commaSeparated")}
          onChange={(e) => {
            const next = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            onChange(next);
          }}
        />
      );
    }
    // eq | neq
    const s = typeof value === "string" ? value : "";
    if (info.enumValues) {
      return (
        <Select value={s || undefined} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("campaigns.builder.segment.value.selectOne")} />
          </SelectTrigger>
          <SelectContent>
            {info.enumValues.map((v) => (
              <SelectItem key={v} value={v}>
                {t(`campaigns.builder.segment.enum.${field.replace(/\./g, "_")}.${v}`, v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        value={s}
        disabled={disabled}
        placeholder={t("campaigns.builder.segment.value.text")}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // ── boolean ───────────────────────────────────────────────────────
  if (type === "boolean") {
    const b = value === true;
    return (
      <div className="flex items-center gap-3 h-9 px-3 rounded-md border border-input">
        <Switch checked={b} onCheckedChange={onChange} disabled={disabled} />
        <span className="text-sm">{b ? t("campaigns.builder.segment.value.true") : t("campaigns.builder.segment.value.false")}</span>
      </div>
    );
  }

  // ── integer ───────────────────────────────────────────────────────
  if (type === "integer") {
    const n = typeof value === "number" ? value : "";
    return (
      <Input
        type="number"
        step={1}
        value={n === "" ? "" : String(n)}
        disabled={disabled}
        placeholder="0"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const parsed = parseInt(raw, 10);
          onChange(Number.isNaN(parsed) ? undefined : parsed);
        }}
      />
    );
  }

  // ── timestamp ─────────────────────────────────────────────────────
  if (op === "older_than" || op === "newer_than") {
    return <DurationInput value={typeof value === "string" ? value : ""} onChange={onChange} disabled={disabled} />;
  }
  // lt | lte | gt | gte → date+time
  return <DateTimePicker value={typeof value === "string" ? value : ""} onChange={onChange} disabled={disabled} />;
}

// ── helpers ──────────────────────────────────────────────────────────

interface DurationInputProps {
  value: string;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}

function DurationInput({ value, onChange, disabled }: DurationInputProps) {
  const { t } = useTranslation();
  const parsed = useMemo(() => {
    const m = DURATION_RE.exec(value);
    if (!m) return { n: "" as number | "", unit: "d" as "s" | "m" | "h" | "d" | "w" };
    return { n: parseInt(m[1], 10), unit: m[2] as "s" | "m" | "h" | "d" | "w" };
  }, [value]);

  function emit(n: number | "", unit: "s" | "m" | "h" | "d" | "w") {
    if (n === "" || Number.isNaN(n)) return onChange(undefined);
    onChange(`${n}${unit}`);
  }

  return (
    <div className="flex gap-2">
      <Input
        type="number"
        min={1}
        step={1}
        value={parsed.n === "" ? "" : String(parsed.n)}
        disabled={disabled}
        placeholder="30"
        className="flex-1"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const n = parseInt(raw, 10);
          emit(Number.isNaN(n) ? "" : n, parsed.unit);
        }}
      />
      <Select
        value={parsed.unit}
        onValueChange={(u) => emit(parsed.n, u as "s" | "m" | "h" | "d" | "w")}
        disabled={disabled}
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="m">{t("campaigns.builder.segment.units.minutes")}</SelectItem>
          <SelectItem value="h">{t("campaigns.builder.segment.units.hours")}</SelectItem>
          <SelectItem value="d">{t("campaigns.builder.segment.units.days")}</SelectItem>
          <SelectItem value="w">{t("campaigns.builder.segment.units.weeks")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

interface DateTimePickerProps {
  value: string;
  onChange: (next: unknown) => void;
  disabled?: boolean;
}

function DateTimePicker({ value, onChange, disabled }: DateTimePickerProps) {
  const { t } = useTranslation();
  const initial = useMemo(() => {
    if (!value) return { date: undefined as Date | undefined, time: "12:00" };
    const d = new Date(value);
    if (isNaN(d.getTime())) return { date: undefined, time: "12:00" };
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return { date: d, time: `${hh}:${mm}` };
  }, [value]);
  const [date, setDate] = useState<Date | undefined>(initial.date);
  const [time, setTime] = useState<string>(initial.time);
  const [open, setOpen] = useState(false);

  function emit(nextDate: Date | undefined, nextTime: string) {
    if (!nextDate) return onChange(undefined);
    const [hh, mm] = nextTime.split(":").map((x) => parseInt(x, 10));
    const merged = new Date(nextDate);
    merged.setHours(hh || 0, mm || 0, 0, 0);
    onChange(merged.toISOString());
  }

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            className={cn(
              "flex-1 justify-start text-left font-normal",
              !date && "text-muted-foreground",
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date ? format(date, "yyyy-MM-dd") : t("campaigns.builder.segment.value.pickDate")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={(d) => {
              setDate(d ?? undefined);
              emit(d ?? undefined, time);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      <Input
        type="time"
        value={time}
        disabled={disabled}
        className="w-28"
        onChange={(e) => {
          setTime(e.target.value);
          emit(date, e.target.value);
        }}
      />
    </div>
  );
}
