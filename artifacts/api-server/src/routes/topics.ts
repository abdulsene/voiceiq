/**
 * Phase 3.1a — customer service topic catalogue endpoints.
 *
 *   GET   /api/business/topics             — current + industry defaults
 *   PATCH /api/business/topics             — full replacement of the list
 *   POST  /api/business/topics/reset       — restore industry defaults
 *
 * Topics live on business_configs.departments (JSONB array of {slug,
 * name, description, example_utterances}). Industry defaults live on
 * industry_templates.default_topics (populated by migration 036).
 *
 * PATCH is a bulk replace, not a differential update — the UI sends the
 * full list, we write it verbatim after validation. This matches the
 * settings-page mental model ("edit the list, hit save") and avoids
 * merge conflicts across concurrent editors.
 *
 * Slug validation rules:
 *   * snake_case: /^[a-z][a-z0-9_]*$/
 *   * unique within the list
 *   * max 12 topics per business (soft product cap — bump if needed)
 *
 * Handlers exported as pure functions for the 035 smoke.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";

const router = Router();

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const MAX_TOPICS = 12;
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const UTTERANCE_MAX = 200;
const MAX_UTTERANCES = 10;

// Phase 6.0 — qualification gate limits.
const REQUIREMENTS_TEXT_MAX = 2000;
const CLOSE_MESSAGE_MAX = 500;
const DISQUALIFIER_LABEL_MAX = 120;
const MAX_DISQUALIFIERS = 20;
const VALID_DISQUALIFIER_KINDS = ["permanent", "temporary"] as const;
type DisqualifierKind = (typeof VALID_DISQUALIFIER_KINDS)[number];

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Types ────────────────────────────────────────────────────────────

export interface Disqualifier {
  id: string;
  label: string;
  kind: DisqualifierKind;
}

export interface QualificationBlock {
  enabled: boolean;
  requirements_text: string;
  disqualifiers: Disqualifier[];
  permanent_close: string;
  temporary_close: string;
}

export interface Topic {
  slug: string;
  name: string;
  description: string;
  example_utterances: string[];
  // Phase 6.0 — optional. When present with enabled=true, Alex speaks
  // requirements_text before invoking route_to_topic, and routes
  // unqualified callers to request_callback with a disqualifier_id.
  qualification?: QualificationBlock;
}

// ── Validation ───────────────────────────────────────────────────────

export function parseTopicsBody(body: unknown): { topics: Topic[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.topics)) return { error: "topics must be an array" };
  if (b.topics.length > MAX_TOPICS) return { error: `at most ${MAX_TOPICS} topics per business` };

  const out: Topic[] = [];
  const seenSlugs = new Set<string>();
  for (const raw of b.topics as unknown[]) {
    if (!raw || typeof raw !== "object") return { error: "each topic must be an object" };
    const t = raw as Record<string, unknown>;

    const slug = typeof t.slug === "string" ? t.slug.trim() : "";
    if (!SLUG_RE.test(slug)) return { error: `invalid slug "${slug}" (expected snake_case)` };
    if (seenSlugs.has(slug)) return { error: `duplicate slug "${slug}"` };
    seenSlugs.add(slug);

    const name = typeof t.name === "string" ? t.name.trim() : "";
    if (!name) return { error: `topic "${slug}" is missing name` };
    if (name.length > NAME_MAX) return { error: `topic "${slug}" name exceeds ${NAME_MAX} chars` };

    const description = typeof t.description === "string" ? t.description.trim() : "";
    if (description.length > DESCRIPTION_MAX) {
      return { error: `topic "${slug}" description exceeds ${DESCRIPTION_MAX} chars` };
    }

    let example_utterances: string[] = [];
    if (Array.isArray(t.example_utterances)) {
      example_utterances = t.example_utterances
        .filter((u): u is string => typeof u === "string")
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
      if (example_utterances.length > MAX_UTTERANCES) {
        return { error: `topic "${slug}" has too many example_utterances (max ${MAX_UTTERANCES})` };
      }
      for (const u of example_utterances) {
        if (u.length > UTTERANCE_MAX) {
          return { error: `topic "${slug}" utterance exceeds ${UTTERANCE_MAX} chars` };
        }
      }
    }

    const topicOut: Topic = { slug, name, description, example_utterances };

    if (t.qualification != null) {
      const parsedQ = parseQualification(slug, t.qualification);
      if ("error" in parsedQ) return { error: parsedQ.error };
      // Only attach when there is meaningful content. Explicitly-empty
      // qualification blocks (enabled:false + no requirements + no
      // disqualifiers) are dropped so the JSONB doesn't accumulate
      // dead structure when a tenant toggles the feature off then on.
      if (
        parsedQ.enabled ||
        parsedQ.requirements_text.length > 0 ||
        parsedQ.disqualifiers.length > 0
      ) {
        topicOut.qualification = parsedQ;
      }
    }

    out.push(topicOut);
  }
  return { topics: out };
}

// Phase 6.0 — validate the per-topic qualification sub-object.
// Server-side enforcement of the "id is readonly" contract: ids must
// match SLUG_RE and be unique within the topic. Since PATCH is a bulk
// replace, we can't detect a "rename" vs a "delete + add" — both
// present identically. The dashboard's fallback-to-raw-id renderer
// handles orphaned lead references either way, so we don't need to
// try to distinguish; we just make sure incoming ids are well-formed.
function parseQualification(
  slug: string,
  raw: unknown,
): QualificationBlock | { error: string } {
  if (!raw || typeof raw !== "object") {
    return { error: `topic "${slug}" qualification must be an object` };
  }
  const q = raw as Record<string, unknown>;

  const enabled = q.enabled === true;

  const requirementsRaw = typeof q.requirements_text === "string" ? q.requirements_text.trim() : "";
  if (requirementsRaw.length > REQUIREMENTS_TEXT_MAX) {
    return { error: `topic "${slug}" requirements_text exceeds ${REQUIREMENTS_TEXT_MAX} chars` };
  }

  const permanentClose = typeof q.permanent_close === "string" ? q.permanent_close.trim() : "";
  if (permanentClose.length > CLOSE_MESSAGE_MAX) {
    return { error: `topic "${slug}" permanent_close exceeds ${CLOSE_MESSAGE_MAX} chars` };
  }
  const temporaryClose = typeof q.temporary_close === "string" ? q.temporary_close.trim() : "";
  if (temporaryClose.length > CLOSE_MESSAGE_MAX) {
    return { error: `topic "${slug}" temporary_close exceeds ${CLOSE_MESSAGE_MAX} chars` };
  }

  const disqualifiers: Disqualifier[] = [];
  const seenIds = new Set<string>();
  const rawList = Array.isArray(q.disqualifiers) ? q.disqualifiers : [];
  if (rawList.length > MAX_DISQUALIFIERS) {
    return { error: `topic "${slug}" has too many disqualifiers (max ${MAX_DISQUALIFIERS})` };
  }
  for (const rawD of rawList as unknown[]) {
    if (!rawD || typeof rawD !== "object") {
      return { error: `topic "${slug}" each disqualifier must be an object` };
    }
    const d = rawD as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id.trim() : "";
    if (!SLUG_RE.test(id)) {
      return { error: `topic "${slug}" disqualifier id "${id}" must be snake_case` };
    }
    if (seenIds.has(id)) {
      return { error: `topic "${slug}" duplicate disqualifier id "${id}"` };
    }
    seenIds.add(id);
    const label = typeof d.label === "string" ? d.label.trim() : "";
    if (!label) {
      return { error: `topic "${slug}" disqualifier "${id}" is missing label` };
    }
    if (label.length > DISQUALIFIER_LABEL_MAX) {
      return { error: `topic "${slug}" disqualifier "${id}" label exceeds ${DISQUALIFIER_LABEL_MAX} chars` };
    }
    const kind = typeof d.kind === "string" ? d.kind : "";
    if (!(VALID_DISQUALIFIER_KINDS as readonly string[]).includes(kind)) {
      return { error: `topic "${slug}" disqualifier "${id}" kind must be one of ${VALID_DISQUALIFIER_KINDS.join(", ")}` };
    }
    disqualifiers.push({ id, label, kind: kind as DisqualifierKind });
  }

  // When the block is enabled it MUST carry the pieces Alex needs to
  // actually run the flow. Turning it off relaxes these — the tenant
  // can leave partially-filled content in place while iterating.
  if (enabled) {
    if (!requirementsRaw) {
      return { error: `topic "${slug}" requirements_text is required when qualification.enabled` };
    }
    if (disqualifiers.length === 0) {
      return { error: `topic "${slug}" must define at least one disqualifier when qualification.enabled` };
    }
    const hasPermanent = disqualifiers.some((d) => d.kind === "permanent");
    const hasTemporary = disqualifiers.some((d) => d.kind === "temporary");
    if (hasPermanent && !permanentClose) {
      return { error: `topic "${slug}" permanent_close is required when a permanent disqualifier exists` };
    }
    if (hasTemporary && !temporaryClose) {
      return { error: `topic "${slug}" temporary_close is required when a temporary disqualifier exists` };
    }
  }

  return {
    enabled,
    requirements_text: requirementsRaw,
    disqualifiers,
    permanent_close: permanentClose,
    temporary_close: temporaryClose,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function handleGetTopics(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; topics: Topic[]; industry_defaults: Topic[]; industry_id: string | null }
  | { ok: false; status: number; error: string }
> {
  try {
    const bizResp = await supabase
      .from("business_configs")
      .select("departments, industry")
      .eq("business_id", businessId)
      .maybeSingle();
    if (bizResp.error) {
      Sentry.captureMessage("topics_get_biz_failed", {
        level: "error",
        extra: { businessId, error: bizResp.error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    const bizRow = bizResp.data as { departments?: unknown; industry?: string | null } | null;
    if (!bizRow) return { ok: false, status: 404, error: "Business not found" };

    const topics = normalizeTopicsJsonb(bizRow.departments);
    const industryId = bizRow.industry || null;

    let industry_defaults: Topic[] = [];
    if (industryId) {
      const indResp = await supabase
        .from("industry_templates")
        .select("default_topics")
        .eq("industry_id", industryId)
        .maybeSingle();
      if (!indResp.error && indResp.data) {
        industry_defaults = normalizeTopicsJsonb((indResp.data as any).default_topics);
      }
    }
    return { ok: true, topics, industry_defaults, industry_id: industryId };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handlePatchTopics(
  supabase: SupabaseClient,
  businessId: string,
  topics: Topic[],
): Promise<{ ok: true; topics: Topic[] } | { ok: false; status: number; error: string }> {
  try {
    const { data, error } = await supabase
      .from("business_configs")
      .update({ departments: topics })
      .eq("business_id", businessId)
      .select("departments")
      .maybeSingle();
    if (error) {
      Sentry.captureMessage("topics_patch_failed", {
        level: "error",
        extra: { businessId, error: error.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    if (!data) return { ok: false, status: 404, error: "Business not found" };
    return { ok: true, topics: normalizeTopicsJsonb((data as any).departments) };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

export async function handleResetTopics(
  supabase: SupabaseClient,
  businessId: string,
): Promise<
  | { ok: true; topics: Topic[]; source: "industry_defaults" | "empty" }
  | { ok: false; status: number; error: string }
> {
  try {
    const bizResp = await supabase
      .from("business_configs")
      .select("industry")
      .eq("business_id", businessId)
      .maybeSingle();
    if (bizResp.error) return { ok: false, status: 500, error: "Database error" };
    if (!bizResp.data) return { ok: false, status: 404, error: "Business not found" };
    const industryId = (bizResp.data as any).industry as string | null;

    let defaults: Topic[] = [];
    let source: "industry_defaults" | "empty" = "empty";
    if (industryId) {
      const indResp = await supabase
        .from("industry_templates")
        .select("default_topics")
        .eq("industry_id", industryId)
        .maybeSingle();
      if (!indResp.error && indResp.data) {
        defaults = normalizeTopicsJsonb((indResp.data as any).default_topics);
        if (defaults.length > 0) source = "industry_defaults";
      }
    }

    const { error: updateErr } = await supabase
      .from("business_configs")
      .update({ departments: defaults })
      .eq("business_id", businessId);
    if (updateErr) {
      Sentry.captureMessage("topics_reset_failed", {
        level: "error",
        extra: { businessId, error: updateErr.message },
      });
      return { ok: false, status: 500, error: "Database error" };
    }
    return { ok: true, topics: defaults, source };
  } catch (err: any) {
    return { ok: false, status: 500, error: err?.message || "Database error" };
  }
}

function normalizeTopicsJsonb(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  for (const t of raw as any[]) {
    if (!t || typeof t !== "object") continue;
    const slug = typeof t.slug === "string" ? t.slug : "";
    const name = typeof t.name === "string" ? t.name : "";
    if (!slug || !name) continue;
    const topic: Topic = {
      slug,
      name,
      description: typeof t.description === "string" ? t.description : "",
      example_utterances: Array.isArray(t.example_utterances)
        ? (t.example_utterances as unknown[]).filter((u): u is string => typeof u === "string")
        : [],
    };
    const q = normalizeQualificationJsonb(t.qualification);
    if (q) topic.qualification = q;
    out.push(topic);
  }
  return out;
}

// Lenient sibling to parseQualification. Read-path: don't reject rows
// that predate the qualification field or carry partial content; drop
// individual disqualifiers with malformed shape and return whatever
// survives. Producers of this JSONB (parseTopicsBody above) already
// enforce strict validation on write, so degraded data here is a signal
// that the JSONB was hand-edited or came from an older schema — the
// UI can still render what remains.
function normalizeQualificationJsonb(raw: unknown): QualificationBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const disqualifiers: Disqualifier[] = [];
  const rawList = Array.isArray(q.disqualifiers) ? q.disqualifiers : [];
  for (const rawD of rawList as unknown[]) {
    if (!rawD || typeof rawD !== "object") continue;
    const d = rawD as Record<string, unknown>;
    const id = typeof d.id === "string" ? d.id.trim() : "";
    const label = typeof d.label === "string" ? d.label.trim() : "";
    const kind = typeof d.kind === "string" ? d.kind : "";
    if (!id || !label) continue;
    if (!(VALID_DISQUALIFIER_KINDS as readonly string[]).includes(kind)) continue;
    disqualifiers.push({ id, label, kind: kind as DisqualifierKind });
  }
  return {
    enabled: q.enabled === true,
    requirements_text: typeof q.requirements_text === "string" ? q.requirements_text : "",
    disqualifiers,
    permanent_close: typeof q.permanent_close === "string" ? q.permanent_close : "",
    temporary_close: typeof q.temporary_close === "string" ? q.temporary_close : "",
  };
}

// ── Route registrations ─────────────────────────────────────────────

router.get(
  "/business/topics",
  requireAuth,
  requirePermission("settings", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleGetTopics(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      topics: result.topics,
      industry_defaults: result.industry_defaults,
      industry_id: result.industry_id,
    });
  },
);

router.patch(
  "/business/topics",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const parsed = parseTopicsBody(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const result = await handlePatchTopics(supabase, businessId, parsed.topics);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ topics: result.topics });
  },
);

router.post(
  "/business/topics/reset",
  requireAuth,
  requirePermission("settings", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const result = await handleResetTopics(supabase, businessId);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({ topics: result.topics, source: result.source });
  },
);

export default router;
