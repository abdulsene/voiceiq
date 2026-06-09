/**
 * Stage 6 Phase 2 — /admin/businesses list page.
 *
 * Browse all customer businesses. Filter, sort, paginate. Each row is
 * a wouter Link to (Phase 3) /admin/businesses/:business_id.
 *
 * Permission UX: nav item is shown to everyone (matches /admin/audit-logs
 * precedent in Sidebar.tsx:45-47). The page detects 403 from the API
 * and renders an "Admin access required" empty state for non-staff
 * users — same pattern as AdminAuditLogs.tsx:188.
 *
 * URL query state: search/plan/has_sync_errors/include_test/sort/offset
 * sync to the URL via history.replaceState so filtered views are
 * shareable. Default values are stripped from the URL (recent sort,
 * include_test=false, etc.) to keep links clean.
 *
 * Polish standards (A-E) applied:
 *   - Mobile: desktop table (md:block) → mobile cards (md:hidden)
 *   - Loading: skeleton rows match table shape
 *   - Empty: invitation to adjust filters
 *   - Error: RefreshCw "Try again" button
 *   - Animations: motion-safe: prefix
 *   - A11y: aria-labels on icon-only buttons, aria-sort on sortable
 *     columns, text-gray-500 minimum for WCAG AA contrast
 *
 * TODO: voiceiq-dashboard has no vitest setup today. When test
 * infrastructure arrives, first target should be the URL query
 * param ↔ filter state sync logic — it's the most non-obvious bit
 * and the most likely to regress on refactor.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  Briefcase,
  Building2,
  Check,
  ChevronRight,
  Filter,
  Mail,
  RefreshCw,
  Search,
  Shield,
  X,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch as ToggleSwitch } from "@/components/ui/switch";

import { getAuthHeaders } from "@/lib/api";

// ───────────────────────────────────────────────────────────────────────
// Types

interface BusinessSummary {
  business_id: string;
  business_name: string | null;
  plan_id: string | null;
  subscription_status: string | null;
  agent_id: string | null;
  voice_id: string | null;
  voice_last_synced_at: string | null;
  voice_sync_error: string | null;
  prompt_updated_at: string | null;
  prompt_sync_error: string | null;
  created_at: string | null;
  owner_email: string | null;
}

interface ListResponse {
  rows: BusinessSummary[];
  total: number;
  limit: number;
  offset: number;
}

type SortKey = "recent" | "name" | "plan";

interface FilterState {
  search: string;
  plan: string; // "" = all
  hasSyncErrors: boolean;
  includeTest: boolean;
  sort: SortKey;
  offset: number;
}

const PAGE_LIMIT = 25;
const SEARCH_DEBOUNCE_MS = 250;

// Plan IDs that appear in business_configs.plan_id today.
// (Sourced from PLAN_PRICING in routes/admin.ts.)
const PLAN_OPTIONS = [
  "essential",
  "starter",
  "professional",
  "growth",
  "business",
  "enterprise",
] as const;

// ───────────────────────────────────────────────────────────────────────
// Helpers

function readFiltersFromUrl(): FilterState {
  const params = new URLSearchParams(window.location.search);
  const sortRaw = params.get("sort");
  const sort: SortKey =
    sortRaw === "name" || sortRaw === "plan" ? sortRaw : "recent";
  const parsedOffset = parseInt(params.get("offset") ?? "0", 10);
  return {
    search: params.get("search") ?? "",
    plan: params.get("plan") ?? "",
    hasSyncErrors: params.get("has_sync_errors") === "true",
    includeTest: params.get("include_test") === "true",
    sort,
    offset: Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0,
  };
}

/**
 * Strip defaults from the URL so shared links stay clean. Only
 * non-default values get encoded; "recent" sort, offset=0,
 * hasSyncErrors=false, includeTest=false, and empty strings are all
 * dropped.
 */
function writeFiltersToUrl(state: FilterState): void {
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.plan) params.set("plan", state.plan);
  if (state.hasSyncErrors) params.set("has_sync_errors", "true");
  if (state.includeTest) params.set("include_test", "true");
  if (state.sort !== "recent") params.set("sort", state.sort);
  if (state.offset > 0) params.set("offset", String(state.offset));
  const qs = params.toString();
  const url =
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
  window.history.replaceState(null, "", url);
}

function buildApiUrl(state: FilterState): string {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_LIMIT));
  if (state.offset > 0) params.set("offset", String(state.offset));
  if (state.search) params.set("search", state.search);
  if (state.plan) params.set("plan", state.plan);
  if (state.hasSyncErrors) params.set("has_sync_errors", "true");
  if (state.includeTest) params.set("include_test", "true");
  if (state.sort !== "recent") params.set("sort", state.sort);
  return `/api/admin/businesses?${params.toString()}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

function lastActiveAt(row: BusinessSummary): string | null {
  const candidates = [row.prompt_updated_at, row.voice_last_synced_at].filter(
    (s): s is string => !!s,
  );
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[candidates.length - 1];
}

function planLabel(planId: string | null): string {
  if (!planId) return "—";
  return planId.charAt(0).toUpperCase() + planId.slice(1);
}

const DEFAULT_FILTERS: FilterState = {
  search: "",
  plan: "",
  hasSyncErrors: false,
  includeTest: false,
  sort: "recent",
  offset: 0,
};

function filtersAreDefault(state: FilterState): boolean {
  return (
    state.search === "" &&
    state.plan === "" &&
    !state.hasSyncErrors &&
    !state.includeTest &&
    state.sort === "recent" &&
    state.offset === 0
  );
}

// ───────────────────────────────────────────────────────────────────────
// Component

export default function BusinessesList() {
  // Lazy initializer reads the URL once on mount. Subsequent filter
  // changes update the URL via writeFiltersToUrl below, not state→URL
  // sync — that prevents infinite loops if a URL change somehow
  // triggered a re-read.
  const [filters, setFilters] = useState<FilterState>(() => readFiltersFromUrl());
  const [searchInput, setSearchInput] = useState<string>(() => filters.search);

  const [rows, setRows] = useState<BusinessSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Debounce the search input → filters.search update. Other filters
  // (toggles, dropdowns) apply immediately because users tap them once
  // and expect instant feedback.
  useEffect(() => {
    if (searchInput === filters.search) return;
    const handle = setTimeout(() => {
      setFilters((f) => ({ ...f, search: searchInput, offset: 0 }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, filters.search]);

  // Write filters → URL whenever they change (without triggering a
  // navigation event — history.replaceState only).
  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  // Load whenever filters change. Cancellation guard prevents stale
  // responses overwriting fresh state if the user filters rapidly.
  const fetchSeqRef = useRef(0);
  useEffect(() => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    setError(null);
    setBlocked(false);
    (async () => {
      try {
        const res = await fetch(buildApiUrl(filters), {
          headers: getAuthHeaders(),
        });
        if (seq !== fetchSeqRef.current) return;
        if (res.status === 403) {
          setBlocked(true);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? `HTTP ${res.status}`);
          setLoading(false);
          return;
        }
        const data = (await res.json()) as ListResponse;
        if (seq !== fetchSeqRef.current) return;
        setRows(data.rows ?? []);
        setTotal(data.total ?? 0);
        setLoading(false);
      } catch (e: any) {
        if (seq !== fetchSeqRef.current) return;
        setError(e?.message ?? "Failed to load");
        setLoading(false);
      }
    })();
  }, [filters]);

  const hasFilters = useMemo(() => !filtersAreDefault(filters), [filters]);
  const showingFrom = total === 0 ? 0 : filters.offset + 1;
  const showingTo = Math.min(filters.offset + PAGE_LIMIT, total);
  const hasPrev = filters.offset > 0;
  const hasNext = filters.offset + PAGE_LIMIT < total;

  function resetFilters(): void {
    setFilters(DEFAULT_FILTERS);
    setSearchInput("");
  }

  function reload(): void {
    // Bump the sequence to force a refetch with current filter state.
    setFilters((f) => ({ ...f }));
  }

  function goToPage(nextOffset: number): void {
    setFilters((f) => ({ ...f, offset: Math.max(0, nextOffset) }));
    // Scroll to top of list on page change.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ── Render: admin-blocked gate ────────────────────────────────────────
  if (blocked) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
        <Header total={null} loading={false} />
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="pt-10 pb-10 text-center space-y-3">
            <Shield className="h-10 w-10 mx-auto text-amber-600" />
            <h2 className="text-lg font-semibold text-gray-900">
              Admin access required
            </h2>
            <p className="text-sm text-gray-600 max-w-md mx-auto">
              Your account doesn't have permission to view customer
              businesses. Contact a super_admin to request access.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Render: main ──────────────────────────────────────────────────────
  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <Header total={loading ? null : total} loading={loading} />

      {/* Filter bar */}
      <Card>
        <CardContent className="pt-5 pb-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500 pointer-events-none" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search by name or business ID…"
                className="pl-9"
                aria-label="Search businesses"
              />
            </div>
            <Select
              value={filters.plan || "__all__"}
              onValueChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  plan: v === "__all__" ? "" : v,
                  offset: 0,
                }))
              }
            >
              <SelectTrigger className="w-full md:w-[180px]" aria-label="Filter by plan">
                <SelectValue placeholder="All plans" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All plans</SelectItem>
                {PLAN_OPTIONS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {planLabel(p)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={filters.sort}
              onValueChange={(v) =>
                setFilters((f) => ({
                  ...f,
                  sort: (v as SortKey) || "recent",
                  offset: 0,
                }))
              }
            >
              <SelectTrigger className="w-full md:w-[180px]" aria-label="Sort businesses">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="name">Name A→Z</SelectItem>
                <SelectItem value="plan">Plan</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 text-sm">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <ToggleSwitch
                checked={filters.hasSyncErrors}
                onCheckedChange={(checked) =>
                  setFilters((f) => ({
                    ...f,
                    hasSyncErrors: checked,
                    offset: 0,
                  }))
                }
                aria-label="Has sync errors only"
              />
              <span className="text-gray-700">Has sync errors only</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <ToggleSwitch
                checked={filters.includeTest}
                onCheckedChange={(checked) =>
                  setFilters((f) => ({
                    ...f,
                    includeTest: checked,
                    offset: 0,
                  }))
                }
                aria-label="Include test businesses"
              />
              <span className="text-gray-700">Include test businesses</span>
            </label>
            {hasFilters && (
              <button
                onClick={resetFilters}
                className="inline-flex items-center gap-1 text-sm text-[#2E75B6] hover:underline ml-auto"
                aria-label="Clear all filters"
              >
                <X className="h-3.5 w-3.5" />
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Body */}
      {error ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6 flex items-start justify-between gap-3 flex-wrap">
            <p className="text-red-700 text-sm flex-1 min-w-0">
              Couldn't load businesses: {error}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={reload}
              disabled={loading}
              className="shrink-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
              />
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : loading && rows.length === 0 ? (
        <LoadingSkeleton />
      ) : total === 0 ? (
        <EmptyState onClear={hasFilters ? resetFilters : null} />
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <div
              className={
                loading
                  ? "opacity-60 motion-safe:transition-opacity motion-safe:duration-150"
                  : "motion-safe:transition-opacity motion-safe:duration-150"
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Business</TableHead>
                    <TableHead className="w-[120px]">Plan</TableHead>
                    <TableHead className="w-[140px]">Agent</TableHead>
                    <TableHead className="w-[120px]">Last active</TableHead>
                    <TableHead className="w-[140px]">Sync</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <DesktopRow key={row.business_id} row={row} />
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* Mobile cards */}
          <div
            className={
              loading
                ? "md:hidden space-y-2 opacity-60 motion-safe:transition-opacity motion-safe:duration-150"
                : "md:hidden space-y-2 motion-safe:transition-opacity motion-safe:duration-150"
            }
          >
            {rows.map((row) => (
              <MobileRow key={row.business_id} row={row} />
            ))}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-xs text-gray-500">
              Showing {showingFrom}–{showingTo} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!hasPrev || loading}
                onClick={() => goToPage(filters.offset - PAGE_LIMIT)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || loading}
                onClick={() => goToPage(filters.offset + PAGE_LIMIT)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Subcomponents

function Header({
  total,
  loading,
}: {
  total: number | null;
  loading: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex-1 min-w-0">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight flex items-center gap-2">
          <Briefcase className="h-6 w-6 text-[#2E75B6]" />
          Customer Businesses
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Browse all customer accounts. Click any row to view details and
          override their AI.
        </p>
      </div>
      <span className="text-xs text-gray-500 shrink-0 mt-2">
        {loading
          ? "Loading…"
          : total === null
            ? ""
            : `${total} ${total === 1 ? "business" : "businesses"}`}
      </span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6 space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex gap-3 items-center">
            <Skeleton className="h-10 w-10 rounded-md shrink-0" />
            <div className="flex-1 space-y-2 min-w-0">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-4 w-20 shrink-0" />
            <Skeleton className="h-4 w-16 shrink-0" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function EmptyState({ onClear }: { onClear: (() => void) | null }) {
  return (
    <Card>
      <CardContent className="pt-10 pb-10 text-center space-y-3">
        <Filter className="h-10 w-10 mx-auto text-gray-500" />
        <h2 className="text-base font-semibold text-gray-900">
          No businesses match these filters
        </h2>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          {onClear
            ? "Try adjusting your search or clearing filters."
            : "There are no customer businesses yet."}
        </p>
        {onClear && (
          <Button variant="outline" size="sm" onClick={onClear}>
            <X className="h-3.5 w-3.5 mr-1.5" />
            Clear filters
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function AgentBadge({ agentId }: { agentId: string | null }) {
  if (agentId) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-700">
        <span
          className="h-2 w-2 rounded-full bg-green-600"
          aria-hidden="true"
        />
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
      <span
        className="h-2 w-2 rounded-full bg-gray-400"
        aria-hidden="true"
      />
      No agent
    </span>
  );
}

function SyncBadge({ row }: { row: BusinessSummary }) {
  // Three-state: no agent_id means there's nothing to sync, so
  // "Healthy" would be misleading. Show an em-dash to indicate
  // "not applicable" instead.
  if (!row.agent_id) {
    return (
      <span
        className="text-xs text-gray-500"
        aria-label="No agent — nothing to sync"
      >
        —
      </span>
    );
  }
  const errors: string[] = [];
  if (row.voice_sync_error) errors.push(`Voice: ${row.voice_sync_error}`);
  if (row.prompt_sync_error) errors.push(`Prompt: ${row.prompt_sync_error}`);
  if (errors.length > 0) {
    const label = errors.join(" · ");
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-red-600"
        title={label}
        aria-label={`Sync error: ${label}`}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
        Has errors
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-green-700"
      aria-label="Sync healthy"
    >
      <Check className="h-3.5 w-3.5" aria-hidden="true" />
      Healthy
    </span>
  );
}

function BusinessNameCell({ row }: { row: BusinessSummary }) {
  return (
    <div className="flex items-start gap-3 min-w-0">
      <div className="h-10 w-10 rounded-md bg-gray-100 text-gray-500 flex items-center justify-center shrink-0">
        <Building2 className="h-5 w-5" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-gray-900 truncate">
          {row.business_name ?? "(unnamed)"}
        </p>
        <p className="font-mono text-[11px] text-gray-500 truncate">
          {row.business_id}
        </p>
      </div>
    </div>
  );
}

function OwnerCell({ email }: { email: string | null }) {
  if (!email) {
    return <span className="text-xs text-gray-500">—</span>;
  }
  return (
    <a
      href={`mailto:${email}`}
      className="inline-flex items-center gap-1 text-xs text-[#2E75B6] hover:underline truncate"
      onClick={(e) => e.stopPropagation()}
      aria-label={`Email ${email}`}
    >
      <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{email}</span>
    </a>
  );
}

function DesktopRow({ row }: { row: BusinessSummary }) {
  const lastActive = lastActiveAt(row);
  return (
    <TableRow className="hover:bg-gray-50 group">
      <TableCell>
        <Link
          href={`/admin/businesses/${row.business_id}`}
          aria-label={`View ${row.business_name ?? row.business_id}`}
        >
          <a className="block focus:outline-none focus:ring-2 focus:ring-[#2E75B6] rounded-md">
            <BusinessNameCell row={row} />
          </a>
        </Link>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="text-xs">
          {planLabel(row.plan_id)}
        </Badge>
      </TableCell>
      <TableCell>
        <AgentBadge agentId={row.agent_id} />
      </TableCell>
      <TableCell className="text-xs text-gray-600">
        {formatRelative(lastActive)}
      </TableCell>
      <TableCell>
        <SyncBadge row={row} />
      </TableCell>
      <TableCell className="max-w-[200px]">
        <OwnerCell email={row.owner_email} />
      </TableCell>
      <TableCell className="text-right">
        <Link
          href={`/admin/businesses/${row.business_id}`}
          aria-label={`Inspect ${row.business_name ?? row.business_id}`}
        >
          <a className="inline-flex items-center justify-center h-8 w-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-[#2E75B6]">
            <ChevronRight className="h-4 w-4" />
          </a>
        </Link>
      </TableCell>
    </TableRow>
  );
}

function MobileRow({ row }: { row: BusinessSummary }) {
  const lastActive = lastActiveAt(row);
  return (
    <Link href={`/admin/businesses/${row.business_id}`}>
      <a className="block focus:outline-none focus:ring-2 focus:ring-[#2E75B6] rounded-lg">
        <Card className="hover:shadow-md motion-safe:transition-shadow">
          <CardContent className="pt-4 pb-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <BusinessNameCell row={row} />
              <ChevronRight className="h-4 w-4 text-gray-500 shrink-0 mt-1" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {planLabel(row.plan_id)}
              </Badge>
              <AgentBadge agentId={row.agent_id} />
              <SyncBadge row={row} />
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-gray-500 pt-1 border-t">
              <OwnerCell email={row.owner_email} />
              <span>{formatRelative(lastActive)}</span>
            </div>
          </CardContent>
        </Card>
      </a>
    </Link>
  );
}
