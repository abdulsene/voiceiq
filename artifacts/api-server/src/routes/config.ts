/**
 * Public runtime config endpoint — 2026-05-03 Calendly env-var swap.
 *
 * Surface (mounted at /api by routes/index.ts):
 *   GET /api/config — returns { discovery_call_url, version }
 *
 * Auth model:
 *   PUBLIC. Listed in app.ts AUTH_BYPASS_PATTERNS as
 *   `/^\/api\/config$/`. The payload contains only
 *   non-sensitive runtime configuration (the discovery-call CTA URL
 *   and the api-server package version) — no tenant data, no secrets.
 *
 * Caching:
 *   In-memory 60s TTL on the JSON payload to keep this on a hot
 *   marketing-page render path cheap. Every request re-reads
 *   process.env via getDiscoveryCallUrl() ONLY when the cache has
 *   expired.
 *
 *   Secret-rotation reality on Replit: changing NEVERR_CALENDLY_URL
 *   in Secrets does NOT propagate into a running api-server
 *   process — the workflow must be restarted (or redeployed) for
 *   process.env to pick up the new value. After restart, /api/config
 *   reflects the new value within at most 60s (the cache TTL after
 *   the first post-restart request that warms the cache).
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getDiscoveryCallUrl } from "../lib/chat-knowledge-base.js";

const router: IRouter = Router();

// Read package.json version once at module-init. Version doesn't change
// at runtime — no need to re-read.
function readVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    // routes/config.ts → ../../package.json
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = readVersion();

// Phase 3.3c — process start-time as a proxy for "when did this deploy
// go live". Restarts on every republish (Replit workflow); stable
// within a running process. Powers the /phone page's "Deployed at:"
// indicator so a user can tell whether the last republish actually
// picked up a new bundle.
const PROCESS_STARTED_AT = new Date().toISOString();

// In-memory cache (60s TTL). Single-process — fine for the api-server,
// which already keeps singletons (pg.Pool, supabase client, anthropic)
// in module scope.
const CACHE_TTL_MS = 60_000;
let _cache: {
  payload: {
    discovery_call_url: string;
    version: string;
    api_started_at: string;
  };
  expires: number;
} | null = null;

function getCachedPayload() {
  const now = Date.now();
  if (_cache && _cache.expires > now) return _cache.payload;
  const payload = {
    discovery_call_url: getDiscoveryCallUrl(),
    version: VERSION,
    api_started_at: PROCESS_STARTED_AT,
  };
  _cache = { payload, expires: now + CACHE_TTL_MS };
  return payload;
}

router.get("/config", (_req: Request, res: Response) => {
  // Set HTTP cache headers too — 60s of public caching at any
  // intermediate proxy is fine; the payload has no per-user data.
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json(getCachedPayload());
});

export default router;
