/**
 * Operator-transfer endpoints. Customer + admin parity, same Stage 6
 * `apiBase` pattern as voices.ts and prompt.ts:
 *
 *   - GET    /api/business/transfer                          customer: read
 *   - PUT    /api/business/transfer                          customer: save
 *   - GET    /api/admin/business/:businessId/transfer        admin: read
 *   - PUT    /api/admin/business/:businessId/transfer        admin: save
 *
 * Auth:
 *   customer endpoints → requireAuth + requirePermission("settings", *)
 *   admin endpoints    → requireAuth + requireStaffPermission("customers", *)
 *
 * Save flow (both surfaces share `handleTransferSave`):
 *   1. Validate input (E.164 phone, condition required if enabled)
 *   2. Loop guard — reject if transfer_to_phone matches
 *      business_configs.twilio_phone_number on the same row
 *   3. Apply defaults for empty optional fields when enabling for the
 *      first time
 *   4. Write to business_configs
 *   5. Call updateAgentTools — GET → strip/insert tool → PATCH
 *      the ElevenLabs agent. Sentry-wrapped; never bubbles
 *   6. Audit-log the change (source='customer' vs 'admin_raw' depending
 *      on which surface called)
 *   7. Respond 200 with the saved row + sync status
 */
import {
  Router,
  type Request,
  type Response,
} from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth, requirePermission } from "../middlewares/auth";
import { requireStaffPermission } from "../middlewares/staff-rbac";
import { auditLog, extractRequestMeta } from "../middlewares/audit";
import { updateAgentTools } from "../agents";

const router = Router();

// E.164: leading +, 1-15 digits. Matches the project's existing phone
// validation pattern in middlewares/validate.ts.
const E164_RE = /^\+?[1-9]\d{1,14}$/;

// Customer-editable size caps. Large enough for thoughtful copy without
// risking ElevenLabs tool-config bloat.
const CONDITION_MAX = 1000;
const WAIT_MESSAGE_MAX = 500;
const WARM_MESSAGE_MAX = 1000;

// Defaults seeded the FIRST time a customer enables transfer with blank
// fields. Customer can edit afterward. {business_name} interpolation
// happens server-side in updateAgentTools at PATCH time.
const DEFAULT_CONDITIONS =
  "When the caller asks something the AI cannot answer, requests to speak " +
  "to a human, reports an emergency or breakdown, asks for the manager or " +
  "owner, or expresses frustration with the AI.";
const DEFAULT_WAIT_MESSAGE = "One moment while I connect you with the team.";
const DEFAULT_WARM_MESSAGE =
  "Incoming Neverr call for {business_name}. The caller's question " +
  "couldn't be fully handled by the AI receptionist — they're on the line now.";

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

type TransferRow = {
  business_id: string;
  business_name: string | null;
  twilio_phone_number: string | null;
  agent_id: string | null;
  transfer_enabled: boolean;
  transfer_to_phone: string | null;
  transfer_conditions: string | null;
  transfer_wait_message: string | null;
  transfer_warm_message: string | null;
};

async function loadTransferRow(
  supabase: SupabaseClient,
  businessId: string,
): Promise<TransferRow | null> {
  const { data, error } = await supabase
    .from("business_configs")
    .select(
      "business_id, business_name, twilio_phone_number, agent_id, transfer_enabled, transfer_to_phone, transfer_conditions, transfer_wait_message, transfer_warm_message",
    )
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) {
    console.error("[transfer] read error:", error.message);
    return null;
  }
  return (data as TransferRow) || null;
}

function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Validate + normalize the request body. Returns either a parsed config
 * or a 400 error message. When `enabled` is true, phone + condition are
 * required and have to clear the format/loop checks. When false, the
 * other fields are optional and we just store whatever the customer left
 * in the form (so toggling enable on doesn't lose their drafts).
 */
function parseSaveBody(body: any): {
  ok: true;
  enabled: boolean;
  phone: string | null;
  conditions: string | null;
  waitMessage: string | null;
  warmMessage: string | null;
} | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Request body required" };
  }
  const enabled = body.transfer_enabled === true;
  const rawPhone = typeof body.transfer_to_phone === "string" ? body.transfer_to_phone.trim() : "";
  const rawConditions = typeof body.transfer_conditions === "string" ? body.transfer_conditions : "";
  const rawWait = typeof body.transfer_wait_message === "string" ? body.transfer_wait_message : "";
  const rawWarm = typeof body.transfer_warm_message === "string" ? body.transfer_warm_message : "";

  if (rawConditions.length > CONDITION_MAX) {
    return { ok: false, status: 400, error: `transfer_conditions must be at most ${CONDITION_MAX} characters` };
  }
  if (rawWait.length > WAIT_MESSAGE_MAX) {
    return { ok: false, status: 400, error: `transfer_wait_message must be at most ${WAIT_MESSAGE_MAX} characters` };
  }
  if (rawWarm.length > WARM_MESSAGE_MAX) {
    return { ok: false, status: 400, error: `transfer_warm_message must be at most ${WARM_MESSAGE_MAX} characters` };
  }

  if (enabled) {
    if (!rawPhone) {
      return { ok: false, status: 400, error: "transfer_to_phone is required when transfer_enabled is true" };
    }
    if (!E164_RE.test(rawPhone)) {
      return {
        ok: false,
        status: 400,
        error: "transfer_to_phone must be in E.164 format (e.g. +14105551234)",
      };
    }
  }

  return {
    ok: true,
    enabled,
    phone: rawPhone || null,
    conditions: rawConditions.trim() || null,
    waitMessage: rawWait.trim() || null,
    warmMessage: rawWarm.trim() || null,
  };
}

/**
 * Shared save handler — invoked by both the customer PUT and the admin
 * PUT, distinguished only by `audit.source` and the business_id source.
 */
async function handleTransferSave(opts: {
  req: Request;
  res: Response;
  supabase: SupabaseClient;
  businessId: string;
  userId: string | undefined;
  auditSource: "customer" | "admin_raw";
}): Promise<void> {
  const { req, res, supabase, businessId, userId, auditSource } = opts;

  const parsed = parseSaveBody(req.body);
  if (!parsed.ok) {
    res.status(parsed.status).json({ error: parsed.error });
    return;
  }

  const current = await loadTransferRow(supabase, businessId);
  if (!current) {
    res.status(404).json({ error: "Business not found" });
    return;
  }

  // Loop guard — only relevant when enabling with a non-null phone.
  // Compare on digits-only so formatting differences ("(443) 331-4649"
  // vs "+14433314649") don't slip through.
  if (parsed.enabled && parsed.phone && current.twilio_phone_number) {
    if (digitsOnly(parsed.phone) === digitsOnly(current.twilio_phone_number)) {
      res.status(400).json({
        error:
          "Transfer destination cannot be the same number Twilio is forwarding to this agent — that would create a call loop.",
        twilio_phone_number: current.twilio_phone_number,
      });
      return;
    }
  }

  // First-time-enable defaults. Only seed when the customer is turning
  // transfer ON for the first time and left the optional fields blank.
  // Editing later with a blank field intentionally clears (the customer
  // can re-enter or re-toggle to reseed).
  const isFirstEnable = parsed.enabled && !current.transfer_enabled;
  const seededConditions = parsed.conditions
    || (isFirstEnable ? DEFAULT_CONDITIONS : null);
  const seededWait = parsed.waitMessage
    || (isFirstEnable ? DEFAULT_WAIT_MESSAGE : null);
  const seededWarm = parsed.warmMessage
    || (isFirstEnable ? DEFAULT_WARM_MESSAGE : null);

  // When enabling, conditions must end up non-null (either the customer
  // provided one or the seed default kicked in — but defensively check).
  if (parsed.enabled && !seededConditions) {
    res.status(400).json({ error: "transfer_conditions cannot be empty when enabling transfer" });
    return;
  }

  const update = {
    transfer_enabled: parsed.enabled,
    transfer_to_phone: parsed.phone,
    transfer_conditions: seededConditions,
    transfer_wait_message: seededWait,
    transfer_warm_message: seededWarm,
  };

  const { error: writeErr } = await supabase
    .from("business_configs")
    .update(update)
    .eq("business_id", businessId);
  if (writeErr) {
    console.error("[transfer] write error:", writeErr.message);
    Sentry.captureMessage("transfer_save_db_failed", {
      level: "error",
      extra: { businessId, error: writeErr.message },
    });
    res.status(500).json({ error: "Failed to save transfer settings" });
    return;
  }

  // Sync to ElevenLabs. Captured to Sentry on failure but we still
  // respond 200 — the DB is the source of truth, and a retry of save
  // will re-sync. Surface the sync error in the response so the
  // dashboard can show an actionable retry hint.
  const sync = await updateAgentTools(supabase, businessId);

  // Audit. customer surface uses source='customer'; admin override uses
  // 'admin_raw' to match the prompt-edit convention so audit_logs
  // filtering on the existing reports keeps working.
  const meta = extractRequestMeta(req);
  await auditLog({
    userId: userId ?? undefined,
    businessId,
    action: "transfer.config.saved",
    ...meta,
    success: true,
    details: {
      source: auditSource,
      enabled: parsed.enabled,
      // Phone is logged plain for incident review — operational, not PII.
      transfer_to_phone: parsed.phone,
      sync_ok: sync.success,
      sync_error: sync.error ?? null,
    },
  });

  // Re-read so the response includes the post-write canonical row.
  const saved = await loadTransferRow(supabase, businessId);
  res.json({
    success: true,
    business_id: businessId,
    transfer_enabled: saved?.transfer_enabled ?? parsed.enabled,
    transfer_to_phone: saved?.transfer_to_phone ?? null,
    transfer_conditions: saved?.transfer_conditions ?? null,
    transfer_wait_message: saved?.transfer_wait_message ?? null,
    transfer_warm_message: saved?.transfer_warm_message ?? null,
    twilio_phone_number: saved?.twilio_phone_number ?? null,
    sync: {
      ok: sync.success,
      error: sync.error ?? null,
    },
  });
}

// ── GET /api/business/transfer ─────────────────────────────────────────

router.get(
  "/business/transfer",
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
    const row = await loadTransferRow(supabase, businessId);
    if (!row) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    res.json({
      business_id: row.business_id,
      transfer_enabled: row.transfer_enabled,
      transfer_to_phone: row.transfer_to_phone,
      transfer_conditions: row.transfer_conditions,
      transfer_wait_message: row.transfer_wait_message,
      transfer_warm_message: row.transfer_warm_message,
      twilio_phone_number: row.twilio_phone_number,
      defaults: {
        transfer_conditions: DEFAULT_CONDITIONS,
        transfer_wait_message: DEFAULT_WAIT_MESSAGE,
        transfer_warm_message: DEFAULT_WARM_MESSAGE,
      },
    });
  },
);

// ── PUT /api/business/transfer ─────────────────────────────────────────

router.put(
  "/business/transfer",
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
    await handleTransferSave({
      req,
      res,
      supabase,
      businessId,
      userId: req.userId,
      auditSource: "customer",
    });
  },
);

// ── GET /api/admin/business/:businessId/transfer ───────────────────────

router.get(
  "/admin/business/:businessId/transfer",
  requireAuth,
  requireStaffPermission("customers", "read"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    const row = await loadTransferRow(supabase, businessId);
    if (!row) {
      res.status(404).json({ error: "Business not found" });
      return;
    }
    res.json({
      business_id: row.business_id,
      transfer_enabled: row.transfer_enabled,
      transfer_to_phone: row.transfer_to_phone,
      transfer_conditions: row.transfer_conditions,
      transfer_wait_message: row.transfer_wait_message,
      transfer_warm_message: row.transfer_warm_message,
      twilio_phone_number: row.twilio_phone_number,
      defaults: {
        transfer_conditions: DEFAULT_CONDITIONS,
        transfer_wait_message: DEFAULT_WAIT_MESSAGE,
        transfer_warm_message: DEFAULT_WARM_MESSAGE,
      },
    });
  },
);

// ── PUT /api/admin/business/:businessId/transfer ───────────────────────

router.put(
  "/admin/business/:businessId/transfer",
  requireAuth,
  requireStaffPermission("customers", "write"),
  async (req: Request, res: Response) => {
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    const businessId = String(req.params.businessId);
    await handleTransferSave({
      req,
      res,
      supabase,
      businessId,
      userId: req.userId,
      auditSource: "admin_raw",
    });
  },
);

export default router;
