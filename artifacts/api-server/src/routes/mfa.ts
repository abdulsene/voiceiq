import { Router, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../middlewares/auth";
import { auditLog, extractRequestMeta } from "../middlewares/audit";

const router = Router();

const mfaAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MFA_MAX_ATTEMPTS = 5;
const MFA_LOCKOUT_MS = 15 * 60 * 1000;

function checkMfaRateLimit(userId: string): { allowed: boolean; remaining: number; lockedMinutes?: number } {
  const now = Date.now();
  const entry = mfaAttempts.get(userId);
  if (entry && entry.lockedUntil > now) {
    return { allowed: false, remaining: 0, lockedMinutes: Math.ceil((entry.lockedUntil - now) / 60000) };
  }
  if (entry && entry.lockedUntil <= now) {
    mfaAttempts.delete(userId);
  }
  const current = mfaAttempts.get(userId);
  return { allowed: true, remaining: MFA_MAX_ATTEMPTS - (current?.count || 0) };
}

function recordMfaFailure(userId: string): { locked: boolean; remaining: number } {
  const entry = mfaAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  entry.count++;
  if (entry.count >= MFA_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + MFA_LOCKOUT_MS;
    mfaAttempts.set(userId, entry);
    return { locked: true, remaining: 0 };
  }
  mfaAttempts.set(userId, entry);
  return { locked: false, remaining: MFA_MAX_ATTEMPTS - entry.count };
}

function clearMfaAttempts(userId: string) {
  mfaAttempts.delete(userId);
}

function getSupabaseForUser(accessToken: string) {
  const url = process.env.SUPABASE_URL!;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY!;
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false },
  });
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function extractToken(req: Request): string {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

router.get("/mfa/factors", requireAuth, async (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    const totp = data?.totp || [];
    res.json({
      success: true,
      factors: totp.map((f: any) => ({
        id: f.id,
        status: f.status,
        friendly_name: f.friendly_name,
        created_at: f.created_at,
      })),
      has_verified: totp.some((f: any) => f.status === "verified"),
    });
  } catch (err: any) {
    console.error("[MFA] List factors error:", err.message);
    res.status(500).json({ error: "Failed to list MFA factors" });
  }
});

router.post("/mfa/enroll", requireAuth, async (req: Request, res: Response) => {
  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: req.body?.friendly_name || "Authenticator App",
    });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({
      success: true,
      factor_id: data.id,
      qr_code: data.totp.qr_code,
      secret: data.totp.secret,
      uri: data.totp.uri,
    });
  } catch (err: any) {
    console.error("[MFA] Enroll error:", err.message);
    res.status(500).json({ error: "Failed to enroll MFA" });
  }
});

router.post("/mfa/verify", requireAuth, async (req: Request, res: Response) => {
  const { factor_id, code } = req.body;
  if (!factor_id || !code) {
    res.status(400).json({ error: "factor_id and code are required" });
    return;
  }
  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);
    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factor_id,
    });
    if (challengeError) {
      res.status(400).json({ error: challengeError.message });
      return;
    }
    const { data, error } = await supabase.auth.mfa.verify({
      factorId: factor_id,
      challengeId: challengeData.id,
      code,
    });
    if (error) {
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId,
        action: "mfa.verify.failed",
        ...meta,
        success: false,
      });
      res.status(400).json({ error: "Invalid verification code" });
      return;
    }
    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId,
      action: "mfa.enrolled",
      ...meta,
      details: { factor_id },
    });
    res.json({ success: true, session: data?.session || null });
  } catch (err: any) {
    console.error("[MFA] Verify error:", err.message);
    res.status(500).json({ error: "Failed to verify MFA code" });
  }
});

router.post("/mfa/challenge", requireAuth, async (req: Request, res: Response) => {
  const { factor_id } = req.body;
  if (!factor_id) {
    res.status(400).json({ error: "factor_id is required" });
    return;
  }
  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);
    const { data, error } = await supabase.auth.mfa.challenge({
      factorId: factor_id,
    });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ success: true, challenge_id: data.id });
  } catch (err: any) {
    console.error("[MFA] Challenge error:", err.message);
    res.status(500).json({ error: "Failed to create MFA challenge" });
  }
});

router.post("/mfa/challenge-verify", requireAuth, async (req: Request, res: Response) => {
  const { factor_id, code } = req.body;
  if (!factor_id || !code) {
    res.status(400).json({ error: "factor_id and code are required" });
    return;
  }

  const userId = req.userId || "unknown";
  const rateCheck = checkMfaRateLimit(userId);
  if (!rateCheck.allowed) {
    res.status(429).json({
      error: `Too many failed attempts. Try again in ${rateCheck.lockedMinutes} minutes.`,
      locked: true,
      locked_minutes: rateCheck.lockedMinutes,
    });
    return;
  }

  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: factor_id,
    });
    if (challengeError) {
      res.status(400).json({ error: challengeError.message });
      return;
    }

    const { data, error } = await supabase.auth.mfa.verify({
      factorId: factor_id,
      challengeId: challengeData.id,
      code,
    });
    if (error) {
      const failResult = recordMfaFailure(userId);
      const meta = extractRequestMeta(req);
      await auditLog({
        userId: req.userId,
        action: "mfa.login.verify.failed",
        ...meta,
        success: false,
        details: { remaining: failResult.remaining, locked: failResult.locked },
      });
      if (failResult.locked) {
        res.status(429).json({
          error: "Too many failed attempts. Try again in 15 minutes.",
          locked: true,
          locked_minutes: 15,
        });
      } else {
        res.status(400).json({
          error: `Invalid verification code. ${failResult.remaining} attempts remaining.`,
          remaining: failResult.remaining,
        });
      }
      return;
    }

    clearMfaAttempts(userId);
    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId,
      action: "mfa.login.verified",
      ...meta,
    });
    res.json({ success: true, session: data?.session || null });
  } catch (err: any) {
    console.error("[MFA] Challenge-verify error:", err.message);
    res.status(500).json({ error: "Failed to verify MFA code" });
  }
});

router.post("/mfa/unenroll", requireAuth, async (req: Request, res: Response) => {
  const { factor_id } = req.body;
  if (!factor_id) {
    res.status(400).json({ error: "factor_id is required" });
    return;
  }
  try {
    const token = extractToken(req);
    const supabase = getSupabaseForUser(token);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: factor_id });
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    const meta = extractRequestMeta(req);
    await auditLog({
      userId: req.userId,
      action: "mfa.unenrolled",
      ...meta,
      details: { factor_id },
    });
    res.json({ success: true });
  } catch (err: any) {
    console.error("[MFA] Unenroll error:", err.message);
    res.status(500).json({ error: "Failed to remove MFA" });
  }
});

export default router;
