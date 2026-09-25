// packages/host/src/index.ts in workerd: R2 (published app files), real D1 with
// the root migrations AND the host's own `routes` migration, and the five
// service bindings as echo workers so dispatch can be asserted per binding.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { COMPATIBILITY_DATE } from './config/shared';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const echo = (name: string) => ({
  name,
  modules: [{ type: 'ESModule' as const, path: here('./stubs/echo-stub.js') }],
  compatibilityDate: COMPATIBILITY_DATE,
  bindings: { STUB_NAME: name },
});

export default defineWorkersConfig(async () => ({
  test: {
    name: 'host',
    include: ['test/host/**/*.test.ts'],
    setupFiles: ['test/host/setup.ts'],
    poolOptions: {
      workers: {
        main: here('../host/src/index.ts'),
        singleWorker: true,
        // The host tees every served body into the edge cache inside waitUntil;
        // the pool's isolated-storage teardown waits for those, which deadlocks
        // when a test leaves a body unread. Tests reset D1 + R2 themselves.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['APPS'],
          serviceBindings: { API: 'api-echo', ADMIN: 'admin-echo', AGENTS: 'agents-echo', MCP: 'mcp-echo', KB: 'kb-echo' },
          // Everything the host fetch()es (the data-* proxy, the Pages proxies)
          // lands on an echo worker instead of the network, so a test can assert
          // the exact upstream URL the host built.
          outboundService: 'outbound-echo',
          bindings: {
            DATA_WORKER_HOST: 'test.workers.dev',
            TEST_MIGRATIONS: await readD1Migrations(here('../../migrations')),
            TEST_HOST_MIGRATIONS: await readD1Migrations(here('../host/migrations')),
          },
          workers: [echo('api-echo'), echo('admin-echo'), echo('agents-echo'), echo('mcp-echo'), echo('kb-echo'), echo('outbound-echo')],
        },
      },
    },
  },
}));
