/**
 * Phase 4.4 — canonical call detail + identifier resolver.
 *
 * Two endpoints:
 *
 *   GET  /api/calls/:id              — full call row for the detail page
 *   GET  /api/calls/resolve?sid=...  — resolves either call_sid or
 *                                      twilio_call_sid to calls.id
 *
 * Both are requireAuth + business-scoped. Cross-tenant lookups return
 * 404 (never 403 — we do not leak whether an id exists in another
 * tenant). This matches the discipline the Phase 3.17 handlers use.
 *
 * Why /calls/:id keyed on calls.id (UUID): the 4.3 audit found that
 * inbound rows are keyed on call_sid, outbound on twilio_call_sid, and
 * only 9 of 44 real prod rows have both. calls.id is the ONLY column
 * present on every row and the only sane URL identifier. The resolver
 * exists precisely so downstream callers (lead-detail activities
 * carrying a call_sid, etc.) can route without knowing which SID
 * column the row was ingested via.
 */

import { Router, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as Sentry from "@sentry/node";

import { requireAuth } from "../middlewares/auth";

const router = Router();

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * The exact column set the detail page consumes. Pulled explicitly
 * so a schema shift (new column) doesn't silently leak into the API
 * without a code change to render it. Field order here MIRRORS the
 * detail page's render order for grep-ability.
 *
 * Notably ABSENT: cultural_profile, was_coached, coaching_session_id,
 * competitor_mentioned — all 0/45 populated in prod (Phase 4.3 audit).
 * Reviving one requires (a) an ingest path that writes it, and
 * (b) adding it to this SELECT. Do not add speculatively.
 */
const DETAIL_COLUMNS = [
  // Identity + timing
  "id",
  "business_id",
  "call_sid",
  "twilio_call_sid",
  "direction",
  "caller_number",
  "caller_name",
  "created_at",
  "start_time",
  "end_time",
  "duration_seconds",
  "status",
  // Outcome (Twilio-inferred vs staff-entered)
  "call_outcome",
  "disposition",
  "dispositioned_by_user_id",
  "dispositioned_at",
  // Routing / attribution (inbound-only in practice)
  "topic_slug",
  "handoff_reason",
  "transfer_status",
  "handled_by_user_id",
  "handled_at",
  "answered_via",
  "answered_by",
  "rung_user_ids",
  // Content
  "transcript",
  "summary",
  "caller_intent",
  // Analysis (Phase 4.5/4.6)
  "sentiment",
  "sentiment_score",
  "dominant_emotion",
  "emotion_journey",
  "urgency",
  "satisfaction_inferred",
  "analyzed_at",
  "analysis_skipped_reason",
  // Follow-up + linkage
  "follow_up_required",
  "lead_data",
].join(", ");

// Route-ordering note: /calls/resolve MUST be declared BEFORE
// /calls/:id, otherwise Express matches "resolve" as the :id
// parameter and returns 404. See 050 smoke T5/T7.

/**
 * GET /api/calls/resolve?sid=<value>
 *
 * Resolves an arbitrary SID to calls.id. Tries call_sid first, then
 * twilio_call_sid, both scoped by business_id. Returns { id } on hit
 * or 404 on miss (including cross-tenant miss). Used by lead-detail
 * activities where we only know a call_sid, and by any future
 * caller who has a Twilio SID and wants the internal UUID.
 */
router.get(
  "/calls/resolve",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const sid = String(req.query.sid || "").trim();
    if (!sid) {
      res.status(400).json({ error: "sid required" });
      return;
    }
    // Both SID formats are short URL-safe strings; reject anything
    // wildly off before hitting the DB.
    if (sid.length < 8 || sid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(sid)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    try {
      // Try call_sid first (inbound path — the majority of prod rows).
      // If no hit, try twilio_call_sid (outbound softphone path).
      // Two round trips is fine at this volume; a single OR query
      // could work but keeps the surface area of the query smaller.
      const callSidResp = await supabase
        .from("calls")
        .select("id")
        .eq("call_sid", sid)
        .eq("business_id", businessId)
        .maybeSingle();
      if (callSidResp.error) {
        res.status(500).json({ error: "Database error" });
        return;
      }
      if (callSidResp.data) {
        res.json({ id: (callSidResp.data as { id: string }).id });
        return;
      }
      const twilioResp = await supabase
        .from("calls")
        .select("id")
        .eq("twilio_call_sid", sid)
        .eq("business_id", businessId)
        .maybeSingle();
      if (twilioResp.error) {
        res.status(500).json({ error: "Database error" });
        return;
      }
      if (twilioResp.data) {
        res.json({ id: (twilioResp.data as { id: string }).id });
        return;
      }
      res.status(404).json({ error: "Not found" });
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: "GET /calls/resolve" } });
      res.status(500).json({ error: "Internal error" });
    }
  },
);

/**
 * GET /api/calls/:id
 *
 * Returns the full call row scoped to the caller's business. 404 on
 * unknown id AND on cross-tenant id (do not leak existence).
 */
router.get(
  "/calls/:id",
  requireAuth,
  async (req: Request, res: Response, next): Promise<void> => {
    const businessId = req.businessId;
    if (!businessId) {
      res.status(400).json({ error: "No active business" });
      return;
    }
    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    // Phase 5.5 — fall through instead of 404ing on non-UUID params.
    //
    // /calls/:id used to hard-404 anything that didn't match the UUID
    // shape. Fine when the only sibling was /calls/resolve (declared
    // above and matched first by Express), but the CATCH-ALL apiRouter
    // in routes/api.ts also declares /calls/stats and /calls/recent,
    // mounted AFTER this router in routes/index.ts. Result: every
    // request for /api/calls/stats or /api/calls/recent hit this
    // handler, failed the UUID check, and 404ed before reaching the
    // real endpoint. Surfaced as a blank dashboard for a staff user
    // whose CommandCenter fetch cascade rejected — the frontend then
    // hit a separate hook-count bug and crashed the whole tree.
    //
    // Passing `next()` lets Express continue the middleware chain to
    // the next matching handler, which is the /calls/stats or
    // /calls/recent implementation in the apiRouter mount.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      next();
      return;
    }
    const supabase = getSupabase();
    if (!supabase) {
      res.status(500).json({ error: "Database not configured" });
      return;
    }
    try {
      const { data, error } = await supabase
        .from("calls")
        .select(DETAIL_COLUMNS)
        .eq("id", id)
        .eq("business_id", businessId)
        .maybeSingle();
      if (error) {
        Sentry.captureMessage("calls_detail_query_failed", {
          level: "error",
          extra: { businessId, id, error: error.message },
        });
        res.status(500).json({ error: "Database error" });
        return;
      }
      if (!data) {
        // Uniform 404 whether the row doesn't exist OR exists in
        // another tenant. Do not distinguish (Phase 3.17 discipline).
        res.status(404).json({ error: "Call not found" });
        return;
      }
      res.json({ call: data });
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: "GET /calls/:id", id } });
      res.status(500).json({ error: "Internal error" });
    }
  },
);

export default router;
