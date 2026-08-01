/**
 * Phase 3.1b — InviteMemberDialog.
 *
 * Modal used by TeamPage to invite a new team member. Fetches the
 * current business's topic list on open so the topic multi-select is
 * populated with the tenant's actual topics (not a hardcoded catalog).
 *
 * On submit: POST /api/business/team/invite. Success → toast + callback.
 * The "user already existed" case comes back as invited=false and is
 * surfaced via a different toast copy.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../lib/api";
import { MultiSelect, type MultiSelectOption } from "./ui/multi-select";

interface Props {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
}

// owner is not assignable via invite — established at signup only.
const ASSIGNABLE_ROLES: Array<{ value: string; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "manager", label: "Manager" },
  { value: "team_lead", label: "Team lead" },
  { value: "agent_manager", label: "Agent manager" },
  { value: "analyst", label: "Analyst" },
  { value: "user", label: "User" },
  { value: "readonly", label: "Read-only" },
];

const E164_RE = /^\+[1-9]\d{6,14}$/;

export default function InviteMemberDialog({ open, onClose, onInvited }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState("user");
  const [topics, setTopics] = useState<string[]>([]);
  const [callbackRing, setCallbackRing] = useState("");
  const [availableTopics, setAvailableTopics] = useState<MultiSelectOption[]>([]);
  const [topicsEmpty, setTopicsEmpty] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Reset form each time dialog opens so re-invites don't inherit stale
  // state from a previous submission.
  useEffect(() => {
    if (!open) return;
    setEmail("");
    setFullName("");
    setRole("user");
    setTopics([]);
    setCallbackRing("");
    setSubmitting(false);
    (async () => {
      try {
        const data = await fetchApi("/business/topics");
        const list = ((data?.topics as Array<{ slug: string; name: string }> | undefined) ?? []).map((t) => ({
          value: t.slug,
          label: t.name,
        }));
        setAvailableTopics(list);
        setTopicsEmpty(list.length === 0);
      } catch {
        setAvailableTopics([]);
        setTopicsEmpty(true);
      }
    })();
  }, [open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    if (callbackRing && !E164_RE.test(callbackRing.trim())) {
      toast.error(t("invite.callbackHelp"));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/business/team/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          email: email.trim(),
          role,
          initial_topics: topics,
          callback_ring_number: callbackRing.trim() || null,
          full_name: fullName.trim() || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      // Phase 3.17: server now returns { invite_id, email, expires_at,
      // resent_previous } instead of { user_id, email, invited }.
      // resent_previous=true means we superseded a prior outstanding
      // invite for the same email — surface that to the owner so
      // they know the old email link no longer works.
      if (body?.resent_previous) {
        toast.success(t("invite.resentSuccess", { email: email.trim(), defaultValue: `Sent a fresh invite to ${email.trim()} (previous one was superseded).` }));
      } else {
        toast.success(t("invite.success", { email: email.trim() }));
      }
      onInvited();
    } catch (err: any) {
      toast.error(err?.message || t("invite.error"));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        // Phase 3.17 — cap max height + overflow-y so the MultiSelect
        // chip list can't push Cancel/Send buttons off-screen when
        // many topics are picked. The Popover portals to <body> and
        // renders above the modal, but the chips are IN the modal DOM.
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{t("invite.title")}</h2>
            <p className="text-sm text-slate-500 mt-1">{t("invite.description")}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label={t("invite.cancel")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">{t("invite.email")}</label>
            <input
              type="email"
              required
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t("invite.emailPlaceholder")}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">{t("invite.fullName")}</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("invite.fullNamePlaceholder")}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
              disabled={submitting}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">{t("invite.role")}</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
              disabled={submitting}
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Phase 3.17 — callback number promoted ABOVE topics. Zero
              of 40 members in prod had one, and browser-only means a
              closed tab is a missed call. Prominent copy + amber
              highlight when empty, promoting the field visually. */}
          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-amber-900">
                {t("invite.callbackRingNumber")} — highly recommended
              </label>
              <span className="text-[10px] uppercase tracking-wide text-amber-700 font-medium">
                For reliability
              </span>
            </div>
            <input
              type="tel"
              value={callbackRing}
              onChange={(e) => setCallbackRing(e.target.value)}
              placeholder="+14155551234"
              className="w-full px-3 py-2 border border-amber-300 bg-white rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-amber-400/40"
              disabled={submitting}
            />
            <p className="text-[11px] text-amber-800">
              If their browser tab is closed, routing rings this cell instead.
              Without a callback number, a member is unreachable when their
              browser isn't open.
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-slate-700 mb-1 block">{t("invite.topics")}</label>
            {topicsEmpty ? (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">
                {t("invite.topicsEmpty")}
              </p>
            ) : (
              <MultiSelect
                options={availableTopics}
                value={topics}
                onChange={setTopics}
                placeholder={t("invite.topicsPlaceholder")}
                disabled={submitting}
              />
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {t("invite.cancel")}
            </button>
            <button
              type="submit"
              disabled={submitting || !email.trim()}
              className="flex-1 px-4 py-2 bg-[#2E75B6] text-white rounded-lg text-sm font-semibold hover:bg-[#1e5a8f] disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
              {submitting ? t("invite.submitting") : t("invite.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
