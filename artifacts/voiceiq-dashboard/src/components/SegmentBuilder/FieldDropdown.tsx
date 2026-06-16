import { useTranslation } from "react-i18next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { ALL_FIELD_KEYS, FIELD_DISPLAY_INFO } from "./types";

interface FieldDropdownProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}

export default function FieldDropdown({ value, onChange, disabled }: FieldDropdownProps) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={t("campaigns.builder.segment.selectField")} />
      </SelectTrigger>
      <SelectContent>
        {ALL_FIELD_KEYS.map((k) => (
          <SelectItem key={k} value={k}>
            {t(FIELD_DISPLAY_INFO[k].labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
