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

// Phase 6.0 — qualification-related types shared with the topics
// module. Not imported from routes/topics.ts to avoid a route→route
// dependency; the enums are tiny and the source of truth for the
// disqualifier catalogue itself is business_configs.departments JSONB.
const VALID_QUALIFICATION_STATUS = [
  "qualified",
  "unqualified_temporary",
  "unqualified_permanent",
] as const;
type QualificationStatus = (typeof VALID_QUALIFICATION_STATUS)[number];
const DISQUALIFIER_ID_MAX = 100;
const DISQUALIFIER_ID_RE = /^[a-z][a-z0-9_]*$/;

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
  // Phase 6.0 — optional. Present when Alex captured this callback
  // because the caller failed a qualification requirement. The server
  // resolves kind (permanent/temporary) by looking the id up in
  // business_configs.departments; that lookup drives
  // qualification_status on the inserted lead.
  disqualifier_id?: string;
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

  // Phase 6.0 — disqualifier_id is optional. Format-check here; the
  // handler resolves it against business_configs.departments to derive
  // kind. We do NOT reject unknown ids at the boundary — an id present
  // in the payload but missing in the config gets captured as
  // qualification_status='unqualified_temporary' with a warning
  // breadcrumb (safer than 400ing a live call because ops just deleted
  // a disqualifier row seconds before Alex tried to use it).
  const disqualifierRaw = body.disqualifier_id;
  let disqualifierId: string | undefined;
  if (disqualifierRaw != null && disqualifierRaw !== "") {
    if (typeof disqualifierRaw !== "string") {
      return { error: "disqualifier_id must be a string" };
    }
    const trimmed = disqualifierRaw.trim();
    if (trimmed.length > DISQUALIFIER_ID_MAX) {
      return { error: `disqualifier_id exceeds ${DISQUALIFIER_ID_MAX} characters` };
    }
    if (!DISQUALIFIER_ID_RE.test(trimmed)) {
      return { error: "disqualifier_id must be snake_case" };
    }
    disqualifierId = trimmed;
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
    disqualifier_id: disqualifierId,
  };
}

// Phase 6.0 — resolve a disqualifier_id to its qualification_status
// by scanning the business's departments JSONB. Unknown ids (deleted
// or misspelled) fall back to 'unqualified_temporary' — safer default
// than 'permanent' because a temporary bucket at least keeps the lead
// in the tenant's workable pile if it turns out to be a real caller.
function resolveQualificationStatus(
  disqualifierId: string,
  departments: unknown,
): { status: QualificationStatus; found: boolean } {
  if (!Array.isArray(departments)) {
    return { status: "unqualified_temporary", found: false };
  }
  for (const topic of departments as any[]) {
    if (!topic || typeof topic !== "object") continue;
    const q = topic.qualification;
    if (!q || typeof q !== "object") continue;
    const list = Array.isArray(q.disqualifiers) ? q.disqualifiers : [];
    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      if (d.id !== disqualifierId) continue;
      if (d.kind === "permanent") return { status: "unqualified_permanent", found: true };
      if (d.kind === "temporary") return { status: "unqualified_temporary", found: true };
      // Kind missing / malformed — treat as temporary so a lookup miss
      // doesn't accidentally hide a caller in the permanent bucket.
      return { status: "unqualified_temporary", found: true };
    }
  }
  return { status: "unqualified_temporary", found: false };
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
      .select("business_id, business_name, sla_overrides, departments")
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
      departments: unknown;
    };

    // Phase 6.0 — resolve qualification status from the disqualifier_id
    // Alex passed. Absent id → NULL columns (treated as 'qualified'
    // downstream for backwards compat with pre-6.0 rows). Unknown id →
    // still stored, with a Sentry breadcrumb so ops can spot drift
    // between the tool schema and the live topics config.
    let qualificationStatus: QualificationStatus | null = null;
    let disqualifierIdForInsert: string | null = null;
    if (parsed.disqualifier_id) {
      const resolved = resolveQualificationStatus(parsed.disqualifier_id, bizRow.departments);
      qualificationStatus = resolved.status;
      disqualifierIdForInsert = parsed.disqualifier_id;
      if (!resolved.found) {
        Sentry.captureMessage("leads_capture_unknown_disqualifier_id", {
          level: "warning",
          extra: {
            businessId: parsed.business_id,
            disqualifierId: parsed.disqualifier_id,
            conversationId: parsed.conversation_id,
          },
        });
      }
    }

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
        qualification_status: qualificationStatus,
        disqualifier_id: disqualifierIdForInsert,
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
          ...(disqualifierIdForInsert
            ? {
                disqualifier_id: disqualifierIdForInsert,
                qualification_status: qualificationStatus,
              }
            : {}),
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
    // Phase 6.0 — do NOT send the "someone will follow up" SMS for
    // permanently-unqualified callers. The team will not be following
    // up; sending the trust-portal link would be a lie. Temporary
    // unqualifieds still get the SMS — the tenant may work them.
    const shouldSendSms = qualificationStatus !== "unqualified_permanent";
    if (trustToken && shouldSendSms) {
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
  // Phase 6.0 — nullable pair. NULL = pre-6.0 or non-qualification
  // capture; the dashboard treats NULL as 'qualified' for filter
  // purposes (see parseListQuery below).
  qualification_status: string | null;
  disqualifier_id: string | null;
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
  "id, business_id, source, source_call_id, contact_name, contact_phone, contact_email, preferred_channel, reason, urgency, status, assigned_to, claimed_at, first_response_at, resolved_at, resolution_note, dismissed_reason, created_at, updated_at, qualification_status, disqualifier_id";

async function loadLeadList(opts: {
  supabase: SupabaseClient;
  businessId: string;
  status: string | null;
  assignedToMe: boolean;
  callerUserId: string | null;
  limit: number;
  offset: number;
  // Phase 6.0 — 'qualified' | 'unqualified_temporary' |
  // 'unqualified_permanent' | null. When null, the default filter
  // excludes both unqualified buckets so they don't pollute My Open /
  // Unassigned / All. When set, filters to exactly that bucket
  // (NULL matches 'qualified' by convention).
  qualificationStatus: QualificationStatus | null;
}): Promise<{ rows: LeadRow[]; total: number } | { error: string }> {
  const q = opts.supabase
    .from("leads")
    .select(LEAD_SELECT_COLUMNS, { count: "exact" })
    .eq("business_id", opts.businessId)
    .order("created_at", { ascending: false })
    .range(opts.offset, opts.offset + opts.limit - 1);
  if (opts.status) q.eq("status", opts.status);
  if (opts.assignedToMe && opts.callerUserId) q.eq("assigned_to", opts.callerUserId);

  // Phase 6.0 — qualification filter. Default (unspecified) EXCLUDES
  // both unqualified buckets so the tenant's workable pipeline stays
  // clean. Explicit values narrow to that bucket; 'qualified' is the
  // union of NULL and the literal 'qualified' string (pre-6.0 rows
  // carried NULL and are treated as qualified by convention).
  if (opts.qualificationStatus === null) {
    q.or("qualification_status.is.null,qualification_status.eq.qualified");
  } else if (opts.qualificationStatus === "qualified") {
    q.or("qualification_status.is.null,qualification_status.eq.qualified");
  } else {
    q.eq("qualification_status", opts.qualificationStatus);
  }

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
  qualificationStatus: QualificationStatus | null;
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
  const rawQualStatus = typeof req.query.qualification_status === "string" ? req.query.qualification_status : null;
  const qualificationStatus = rawQualStatus && (VALID_QUALIFICATION_STATUS as readonly string[]).includes(rawQualStatus)
    ? (rawQualStatus as QualificationStatus)
    : null;
  return { status, assignedToMe, callerUserId, limit, offset, qualificationStatus };
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

// ── POST /api/leads/record-appointment (Phase 2.2.5) ──────────────────
//
// The AI receptionist's record_appointment webhook tool POSTs here when
// the caller books an appointment. Verifies Bearer secret (same as
// /api/leads/capture). Resolves the caller's lead via:
//   1. conversation_id → calls.call_sid → calls.id → leads.source_call_id
//   2. contact_phone fallback → leads.contact_phone WHERE business_id=$1
//   3. stub lead creation (source='ai_appointment_booking') if both miss
// then INSERTs the appointment with status='confirmed',
// source='ai_receptionist', lead_id set. lead_activities row is
// best-effort.
//
// Gated by business_configs.record_appointment_enabled at the agent-
// registration layer (updateAgentTools only registers the tool when the
// flag is TRUE), but we ALSO check here as a belt-and-suspenders for the
// case where the flag was flipped FALSE after the agent was last sync'd.

type RecordAppointmentPayload = {
  business_id: string;
  conversation_id: string;
  appointment_datetime: string;  // ISO 8601 with TZ
  reason: string;
  duration_minutes?: number;
  notes?: string;
  contact_phone?: string;
};

const NOTES_MAX = 2000;
const APPT_REASON_MAX = 500;
const DURATION_MAX = 24 * 60;  // 24 hours upper bound

// Exported for the 031 smoke — direct unit-tests of validation.
export function parseRecordAppointmentPayload(body: any): RecordAppointmentPayload | { error: string } {
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

  // R1 — appointment_datetime is required (production column is nullable
  // but Phase 2 semantics require it). Reject at the route boundary.
  const apptRaw = body.appointment_datetime;
  if (typeof apptRaw !== "string" || !apptRaw.trim()) {
    return { error: "appointment_datetime is required" };
  }
  const apptDate = new Date(apptRaw);
  if (isNaN(apptDate.getTime())) {
    return { error: "appointment_datetime must be a valid ISO 8601 timestamp" };
  }
  if (apptDate.getTime() <= Date.now()) {
    return { error: "appointment_datetime must be in the future" };
  }

  const reason = requireStr("reason", APPT_REASON_MAX);
  if (typeof reason !== "string") return reason;

  const notes = optionalStr("notes", NOTES_MAX);
  if (typeof notes === "object") return notes;

  let durationMinutes: number | undefined;
  if (body.duration_minutes != null) {
    const n = typeof body.duration_minutes === "number"
      ? body.duration_minutes
      : parseInt(String(body.duration_minutes), 10);
    if (!Number.isFinite(n) || n <= 0 || n > DURATION_MAX) {
      return { error: `duration_minutes must be a positive number, max ${DURATION_MAX}` };
    }
    durationMinutes = Math.round(n);
  }

  const contactPhone = optionalStr("contact_phone", PHONE_MAX);
  if (typeof contactPhone === "object") return contactPhone;
  if (contactPhone && !E164_RE.test(contactPhone)) {
    return { error: "contact_phone must be E.164 format if provided (e.g. +14105551234)" };
  }

  return {
    business_id: businessId,
    conversation_id: conversationId,
    appointment_datetime: apptDate.toISOString(),
    reason,
    duration_minutes: durationMinutes,
    notes,
    contact_phone: contactPhone,
  };
}

interface RecordAppointmentSuccess {
  ok: true;
  appointmentId: number;
  scheduledAt: string;
  leadId: string | null;
}
interface RecordAppointmentFailure {
  ok: false;
  status: number;
  error: string;
}
type RecordAppointmentResult = RecordAppointmentSuccess | RecordAppointmentFailure;

// Exported for the 031 smoke — direct handler invocation with mock
// req/res + FakeSupabaseClient (mirrors handleScheduleCall in routes/
// lead-calls.ts).
export async function handleRecordAppointment(
  supabase: SupabaseClient,
  payload: RecordAppointmentPayload,
): Promise<RecordAppointmentResult> {
  // Confirm business + per-tenant flag.
  const { data: biz, error: bizErr } = await supabase
    .from("business_configs")
    .select("business_id, record_appointment_enabled")
    .eq("business_id", payload.business_id)
    .maybeSingle();
  if (bizErr) {
    Sentry.captureMessage("record_appointment_business_lookup_failed", {
      level: "error",
      extra: { businessId: payload.business_id, error: bizErr.message },
    });
    return { ok: false, status: 500, error: "Database error" };
  }
  const bizRow = biz as { business_id: string; record_appointment_enabled: boolean | null } | null;
  if (!bizRow) {
    return { ok: false, status: 404, error: "Business not found" };
  }
  if (bizRow.record_appointment_enabled !== true) {
    // Belt-and-suspenders: the agent should not have the tool registered
    // when the flag is FALSE, but a stale agent config could still call
    // through. Refuse and surface a message the LLM can apologize for.
    return {
      ok: false,
      status: 400,
      error: "Appointment recording is not enabled for this business",
    };
  }

  // (1) Lead resolution chain — conversation_id → calls → leads.source_call_id.
  let leadId: string | null = null;
  let leadContactName: string | null = null;
  let leadContactPhone: string | null = null;
  try {
    const { data: callRow } = await supabase
      .from("calls")
      .select("id")
      .eq("call_sid", payload.conversation_id)
      .maybeSingle();
    const sourceCallId = (callRow as { id?: string } | null)?.id ?? null;
    if (sourceCallId) {
      const { data: leadByCall } = await supabase
        .from("leads")
        .select("id, contact_name, contact_phone")
        .eq("source_call_id", sourceCallId)
        .eq("business_id", payload.business_id)
        .maybeSingle();
      const row = leadByCall as { id: string; contact_name: string | null; contact_phone: string | null } | null;
      if (row) {
        leadId = row.id;
        leadContactName = row.contact_name;
        leadContactPhone = row.contact_phone;
      }
    }
  } catch {
    /* best-effort; fall through */
  }

  // (2) contact_phone fallback if (1) missed.
  if (!leadId && payload.contact_phone) {
    try {
      const { data: leadByPhone } = await supabase
        .from("leads")
        .select("id, contact_name, contact_phone")
        .eq("business_id", payload.business_id)
        .eq("contact_phone", payload.contact_phone)
        .maybeSingle();
      const row = leadByPhone as { id: string; contact_name: string | null; contact_phone: string | null } | null;
      if (row) {
        leadId = row.id;
        leadContactName = row.contact_name;
        leadContactPhone = row.contact_phone;
      }
    } catch {
      /* best-effort; fall through */
    }
  }

  // (3) Stub-lead creation if both (1) and (2) missed.
  // Per R-Call2 — source='ai_appointment_booking' (distinct from
  // 'ai_receptionist' which is the APPOINTMENT's source). Best-effort:
  // if the stub INSERT fails, the appointment still lands with lead_id
  // NULL (verified by smoke T12).
  if (!leadId) {
    try {
      const { data: newLead, error: stubErr } = await supabase
        .from("leads")
        .insert({
          business_id: payload.business_id,
          source: "ai_appointment_booking",
          contact_name: null,
          contact_phone: payload.contact_phone ?? null,
          reason: payload.reason,
          urgency: "medium",
          preferred_channel: "call",
          status: "new",
        })
        .select("id, contact_name, contact_phone")
        .single();
      if (!stubErr && newLead) {
        const row = newLead as { id: string; contact_name: string | null; contact_phone: string | null };
        leadId = row.id;
        leadContactName = row.contact_name;
        leadContactPhone = row.contact_phone;
      } else if (stubErr) {
        Sentry.captureMessage("record_appointment_stub_lead_failed", {
          level: "warning",
          extra: { businessId: payload.business_id, error: stubErr.message },
        });
      }
    } catch (err: any) {
      Sentry.captureMessage("record_appointment_stub_lead_threw", {
        level: "warning",
        extra: { businessId: payload.business_id, error: err?.message },
      });
    }
  }

  // (4) INSERT appointment. status='confirmed' per R-Call3.
  let appointmentId: number;
  try {
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .insert({
        business_id: payload.business_id,
        lead_id: leadId,
        appointment_datetime: payload.appointment_datetime,
        duration_minutes: payload.duration_minutes ?? 30,
        status: "confirmed",
        source: "ai_receptionist",
        reason: payload.reason,
        notes: payload.notes ?? null,
        caller_name: leadContactName,
        caller_phone: leadContactPhone ?? payload.contact_phone ?? null,
      })
      .select("id, appointment_datetime")
      .single();
    if (apptErr || !appt) {
      Sentry.captureMessage("record_appointment_insert_failed", {
        level: "error",
        extra: { businessId: payload.business_id, leadId, error: apptErr?.message },
      });
      return {
        ok: false,
        status: 500,
        error: "Could not save the appointment right now.",
      };
    }
    appointmentId = (appt as { id: number }).id;
  } catch (err: any) {
    Sentry.captureMessage("record_appointment_insert_threw", {
      level: "error",
      extra: { businessId: payload.business_id, leadId, error: err?.message },
    });
    return {
      ok: false,
      status: 500,
      error: "Could not save the appointment right now.",
    };
  }

  // (5) lead_activities — best-effort per R3. Don't fail the booking on
  // audit-log failure. Skipped entirely if no lead_id (the row has no
  // home to attach to in the timeline).
  if (leadId) {
    try {
      await supabase.from("lead_activities").insert({
        lead_id: leadId,
        actor_id: null,
        actor_type: "ai_agent",
        action: "appointment_booked",
        metadata: {
          appointment_id: appointmentId,
          appointment_datetime: payload.appointment_datetime,
          reason: payload.reason,
          duration_minutes: payload.duration_minutes ?? 30,
          conversation_id: payload.conversation_id,
          source: "ai_receptionist",
        },
      });
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { route: "record-appointment.lead_activities_insert", appointmentId, leadId },
      });
    }
  }

  return {
    ok: true,
    appointmentId,
    scheduledAt: payload.appointment_datetime,
    leadId,
  };
}

router.post("/leads/record-appointment", async (req: Request, res: Response) => {
  if (!verifyToolSecret(req)) {
    res.status(401).json({ success: false, error: "Invalid or missing bearer token" });
    return;
  }
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ success: false, error: "Database not configured" });
    return;
  }

  const parsed = parseRecordAppointmentPayload(req.body);
  if ("error" in parsed) {
    res.status(400).json({ success: false, error: parsed.error });
    return;
  }

  const result = await handleRecordAppointment(supabase, parsed);
  if (!result.ok) {
    res.status(result.status).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    appointment_id: result.appointmentId,
    scheduled_at: result.scheduledAt,
    lead_id: result.leadId,
  });
});

export default router;
