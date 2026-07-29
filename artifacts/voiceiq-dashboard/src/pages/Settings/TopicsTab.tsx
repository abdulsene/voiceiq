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
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { fetchApi, getAuthHeaders } from "../../lib/api";

interface Topic {
  slug: string;
  name: string;
  description: string;
  example_utterances: string[];
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
      const res = await fetch("/api/business/topics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ topics }),
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
