/**
 * Transfer tab — operator-transfer settings. Redesigned in 1.3 after a
 * customer reported "the toggle does nothing." Diagnosis was a UX trap,
 * not a Radix bug: the original used shadcn <Switch>, flipping it
 * updated state correctly but the surrounding UX showed zero visible
 * downstream change — no progressive disclosure, no "unsaved changes"
 * indicator, and Save flipped from disabled-because-clean to
 * disabled-because-phoneMissing the moment enabled went true. The
 * customer perceived "click → no effect" because there literally was
 * no effect they could see.
 *
 * What this redesign does differently:
 *   - Replaces shadcn <Switch> with a hand-rolled button-style toggle
 *     mirroring the codebase pattern at SettingsPage.tsx:172. Same JSX
 *     shape used elsewhere in production. Removes Radix Switch as a
 *     variable in the only place the dashboard ever used it.
 *   - Hero block at the top: large toggle IMMEDIATELY adjacent to its
 *     label (no justify-between separation). Click target ~44x24,
 *     well over the 24x24 WCAG floor.
 *   - Progressive disclosure: when off, only a muted explainer below.
 *     When on, three labelled sections fade in (motion-safe).
 *   - Sticky "you have unsaved changes" bar at the bottom of the
 *     viewport whenever the form is dirty. Replaces the isolated
 *     bottom-of-card Save button. Same pattern as Linear / Stripe.
 *   - In-form green confirmation strip after a successful save,
 *     auto-dismisses after 5s. Replaces the toast (toast was removed
 *     per spec — strip is durable + ambient, no noise).
 *   - Loop warning is its own amber pill with ⚠ icon, only rendered
 *     when state.twilio_phone_number is non-null (contextual, not
 *     always-on). Phone tip below the input is a single short line.
 *   - Phone input uses lib/phone.ts: live formatting to
 *     "+1 (NNN) NNN-NNNN" on blur, parsed to E.164 on submit. Inline
 *     ✓ icon when E.164-valid.
 *   - Messages (hold + operator briefing) collapse behind a "Customize
 *     messages" expander — defaults handle the common case.
 *
 * Backend (routes/transfer.ts + agents.ts) is unchanged.
 *
 * The component still accepts `onToast` for interface stability with
 * AiSettingsPage but no longer invokes it — confirmation lives in the
 * strip below, not in the global toast.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  Headphones,
  Phone,
} from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

import { getAuthHeaders } from "@/lib/api";
import {
  formatPhoneForDisplay,
  isPhoneE164Valid,
  parsePhoneToE164,
  phonesEquivalent,
} from "@/lib/phone";

interface TransferStateResponse {
  business_id: string;
  transfer_enabled: boolean;
  transfer_to_phone: string | null;
  transfer_conditions: string | null;
  transfer_wait_message: string | null;
  transfer_warm_message: string | null;
  twilio_phone_number: string | null;
  defaults: {
    transfer_conditions: string;
    transfer_wait_message: string;
    transfer_warm_message: string;
  };
}

interface PutResponse {
  success: boolean;
  business_id: string;
  transfer_enabled: boolean;
  transfer_to_phone: string | null;
  transfer_conditions: string | null;
  transfer_wait_message: string | null;
  transfer_warm_message: string | null;
  twilio_phone_number: string | null;
  sync: { ok: boolean; error: string | null };
}

function buildFormFromState(s: TransferStateResponse) {
  return {
    enabled: s.transfer_enabled,
    phone: s.transfer_to_phone ?? "",
    conditions: s.transfer_conditions ?? "",
    wait: s.transfer_wait_message ?? "",
    warm: s.transfer_warm_message ?? "",
  };
}

/**
 * Hand-rolled hero toggle. Same mechanic as SettingsPage.tsx:172 — a
 * <button> that flips state on click. Larger than the SettingsPage
 * variant (h-7 w-12 instead of h-6 w-11) so it reads as the primary
 * affordance on the tab.
 */
function HeroToggle({
  checked,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative h-7 w-12 rounded-full transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2E75B6] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? "bg-[#2E75B6]" : "bg-gray-300"
      }`}
    >
      <span
        className={`absolute top-1 left-1 h-5 w-5 bg-white rounded-full shadow transition-transform ${
          checked ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}

export default function TransferTab({
  apiBase = "business",
  // Accepted for interface compatibility with the other tabs but
  // intentionally not invoked — confirmation lives in the strip below.
  // Saves keep the call signature stable so AiSettingsPage doesn't need
  // a branch when wiring tabs.
  onToast: _onToast,
}: {
  apiBase?: string;
  onToast: (text: string, kind: "ok" | "err") => void;
}) {
  void _onToast;
  const { t } = useTranslation();
  const [state, setState] = useState<TransferStateResponse | null>(null);
  const [form, setForm] = useState({
    enabled: false,
    phone: "",
    conditions: "",
    wait: "",
    warm: "",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [messagesOpen, setMessagesOpen] = useState(false);
  // Post-save durable confirmation strip. Auto-dismisses after 5s.
  // Keyed so re-saves restart the timer cleanly.
  const [confirmation, setConfirmation] = useState<{ key: number; text: string } | null>(null);
  const confirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/${apiBase}/transfer`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) throw new Error(`GET failed: ${res.status}`);
        const data = (await res.json()) as TransferStateResponse;
        if (cancelled) return;
        setState(data);
        setForm(buildFormFromState(data));
      } catch (e: any) {
        if (cancelled) return;
        setLoadError(e?.message || "Failed to load transfer settings");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  // Auto-dismiss the confirmation strip after 5s. Restart the timer when
  // a new confirmation arrives (keyed via the `.key` field).
  useEffect(() => {
    if (!confirmation) return;
    if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    confirmationTimerRef.current = setTimeout(() => setConfirmation(null), 5000);
    return () => {
      if (confirmationTimerRef.current) clearTimeout(confirmationTimerRef.current);
    };
  }, [confirmation]);

  function clearMessages() {
    setServerError(null);
    setSyncError(null);
  }

  function onToggleEnabled(next: boolean) {
    clearMessages();
    setForm((f) => {
      // First-time enable: seed the optional fields with the server-
      // provided defaults so the customer can see + edit them before
      // hitting Save. Conditions field gets seeded too because it's
      // REQUIRED when enabled (the server seeds it too on first enable
      // — this is the client-side mirror so the customer sees what
      // will be saved).
      if (next && !state?.transfer_enabled) {
        return {
          ...f,
          enabled: true,
          conditions: f.conditions || state?.defaults.transfer_conditions || "",
          wait: f.wait || state?.defaults.transfer_wait_message || "",
          warm: f.warm || state?.defaults.transfer_warm_message || "",
        };
      }
      return { ...f, enabled: next };
    });
  }

  const dirty = useMemo(() => {
    if (!state) return false;
    const base = buildFormFromState(state);
    return base.enabled !== form.enabled
      || base.phone !== form.phone
      || base.conditions !== form.conditions
      || base.wait !== form.wait
      || base.warm !== form.warm;
  }, [state, form]);

  // Phone validity only matters when enabled.
  const phoneEntered = form.phone.trim();
  const parsedPhone = phoneEntered ? parsePhoneToE164(phoneEntered) : null;
  const phoneValid = form.enabled ? isPhoneE164Valid(phoneEntered) : true;
  const phoneInvalid = form.enabled && !!phoneEntered && !phoneValid;
  const phoneMissing = form.enabled && !phoneEntered;
  // Client-side loop-guard preview. The server still authoritatively
  // rejects, but showing it before the click saves a round-trip.
  const phoneLoops = form.enabled && !!parsedPhone && phonesEquivalent(parsedPhone, state?.twilio_phone_number ?? null);
  const saveDisabled = saving || !dirty || phoneInvalid || phoneMissing;

  function handleDiscard() {
    if (!state) return;
    setForm(buildFormFromState(state));
    clearMessages();
  }

  async function handleSave() {
    if (saveDisabled) return;
    clearMessages();
    setSaving(true);
    try {
      // Normalize the phone to E.164 before sending so the server sees
      // exactly what the loop guard + format check expect. The UI
      // displays a pretty version; the wire format is canonical.
      const phoneToSend = form.enabled
        ? (parsedPhone || form.phone.trim() || null)
        : (form.phone.trim() ? (parsedPhone || form.phone.trim()) : null);
      const res = await fetch(`/api/${apiBase}/transfer`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          transfer_enabled: form.enabled,
          transfer_to_phone: phoneToSend,
          transfer_conditions: form.conditions.trim() || null,
          transfer_wait_message: form.wait.trim() || null,
          transfer_warm_message: form.warm.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as PutResponse | { error?: string };
      if (!res.ok) {
        setServerError((body as { error?: string }).error || `HTTP ${res.status}`);
        return;
      }
      const ok = body as PutResponse;
      setState({
        business_id: ok.business_id,
        transfer_enabled: ok.transfer_enabled,
        transfer_to_phone: ok.transfer_to_phone,
        transfer_conditions: ok.transfer_conditions,
        transfer_wait_message: ok.transfer_wait_message,
        transfer_warm_message: ok.transfer_warm_message,
        twilio_phone_number: ok.twilio_phone_number,
        defaults: state?.defaults || {
          transfer_conditions: "",
          transfer_wait_message: "",
          transfer_warm_message: "",
        },
      });
      setForm({
        enabled: ok.transfer_enabled,
        phone: ok.transfer_to_phone ?? "",
        conditions: ok.transfer_conditions ?? "",
        wait: ok.transfer_wait_message ?? "",
        warm: ok.transfer_warm_message ?? "",
      });
      if (!ok.sync.ok) {
        // DB saved but ElevenLabs sync failed. Surface inline; no
        // confirmation strip in this case — the customer needs to
        // retry, not see a "saved!" celebration.
        setSyncError(ok.sync.error || "Saved, but couldn't sync to your AI yet. Save again to retry.");
      } else {
        const text = ok.transfer_enabled
          ? t("transfer.savedConfirmationEnabled", { phone: formatPhoneForDisplay(ok.transfer_to_phone) })
          : t("transfer.savedConfirmationDisabled");
        setConfirmation({ key: Date.now(), text });
      }
    } catch (e: any) {
      console.error("[TransferTab] save failed:", e);
      setServerError("Network error. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-2 text-sm text-red-700">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <span>{loadError}</span>
      </div>
    );
  }

  const twilioNumber = state?.twilio_phone_number || null;
  const prettyTwilio = twilioNumber ? formatPhoneForDisplay(twilioNumber) : null;

  return (
    <div className="space-y-6 pb-24">
      {/* Confirmation strip — durable success indicator, auto-dismisses
          after 5s. Sits at the top so it doesn't compete with form
          interaction lower down. */}
      {confirmation && (
        <div
          key={confirmation.key}
          role="status"
          aria-live="polite"
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-2.5 text-sm text-emerald-800 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200 motion-safe:ease-out"
        >
          <Check className="h-4 w-4 shrink-0 mt-0.5 text-emerald-600" />
          <span>{confirmation.text}</span>
        </div>
      )}

      {/* Hero block. Toggle sits IMMEDIATELY left of the label — no
          justify-between separation. The whole block is clickable on
          the label area too (htmlFor isn't reliable across button-based
          toggles, so we just route the label click through to
          onToggleEnabled). */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <HeroToggle
            checked={form.enabled}
            onChange={onToggleEnabled}
            disabled={saving}
            ariaLabel={t("transfer.toggleLabel")}
          />
          <div className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => !saving && onToggleEnabled(!form.enabled)}
              disabled={saving}
              className="text-left block w-full"
            >
              <h2 className="text-base sm:text-lg font-semibold text-gray-900 leading-tight">
                {t("transfer.toggleLabel")}
              </h2>
              <p className="text-sm text-gray-500 mt-1 leading-snug">
                {t("transfer.toggleSubtitle")}
              </p>
            </button>
          </div>
        </div>
      </div>

      {/* Progressive disclosure */}
      {!form.enabled && (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-500 flex items-center gap-2">
          <Headphones className="h-4 w-4 shrink-0 text-gray-400" />
          <span>{t("transfer.disabledExplainer")}</span>
        </div>
      )}

      {form.enabled && (
        <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2 motion-safe:duration-200 motion-safe:ease-out">
          {/* Section 1 — Where to transfer */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 text-gray-400" />
              <h3 className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
                {t("transfer.sectionWhereTitle")}
              </h3>
            </div>
            <div className="space-y-2">
              <label htmlFor="transfer-phone" className="text-sm font-medium text-gray-900 block">
                {t("transfer.phoneLabel")}
              </label>
              <div className="relative">
                <input
                  id="transfer-phone"
                  type="tel"
                  inputMode="tel"
                  placeholder="(443) 708-7894"
                  value={form.phone}
                  onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, phone: e.target.value })); }}
                  onBlur={() => {
                    // Pretty-format on blur so the customer sees the
                    // saved shape immediately. Round-trip through
                    // parsePhoneToE164 → formatPhoneForDisplay so the
                    // displayed value reflects what'll be sent.
                    if (!form.phone.trim()) return;
                    const e164 = parsePhoneToE164(form.phone);
                    if (e164) {
                      const pretty = formatPhoneForDisplay(e164);
                      setForm((f) => ({ ...f, phone: pretty }));
                    }
                  }}
                  disabled={saving}
                  aria-invalid={phoneInvalid || undefined}
                  className={`w-full rounded-lg border px-3 py-2.5 text-sm pr-10 transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E75B6] focus:border-transparent ${
                    phoneInvalid ? "border-red-400" : "border-gray-200"
                  } disabled:bg-gray-50 disabled:cursor-not-allowed`}
                />
                {phoneEntered && phoneValid && (
                  <span className="absolute inset-y-0 right-3 flex items-center text-emerald-500">
                    <Check className="h-4 w-4" />
                  </span>
                )}
              </div>
              {phoneInvalid && (
                <p className="text-xs text-red-600">{t("transfer.phoneFormatError")}</p>
              )}
              <p className="text-xs text-gray-500">{t("transfer.phoneHelp")}</p>

              {/* Amber pill — loop warning. Renders ONLY when the
                  business has a Twilio number. Stays visible whether
                  or not the customer has typed the colliding number
                  yet (it's a "don't do this" reminder, not a reactive
                  error). */}
              {prettyTwilio && (
                <div className={`mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-snug ${
                  phoneLoops
                    ? "border-amber-400 bg-amber-50 text-amber-900"
                    : "border-amber-200 bg-amber-50 text-amber-800"
                }`}>
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    {t("transfer.loopPillWarning", { twilioNumber: prettyTwilio })}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Section 2 — When the AI should transfer */}
          <div className="rounded-2xl border border-gray-200 bg-white p-5 sm:p-6 space-y-4">
            <div className="flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-gray-400" />
              <h3 className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
                {t("transfer.sectionWhenTitle")}
              </h3>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-gray-500">{t("transfer.conditionsHint")}</p>
              <textarea
                value={form.conditions}
                onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, conditions: e.target.value })); }}
                disabled={saving}
                rows={4}
                maxLength={1000}
                placeholder={state?.defaults.transfer_conditions}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm leading-relaxed transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E75B6] focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed resize-y"
              />
              {/* Counter appears only when within 200 of the limit. */}
              {form.conditions.length > 800 && (
                <p className="text-xs text-gray-400 text-right tabular-nums">
                  {form.conditions.length}/1000
                </p>
              )}
            </div>
          </div>

          {/* Section 3 — Messages (collapsed by default) */}
          <div className="rounded-2xl border border-gray-200 bg-white">
            <button
              type="button"
              onClick={() => setMessagesOpen((o) => !o)}
              className="w-full px-5 sm:px-6 py-4 flex items-center justify-between text-left rounded-2xl hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2E75B6] focus-visible:ring-offset-2"
              aria-expanded={messagesOpen}
            >
              <span className="text-sm font-semibold tracking-wide text-gray-600 uppercase">
                {t("transfer.sectionMessagesToggle")}
              </span>
              <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${messagesOpen ? "rotate-180" : ""}`} />
            </button>
            {messagesOpen && (
              <div className="px-5 sm:px-6 pb-6 space-y-5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150">
                {/* Hold message */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-900 block">
                    {t("transfer.waitLabelInline")}
                  </label>
                  <textarea
                    value={form.wait}
                    onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, wait: e.target.value })); }}
                    disabled={saving}
                    rows={2}
                    maxLength={500}
                    placeholder={state?.defaults.transfer_wait_message}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E75B6] focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed resize-y"
                  />
                  {form.wait.length > 400 && (
                    <p className="text-xs text-gray-400 text-right tabular-nums">{form.wait.length}/500</p>
                  )}
                </div>

                {/* Warm message */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-900 block">
                    {t("transfer.warmLabelInline")}
                  </label>
                  <textarea
                    value={form.warm}
                    onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, warm: e.target.value })); }}
                    disabled={saving}
                    rows={3}
                    maxLength={1000}
                    placeholder={state?.defaults.transfer_warm_message}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[#2E75B6] focus:border-transparent disabled:bg-gray-50 disabled:cursor-not-allowed resize-y"
                  />
                  <p className="text-xs text-gray-500">{t("transfer.warmHelpAutoInsert")}</p>
                  {form.warm.length > 800 && (
                    <p className="text-xs text-gray-400 text-right tabular-nums">{form.warm.length}/1000</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Server-error (loop guard 400, format 400, etc.) */}
      {serverError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-2 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{serverError}</span>
        </div>
      )}

      {/* Sync warning — DB saved but ElevenLabs PATCH failed. */}
      {syncError && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-2 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{syncError}</span>
        </div>
      )}

      {/* Sticky save bar — only renders when dirty. Fixed to the
          viewport bottom so it follows the customer's scroll. Replaces
          the bottom-of-card Save button that was easy to miss. */}
      {dirty && (
        <div
          role="region"
          aria-label={t("transfer.unsavedChanges")}
          className="fixed bottom-0 left-0 right-0 z-30 border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-[0_-4px_12px_-6px_rgba(0,0,0,0.1)] motion-safe:animate-in motion-safe:slide-in-from-bottom-2 motion-safe:fade-in-0 motion-safe:duration-200 motion-safe:ease-out"
        >
          <div className="max-w-4xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
            <p className="text-sm text-gray-700 truncate">{t("transfer.unsavedChanges")}</p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleDiscard}
                disabled={saving}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {t("transfer.discard")}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saveDisabled}
                className="px-4 py-1.5 rounded-lg text-sm font-semibold bg-[#2E75B6] text-white hover:bg-[#2563a0] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? t("transfer.saving") : t("transfer.save")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
