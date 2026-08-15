/**
 * Health endpoints — Monday-deploy monitoring (2026-05-03).
 *
 * Surface (mounted under /api by routes/index.ts):
 *   GET /api/livez   — liveness probe: trivial 200, no dependencies.
 *                      Use for "is this process alive?" — k8s liveness
 *                      analog. Restarting on a livez failure is the
 *                      right action for ops.
 *   GET /api/healthz — readiness probe: full dependency check
 *                      (database, supabase, configured-vendor envs).
 *                      Use for uptime monitoring + deploy verification.
 *                      Failing healthz means "don't route traffic here
 *                      yet"; the process is still alive (livez stays
 *                      green).
 *
 * Auth model:
 *   PUBLIC. AUTH_BYPASS_PATTERNS in app.ts whitelists
 *   /^\/api\/(health(z)?|livez)$/, so neither endpoint requires a
 *   key/JWT. The rate-limiter `generalLimiter` does still cover them
 *   (100 req / 15 min / IP) — uptime monitors should poll well within
 *   that, and bypassing the limiter would open a cheap DoS pinhole on
 *   the database/supabase checks.
 *
 * Cache headers:
 *   no-store on both. Monitoring tools must always see fresh state.
 *
 * Dependency-check budget:
 *   Each network/db check is wrapped in a 500ms AbortController/timeout.
 *   With db + supabase running in parallel via Promise.all, the worst-
 *   case healthz response time is ≤ ~600ms (network round-trip + JSON
 *   serialization). Anthropic + ElevenLabs are env-presence-only
 *   checks (intentional: live API calls would charge us per health
 *   poll, and those vendors expose no free probe endpoint).
 *
 * Schema note:
 *   The previous /healthz was parsed through HealthCheckResponse from
 *   @workspace/api-zod (shape: { status: "ok" }). Touching the cross-
 *   package zod schema is out of scope for this change, so we return
 *   the wider shape directly without parsing. If api-zod ever grows
 *   a richer HealthCheck schema, swap the return back through it.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { Pool, type Pool as PgPool, type PoolClient } from "pg";

import { BUILD_COMMIT, BUILD_TIME } from "../lib/build-info";

const router: IRouter = Router();

const BOOT_TIME_MS = Date.now();
const VERSION =
  process.env["npm_package_version"] ||
  process.env["API_SERVER_VERSION"] ||
  "0.0.0";

// Per-check timeout. 500ms is tight enough that a slow upstream can't
// stall an uptime poll past its own threshold (most uptime tools fire
// a 5-10s timeout) yet generous enough that a transient network blip
// doesn't false-flag the deploy as down.
const CHECK_TIMEOUT_MS = 500;

// Lazy module-scoped pool. Sized 1/connection because:
//   (a) /healthz fires SELECT 1 — no concurrency benefit from more
//   (b) we don't want healthz to compete with the rest of the app
//       for the Supabase connection budget.
// idleTimeoutMillis short so an idle pool collapses fast between
// monitoring polls.
let _pool: PgPool | null = null;
function getPool(): PgPool | null {
  if (_pool) return _pool;
  const cs = process.env["DATABASE_URL"];
  if (!cs) return null;
  _pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10_000,
  });
  // Don't crash the process on a transient pool error.
  _pool.on("error", (err) => {
    console.warn("[health] pg pool error:", err.message);
  });
  return _pool;
}

type ServiceState = "ok" | "degraded" | "down";
type ConfigState = "configured" | "missing";

async function checkDatabase(): Promise<ServiceState> {
  const pool = getPool();
  if (!pool) return "down";
  // Take a dedicated client so we can apply a server-side
  // statement_timeout for the SELECT 1. The earlier Promise.race
  // approach only unblocked the JS await — the underlying pg query
  // kept running and, with this pool sized max:1, repeated /healthz
  // polls during a DB hang would queue indefinitely (memory pressure
  // + connection starvation). statement_timeout makes Postgres itself
  // cancel the probe at CHECK_TIMEOUT_MS, releasing the client.
  //
  // SET LOCAL only persists inside an explicit transaction (pg pool
  // clients are autocommit), so we wrap BEGIN..COMMIT around the
  // probe. The transaction is read-only and trivially short.
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${CHECK_TIMEOUT_MS}`);
    await client.query("SELECT 1");
    await client.query("COMMIT");
    return "ok";
  } catch (err) {
    if (client) {
      // Roll back if we opened a transaction. Swallow rollback errors:
      // if BEGIN itself failed, ROLLBACK will too, and we don't want
      // to mask the original failure cause in logs.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    console.warn(
      "[health] db check failed:",
      (err as Error).message?.slice(0, 200),
    );
    return "down";
  } finally {
    if (client) {
      try {
        client.release();
      } catch {
        /* ignore */
      }
    }
  }
}

async function checkSupabase(): Promise<ServiceState> {
  const url = process.env["SUPABASE_URL"];
  if (!url) return "down";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
  try {
    // HEAD on the project root is enough to confirm DNS + TLS + the
    // Supabase edge is responsive. Status code irrelevant — Supabase
    // returns 401/404 on bare URLs depending on shape; what matters
    // is that the request completed before the timeout fired.
    await fetch(url, { method: "HEAD", signal: ctrl.signal });
    return "ok";
  } catch (err) {
    console.warn(
      "[health] supabase check failed:",
      (err as Error).message?.slice(0, 200),
    );
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

function checkEnv(name: string): ConfigState {
  const v = process.env[name];
  return v && v.trim().length > 0 ? "configured" : "missing";
}

router.get("/livez", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    status: "ok",
    uptime_secs: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),
    // Phase 6.7 — fingerprint on livez too so a monitor that only
    // hits /livez can still verify WHICH bundle is running without
    // paying for the healthz dependency probe.
    build_commit: BUILD_COMMIT,
    build_time: BUILD_TIME,
  });
});

router.get("/healthz", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");

  const [database, supabase] = await Promise.all([
    checkDatabase(),
    checkSupabase(),
  ]);
  const anthropic = checkEnv("ANTHROPIC_API_KEY");
  const elevenlabs = checkEnv("ELEVENLABS_API_KEY");

  // "status" rolls up to the worst real-service state. Env-only checks
  // (anthropic, elevenlabs) DON'T degrade overall status — a missing
  // ELEVENLABS_API_KEY just means voice mode is off, not that the
  // deploy is broken. Ops can spot the missing config in `services`.
  const realStates: ServiceState[] = [database, supabase];
  const overall: ServiceState = realStates.includes("down")
    ? "down"
    : realStates.includes("degraded")
      ? "degraded"
      : "ok";

  // 503 when overall isn't ok — uptime monitors typically alert on
  // non-2xx, so this gives them an honest signal without forcing
  // ops to parse the body.
  const httpStatus = overall === "ok" ? 200 : 503;
  res.status(httpStatus).json({
    status: overall,
    version: VERSION,
    uptime_secs: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),
    // Phase 6.7 — deploy fingerprint. build_commit is the git SHA
    // baked at bundle time; build_time is when the bundle was built.
    // uptime_secs proves the process is fresh; these prove WHICH
    // bundle it's running. Dev-mode (tsx) reports "dev" for both.
    build_commit: BUILD_COMMIT,
    build_time: BUILD_TIME,
    services: {
      database,
      supabase,
      anthropic,
      elevenlabs,
    },
  });
});

export default router;
