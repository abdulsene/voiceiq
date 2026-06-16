import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

import FieldDropdown from "./FieldDropdown";
import OperatorDropdown from "./OperatorDropdown";
import ValueInput from "./ValueInput";
import {
  ALLOWED_OPERATORS_BY_TYPE,
  FIELD_DISPLAY_INFO,
  type FilterClause,
  type Op,
} from "./types";

interface FilterRowProps {
  clause: FilterClause;
  onChange: (next: FilterClause) => void;
  onRemove: () => void;
  disabled?: boolean;
}

export default function FilterRow({ clause, onChange, onRemove, disabled }: FilterRowProps) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-12 gap-2 items-start">
      <div className="col-span-12 md:col-span-4">
        <FieldDropdown
          value={clause.field}
          onChange={(field) => {
            const info = FIELD_DISPLAY_INFO[field];
            const allowed = info ? ALLOWED_OPERATORS_BY_TYPE[info.type] : [];
            const nextOp = allowed.includes(clause.op) ? clause.op : (allowed[0] ?? "eq");
            onChange({ field, op: nextOp as Op, value: undefined });
          }}
          disabled={disabled}
        />
      </div>
      <div className="col-span-6 md:col-span-3">
        <OperatorDropdown
          field={clause.field}
          value={clause.op}
          onChange={(op) => onChange({ ...clause, op, value: undefined })}
          disabled={disabled}
        />
      </div>
      <div className="col-span-5 md:col-span-4">
        <ValueInput
          field={clause.field}
          op={clause.op}
          value={clause.value}
          onChange={(value) => onChange({ ...clause, value })}
          disabled={disabled}
        />
      </div>
      <div className="col-span-1 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          disabled={disabled}
          aria-label={t("campaigns.builder.segment.removeRow")}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
