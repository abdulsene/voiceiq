/**
 * Alex Phase 1 chat routes — Sprint 5.
 *
 * Surface (mounted at /api by routes/index.ts):
 *   POST   /api/chat/conversation              — create a new conversation
 *   POST   /api/chat/conversation/:id/message  — send a user msg, get Alex reply
 *   GET    /api/chat/conversation/:id          — fetch full message history
 *   DELETE /api/chat/conversation/:id          — soft-delete a conversation
 *
 * Auth model:
 *   All four endpoints are PUBLIC (listed in app.ts AUTH_BYPASS_PATTERNS
 *   as /^\/api\/chat\//). Identity is established by an HttpOnly visitor
 *   cookie (`neverr_visitor_id`) minted on the first request and echoed
 *   back via res.cookie() with SameSite=Lax + Secure-in-prod. Ownership
 *   on subsequent requests is enforced by matching the cookie's UUID
 *   against the conversation's visitor_id column. Phase 1 is anonymous-
 *   only; the JWT-authenticated path (user_id) is wired in the schema
 *   (CHECK allows either) but not exercised here — that lands when the
 *   authenticated dashboard widget ships.
 *
 * DB strategy:
 *   This module uses a direct pg.Pool against DATABASE_URL rather than
 *   supabase-js. Reason: when migration 015 created chat_conversations
 *   and chat_messages, Supabase's hosted PostgREST schema cache did
 *   NOT pick up the new tables for an extended window even after
 *   `NOTIFY pgrst, 'reload schema'` and a server restart. Supabase-js
 *   goes through PostgREST and was returning "table not found in
 *   schema cache" errors. Direct pg bypasses PostgREST entirely and
 *   talks to the underlying Postgres connection. The audit middleware
 *   keeps using supabase-js because audit_logs already lives in the
 *   PostgREST cache.
 *
 * Side-effect on import:
 *   Importing this file triggers `lib/anthropic.ts`'s boot-time
 *   ANTHROPIC_API_KEY check — by design.
 */

import {
  Router,
  type IRouter,
  type Request,
  type Response,
} from "express";
import { Pool, type Pool as PgPool } from "pg";
import { randomUUID } from "node:crypto";
import { auditLog, extractRequestMeta } from "../middlewares/audit.js";
import {
  anthropic,
  ALEX_MODEL,
  ALEX_MAX_TOKENS,
  ALEX_TEMPERATURE,
  ALEX_PROMPT_CONTEXT_MAX,
} from "../lib/anthropic.js";
import { buildAlexSystemPrompt } from "../lib/alex-prompt.js";
import {
  ALEX_INITIAL_GREETING,
  ALEX_INDUSTRIES,
  getDiscoveryCallUrl,
} from "../lib/chat-knowledge-base.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Lazy pg.Pool singleton. DATABASE_URL is the canonical Supabase Postgres
// connection string (already populated in this environment — see
// /proc/<api-server-pid>/environ). SSL with rejectUnauthorized=false is
// the standard Supabase dev pattern (their cert chain isn't in the
// default Node.js bundle and we trust the URL itself).
//
// Pool size kept conservative — Phase 1 chat is rare (humans typing) and
// we don't want to compete with the rest of the app for connection slots.
// ---------------------------------------------------------------------------
let _pool: PgPool | null = null;
function getPool(): PgPool | null {
  if (_pool) return _pool;
  const cs = process.env["DATABASE_URL"];
  if (!cs) return null;
  _pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  _pool.on("error", (err) => {
    console.error("[chat] pg pool error:", err.message);
  });
  return _pool;
}

// ---------------------------------------------------------------------------
// Visitor cookie. UUID v4 minted on first request, set HttpOnly + Lax so
// embedded chat from any neverr.ai page works without third-party-cookie
// quirks. 1y maxAge — anonymous chat history persists across sessions
// until the visitor clears cookies. Secure flag in prod only (otherwise
// localhost dev breaks).
// ---------------------------------------------------------------------------
const VISITOR_COOKIE = "neverr_visitor_id";
const VISITOR_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Manual cookie parser to avoid pulling cookie-parser middleware into
// app.ts just for this route (sso.ts deliberately stayed cookie-free
// for the same reason — see the comment block in sso.ts:99).
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function getOrSetVisitorId(req: Request, res: Response): string {
  const existing = parseCookies(req.headers.cookie)[VISITOR_COOKIE];
  if (existing && UUID_RE.test(existing)) return existing;
  const fresh = randomUUID();
  res.cookie(VISITOR_COOKIE, fresh, {
    maxAge: VISITOR_COOKIE_MAX_AGE_MS,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env["NODE_ENV"] === "production",
    path: "/",
  });
  return fresh;
}

// ---------------------------------------------------------------------------
// Lightweight signal extraction. Phase 1 uses keyword heuristics rather
// than tool-calling — cheap, deterministic, easy to debug. Anything
// fancier (entity extraction, classifier) is deferred to Phase 2.
//
//   detectIndustry(): scans text for an exact substring match against
//     any known industryName. Returns the industryCode (machine ID) so
//     downstream consumers can join back to the catalogue.
//
//   detectCtaSignaled(): true when Alex's reply contains a CTA marker
//     (signup URL, demo URL, or one of the canonical CTA phrases).
// ---------------------------------------------------------------------------
function detectIndustry(text: string): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const ind of ALEX_INDUSTRIES) {
    const name = ind.industryName.toLowerCase();
    if (name.length >= 4 && lower.includes(name)) return ind.industryCode;
  }
  return null;
}

// 2026-05-03 KB audit H3 fix: prior regex matched neverr.ai/(signup|demo)
// and "book a demo" — strings Alex never produces under the current
// prompt (paths are now /signup and /contact?topic=enterprise; "book a
// demo" is on the forbidden list). The "free trial"/"get started"
// phrase fallbacks stayed live and were the only thing actually firing
// telemetry. New regex matches the three canonical CTA destinations
// Alex actually emits (/signup, /contact?topic=enterprise,
// enterprise@neverr.ai) plus "discovery call" (used in the SOC 2 +
// warm-CTA example responses), and keeps the two phrase fallbacks.
// Coverage tradeoff: this is BETTER coverage of canonical current Alex
// outputs but NOT regex-level monotonic — the dropped patterns
// (`book a demo`, `neverr.ai/demo`) are forbidden/deprecated, so under
// the current prompt Alex would not produce them; if a future prompt
// regression brought either back the new regex would not match. Locked
// by tests/alex-kb-smoke.ts T8.
function detectCtaSignaled(text: string): boolean {
  if (!text) return false;
  if (/\/signup|\/contact\?topic=enterprise|enterprise@neverr\.ai|free trial|discovery call|get started/i.test(text)) {
    return true;
  }
  // 2026-05-03 Calendly env-var swap: also detect the LIVE discovery
  // URL when NEVERR_CALENDLY_URL is set. The static regex above covers
  // the conversational case (Alex's prose almost always includes
  // "discovery call"), but a URL-only reply (e.g. "Here's the link:
  // https://calendly.com/foo") would not match. This branch is a
  // no-op when env is unset (liveUrl === fallback path, which the
  // regex already matches).
  const liveUrl = getDiscoveryCallUrl();
  if (liveUrl !== "/contact?topic=enterprise" && text.includes(liveUrl)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ownership check — explicit dual-mode branching to avoid the IDOR class
// the architect flagged. The original "if (conv.visitor_id && conv.visitor_id
// !== visitorId)" no-ops when visitor_id is NULL (i.e. a user-owned row),
// which would let any anonymous caller with any cookie read/delete an
// authenticated user's conversation as soon as the Sunday JWT path adds
// user-owned rows.
//
// Phase 1 contract:
//   - All conversations created by these handlers are visitor-owned only.
//   - This helper still defensively handles user-owned rows: in Phase 1 we
//     have no authenticated identity in this route (no JWT verification),
//     so user-owned rows are categorically denied here. When the Sunday
//     widget lands the authenticated path, the `userId` arg becomes a
//     verified Supabase user id and the user-owned branch lights up.
//   - Migration 015's XOR CHECK enforces "exactly one of user_id /
//     visitor_id is set" so the "both populated" branch is impossible at
//     the DB level — denied here as belt-and-suspenders.
// ---------------------------------------------------------------------------
type OwnerRow = { visitor_id: string | null; user_id: string | null };
function checkOwnership(
  conv: OwnerRow,
  visitorId: string,
  userId: string | null,
): "ok" | "forbidden" {
  const hasVisitor = !!conv.visitor_id;
  const hasUser = !!conv.user_id;

  // Ambiguous (both populated) — should be unreachable thanks to the XOR
  // CHECK constraint, but deny defensively if a row ever slips through.
  if (hasVisitor && hasUser) return "forbidden";

  // Visitor-owned: must match the requesting cookie.
  if (hasVisitor) return conv.visitor_id === visitorId ? "ok" : "forbidden";

  // User-owned: requires an authenticated request whose verified user id
  // matches. Phase 1 has no JWT in this route, so userId is always null
  // and this branch always denies.
  if (hasUser) {
    return userId && conv.user_id === userId ? "ok" : "forbidden";
  }

  // Neither populated — impossible per migration 015 CHECK; deny.
  return "forbidden";
}

// ===========================================================================
// POST /chat/conversation
// ===========================================================================
router.post("/chat/conversation", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  const visitorId = getOrSetVisitorId(req, res);
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  try {
    const convResult = await pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO chat_conversations (visitor_id)
       VALUES ($1)
       RETURNING id, created_at`,
      [visitorId],
    );
    const conv = convResult.rows[0];

    // Snapshot the system prompt + write the opening greeting so the full
    // history reads cleanly from row 1.
    const systemPrompt = buildAlexSystemPrompt();
    await pool.query(
      `INSERT INTO chat_messages (conversation_id, role, content, model)
       VALUES ($1, 'system', $2, $3),
              ($1, 'assistant', $4, $3)`,
      [conv.id, systemPrompt, ALEX_MODEL, ALEX_INITIAL_GREETING],
    );

    auditLog({
      action: "chat.conversation.start",
      resource: "chat_conversations",
      resourceId: conv.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: true,
      details: { visitor_id: visitorId },
    });

    return res.json({
      conversation_id: conv.id,
      visitor_id: visitorId,
      initial_message: ALEX_INITIAL_GREETING,
      created_at: conv.created_at,
    });
  } catch (err: any) {
    console.error("[chat] conversation create failed:", err?.message);
    auditLog({
      action: "chat.conversation.start",
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: false,
      details: { visitor_id: visitorId, error: String(err?.message || err).slice(0, 500) },
    });
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

// ===========================================================================
// POST /chat/conversation/:id/message
// ===========================================================================
router.post(
  "/chat/conversation/:id/message",
  async (req: Request, res: Response) => {
    const meta = extractRequestMeta(req);
    const conversationId = req.params.id;
    const { content } = (req.body || {}) as { content?: unknown };

    if (typeof content !== "string" || content.length === 0 || content.length > 4000) {
      return res
        .status(400)
        .json({ error: "content is required (1-4000 chars)" });
    }
    if (!UUID_RE.test(conversationId)) {
      return res.status(400).json({ error: "invalid conversation id" });
    }

    const visitorId = getOrSetVisitorId(req, res);
    const pool = getPool();
    if (!pool) return res.status(503).json({ error: "Database unavailable" });

    try {
      // Load conversation + ownership check (visitor_id match).
      const convResult = await pool.query<{
        id: string;
        visitor_id: string | null;
        user_id: string | null;
        industry: string | null;
        cta_signaled: boolean;
        deleted_at: Date | null;
      }>(
        `SELECT id, visitor_id, user_id, industry, cta_signaled, deleted_at
           FROM chat_conversations
          WHERE id = $1`,
        [conversationId],
      );
      const conv = convResult.rows[0];
      if (!conv || conv.deleted_at) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      // Phase 1: no JWT in chat routes → authenticated userId is always null.
      if (checkOwnership(conv, visitorId, null) !== "ok") {
        return res.status(403).json({ error: "Not your conversation" });
      }

      // Load message history. System row passes through Anthropic's
      // separate `system` parameter; only user/assistant turns go in
      // the messages array. Trim to ALEX_PROMPT_CONTEXT_MAX most recent
      // so long conversations stay token-bounded.
      const histResult = await pool.query<{ role: string; content: string }>(
        `SELECT role, content
           FROM chat_messages
          WHERE conversation_id = $1
          ORDER BY created_at ASC`,
        [conversationId],
      );
      const rows = histResult.rows;
      const systemRow = rows.find((m) => m.role === "system");
      const turns = rows.filter((m) => m.role !== "system");
      const trimmed = turns.slice(-ALEX_PROMPT_CONTEXT_MAX);
      const claudeMessages = [
        ...trimmed.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
        { role: "user" as const, content },
      ];
      const systemPrompt = systemRow?.content || buildAlexSystemPrompt();

      // Persist the user message before we call Anthropic so a partial
      // failure still leaves the user's input on the record.
      await pool.query(
        `INSERT INTO chat_messages (conversation_id, role, content)
         VALUES ($1, 'user', $2)`,
        [conversationId, content],
      );

      let assistantText = "";
      let tokensIn = 0;
      let tokensOut = 0;
      try {
        const resp = await anthropic.messages.create({
          model: ALEX_MODEL,
          max_tokens: ALEX_MAX_TOKENS,
          temperature: ALEX_TEMPERATURE,
          system: systemPrompt,
          messages: claudeMessages,
        });
        tokensIn = resp.usage?.input_tokens ?? 0;
        tokensOut = resp.usage?.output_tokens ?? 0;
        for (const block of resp.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } catch (err: any) {
        console.error("[chat] Anthropic call failed:", err?.status, err?.message);
        auditLog({
          action: "chat.message.sent",
          resource: "chat_messages",
          resourceId: conversationId,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
          success: false,
          details: {
            visitor_id: visitorId,
            status: err?.status,
            error: String(err?.message || err).slice(0, 500),
          },
        });
        return res.status(502).json({ error: "AI provider unavailable, please retry" });
      }

      // Persist assistant reply with token usage.
      const asstResult = await pool.query<{ id: string; created_at: Date }>(
        `INSERT INTO chat_messages
           (conversation_id, role, content, tokens_in, tokens_out, model)
         VALUES ($1, 'assistant', $2, $3, $4, $5)
         RETURNING id, created_at`,
        [conversationId, assistantText, tokensIn, tokensOut, ALEX_MODEL],
      );
      const assistantRow = asstResult.rows[0];

      // Update conversation-level signals (industry latches on first
      // capture; cta_signaled latches true on first occurrence). We
      // always bump updated_at.
      let detectedIndustry: string | null = null;
      if (!conv.industry) {
        detectedIndustry = detectIndustry(content) || detectIndustry(assistantText);
      }
      const detectedCta = !conv.cta_signaled && detectCtaSignaled(assistantText);
      await pool.query(
        `UPDATE chat_conversations
            SET updated_at   = NOW(),
                industry     = COALESCE(industry, $2),
                cta_signaled = cta_signaled OR $3
          WHERE id = $1`,
        [conversationId, detectedIndustry, detectedCta],
      );

      auditLog({
        action: "chat.message.sent",
        resource: "chat_messages",
        resourceId: conversationId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        success: true,
        details: {
          visitor_id: visitorId,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model: ALEX_MODEL,
          industry: detectedIndustry || conv.industry || null,
          cta_signaled: Boolean(detectedCta || conv.cta_signaled),
        },
      });

      return res.json({
        message: {
          id: assistantRow.id,
          role: "assistant",
          content: assistantText,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model: ALEX_MODEL,
          created_at: assistantRow.created_at,
        },
        conversation: {
          id: conversationId,
          industry: detectedIndustry || conv.industry || null,
          cta_signaled: Boolean(detectedCta || conv.cta_signaled),
        },
      });
    } catch (err: any) {
      console.error("[chat] message handler failed:", err?.message);
      return res.status(500).json({ error: "Internal error" });
    }
  },
);

// ===========================================================================
// GET /chat/conversation/:id
// ===========================================================================
router.get("/chat/conversation/:id", async (req: Request, res: Response) => {
  const conversationId = req.params.id;
  if (!UUID_RE.test(conversationId)) {
    return res.status(400).json({ error: "invalid conversation id" });
  }
  const visitorId = getOrSetVisitorId(req, res);
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  try {
    const convResult = await pool.query(
      `SELECT id, visitor_id, user_id, industry, cta_signaled,
              created_at, updated_at, deleted_at
         FROM chat_conversations
        WHERE id = $1`,
      [conversationId],
    );
    const conv = convResult.rows[0];
    if (!conv || conv.deleted_at) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (checkOwnership(conv, visitorId, null) !== "ok") {
      return res.status(403).json({ error: "Not your conversation" });
    }

    const msgResult = await pool.query(
      `SELECT id, role, content, tokens_in, tokens_out, model, created_at
         FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversationId],
    );

    return res.json({
      conversation: {
        id: conv.id,
        industry: conv.industry,
        cta_signaled: conv.cta_signaled,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
      },
      messages: msgResult.rows,
    });
  } catch (err: any) {
    console.error("[chat] get conversation failed:", err?.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

// ===========================================================================
// DELETE /chat/conversation/:id  (soft delete — sets deleted_at)
// ===========================================================================
router.delete("/chat/conversation/:id", async (req: Request, res: Response) => {
  const meta = extractRequestMeta(req);
  const conversationId = req.params.id;
  if (!UUID_RE.test(conversationId)) {
    return res.status(400).json({ error: "invalid conversation id" });
  }
  const visitorId = getOrSetVisitorId(req, res);
  const pool = getPool();
  if (!pool) return res.status(503).json({ error: "Database unavailable" });

  try {
    const convResult = await pool.query(
      `SELECT id, visitor_id, deleted_at
         FROM chat_conversations
        WHERE id = $1`,
      [conversationId],
    );
    const conv = convResult.rows[0];
    if (!conv || conv.deleted_at) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (checkOwnership(conv, visitorId, null) !== "ok") {
      return res.status(403).json({ error: "Not your conversation" });
    }

    const updResult = await pool.query<{ deleted_at: Date }>(
      `UPDATE chat_conversations
          SET deleted_at = NOW()
        WHERE id = $1
        RETURNING deleted_at`,
      [conversationId],
    );

    auditLog({
      action: "chat.conversation.deleted",
      resource: "chat_conversations",
      resourceId: conversationId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      success: true,
      details: { visitor_id: visitorId },
    });

    return res.json({
      success: true,
      deleted_at: updResult.rows[0].deleted_at,
    });
  } catch (err: any) {
    console.error("[chat] delete failed:", err?.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
