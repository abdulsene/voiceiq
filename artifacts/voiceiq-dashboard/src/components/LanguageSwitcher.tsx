import { useTranslation } from "react-i18next";

type Variant = "dark" | "light";

interface LanguageSwitcherProps {
  variant?: Variant;
  className?: string;
}

const ORDER = ["en", "es", "fr"] as const;
type LangCode = (typeof ORDER)[number];

function normalize(lng: string | undefined): LangCode {
  if (lng?.startsWith("es")) return "es";
  if (lng?.startsWith("fr")) return "fr";
  return "en";
}

export default function LanguageSwitcher({
  variant = "light",
  className = "",
}: LanguageSwitcherProps) {
  const { i18n } = useTranslation();
  const current = normalize(i18n.language);

  const cycle = () => {
    const idx = ORDER.indexOf(current);
    const next = ORDER[(idx + 1) % ORDER.length];
    void i18n.changeLanguage(next);
  };

  const isDark = variant === "dark";
  const baseBtn = isDark
    ? "bg-white/[0.06] hover:bg-white/[0.12]"
    : "bg-slate-100 hover:bg-slate-200/80";
  const sep = isDark ? "text-gray-600" : "text-slate-400";
  const activeText = isDark ? "text-white" : "text-slate-900";
  const inactiveText = isDark ? "text-gray-500" : "text-slate-500";

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`Switch language (current: ${current.toUpperCase()})`}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-colors ${baseBtn} ${className}`}
    >
      {ORDER.map((code, i) => (
        <span key={code} className="flex items-center gap-1.5">
          <span
            className={`text-[11px] font-semibold transition-colors ${
              current === code ? activeText : inactiveText
            }`}
          >
            {code.toUpperCase()}
          </span>
          {i < ORDER.length - 1 && <span className={`${sep} text-[11px]`}>|</span>}
        </span>
      ))}
    </button>
  );
}
