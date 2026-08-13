/**
 * Phase 3.1b — Topics tab for the SettingsPage.
 *
 * Renders and edits the business's topic list from
 * business_configs.departments. The list is the routing catalog for
 * Phase 3.2 (who handles which call) — each topic has a stable slug,
 * a display name, a description that seeds the AI prompt, and example
 * utterances that help the AI recognize the topic in speech.
 *
 * PATCH is a bulk replace — the UI edits in-place, then hits Save. If
 * the user has never customized their topics, the "Reset to defaults"
 * button copies the industry_templates.default_topics catalogue.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../../lib/api";

type DisqualifierKind = "permanent" | "temporary";

interface Disqualifier {
  id: string;
  label: string;
  kind: DisqualifierKind;
  // Client-only flag. New rows are editable-id; server-persisted rows
  // become readonly-id on save. Not sent to the server.
  __isNew?: boolean;
}

interface Qualification {
  enabled: boolean;
  requirements_text: string;
  disqualifiers: Disqualifier[];
  permanent_close: string;
  temporary_close: string;
}

interface Topic {
  slug: string;
  name: string;
  description: string;
  example_utterances: string[];
  qualification?: Qualification;
}

const EMPTY_QUALIFICATION: Qualification = {
  enabled: false,
  requirements_text: "",
  disqualifiers: [],
  permanent_close: "",
  temporary_close: "",
};

function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9]/, (m) => `d_${m}`)
    .slice(0, 60) || "disqualifier";
}

interface TopicsResponse {
  topics: Topic[];
  industry_defaults: Topic[];
  industry_id: string | null;
}

const SLUG_RE = /^[a-z][a-z0-9_]*$/;

function utterancesToString(u: string[]): string {
  return u.join(", ");
}

function stringToUtterances(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function humanizeIndustry(id: string | null): string {
  if (!id) return "";
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function TopicsTab() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [industryId, setIndustryId] = useState<string | null>(null);
  const [industryDefaults, setIndustryDefaults] = useState<Topic[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 6.0 — expanded-qualification-block state, keyed by topic index.
  // Collapsed by default so the tab reads uncluttered for tenants who
  // don't use gating on that topic.
  const [expandedQualification, setExpandedQualification] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await fetchApi("/business/topics")) as TopicsResponse;
      setTopics(data?.topics ?? []);
      setIndustryDefaults(data?.industry_defaults ?? []);
      setIndustryId(data?.industry_id ?? null);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canReset = industryDefaults.length > 0;

  const validate = useCallback((): string | null => {
    const seen = new Set<string>();
    for (const [i, topic] of topics.entries()) {
      const slug = topic.slug.trim();
      if (!SLUG_RE.test(slug)) return `Row ${i + 1}: slug "${slug}" is not snake_case`;
      if (seen.has(slug)) return `Row ${i + 1}: duplicate slug "${slug}"`;
      seen.add(slug);
      if (!topic.name.trim()) return `Row ${i + 1}: name is required`;

      // Phase 6.0 — client-side qualification validation. Mirrors the
      // server rules in routes/topics.ts:parseQualification so the
      // tenant sees a targeted error rather than a generic 400.
      const q = topic.qualification;
      if (q?.enabled) {
        if (!q.requirements_text.trim()) {
          return `Row ${i + 1}: qualification requirements text is required when the gate is enabled`;
        }
        if (q.disqualifiers.length === 0) {
          return `Row ${i + 1}: add at least one disqualifier when the gate is enabled`;
        }
        const seenIds = new Set<string>();
        for (const d of q.disqualifiers) {
          const id = d.id.trim();
          if (!SLUG_RE.test(id)) return `Row ${i + 1}: disqualifier id "${id}" must be snake_case`;
          if (seenIds.has(id)) return `Row ${i + 1}: duplicate disqualifier id "${id}"`;
          seenIds.add(id);
          if (!d.label.trim()) return `Row ${i + 1}: disqualifier "${id}" needs a label`;
        }
        const hasPermanent = q.disqualifiers.some((d) => d.kind === "permanent");
        const hasTemporary = q.disqualifiers.some((d) => d.kind === "temporary");
        if (hasPermanent && !q.permanent_close.trim()) {
          return `Row ${i + 1}: closing message for permanently-unqualified callers is required`;
        }
        if (hasTemporary && !q.temporary_close.trim()) {
          return `Row ${i + 1}: closing message for temporarily-unqualified callers is required`;
        }
      }
    }
    return null;
  }, [topics]);

  async function handleSave() {
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      // Strip client-only __isNew flags before sending. Not doing so
      // works today (server ignores unknown fields) but leaves cruft
      // in the JSONB after a round-trip.
      const payloadTopics = topics.map((t) => {
        if (!t.qualification) return t;
        return {
          ...t,
          qualification: {
            ...t.qualification,
            disqualifiers: t.qualification.disqualifiers.map(({ __isNew, ...rest }) => {
              void __isNew;
              return rest;
            }),
          },
        };
      });
      const res = await fetch("/api/business/topics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ topics: payloadTopics }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setTopics((body?.topics as Topic[]) ?? topics);
      toast.success(t("topics.saveSuccess"));
    } catch (e: any) {
      toast.error(e?.message || t("topics.saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!canReset) {
      toast.error(t("topics.resetEmpty"));
      return;
    }
    try {
      const res = await fetch("/api/business/topics/reset", {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setTopics((body?.topics as Topic[]) ?? []);
      toast.success(t("topics.resetSuccess"));
    } catch (e: any) {
      toast.error(e?.message || t("topics.resetError"));
    }
  }

  const updateTopic = useCallback((idx: number, patch: Partial<Topic>) => {
    setTopics((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  }, []);

  // Phase 6.0 — qualification-block mutation helpers. Kept as
  // small setters rather than passing the whole editor as props so
  // the render is easy to read at the call site.
  const updateQualification = useCallback((idx: number, patch: Partial<Qualification>) => {
    setTopics((prev) =>
      prev.map((t, i) => {
        if (i !== idx) return t;
        const current = t.qualification ?? EMPTY_QUALIFICATION;
        return { ...t, qualification: { ...current, ...patch } };
      }),
    );
  }, []);

  const addDisqualifier = useCallback((idx: number) => {
    setTopics((prev) =>
      prev.map((t, i) => {
        if (i !== idx) return t;
        const current = t.qualification ?? EMPTY_QUALIFICATION;
        return {
          ...t,
          qualification: {
            ...current,
            disqualifiers: [
              ...current.disqualifiers,
              { id: "", label: "", kind: "temporary" as DisqualifierKind, __isNew: true },
            ],
          },
        };
      }),
    );
  }, []);

  const updateDisqualifier = useCallback(
    (topicIdx: number, dIdx: number, patch: Partial<Disqualifier>) => {
      setTopics((prev) =>
        prev.map((t, i) => {
          if (i !== topicIdx) return t;
          const current = t.qualification ?? EMPTY_QUALIFICATION;
          const nextDs = current.disqualifiers.map((d, j) => {
            if (j !== dIdx) return d;
            const merged = { ...d, ...patch };
            // Auto-derive the id from the label ONLY while the row is
            // still new (never persisted). Once saved, id is readonly.
            if (patch.label != null && d.__isNew) {
              merged.id = slugifyLabel(patch.label);
            }
            return merged;
          });
          return { ...t, qualification: { ...current, disqualifiers: nextDs } };
        }),
      );
    },
    [],
  );

  const removeDisqualifier = useCallback((topicIdx: number, dIdx: number) => {
    setTopics((prev) =>
      prev.map((t, i) => {
        if (i !== topicIdx) return t;
        const current = t.qualification ?? EMPTY_QUALIFICATION;
        return {
          ...t,
          qualification: {
            ...current,
            disqualifiers: current.disqualifiers.filter((_, j) => j !== dIdx),
          },
        };
      }),
    );
  }, []);

  const toggleQualificationPanel = useCallback((idx: number) => {
    setExpandedQualification((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }, []);

  const removeTopic = useCallback((idx: number) => {
    setTopics((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const addTopic = useCallback(() => {
    setTopics((prev) => [
      ...prev,
      { slug: "", name: "", description: "", example_utterances: [] },
    ]);
  }, []);

  const industryLabel = useMemo(() => humanizeIndustry(industryId), [industryId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
        <Loader2 className="w-4 h-4 animate-spin" /> {t("hours.loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{t("topics.title")}</h2>
          <p className="text-sm text-slate-500 mt-1">{t("topics.subtitle")}</p>
        </div>
        {canReset && (
          <button
            type="button"
            onClick={handleReset}
            className="inline-flex items-center gap-2 text-sm text-slate-700 border border-slate-300 px-3 py-2 rounded-lg hover:bg-slate-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {industryLabel
              ? t("topics.resetToDefaults", { industry: industryLabel })
              : t("topics.resetDefault")}
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
          {error}
        </div>
      )}

      {topics.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500 border border-dashed border-slate-300 rounded-xl">
          {t("topics.empty")}
        </div>
      ) : (
        <div className="space-y-4">
          {topics.map((topic, idx) => (
            <div key={idx} className="border border-slate-200 rounded-xl p-4 bg-white space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-slate-700 mb-1 block">
                      {t("topics.slug")}
                    </label>
                    <input
                      type="text"
                      value={topic.slug}
                      onChange={(e) => updateTopic(idx, { slug: e.target.value.toLowerCase() })}
                      placeholder={t("topics.slugPlaceholder")}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                    />
                    <p className="text-[11px] text-slate-500 mt-1">{t("topics.slugHelp")}</p>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700 mb-1 block">
                      {t("topics.name")}
                    </label>
                    <input
                      type="text"
                      value={topic.name}
                      onChange={(e) => updateTopic(idx, { name: e.target.value })}
                      placeholder={t("topics.namePlaceholder")}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeTopic(idx)}
                  className="text-slate-400 hover:text-red-600 p-1"
                  aria-label={t("topics.remove")}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-700 mb-1 block">
                  {t("topics.description")}
                </label>
                <textarea
                  value={topic.description}
                  onChange={(e) => updateTopic(idx, { description: e.target.value })}
                  placeholder={t("topics.descriptionPlaceholder")}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 resize-y"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-700 mb-1 block">
                  {t("topics.utterances")}
                </label>
                <textarea
                  value={utterancesToString(topic.example_utterances)}
                  onChange={(e) => updateTopic(idx, { example_utterances: stringToUtterances(e.target.value) })}
                  placeholder={t("topics.utterancesPlaceholder")}
                  rows={2}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 resize-y"
                />
                <p className="text-[11px] text-slate-500 mt-1">{t("topics.utterancesHelp")}</p>
              </div>

              {/* Phase 6.0 — qualification editor. Collapsed by default;
                  expanded on demand so unused topics don't clutter the tab. */}
              <div className="border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => toggleQualificationPanel(idx)}
                  className="flex items-center gap-1.5 text-xs font-medium text-slate-700 hover:text-slate-900"
                >
                  {expandedQualification[idx] ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  Qualification requirements
                  {topic.qualification?.enabled ? (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                      on
                    </span>
                  ) : (
                    <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-500 border border-slate-200">
                      off
                    </span>
                  )}
                </button>
                {expandedQualification[idx] && (
                  <div className="mt-3 space-y-3 pl-5 border-l-2 border-slate-100">
                    <label className="flex items-center gap-2 text-xs text-slate-700">
                      <input
                        type="checkbox"
                        checked={topic.qualification?.enabled ?? false}
                        onChange={(e) => updateQualification(idx, { enabled: e.target.checked })}
                        className="rounded border-slate-300"
                      />
                      Recite requirements to callers matched to this topic before routing.
                    </label>

                    <div>
                      <label className="text-xs font-medium text-slate-700 mb-1 block">
                        Requirements (spoken verbatim by Alex; keep it conversational, one paragraph)
                      </label>
                      <textarea
                        value={topic.qualification?.requirements_text ?? ""}
                        onChange={(e) => updateQualification(idx, { requirements_text: e.target.value })}
                        placeholder="e.g. Valid Maryland driver's license, 25 or older, vehicle stays in Maryland…"
                        rows={4}
                        maxLength={2000}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 resize-y"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-medium text-slate-700">
                          Disqualifiers (Alex tags unqualified callbacks with the matching id)
                        </label>
                        <button
                          type="button"
                          onClick={() => addDisqualifier(idx)}
                          className="inline-flex items-center gap-1 text-xs text-[#2E75B6] hover:text-[#1e5a8f]"
                        >
                          <Plus className="w-3 h-3" /> Add
                        </button>
                      </div>
                      {(topic.qualification?.disqualifiers ?? []).length === 0 ? (
                        <p className="text-[11px] text-slate-500 italic">No disqualifiers defined.</p>
                      ) : (
                        <div className="space-y-2">
                          {(topic.qualification?.disqualifiers ?? []).map((d, dIdx) => (
                            <div key={dIdx} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={d.label}
                                onChange={(e) => updateDisqualifier(idx, dIdx, { label: e.target.value })}
                                placeholder="e.g. Under 25"
                                maxLength={120}
                                className="flex-1 px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                              />
                              <input
                                type="text"
                                value={d.id}
                                readOnly={!d.__isNew}
                                onChange={(e) => updateDisqualifier(idx, dIdx, { id: e.target.value.toLowerCase() })}
                                title={d.__isNew ? "Auto-derived from label; edit if you want a specific id" : "Locked once saved — existing leads reference this id"}
                                className={`w-40 px-2 py-1.5 border border-slate-300 rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 ${d.__isNew ? "" : "bg-slate-50 text-slate-500 cursor-not-allowed"}`}
                              />
                              <select
                                value={d.kind}
                                onChange={(e) => updateDisqualifier(idx, dIdx, { kind: e.target.value as DisqualifierKind })}
                                className="px-2 py-1.5 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30"
                              >
                                <option value="temporary">Temporary</option>
                                <option value="permanent">Permanent</option>
                              </select>
                              <button
                                type="button"
                                onClick={() => removeDisqualifier(idx, dIdx)}
                                className="text-slate-400 hover:text-red-600 p-1"
                                aria-label="Remove disqualifier"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <p className="text-[11px] text-slate-500 mt-1">
                        Permanent: caller can never satisfy by calling back (e.g. under 25). Temporary: could work later (e.g. can't pay by 3pm today).
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-medium text-slate-700 mb-1 block">
                          Closing message — permanent (polite decline, no invitation to call back)
                        </label>
                        <textarea
                          value={topic.qualification?.permanent_close ?? ""}
                          onChange={(e) => updateQualification(idx, { permanent_close: e.target.value })}
                          placeholder="e.g. Thanks for calling — we won't be able to help with a rental. Wishing you the best."
                          rows={3}
                          maxLength={500}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 resize-y"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-700 mb-1 block">
                          Closing message — temporary (explicit invitation to call back)
                        </label>
                        <textarea
                          value={topic.qualification?.temporary_close ?? ""}
                          onChange={(e) => updateQualification(idx, { temporary_close: e.target.value })}
                          placeholder="e.g. Please give us a call back when that changes and we'd be happy to help."
                          rows={3}
                          maxLength={500}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#2E75B6]/30 resize-y"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={addTopic}
          className="inline-flex items-center gap-2 text-sm text-[#2E75B6] hover:text-[#1e5a8f]"
        >
          <Plus className="w-4 h-4" />
          {t("topics.add")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-[#2E75B6] text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-[#1e5a8f] disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {saving ? t("topics.saving") : t("topics.save")}
        </button>
      </div>
    </div>
  );
}
