/**
 * Branded HTML+text invitation email template.
 *
 * Self-contained: takes plain data, returns `{ subject, html, text }`. No I/O,
 * no SendGrid coupling — the service layer handles delivery.
 *
 * Security: ALL user-controlled fields (names, emails, role labels, permission
 * resource keys/values) are HTML-escaped before being interpolated. The
 * `activationUrl` is NOT body-escaped because it's used inside an `href`
 * attribute and a plain-text URL block; callers MUST construct it from a
 * trusted base URL + URL-encoded query parameters (which the service does).
 */

const ROLE_DESCRIPTIONS: Record<string, string> = {
  super_admin: "Full system administration with all permissions",
  admin: "Team management and customer operations",
  manager: "Customer and analytics management",
  analyst: "Analytics and reporting focus",
  support: "Customer support and ticket management",
  viewer: "Read-only access to dashboards",
};

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Strip CR/LF from a user-controlled string before placing it in the text
 * email body. Prevents stray newlines from breaking layout (and shuts the
 * door on any header-injection-style abuse if a value ever leaked into a
 * header context).
 */
function stripCtl(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, " ").trim();
}

export interface InvitationTemplateData {
  inviteeName: string;
  inviterName: string;
  inviterEmail: string;
  organizationName: string;
  role: string;
  permissions: Record<string, string[] | string>;
  activationUrl: string;
  /** Pre-formatted human-readable expiry string. */
  expiresAt: string;
  /** Pre-formatted human-readable invite date. */
  inviteDate: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export function generateInvitationEmail(
  data: InvitationTemplateData,
): RenderedEmail {
  const roleLabel = data.role.replace(/_/g, " ").toUpperCase();
  const roleDesc = ROLE_DESCRIPTIONS[data.role] || `${roleLabel} access`;

  const subject = `You're invited to join ${data.organizationName} - ${roleLabel} access`;

  // Build permissions list (skip metadata keys starting with `_`).
  const permissionEntries = Object.entries(data.permissions).filter(
    ([k]) => !k.startsWith("_"),
  );

  const permissionRowsHtml = permissionEntries
    .map(([resource, actions]) => {
      const actionsStr = Array.isArray(actions) ? actions.join(", ") : String(actions);
      return `
        <li>
          <span class="permission-resource">${esc(titleCase(resource))}</span>
          <span class="permission-actions">${esc(actionsStr)}</span>
        </li>`;
    })
    .join("");

  const permissionRowsText = permissionEntries
    .map(([resource, actions]) => {
      const actionsStr = Array.isArray(actions) ? actions.join(", ") : String(actions);
      return `- ${resource}: ${actionsStr}`;
    })
    .join("\n");

  // Derive a "support" URL by stripping the /activate path from the activation URL.
  const supportUrl = (() => {
    try {
      const u = new URL(data.activationUrl);
      return `${u.origin}/support`;
    } catch {
      return "#";
    }
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Invitation - ${esc(data.organizationName)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6; color: #374151; margin: 0; padding: 0; background-color: #f9fafb;
    }
    .container {
      max-width: 600px; margin: 20px auto; background: #ffffff;
      border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; padding: 40px 30px; text-align: center;
    }
    .header h1 { margin: 0; font-size: 28px; font-weight: 700; }
    .header p { margin: 10px 0 0; opacity: 0.9; font-size: 16px; }

    .content { padding: 40px 30px; }
    .greeting { font-size: 18px; margin-bottom: 25px; }

    .invitation-card {
      background: linear-gradient(145deg, #f8fafc, #e2e8f0);
      border: 1px solid #e5e7eb; border-radius: 12px; padding: 25px;
      margin: 25px 0; position: relative; overflow: hidden;
    }
    .invitation-card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, #10b981, #3b82f6, #8b5cf6);
    }

    .role-section { display: flex; align-items: center; gap: 15px; margin-bottom: 20px; flex-wrap: wrap; }
    .role-badge {
      background: linear-gradient(135deg, #ede9fe, #ddd6fe);
      color: #7c3aed; padding: 8px 16px; border-radius: 25px;
      font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
    }

    .permissions-box {
      background: white; border-left: 4px solid #10b981; border-radius: 8px;
      padding: 20px; margin: 20px 0;
    }
    .permissions-list { margin: 15px 0; padding: 0; list-style: none; }
    .permissions-list li {
      display: flex; justify-content: space-between; padding: 8px 0;
      border-bottom: 1px solid #f3f4f6;
    }
    .permissions-list li:last-child { border-bottom: none; }
    .permission-resource { font-weight: 600; color: #374151; }
    .permission-actions {
      color: #6b7280; font-size: 14px;
      background: #f9fafb; padding: 2px 8px; border-radius: 12px;
    }

    .cta-section { text-align: center; margin: 35px 0; }
    .cta-button {
      display: inline-block; background: linear-gradient(135deg, #4f46e5, #7c3aed);
      color: white; text-decoration: none; padding: 16px 32px; border-radius: 8px;
      font-weight: 600; font-size: 16px;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
    }

    .expiry-notice {
      background: linear-gradient(135deg, #fef3c7, #fed7aa);
      border: 1px solid #f59e0b; border-radius: 8px; padding: 18px;
      margin: 25px 0; display: flex; align-items: flex-start; gap: 12px;
    }
    .expiry-icon { font-size: 20px; margin-top: 2px; }

    .next-steps { margin: 30px 0; }
    .steps-list { counter-reset: step; list-style: none; padding: 0; }
    .steps-list li {
      counter-increment: step; margin: 15px 0; padding: 15px 20px 15px 60px;
      background: #f8fafc; border-radius: 8px; position: relative;
    }
    .steps-list li::before {
      content: counter(step); position: absolute; left: 20px; top: 15px;
      background: #4f46e5; color: white; border-radius: 50%;
      width: 25px; height: 25px; display: flex; align-items: center;
      justify-content: center; font-weight: bold; font-size: 13px;
    }

    .footer {
      background: #f8fafc; padding: 30px; text-align: center;
      border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px;
    }
    .footer-links { margin: 15px 0; }
    .footer-links a { color: #4f46e5; text-decoration: none; margin: 0 15px; }

    .fallback-url {
      word-break: break-all; color: #4f46e5; font-size: 13px;
      background: #f8fafc; padding: 10px 12px; border-radius: 6px;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Welcome to the Team!</h1>
      <p>${esc(data.inviterName)} has invited you to join ${esc(data.organizationName)}</p>
    </div>

    <div class="content">
      <div class="greeting">
        Hello <strong>${esc(data.inviteeName)}</strong>,
      </div>

      <p>You've been invited to join our team with the following access level:</p>

      <div class="invitation-card">
        <div class="role-section">
          <div class="role-badge">${esc(data.role.replace(/_/g, " "))}</div>
          <div>
            <div style="font-weight: 600; color: #374151;">${esc(roleDesc)}</div>
            <div style="color: #6b7280; font-size: 14px; margin-top: 4px;">Invited by ${esc(data.inviterName)}</div>
          </div>
        </div>

        ${permissionRowsHtml ? `
        <div class="permissions-box">
          <div style="font-weight: 600; margin-bottom: 10px; color: #374151;">Your Access Permissions:</div>
          <ul class="permissions-list">${permissionRowsHtml}
          </ul>
        </div>` : ""}
      </div>

      <div class="cta-section">
        <p style="margin-bottom: 25px; font-size: 16px;">Ready to get started? Click below to activate your account:</p>
        <a href="${esc(data.activationUrl)}" class="cta-button">
          Activate Account &amp; Set Password
        </a>
        <div class="fallback-url">${esc(data.activationUrl)}</div>
      </div>

      <div class="expiry-notice">
        <div class="expiry-icon">&#x23F0;</div>
        <div>
          <strong>Important:</strong> This invitation expires on <strong>${esc(data.expiresAt)}</strong>.
          <br>If you don't activate by then, please contact ${esc(data.inviterEmail)} for a new invitation.
        </div>
      </div>

      <div class="next-steps">
        <h3 style="color: #374151; margin-bottom: 20px;">What happens next:</h3>
        <ol class="steps-list">
          <li><strong>Verify your email</strong> by clicking the activation link above</li>
          <li><strong>Create your secure password</strong> following our security requirements</li>
          <li><strong>Explore your dashboard</strong> with your new ${esc(data.role)} permissions</li>
          <li><strong>Start collaborating</strong> with the ${esc(data.organizationName)} team!</li>
        </ol>
      </div>

      <div style="margin-top: 35px; padding-top: 25px; border-top: 1px solid #e5e7eb;">
        <p style="color: #6b7280;">
          <strong>Need help getting started?</strong> Contact ${esc(data.inviterEmail)} or visit our support center.
          We're here to help you succeed!
        </p>
      </div>
    </div>

    <div class="footer">
      <p><strong>Invitation Details</strong></p>
      <p>Sent by: ${esc(data.inviterName)} (${esc(data.inviterEmail)})<br>Date: ${esc(data.inviteDate)}</p>
      <div class="footer-links">
        <a href="mailto:${esc(data.inviterEmail)}">Contact Inviter</a>
        <a href="${esc(supportUrl)}">Get Support</a>
      </div>
      <p style="color: #9ca3af; font-size: 12px; margin-top: 20px;">
        If you didn't expect this invitation, you can safely ignore this email.<br>
        This is an automated message from ${esc(data.organizationName)}.
      </p>
    </div>
  </div>
</body>
</html>`;

  // Sanitize user-controlled fields for the text body (strip CR/LF/tabs).
  // The activation URL is left intact because URL components are already
  // %-encoded by the service layer.
  const tName = stripCtl(data.inviteeName);
  const tInviter = stripCtl(data.inviterName);
  const tInviterEmail = stripCtl(data.inviterEmail);
  const tOrg = stripCtl(data.organizationName);
  const tRole = stripCtl(data.role.replace(/_/g, " "));
  const tExpires = stripCtl(data.expiresAt);
  const tInviteDate = stripCtl(data.inviteDate);

  const text = `Welcome to ${tOrg}!

Hello ${tName},

${tInviter} has invited you to join the team with ${tRole} access.
${stripCtl(roleDesc)}

Your Permissions:
${permissionRowsText || "(default permissions for your role)"}

To activate your account:
1. Click this link: ${data.activationUrl}
2. Create your secure password
3. Start using your dashboard

This invitation expires on ${tExpires}.

Questions? Contact ${tInviterEmail}

Welcome to the team!

---
This invitation was sent by ${tInviter} on ${tInviteDate}.
If you didn't expect this invitation, you can safely ignore this email.
`;

  return { subject, html, text };
}
