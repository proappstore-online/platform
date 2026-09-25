// packages/backend/src/index.ts in workerd: real D1 (root migrations applied in
// test/backend/setup.ts), R2, the Room Durable Object, the SELF service binding
// and a stub QA worker behind QA_WORKER.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { kCurrentWorker } from 'miniflare';
import { COMPATIBILITY_DATE, INTERNAL_TOKEN, SESSION_SIGNING_KEY } from './config/shared';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineWorkersConfig(async () => ({
  test: {
    name: 'backend',
    include: ['test/backend/**/*.test.ts'],
    setupFiles: ['test/backend/setup.ts'],
    poolOptions: {
      workers: {
        main: here('../backend/src/index.ts'),
        singleWorker: true,
        // The Room DO keeps SQLite-backed storage whose -shm files the pool's
        // per-test storage stacking cannot snapshot; tests reset the tables they
        // touch instead (helpers.resetTables).
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['STORAGE'],
          durableObjects: { ROOM: 'Room' },
          // kCurrentWorker binds SELF to this worker. The cast is type-only: the
          // `miniflare` package here and the one the pool bundles are the same
          // runtime instance but declare distinct `unique symbol` types.
          serviceBindings: { SELF: kCurrentWorker as unknown as string, QA_WORKER: 'proappstore-qa-worker' },
          bindings: {
            APP_BASE: 'https://api.test',
            DATA_WORKER_HOST: 'test.workers.dev',
            ADMIN_GITHUB_IDS: 'gh:admin',
            SESSION_SIGNING_KEY,
            INTERNAL_TOKEN,
            STRIPE_SECRET_KEY: 'sk_test_runtime',
            STRIPE_WEBHOOK_SECRET: 'whsec_runtime',
            CF_API_TOKEN: 'cf-runtime',
            CF_ACCOUNT_ID: 'acct-runtime',
            VAPID_PUBLIC_KEY: 'vapid-public',
            VAPID_PRIVATE_KEY: 'vapid-private',
            // The key vault's KEK (base64 32 bytes) so the BYO key round-trip runs on real WebCrypto + D1 (#3).
            APP_SECRET_KEK: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
            TEST_MIGRATIONS: await readD1Migrations(here('../../migrations')),
          },
          workers: [
            { name: 'proappstore-qa-worker', modules: [{ type: 'ESModule' as const, path: here('./stubs/qa-worker.js') }], compatibilityDate: COMPATIBILITY_DATE },
          ],
        },
      },
    },
  },
}));
