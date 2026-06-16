/**
 * SegmentBuilder — composes FilterList ("All" + "Any") + JsonEditor with
 * a form/json view toggle. Shape mirrors segment-resolver.ts's DSL.
 *
 * The component is a controlled input: parent owns `value` + `onChange`.
 * Server validation errors flow back via `serverErrors` (rendered inline
 * under the builder).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Code2, FormInput } from "lucide-react";

import { Button } from "@/components/ui/button";

import FilterList from "./FilterList";
import JsonEditor from "./JsonEditor";
import type { FilterClause, SegmentDefinition } from "./types";

export interface SegmentBuilderProps {
  value: SegmentDefinition;
  onChange: (next: SegmentDefinition) => void;
  serverErrors?: string[];
  disabled?: boolean;
}

export default function SegmentBuilder({
  value,
  onChange,
  serverErrors,
  disabled,
}: SegmentBuilderProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<"form" | "json">("form");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-gray-900">{t("campaigns.builder.segment.title")}</h3>
          <p className="text-xs text-gray-500">{t("campaigns.builder.segment.description")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => setView(view === "form" ? "json" : "form")}
        >
          {view === "form" ? (
            <>
              <Code2 className="h-3.5 w-3.5 mr-1.5" />
              {t("campaigns.builder.segment.showJson")}
            </>
          ) : (
            <>
              <FormInput className="h-3.5 w-3.5 mr-1.5" />
              {t("campaigns.builder.segment.showForm")}
            </>
          )}
        </Button>
      </div>
      {view === "form" && (
        <div className="space-y-6">
          <FilterList
            kind="all"
            clauses={value.filters.all ?? []}
            onChange={(all: FilterClause[]) =>
              onChange({ ...value, filters: { ...value.filters, all } })
            }
            disabled={disabled}
          />
          <FilterList
            kind="any"
            clauses={value.filters.any ?? []}
            onChange={(any: FilterClause[]) =>
              onChange({ ...value, filters: { ...value.filters, any } })
            }
            disabled={disabled}
          />
        </div>
      )}
      {view === "json" && (
        <JsonEditor value={value} onChange={onChange} disabled={disabled} />
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
