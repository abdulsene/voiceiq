/**
 * MetricCard — generic "big number" card.
 *
 * Phase 2.7b: shipped for CounterCards / rate tiles but kept generic
 * (label + value + optional helper + tooltip + accent) so the next
 * dashboard surface that needs to surface a single metric doesn't
 * fork the pattern.
 *
 * Caller formats `value` — pass "85.7%", "1,234", "—" as appropriate.
 * That keeps the card's locale/format logic at the call site (where
 * the data shape is known) instead of guessing here.
 */

import * as React from "react";
import { HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface MetricCardProps {
  label: string;
  value: string | number;
  helper?: string;
  /** Hover help text — typically the formula or definition. */
  tooltip?: string;
  /** Visual accent — defaults to neutral. */
  accent?: "default" | "success" | "warning";
  className?: string;
}

const ACCENT_BORDER: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  default: "border-gray-200",
  success: "border-emerald-200",
  warning: "border-amber-200",
};

const ACCENT_VALUE: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  default: "text-gray-900",
  success: "text-emerald-700",
  warning: "text-amber-700",
};

export function MetricCard({
  label,
  value,
  helper,
  tooltip,
  accent = "default",
  className,
}: MetricCardProps) {
  return (
    <Card className={cn("border", ACCENT_BORDER[accent], className)}>
      <CardContent className="p-4">
        <div className="flex items-center gap-1.5">
          <p className="text-xs uppercase tracking-wide text-gray-500 font-medium">{label}</p>
          {tooltip && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label="More info"
                    className="text-gray-400 hover:text-gray-600 focus:outline-none focus:ring-1 focus:ring-ring rounded"
                  >
                    <HelpCircle className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-xs">{tooltip}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <div className={cn("text-2xl font-semibold tabular-nums mt-1", ACCENT_VALUE[accent])}>
          {value}
        </div>
        {helper && <p className="text-xs text-gray-500 mt-1">{helper}</p>}
      </CardContent>
    </Card>
  );
}
