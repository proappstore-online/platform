import { fileURLToPath } from 'node:url';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
import { COMPATIBILITY_DATE, INTERNAL_TOKEN } from './config/shared';

export default defineWorkersConfig({
  test: {
    name: 'kb-host',
    include: ['test/kb-host/**/*.test.ts'],
    poolOptions: {
      workers: {
        main: fileURLToPath(new URL('../kb-host/src/index.ts', import.meta.url)),
        singleWorker: true,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['KB_R2'],
          bindings: { INTERNAL_TOKEN },
        },
      },
    },
  },
});
