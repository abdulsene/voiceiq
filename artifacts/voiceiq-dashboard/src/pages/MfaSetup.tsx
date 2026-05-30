import { useState, useEffect } from "react";
import { Shield, Copy, CheckCircle, ArrowRight } from "lucide-react";

const API = "/api";

function getToken() {
  return localStorage.getItem("neverr_token") || "";
}

export default function MfaSetup() {
  const [step, setStep] = useState<"loading" | "enroll" | "verify" | "done">("loading");
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [factorId, setFactorId] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    enrollMfa();
  }, []);

  async function enrollMfa() {
    try {
      const res = await fetch(`${API}/mfa/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to start MFA setup");
        setStep("enroll");
        return;
      }
      setQrCode(data.qr_code);
      setSecret(data.secret);
      setFactorId(data.factor_id);
      setStep("enroll");
    } catch {
      setError("Connection error. Please try again.");
      setStep("enroll");
    }
  }

  async function verifyCode() {
    if (code.length !== 6) {
      setError("Please enter a 6-digit code");
      return;
    }
    setError("");
    setVerifying(true);
    try {
      const res = await fetch(`${API}/mfa/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ factor_id: factorId, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Invalid code. Please try again.");
        setVerifying(false);
        return;
      }
      if (data.session?.access_token) {
        localStorage.setItem("neverr_token", data.session.access_token);
        if (data.session.refresh_token) {
          localStorage.setItem("neverr_refresh", data.session.refresh_token);
        }
      }
      setStep("done");
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  function copySecret() {
    navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function skip() {
    window.location.href = "/dashboard";
  }

  if (step === "done") {
    return (
      <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ width: "100%", maxWidth: "440px", textAlign: "center" }}>
          <div style={{ width: "64px", height: "64px", background: "#dcfce7", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
            <CheckCircle style={{ width: "32px", height: "32px", color: "#16a34a" }} />
          </div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, color: "#0f172a", marginBottom: "8px" }}>Two-factor authentication enabled</h1>
          <p style={{ fontSize: "14px", color: "#64748b", marginBottom: "32px" }}>Your account is now protected with an extra layer of security.</p>
          <button
            onClick={() => (window.location.href = "/dashboard")}
            style={{ padding: "12px 32px", background: "#2E75B6", color: "white", border: "none", borderRadius: "10px", fontSize: "15px", fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "8px" }}
          >
            Go to Dashboard <ArrowRight style={{ width: "16px", height: "16px" }} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: "100%", maxWidth: "480px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <img src="/neverr-logo.png" alt="Neverr" style={{ height: "40px" }} />
        </div>

        <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: "14px", padding: "36px", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
          <div style={{ textAlign: "center", marginBottom: "28px" }}>
            <div style={{ width: "48px", height: "48px", background: "#eff6ff", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Shield style={{ width: "24px", height: "24px", color: "#2E75B6" }} />
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Secure your account</h1>
            <p style={{ fontSize: "14px", color: "#64748b", margin: 0, lineHeight: "1.5" }}>
              Add two-factor authentication for extra security.
              <br />
              <span style={{ fontSize: "13px" }}>Required for government and enterprise accounts.</span>
            </p>
          </div>

          {error && (
            <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#dc2626", padding: "11px 14px", borderRadius: "8px", fontSize: "13px", marginBottom: "18px" }}>
              {error}
            </div>
          )}

          {step === "loading" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ width: "32px", height: "32px", border: "3px solid #e2e8f0", borderTopColor: "#2E75B6", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto" }} />
              <p style={{ color: "#64748b", fontSize: "14px", marginTop: "12px" }}>Setting up authenticator...</p>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          )}

          {step === "enroll" && qrCode && (
            <>
              <div style={{ marginBottom: "24px" }}>
                <p style={{ fontSize: "13px", fontWeight: 500, color: "#374151", marginBottom: "12px" }}>
                  1. Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.)
                </p>
                <div style={{ display: "flex", justifyContent: "center", padding: "16px", background: "#fafafa", borderRadius: "12px", border: "1px solid #e5e7eb" }}>
                  <img src={qrCode} alt="QR Code" style={{ width: "200px", height: "200px" }} />
                </div>
              </div>

              <div style={{ marginBottom: "24px" }}>
                <p style={{ fontSize: "13px", fontWeight: 500, color: "#374151", marginBottom: "8px" }}>
                  Or enter this secret key manually:
                </p>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <code style={{ flex: 1, padding: "10px 12px", background: "#f1f5f9", borderRadius: "8px", fontSize: "12px", fontFamily: "monospace", color: "#334155", wordBreak: "break-all", border: "1px solid #e2e8f0" }}>
                    {secret}
                  </code>
                  <button onClick={copySecret} style={{ padding: "10px", background: "white", border: "1px solid #e2e8f0", borderRadius: "8px", cursor: "pointer", display: "flex", alignItems: "center" }}>
                    {copied ? <CheckCircle style={{ width: "16px", height: "16px", color: "#16a34a" }} /> : <Copy style={{ width: "16px", height: "16px", color: "#64748b" }} />}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: "20px" }}>
                <p style={{ fontSize: "13px", fontWeight: 500, color: "#374151", marginBottom: "8px" }}>
                  2. Enter the 6-digit code from your app
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && verifyCode()}
                  placeholder="000000"
                  style={{
                    width: "100%", padding: "14px", fontSize: "24px", fontFamily: "monospace",
                    textAlign: "center", letterSpacing: "12px", border: "1px solid #e2e8f0",
                    borderRadius: "10px", outline: "none", boxSizing: "border-box",
                  }}
                />
              </div>

              <button
                onClick={verifyCode}
                disabled={verifying || code.length !== 6}
                style={{
                  width: "100%", padding: "12px", background: verifying || code.length !== 6 ? "#94a3b8" : "#2E75B6",
                  color: "white", border: "none", borderRadius: "10px", fontSize: "15px",
                  fontWeight: 600, cursor: verifying || code.length !== 6 ? "not-allowed" : "pointer",
                }}
              >
                {verifying ? "Verifying..." : "Verify and Enable 2FA"}
              </button>

              <div style={{ textAlign: "center", marginTop: "16px" }}>
                <button
                  onClick={skip}
                  style={{ background: "none", border: "none", color: "#64748b", fontSize: "13px", cursor: "pointer", textDecoration: "underline" }}
                >
                  Skip for now
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
