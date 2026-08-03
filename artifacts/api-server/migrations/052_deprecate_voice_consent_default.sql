-- 052_deprecate_voice_consent_default.sql
-- Phase 5.1 — mark business_configs.voice_consent_default DEPRECATED.
--
-- The consent-bypass branch this flag enabled was removed in Phase 5.1
-- (see lib/voice-consent.ts + lib/outbound-voice/compliance.ts). The
-- column stays for history (auditability of past consent policy) but
-- must not be read or extended. FALSE on all 48 production tenants at
-- retirement (verified 2026-08); flipping it TRUE now has no effect
-- because checkVoiceConsent no longer consults it.
--
-- Rationale for removal: a single ops SQL flip converted "no consent
-- evidence" into "call anyone" with no per-phone audit trail — a
-- compliance liability. Tenants that need bulk-import consent express
-- it via per-phone voice_consent_records rows with source='import' and
-- evidence_text pointing at the batch attestation. No tenant-wide
-- bypass. See migration 051 header + lib/voice-consent.ts header.
--
-- Apply via Supabase apply_migration MCP against zqhijauefcpwggklshoa.
-- Verify:
--   SELECT col_description('business_configs'::regclass,
--          (SELECT attnum FROM pg_attribute
--            WHERE attrelid = 'business_configs'::regclass
--              AND attname = 'voice_consent_default'));

BEGIN;

COMMENT ON COLUMN business_configs.voice_consent_default IS
  'DEPRECATED as of Phase 5.1. The consent bypass this flag enabled was removed — consent is now an explicit voice_consent_records row only. FALSE on all tenants at retirement. Column retained for history; do not read, do not extend.';

COMMIT;
