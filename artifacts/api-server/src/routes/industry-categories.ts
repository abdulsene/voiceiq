/**
 * Phase 3h: public template-category navigation API.
 *
 * These three endpoints power the /industries hub + category pages on
 * the marketing site. They read from the `industry_templates` Supabase
 * table (NOT the in-memory `comprehensive-industries.ts` catalogue used
 * by industry-pages.ts) so that templates added/edited via the admin UI
 * show up immediately without a redeploy.
 *
 * Mounted BEFORE industry-pages.ts in routes/index.ts so the specific
 * paths (/industries/categories, /industries/category/:slug,
 * /industries/:industry_id/preview) win over industry-pages.ts's
 * generic /industries/:industryCode wildcard.
 *
 * Auth: all three are unauthenticated. AUTH_BYPASS_PATTERNS already
 * includes `/^\/api\/industries(\/|$)/`, so nothing to add in app.ts.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";

const router: IRouter = Router();

let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

function categorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unslugifyCategory(slug: string, allCategories: string[]): string | null {
  return allCategories.find((c) => categorySlug(c) === slug) || null;
}

// ──────────────────────────────────────────
// GET /api/industries/categories
// ──────────────────────────────────────────
router.get("/industries/categories", async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database unavailable" });
    return;
  }

  const { data, error } = await supabase
    .from("industry_templates")
    .select("industry_id, name, canonical_category")
    .not("canonical_category", "is", null);

  if (error) {
    console.error("[IndustryCategories] list fetch error:", error.message);
    res.status(500).json({ error: "Fetch failed" });
    return;
  }

  const byCategory: Record<string, Array<{ industry_id: string; name: string }>> = {};
  for (const row of (data || []) as Array<{ industry_id: string; name: string; canonical_category: string | null }>) {
    const cat = row.canonical_category || "Other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({ industry_id: row.industry_id, name: row.name });
  }

  // Sprint 4 FIX 4a: featured categories first (alphabetical within
  // featured), then everything else alphabetical. Featured set per Abdul
  // A3-α decision: maps the INDUSTRY_CATEGORIES const intent ("Healthcare",
  // "Professional Services", "Legal Services", "Health & Fitness",
  // "Transportation") to the live canonical_category names actually
  // present in industry_templates.
  const FEATURED_CATEGORIES = new Set([
    "Fitness & Recreation",
    "Healthcare & Medical",
    "Legal Services",
    "Technology & Professional Services",
    "Transportation & Logistics",
  ]);
  const categories = Object.entries(byCategory)
    .sort(([a], [b]) => {
      const aF = FEATURED_CATEGORIES.has(a);
      const bF = FEATURED_CATEGORIES.has(b);
      if (aF && !bF) return -1;
      if (!aF && bF) return 1;
      return a.localeCompare(b);
    })
    .map(([name, industries]) => ({
      name,
      slug: categorySlug(name),
      industry_count: industries.length,
      sample_industries: industries.slice(0, 4).map((i) => i.name),
    }));

  res.json({ success: true, categories, total_industries: (data || []).length });
});

// ──────────────────────────────────────────
// GET /api/industries/category/:slug
// ──────────────────────────────────────────
router.get("/industries/category/:slug", async (req: Request, res: Response) => {
  const slug = req.params.slug;

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database unavailable" });
    return;
  }

  const { data: allRows, error: allErr } = await supabase
    .from("industry_templates")
    .select("canonical_category")
    .not("canonical_category", "is", null);

  if (allErr) {
    console.error("[IndustryCategories] category lookup error:", allErr.message);
    res.status(500).json({ error: "Fetch failed" });
    return;
  }

  const allCats = Array.from(
    new Set(((allRows || []) as Array<{ canonical_category: string | null }>).map((r) => r.canonical_category).filter((c): c is string => !!c)),
  );
  const categoryName = unslugifyCategory(slug, allCats);

  if (!categoryName) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  const { data, error } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description")
    .eq("canonical_category", categoryName)
    .order("name");

  if (error) {
    console.error("[IndustryCategories] category fetch error:", error.message);
    res.status(500).json({ error: "Fetch failed" });
    return;
  }

  res.json({
    success: true,
    category: { name: categoryName, slug },
    industries: data || [],
  });
});

// ──────────────────────────────────────────
// GET /api/industries/:industry_id/preview
// ──────────────────────────────────────────
router.get("/industries/:industry_id/preview", async (req: Request, res: Response) => {
  const industryId = req.params.industry_id;

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database unavailable" });
    return;
  }

  const { data, error } = await supabase
    .from("industry_templates")
    .select("industry_id, name, description, canonical_category, pain_points, value_props, call_scripts, roi_snapshot")
    .eq("industry_id", industryId)
    .maybeSingle();

  if (error) {
    console.error("[IndustryCategories] preview fetch error:", error.message);
    res.status(500).json({ error: "Fetch failed" });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Industry not found" });
    return;
  }

  const row = data as {
    industry_id: string;
    name: string;
    description: string | null;
    canonical_category: string | null;
    pain_points: unknown;
    value_props: unknown;
    call_scripts: unknown;
    roi_snapshot: unknown;
  };

  const sampleScript =
    Array.isArray(row.call_scripts) && row.call_scripts.length > 0 ? row.call_scripts[0] : null;

  res.json({
    success: true,
    industry: {
      industry_id: row.industry_id,
      name: row.name,
      description: row.description || "",
      canonical_category: row.canonical_category,
      pain_points: Array.isArray(row.pain_points) ? row.pain_points.slice(0, 5) : [],
      value_props: Array.isArray(row.value_props) ? row.value_props.slice(0, 5) : [],
      sample_script: sampleScript,
      roi_snapshot: row.roi_snapshot || null,
    },
  });
});

export default router;
