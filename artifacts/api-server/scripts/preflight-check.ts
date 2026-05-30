/**
 * Monday-morning deploy preflight (2026-05-04).
 *
 * Single-command "is everything ready to ship to neverr.ai?" check.
 * Replaces the manual mental checklist; fails loud (exit 1) if any
 * required item is RED.
 *
 * Run:    pnpm --filter @workspace/api-server run preflight
 * Verbose: PREFLIGHT_VERBOSE=1 pnpm --filter @workspace/api-server run preflight
 *
 * Hard rules baked into this script:
 *   - READ-ONLY everywhere. No DDL, no INSERT/UPDATE/DELETE, no API
 *     calls that cost money. Anthropic / ElevenLabs / Stripe / Twilio
 *     are checked via env-presence only — a real call on every preflight
 *     would charge us per run.
 *   - No new dependencies. Uses what's already in api-server's
 *     package.json (@supabase/supabase-js, pg, built-in fetch).
 *     pg.Client is used for chat_conversations / chat_messages
 *     existence checks against helium PG (DATABASE_URL) — those
 *     tables live there by design (see chat.ts lines 23-24 for
 *     the PostgREST schema-cache reason). All other schema checks
 *     go through supabase-js as before.
 *   - Total runtime budget < 5s. All network I/O has explicit timeouts
 *     and runs in parallel via Promise.allSettled where possible.
 *
 * Exit codes:
 *   0 — every required check is GREEN or YELLOW
 *   1 — at least one RED block (deploy is unsafe; investigate first)
 *
 * Output ordering follows ops priority: ❌ first, then ⚠️, then ✅
 * grouped by section. The summary footer always renders last.
 */

import { createClient } from "@supabase/supabase-js";
import { Client as PgClient } from "pg";

type Status = "ok" | "warn" | "fail";

interface CheckResult {
  section: string;
  label: string;
  status: Status;
  detail?: string;
}

const VERBOSE = process.env["PREFLIGHT_VERBOSE"] === "1";
const PER_CHECK_TIMEOUT_MS = 1500;
const APP_BASE = process.env["PREFLIGHT_APP_BASE"] || "http://localhost:8080";
// Opt-in flag for the one probe that hits a write-touching endpoint
// (POST /api/chat/conversation INSERTs into chat_conversations + audit
// rows). Default OFF to honor the script's read-only contract.
const ALLOW_WRITES = process.env["PREFLIGHT_ALLOW_WRITES"] === "1";

const ICON: Record<Status, string> = {
  ok: "✅",
  warn: "⚠️",
  fail: "❌",
};

const results: CheckResult[] = [];
function record(r: CheckResult): void {
  results.push(r);
}

// ─── helpers ───────────────────────────────────────────────────────────────

function envPresent(name: string): string | null {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Race a promise against a hard timeout. Used for every network probe so
 * a hung upstream can't blow the script's <5s total budget.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${label} >${ms}ms`)), ms),
    ),
  ]);
}

/** Mask a secret for verbose output: keep prefix + last 4 chars + length. */
function mask(secret: string, prefixLen = 7): string {
  if (secret.length <= prefixLen + 4) return `len=${secret.length}`;
  const tail = secret.slice(-4);
  return `${secret.slice(0, prefixLen)}...${tail}, len=${secret.length}`;
}

// ─── SCHEMA + DB ───────────────────────────────────────────────────────────
//
// Strategy: use supabase-js with the service-role key. To check if a
// table or column exists without information_schema (which requires a
// user-defined RPC under PostgREST), we issue a .select(col).limit(0)
// probe and inspect the resulting error code. PostgREST returns:
//   - 200, error:null, data:[]                                 → present
//   - 404, error.code "PGRST205"  ("could not find the table") → table missing
//   - 400, error.code "42703"     ("column ... does not exist")→ column missing
// 42703 is the Postgres SQLSTATE for "undefined_column"; PGRST205 is
// PostgREST's own schema-cache miss code.
//
// IMPORTANT: do NOT pass { head: true } — when head is true, PostgREST
// returns an empty error.message and a 204 even for missing tables, so
// we lose the ability to distinguish present from missing. The
// .limit(0) call is already cheap (zero rows transferred).

async function schemaChecks(): Promise<void> {
  const url = envPresent("SUPABASE_URL");
  const key = envPresent("SUPABASE_SERVICE_KEY");
  if (!url || !key) {
    record({
      section: "SCHEMA + DB",
      label: "Supabase service role can connect",
      status: "fail",
      detail: "SUPABASE_URL or SUPABASE_SERVICE_KEY missing",
    });
    return;
  }

  // Project-id sniff for a friendlier success message.
  let projectId = "unknown";
  try {
    const host = new URL(url).hostname;
    projectId = host.split(".")[0] || host;
  } catch {
    /* ignore — URL validity is checked separately */
  }

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // Connection probe: a HEAD select against any table works, but if
  // business_configs doesn't exist this would also fail. Cleaner: probe
  // pg_catalog.pg_namespace via PostgREST? Not exposed by default.
  // Cheapest reliable probe: .auth.getSession() forces the SDK to
  // exchange the service key with the auth endpoint — proves URL+key.
  try {
    await withTimeout(
      supa.auth.getSession(),
      PER_CHECK_TIMEOUT_MS,
      "supabase auth.getSession",
    );
    record({
      section: "SCHEMA + DB",
      label: "Supabase service role can connect",
      status: "ok",
      detail: `project=${projectId}`,
    });
  } catch (err) {
    record({
      section: "SCHEMA + DB",
      label: "Supabase service role can connect",
      status: "fail",
      detail: (err as Error).message.slice(0, 120),
    });
    return; // No point continuing schema probes if we can't talk to it.
  }

  // Table-existence probes. We check for a column we know SHOULD exist
  // alongside the table, so a column-missing response also signals a
  // table problem we'd want to flag.
  const tableProbes: Array<{
    label: string;
    table: string;
    column: string;
  }> = [
    { label: "business_configs table exists", table: "business_configs", column: "id" },
    { label: "audit_logs exists", table: "audit_logs", column: "id" },
  ];

  // Run table-existence probes IN PARALLEL — sequential probes with a
  // 1.5s per-check timeout could push schemaChecks() to ~7.5s on a
  // partially-degraded Supabase, blowing the script's <5s total budget.
  // Promise.all here keeps worst case at one timeout (~1.5s) for the
  // entire batch.
  const tableResults = await Promise.all(
    tableProbes.map(async (probe) => {
      try {
        const { error } = await withTimeout(
          supa.from(probe.table).select(probe.column).limit(0),
          PER_CHECK_TIMEOUT_MS,
          probe.table,
        );
        if (!error) {
          return { probe, status: "ok" as Status, detail: undefined };
        }
        if (
          error.code === "PGRST205" ||
          error.code === "42P01" ||
          /could not find the table|relation .* does not exist/i.test(
            error.message,
          )
        ) {
          return {
            probe,
            status: "fail" as Status,
            detail: `table ${probe.table} not found`,
          };
        }
        // RLS rejection / permission errors etc. — not a missing-table
        // issue. Treat as warn so ops can investigate but it doesn't
        // block deploy.
        return {
          probe,
          status: "warn" as Status,
          detail: `${error.code || "?"}: ${error.message.slice(0, 80)}`,
        };
      } catch (err) {
        return {
          probe,
          status: "fail" as Status,
          detail: (err as Error).message.slice(0, 120),
        };
      }
    }),
  );
  for (const { probe, status, detail } of tableResults) {
    record({ section: "SCHEMA + DB", label: probe.label, status, detail });
  }

  // Migration 016: business_configs.pii_handling column. Probing the
  // specific column reveals whether the migration has been applied. A
  // 42703 ("column does not exist") response means MIGRATION 016 IS NOT
  // YET RUN — that's the headline RED for Sunday/Monday.
  try {
    const { error } = await withTimeout(
      supa.from("business_configs").select("pii_handling").limit(0),
      PER_CHECK_TIMEOUT_MS,
      "business_configs.pii_handling",
    );
    if (!error) {
      record({
        section: "SCHEMA + DB",
        label: "business_configs.pii_handling column (Migration 016)",
        status: "ok",
      });
    } else if (
      error.code === "42703" ||
      /column .* does not exist|pii_handling/i.test(error.message)
    ) {
      record({
        section: "SCHEMA + DB",
        label: "business_configs.pii_handling column (Migration 016)",
        status: "fail",
        detail: "Migration 016 NOT applied — paste 016_business_configs_pii_handling.sql into Supabase SQL editor before deploy",
      });
    } else {
      record({
        section: "SCHEMA + DB",
        label: "business_configs.pii_handling column (Migration 016)",
        status: "warn",
        detail: `${error.code || "?"}: ${error.message.slice(0, 80)}`,
      });
    }
  } catch (err) {
    record({
      section: "SCHEMA + DB",
      label: "business_configs.pii_handling column (Migration 016)",
      status: "fail",
      detail: (err as Error).message.slice(0, 120),
    });
  }

}

// Helium PG (DATABASE_URL) — hosts chat_conversations + chat_messages.
// chat.ts uses pg.Pool against DATABASE_URL (not supabase-js) because
// PostgREST's schema cache stayed stale after direct DDL (see chat.ts
// lines 23-24). These tables were created by migration 015 and live
// here by design.
async function heliumChatChecks(): Promise<void> {
  const connStr = envPresent("DATABASE_URL");
  if (!connStr) {
    record({
      section: "SCHEMA + DB",
      label: "Helium PG (DATABASE_URL) reachable",
      status: "fail",
      detail: "DATABASE_URL not set — chat tables live here, cannot verify",
    });
    return;
  }

  const client = new PgClient({
    connectionString: connStr,
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
  });

  try {
    await withTimeout(client.connect(), 3000, "helium PG connect");
    record({
      section: "SCHEMA + DB",
      label: "Helium PG (DATABASE_URL) reachable — hosts chat tables",
      status: "ok",
    });

    const chatTables = ["chat_conversations", "chat_messages"] as const;
    for (const table of chatTables) {
      const exists = await client.query(
        `SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      if (exists.rowCount === 0) {
        record({
          section: "SCHEMA + DB",
          label: `${table} exists (Migration 015)`,
          status: "fail",
          detail: `table ${table} not found in helium PG`,
        });
        continue;
      }
      const cnt = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
      const n = cnt.rows[0]?.n ?? 0;
      if (n === 0) {
        record({
          section: "SCHEMA + DB",
          label: `${table} exists (Migration 015)`,
          status: "warn",
          detail: `table exists but is empty (0 rows)`,
        });
      } else {
        record({
          section: "SCHEMA + DB",
          label: `${table} exists (Migration 015)`,
          status: "ok",
          detail: `${n} row(s)`,
        });
      }
    }
  } catch (err) {
    record({
      section: "SCHEMA + DB",
      label: "Helium PG chat-table checks",
      status: "fail",
      detail: `helium PG unreachable: ${(err as Error).message.slice(0, 120)}`,
    });
  } finally {
    await client.end().catch(() => {});
  }
}

// ─── ENV VARS ──────────────────────────────────────────────────────────────

interface EnvSpec {
  name: string;
  required: boolean;
  prefix?: string;
  // exactLen removed — too brittle. Vendors rotate key formats over
  // time (e.g. ElevenLabs introduced 81-char `sk_*` keys alongside the
  // legacy 64-char hex keys). Use minLen instead so a legitimate
  // longer-than-expected key doesn't false-fail the preflight.
  minLen?: number;
  format?: "url" | "jwt";
  note?: string;
}

const ENV_SPECS: EnvSpec[] = [
  { name: "ANTHROPIC_API_KEY", required: true, prefix: "sk-ant-", minLen: 80 },
  { name: "ELEVENLABS_API_KEY", required: true, minLen: 32 },
  { name: "SUPABASE_SERVICE_KEY", required: true, format: "jwt" },
  { name: "SUPABASE_URL", required: true, format: "url" },
  { name: "WORKOS_API_KEY", required: true, minLen: 16 },
  { name: "WORKOS_CLIENT_ID", required: true, prefix: "client_" },
  { name: "STRIPE_SECRET_KEY", required: true, prefix: "sk_" },
  { name: "STRIPE_WEBHOOK_SECRET", required: true, prefix: "whsec_" },
  { name: "TWILIO_ACCOUNT_SID", required: true, prefix: "AC", minLen: 30 },
  { name: "TWILIO_AUTH_TOKEN", required: true, minLen: 20 },
  { name: "TWILIO_PHONE_NUMBER", required: true, prefix: "+", minLen: 8 },
  { name: "NEVERR_CALENDLY_URL", required: false, format: "url", note: "expected unset until Calendly link arrives — falls back to /contact?topic=enterprise" },
  { name: "VITE_CALENDLY_URL", required: false, format: "url", note: "frontend Calendly override; rebuild dashboard after setting" },
  { name: "BASE_URL", required: false, note: "should be unset in dev; production sets this" },
];

function envChecks(): void {
  for (const spec of ENV_SPECS) {
    const val = envPresent(spec.name);
    if (!val) {
      if (spec.required) {
        record({
          section: "ENV VARS",
          label: spec.name,
          status: "fail",
          detail: "missing — required for production",
        });
      } else {
        record({
          section: "ENV VARS",
          label: spec.name,
          status: "warn",
          detail: spec.note || "not set",
        });
      }
      continue;
    }

    // Validation — every failure here is RED for required vars (the
    // value is present but wrong shape, which is worse than missing
    // because it would fail at runtime in a confusing way). For optional
    // vars, shape failures are YELLOW.
    const problems: string[] = [];
    if (spec.prefix && !val.startsWith(spec.prefix)) {
      problems.push(`expected prefix "${spec.prefix}"`);
    }
    if (spec.minLen && val.length < spec.minLen) {
      problems.push(`expected minimum length ${spec.minLen}, got ${val.length}`);
    }
    if (spec.format === "url" && !/^https:\/\//.test(val)) {
      problems.push("expected https:// URL");
    }
    if (spec.format === "jwt" && val.split(".").length !== 3) {
      problems.push("expected JWT (3 dot-separated segments)");
    }

    if (problems.length > 0) {
      record({
        section: "ENV VARS",
        label: spec.name,
        status: spec.required ? "fail" : "warn",
        detail: problems.join("; "),
      });
    } else {
      record({
        section: "ENV VARS",
        label: spec.name,
        status: "ok",
        detail: spec.format === "url" ? val : mask(val),
      });
    }
  }
}

// ─── LIVE API HEALTH (light touch — no charges) ────────────────────────────

async function liveApiChecks(): Promise<void> {
  // Anthropic / ElevenLabs / Stripe — env-presence is the entire check.
  // The env-vars block already validated shape. Re-record the conclusion
  // here so ops sees them in the LIVE-API section too (clearer narrative
  // when scanning the output).
  for (const name of [
    "ANTHROPIC_API_KEY",
    "ELEVENLABS_API_KEY",
    "STRIPE_SECRET_KEY",
  ] as const) {
    record({
      section: "LIVE API HEALTH",
      label: `${name} (env-only — no API call to avoid charges)`,
      status: envPresent(name) ? "ok" : "fail",
    });
  }

  // Supabase HEAD on the project URL — free, instant, proves DNS+TLS+edge.
  const url = envPresent("SUPABASE_URL");
  if (!url) {
    record({
      section: "LIVE API HEALTH",
      label: "Supabase HEAD probe",
      status: "fail",
      detail: "SUPABASE_URL not set",
    });
  } else {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1000);
    try {
      const res = await fetch(url, { method: "HEAD", signal: ctrl.signal });
      // Status code is irrelevant — Supabase returns 401/404 on a bare
      // project URL depending on shape; what matters is the request
      // completed before timeout.
      record({
        section: "LIVE API HEALTH",
        label: "Supabase HEAD probe (DNS+TLS reachable)",
        status: "ok",
        detail: `HTTP ${res.status} (any status = reachable)`,
      });
    } catch (err) {
      record({
        section: "LIVE API HEALTH",
        label: "Supabase HEAD probe (DNS+TLS reachable)",
        status: "fail",
        detail: (err as Error).message.slice(0, 120),
      });
    } finally {
      clearTimeout(t);
    }
  }
}

// ─── APP HEALTH (local dev server, if running) ─────────────────────────────

async function appHealthChecks(): Promise<void> {
  // /api/livez — must be 200 with status:"ok".
  const livez = await probeJson(`${APP_BASE}/api/livez`);
  if (livez.kind === "down") {
    record({
      section: "APP HEALTH",
      label: "/api/livez",
      status: "warn",
      detail: `dev server unreachable at ${APP_BASE} (${livez.detail}) — start it before deploy verification`,
    });
    // No point probing the rest if the server isn't up.
    record({
      section: "APP HEALTH",
      label: "/api/healthz, SSO init, chat conversation smoke",
      status: "warn",
      detail: "skipped — dev server not reachable",
    });
    return;
  }
  if (livez.status === 200 && (livez.body as { status?: string })?.status === "ok") {
    record({ section: "APP HEALTH", label: "/api/livez returned 200 + status:ok", status: "ok" });
  } else {
    record({
      section: "APP HEALTH",
      label: "/api/livez",
      status: "fail",
      detail: `HTTP ${livez.status} body=${JSON.stringify(livez.body).slice(0, 100)}`,
    });
  }

  // /api/healthz — must be 200 with all real services "ok".
  const healthz = await probeJson(`${APP_BASE}/api/healthz`);
  if (healthz.kind === "down") {
    record({
      section: "APP HEALTH",
      label: "/api/healthz",
      status: "fail",
      detail: healthz.detail,
    });
  } else {
    const body = healthz.body as {
      status?: string;
      services?: Record<string, string>;
    };
    const svcs = body.services || {};
    const realDown = (["database", "supabase"] as const).filter(
      (k) => svcs[k] !== "ok",
    );
    if (healthz.status === 200 && body.status === "ok" && realDown.length === 0) {
      record({
        section: "APP HEALTH",
        label: "/api/healthz returned 200, all services ok",
        status: "ok",
        detail: VERBOSE ? JSON.stringify(svcs) : undefined,
      });
    } else {
      record({
        section: "APP HEALTH",
        label: "/api/healthz",
        status: "fail",
        detail: `HTTP ${healthz.status} status=${body.status} downServices=[${realDown.join(",")}]`,
      });
    }
  }

  // /api/sso/init — should be a 302 redirect to WorkOS. We use fetch's
  // redirect:"manual" so the response status is the redirect, not the
  // followed-target status.
  try {
    const res = await withTimeout(
      fetch(
        `${APP_BASE}/api/sso/init?connectionId=conn_01KQJAV4AMQQMW809WYQQK6TN2`,
        { redirect: "manual" },
      ),
      PER_CHECK_TIMEOUT_MS,
      "sso init",
    );
    if (res.status === 302 || res.status === 301 || res.status === 303 || res.status === 307) {
      record({
        section: "APP HEALTH",
        label: "/api/sso/init returns 3xx (WorkOS redirect)",
        status: "ok",
        detail: `HTTP ${res.status}`,
      });
    } else {
      record({
        section: "APP HEALTH",
        label: "/api/sso/init",
        status: "warn",
        detail: `expected 302, got HTTP ${res.status}`,
      });
    }
  } catch (err) {
    record({
      section: "APP HEALTH",
      label: "/api/sso/init",
      status: "warn",
      detail: (err as Error).message.slice(0, 120),
    });
  }

  // /api/chat/conversation — this endpoint is a POST that INSERTs a
  // chat_conversations row + initial assistant message + audit row.
  // Running it on every preflight would litter the database with empty
  // probe conversations, violating the read-only contract. We gate it
  // behind PREFLIGHT_ALLOW_WRITES=1 (off by default) so ops can opt-in
  // to a one-shot smoke when they explicitly want it (e.g. right after
  // a deploy).
  if (!ALLOW_WRITES) {
    record({
      section: "APP HEALTH",
      label: "/api/chat/conversation smoke",
      status: "warn",
      detail:
        "skipped — endpoint INSERTs rows. Set PREFLIGHT_ALLOW_WRITES=1 to opt in",
    });
    return;
  }
  try {
    const res = await withTimeout(
      fetch(`${APP_BASE}/api/chat/conversation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      PER_CHECK_TIMEOUT_MS,
      "chat conversation",
    );
    const body = (await res.json().catch(() => ({}))) as {
      initial_message?: unknown;
      conversation_id?: unknown;
    };
    if (
      res.status === 200 &&
      (typeof body.initial_message === "string" ||
        typeof body.conversation_id === "string")
    ) {
      record({
        section: "APP HEALTH",
        label: "/api/chat/conversation returned 200 + conversation/initial_message",
        status: "ok",
        detail: "PREFLIGHT_ALLOW_WRITES=1 active — created a probe row",
      });
    } else {
      record({
        section: "APP HEALTH",
        label: "/api/chat/conversation",
        status: "warn",
        detail: `HTTP ${res.status} keys=${Object.keys(body).join(",") || "(empty)"}`,
      });
    }
  } catch (err) {
    record({
      section: "APP HEALTH",
      label: "/api/chat/conversation",
      status: "warn",
      detail: (err as Error).message.slice(0, 120),
    });
  }
}

type ProbeResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "down"; detail: string };

async function probeJson(url: string): Promise<ProbeResult> {
  try {
    const res = await withTimeout(fetch(url), PER_CHECK_TIMEOUT_MS, url);
    const body = (await res.json().catch(() => ({}))) as unknown;
    return { kind: "ok", status: res.status, body };
  } catch (err) {
    return { kind: "down", detail: (err as Error).message.slice(0, 120) };
  }
}

// ─── OPERATIONAL ───────────────────────────────────────────────────────────
//
// Time-bounded vendor reminders + paid-API headroom visibility. None of
// these make API calls — strictly local computation against env vars and
// a hard-coded reference date.

function operationalChecks(): void {
  // CookieYes Pro Trial — registered Saturday 2026-05-02, 14-day trial,
  // expires ~2026-05-16. Hard-coded so the reminder fires even if no
  // env var is set; env override (NEVERR_COOKIEYES_TRIAL_EXPIRES, ISO
  // date) lets ops bump the date if the trial gets extended without a
  // code change.
  const override = envPresent("NEVERR_COOKIEYES_TRIAL_EXPIRES");
  const expiresStr = override || "2026-05-16";
  const expires = new Date(`${expiresStr}T23:59:59Z`);
  if (Number.isNaN(expires.getTime())) {
    record({
      section: "OPERATIONAL",
      label: "CookieYes Pro Trial expiry",
      status: "warn",
      detail: `unparseable expiry "${expiresStr}" — expected YYYY-MM-DD`,
    });
  } else {
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / msPerDay);
    if (daysLeft < 0) {
      record({
        section: "OPERATIONAL",
        label: "CookieYes Pro Trial",
        status: "fail",
        detail: `EXPIRED ${Math.abs(daysLeft)} day(s) ago (${expiresStr}) — decide upgrade vs downgrade NOW; consent banner may be in degraded state`,
      });
    } else if (daysLeft < 7) {
      record({
        section: "OPERATIONAL",
        label: "CookieYes Pro Trial",
        status: "warn",
        detail: `expires in ${daysLeft} day(s) (${expiresStr}) — decide upgrade vs downgrade`,
      });
    } else {
      record({
        section: "OPERATIONAL",
        label: "CookieYes Pro Trial",
        status: "ok",
        detail: `${daysLeft} day(s) remaining (${expiresStr})`,
      });
    }
  }

  // Anthropic rate-limit headroom — pure visibility, no probe. We don't
  // call Anthropic (would charge) and we don't tally tokens from
  // audit_logs here (would add a Supabase round-trip + a schema-coupled
  // assumption that audit rows expose token counts in a stable shape;
  // out of scope for a 5s preflight). Leave this as an informational
  // pointer so ops sees it on every run.
  record({
    section: "OPERATIONAL",
    label: "Anthropic rate-limit headroom",
    status: "warn",
    detail:
      "no automated probe (would cost $) — monitor manually via Anthropic console post-deploy",
  });
}

// ─── MANUAL CHECKS ─────────────────────────────────────────────────────────

function manualChecks(): void {
  const items: string[] = [
    "WorkOS Phase 5 SAML browser flow — verify ticket #02893098 status",
    "Cookie consent banner — verify on neverr.ai in incognito browser",
    "ChatWidget voice mode — requires real microphone, validate manually post-deploy",
    "Pre-deploy: ensure migration 016 has been pasted into Supabase SQL editor",
    "Pre-deploy: review .replit secrets cleanup status (7 leaked keys per Saturday's audit)",
  ];
  for (const item of items) {
    record({ section: "MANUAL CHECKS", label: item, status: "warn" });
  }
}

// ─── render ────────────────────────────────────────────────────────────────

const SECTION_ICON: Record<string, string> = {
  "SCHEMA + DB": "📋",
  "ENV VARS": "🔑",
  "LIVE API HEALTH": "📡",
  "APP HEALTH": "💚",
  "OPERATIONAL": "⏱️",
  "MANUAL CHECKS": "📌",
};

function render(): void {
  const now = new Date()
    .toISOString()
    .replace("T", " ")
    .slice(0, 16);
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Neverr.ai — Monday Deploy Preflight         ║");
  console.log(`║  Generated: ${now} UTC                ║`);
  console.log("╚══════════════════════════════════════════════╝");

  const sections = [
    "SCHEMA + DB",
    "ENV VARS",
    "LIVE API HEALTH",
    "APP HEALTH",
    "OPERATIONAL",
    "MANUAL CHECKS",
  ];

  for (const section of sections) {
    const inSection = results.filter((r) => r.section === section);
    if (inSection.length === 0) continue;

    // Priority order within each section: fail → warn → ok.
    const ordered = [
      ...inSection.filter((r) => r.status === "fail"),
      ...inSection.filter((r) => r.status === "warn"),
      ...inSection.filter((r) => r.status === "ok"),
    ];

    console.log("");
    console.log(`${SECTION_ICON[section] || "•"} ${section}`);
    for (const r of ordered) {
      const showDetail = r.detail && (VERBOSE || r.status !== "ok");
      const detailSuffix = showDetail ? ` — ${r.detail}` : "";
      console.log(`  ${ICON[r.status]} ${r.label}${detailSuffix}`);
    }
  }

  const counts = {
    ok: results.filter((r) => r.status === "ok").length,
    warn: results.filter((r) => r.status === "warn").length,
    fail: results.filter((r) => r.status === "fail").length,
  };
  const exitCode = counts.fail > 0 ? 1 : 0;
  console.log("");
  console.log("─────────────────────────────────────");
  console.log(
    `Summary: ${counts.ok} ${ICON.ok}  ${counts.warn} ${ICON.warn}  ${counts.fail} ${ICON.fail}`,
  );
  console.log(
    `Exit: ${exitCode}${counts.fail > 0 ? ` (${counts.fail} RED block${counts.fail === 1 ? "" : "s"} — investigate before deploy)` : " (green-light)"}`,
  );
  console.log("");
  process.exit(exitCode);
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Run independent buckets in parallel. Anything that times out is
  // already capped by withTimeout at the per-check level.
  await Promise.all([schemaChecks(), heliumChatChecks(), liveApiChecks(), appHealthChecks()]);
  // Synchronous buckets — order doesn't matter.
  envChecks();
  operationalChecks();
  manualChecks();
  render();
}

main().catch((err) => {
  console.error("[preflight] fatal error:", err);
  process.exit(1);
});
