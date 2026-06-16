import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  ALLOWED_OPERATORS_BY_TYPE,
  FIELD_DISPLAY_INFO,
  OP_LABEL_KEYS,
  type Op,
} from "./types";

interface OperatorDropdownProps {
  field: string;
  value: Op | "";
  onChange: (next: Op) => void;
  disabled?: boolean;
}

export default function OperatorDropdown({ field, value, onChange, disabled }: OperatorDropdownProps) {
  const { t } = useTranslation();
  const info = FIELD_DISPLAY_INFO[field];
  const ops = info ? ALLOWED_OPERATORS_BY_TYPE[info.type] : [];
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => onChange(v as Op)}
      disabled={disabled || !info}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={t("campaigns.builder.segment.selectOperator")} />
      </SelectTrigger>
      <SelectContent>
        {ops.map((op) => (
          <SelectItem key={op} value={op}>
            {t(OP_LABEL_KEYS[op])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
