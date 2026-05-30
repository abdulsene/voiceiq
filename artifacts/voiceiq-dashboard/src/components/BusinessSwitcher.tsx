import { useEffect, useMemo, useState, useRef } from "react";
import { ChevronDown, Plus, Check, Briefcase, Search } from "lucide-react";

const API = window.location.origin + "/api";

type BusinessSummary = {
  business_id: string;
  business_name: string;
  industry: string;
  agent_id: string | null;
  role: string;
  is_active: boolean;
};

type Props = {
  onAddBusiness: () => void;
};

const ROLE_BADGE_STYLES: Record<string, string> = {
  owner: "bg-violet-100 text-violet-700",
  admin: "bg-blue-100 text-blue-700",
  manager: "bg-emerald-100 text-emerald-700",
  team_lead: "bg-emerald-100 text-emerald-700",
  agent_manager: "bg-emerald-100 text-emerald-700",
  analyst: "bg-amber-100 text-amber-700",
  user: "bg-slate-100 text-slate-700",
  member: "bg-slate-100 text-slate-700",
  readonly: "bg-slate-100 text-slate-500",
};

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  team_lead: "Team Lead",
  agent_manager: "Agent Manager",
  analyst: "Analyst",
  user: "Member",
  readonly: "Viewer",
};

// Sprint 5 P4 fix: when a customer has many businesses, show the search
// input. Threshold is intentionally low (5) so the affordance appears
// well before the dropdown becomes unwieldy. The Tailwind `max-h-80`
// scroll cap below applies regardless of count.
const SEARCH_VISIBILITY_THRESHOLD = 5;

export default function BusinessSwitcher({ onAddBusiness }: Props) {
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem("neverr_token");

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/user/businesses`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (d.success) {
        setBusinesses(d.businesses || []);
        if (
          d.active_business_id &&
          !localStorage.getItem("neverr_active_business_id")
        ) {
          localStorage.setItem("neverr_active_business_id", d.active_business_id);
        }
      }
    } catch (e) {
      console.warn("BusinessSwitcher load failed:", e);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Sprint 5 P4 fix: Escape to close, auto-focus search on open, clear
  // search on close. Focus is deferred one tick so the input is mounted.
  useEffect(() => {
    if (!open) {
      setSearch("");
      return undefined;
    }
    const focusTimer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const currentBiz = businesses.find((b) => b.is_active) || businesses[0];

  // Sprint 5 P4 fix: case-insensitive substring filter on business_name.
  // Memoized so it doesn't recompute on every keystroke for large lists.
  const filteredBusinesses = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return businesses;
    return businesses.filter((b) =>
      (b.business_name || "").toLowerCase().includes(q),
    );
  }, [businesses, search]);

  function switchTo(businessId: string) {
    if (businessId === currentBiz?.business_id) {
      setOpen(false);
      return;
    }
    localStorage.setItem("neverr_active_business_id", businessId);
    // Hard reload so all components re-fetch under the new active business.
    window.location.reload();
  }

  // Sprint 5 P4 fix: Enter on the search input picks the first filtered
  // match — common power-user pattern (type a few chars + hit Enter).
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && filteredBusinesses.length > 0) {
      e.preventDefault();
      switchTo(filteredBusinesses[0].business_id);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500">
        <div className="animate-spin w-4 h-4 border-2 border-slate-300 border-t-slate-600 rounded-full" />
        Loading...
      </div>
    );
  }

  if (!currentBiz) {
    return (
      <button
        onClick={onAddBusiness}
        className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg"
      >
        <Plus className="w-4 h-4" />
        Add a business
      </button>
    );
  }

  // Single-business case: render as static label, no dropdown affordance.
  if (businesses.length === 1) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-sm">
        <Briefcase className="w-4 h-4 text-slate-400" />
        <span className="font-medium text-slate-900">
          {currentBiz.business_name}
        </span>
        <span
          className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${
            ROLE_BADGE_STYLES[currentBiz.role] || ROLE_BADGE_STYLES.user
          }`}
        >
          {ROLE_LABEL[currentBiz.role] || currentBiz.role}
        </span>
      </div>
    );
  }

  const showSearch = businesses.length >= SEARCH_VISIBILITY_THRESHOLD;
  const isFiltering = search.trim().length > 0;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-100 rounded-lg transition-colors"
      >
        <Briefcase className="w-4 h-4 text-slate-400" />
        <span className="font-medium text-slate-900 max-w-[180px] truncate">
          {currentBiz.business_name}
        </span>
        <span
          className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${
            ROLE_BADGE_STYLES[currentBiz.role] || ROLE_BADGE_STYLES.user
          }`}
        >
          {ROLE_LABEL[currentBiz.role] || currentBiz.role}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-72 max-w-[calc(100vw-1rem)] bg-white rounded-xl shadow-lg border border-slate-200 py-2 z-50"
          role="listbox"
          aria-label="Switch business"
        >
          <div className="px-3 py-1.5 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">
              Switch business
            </span>
            {showSearch && isFiltering && (
              <span className="text-[10px] text-slate-500 tabular-nums">
                {filteredBusinesses.length} of {businesses.length}
              </span>
            )}
          </div>

          {showSearch && (
            <div className="px-2 pb-1.5">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search businesses..."
                  aria-label="Search businesses"
                  className="w-full pl-7 pr-2.5 py-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
                />
              </div>
            </div>
          )}

          {/* Sprint 5 P4 fix: bounded scroll region so 50+ businesses
              don't push the dropdown off-screen. ~5 rows visible at the
              max-h-80 (320px) cap; the rest scroll. */}
          <div className="max-h-80 overflow-y-auto">
            {filteredBusinesses.length === 0 ? (
              <div className="px-3 py-6 text-sm text-slate-500 text-center">
                No businesses match "{search}"
              </div>
            ) : (
              filteredBusinesses.map((biz) => (
                <button
                  key={biz.business_id}
                  onClick={() => switchTo(biz.business_id)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-slate-50 transition-colors"
                >
                  <div className="flex-1 min-w-0 text-left">
                    <div className="font-medium text-slate-900 truncate">
                      {biz.business_name}
                    </div>
                    <div className="text-xs text-slate-500 capitalize">
                      {biz.industry || "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span
                      className={`text-[10px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded ${
                        ROLE_BADGE_STYLES[biz.role] || ROLE_BADGE_STYLES.user
                      }`}
                    >
                      {ROLE_LABEL[biz.role] || biz.role}
                    </span>
                    {biz.is_active && (
                      <Check className="w-4 h-4 text-emerald-600" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="border-t border-slate-100 mt-1 pt-1">
            <button
              onClick={() => {
                setOpen(false);
                onAddBusiness();
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Create new business
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
