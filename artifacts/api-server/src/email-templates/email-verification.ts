/**
 * Branded HTML+text email-verification template.
 *
 * Self-contained: takes plain data, returns `{ subject, html, text }`. No
 * I/O, no Resend coupling — the service layer (services/verification-email-service.ts)
 * handles delivery. Pattern mirrors email-templates/user-invitation.ts.
 *
 * Security: the recipient email is HTML-escaped before being interpolated.
 * The verifyUrl is NOT body-escaped because it's used inside an `href`
 * attribute and a plain-text URL block; the caller MUST construct it from
 * a trusted base URL + URL-encoded query parameter (the service does this
 * with encodeURIComponent on the token).
 */

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripCtl(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, " ").trim();
}

export interface VerificationTemplateData {
  /** The recipient's email — purely cosmetic, displayed in the salutation. */
  email: string;
  /** Fully-formed https URL with ?token=<token> already appended + encoded. */
  verifyUrl: string;
  /** Pre-formatted human-readable expiry string, e.g. "in 24 hours". */
  expiresIn: string;
}

export function generateVerificationEmail(
  data: VerificationTemplateData,
): { subject: string; html: string; text: string } {
  const safeEmail = esc(data.email);
  const safeUrl = data.verifyUrl;

  const subject = "Verify your Neverr email";

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
             background: #F8FAFC; margin: 0; padding: 40px 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white;
              border-radius: 16px; overflow: hidden;
              box-shadow: 0 4px 24px rgba(0,0,0,0.08);">

    <div style="background: #1B2537; padding: 32px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px; font-weight: 800;
                 letter-spacing: -0.5px;">Neverr</h1>
      <p style="color: rgba(255,255,255,0.5); margin: 8px 0 0; font-size: 14px;">
        AI Receptionist &middot; Verify your email
      </p>
    </div>

    <div style="padding: 32px;">
      <h2 style="color: #1B2537; font-size: 18px; margin: 0 0 12px;">
        Confirm your email address
      </h2>
      <p style="color: #475569; line-height: 1.6; font-size: 14px; margin: 0 0 16px;">
        Thanks for signing up for Neverr. To finish activating your account,
        please confirm that <strong>${safeEmail}</strong> is your real email
        address.
      </p>
      <p style="color: #475569; line-height: 1.6; font-size: 14px; margin: 0 0 24px;">
        We use your email for call summaries, billing alerts, and password
        reset — so it has to be one you actually own.
      </p>

      <div style="text-align: center; margin: 0 0 24px;">
        <a href="${safeUrl}"
           style="background: #2E75B6; color: white; padding: 14px 32px;
                  border-radius: 10px; text-decoration: none; font-weight: 600;
                  font-size: 15px; display: inline-block;">
          Verify my email &rarr;
        </a>
      </div>

      <p style="color: #64748B; font-size: 12px; line-height: 1.6; margin: 0 0 8px;">
        Or paste this link into your browser:
      </p>
      <p style="color: #2E75B6; font-size: 12px; line-height: 1.6; margin: 0 0 24px;
                word-break: break-all;">
        <a href="${safeUrl}" style="color: #2E75B6;">${safeUrl}</a>
      </p>

      <div style="background: #F8FAFC; border-left: 3px solid #2E75B6;
                  padding: 12px 16px; border-radius: 4px; margin: 0 0 16px;">
        <p style="color: #475569; font-size: 13px; line-height: 1.6; margin: 0;">
          This link expires ${esc(data.expiresIn)}. If it expires, you can
          request a fresh one from the verification screen inside your
          dashboard.
        </p>
      </div>

      <p style="color: #94A3B8; font-size: 12px; line-height: 1.6; margin: 0;">
        If you didn't sign up for Neverr, you can safely ignore this email.
      </p>
    </div>

    <div style="background: #F8FAFC; padding: 24px 32px; text-align: center;
                border-top: 1px solid #E2E8F0;">
      <p style="color: #94A3B8; font-size: 12px; margin: 0;">
        Neverr AI &middot; Never missed. Never closed. Never lost.
      </p>
    </div>
  </div>
</body>
</html>`;

  const tEmail = stripCtl(data.email);
  const tUrl = stripCtl(data.verifyUrl);
  const tExpires = stripCtl(data.expiresIn);

  const text = `Verify your Neverr email

Thanks for signing up for Neverr. To finish activating your account,
please confirm that ${tEmail} is your real email address.

We use your email for call summaries, billing alerts, and password reset
— so it has to be one you actually own.

Verify your email by visiting:
${tUrl}

This link expires ${tExpires}. If it expires, you can request a fresh one
from the verification screen inside your dashboard.

If you didn't sign up for Neverr, you can safely ignore this email.

---
Neverr AI - Never missed. Never closed. Never lost.
`;

  return { subject, html, text };
}
