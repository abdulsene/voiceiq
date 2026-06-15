/**
 * SMS template engine for Slice 3A — pillar 2.
 *
 * Three templates × three locales. Used by lib/sms-service.ts. Pure
 * string interpolation — no I/O, no validation beyond field
 * presence. Validation is the caller's responsibility (the route or
 * service that resolved the lead).
 *
 * TCPA compliance: every template ends with "Reply STOP to
 * unsubscribe." on first-message-of-conversation. The service layer
 * decides whether to append; the templates always carry it because
 * the cost of double-displaying STOP is zero and the cost of
 * forgetting it is a CTIA strike.
 *
 * Locale fallback: unknown locale → en. Missing context key → empty
 * string with a console.warn so the dev catches incomplete contexts
 * during testing.
 */

import { getPublicApiBase } from "./public-url";

export type SmsTemplate =
  | "lead_captured"
  | "callback_starting"
  | "callback_resolved";

export type SmsLocale = "en" | "es" | "fr";

export interface SmsTemplateContext {
  business_name?: string;
  contact_name?: string;
  brief_reason?: string;
  sla_window?: string;
  portal_url?: string;
  from_phone?: string;
  staff_name?: string;
}

type LocaleStrings = Record<SmsTemplate, string>;

const STRINGS: Record<SmsLocale, LocaleStrings> = {
  en: {
    lead_captured:
      "Hi {{contact_name}}, this is {{business_name}} — we received your callback request about {{brief_reason}}. Expect to hear back {{sla_window}}. Track status: {{portal_url}}. Reply STOP to unsubscribe.",
    callback_starting:
      "{{business_name}} is calling you in 30 seconds about {{brief_reason}} — answer the call from {{from_phone}}. Reply STOP to unsubscribe.",
    callback_resolved:
      "Thanks for chatting with {{staff_name}} at {{business_name}}! Did this resolve your needs? Reply YES, or anything else and we'll follow up. View summary: {{portal_url}}. Reply STOP to unsubscribe.",
  },
  es: {
    lead_captured:
      "Hola {{contact_name}}, soy {{business_name}} — recibimos tu solicitud de devolución de llamada sobre {{brief_reason}}. Te contactaremos {{sla_window}}. Estado: {{portal_url}}. Responde STOP para darte de baja.",
    callback_starting:
      "{{business_name}} te llamará en 30 segundos sobre {{brief_reason}} — contesta la llamada desde {{from_phone}}. Responde STOP para darte de baja.",
    callback_resolved:
      "¡Gracias por hablar con {{staff_name}} de {{business_name}}! ¿Esto resolvió tu necesidad? Responde SÍ, o cualquier otra cosa y te contactaremos. Resumen: {{portal_url}}. Responde STOP para darte de baja.",
  },
  fr: {
    lead_captured:
      "Bonjour {{contact_name}}, c'est {{business_name}} — nous avons reçu votre demande de rappel concernant {{brief_reason}}. Nous vous recontactons {{sla_window}}. Statut : {{portal_url}}. Répondez STOP pour vous désabonner.",
    callback_starting:
      "{{business_name}} vous appelle dans 30 secondes au sujet de {{brief_reason}} — répondez à l'appel de {{from_phone}}. Répondez STOP pour vous désabonner.",
    callback_resolved:
      "Merci d'avoir parlé avec {{staff_name}} de {{business_name}} ! Est-ce que cela a résolu votre besoin ? Répondez OUI, sinon nous vous recontacterons. Résumé : {{portal_url}}. Répondez STOP pour vous désabonner.",
  },
};

/**
 * Truncate a lead's free-text reason to a short SMS-friendly version.
 * Tries to cut at a word boundary above 40 chars; ellipsizes otherwise.
 */
export function briefReason(reason: string, maxChars = 80): string {
  const trimmed = (reason || "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
  return base.trim() + "…";
}

/**
 * Build the customer-facing trust portal URL for a token. Uses
 * PUBLIC_API_URL when set (Replit prod) and falls back to the
 * canonical host. Single source of truth so the 3 SMS integration
 * sites don't drift.
 */
export function portalUrlFromToken(token: string): string {
  const base = getPublicApiBase();
  return `${base}/r/${token}`;
}

/**
 * Render a template against the context. Unresolved placeholders log
 * a warning and are replaced with the empty string so the SMS still
 * sends (better than a literal `{{contact_name}}` reaching a customer).
 */
export function renderSmsTemplate(
  template: SmsTemplate,
  locale: SmsLocale,
  context: SmsTemplateContext,
): string {
  const resolvedLocale: SmsLocale = (["en", "es", "fr"] as SmsLocale[]).includes(locale)
    ? locale
    : "en";
  const tpl = STRINGS[resolvedLocale][template];
  return tpl.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = (context as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === "") {
      console.warn(`[sms-templates] missing context key '${key}' for template '${template}'`);
      return "";
    }
    return String(value);
  });
}
