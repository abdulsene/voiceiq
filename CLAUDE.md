# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package manager

**pnpm is required.** The root `preinstall` script rejects npm/yarn. The repo is a pnpm workspace declared in `pnpm-workspace.yaml`; packages live in `artifacts/*`, `lib/*`, and `scripts`. Shared dependency versions (React 19, Vite 7, Drizzle 0.45, Zod 3.25, Tailwind 4, etc.) come from the `catalog:` block in `pnpm-workspace.yaml` — when adding a dep that already has a catalog entry, write `"foo": "catalog:"` instead of pinning a new version.

`pnpm install` includes a 1440-minute `minimumReleaseAge` (2-day-old packages only) and explicit per-platform optional-dep exclusions to keep installs reproducible across Linux/Windows/Mac.

## Common commands

Root:
- `pnpm run build` — typecheck everything, then run each workspace's `build`.
- `pnpm run typecheck` — `tsc --build` for `lib/*` (project references), then recursive typecheck of `artifacts/*` and `scripts`.
- `pnpm --filter <pkg-name> run <script>` — run a script in one workspace (filter by `name` in that package's `package.json`).

API server (`artifacts/api-server`, name `@workspace/api-server`):
- `pnpm --filter @workspace/api-server run dev` — `tsx src/index.ts` (requires `PORT` env var; hard-fails without it).
- `pnpm --filter @workspace/api-server run build` — esbuild bundle to `dist/index.cjs`. Only the modules in the `allowlist` in `build.ts` are bundled; the rest stay external. Add new entries there when introducing a dep that's bundle-safe but not in the list.
- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/api-server run preflight` — ~34 READ-ONLY production-readiness checks (schema, env vars, vendor reachability, app health). Exit 0 unless RED. Env knobs: `PREFLIGHT_VERBOSE=1`, `PREFLIGHT_APP_BASE`, `PREFLIGHT_ALLOW_WRITES=1` (opt-in to the one write-touching probe).
- Smoke test scripts (each is a single `tsx` invocation, no test framework): `test:dashboard`, `test:pii`, `test:alex-kb`, `test:config-endpoint`, `test:tts-rate-limit`. Additional ad-hoc verifiers in `src/tests/` (e.g. `3e-verify.ts`, `008-bug18-verify.ts`) are run directly via `tsx`.

Dashboard (`artifacts/voiceiq-dashboard`, name `@neverr/dashboard`):
- `pnpm --filter @neverr/dashboard run dev` — Vite dev server. `PORT` is required (`vite.config.ts` throws without it).
- `pnpm --filter @neverr/dashboard run build` — Vite production build to `dist/public/`.
- Replit dev-only Vite plugins (`@replit/vite-plugin-cartographer`, `dev-banner`, `runtime-error-modal`) are gated behind `NODE_ENV !== "production" && REPL_ID !== undefined` — they never ship to prod.

Voice engine (`voiceiq-engine/` at repo root, **NOT** under `artifacts/`, name `neverr-engine`):
- `pnpm --filter neverr-engine run dev` — `node --watch server.js`.
- Plain Node ESM (no TypeScript build). Fastify + WebSockets to ElevenLabs + Twilio. Loads `.env` directly via `dotenv`.

Database (`lib/db`, name `@workspace/db`):
- `pnpm --filter @workspace/db run push` — `drizzle-kit push` (requires `DATABASE_URL`). `push-force` for destructive pushes.
- Schema is empty boilerplate in `src/schema/index.ts`. The active production schema lives in `artifacts/api-server/migrations/*.sql` and is applied manually via the Supabase SQL editor against project `zqhijauefcpwggklshoa`. Drizzle is wired up but not the source of truth — be careful before assuming `db push` reflects production.

API contract (`lib/api-spec`):
- `pnpm --filter @workspace/api-spec run codegen` — runs orval against `openapi.yaml` to regenerate `lib/api-client-react/src/generated` (TanStack Query hooks) and `lib/api-zod/src/generated` (Zod schemas). Both `generated/` dirs are wiped on each run — don't hand-edit them.

## Architecture

This is a pnpm monorepo for **Neverr AI**, an AI receptionist SaaS (voice + chat + CRM + SMS) marketed at SMB / enterprise. There are three independently-deployed services and a shared lib layer.

### Services (three deploys)

1. **`artifacts/api-server`** — Express 5 + TypeScript REST API on port 8080. Single entry `src/index.ts` boots Sentry (gated on `SENTRY_API_DSN`), then `app.ts`, then schedules cron (`scheduleBriefings`, `scheduleRetentionCron`). Routes are composed in `src/routes/index.ts` — `health`, `auth`, `mfa`, `stripe`, `widget`, `enterprise`, `admin` (with `dashboard-builder` + `webhooks` mounted first to win ordering), `industry-categories` (before `industry-pages` for the same reason), `chat`, `chat-tts`, `config`, and the catch-all `api` last. Auth uses Supabase JWTs verified via `middlewares/auth.ts`; certain paths are whitelisted in `AUTH_BYPASS_PATTERNS` inside `app.ts` (e.g. `/api/healthz`, `/api/livez`, `/api/config`, the chat endpoints). Persistent boot-time env checks live inside `src/lib/anthropic.ts`, `src/lib/elevenlabs-tts.ts`, and `src/lib/workos.ts` — importing a route that depends on these crashes the server at boot if the key is missing (intentional fail-fast).

2. **`artifacts/voiceiq-dashboard`** — React 19 + Vite 7 + Wouter SPA built to `dist/public/`. Tailwind v4 is CSS-native via `@import "tailwindcss"` + `@theme inline` in `src/index.css` (no `tailwind.config.js`). shadcn/ui components in `src/components/ui/` (style "new-york", baseColor "neutral" per `components.json`). Path aliases: `@` → `src`, `@assets` → repo-root `attached_assets/`. State via TanStack Query through generated hooks in `@workspace/api-client-react`. i18n via `i18next` (en/es/fr).

3. **`voiceiq-engine/server.js`** — Fastify voice processing server at the repo root (the `artifacts/voiceiq-engine/` directory is a *separate* React frontend bundle, also named `@neverr/engine`; its `dev` script confusingly invokes `node ../../voiceiq-engine/server.js`). The runtime engine handles Twilio webhooks + ElevenLabs WS streaming + Anthropic call summarisation + Supabase persistence. Plain Node ESM, no build step. PII redaction logic in `voiceiq-engine/lib/pii-redact-transcript.js` is mirrored in `artifacts/api-server/src/lib/pii-redact-transcript.ts` — changes must be made in both.

### Shared libs (`lib/*`)

- `lib/db` (`@workspace/db`) — Drizzle ORM tables / Zod insert schemas. Schema currently empty; production schema lives in `artifacts/api-server/migrations/*.sql`.
- `lib/api-spec` — OpenAPI YAML; orval is the codegen front-end.
- `lib/api-client-react` (`@workspace/api-client-react`) — orval-generated TanStack Query hooks. `custom-fetch.ts` is the mutator. Imported by the dashboard.
- `lib/api-zod` (`@workspace/api-zod`) — orval-generated Zod request/response schemas, used server-side and client-side for validation.

These four are TypeScript project references (`tsconfig.json` lists them under `references`), so `pnpm run typecheck:libs` does a `tsc --build` pass across them in dependency order.

### Data + auth

- **Supabase project `zqhijauefcpwggklshoa`** is the system of record for Postgres + auth. Service-role access via `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. The `audit_logs` table lives here, written by `middlewares/audit.ts`.
- `DATABASE_URL` points to a separate "helium PG" instance used for chat (`chat_conversations`, `chat_messages` via raw `pg.Pool`) and for Drizzle. Do not assume Supabase ↔ DATABASE_URL parity — `replit.md` records past confusion where audit log presence was checked against the wrong DB.
- **`business_configs.pii_handling`** column (migration 016) gates per-business PII redaction: `resolveRedactionMode()` checks business config → `PII_REDACTION_MODE` env → `'minimize'` default, with a 60s in-memory cache and graceful fallback on DB error.
- **Migrations** are SQL files in `artifacts/api-server/migrations/` (numeric prefix), applied **manually via the Supabase SQL editor**. After applying, restart the API server workflow.

### Replit deployment

Each artifact owns a `.replit-artifact/artifact.toml` describing dev/prod commands and port mapping. The root `.replit` registers the api-server and mockup-sandbox artifacts and the autoscale deployment target. **Replit secrets do NOT hot-reload** — `process.env` only re-reads at process boot. Restart workflows after changing env vars.

### Calendly / runtime config

The "book a discovery call" CTA URL is config-driven. Server side: `NEVERR_CALENDLY_URL` is exposed via `GET /api/config` (cached 60s, 60s-cached, in `AUTH_BYPASS_PATTERNS`). Frontend has two consumers (`EnterprisePage.tsx`, `ChatWidget.tsx`); both go through `src/lib/cta.ts:getDiscoveryCallUrl()` which prefers `VITE_CALENDLY_URL` (baked into the Vite bundle at build time — requires rebuild + redeploy to change). When neither var is set the destination falls back to `/contact?topic=enterprise`.

## Conventions worth knowing

- **TypeScript strictness:** `strictNullChecks` and `noImplicitAny` are on, but `strictFunctionTypes` and `noUnusedLocals` are off. `useUnknownInCatchVariables` is enabled — catch blocks see `unknown`, not `any`.
- **Route ordering matters.** Several mounts in `routes/index.ts` are intentionally before the catch-all `apiRouter` to win specificity. Preserve this when adding new routers — see the comments inline.
- **Boot-time env checks are intentional.** Some `src/lib/*` modules throw on import if their env var is missing. This is deliberate fail-fast behaviour for production safety.
- **Cross-service code duplication is intentional in one place:** `pii-redact-transcript` exists in both the TS API server and the JS voice engine. Keep them in sync.
- **`replit.md`** at the repo root is a running log of architectural decisions, sprint notes, and known tech-debt items. Skim it before making non-trivial changes — it captures context (e.g. "audit_logs is in Supabase not helium PG", "Migration 008 not yet applied", Calendly env-var swap mechanics) that isn't visible from code alone.
