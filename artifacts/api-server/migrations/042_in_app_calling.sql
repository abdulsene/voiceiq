-- 042_in_app_calling.sql
-- Phase 3.3 — in-app calling (Twilio Voice WebRTC softphone).
--
-- Staff answer routed calls and place outbound calls from the dashboard
-- instead of (or in addition to) a cell phone. Extends Phase 3.2 routing;
-- does NOT replace it. Simultaneous ring targets browser AND cell together.
--
-- Columns:
--
--   user_businesses.client_identity TEXT
--
--     ⚠️ SUPERSEDED by migration 043 (Phase 3.3a). The per-USER formula
--     `user_ || replace(user_id::text, '-', '')` shipped here was
--     WRONG — Twilio's <Client><Identity>X</Identity></Client> has no
--     tenant scoping, so a user with memberships in two businesses
--     would receive calls for BOTH, with the wrong tenant's topic
--     name in the incoming banner. Cross-tenant UI-level data leak.
--     Migration 043 recomputes every row using a per-MEMBERSHIP
--     formula and restores the UNIQUE constraint we could not add
--     here.
--
--     The reasoning below is preserved for context (it explains WHY
--     we did not add UNIQUE at the time — the original formula
--     genuinely collided). Read this alongside migration 043 and
--     lib/voice/client-identity.ts:buildClientIdentity for the
--     current authoritative behaviour.
--
--     [Original 042 rationale — CORRECTED by 043]:
--     Deterministic Twilio Client identity: 'user_' || replace(user_id, '-', '').
--     Baked at row-creation time; backfilled here for existing rows.
--
--     Not a UNIQUE constraint at the ROW level. Under Phase 3e
--     multi-tenancy (see auth.ts:"a single user can belong to multiple
--     tenants"), a single user_id has multiple user_businesses rows, all
--     of which share the same deterministic identity. UNIQUE would fail
--     the moment two memberships exist for the same user (verified in
--     production at migration time: user_f4dcd0ed... has 2 rows).
--     Uniqueness is enforced CONCEPTUALLY by the deterministic formula
--     — identity(user_a) can never collide with identity(user_b).
--     A regular (non-unique) partial index covers lookup performance.
--
--     The WebRTC device registers under this identity; the outbound TwiML
--     webhook (POST /api/voice/outbound) uses it to resolve the calling
--     business tenant SERVER-SIDE — the whole security model of the
--     feature depends on identity being derived from the JWT, never
--     accepted from the request.
--
--   user_businesses.in_app_calling_enabled BOOLEAN NOT NULL DEFAULT false
--     Per-membership flag. When true, the Phase 3.2 dial-builder emits a
--     <Client> child alongside (or instead of) the <Number> for that
--     staff's cell. Off by default so nothing changes for existing
--     tenants until they explicitly opt in per staff member.
--
--   user_businesses.voice_device_last_seen_at TIMESTAMPTZ
--     Heartbeat updated by POST /api/voice/heartbeat when the browser
--     Device successfully registers (and every ~30s while registered).
--     The routing candidate query treats a staff member with
--     in_app_calling_enabled=true AND no fresh heartbeat AND no
--     callback_ring_number as UNAVAILABLE — otherwise routing would ring
--     a dead <Client> endpoint. Not explicitly listed in the Phase 3.3
--     spec but required to make the "unregistered device as unavailable"
--     requirement actually enforceable server-side.
--
--   calls.answered_via TEXT
--     'browser' | 'pstn' | NULL. Set by handleDialStatus when the Dial
--     leg completes — resolved from the winning `To` field: `client:<id>`
--     → 'browser', E.164 → 'pstn'.
--
--   calls.twilio_call_sid TEXT
--     The real Twilio CallSid. Phase 3.2b passes it via `system__call_sid`
--     in the route_to_topic tool body but never persists it — failed-
--     redirect forensics currently require hand-correlating Sentry
--     entries to the Twilio console. Phase 3.3 writes it in the routing
--     UPSERT so we can query calls.twilio_call_sid directly.
--
--     ⚠️ DO NOT CONFLATE with calls.call_sid. Per the migration 041
--     header, calls.call_sid stores the ElevenLabs CONVERSATION_ID
--     (historical naming quirk). twilio_call_sid is a DISTINCT column
--     that stores the actual Twilio CallSid. Both columns are additive
--     — the schema keeps its historical alias untouched.
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- After apply, verify:
--
--   SELECT column_name, data_type, is_nullable, column_default
--     FROM information_schema.columns
--    WHERE table_name = 'user_businesses'
--      AND column_name IN
--        ('client_identity','in_app_calling_enabled','voice_device_last_seen_at');
--
--   SELECT COUNT(*) AS rows_missing_client_identity
--     FROM user_businesses WHERE client_identity IS NULL;
--   -- expect 0 (backfilled by this migration)
--
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'calls'
--      AND column_name IN ('answered_via','twilio_call_sid');

BEGIN;

-- ── user_businesses columns ─────────────────────────────────────────

ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS client_identity TEXT;

ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS in_app_calling_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE user_businesses
  ADD COLUMN IF NOT EXISTS voice_device_last_seen_at TIMESTAMPTZ;

-- Backfill client_identity for every existing row using the deterministic
-- formula. NULLIF guard = idempotent re-run (skips rows already set).
UPDATE user_businesses
   SET client_identity = 'user_' || replace(user_id::text, '-', '')
 WHERE client_identity IS NULL;

-- Regular partial index for lookup performance. NOT UNIQUE — see the
-- multi-tenancy note in the header. Uniqueness is enforced by the
-- deterministic formula (identity(user_a) != identity(user_b)); at the
-- row level, a user with N memberships has N rows sharing one identity.
CREATE INDEX IF NOT EXISTS idx_user_businesses_client_identity
  ON user_businesses (client_identity)
  WHERE client_identity IS NOT NULL;

COMMENT ON COLUMN user_businesses.client_identity IS
  'Phase 3.3: deterministic Twilio Client identity for the WebRTC softphone. Formula: user_ || replace(user_id::text, -, ). Baked at row-creation, backfilled by migration 042. NOT UNIQUE at the row level — a single user with multiple user_businesses memberships (Phase 3e multi-tenancy) shares the same identity across rows. Uniqueness is enforced conceptually by the deterministic formula: identity(user_a) != identity(user_b). NEVER accept an identity from a client request; always derive from the JWT.';

COMMENT ON COLUMN user_businesses.in_app_calling_enabled IS
  'Phase 3.3: when true, routing engine emits <Client> child alongside/instead of <Number> for this staff. Off by default — no behavior change for existing tenants.';

COMMENT ON COLUMN user_businesses.voice_device_last_seen_at IS
  'Phase 3.3: heartbeat timestamp set on Device register + periodic ping via POST /api/voice/heartbeat. Routing treats in_app_calling_enabled=true AND stale/absent heartbeat AND no callback_ring_number as UNAVAILABLE (would otherwise ring a dead <Client> endpoint).';

-- ── calls columns ───────────────────────────────────────────────────

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS answered_via TEXT;

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS twilio_call_sid TEXT;

CREATE INDEX IF NOT EXISTS idx_calls_twilio_call_sid
  ON calls (twilio_call_sid)
  WHERE twilio_call_sid IS NOT NULL;

COMMENT ON COLUMN calls.answered_via IS
  'Phase 3.3: how the answering leg terminated — "browser" (WebRTC <Client>), "pstn" (cell <Number>), or NULL (call never answered or predates 3.3). Resolved by handleDialStatus from the winning Twilio "To" field: client:<identity> → browser, E.164 → pstn.';

COMMENT ON COLUMN calls.twilio_call_sid IS
  'Phase 3.3: the Twilio CallSid (CA...). DISTINCT from calls.call_sid, which stores the ElevenLabs conversation_id per migration 041''s historical-naming header. Written by the Phase 3.2 routing UPSERT so failed-redirect forensics can query directly without hand-correlating Sentry to the Twilio console.';

COMMIT;
