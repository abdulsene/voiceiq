/**
 * Sprint 3 Stage 5 Session 3 — Audit history viewer for /settings/ai.
 *
 * Chronological timeline of every change to a business's AI: prompt
 * edits (raw + helpers-regen), admin overrides, voice changes, and
 * backfill rows from earlier migrations. Source: GET
 * /api/business/prompt/audit (Session 3 backend).
 *
 * Three views derived from the same audit row:
 *   - Desktop table (md+) with WHEN / CHANGE / DETAILS / BY / SYNC /
 *     Inspect columns.
 *   - Mobile card stack (below md) with the same data restacked.
 *   - Inspect dialog: side-by-side before/after for prompt rows,
 *     voice-name diff for voice_change rows, generic metadata for
 *     backfill / unknown sources.
 *
 * Voice ID → name resolution piggybacks on the existing
 * /api/voices/catalog endpoint (the voice picker already hits it on
 * mount; we refetch instead of plumbing a shared cache to keep this
 * component self-contained — round-trip is ~30ms over the same JWT).
 *
 * Privacy: ip_address is never returned by the customer endpoint, so
 * we never display it. user_agent IS returned but only surfaced
 * inside the diff dialog (not in the row summary) — script-style UAs
 * ("backfill-*.ts") render with a Code icon + monospace; browser UAs
 * pass through a tiny parser that produces "Firefox on Windows" etc.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Eye,
  GitCommit,
  Mic,
  ShieldAlert,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { fetchApi } from "@/lib/api";

// ───────────────────────────────────────────────────────────────────────
// Types

interface AuditRow {
  id: string;
  changed_by_user_id: string | null;
  changed_at: string;
  language: string | null;
  source: string;
  old_prompt: string | null;
  new_prompt: string | null;
  sync_to_elevenlabs_ok: boolean | null;
  elevenlabs_error: string | null;
  user_agent: string | null;
}

interface AuditResponse {
  business_id: string;
  limit: number;
  offset: number;
  total: number;
  rows: AuditRow[];
}

interface CatalogVoice {
  voice_id: string;
  name: string;
  gender: string;
  accent: string;
}

const PAGE_LIMIT = 20;

// ───────────────────────────────────────────────────────────────────────
// Source → presentation mapping

type SourceColor = "blue" | "purple" | "amber" | "gray";

interface SourceMeta {
  label: string;
  color: SourceColor;
  icon: React.ComponentType<{ className?: string }>;
}

function sourceToMeta(source: string): SourceMeta {
  switch (source) {
    case "owner_raw":
      return { label: "Prompt edited", color: "blue", icon: GitCommit };
    case "owner_helpers_regen":
      return { label: "Prompt regenerated", color: "blue", icon: Sparkles };
    case "admin_raw":
      return { label: "Admin override", color: "amber", icon: ShieldAlert };
    case "backfill":
      return { label: "Migration", color: "gray", icon: Wrench };
    case "voice_change":
      return { label: "Voice changed", color: "purple", icon: Mic };
    case "system":
      return { label: "System", color: "gray", icon: Bot };
    default:
      return { label: "Unknown", color: "gray", icon: Bot };
  }
}

const COLOR_CLASSES: Record<SourceColor, string> = {
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  gray: "bg-gray-100 text-gray-700 border-gray-200",
};

// ───────────────────────────────────────────────────────────────────────
// Helpers

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 30) return `${day} days ago`;
  const mo = Math.round(day / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function byColumn(
  changedById: string | null,
  currentUserId: string | null,
): string {
  if (changedById === null) return "System";
  if (currentUserId !== null && changedById === currentUserId) return "You";
  return "Team member";
}

/**
 * Voice-ID resolution. For "voice_change" rows, the voice name comes
 * from the catalog if known, else "Custom voice" for the row summary
 * (no leaking raw IDs to the listing). The diff dialog shows the ID
 * inside parens so power users can still copy it.
 */
function resolveVoiceName(
  voiceId: string | null,
  catalog: Map<string, CatalogVoice>,
): { name: string; isCatalog: boolean; rawId: string | null } {
  if (!voiceId) return { name: "(not set)", isCatalog: false, rawId: null };
  if (voiceId === "NULL") {
    return { name: "(not previously set)", isCatalog: false, rawId: null };
  }
  const match = catalog.get(voiceId);
  if (match) return { name: match.name, isCatalog: true, rawId: voiceId };
  return { name: "Custom voice", isCatalog: false, rawId: voiceId };
}

/**
 * Tiny UA splitter. Distinguishes scripted writes (which set
 * user_agent to a filename like "backfill-prompts.ts" or
 * "manual-via-mcp-...") from real browsers, and labels common
 * browsers as "Chrome on Windows" etc. Anything we don't recognize
 * passes through unchanged.
 */
type UAKind = "script" | "browser" | "unknown";

function parseUserAgent(
  ua: string | null,
): { kind: UAKind; label: string } {
  if (!ua) return { kind: "unknown", label: "Unknown source" };
  // Script-style UAs: anything with a hyphen and ".ts" suffix, or
  // explicit "manual-via-mcp-…" prefix.
  if (/\.ts(\b|$)/.test(ua) || /^manual-via-mcp/.test(ua)) {
    return { kind: "script", label: ua };
  }
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
    ? "Firefox"
    : /Chrome\//.test(ua)
    ? "Chrome"
    : /Safari\//.test(ua)
    ? "Safari"
    : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Macintosh|Mac OS X/.test(ua)
    ? "Mac"
    : /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
    ? "Android"
    : /Linux/.test(ua)
    ? "Linux"
    : null;
  if (browser && os) return { kind: "browser", label: `${browser} on ${os}` };
  if (browser) return { kind: "browser", label: browser };
  return { kind: "unknown", label: ua };
}

/**
 * Per-row summary derived once and reused by the table cell, mobile
 * card, and diff dialog. Centralizes the source-specific branching.
 */
interface RowSummary {
  meta: SourceMeta;
  details: string;
  detailsForDialog: string | null;
  isVoiceChange: boolean;
  isBackfill: boolean;
}

function summarizeRow(
  row: AuditRow,
  voiceCatalog: Map<string, CatalogVoice>,
): RowSummary {
  const meta = sourceToMeta(row.source);
  const isVoiceChange = row.source === "voice_change";
  const isBackfill = row.source === "backfill";

  if (isVoiceChange) {
    const oldV = resolveVoiceName(row.old_prompt, voiceCatalog);
    const newV = resolveVoiceName(row.new_prompt, voiceCatalog);
    return {
      meta,
      details: `Voice: ${oldV.name} → ${newV.name}`,
      detailsForDialog: null,
      isVoiceChange: true,
      isBackfill: false,
    };
  }

  const oldChars = row.old_prompt?.length ?? 0;
  const newChars = row.new_prompt?.length ?? 0;

  switch (row.source) {
    case "owner_raw":
      return {
        meta,
        details: `Raw prompt: ${oldChars.toLocaleString()} → ${newChars.toLocaleString()} chars`,
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: false,
      };
    case "owner_helpers_regen":
      return {
        meta,
        details: `Rebuilt from settings (${newChars.toLocaleString()} chars)`,
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: false,
      };
    case "admin_raw":
      return {
        meta,
        details: `Admin updated prompt (${oldChars.toLocaleString()} → ${newChars.toLocaleString()} chars)`,
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: false,
      };
    case "backfill":
      return {
        meta,
        details: "Automated backfill (system maintenance)",
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: true,
      };
    case "system":
      return {
        meta,
        details: "System update",
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: false,
      };
    default:
      return {
        meta,
        details: `Change type: ${row.source}`,
        detailsForDialog: null,
        isVoiceChange: false,
        isBackfill: false,
      };
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Component

export default function HistoryViewer({
  onSwitchTab,
}: {
  onSwitchTab: (tab: "voice" | "prompt") => void;
}) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [voiceCatalog, setVoiceCatalog] = useState<Map<string, CatalogVoice>>(
    () => new Map(),
  );

  const [selectedRow, setSelectedRow] = useState<AuditRow | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Mount: fetch user + catalog in parallel, then first page of audit.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [meRes, catalogRes] = await Promise.all([
          fetchApi("/auth/me").catch(() => null) as Promise<{
            user?: { id?: string };
          } | null>,
          fetchApi("/voices/catalog").catch(() => null) as Promise<{
            voices?: CatalogVoice[];
          } | null>,
        ]);
        if (cancelled) return;
        setCurrentUserId(meRes?.user?.id ?? null);
        if (catalogRes?.voices) {
          const map = new Map<string, CatalogVoice>();
          for (const v of catalogRes.voices) map.set(v.voice_id, v);
          setVoiceCatalog(map);
        }
      } catch {
        // Non-fatal — table still renders with anonymized "Saved" and
        // raw IDs as voice names.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Page fetch — re-runs whenever offset changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = (await fetchApi(
          `/business/prompt/audit?limit=${PAGE_LIMIT}&offset=${offset}`,
        )) as AuditResponse;
        if (cancelled) return;
        setRows(res.rows ?? []);
        setTotal(res.total ?? 0);
        setLoading(false);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message ?? "Failed to load history");
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offset]);

  const summaries = useMemo(
    () => rows.map((r) => ({ row: r, sum: summarizeRow(r, voiceCatalog) })),
    [rows, voiceCatalog],
  );

  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_LIMIT < total;
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_LIMIT, total);

  // ── Loading ───────────────────────────────────────────────────────────
  if (loading && rows.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Card>
          <CardContent className="pt-6 space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3 items-center">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 flex-1" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (error) {
    return (
      <Card className="border-red-200 bg-red-50">
        <CardContent className="pt-6">
          <p className="text-red-700 text-sm">
            Couldn't load change history: {error}
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Change History</h2>
          <p className="text-sm text-gray-500">
            Every change to your AI's voice and prompt, in order.
          </p>
        </div>
        <Card>
          <CardContent className="pt-8 pb-8 text-center space-y-4">
            <GitCommit className="h-10 w-10 mx-auto text-gray-300" />
            <p className="text-gray-600 max-w-md mx-auto">
              No changes yet. Your AI is using its initial setup. Edit your
              voice or prompt to start a history.
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSwitchTab("voice")}
              >
                <Mic className="h-4 w-4 mr-1.5" />
                Edit Voice
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSwitchTab("prompt")}
              >
                <Sparkles className="h-4 w-4 mr-1.5" />
                Edit Prompt
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Populated ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Change History</h2>
          <p className="text-sm text-gray-500">
            Every change to your AI's voice and prompt, in order.
          </p>
        </div>
        <span className="text-xs text-gray-400 shrink-0">
          {total} total
        </span>
      </div>

      {/* Desktop table */}
      <Card className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[140px]">When</TableHead>
              <TableHead className="w-[180px]">Change</TableHead>
              <TableHead>Details</TableHead>
              <TableHead className="w-[110px]">By</TableHead>
              <TableHead className="w-[80px]">Sync</TableHead>
              <TableHead className="w-[80px] text-right">Inspect</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summaries.map(({ row, sum }) => (
              <TableRow key={row.id} className="hover:bg-gray-50">
                <TableCell className="text-sm text-gray-600">
                  <span title={formatAbsolute(row.changed_at)}>
                    {formatRelative(row.changed_at)}
                  </span>
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${COLOR_CLASSES[sum.meta.color]}`}
                  >
                    <sum.meta.icon className="h-3 w-3" />
                    {sum.meta.label}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-gray-700">
                  {sum.details}
                </TableCell>
                <TableCell className="text-sm">
                  <ByBadge
                    label={byColumn(row.changed_by_user_id, currentUserId)}
                  />
                </TableCell>
                <TableCell>
                  <SyncCell
                    ok={row.sync_to_elevenlabs_ok}
                    err={row.elevenlabs_error}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedRow(row)}
                    aria-label="Inspect change"
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Mobile cards */}
      <div className="md:hidden space-y-2">
        {summaries.map(({ row, sum }) => (
          <Card key={row.id}>
            <CardContent className="pt-4 pb-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${COLOR_CLASSES[sum.meta.color]}`}
                >
                  <sum.meta.icon className="h-3 w-3" />
                  {sum.meta.label}
                </span>
                <span
                  className="text-xs text-gray-500 shrink-0"
                  title={formatAbsolute(row.changed_at)}
                >
                  {formatRelative(row.changed_at)}
                </span>
              </div>
              <p className="text-sm text-gray-700">{sum.details}</p>
              <div className="flex items-center justify-between gap-2 pt-1">
                <div className="flex items-center gap-2 text-xs">
                  <ByBadge
                    label={byColumn(row.changed_by_user_id, currentUserId)}
                  />
                  <SyncCell
                    ok={row.sync_to_elevenlabs_ok}
                    err={row.elevenlabs_error}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedRow(row)}
                  aria-label="Inspect change"
                >
                  <Eye className="h-4 w-4 mr-1.5" />
                  Inspect
                </Button>
              </div>
            </CardContent>
          </Card>
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
            onClick={() => setOffset(Math.max(0, offset - PAGE_LIMIT))}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasNext || loading}
            onClick={() => setOffset(offset + PAGE_LIMIT)}
          >
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>

      {/* Inspect dialog */}
      <InspectDialog
        row={selectedRow}
        voiceCatalog={voiceCatalog}
        currentUserId={currentUserId}
        copiedKey={copiedKey}
        onCopy={async (text, key) => {
          const ok = await copyText(text);
          if (ok) {
            setCopiedKey(key);
            setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
          }
        }}
        onClose={() => setSelectedRow(null)}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Subcomponents

function ByBadge({ label }: { label: string }) {
  const isYou = label === "You";
  return (
    <Badge
      variant="outline"
      className={
        isYou
          ? "bg-blue-50 text-blue-700 border-blue-200 text-xs"
          : "text-xs"
      }
    >
      {label}
    </Badge>
  );
}

function SyncCell({
  ok,
  err,
}: {
  ok: boolean | null;
  err: string | null;
}) {
  if (ok === true) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-green-700"
        title="Successfully applied to your AI"
      >
        <Check className="h-3.5 w-3.5" />
        Live
      </span>
    );
  }
  if (ok === false) {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-red-600"
        title={err ?? "Sync to AI failed"}
      >
        <X className="h-3.5 w-3.5" />
        Failed
      </span>
    );
  }
  return <span className="text-xs text-gray-400">—</span>;
}

function InspectDialog({
  row,
  voiceCatalog,
  currentUserId,
  copiedKey,
  onCopy,
  onClose,
}: {
  row: AuditRow | null;
  voiceCatalog: Map<string, CatalogVoice>;
  currentUserId: string | null;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  onClose: () => void;
}) {
  if (!row) {
    return (
      <Dialog open={false} onOpenChange={onClose}>
        <DialogContent />
      </Dialog>
    );
  }

  const sum = summarizeRow(row, voiceCatalog);
  const ua = parseUserAgent(row.user_agent);
  const by = byColumn(row.changed_by_user_id, currentUserId);

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-xs font-medium ${COLOR_CLASSES[sum.meta.color]}`}
            >
              <sum.meta.icon className="h-3 w-3" />
              {sum.meta.label}
            </span>
            <span className="text-sm font-normal text-gray-500">
              {formatRelative(row.changed_at)}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            <span className="text-gray-500">
              {formatAbsolute(row.changed_at)} · By{" "}
              <span className="font-medium">{by}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        {/* Body — branches on source */}
        <div className="space-y-4 mt-2">
          {sum.isVoiceChange ? (
            <VoiceChangeBody row={row} voiceCatalog={voiceCatalog} />
          ) : sum.isBackfill ? (
            <BackfillBody row={row} />
          ) : (
            <PromptDiffBody
              row={row}
              copiedKey={copiedKey}
              onCopy={onCopy}
            />
          )}

          {/* Sync status block */}
          {row.sync_to_elevenlabs_ok === false && row.elevenlabs_error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              <strong>Sync failed:</strong> {row.elevenlabs_error}
            </div>
          )}

          {/* User-agent / source metadata */}
          <div className="text-xs text-gray-500 border-t pt-3">
            <span className="font-medium">Source:</span>{" "}
            {ua.kind === "script" ? (
              <span className="inline-flex items-center gap-1 font-mono text-gray-700">
                <Code className="h-3 w-3" />
                {ua.label}
              </span>
            ) : (
              <span>{ua.label}</span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoiceChangeBody({
  row,
  voiceCatalog,
}: {
  row: AuditRow;
  voiceCatalog: Map<string, CatalogVoice>;
}) {
  const oldV = resolveVoiceName(row.old_prompt, voiceCatalog);
  const newV = resolveVoiceName(row.new_prompt, voiceCatalog);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-gray-500 mb-1">Before</p>
            <p className="font-semibold">{oldV.name}</p>
            {!oldV.isCatalog && oldV.rawId && (
              <p className="text-xs text-gray-400 font-mono mt-1">
                ({oldV.rawId})
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-gray-500 mb-1">After</p>
            <p className="font-semibold">{newV.name}</p>
            {!newV.isCatalog && newV.rawId && (
              <p className="text-xs text-gray-400 font-mono mt-1">
                ({newV.rawId})
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function BackfillBody({ row }: { row: AuditRow }) {
  return (
    <div className="space-y-2 text-sm text-gray-600">
      <p>
        This row was written by an automated system maintenance script. The
        underlying script name is shown in <em>Source</em> below.
      </p>
      {row.old_prompt && row.new_prompt && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-gray-500 mb-1">old_prompt</p>
              <p className="font-mono text-xs break-all">{row.old_prompt}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <p className="text-xs text-gray-500 mb-1">new_prompt</p>
              <p className="font-mono text-xs break-all">{row.new_prompt}</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function PromptDiffBody({
  row,
  copiedKey,
  onCopy,
}: {
  row: AuditRow;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  const oldKey = `${row.id}:old`;
  const newKey = `${row.id}:new`;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-gray-500">
            Before ({(row.old_prompt?.length ?? 0).toLocaleString()} chars)
          </p>
          {row.old_prompt && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCopy(row.old_prompt!, oldKey)}
              className="h-7 text-xs"
            >
              {copiedKey === oldKey ? (
                <>
                  <Check className="h-3 w-3 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" /> Copy
                </>
              )}
            </Button>
          )}
        </div>
        <pre className="bg-gray-50 border rounded-md p-3 text-xs font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          {row.old_prompt ?? (
            <span className="italic text-gray-400">(no previous content)</span>
          )}
        </pre>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-gray-500">
            After ({(row.new_prompt?.length ?? 0).toLocaleString()} chars)
          </p>
          {row.new_prompt && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onCopy(row.new_prompt!, newKey)}
              className="h-7 text-xs"
            >
              {copiedKey === newKey ? (
                <>
                  <Check className="h-3 w-3 mr-1" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 mr-1" /> Copy
                </>
              )}
            </Button>
          )}
        </div>
        <pre className="bg-gray-50 border rounded-md p-3 text-xs font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          {row.new_prompt ?? (
            <span className="italic text-gray-400">(empty)</span>
          )}
        </pre>
      </div>
    </div>
  );
}
