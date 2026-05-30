/**
 * SendGrid client (Replit connector blueprint).
 *
 * Credentials are fetched fresh from the Replit connector service on every
 * call — never cache the client. Tokens rotate.
 */
import sgMail from "@sendgrid/mail";

async function getCredentials(): Promise<{ apiKey: string; email: string }> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }
  if (!hostname) {
    throw new Error("REPLIT_CONNECTORS_HOSTNAME not set");
  }

  const settings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=sendgrid",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    },
  )
    .then((res) => res.json())
    .then((data: any) => data.items?.[0]);

  if (!settings || !settings.settings?.api_key || !settings.settings?.from_email) {
    throw new Error("SendGrid not connected");
  }
  return { apiKey: settings.settings.api_key, email: settings.settings.from_email };
}

export async function getUncachableSendGridClient() {
  const { apiKey, email } = await getCredentials();
  sgMail.setApiKey(apiKey);
  return { client: sgMail, fromEmail: email };
}

// ---------------------------------------------------------------------------
// NOTE: Transactional email senders (e.g. invitations) live in
// `src/services/<purpose>-email-service.ts` and import the client from this
// module. Keep this file focused on connector/credential concerns only.
// ---------------------------------------------------------------------------

