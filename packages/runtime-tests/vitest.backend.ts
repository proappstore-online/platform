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
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
          compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], // parity with backend/wrangler.toml (#310)
          d1Databases: ['DB'],
          r2Buckets: ['STORAGE'],
          durableObjects: { ROOM: 'Room' },
          // #253: the app-worker `loader` backend, on the real Worker Loader. Production
          // has neither the binding nor APP_WORKER_BACKEND yet (app workers stay off).
          workerLoaders: { LOADER: {} },
          // #257: the app-events producer. No consumer is wired: tests record `env.APP_EVENTS.send` and
          // feed the messages to the real consumer by hand, so retry delays and the DLQ are instant
          // (helpers.captureAppEvents / drainAppEvents).
          queueProducers: { APP_EVENTS: { queueName: 'pas-app-events' } },
          ratelimits: {
            PUBLIC_ACTION_RATE_LIMIT: { simple: { limit: 120, period: 60 } },
            AI_RATE_LIMIT: { simple: { limit: 20, period: 60 } },
            MODERATION_RATE_LIMIT: { simple: { limit: 60, period: 60 } },
          },
          // kCurrentWorker binds SELF to this worker. The cast is type-only: the
          // `miniflare` package here and the one the pool bundles are the same
          // runtime instance but declare distinct `unique symbol` types.
          // HOST_API is the host worker's binding to the HostApi entrypoint (#315): the only path on which
          // X-PAS-App / X-PAS-Host are honoured. SELF is the default export, which strips them.
          serviceBindings: {
            SELF: kCurrentWorker as unknown as string,
            HOST_API: { name: kCurrentWorker, entrypoint: 'HostApi' } as unknown as string,
            QA_WORKER: 'proappstore-qa-worker',
            MCP: 'proappstore-mcp-broker-stub',
          },
          // #320: usage pings meter into Analytics Engine and fail closed without both.
          analyticsEngineDatasets: { PAYOUT_METER: { dataset: 'pas_payout_meter_test' } },
          bindings: {
            PAYOUT_METER_SALT: 'runtime-test-payout-salt',
            APP_BASE: 'https://api.test',
            MCP_ORIGIN: 'https://mcp.test',
            DATA_WORKER_HOST: 'test.workers.dev',
            APP_WORKER_BACKEND: 'loader',
            // This workerd predates the platform's app-worker date (2026-01-01).
            APP_WORKER_COMPATIBILITY_DATE: COMPATIBILITY_DATE,
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
            // Lets /email/send and notify-user reach their role checks (#272); Resend itself is fetchMock'd.
            RESEND_API_KEY: 're_runtime',
            TEST_MIGRATIONS: await readD1Migrations(here('../../migrations')),
          },
          workers: [
            { name: 'proappstore-qa-worker', modules: [{ type: 'ESModule' as const, path: here('./stubs/qa-worker.js') }], compatibilityDate: COMPATIBILITY_DATE },
            { name: 'proappstore-mcp-broker-stub', modules: [{ type: 'ESModule' as const, path: here('./stubs/mcp-broker.js') }], compatibilityDate: COMPATIBILITY_DATE, bindings: { INTERNAL_TOKEN } },
          ],
        },
      },
    },
  },
}));
