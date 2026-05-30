import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface AuditLogEntry {
  userId?: string;
  businessId?: string;
  action: string;
  resource?: string;
  resourceId?: string;
  ipAddress?: string;
  userAgent?: string;
  success?: boolean;
  details?: Record<string, unknown>;
  // Enterprise-grade fields (optional, fall back gracefully)
  riskScore?: number;
  complianceFlags?: string[];
  sessionId?: string;
}

/**
 * Canonical shape stored for an enterprise audit event. All fields are
 * always present in the persisted row, with safe defaults applied for
 * legacy callers that don't supply enterprise metadata.
 */
export interface EnterpriseAuditLog {
  id: string;
  timestamp: string;
  userId: string;
  businessId: string;
  action: string;
  resource: string;
  resourceId?: string;
  result: "success" | "failure";
  ipAddress: string;
  userAgent: string;
  riskScore?: number;
  complianceFlags: string[];
  sessionId: string;
}

/**
 * Lightweight, deterministic risk scorer (0–100). Higher values indicate
 * more sensitive or unusual activity; consumers can threshold on this for
 * alerting without paying for an external risk engine.
 */
function computeRiskScore(entry: AuditLogEntry): number {
  let score = 0;
  if (entry.success === false) score += 40;
  const action = entry.action.toLowerCase();
  if (action.includes("delete")) score += 30;
  if (action.includes("billing") || action.includes("payment")) score += 20;
  if (action.includes("permission.denied") || action.includes("access.denied")) score += 25;
  if (action.includes("login") || action.includes("auth")) score += 10;
  if (entry.resource === "users" || entry.resource === "billing") score += 10;
  return Math.min(100, score);
}

function deriveComplianceFlags(entry: AuditLogEntry): string[] {
  const flags = new Set<string>(entry.complianceFlags || []);
  const action = entry.action.toLowerCase();
  if (entry.resource === "billing" || action.includes("payment")) flags.add("PCI");
  if (entry.resource === "calls" || action.includes("call")) flags.add("HIPAA-candidate");
  if (action.includes("export") || action.includes("download")) flags.add("DATA-EGRESS");
  if (action.includes("permission.denied") || action.includes("access.denied")) flags.add("SECURITY");
  return [...flags];
}

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

export async function auditLog(entry: AuditLogEntry): Promise<void> {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const success = entry.success ?? true;
    const riskScore = entry.riskScore ?? computeRiskScore(entry);
    const complianceFlags = deriveComplianceFlags(entry);

    const row: Record<string, unknown> = {
      user_id: entry.userId || null,
      business_id: entry.businessId || null,
      action: entry.action,
      resource: entry.resource || null,
      resource_id: entry.resourceId || null,
      ip_address: entry.ipAddress || null,
      user_agent: entry.userAgent || null,
      success,
      result: success ? "success" : "failure",
      details: entry.details || null,
      risk_score: riskScore,
      compliance_flags: complianceFlags,
      session_id: entry.sessionId || null,
    };

    const { error } = await (supabase as any).from("audit_logs").insert(row);
    if (error && (
      /column .* does not exist/i.test(error.message || "") ||
      /could not find the .* column/i.test(error.message || "") ||
      (error as any).code === "PGRST204"
    )) {
      console.warn("[Audit] Primary insert failed due to missing column, using fallback. Error:", error.message);
      // Fallback for older audit_logs schemas without enterprise columns
      await (supabase as any).from("audit_logs").insert({
        user_id: row.user_id,
        business_id: row.business_id,
        action: row.action,
        resource: row.resource,
        resource_id: row.resource_id,
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        success,
        details: { ...(entry.details || {}), riskScore, complianceFlags, sessionId: entry.sessionId },
      });
    }
  } catch (err: any) {
    console.error("[Audit] Both primary and fallback insert failed:", {
      message: err.message,
      code: err.code,
      action: entry.action,
      resource: entry.resource,
    });
  }
}

export function extractRequestMeta(req: any): { ipAddress: string; userAgent: string } {
  return {
    ipAddress: req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown",
    userAgent: (req.headers["user-agent"] || "unknown").substring(0, 500),
  };
}
