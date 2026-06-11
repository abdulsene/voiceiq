/**
 * Transfer tab — operator-transfer settings. Same Stage 6 apiBase
 * pattern as VoiceTab / PromptEditor: customer flow uses apiBase="business"
 * and posts to PUT /api/business/transfer; admin drill-in uses
 * apiBase=`admin/business/${id}` and posts to the parallel admin
 * endpoint. Behavior is identical otherwise.
 *
 * The backend (Commit 1) does the heavy lifting:
 *   - E.164 validation server-side (we mirror lightly for UX, server is
 *     the source of truth)
 *   - Loop guard against business_configs.twilio_phone_number
 *   - First-enable defaults seeding when blank
 *   - {business_name} interpolation at PATCH time (we DON'T resolve it
 *     here — the customer's template stays literal so renaming the
 *     business later doesn't require a re-save)
 *   - ElevenLabs tool registration via updateAgentTransferConfig
 *
 * What this component owns:
 *   - GET on mount to hydrate (loads server-side defaults too)
 *   - Local form state mirroring the row
 *   - Dirty detection (Save is disabled when nothing changed)
 *   - Inline server-error surface for the 400 cases (loop guard
 *     especially)
 *   - Sync status from the PUT response (`sync.ok` / `sync.error`) so
 *     the customer sees if ElevenLabs propagation failed
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Headphones, AlertCircle, CheckCircle2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

import { getAuthHeaders } from "@/lib/api";

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

// Client-side E.164 sniff to disable Save before the user can fire the
// request. The server is still the source of truth — it runs the same
// regex AND the loop guard, so a permissive client check is fine.
const E164_CLIENT_RE = /^\+?[1-9]\d{6,14}$/;

function buildFormFromState(s: TransferStateResponse) {
  return {
    enabled: s.transfer_enabled,
    phone: s.transfer_to_phone ?? "",
    conditions: s.transfer_conditions ?? "",
    wait: s.transfer_wait_message ?? "",
    warm: s.transfer_warm_message ?? "",
  };
}

export default function TransferTab({
  apiBase = "business",
  onToast,
}: {
  apiBase?: string;
  onToast: (text: string, kind: "ok" | "err") => void;
}) {
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
  // The 400 body from the loop guard / phone format check lands here.
  // Cleared on any field edit so the message doesn't linger after the
  // customer fixes the input.
  const [serverError, setServerError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/${apiBase}/transfer`, {
          headers: getAuthHeaders(),
        });
        if (!res.ok) {
          throw new Error(`GET failed: ${res.status}`);
        }
        const data = (await res.json()) as TransferStateResponse;
        if (cancelled) return;
        setState(data);
        // Seed the form with current values. When the customer toggles
        // ON for the first time (server-side first-enable seed), the
        // defaults from `data.defaults` are used to pre-fill on the
        // client below in onToggleEnabled, NOT here — empty fields
        // here should stay empty so the customer sees "blank → about
        // to seed defaults" rather than "pre-populated with text the
        // server hasn't accepted yet".
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

  function clearMessages() {
    setServerError(null);
    setSyncError(null);
  }

  function onToggleEnabled(next: boolean) {
    clearMessages();
    setForm((f) => {
      // First-time enable: seed the optional fields with the server-
      // provided defaults so the customer can see / edit them before
      // hitting Save. The textarea content is theirs to keep or
      // rewrite. Conditions field gets seeded too because it's REQUIRED
      // when enabled.
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

  // Phone validity matters only when enabled.
  const phoneInvalid = form.enabled && !!form.phone && !E164_CLIENT_RE.test(form.phone.trim());
  const phoneMissing = form.enabled && !form.phone.trim();
  const saveDisabled = saving || !dirty || phoneInvalid || phoneMissing;

  async function handleSave() {
    if (saveDisabled) return;
    clearMessages();
    setSaving(true);
    try {
      const res = await fetch(`/api/${apiBase}/transfer`, {
        method: "PUT",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          transfer_enabled: form.enabled,
          transfer_to_phone: form.phone.trim() || null,
          transfer_conditions: form.conditions.trim() || null,
          transfer_wait_message: form.wait.trim() || null,
          transfer_warm_message: form.warm.trim() || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as PutResponse | { error?: string };
      if (!res.ok) {
        const msg = (body as { error?: string }).error || `HTTP ${res.status}`;
        setServerError(msg);
        return;
      }
      const ok = body as PutResponse;
      // Refresh local state from the canonical server response so the
      // dirty diff resets and the next edit starts from saved values.
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
        // DB saved but ElevenLabs sync failed. Surface inline (not just
        // toast) so the customer knows to retry.
        setSyncError(ok.sync.error || "Saved, but couldn't sync to your AI yet. Save again to retry.");
        onToast("Saved. Your AI is syncing in the background.", "ok");
      } else {
        onToast(form.enabled ? "Transfer enabled" : "Transfer disabled", "ok");
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
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 text-red-600">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">{loadError}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  const businessLine = state?.twilio_phone_number || null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Headphones className="h-5 w-5" />
            {t("transfer.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Master toggle */}
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="transfer-enabled" className="text-base font-medium">
                {t("transfer.toggleLabel")}
              </Label>
              <p className="text-sm text-gray-500">
                {t("transfer.toggleDescription")}
              </p>
            </div>
            <Switch
              id="transfer-enabled"
              checked={form.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={saving}
            />
          </div>

          {/* Phone — only meaningful when enabled, but stays visible so
              the customer can keep their saved number after disabling. */}
          <div className="space-y-2">
            <Label htmlFor="transfer-phone" className="text-sm font-medium">
              {t("transfer.phoneLabel")}
            </Label>
            <Input
              id="transfer-phone"
              type="tel"
              inputMode="tel"
              placeholder="+14105551234"
              value={form.phone}
              onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, phone: e.target.value })); }}
              disabled={saving}
              className={phoneInvalid ? "border-red-500" : ""}
              aria-invalid={phoneInvalid || undefined}
            />
            <p className="text-xs text-gray-500">
              {t("transfer.phoneHelpPrefix")}
              {businessLine && (
                <>
                  {" "}
                  <span className="font-mono text-gray-700">{businessLine}</span>
                  {" "}
                  {t("transfer.phoneHelpSuffix")}
                </>
              )}
            </p>
            {phoneInvalid && (
              <p className="text-xs text-red-600">{t("transfer.phoneFormatError")}</p>
            )}
          </div>

          {/* Conditions — required when enabled */}
          <div className="space-y-2">
            <Label htmlFor="transfer-conditions" className="text-sm font-medium">
              {t("transfer.conditionsLabel")}
            </Label>
            <Textarea
              id="transfer-conditions"
              value={form.conditions}
              onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, conditions: e.target.value })); }}
              disabled={saving}
              rows={4}
              maxLength={1000}
              placeholder={state?.defaults.transfer_conditions}
            />
            <p className="text-xs text-gray-500">
              {form.conditions.length}/1000
            </p>
          </div>

          {/* Wait message — read to the caller */}
          <div className="space-y-2">
            <Label htmlFor="transfer-wait" className="text-sm font-medium">
              {t("transfer.waitLabel")}
            </Label>
            <Textarea
              id="transfer-wait"
              value={form.wait}
              onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, wait: e.target.value })); }}
              disabled={saving}
              rows={2}
              maxLength={500}
              placeholder={state?.defaults.transfer_wait_message}
            />
            <p className="text-xs text-gray-500">{form.wait.length}/500</p>
          </div>

          {/* Warm message — read to the operator on pickup. {business_name}
              is server-side interpolated. */}
          <div className="space-y-2">
            <Label htmlFor="transfer-warm" className="text-sm font-medium">
              {t("transfer.warmLabel")}
            </Label>
            <Textarea
              id="transfer-warm"
              value={form.warm}
              onChange={(e) => { clearMessages(); setForm((f) => ({ ...f, warm: e.target.value })); }}
              disabled={saving}
              rows={3}
              maxLength={1000}
              placeholder={state?.defaults.transfer_warm_message}
            />
            <p className="text-xs text-gray-500">
              {t("transfer.warmHelpAutoInsert")} {form.warm.length}/1000
            </p>
          </div>

          {/* Server-error surface — primarily the loop guard 400. */}
          {serverError && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{serverError}</span>
            </div>
          )}

          {/* Sync warning — DB saved but ElevenLabs hadn't propagated. */}
          {syncError && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{syncError}</span>
            </div>
          )}

          {/* Status line when no errors and a previous save landed clean. */}
          {!serverError && !syncError && state?.transfer_enabled && state.transfer_to_phone && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              <span>
                {t("transfer.activeStatus")} <span className="font-mono">{state.transfer_to_phone}</span>
              </span>
            </div>
          )}

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saveDisabled}>
              {saving ? t("transfer.saving") : t("transfer.save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
