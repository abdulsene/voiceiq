/**
 * Leads endpoints — Slice 1 of the leads epic. Read-only foundation
 * for the callback-first escalation flow.
 *
 * Three surfaces, three auth profiles:
 *
 *   POST /api/leads/capture
 *     PUBLIC — bypass-listed in app.ts AUTH_BYPASS_PATTERNS. Bearer-token
 *     authenticated against process.env.ELEVENLABS_TOOL_SECRET; the
 *     token is a shared secret known only to our backend and the
 *     ElevenLabs agent config (baked at PATCH time via
 *     agents.ts:buildRequestCallbackTool). Rotation: update env var on
 *     our side, then re-run updateAgentTools for every agent — a
 *     one-shot resync (we don't have it yet; for Slice 1, rotation
 *     means a brief PATCH loop in a one-off script).
 *
 *   GET /api/business/leads
 *   GET /api/business/leads/:id
 *     CUSTOMER — JWT-authenticated via requireAuth +
 *     requirePermission("settings", "read"). Scoped to the caller's
 *     current business_id; cross-tenant access is prevented by the
 *     supabase query .eq("business_id", req.businessId).
 *
 *   GET /api/admin/business/:businessId/leads
 *   GET /api/admin/business/:businessId/leads/:id
 *     ADMIN — staff-RBAC gated via requireStaffPermission("leads",
 *     "read"). Dedicated `leads` resource bucket added to
 *     staff-rbac.ts:DEFAULT_PERMISSIONS for Slice 1 so we don't have to
 *     retrofit when Slice 2 introduces leads:write / leads:assign.
 *     Same Stage 6 apiBase parity pattern as routes/transfer.ts.
 *
 * Slice 1 is READ + CAPTURE only. Slices 2+ will add staff actions
 * (claim/resolve/SMS/email) — explicitly out of scope here. No action
 * buttons on the detail page; no PUT/PATCH/DELETE.
 */
import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";
import { auditLog, extractRequestMeta } from "../middlewares/audit";
import { sendLeadSms } from "../lib/sms-service";
import { signTrustToken } from "../lib/trust-portal-token";
import { briefReason, portalUrlFromToken } from "../lib/sms-templates";
import { normalizeUrgency, slaLabel } from "../lib/lead-sla";

const router = Router();

// Field caps that mirror the LiteralJsonSchemaProperty descriptions on
// the ElevenLabs tool side — enforce them again here so a misbehaving
// agent (or anyone with the shared secret) can't insert pathological
// values that bloat the row.
const NAME_MAX = 200;
const PHONE_MAX = 20;
const EMAIL_MAX = 320;
const REASON_MAX = 2000;
const CONVERSATION_ID_MAX = 128;
const RESOLUTION_NOTE_MAX = 2000;
void RESOLUTION_NOTE_MAX; // unused in Slice 1; cap declared for Slice 2 parity

const VALID_URGENCY = ["low", "medium", "high", "emergency"] as const;
const VALID_CHANNEL = ["text", "call", "email", "voice_callback"] as const;
type Urgency = (typeof VALID_URGENCY)[number];
type Channel = (typeof VALID_CHANNEL)[number];

const E164_RE = /^\+[1-9]\d{6,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Verify the inbound request carries the shared secret that we baked into
 * the ElevenLabs agent's request_callback tool. Returns the parsed token
 * or null. Constant-time compare to defeat timing oracles even though the
 * secret is high-entropy.
 */
function verifyToolSecret(req: Request): boolean {
  const expected = process.env.ELEVENLABS_TOOL_SECRET;
  if (!expected) return false;
  const header = (req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  const presented = header.slice(7).trim();
  if (presented.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

type CapturePayload = {
  business_id: string;
  conversation_id: string;
  contact_name: string;
  contact_phone: string;
  contact_email?: string;
  reason: string;
  urgency: Urgency;
  preferred_channel: Channel;
};

function parseCapturePayload(body: any): CapturePayload | { error: string } {
  if (!body || typeof body !== "object") return { error: "Request body required" };
  const requireStr = (k: string, max: number): string | { error: string } => {
    const v = body[k];
    if (typeof v !== "string" || !v.trim()) return { error: `${k} is required` };
    if (v.length > max) return { error: `${k} exceeds ${max} characters` };
    return v.trim();
  };
  const optionalStr = (k: string, max: number): string | undefined | { error: string } => {
    const v = body[k];
    if (v == null || v === "") return undefined;
    if (typeof v !== "string") return { error: `${k} must be a string when provided` };
    if (v.length > max) return { error: `${k} exceeds ${max} characters` };
    return v.trim();
  };

  const businessId = requireStr("business_id", 100);
  if (typeof businessId !== "string") return businessId;
  const conversationId = requireStr("conversation_id", CONVERSATION_ID_MAX);
  if (typeof conversationId !== "string") return conversationId;
  const contactName = requireStr("contact_name", NAME_MAX);
  if (typeof contactName !== "string") return contactName;
  const contactPhone = requireStr("contact_phone", PHONE_MAX);
  if (typeof contactPhone !== "string") return contactPhone;
  // Permissive E.164 check — the LLM should have already prepended +1
  // per the parameter description. Reject obvious garbage but don't get
  // strict about format details we can't enforce client-side.
  if (!E164_RE.test(contactPhone)) {
    return { error: "contact_phone must be E.164 format (e.g. +14105551234)" };
  }
  const contactEmail = optionalStr("contact_email", EMAIL_MAX);
  if (typeof contactEmail === "object") return contactEmail;
  if (contactEmail && !EMAIL_RE.test(contactEmail)) {
    return { error: "contact_email must be a valid email if provided" };
  }
  const reason = requireStr("reason", REASON_MAX);
  if (typeof reason !== "string") return reason;
  const urgency = typeof body.urgency === "string" ? body.urgency : null;
  if (!urgency || !(VALID_URGENCY as readonly string[]).includes(urgency)) {
    return { error: `urgency must be one of: ${VALID_URGENCY.join(", ")}` };
  }
  const preferredChannel = typeof body.preferred_channel === "string" ? body.preferred_channel : null;
  if (!preferredChannel || !(VALID_CHANNEL as readonly string[]).includes(preferredChannel)) {
    return { error: `preferred_channel must be one of: ${VALID_CHANNEL.join(", ")}` };
  }

  return {
    business_id: businessId,
    conversation_id: conversationId,
    contact_name: contactName,
    contact_phone: contactPhone,
    contact_email: contactEmail,
    reason,
    urgency: urgency as Urgency,
    preferred_channel: preferredChannel as Channel,
  };
}

// ── POST /api/leads/capture ────────────────────────────────────────────
// Public; Bearer-auth via shared secret. The AI's request_callback tool
// targets this endpoint.
//
// Note on business_id: we now bake business_id as a `constant_value` in
// the ElevenLabs tool schema (per buildRequestCallbackTool), so the AI's
// POST ALWAYS includes the correct business_id. The earlier spec
// mentioned an agent_id-based fallback via resolveBusinessFromAgentId,
// but with constant_value baked in that fallback is no longer needed —
// we just require business_id directly. Cleaner contract, less
// indirection.
router.post("/leads/capture", async (req: Request, res: Response) => {
  if (!verifyToolSecret(req)) {
    res.status(401).json({ error: "Invalid or missing bearer token" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "Database not configured" });
    return;
  }

  const parsed = parseCapturePayload(req.body);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    // Confirm the business exists. The agent config bakes business_id
    // as constant_value at PATCH time, so a mismatch here means the
    // business has been deleted (or the agent was reconfigured to a
    // bogus id). Return 404 so the LLM apologizes per its
    // tool_error_handling_mode='summarized' setting.
    const { data: biz, error: bizErr } = await supabase
      .from("business_configs")
      .select("business_id, business_name, sla_overrides")
      .eq("business_id", parsed.business_id)
      .maybeSingle();
    if (bizErr) {
      Sentry.captureMessage("leads_capture_business_lookup_failed", {
        level: "error",
        extra: { businessId: parsed.business_id, error: bizErr.message },
      });
      res.status(500).json({ error: "Database error" });
      return;
    }
    if (!biz) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    const bizRow = biz as {
      business_id: string;
      business_name: string | null;
      sla_overrides: Record<string, unknown> | null;
    };

    // Try to link to the source call. Best-effort — if no calls row
    // exists yet for this conversation (the post-call sync hasn't
    // landed), leave source_call_id null. The polling sync at
    // api.ts:720 will run within 2 minutes and back-fill the calls
    // row; we don't block lead capture on that.
    let sourceCallId: string | null = null;
    try {
      const { data: callRow } = await supabase
        .from("calls")
        .select("id")
        .eq("call_sid", parsed.conversation_id)
        .maybeSingle();
      sourceCallId = (callRow as { id?: string } | null)?.id ?? null;
    } catch {
      // best-effort; null is fine
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("leads")
      .insert({
        business_id: parsed.business_id,
        source: "ai_callback",
        source_call_id: sourceCallId,
        contact_name: parsed.contact_name,
        contact_phone: parsed.contact_phone,
        contact_email: parsed.contact_email ?? null,
        preferred_channel: parsed.preferred_channel,
        reason: parsed.reason,
        urgency: parsed.urgency,
        status: "new",
      })
      .select("id, created_at")
      .single();
    if (insertErr || !inserted) {
      Sentry.captureMessage("leads_capture_insert_failed", {
        level: "error",
        extra: { businessId: parsed.business_id, error: insertErr?.message, conversationId: parsed.conversation_id },
      });
      res.status(500).json({ error: "Failed to capture lead" });
      return;
    }
    const lead = inserted as { id: string; created_at: string };

    // Activity timeline seed — the 'captured' event. Always the first
    // entry on a lead's timeline; ai actor_type so the dashboard can
    // render the AI avatar/icon. Metadata holds the conversation_id
    // for traceability + the raw payload so an admin can debug any
    // mis-extraction by the LLM.
    const { error: activityErr } = await supabase
      .from("lead_activities")
      .insert({
        lead_id: lead.id,
        actor_id: null,
        actor_type: "ai",
        action: "captured",
        note: null,
        metadata: {
          conversation_id: parsed.conversation_id,
          source_call_id: sourceCallId,
          urgency: parsed.urgency,
          preferred_channel: parsed.preferred_channel,
        },
      });
    if (activityErr) {
      // Lead was inserted but the activity wasn't. Log + Sentry but
      // STILL return success — the lead exists, and the customer can
      // see it. The timeline gap will show "captured" missing as the
      // first entry; acceptable failure mode for v1.
      Sentry.captureMessage("leads_capture_activity_insert_failed", {
        level: "error",
        extra: { leadId: lead.id, error: activityErr.message },
      });
    }

    // Audit-log the capture as well (separate from lead_activities —
    // audit_logs is the cross-cutting system record; lead_activities is
    // the lead-scoped timeline UI consumes).
    const meta = extractRequestMeta(req);
    await auditLog({
      action: "leads.captured",
      businessId: parsed.business_id,
      ...meta,
      details: {
        lead_id: lead.id,
        conversation_id: parsed.conversation_id,
        source: "ai_callback",
        urgency: parsed.urgency,
        preferred_channel: parsed.preferred_channel,
      },
    });

    // Slice 3A pillar 2: fire the lead_captured SMS. Fire-and-forget —
    // an SMS failure must not break lead capture. Token is signed for
    // this lead so the URL is unique-per-customer; SLA window is
    // computed via lib/lead-sla.ts respecting any per-tenant override.
    // Locale defaults to 'en' (Slice 3A has no per-lead locale field;
    // a future slice can resolve from caller language or business
    // languages array).
    const urgency = normalizeUrgency(parsed.urgency);
    const trustToken = (() => {
      try {
        return signTrustToken(lead.id, parsed.business_id);
      } catch (signErr: any) {
        Sentry.captureMessage("leads_capture_trust_token_sign_failed", {
          level: "warning",
          extra: { leadId: lead.id, error: signErr?.message },
        });
        return null;
      }
    })();
    if (trustToken) {
      void sendLeadSms({
        supabase,
        businessId: parsed.business_id,
        leadId: lead.id,
        to: parsed.contact_phone,
        template: "lead_captured",
        context: {
          contact_name: parsed.contact_name,
          business_name: bizRow.business_name || "the team",
          brief_reason: briefReason(parsed.reason),
          sla_window: slaLabel(urgency, "en", bizRow.sla_overrides),
          portal_url: portalUrlFromToken(trustToken),
        },
        locale: "en",
      }).catch((smsErr: any) => {
        // sendLeadSms swallows its own errors; this catch covers the
        // truly unexpected (e.g. supabase pool blown up). Sentry only.
        Sentry.captureException(smsErr, {
          extra: { route: "/api/leads/capture sms", leadId: lead.id },
        });
      });
    }

    res.json({ success: true, lead_id: lead.id });
  } catch (err: any) {
    Sentry.captureException(err, {
      extra: { route: "/api/leads/capture", businessId: parsed.business_id, conversationId: parsed.conversation_id },
    });
    res.status(500).json({ error: "An unexpected error occurred" });
  }
});

// ── Customer + admin read endpoints share these helpers ───────────────

type LeadRow = {
  id: string;
  business_id: string;
  source: string;
  source_call_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  preferred_channel: string | null;
  reason: string;
  urgency: string;
  status: string;
  assigned_to: string | null;
  claimed_at: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  dismissed_reason: string | null;
  created_at: string;
  updated_at: string;
};

type LeadActivityRow = {
  id: string;
  lead_id: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  metadata: any;
  note: string | null;
  created_at: string;
};

const LEAD_SELECT_COLUMNS =
  "id, business_id, source, source_call_id, contact_name, contact_phone, contact_email, preferred_channel, reason, urgency, status, assigned_to, claimed_at, first_response_at, resolved_at, resolution_note, dismissed_reason, created_at, updated_at";

async function loadLeadList(opts: {
  supabase: SupabaseClient;
  businessId: string;
  status: string | null;
  assignedToMe: boolean;
  callerUserId: string | null;
  limit: number;
  offset: number;
}): Promise<{ rows: LeadRow[]; total: number } | { error: string }> {
  const q = opts.supabase
    .from("leads")
    .select(LEAD_SELECT_COLUMNS, { count: "exact" })
    .eq("business_id", opts.businessId)
    .order("created_at", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);
  if (opts.status) q.eq("status", opts.status);
  if (opts.assignedToMe && opts.callerUserId) q.eq("assigned_to", opts.callerUserId);

  const { data, error, count } = await q;
  if (error) {
    console.error("[leads:list] error:", error.message);
    return { error: error.message };
  }
  return { rows: (data as LeadRow[]) || [], total: count ?? 0 };
}

async function loadLeadWithActivities(
  supabase: SupabaseClient,
  businessId: string,
  leadId: string,
): Promise<{ lead: LeadRow; activities: LeadActivityRow[] } | null> {
  const { data: leadData, error: leadErr } = await supabase
    .from("leads")
    .select(LEAD_SELECT_COLUMNS)
    .eq("id", leadId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (leadErr || !leadData) return null;
  const { data: activities } = await supabase
    .from("lead_activities")
    .select("id, lead_id, actor_id, actor_type, action, metadata, note, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: true });
  return {
    lead: leadData as LeadRow,
    activities: (activities as LeadActivityRow[]) || [],
  };
}

function parseListQuery(req: Request, callerUserId: string | null): {
  status: string | null;
  assignedToMe: boolean;
  callerUserId: string | null;
  limit: number;
  offset: number;
} {
  const rawStatus = typeof req.query.status === "string" ? req.query.status : null;
  const validStatuses = ["new", "claimed", "in_progress", "resolved", "dismissed"];
  const status = rawStatus && validStatuses.includes(rawStatus) ? rawStatus : null;
  const assignedToMe = req.query.assigned_to_me === "true" || req.query.assigned_to_me === "1";
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, parseInt(typeof req.query.limit === "string" ? req.query.limit : "", 10) || DEFAULT_LIST_LIMIT),
  );
  const offset = Math.max(0, parseInt(typeof req.query.offset === "string" ? req.query.offset : "", 10) || 0);
  return { status, assignedToMe, callerUserId, limit, offset };
}

// ── GET /api/business/leads ────────────────────────────────────────────

router.get(
  "/business/leads",
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
    const opts = parseListQuery(req, req.userId ?? null);
    const result = await loadLeadList({
      supabase,
      businessId,
      ...opts,
    });
    if ("error" in result) {
      res.status(500).json({ error: "Failed to load leads" });
      return;
    }
    res.json({
      leads: result.rows,
      total: result.total,
      limit: opts.limit,
      offset: opts.offset,
    });
  },
);

// ── GET /api/business/leads/:id ────────────────────────────────────────

router.get(
  "/business/leads/:id",
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
    const leadId = String(req.params.id);
    const result = await loadLeadWithActivities(supabase, businessId, leadId);
    if (!result) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(result);
  },
);

// ── GET /api/admin/business/:businessId/leads ──────────────────────────

router.get(
  "/admin/business/:businessId/leads",
  requireAuth,
  requireStaffPermission("leads", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    const opts = parseListQuery(req, req.userId ?? null);
    const result = await loadLeadList({
      supabase,
      businessId,
      ...opts,
    });
    if ("error" in result) {
      res.status(500).json({ error: "Failed to load leads" });
      return;
    }
    res.json({
      leads: result.rows,
      total: result.total,
      limit: opts.limit,
      offset: opts.offset,
    });
  },
);

// ── GET /api/admin/business/:businessId/leads/:id ──────────────────────

router.get(
  "/admin/business/:businessId/leads/:id",
  requireAuth,
  requireStaffPermission("leads", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    const leadId = String(req.params.id);
    const result = await loadLeadWithActivities(supabase, businessId, leadId);
    if (!result) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    res.json(result);
  },
);

export default router;
