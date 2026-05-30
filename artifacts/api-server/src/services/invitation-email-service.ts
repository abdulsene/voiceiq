/**
 * Invitation email delivery service.
 *
 * Thin orchestration layer: builds the activation URL, renders the template,
 * and ships through SendGrid via the Replit connector. Never throws — all
 * errors are returned in the result envelope so the caller can decide whether
 * a failed send is fatal (it isn't, for invites — the inviter still has the
 * token in the API response and can fall back to manual delivery).
 *
 * Tracking: opens + clicks are enabled so admins can see in the SendGrid
 * dashboard whether invitees actually received and engaged with the email.
 * `customArgs` get forwarded to SendGrid event webhooks for downstream
 * analytics.
 */
import { getUncachableSendGridClient } from "../integrations/sendgrid.js";
import { generateInvitationEmail } from "../email-templates/user-invitation.js";

export interface InvitationEmailData {
  recipientEmail: string;
  inviteeName?: string;
  inviterName: string;
  inviterEmail: string;
  role: string;
  permissions: Record<string, string[] | string>;
  inviteToken: string;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  organizationName?: string;
  /** Override base URL (defaults to FRONTEND_URL → BASE_URL → https://neverr.ai). */
  frontendUrl?: string;
}

export type InvitationEmailResult =
  | {
      success: true;
      messageId?: string;
      deliveredAt: string;
    }
  | {
      success: false;
      error: string;
      errorCode?: string;
    };

export async function sendInvitationEmail(
  data: InvitationEmailData,
): Promise<InvitationEmailResult> {
  try {
    const baseUrl = (
      data.frontendUrl ||
      process.env.FRONTEND_URL ||
      process.env.BASE_URL ||
      "https://neverr.ai"
    ).replace(/\/$/, "");

    // Build activation URL with URL-encoded query params (template trusts this).
    const activationUrl =
      `${baseUrl}/activate` +
      `?token=${encodeURIComponent(data.inviteToken)}` +
      `&email=${encodeURIComponent(data.recipientEmail)}`;

    const orgName = data.organizationName || "Neverr Platform";
    const inviteeName = data.inviteeName || data.recipientEmail.split("@")[0];

    const expiresAtFormatted = new Date(data.expiresAt).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });

    const inviteDateFormatted = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const emailContent = generateInvitationEmail({
      inviteeName,
      inviterName: data.inviterName,
      inviterEmail: data.inviterEmail,
      organizationName: orgName,
      role: data.role,
      permissions: data.permissions,
      activationUrl,
      expiresAt: expiresAtFormatted,
      inviteDate: inviteDateFormatted,
    });

    const { client, fromEmail } = await getUncachableSendGridClient();

    // SendGrid v8 mail payload. We type as `any` because @sendgrid/mail's
    // generated types are restrictive about `customArgs` value coercion
    // (it expects strings; we provide strings).
    const message: any = {
      to: data.recipientEmail,
      from: {
        email: fromEmail,
        name: `${orgName} Team`,
      },
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      trackingSettings: {
        clickTracking: { enable: true, enableText: false },
        openTracking: { enable: true },
      },
      // SendGrid requires customArgs values to be strings — coerce defensively
      // even though the TS interface declares them as strings (callers in JS
      // contexts could pass non-strings).
      customArgs: {
        email_type: "user_invitation",
        invite_role: String(data.role ?? ""),
        inviter: String(data.inviterEmail ?? ""),
      },
    };

    const [response] = await client.send(message);

    const messageId =
      (response?.headers as any)?.["x-message-id"] ||
      (response?.headers as any)?.["X-Message-Id"];

    console.log(
      `[Email] Invitation sent to ${data.recipientEmail}, MessageID: ${messageId || "unknown"}`,
    );

    return {
      success: true,
      messageId,
      deliveredAt: new Date().toISOString(),
    };
  } catch (error: any) {
    // SendGrid wraps API errors in `error.response.body.errors`. Surface the
    // most useful string we can find without throwing.
    const sgErrors = error?.response?.body?.errors;
    const msg =
      Array.isArray(sgErrors) && sgErrors.length
        ? sgErrors.map((e: any) => e.message).join("; ")
        : error?.message || "Unknown SendGrid error";

    console.error("[Email] Failed to send invitation:", msg);

    return {
      success: false,
      error: msg,
      errorCode: error?.code,
    };
  }
}
