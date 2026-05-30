import { useEffect, useState } from "react";
import {
  Sparkles,
  Plus,
  Copy,
  Check,
  Loader2,
  ExternalLink,
  Ban,
  AlertCircle,
} from "lucide-react";

const API = window.location.origin + "/api";

type DemoStatus = "active" | "expired" | "revoked" | "deleted";

type Demo = {
  id: string;
  demo_business_id: string;
  demo_agent_id: string | null;
  demo_label: string;
  business_name: string;
  industry: string;
  website: string | null;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
  share_notes: string | null;
  call_count: number;
  share_url: string;
  status: DemoStatus;
};

type Industry = { industry_id: string; name: string; category: string };

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("neverr_token") || "";
  const activeBiz = localStorage.getItem("neverr_active_business_id") || "";
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (activeBiz) h["X-Active-Business"] = activeBiz;
  return h;
}

function statusBadge(status: DemoStatus) {
  const map: Record<DemoStatus, { label: string; cls: string }> = {
    active: { label: "Active", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    expired: { label: "Expired", cls: "bg-amber-50 text-amber-700 border-amber-200" },
    revoked: { label: "Revoked", cls: "bg-red-50 text-red-700 border-red-200" },
    deleted: { label: "Deleted", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  };
  const m = map[status];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${m.cls}`}>
      {m.label}
    </span>
  );
}

/**
 * Phase 3g: Admin-only Sales Demos tab. Lists persistent demos created for
 * sales outreach, lets admins create new ones, and revoke existing ones.
 * Mirrors the access pattern used by the API: any non-admin caller hitting
 * /api/admin/demos already gets 403, but we also hide the tab from the
 * sidebar in SettingsPage when the user has no admin membership.
 */
export default function SalesDemosTab() {
  const [demos, setDemos] = useState<Demo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [industries, setIndustries] = useState<Record<string, Industry[]>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [demoLabel, setDemoLabel] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("");
  const [website, setWebsite] = useState("");
  const [tone, setTone] = useState("");
  const [shareNotes, setShareNotes] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(30);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function resetForm() {
    setDemoLabel("");
    setBusinessName("");
    setIndustry("");
    setWebsite("");
    setTone("");
    setShareNotes("");
    setExpiresInDays(30);
    setCreateError(null);
  }

  async function loadDemos() {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await fetch(`${API}/admin/demos`, { headers: authHeaders() });
      const d = await r.json();
      if (r.ok && d.success) {
        setDemos(d.demos || []);
      } else {
        setLoadError(d.error || "Failed to load demos");
      }
    } catch (e: any) {
      setLoadError(e?.message || "Failed to load demos");
    }
    setLoading(false);
  }

  async function loadIndustries() {
    try {
      const r = await fetch(`${API}/onboard/industries`);
      const d = await r.json();
      if (d.success && d.categories) {
        setIndustries(d.categories);
      }
    } catch {
      /* non-fatal */
    }
  }

  useEffect(() => {
    loadDemos();
    loadIndustries();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreateError(null);

    if (!demoLabel.trim() || !businessName.trim() || !industry.trim()) {
      setCreateError("Demo label, business name, and industry are required");
      return;
    }

    setCreating(true);
    try {
      const r = await fetch(`${API}/admin/demos`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          demo_label: demoLabel.trim(),
          business_name: businessName.trim(),
          industry: industry.trim(),
          website: website.trim(),
          tone: tone.trim(),
          share_notes: shareNotes.trim(),
          expires_in_days: expiresInDays,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) {
        setCreateError(d.error || "Failed to create demo");
      } else {
        resetForm();
        setShowCreate(false);
        await loadDemos();
      }
    } catch (err: any) {
      setCreateError(err?.message || "Failed to create demo");
    }
    setCreating(false);
  }

  async function handleRevoke(demo: Demo) {
    if (revokingId) return;
    const reason = window.prompt(
      `Revoke "${demo.demo_label}"?\n\nThis tears down the voice agent and disables the share link immediately.\n\nOptional reason:`,
      "",
    );
    if (reason === null) return;

    setRevokingId(demo.demo_business_id);
    try {
      const r = await fetch(`${API}/admin/demos/${demo.demo_business_id}/revoke`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const d = await r.json();
      if (!r.ok || !d.success) {
        alert(d.error || "Failed to revoke demo");
      } else {
        await loadDemos();
      }
    } catch (err: any) {
      alert(err?.message || "Failed to revoke demo");
    }
    setRevokingId(null);
  }

  async function copyShareUrl(demo: Demo) {
    try {
      await navigator.clipboard.writeText(demo.share_url);
      setCopiedId(demo.demo_business_id);
      setTimeout(() => setCopiedId((c) => (c === demo.demo_business_id ? null : c)), 1500);
    } catch {
      /* clipboard might be unavailable; fall back silently */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
        <div>
          <h4 className="text-sm font-semibold text-red-900">Couldn't load sales demos</h4>
          <p className="text-sm text-red-700 mt-0.5">{loadError}</p>
          <button
            onClick={loadDemos}
            className="mt-2 text-sm font-medium text-red-700 underline hover:text-red-900"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-blue-600" />
            Sales Demos
          </h2>
          <p className="text-sm text-slate-600 mt-1 max-w-xl">
            Persistent demo accounts for outreach. Each demo gets its own share link
            and voice agent that prospects can talk to without signing up. Revoke
            anytime to disable the link and free the agent.
          </p>
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowCreate(true);
          }}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New demo
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Demo label (internal)
              </label>
              <input
                type="text"
                value={demoLabel}
                onChange={(e) => setDemoLabel(e.target.value)}
                placeholder="Acme Plumbing — Q2 outreach"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={200}
                required
              />
              <p className="text-xs text-slate-500 mt-1">
                Only visible to your team. Helps you recognize this demo in the list.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Prospect's business name
              </label>
              <input
                type="text"
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
                placeholder="Acme Plumbing"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={120}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Industry</label>
              <select
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                required
              >
                <option value="">Select industry…</option>
                {Object.entries(industries).map(([category, items]) => (
                  <optgroup key={category} label={category}>
                    {items.map((it) => (
                      <option key={it.industry_id} value={it.industry_id}>
                        {it.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Website (optional)
              </label>
              <input
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://acmeplumbing.com"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={500}
              />
              <p className="text-xs text-slate-500 mt-1">
                We'll scrape it to personalize the agent's responses.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Tone preference (optional)
              </label>
              <input
                type="text"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                placeholder="Friendly and professional, mention 24/7 emergency service"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={500}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Expires in (days)
              </label>
              <input
                type="number"
                min={1}
                max={90}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(parseInt(e.target.value, 10) || 30)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-xs text-slate-500 mt-1">Between 1 and 90 days.</p>
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Internal notes (optional)
              </label>
              <textarea
                value={shareNotes}
                onChange={(e) => setShareNotes(e.target.value)}
                placeholder="Notes about this prospect, follow-up dates, etc."
                rows={2}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                maxLength={2000}
              />
            </div>
          </div>

          {createError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
              {createError}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setShowCreate(false);
                resetForm();
              }}
              className="px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              {creating ? "Creating…" : "Create demo"}
            </button>
          </div>
        </form>
      )}

      {demos.length === 0 ? (
        <div className="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-8 text-center">
          <Sparkles className="w-10 h-10 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-600">No sales demos yet.</p>
          <p className="text-xs text-slate-500 mt-1">
            Click "New demo" to create a personalized link for your next outreach.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {demos.map((demo) => {
            const created = new Date(demo.created_at).toLocaleDateString();
            const expires = new Date(demo.expires_at).toLocaleDateString();
            const canRevoke = demo.status === "active" || demo.status === "expired";
            const linkLive = demo.status === "active";

            return (
              <div
                key={demo.id}
                className="bg-white border border-slate-200 rounded-xl p-4"
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-slate-900 truncate">
                        {demo.demo_label}
                      </h3>
                      {statusBadge(demo.status)}
                    </div>
                    <p className="text-sm text-slate-600 mt-0.5">
                      {demo.business_name} · {demo.industry}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Created {created} · Expires {expires} · {demo.call_count} call
                      {demo.call_count === 1 ? "" : "s"}
                    </p>
                    {demo.share_notes && (
                      <p className="text-xs text-slate-600 mt-2 italic">
                        {demo.share_notes}
                      </p>
                    )}
                    {demo.revoked_at && demo.revoke_reason && (
                      <p className="text-xs text-red-700 mt-2">
                        Revoked: {demo.revoke_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {linkLive && (
                      <>
                        <button
                          onClick={() => copyShareUrl(demo)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
                        >
                          {copiedId === demo.demo_business_id ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" />
                              Copy link
                            </>
                          )}
                        </button>
                        <a
                          href={demo.share_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Open
                        </a>
                      </>
                    )}
                    {canRevoke && (
                      <button
                        onClick={() => handleRevoke(demo)}
                        disabled={revokingId === demo.demo_business_id}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 hover:bg-red-100 disabled:opacity-60 rounded-lg transition-colors"
                      >
                        {revokingId === demo.demo_business_id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Ban className="w-3.5 h-3.5" />
                        )}
                        Revoke
                      </button>
                    )}
                  </div>
                </div>
                {linkLive && (
                  <div className="mt-3 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 font-mono break-all">
                    {demo.share_url}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
