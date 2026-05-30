/**
 * Salesforce REST connector for Neverr enterprise CRM sync. Implements
 * OAuth client_credentials authentication and the three highest-value
 * write operations triggered by Neverr call events: createLead,
 * updateContact, and createTask.
 *
 * The connector intentionally keeps no internal state besides the
 * (mutated) integration record so callers can pass a freshly hydrated
 * integration on each request without re-instantiation cost.
 */

import type { CRMIntegration } from "../types/enterprise.js";

export interface CallDataLike {
  caller_name?: string | null;
  caller_number?: string | null;
  company?: string | null;
  summary?: string | null;
  sentiment?: string | null;
  duration_seconds?: number | null;
}

export class SalesforceConnector {
  private integration: CRMIntegration;
  private baseUrl: string;

  constructor(integration: CRMIntegration) {
    this.integration = integration;
    const instanceUrl = integration.credentials.instanceUrl?.replace(/\/+$/, "");
    if (!instanceUrl) throw new Error("Salesforce instanceUrl is required");
    this.baseUrl = `${instanceUrl}/services/data/v58.0`;
  }

  /** Authenticate via OAuth client_credentials and cache the access token. */
  async authenticate(): Promise<boolean> {
    const { instanceUrl, clientId, clientSecret } = this.integration.credentials;
    if (!instanceUrl || !clientId || !clientSecret) {
      console.error("[Salesforce] Missing instanceUrl/clientId/clientSecret");
      return false;
    }
    try {
      const response = await fetch(`${instanceUrl}/services/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
      const data = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
      if (response.ok && data.access_token) {
        this.integration.credentials.accessToken = data.access_token;
        return true;
      }
      console.error("[Salesforce] Auth failed:", data.error_description || data.error || response.status);
      return false;
    } catch (err: any) {
      console.error("[Salesforce] Auth error:", err.message);
      return false;
    }
  }

  private async ensureAuthed(): Promise<void> {
    if (!this.integration.credentials.accessToken) {
      const ok = await this.authenticate();
      if (!ok) throw new Error("Salesforce authentication failed");
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.integration.credentials.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  /** Create a Salesforce Lead from a Neverr call. Returns the Lead Id, or null. */
  async createLead(callData: CallDataLike): Promise<string | null> {
    await this.ensureAuthed();
    const fullName = (callData.caller_name || "Unknown Caller").trim();
    const [first, ...rest] = fullName.split(/\s+/);
    const lead = {
      FirstName: first || "Unknown",
      LastName: rest.join(" ") || "Caller",
      Phone: callData.caller_number || undefined,
      Company: callData.company || "Unknown Company",
      LeadSource: "Neverr AI Voice",
      Status: "New",
      Description:
        `Call Summary: ${callData.summary || "No summary available"}\n\n` +
        `Sentiment: ${callData.sentiment || "Unknown"}\n\n` +
        `Duration: ${callData.duration_seconds || 0}s`,
    };

    try {
      const response = await fetch(`${this.baseUrl}/sobjects/Lead`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(lead),
      });
      if (response.ok) {
        const result = (await response.json()) as { id?: string };
        return result.id ?? null;
      }
      console.error("[Salesforce] createLead failed:", response.status, await response.text());
      return null;
    } catch (err: any) {
      console.error("[Salesforce] createLead error:", err.message);
      return null;
    }
  }

  /** Patch an existing Contact with a recent-call summary. */
  async updateContact(contactId: string, callData: CallDataLike): Promise<boolean> {
    await this.ensureAuthed();
    const update = {
      Description: `Recent Neverr AI Call - ${new Date().toLocaleDateString()}: ${callData.summary || "Call completed"}`,
    };
    try {
      const response = await fetch(`${this.baseUrl}/sobjects/Contact/${contactId}`, {
        method: "PATCH",
        headers: this.authHeaders(),
        body: JSON.stringify(update),
      });
      return response.ok;
    } catch (err: any) {
      console.error("[Salesforce] updateContact error:", err.message);
      return false;
    }
  }

  /** Create a follow-up Task from a Neverr call. */
  async createTask(callData: CallDataLike, assignedTo?: string): Promise<string | null> {
    await this.ensureAuthed();
    const task: Record<string, unknown> = {
      Subject: `Follow up on Neverr AI call from ${callData.caller_name || "Unknown Caller"}`,
      Description:
        `Call Summary: ${callData.summary || "No summary"}\n\n` +
        `Caller: ${callData.caller_number || "Unknown"}\n` +
        `Sentiment: ${callData.sentiment || "Unknown"}\n` +
        `Duration: ${callData.duration_seconds || 0}s`,
      Priority: callData.sentiment === "negative" ? "High" : "Normal",
      Status: "Open",
      ActivityDate: new Date().toISOString().split("T")[0],
    };
    if (assignedTo) task.OwnerId = assignedTo;

    try {
      const response = await fetch(`${this.baseUrl}/sobjects/Task`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(task),
      });
      if (response.ok) {
        const result = (await response.json()) as { id?: string };
        return result.id ?? null;
      }
      console.error("[Salesforce] createTask failed:", response.status, await response.text());
      return null;
    } catch (err: any) {
      console.error("[Salesforce] createTask error:", err.message);
      return null;
    }
  }
}
