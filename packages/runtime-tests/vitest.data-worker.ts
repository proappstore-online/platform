// packages/data-worker/src/index.ts in workerd: a real, empty D1 (the worker
// migrates it on request) and a stub platform API behind the `API` service binding.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { COMPATIBILITY_DATE, INTERNAL_TOKEN, SESSION_SIGNING_KEY } from './config/shared';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineWorkersConfig({
  test: {
    name: 'data-worker',
    include: ['test/data-worker/**/*.test.ts'],
    poolOptions: {
      workers: {
        main: here('../data-worker/src/index.ts'),
        singleWorker: true,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          serviceBindings: { API: 'proappstore-api-stub' },
          bindings: { APP_ID: 'test-app', API_BASE: 'https://api.test', SESSION_SIGNING_KEY, INTERNAL_TOKEN },
          workers: [
            { name: 'proappstore-api-stub', modules: [{ type: 'ESModule' as const, path: here('./stubs/api-stub.js') }], compatibilityDate: COMPATIBILITY_DATE },
          ],
        },
      },
    },
  },
});
