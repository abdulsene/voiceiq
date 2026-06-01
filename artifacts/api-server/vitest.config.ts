/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for api-server.
 *
 * Test files use the `.test.ts` extension and live under `src/tests/`.
 * The legacy `*-smoke.ts` / sprint-N scripts in the same directory are
 * standalone tsx-invokable scripts (not vitest tests) — they are
 * intentionally excluded from `include`.
 *
 * `src/tests/helpers/` and `src/tests/**\/*.test.ts` are also excluded
 * from the api-server's main `tsc --noEmit` typecheck (see
 * tsconfig.json `exclude`) so the production typecheck stays clean
 * when vitest hasn't been installed yet. Once `pnpm install` lands
 * vitest, `pnpm run test:vitest` will typecheck the tests as part of
 * the run.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // Restore mocks between tests so spies don't leak.
    restoreMocks: true,
    clearMocks: true,
  },
});
