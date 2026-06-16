import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui/textarea";

import { parseSegmentDefinition } from "./parse";
import type { SegmentDefinition } from "./types";

interface JsonEditorProps {
  value: SegmentDefinition;
  onChange: (next: SegmentDefinition) => void;
  disabled?: boolean;
}

export default function JsonEditor({ value, onChange, disabled }: JsonEditorProps) {
  const { t } = useTranslation();
  // Local text state — only push to parent on blur after a successful
  // parse. Keeping a separate buffer lets the user mid-type something
  // that's transiently invalid without the parent thrashing.
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  // Sync downward when parent updates value (e.g., switching from form
  // view back to json with edits made there).
  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  function tryCommit(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e: any) {
      setError(`JSON: ${e?.message || String(e)}`);
      return;
    }
    const r = parseSegmentDefinition(parsed);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    onChange(r.value);
  }

  return (
    <div className="space-y-2">
      <Textarea
        value={text}
        disabled={disabled}
        rows={12}
        spellCheck={false}
        className="font-mono text-xs"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => tryCommit(e.target.value)}
      />
      <p className="text-xs text-gray-500">{t("campaigns.builder.segment.jsonHint")}</p>
      {error && (
        <p className="text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
