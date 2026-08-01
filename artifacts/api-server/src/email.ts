import { Resend } from "resend";

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

/**
 * Phase 3.17 — where the invite link lands. Set in Replit Secrets.
 * Falls back to the production dashboard URL so we never send a
 * localhost link into a customer's inbox by accident.
 */
function getInviteBaseUrl(): string {
  const raw = process.env.PUBLIC_APP_URL || process.env.PUBLIC_URL;
  if (raw && /^https:\/\//.test(raw)) return raw.replace(/\/+$/, "");
  return "https://neverr.ai";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendCallSummaryEmail({
  to,
  businessName,
  callerName,
  callerPhone,
  callDuration,
  summary,
  leadScore,
  appointmentBooked,
  actionItems,
  callId,
}: {
  to: string;
  businessName: string;
  callerName?: string;
  callerPhone: string;
  callDuration: number;
  summary: string;
  leadScore: "hot" | "warm" | "cold";
  appointmentBooked: boolean;
  actionItems: string[];
  callId: string;
}) {
  const resend = getResend();
  if (!resend) {
    console.log("[Email] Skipping — RESEND_API_KEY not set");
    return;
  }

  const leadColors = { hot: "#DC2626", warm: "#D97706", cold: "#2563EB" };
  const leadEmojis = { hot: "\u{1F525}", warm: "\u2600\uFE0F", cold: "\u2744\uFE0F" };
  const minutes = Math.floor(callDuration / 60);
  const seconds = callDuration % 60;
  const durationStr = `${minutes}m ${seconds}s`;

  const safeName = escapeHtml(callerName || "Unknown");
  const safePhone = escapeHtml(callerPhone);
  const safeBusiness = escapeHtml(businessName);
  const safeSummary = escapeHtml(summary);

  const actionItemsHtml =
    actionItems.length > 0
      ? actionItems.map((item) => `<li style="margin-bottom:8px">${escapeHtml(item)}</li>`).join("")
      : "<li>No action items</li>";

  const html = `
<!DOCTYPE html>
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
        AI Receptionist Call Summary
      </p>
    </div>

    <div style="background: ${leadColors[leadScore]}15; 
                border-left: 4px solid ${leadColors[leadScore]}; 
                padding: 16px 32px; display: flex; align-items: center;">
      <span style="font-size: 24px; margin-right: 12px;">${leadEmojis[leadScore]}</span>
      <div>
        <div style="font-weight: 700; color: ${leadColors[leadScore]}; 
                    text-transform: uppercase; font-size: 12px; letter-spacing: 1px;">
          ${leadScore} Lead
        </div>
        <div style="color: #1B2537; font-weight: 600; font-size: 15px;">
          ${appointmentBooked ? "\u2705 Appointment Booked" : "No appointment booked"}
        </div>
      </div>
    </div>

    <div style="padding: 32px;">
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; 
                     color: #64748B; font-size: 14px; width: 40%;">Caller</td>
          <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; 
                     font-weight: 600; color: #1B2537; font-size: 14px;">
            ${safeName} &middot; ${safePhone}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; 
                     color: #64748B; font-size: 14px;">Duration</td>
          <td style="padding: 10px 0; border-bottom: 1px solid #F1F5F9; 
                     font-weight: 600; color: #1B2537; font-size: 14px;">
            ${durationStr}
          </td>
        </tr>
        <tr>
          <td style="padding: 10px 0; color: #64748B; font-size: 14px;">Business</td>
          <td style="padding: 10px 0; font-weight: 600; 
                     color: #1B2537; font-size: 14px;">${safeBusiness}</td>
        </tr>
      </table>

      <h3 style="color: #1B2537; font-size: 16px; margin: 0 0 12px;">Call Summary</h3>
      <p style="color: #475569; line-height: 1.7; font-size: 14px; 
                background: #F8FAFC; padding: 16px; border-radius: 8px; margin: 0 0 24px;">
        ${safeSummary}
      </p>

      <h3 style="color: #1B2537; font-size: 16px; margin: 0 0 12px;">Action Items</h3>
      <ul style="color: #475569; font-size: 14px; line-height: 1.7; 
                 padding-left: 20px; margin: 0 0 32px;">
        ${actionItemsHtml}
      </ul>

      <div style="text-align: center;">
        <a href="https://neverr.ai/calls" 
           style="background: #2E75B6; color: white; padding: 14px 32px; 
                  border-radius: 10px; text-decoration: none; font-weight: 600; 
                  font-size: 15px; display: inline-block;">
          View Full Call Details &rarr;
        </a>
      </div>
    </div>

    <div style="background: #F8FAFC; padding: 24px 32px; text-align: center; 
                border-top: 1px solid #E2E8F0;">
      <p style="color: #94A3B8; font-size: 12px; margin: 0;">
        Neverr AI &middot; Never missed. Never closed. Never lost.<br>
        <a href="https://neverr.ai/settings" 
           style="color: #94A3B8;">Manage notification settings</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  await resend.emails.send({
    from: "Neverr <calls@neverr.ai>",
    to,
    subject: `${leadEmojis[leadScore]} New call from ${callerPhone} · ${businessName}`,
    html,
  });

  console.log("[Email] Call summary sent to:", to);
}

/**
 * Phase 3.17 — branded team invite email via Resend.
 *
 * Ships instead of Supabase's default "You have been invited to
 * access <project>" email, which was:
 *   (a) unbranded — didn't mention Neverr, the business, or who
 *       invited them (so it looked like phishing)
 *   (b) a one-time GET link — Microsoft Defender Safe Links (and
 *       Google's equivalent) prefetched and consumed it on corporate
 *       mailboxes, silently marking invites accepted with no
 *       password set. Live prod evidence:
 *       aaliyah.louise@ezrentalsandleasing.com, redeemed 48s after
 *       send, no human interaction.
 *
 * This email carries a token that only becomes real when the human
 * POSTs from our /invite/:token SPA page — GET is safe for scanners
 * to prefetch. See migration 047 + routes/team.ts Phase 3.17 header.
 *
 * Copy requirements from the phase brief:
 *   - who invited them (name)
 *   - the business
 *   - their role
 *   - one-line what Neverr does
 *   - what happens after they set a password
 *   - that the link expires in 7 days
 */
export async function sendTeamInviteEmail({
  to,
  inviteToken,
  businessName,
  inviterName,
  role,
  fullName,
  expiresAt,
}: {
  to: string;
  inviteToken: string;
  businessName: string;
  inviterName: string;
  role: string;
  fullName: string | null;
  expiresAt: string;
}): Promise<void> {
  const resend = getResend();
  if (!resend) {
    console.log("[Email] Skipping invite send — RESEND_API_KEY not set");
    return;
  }

  const inviteUrl = `${getInviteBaseUrl()}/invite/${encodeURIComponent(inviteToken)}`;
  const expiryDate = new Date(expiresAt);
  const expiryLabel = expiryDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const safeInviter = escapeHtml(inviterName);
  const safeBusiness = escapeHtml(businessName);
  const safeRole = escapeHtml(prettyRoleLabel(role));
  const safeFullName = fullName ? escapeHtml(fullName) : null;
  const safeUrl = escapeHtml(inviteUrl);
  const safeExpiry = escapeHtml(expiryLabel);
  const greeting = safeFullName ? `Hi ${safeFullName},` : "Hi,";

  const html = `
<!DOCTYPE html>
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
        AI Receptionist for calls, chat, SMS, and CRM
      </p>
    </div>

    <div style="padding: 32px;">
      <p style="color: #1B2537; font-size: 16px; margin: 0 0 16px;">${greeting}</p>

      <p style="color: #475569; line-height: 1.7; font-size: 15px; margin: 0 0 20px;">
        <strong style="color: #1B2537;">${safeInviter}</strong> invited you to join
        <strong style="color: #1B2537;">${safeBusiness}</strong> on Neverr as
        <strong style="color: #1B2537;">${safeRole}</strong>.
      </p>

      <p style="color: #475569; line-height: 1.7; font-size: 15px; margin: 0 0 24px;">
        Neverr is the AI receptionist your business uses to never miss a call,
        chat, or SMS from a customer. You'll answer live calls in the browser,
        see call transcripts, and manage the shared lead pipeline.
      </p>

      <div style="text-align: center; margin: 24px 0 28px;">
        <a href="${safeUrl}"
           style="background: #2E75B6; color: white; padding: 14px 32px;
                  border-radius: 10px; text-decoration: none; font-weight: 600;
                  font-size: 15px; display: inline-block;">
          Set your password &rarr;
        </a>
      </div>

      <p style="color: #64748B; font-size: 13px; line-height: 1.6; margin: 0 0 8px;">
        <strong style="color: #475569;">What happens next:</strong> you'll set a password,
        then land on your dashboard with a short checklist (add your callback
        number, enable in-app calling, go on duty) so the routing engine can
        reach you.
      </p>

      <p style="color: #94A3B8; font-size: 12px; line-height: 1.6; margin: 20px 0 0;">
        This invite expires on <strong>${safeExpiry}</strong>. If it does, ask
        ${safeInviter} to send a new one.
      </p>

      <p style="color: #94A3B8; font-size: 11px; line-height: 1.5; margin: 16px 0 0;
                padding-top: 16px; border-top: 1px solid #E2E8F0;">
        If the button doesn't work, copy this link into your browser:<br>
        <span style="font-family: 'SF Mono', Consolas, monospace; word-break: break-all;
                     color: #64748B;">${safeUrl}</span>
      </p>
    </div>

    <div style="background: #F8FAFC; padding: 20px 32px; text-align: center;
                border-top: 1px solid #E2E8F0;">
      <p style="color: #94A3B8; font-size: 12px; margin: 0;">
        Neverr AI &middot; Never missed. Never closed. Never lost.<br>
        If you weren't expecting this invite, you can safely ignore this email.
      </p>
    </div>
  </div>
</body>
</html>`;

  await resend.emails.send({
    from: "Neverr <invites@neverr.ai>",
    to,
    subject: `${inviterName} invited you to ${businessName} on Neverr`,
    html,
  });

  console.log("[Email] Team invite sent to:", to);
}

function prettyRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: "Owner",
    admin: "Admin",
    manager: "Manager",
    team_lead: "Team lead",
    agent_manager: "Agent manager",
    analyst: "Analyst",
    user: "Team member",
    readonly: "Read-only",
  };
  return labels[role] || role;
}
