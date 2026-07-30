/// <reference types="vite/client" />

/**
 * Phase 3.3c — build-time constants substituted by Vite's `define`.
 * See vite.config.ts:BUILD_INFO. These are LITERAL strings at build
 * time; a change to either invalidates the whole bundle so the user
 * can compare the deployed value to the expected commit.
 */
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
