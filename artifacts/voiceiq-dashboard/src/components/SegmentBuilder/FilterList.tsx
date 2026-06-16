import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import FilterRow from "./FilterRow";
import { ALL_FIELD_KEYS, FIELD_DISPLAY_INFO, type FilterClause } from "./types";

interface FilterListProps {
  kind: "all" | "any";
  clauses: FilterClause[];
  onChange: (next: FilterClause[]) => void;
  disabled?: boolean;
}

function blankClause(): FilterClause {
  const firstField = ALL_FIELD_KEYS[0];
  const info = FIELD_DISPLAY_INFO[firstField];
  const ops = info ? { text: "eq", boolean: "eq", integer: "eq", timestamp: "lt" }[info.type] : "eq";
  return { field: firstField, op: ops as FilterClause["op"], value: undefined };
}

export default function FilterList({ kind, clauses, onChange, disabled }: FilterListProps) {
  const { t } = useTranslation();
  const titleKey = kind === "all"
    ? "campaigns.builder.segment.allTitle"
    : "campaigns.builder.segment.anyTitle";
  const hintKey = kind === "all"
    ? "campaigns.builder.segment.allHint"
    : "campaigns.builder.segment.anyHint";
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-gray-900">{t(titleKey)}</h4>
        <p className="text-xs text-gray-500">{t(hintKey)}</p>
      </div>
      {clauses.length === 0 && (
        <div className="rounded-md border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
          {t("campaigns.builder.segment.empty")}
        </div>
      )}
      {clauses.map((c, idx) => (
        <FilterRow
          key={idx}
          clause={c}
          onChange={(next) => {
            const copy = clauses.slice();
            copy[idx] = next;
            onChange(copy);
          }}
          onRemove={() => onChange(clauses.filter((_, i) => i !== idx))}
          disabled={disabled}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => onChange([...clauses, blankClause()])}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        {t("campaigns.builder.segment.addRow")}
      </Button>
    </div>
  );
}
