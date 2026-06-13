/**
 * Single source of truth for lead urgency → callback SLA window.
 *
 * Consumers in Slice 3A:
 *   - lib/sms-templates.ts        — {{sla_window}} interpolation
 *   - routes/public-lead.ts       — expected_callback_window in the
 *                                   trust portal response
 *   - (future) cron SLA-breach    — checks lead.created_at +
 *                                   resolveSla(urgency).minutes
 *
 * Defaults live here; per-tenant overrides come from
 * business_configs.sla_overrides JSONB (no settings UI in Slice 3A,
 * but the override path is wired so support can flip a customer's
 * windows by hand if needed).
 *
 * Override shape (JSONB):
 *   { "emergency": { "minutes": 5 }, "low": { "minutes": 720 } }
 *   Missing keys fall through to SLA_DEFAULTS.
 */

export type Urgency = "low" | "medium" | "high" | "emergency";

export type SlaLocale = "en" | "es" | "fr";

export interface SlaWindow {
  minutes: number;
  label: Record<SlaLocale, string>;
}

export const SLA_DEFAULTS: Record<Urgency, SlaWindow> = {
  emergency: {
    minutes: 15,
    label: {
      en: "within 15 minutes",
      es: "en 15 minutos",
      fr: "sous 15 minutes",
    },
  },
  high: {
    minutes: 60,
    label: {
      en: "within the hour",
      es: "en una hora",
      fr: "sous une heure",
    },
  },
  medium: {
    minutes: 240,
    label: {
      en: "within 4 hours",
      es: "en 4 horas",
      fr: "sous 4 heures",
    },
  },
  low: {
    minutes: 1440,
    label: {
      en: "within 24 hours",
      es: "en 24 horas",
      fr: "sous 24 heures",
    },
  },
};

const URGENCY_KEYS: Urgency[] = ["low", "medium", "high", "emergency"];

function isUrgency(u: string): u is Urgency {
  return (URGENCY_KEYS as string[]).includes(u);
}

/**
 * Normalize a free-form urgency string (we accept anything the LLM
 * might produce) down to a known Urgency. Unknown values land on
 * 'medium' — the AI tool spec defaults to that anyway.
 */
export function normalizeUrgency(raw: string | null | undefined): Urgency {
  if (!raw) return "medium";
  const lower = raw.toLowerCase();
  return isUrgency(lower) ? lower : "medium";
}

/**
 * Resolve a single urgency to its SLA window, applying per-tenant
 * overrides on top of the defaults. Override JSONB shape:
 *   { "<urgency>": { "minutes": <int> } }
 * Only minutes is overridable today; label stays canonical so en/es/fr
 * remain consistent across tenants.
 */
export function resolveSla(
  urgency: Urgency,
  overrides: Record<string, unknown> | null | undefined,
): SlaWindow {
  const base = SLA_DEFAULTS[urgency];
  if (!overrides || typeof overrides !== "object") return base;
  const o = (overrides as Record<string, unknown>)[urgency];
  if (!o || typeof o !== "object") return base;
  const ov = o as { minutes?: unknown };
  const overrideMinutes = typeof ov.minutes === "number" && ov.minutes > 0 ? ov.minutes : null;
  if (overrideMinutes === null) return base;
  return { minutes: overrideMinutes, label: base.label };
}

/**
 * Localized one-liner ("within 15 minutes", "en 4 horas", …) suitable
 * for SMS interpolation or the trust portal banner.
 */
export function slaLabel(
  urgency: Urgency,
  locale: SlaLocale,
  overrides: Record<string, unknown> | null | undefined,
): string {
  const w = resolveSla(urgency, overrides);
  return w.label[locale];
}

/**
 * Computed callback window for the trust portal payload. We surface a
 * tolerance band rather than a single ETA — emergencies aren't always
 * sub-15min, and customers seeing a precise time and missing it by 2
 * minutes is worse than seeing a band.
 *
 * Band width: half of the SLA minutes, capped at 30. So:
 *   emergency (15m) → ±7.5 min  → 7 min before / 7 min after target
 *   high      (60m) → ±30 min
 *   medium   (240m) → ±30 min (capped)
 *   low     (1440m) → ±30 min (capped)
 */
export function expectedCallbackWindow(
  urgency: Urgency,
  createdAt: Date,
  overrides: Record<string, unknown> | null | undefined,
): { earliest: string; latest: string } {
  const w = resolveSla(urgency, overrides);
  const targetMs = createdAt.getTime() + w.minutes * 60_000;
  const halfBandMin = Math.min(Math.round(w.minutes / 2), 30);
  const earliest = new Date(targetMs - halfBandMin * 60_000).toISOString();
  const latest = new Date(targetMs + halfBandMin * 60_000).toISOString();
  return { earliest, latest };
}
