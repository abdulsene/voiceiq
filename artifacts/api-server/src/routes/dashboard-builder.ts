/**
 * Custom dashboard builder API.
 *
 * Notable deviations from the rough spec:
 *   * Adds the missing CRUD: list, get, update, delete (the spec only
 *     described `create` and `getData`, which would leave dashboards
 *     unmanageable from the UI).
 *   * `req.userId` rather than the spec's `req.user.id` (matches the
 *     shape `requireAuth` actually populates in this project).
 *   * Widget data generation is scoped strictly to `req.businessId`;
 *     the dashboard row is also filtered by `business_id` so a tenant
 *     cannot read another tenant's dashboard by ID guess.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireAuth, requirePermission } from "../middlewares/auth.js";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";

const router: IRouter = Router();

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

// Match the call-outcome vocabulary used by /monitoring routes so widget
// numbers line up with the rest of the platform.
const SUCCESS_OUTCOMES = ["answered", "resolved", "appointment_booked", "completed", "booked", "success"];
function callIs(call: any, set: string[]): boolean {
  const status = String(call.status || "").toLowerCase();
  const outcome = String(call.call_outcome || "").toLowerCase();
  return set.includes(status) || set.includes(outcome);
}

interface WidgetDef {
  name: string;
  type: string;
  description: string;
  dataSource: string;
  config: Record<string, any>;
}

const WIDGET_LIBRARY: Record<string, Record<string, WidgetDef>> = {
  metrics: {
    call_volume: {
      name: "Call Volume",
      type: "metric",
      description: "Total number of calls in selected time period",
      dataSource: "calls",
      config: { aggregation: "count", timeRange: "24h" },
    },
    success_rate: {
      name: "Success Rate",
      type: "metric",
      description: "Percentage of successful calls",
      dataSource: "calls",
      config: { aggregation: "success_rate", timeRange: "24h" },
    },
  },
  charts: {
    call_volume_trend: {
      name: "Call Volume Trend",
      type: "line_chart",
      description: "Call volume over time",
      dataSource: "calls",
      config: { groupBy: "day", timeRange: "30d" },
    },
    success_by_outcome: {
      name: "Success by Outcome",
      type: "pie_chart",
      description: "Distribution of call outcomes",
      dataSource: "calls",
      config: { groupBy: "call_outcome" },
    },
  },
  tables: {
    recent_calls: {
      name: "Recent Calls",
      type: "data_table",
      description: "Latest call activity",
      dataSource: "calls",
      config: { columns: ["created_at", "status", "call_outcome", "duration_seconds"], limit: 10, orderBy: "created_at" },
    },
  },
};

// Reverse index: widget type -> { categoryName, def } so widget validation
// can do a single map lookup instead of scanning all categories.
const WIDGET_TYPE_INDEX: Record<string, { category: string; def: WidgetDef }> = {};
for (const [category, widgets] of Object.entries(WIDGET_LIBRARY)) {
  for (const [type, def] of Object.entries(widgets)) {
    WIDGET_TYPE_INDEX[type] = { category, def };
  }
}

const TIME_WINDOWS_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function makeWidgetId(): string {
  return `widget_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Widget library
// ---------------------------------------------------------------------------
router.get("/widgets/library", requireAuth, requirePermission("analytics", "read"), async (_req: Request, res: Response) => {
  res.json({
    widgets: WIDGET_LIBRARY,
    categories: Object.keys(WIDGET_LIBRARY),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// List dashboards
// ---------------------------------------------------------------------------
router.get("/dashboards", requireAuth, requirePermission("analytics", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("custom_dashboards")
      .select("id, name, description, layout, theme, is_public, is_default, created_by, created_at, updated_at")
      .eq("business_id", req.businessId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return res.json({ dashboards: data || [], count: (data || []).length });
  } catch (err: any) {
    console.error("[Dashboard] list error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
router.post("/dashboards", requireAuth, requirePermission("analytics", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId || !req.userId) return res.status(400).json({ error: "No business in scope" });

    const { name, description, widgets, layout, theme, isPublic = false } = req.body || {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (!Array.isArray(widgets)) return res.status(400).json({ error: "widgets must be an array" });

    const validatedWidgets: any[] = [];
    for (const w of widgets) {
      if (!w?.type) return res.status(400).json({ error: "Each widget requires a type" });
      const entry = WIDGET_TYPE_INDEX[w.type];
      if (!entry) return res.status(400).json({ error: `Invalid widget type: ${w.type}` });
      validatedWidgets.push({
        id: w.id || makeWidgetId(),
        type: w.type,
        config: { ...entry.def.config, ...(w.config || {}) },
        position: w.position || { x: 0, y: 0, w: 6, h: 4 },
        title: w.title || entry.def.name,
      });
    }

    const { data: dashboard, error } = await supabase
      .from("custom_dashboards")
      .insert({
        business_id: req.businessId,
        name,
        description: description || "",
        layout: layout || { columns: 12, rowHeight: 100 },
        widgets: validatedWidgets,
        theme: theme || { primaryColor: "#4f46e5", backgroundColor: "#ffffff" },
        is_public: !!isPublic,
        created_by: req.userId,
        permissions: {
          viewers: isPublic ? ["all"] : [req.userId],
          editors: [req.userId],
        },
      })
      .select()
      .single();
    if (error) throw error;

    const meta = extractRequestMeta(req);
    void auditLog({
      userId: req.userId,
      businessId: req.businessId,
      action: "dashboard.created",
      resource: "custom_dashboards",
      resourceId: dashboard.id,
      success: true,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      details: { name, widgetCount: validatedWidgets.length, isPublic },
    });

    return res.status(201).json({ success: true, dashboard });
  } catch (err: any) {
    console.error("[Dashboard] create error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------
router.get("/dashboards/:id", requireAuth, requirePermission("analytics", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("custom_dashboards")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Dashboard not found" });
    return res.json({ dashboard: data });
  } catch (err: any) {
    console.error("[Dashboard] get error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
router.put("/dashboards/:id", requireAuth, requirePermission("analytics", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const allowed: Record<string, any> = {};
    const { name, description, widgets, layout, theme, isPublic, isDefault } = req.body || {};
    if (typeof name === "string") allowed.name = name;
    if (typeof description === "string") allowed.description = description;
    if (typeof isPublic === "boolean") allowed.is_public = isPublic;
    if (typeof isDefault === "boolean") allowed.is_default = isDefault;
    if (layout && typeof layout === "object") allowed.layout = layout;
    if (theme && typeof theme === "object") allowed.theme = theme;

    if (Array.isArray(widgets)) {
      const validated: any[] = [];
      for (const w of widgets) {
        if (!w?.type) return res.status(400).json({ error: "Each widget requires a type" });
        const entry = WIDGET_TYPE_INDEX[w.type];
        if (!entry) return res.status(400).json({ error: `Invalid widget type: ${w.type}` });
        validated.push({
          id: w.id || makeWidgetId(),
          type: w.type,
          config: { ...entry.def.config, ...(w.config || {}) },
          position: w.position || { x: 0, y: 0, w: 6, h: 4 },
          title: w.title || entry.def.name,
        });
      }
      allowed.widgets = validated;
    }

    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }
    allowed.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("custom_dashboards")
      .update(allowed)
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .select()
      .single();
    if (error) {
      if ((error as any).code === "PGRST116") return res.status(404).json({ error: "Dashboard not found" });
      throw error;
    }
    return res.json({ success: true, dashboard: data });
  } catch (err: any) {
    console.error("[Dashboard] update error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
router.delete("/dashboards/:id", requireAuth, requirePermission("analytics", "write"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const { data, error } = await supabase
      .from("custom_dashboards")
      .delete()
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Dashboard not found" });
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[Dashboard] delete error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Get dashboard data (real-time widget rendering)
// ---------------------------------------------------------------------------
router.get("/dashboards/:id/data", requireAuth, requirePermission("analytics", "read"), async (req: Request, res: Response) => {
  try {
    const supabase = getSupabase();
    if (!supabase) return res.status(503).json({ error: "Database unavailable" });
    if (!req.businessId) return res.status(400).json({ error: "No business in scope" });

    const timeRange = String(req.query.timeRange || "24h");
    if (!TIME_WINDOWS_MS[timeRange]) {
      return res.status(400).json({ error: `Invalid timeRange. Must be one of: ${Object.keys(TIME_WINDOWS_MS).join(", ")}` });
    }

    const { data: dashboard, error } = await supabase
      .from("custom_dashboards")
      .select("*")
      .eq("id", req.params.id)
      .eq("business_id", req.businessId)
      .maybeSingle();
    if (error) throw error;
    if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });

    const widgetData: Record<string, any> = {};
    for (const widget of dashboard.widgets || []) {
      try {
        const data = await generateWidgetData(widget, req.businessId, timeRange, supabase);
        widgetData[widget.id] = {
          type: widget.type,
          title: widget.title,
          data,
          lastUpdated: new Date().toISOString(),
        };
      } catch (we: any) {
        console.error(`[Dashboard] widget ${widget.id} error:`, we);
        widgetData[widget.id] = {
          type: widget.type,
          title: widget.title,
          error: we.message,
          lastUpdated: new Date().toISOString(),
        };
      }
    }

    return res.json({
      dashboard: { id: dashboard.id, name: dashboard.name, layout: dashboard.layout, theme: dashboard.theme },
      widgets: widgetData,
      timeRange,
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[Dashboard] data error:", err);
    return res.status(500).json({ error: err.message });
  }
});

async function generateWidgetData(widget: any, businessId: string, timeRange: string, supabase: SupabaseClient): Promise<any> {
  const windowMs = TIME_WINDOWS_MS[timeRange] ?? TIME_WINDOWS_MS["24h"];
  const startDate = new Date(Date.now() - windowMs).toISOString();

  switch (widget.type) {
    case "call_volume": {
      const { count } = await supabase
        .from("calls")
        .select("*", { count: "exact", head: true })
        .eq("business_id", businessId)
        .gte("created_at", startDate);
      return { value: count || 0, unit: "calls" };
    }
    case "success_rate": {
      const { data: calls } = await supabase
        .from("calls")
        .select("status, call_outcome")
        .eq("business_id", businessId)
        .gte("created_at", startDate);
      const total = calls?.length || 0;
      const ok = calls?.filter((c: any) => callIs(c, SUCCESS_OUTCOMES)).length || 0;
      const rate = total > 0 ? (ok / total) * 100 : 0;
      return { value: Math.round(rate * 100) / 100, unit: "%", total, successful: ok };
    }
    case "call_volume_trend": {
      const { data: calls } = await supabase
        .from("calls")
        .select("created_at")
        .eq("business_id", businessId)
        .gte("created_at", startDate)
        .order("created_at");
      const groupBy: "hour" | "day" = timeRange === "24h" || timeRange === "1h" ? "hour" : "day";
      const points = groupCallsByTime(calls || [], groupBy);
      return { type: "line", data: points.map((p) => ({ x: p.period, y: p.count })) };
    }
    case "success_by_outcome": {
      const { data: calls } = await supabase
        .from("calls")
        .select("call_outcome")
        .eq("business_id", businessId)
        .gte("created_at", startDate);
      const counts: Record<string, number> = {};
      for (const c of calls || []) {
        const k = String((c as any).call_outcome || "unknown").toLowerCase();
        counts[k] = (counts[k] || 0) + 1;
      }
      return { type: "pie", data: Object.entries(counts).map(([label, value]) => ({ label, value })) };
    }
    case "recent_calls": {
      const limit = Math.max(1, Math.min(100, Number(widget.config?.limit) || 10));
      const { data: calls } = await supabase
        .from("calls")
        .select("created_at, status, call_outcome, duration_seconds")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .limit(limit);
      return {
        columns: ["Time", "Status", "Outcome", "Duration"],
        rows: (calls || []).map((c: any) => [
          new Date(c.created_at).toISOString(),
          c.status,
          c.call_outcome || "N/A",
          `${c.duration_seconds || 0}s`,
        ]),
      };
    }
    default:
      throw new Error(`Unsupported widget type: ${widget.type}`);
  }
}

function groupCallsByTime(calls: any[], groupBy: "hour" | "day"): Array<{ period: string; count: number }> {
  const groups: Record<string, number> = {};
  for (const c of calls) {
    const d = new Date(c.created_at);
    const key =
      groupBy === "hour"
        ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:00`
        : `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    groups[key] = (groups[key] || 0) + 1;
  }
  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, count]) => ({ period, count }));
}

export default router;
