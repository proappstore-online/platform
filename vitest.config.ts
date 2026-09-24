import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Stub the workerd-only virtual modules so Node tests can import Worker
// entrypoints that re-export a WorkflowEntrypoint subclass. The durable step
// logic is tested directly (not through these); see test/cloudflare-virtual-stub.ts.
const workerdStub = fileURLToPath(new URL('./test/cloudflare-virtual-stub.ts', import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    alias: {
      'cloudflare:workers': workerdStub,
      'cloudflare:workflows': workerdStub,
    },
    // Coverage (#128): `pnpm test:coverage` (CI's check job). V8, over the
    // package sources this suite exercises; generated artifacts, fixtures, test
    // scaffolding and the workerd-only runtime suite are excluded on purpose.
    // Thresholds are a floor against zero-coverage regressions, not a target —
    // raise them as the runtime suite (packages/runtime-tests) grows.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.d.ts',
        'packages/*/src/generated/**',
        'packages/*/src/__fixtures__/**',
        'packages/*/src/__snapshots__/**',
        'packages/*/src/test-helpers.ts',
        'packages/backend/src/openapi-spec.ts',
        'packages/runtime-tests/**',
        'packages/e2e/**',
      ],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        // Baseline on 2026-09-25: lines 66.7 / statements 66.7 / functions 76.0 /
        // branches 78.8 (2939 tests). Floors sit a few points under it so a
        // change that lands untested code fails, while ordinary refactors don't.
        // Per-area floors on the high-risk code: the backend's libraries and
        // routes, and the data worker. The Room DO (packages/backend/src/do) is
        // covered by the runtime suite, not here — visible in the gaps report,
        // no floor. See scripts/coverage-gaps.mjs for where the gaps are.
        lines: 62,
        statements: 62,
        functions: 72,
        branches: 74,
        'packages/backend/src/lib/**': { lines: 90, functions: 95, branches: 85 },
        'packages/backend/src/routes/**': { lines: 68, functions: 80, branches: 72 },
        'packages/data-worker/src/**': { lines: 90, functions: 95, branches: 80 },
        'packages/sdk/src/**': { lines: 45, functions: 55, branches: 80 },
      },
    },
  },
});
