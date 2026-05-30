import { useState, useEffect, useRef } from "react";
import { Shield, AlertCircle } from "lucide-react";
// Sprint 4 TC-59 add-on: import the shared clearSession helper so this
// "Sign in with a different account" path uses the SAME key list as
// AuthGuard / Sidebar. Previously this path only cleared 5 of the 9 keys
// in clearSession (missing neverr_active_business_id, neverr_last_activity,
// mfa_attempts, mfa_locked_until) — the worst drift among all sign-out
// paths in the dashboard.
import { clearSession } from "../App";

const API = "/api";
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function getToken() {
  return localStorage.getItem("neverr_token") || "";
}

export default function MfaVerify() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [factorId, setFactorId] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [lockRemaining, setLockRemaining] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = localStorage.getItem("mfa_factor_id");
    if (stored) {
      setFactorId(stored);
    } else {
      loadFactors();
    }
    inputRef.current?.focus();

    const lockTs = localStorage.getItem("mfa_locked_until");
    if (lockTs) {
      const ts = parseInt(lockTs, 10);
      if (Date.now() < ts) {
        setLockedUntil(ts);
      } else {
        localStorage.removeItem("mfa_locked_until");
        localStorage.removeItem("mfa_attempts");
      }
    }
    const savedAttempts = parseInt(localStorage.getItem("mfa_attempts") || "0", 10);
    setAttempts(savedAttempts);
  }, []);

  useEffect(() => {
    if (!lockedUntil) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, lockedUntil - Date.now());
      setLockRemaining(remaining);
      if (remaining <= 0) {
        setLockedUntil(null);
        setAttempts(0);
        localStorage.removeItem("mfa_locked_until");
        localStorage.removeItem("mfa_attempts");
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [lockedUntil]);

  async function loadFactors() {
    try {
      const res = await fetch(`${API}/mfa/factors`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (data.factors?.length > 0) {
        const verified = data.factors.find((f: any) => f.status === "verified");
        if (verified) {
          setFactorId(verified.id);
          localStorage.setItem("mfa_factor_id", verified.id);
        }
      }
    } catch {
      setError("Failed to load authentication factors");
    }
  }

  async function handleVerify() {
    if (lockedUntil) return;
    if (code.length !== 6) {
      setError("Please enter a 6-digit code");
      return;
    }
    if (!factorId) {
      setError("No MFA factor found. Please contact support.");
      return;
    }
    setError("");
    setVerifying(true);
    try {
      const res = await fetch(`${API}/mfa/challenge-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ factor_id: factorId, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.locked) {
          const lockTime = Date.now() + (data.locked_minutes || 15) * 60 * 1000;
          setLockedUntil(lockTime);
          localStorage.setItem("mfa_locked_until", lockTime.toString());
          setError(data.error || "Too many failed attempts. Try again later.");
        } else {
          const newAttempts = attempts + 1;
          setAttempts(newAttempts);
          localStorage.setItem("mfa_attempts", newAttempts.toString());
          setError(data.error || `Invalid code. Please try again.`);
        }
        setCode("");
        setVerifying(false);
        return;
      }

      localStorage.removeItem("mfa_attempts");
      localStorage.removeItem("mfa_locked_until");
      localStorage.removeItem("mfa_factor_id");
      localStorage.removeItem("mfa_pending");

      if (data.session?.access_token) {
        localStorage.setItem("neverr_token", data.session.access_token);
        if (data.session.refresh_token) {
          localStorage.setItem("neverr_refresh", data.session.refresh_token);
        }
      }
      window.location.href = "/dashboard";
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  const isLocked = !!lockedUntil && lockRemaining > 0;
  const lockMinutes = Math.ceil(lockRemaining / 60000);

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: "420px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <img src="/neverr-logo.png" alt="Neverr" style={{ height: "40px" }} />
        </div>

        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "36px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ textAlign: "center", marginBottom: "28px" }}>
            <div style={{ width: "48px", height: "48px", background: "#eff6ff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Shield style={{ width: "24px", height: "24px", color: "#2E75B6" }} />
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Enter verification code</h1>
            <p style={{ fontSize: "14px", color: "#64748b", margin: 0 }}>
              Open your authenticator app and enter the 6-digit code
            </p>
          </div>

          {error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "11px 14px", borderRadius: "8px", fontSize: "13px", marginBottom: "18px", display: "flex", alignItems: "center", gap: "8px" }}>
              <AlertCircle style={{ width: "16px", height: "16px", flexShrink: 0 }} />
              {error}
            </div>
          )}

          {isLocked ? (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <p style={{ fontSize: "14px", color: "#dc2626", fontWeight: 500 }}>
                Account locked for {lockMinutes} minute{lockMinutes !== 1 ? "s" : ""}
              </p>
              <p style={{ fontSize: "13px", color: "#64748b", marginTop: "8px" }}>
                Too many failed attempts. Please wait and try again.
              </p>
            </div>
          ) : (
            <>
              <div style={{ marginBottom: "20px" }}>
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && handleVerify()}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  style={{
                    width: "100%", padding: "16px", fontSize: "28px", fontFamily: "monospace",
                    textAlign: "center", letterSpacing: "14px", border: "2px solid #e2e8f0",
                    borderRadius: "12px", outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>

              <button
                onClick={handleVerify}
                disabled={verifying || code.length !== 6}
                style={{
                  width: "100%", padding: "12px", background: verifying || code.length !== 6 ? "#94a3b8" : "#2E75B6",
                  color: "white", border: "none", borderRadius: "10px", fontSize: "15px",
                  fontWeight: 600, cursor: verifying || code.length !== 6 ? "not-allowed" : "pointer",
                }}
              >
                {verifying ? "Verifying..." : "Verify"}
              </button>
            </>
          )}

          <div style={{ textAlign: "center", marginTop: "20px", paddingTop: "16px", borderTop: "1px solid #f1f5f9" }}>
            <button
              onClick={() => {
                // Sprint 4 TC-59 add-on: delegate to clearSession so we
                // wipe the SAME set of keys AuthGuard / Sidebar wipe.
                clearSession();
                window.location.href = "/signup";
              }}
              style={{ background: "none", border: "none", color: "#64748b", fontSize: "13px", cursor: "pointer" }}
            >
              Sign in with a different account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
