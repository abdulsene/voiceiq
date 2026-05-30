// Runtime translation helper for industry briefs.
// Source of truth (English) lives in src/data/featured-industries.ts.
// Per-locale overrides live under marketing.industries.<slug>.* in
// src/i18n/{en,es,fr}.json. Missing keys fall back to the English value.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  INDUSTRIES,
  getIndustryBySlug,
  type IndustryBrief,
} from "../data/featured-industries";

// Deep-merge: for every leaf in `base`, prefer the corresponding value from
// `overrides` when it's a non-empty string (or non-empty array). Anything
// missing in `overrides` falls back to `base`. Keeps integration vendor
// names, slug, emoji, category, etc. as-is from `base`.
function mergeBrief(base: IndustryBrief, overrides: any): IndustryBrief {
  if (!overrides || typeof overrides !== "object") return base;

  const pick = <T,>(o: any, b: T): T =>
    o === undefined || o === null || o === "" ? b : (o as T);

  const mergeArrayOfObjects = <T extends Record<string, any>>(
    baseArr: T[],
    overrideArr: any,
  ): T[] => {
    if (!Array.isArray(overrideArr)) return baseArr;
    return baseArr.map((item, i) => {
      const ov = overrideArr[i];
      if (!ov || typeof ov !== "object") return item;
      const out: any = { ...item };
      for (const k of Object.keys(item)) {
        out[k] = pick(ov[k], (item as any)[k]);
      }
      return out as T;
    });
  };

  const mergeStringArray = (baseArr: string[], overrideArr: any): string[] => {
    if (!Array.isArray(overrideArr)) return baseArr;
    return baseArr.map((s, i) =>
      typeof overrideArr[i] === "string" && overrideArr[i].trim() !== ""
        ? overrideArr[i]
        : s,
    );
  };

  return {
    ...base,
    name: pick(overrides.name, base.name),
    shortPitch: pick(overrides.shortPitch, base.shortPitch),
    hero: {
      headline: pick(overrides.hero?.headline, base.hero.headline),
      subhead: pick(overrides.hero?.subhead, base.hero.subhead),
      ctaPrimary: pick(overrides.hero?.ctaPrimary, base.hero.ctaPrimary),
      ctaSecondary: pick(overrides.hero?.ctaSecondary, base.hero.ctaSecondary),
    },
    pain: mergeArrayOfObjects(base.pain, overrides.pain),
    proof: {
      title: pick(overrides.proof?.title, base.proof.title),
      setup: pick(overrides.proof?.setup, base.proof.setup),
      transcript: mergeArrayOfObjects(base.proof.transcript, overrides.proof?.transcript),
      durationLabel: pick(overrides.proof?.durationLabel, base.proof.durationLabel),
      handoffMarkers: mergeStringArray(
        base.proof.handoffMarkers,
        overrides.proof?.handoffMarkers,
      ),
      caption: pick(overrides.proof?.caption, base.proof.caption),
    },
    howItWorks: mergeArrayOfObjects(base.howItWorks, overrides.howItWorks),
    whatItHandles: mergeStringArray(base.whatItHandles, overrides.whatItHandles),
    beyondTheCall: {
      headline: pick(overrides.beyondTheCall?.headline, base.beyondTheCall.headline),
      subhead: pick(overrides.beyondTheCall?.subhead, base.beyondTheCall.subhead),
      blocks: mergeArrayOfObjects(
        base.beyondTheCall.blocks,
        overrides.beyondTheCall?.blocks,
      ),
    },
    whyNeverr: {
      headline: pick(overrides.whyNeverr?.headline, base.whyNeverr.headline),
      blocks: mergeArrayOfObjects(base.whyNeverr.blocks, overrides.whyNeverr?.blocks),
    },
    integrations: {
      headline: pick(overrides.integrations?.headline, base.integrations.headline),
      body: pick(overrides.integrations?.body, base.integrations.body),
      examples: base.integrations.examples, // keep proper-noun vendor names
    },
    close: {
      headline: pick(overrides.close?.headline, base.close.headline),
      subhead: pick(overrides.close?.subhead, base.close.subhead),
      ctaPrimary: pick(overrides.close?.ctaPrimary, base.close.ctaPrimary),
      ctaSecondary: pick(overrides.close?.ctaSecondary, base.close.ctaSecondary),
    },
    seo: {
      title: pick(overrides.seo?.title, base.seo.title),
      description: pick(overrides.seo?.description, base.seo.description),
    },
  };
}

function getOverridesFor(i18n: ReturnType<typeof useTranslation>["i18n"], slug: string): any {
  const lng = i18n.resolvedLanguage || i18n.language || "en";
  // i18next stores nested under `translation` namespace.
  const bundle: any = i18n.getResourceBundle(lng, "translation");
  return bundle?.marketing?.industries?.[slug] ?? null;
}

export function useTranslatedIndustry(slug: string): IndustryBrief | undefined {
  const { i18n } = useTranslation();
  const lng = i18n.resolvedLanguage || i18n.language;

  return useMemo(() => {
    const base = getIndustryBySlug(slug);
    if (!base) return undefined;
    if ((lng || "en").startsWith("en")) return base;
    const overrides = getOverridesFor(i18n, slug);
    return overrides ? mergeBrief(base, overrides) : base;
  }, [slug, lng, i18n]);
}

export function useTranslatedIndustries(): IndustryBrief[] {
  const { i18n } = useTranslation();
  const lng = i18n.resolvedLanguage || i18n.language;

  return useMemo(() => {
    if ((lng || "en").startsWith("en")) return INDUSTRIES;
    return INDUSTRIES.map((base) => {
      const overrides = getOverridesFor(i18n, base.slug);
      return overrides ? mergeBrief(base, overrides) : base;
    });
  }, [lng, i18n]);
}

// Convenience selectors that mirror the data-file helpers but return
// translated copies. Use these in IndustriesHub / IndustriesMegaMenu so
// callers don't have to filter twice.
export function useTranslatedFeaturedIndustries(): IndustryBrief[] {
  const list = useTranslatedIndustries();
  return useMemo(() => list.filter((b) => b.featured), [list]);
}

export function useTranslatedIndustriesByCategory(
  category: IndustryBrief["category"],
): IndustryBrief[] {
  const list = useTranslatedIndustries();
  return useMemo(
    () => list.filter((b) => b.category === category),
    [list, category],
  );
}
