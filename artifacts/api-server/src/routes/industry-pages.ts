/**
 * Public industry catalogue API.
 *
 * These endpoints power the marketing landing pages and on-site demo
 * generator — they do NOT require auth and they do NOT touch a tenant's
 * data. The catalogue itself lives in
 * `src/data/comprehensive-industries.ts`.
 *
 * Notable deviations from the rough spec:
 *   * `category` filter matches against either the human `industryCategory`
 *     string ("Healthcare") OR the category id ("healthcare") so the UI can
 *     pass whichever it has on hand. The original spec only accepted the
 *     human string, which is fragile across translations.
 *   * `limit` is capped at 100 to keep response sizes bounded.
 *   * Demo customisation handles every `[BRACKET_TOKEN]` substitution in a
 *     single regex pass instead of N chained `.replace()` calls.
 *   * `[URGENT_ACTION_NOTE]` is honoured as a substitution token (the
 *     original spec used `${URGENT_ACTION_REQUIRED ? ... }` inside a
 *     template literal which would have ReferenceError'd at module load).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import {
  REVOLUTIONARY_INDUSTRIES,
  INDUSTRY_CATEGORIES,
  getIndustryByCode,
  type IndustryTemplate,
  type TemplateCategory,
} from "../data/comprehensive-industries.js";

const router: IRouter = Router();

const VALID_SCENARIO_TYPES: Set<TemplateCategory> = new Set([
  "lead_generation",
  "appointment_booking",
  "customer_service",
  "sales_follow_up",
  "emergency_response",
  "compliance",
  "upsell_cross_sell",
]);

const CATEGORY_NAME_BY_ID: Record<string, string> = INDUSTRY_CATEGORIES.reduce(
  (acc, c) => {
    acc[c.id] = c.name;
    return acc;
  },
  {} as Record<string, string>,
);

function resolveCategoryFilter(raw: string): string | null {
  // Accept either category id ("healthcare") or display name ("Healthcare").
  if (CATEGORY_NAME_BY_ID[raw]) return CATEGORY_NAME_BY_ID[raw];
  const direct = INDUSTRY_CATEGORIES.find((c) => c.name.toLowerCase() === raw.toLowerCase());
  return direct ? direct.name : raw;
}

// ---------------------------------------------------------------------------
// GET /api/industries — list with optional filters
// ---------------------------------------------------------------------------
router.get("/industries", async (req: Request, res: Response) => {
  try {
    const { category, featured, limit } = req.query as {
      category?: string;
      featured?: string;
      limit?: string;
    };

    let industries: IndustryTemplate[] = REVOLUTIONARY_INDUSTRIES;

    if (category) {
      const wanted = resolveCategoryFilter(String(category));
      industries = industries.filter((ind) => ind.industryCategory === wanted);
    }

    if (featured === "true") {
      const featuredCategoryNames = new Set(
        INDUSTRY_CATEGORIES.filter((c) => c.isFeatured).map((c) => c.name),
      );
      industries = industries.filter((ind) => featuredCategoryNames.has(ind.industryCategory));
    }

    if (limit) {
      const parsed = Number.parseInt(String(limit), 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      industries = industries.slice(0, Math.min(parsed, 100));
    }

    return res.json({
      industries: industries.map((industry) => ({
        code: industry.industryCode,
        name: industry.industryName,
        category: industry.industryCategory,
        description: industry.description,
        primaryPainPoints: industry.painPoints.primary,
        immediateValue: industry.valuePropositions.immediate,
        templateCount: industry.templates.length,
        roiMetrics: {
          revenueGrowth: industry.roiMetrics.revenueGrowth,
          timeToValue: industry.roiMetrics.timeToValue,
        },
        pricing: industry.pricingModel.professionalTier,
      })),
      categories: INDUSTRY_CATEGORIES,
      totalCount: REVOLUTIONARY_INDUSTRIES.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Industries] list error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/industries/:industryCode — full detail for one industry
// ---------------------------------------------------------------------------
router.get("/industries/:industryCode", async (req: Request, res: Response) => {
  try {
    const industry = getIndustryByCode(req.params.industryCode);
    if (!industry) return res.status(404).json({ error: "Industry not found" });

    return res.json({
      industry: {
        ...industry,
        competitorAnalysis: generateCompetitorAnalysis(industry),
        marketSizeData: generateMarketData(industry),
        successStories: generateSuccessStories(industry),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Industries] detail error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/industries/:industryCode/demo — generate a customised demo
// ---------------------------------------------------------------------------
router.post("/industries/:industryCode/demo", async (req: Request, res: Response) => {
  try {
    const industry = getIndustryByCode(req.params.industryCode);
    if (!industry) return res.status(404).json({ error: "Industry not found" });

    const { scenarioType = "lead_generation", customization = {} } = (req.body ?? {}) as {
      scenarioType?: string;
      customization?: Record<string, string>;
    };

    if (!VALID_SCENARIO_TYPES.has(scenarioType as TemplateCategory)) {
      return res.status(400).json({
        error: `Invalid scenarioType. Must be one of: ${Array.from(VALID_SCENARIO_TYPES).join(", ")}`,
      });
    }

    const template =
      industry.templates.find((t) => t.category === (scenarioType as TemplateCategory)) ||
      industry.templates[0];

    if (!template) {
      return res.status(404).json({ error: "No templates configured for this industry" });
    }

    const businessName = customization.businessName || `${industry.industryName} Demo`;
    const substitutions: Record<string, string> = {
      PRACTICE_NAME: businessName,
      PROVIDER: customization.providerName || "Dr. Smith",
      FIRM_NAME: businessName,
      GYM_NAME: businessName,
      STORE_NAME: businessName,
      RENTAL_COMPANY: businessName,
      TRAINER_NAME: customization.providerName || "your trainer",
      // Sensible defaults for tokens that would otherwise leak as
      // literal "[CLIENT_NAME]" strings in a generated demo.
      CLIENT_NAME: customization.clientName || "there",
      MEMBER_NAME: customization.clientName || "there",
      CUSTOMER_NAME: customization.clientName || "there",
      PET_NAME: "your pet",
      URGENT_ACTION_NOTE: "No action required from you at this time.",
    };
    // One-pass substitution — any unrecognised token survives untouched
    // so the UI can highlight it as still-needs-data.
    const customizedScript = template.script.replace(/\[([A-Z_]+)\]/g, (full, key) =>
      Object.prototype.hasOwnProperty.call(substitutions, key) ? substitutions[key] : full,
    );

    const demoId = `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return res.json({
      demo: {
        id: demoId,
        industry: industry.industryName,
        scenario: template.name,
        scenarioType: template.category,
        script: customizedScript,
        expectedOutcomes: template.outcomes,
        estimatedDuration: 60,
        customization: {
          businessName,
          industry: industry.industryName,
          painPoint: industry.painPoints.primary[0],
          valueProposition: industry.valuePropositions.immediate[0],
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Industries] demo error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Synthetic helpers — placeholders until we wire real market intel
// ---------------------------------------------------------------------------
function generateCompetitorAnalysis(_industry: IndustryTemplate) {
  return {
    mainCompetitors: ["Traditional phone systems", "Basic appointment booking software", "Generic customer service platforms"],
    competitiveAdvantages: ["Industry-specific AI training", "Compliance-aware communications", "Integrated workflow automation"],
    marketPosition: "Revolutionary industry-specific AI solution",
  };
}

function generateMarketData(_industry: IndustryTemplate) {
  return {
    totalAddressableMarket: "$2.4B",
    servicableAddressableMarket: "$450M",
    growthRate: "15% annually",
    keyTrends: ["Increasing automation adoption", "Rising labor costs", "Growing customer service expectations"],
  };
}

function generateSuccessStories(industry: IndustryTemplate) {
  return [
    {
      businessType: industry.industryName,
      challenge: industry.painPoints.primary[0],
      solution: industry.valuePropositions.immediate[0],
      results: industry.roiMetrics.revenueGrowth,
      timeframe: industry.roiMetrics.timeToValue,
    },
  ];
}

export default router;
