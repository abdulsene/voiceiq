import { Fragment, useEffect, useMemo, useState } from "react";
import { fetchApi } from "../lib/api";
import {
  Loader2,
  Download,
  Search,
  ChevronDown,
  ChevronRight,
  Shield,
  Filter,
  RefreshCw,
} from "lucide-react";

interface AuditLog {
  id: string;
  business_id: string | null;
  user_id: string | null;
  action: string;
  resource: string | null;
  resource_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  success: boolean | null;
  result: string | null;
  details: any;
  risk_score: number | null;
  compliance_flags: string[] | null;
  session_id: string | null;
  timestamp: string;
}

interface ListResponse {
  logs: AuditLog[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 100;

function csvEscape(v: any): string {
  if (v === null || v === undefined) return "";
  let s =
    typeof v === "string"
      ? v
      : Array.isArray(v) || typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  // Spreadsheet formula injection: cells starting with =, +, -, @, tab, or CR
  // are interpreted as formulas in Excel/Sheets/Numbers. Audit rows include
  // attacker-controllable fields (user_agent, details). Prefix with a single
  // quote to neutralize without losing the original character on display.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export default function AdminAuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterAction, setFilterAction] = useState("");
  const [filterBusinessId, setFilterBusinessId] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [search, setSearch] = useState("");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  async function load(
    off = 0,
    overrides?: {
      filterAction?: string;
      filterBusinessId?: string;
      filterFrom?: string;
      filterTo?: string;
    },
  ) {
    setLoading(true);
    setError(null);
    // Allow callers (e.g. clearFilters) to pass cleared values directly so
    // they don't depend on React state being committed before the fetch.
    const fa = overrides?.filterAction ?? filterAction;
    const fb = overrides?.filterBusinessId ?? filterBusinessId;
    const ff = overrides?.filterFrom ?? filterFrom;
    const ft = overrides?.filterTo ?? filterTo;
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(off));
    if (fa.trim()) params.set("action", fa.trim());
    if (fb.trim()) params.set("business_id", fb.trim());
    if (ff) {
      params.set("from", new Date(ff + "T00:00:00Z").toISOString());
    }
    if (ft) {
      params.set("to", new Date(ft + "T23:59:59Z").toISOString());
    }
    try {
      const data: ListResponse = await fetchApi(`/admin/audit-logs?${params}`);
      setLogs(data.logs);
      setTotal(data.total);
      setOffset(off);
    } catch (e: any) {
      const msg = e?.message || "Failed to load";
      setError(msg);
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleLogs = useMemo(() => {
    if (!search.trim()) return logs;
    const s = search.toLowerCase();
    return logs.filter(
      (l) =>
        l.action.toLowerCase().includes(s) ||
        (l.resource || "").toLowerCase().includes(s) ||
        (l.resource_id || "").toLowerCase().includes(s) ||
        (l.user_id || "").toLowerCase().includes(s) ||
        (l.business_id || "").toLowerCase().includes(s) ||
        (l.ip_address || "").includes(s) ||
        JSON.stringify(l.details || {})
          .toLowerCase()
          .includes(s),
    );
  }, [logs, search]);

  function exportCSV() {
    const cols: (keyof AuditLog)[] = [
      "timestamp",
      "business_id",
      "user_id",
      "action",
      "resource",
      "resource_id",
      "ip_address",
      "user_agent",
      "success",
      "result",
      "risk_score",
      "compliance_flags",
      "session_id",
      "details",
    ];
    const header = cols.join(",");
    const rows = visibleLogs.map((l) =>
      cols.map((c) => csvEscape(l[c])).join(","),
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function clearFilters() {
    setFilterAction("");
    setFilterBusinessId("");
    setFilterFrom("");
    setFilterTo("");
    setSearch("");
    // Pass cleared values explicitly — setState is async; reading filter*
    // from closure here would re-send the OLD values on the very next fetch.
    load(0, {
      filterAction: "",
      filterBusinessId: "",
      filterFrom: "",
      filterTo: "",
    });
  }

  const isAdminBlocked = !!error && /403|admin|denied/i.test(error);

  return (
    <div className="px-6 py-4 max-w-[1400px]">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-[#2E75B6]" />
          <h1 className="text-2xl font-semibold text-gray-900">
            Admin Audit Logs
          </h1>
        </div>
        <button
          onClick={() => load(offset)}
          className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 hover:bg-gray-50 rounded-md flex items-center gap-1"
          data-testid="refresh-button"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      <p className="text-sm text-gray-500 mb-4">
        Read-only audit trail for compliance and security review. Showing{" "}
        <span className="font-semibold text-gray-700">
          {visibleLogs.length}
        </span>{" "}
        of <span className="font-semibold text-gray-700">{total}</span>{" "}
        total entries.
      </p>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Action
            </label>
            <input
              type="text"
              placeholder="e.g. auth.login"
              value={filterAction}
              onChange={(e) => setFilterAction(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load(0)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2E75B6]"
              data-testid="filter-action"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Business ID
            </label>
            <input
              type="text"
              placeholder="biz_..."
              value={filterBusinessId}
              onChange={(e) => setFilterBusinessId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load(0)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2E75B6]"
              data-testid="filter-business"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              From
            </label>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2E75B6]"
              data-testid="filter-from"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              To
            </label>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2E75B6]"
              data-testid="filter-to"
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              onClick={() => load(0)}
              className="flex-1 px-3 py-2 text-sm font-medium text-white bg-[#2E75B6] hover:bg-[#235a8e] rounded-md flex items-center justify-center gap-1"
              data-testid="apply-filters"
            >
              <Filter className="w-4 h-4" />
              Apply
            </button>
            <button
              onClick={clearFilters}
              className="px-3 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 hover:bg-gray-50 rounded-md"
              data-testid="clear-filters"
            >
              Clear
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
            <input
              type="search"
              placeholder="Search current page (action, IDs, IP, metadata)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-[#2E75B6]"
              data-testid="search-input"
            />
          </div>
          <button
            onClick={exportCSV}
            disabled={visibleLogs.length === 0}
            className="ml-3 px-3 py-2 text-sm font-medium text-gray-700 border border-gray-300 hover:bg-gray-50 rounded-md flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid="export-csv"
          >
            <Download className="w-4 h-4" />
            Export CSV ({visibleLogs.length})
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-[#2E75B6]" />
          </div>
        ) : isAdminBlocked ? (
          <div className="px-4 py-12 text-center">
            <Shield className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-900">
              Admin access required
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Your account does not have permission to view audit logs.
            </p>
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-red-600">
            Error: {error}
          </div>
        ) : visibleLogs.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            No audit logs match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm"
              data-testid="audit-logs-table"
            >
              <thead className="bg-gray-50 text-gray-700 text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left w-8"></th>
                  <th className="px-3 py-2 text-left">Timestamp</th>
                  <th className="px-3 py-2 text-left">User</th>
                  <th className="px-3 py-2 text-left">Action</th>
                  <th className="px-3 py-2 text-left">Resource</th>
                  <th className="px-3 py-2 text-left">IP</th>
                  <th className="px-3 py-2 text-left">Compliance</th>
                  <th className="px-3 py-2 text-left">Risk</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogs.map((l) => (
                  <Fragment key={l.id}>
                    <tr
                      className="border-t border-gray-100 hover:bg-gray-50 cursor-pointer"
                      onClick={() =>
                        setExpandedRow(expandedRow === l.id ? null : l.id)
                      }
                      data-testid={`audit-row-${l.id}`}
                    >
                      <td className="px-3 py-2 text-gray-400">
                        {expandedRow === l.id ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-gray-900 whitespace-nowrap">
                        {new Date(l.timestamp).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-gray-700 font-mono text-xs">
                        {l.user_id ? l.user_id.slice(0, 8) + "…" : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            l.success === false
                              ? "bg-red-100 text-red-700"
                              : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {l.action}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-gray-700 text-xs">
                        {l.resource || "—"}
                        {l.resource_id
                          ? ` / ${l.resource_id.slice(0, 12)}…`
                          : ""}
                      </td>
                      <td className="px-3 py-2 text-gray-700 font-mono text-xs">
                        {l.ip_address || "—"}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {(l.compliance_flags || []).map((f) => (
                            <span
                              key={f}
                              className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-medium"
                            >
                              {f}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-xs font-medium ${
                            (l.risk_score ?? 0) >= 50
                              ? "text-red-600"
                              : (l.risk_score ?? 0) >= 25
                                ? "text-amber-600"
                                : "text-gray-500"
                          }`}
                        >
                          {l.risk_score ?? 0}
                        </span>
                      </td>
                    </tr>
                    {expandedRow === l.id && (
                      <tr className="border-t border-gray-100 bg-gray-50">
                        <td colSpan={8} className="px-6 py-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                            <div>
                              <div className="font-medium text-gray-700 mb-1">
                                Full IDs
                              </div>
                              <div className="font-mono text-gray-600 break-all">
                                user: {l.user_id || "—"}
                              </div>
                              <div className="font-mono text-gray-600 break-all">
                                business: {l.business_id || "—"}
                              </div>
                              <div className="font-mono text-gray-600 break-all">
                                resource_id: {l.resource_id || "—"}
                              </div>
                              <div className="font-mono text-gray-600 break-all">
                                session: {l.session_id || "—"}
                              </div>
                              <div className="font-mono text-gray-600 mt-1">
                                result: {l.result || "—"} | success:{" "}
                                {String(l.success)}
                              </div>
                            </div>
                            <div>
                              <div className="font-medium text-gray-700 mb-1">
                                Metadata
                              </div>
                              <pre className="bg-white p-2 rounded border border-gray-200 overflow-x-auto text-[11px] leading-tight max-h-64">
                                {l.details
                                  ? JSON.stringify(l.details, null, 2)
                                  : "(none)"}
                              </pre>
                            </div>
                          </div>
                          <div className="mt-2 text-[11px] text-gray-500 break-all">
                            User-Agent: {l.user_agent || "—"}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {!loading && !error && total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-gray-500">
            Showing {offset + 1}–{Math.min(offset + logs.length, total)} of{" "}
            {total}
          </div>
          <div className="flex gap-2">
            <button
              disabled={offset === 0}
              onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md disabled:opacity-50 hover:bg-gray-50"
              data-testid="prev-page"
            >
              Previous
            </button>
            <button
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => load(offset + PAGE_SIZE)}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md disabled:opacity-50 hover:bg-gray-50"
              data-testid="next-page"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
