// packages/agent-teams/src/index.ts in workerd: the ProjectDO (SQLite-backed),
// real D1 with the root migrations (agent_projects, team_members), R2, and the
// three service bindings — ADMIN answers the repo-pull handshake, PAS_BACKEND
// and KB echo what reached them.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { COMPATIBILITY_DATE, INTERNAL_TOKEN, SESSION_SIGNING_KEY } from './config/shared';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const echo = (name: string) => ({
  name,
  modules: [{ type: 'ESModule' as const, path: here('./stubs/echo-stub.js') }],
  compatibilityDate: COMPATIBILITY_DATE,
  bindings: { STUB_NAME: name },
});

export default defineWorkersConfig(async () => ({
  test: {
    name: 'agent-teams',
    include: ['test/agent-teams/**/*.test.ts'],
    setupFiles: ['test/agent-teams/setup.ts'],
    poolOptions: {
      workers: {
        main: here('../agent-teams/src/index.ts'),
        singleWorker: true,
        // ProjectDO is a SQLite-backed DO; the pool cannot snapshot its -shm files.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          r2Buckets: ['AGENT_STORAGE'],
          durableObjects: { PROJECT: { className: 'ProjectDO', useSQLite: true } },
          serviceBindings: { ADMIN: 'proappstore-admin-stub', PAS_BACKEND: 'proappstore-api-echo', KB: 'proappstore-kb-echo' },
          bindings: {
            PAS_API_BASE: 'https://api.test',
            SESSION_SIGNING_KEY,
            INTERNAL_TOKEN,
            TEST_MIGRATIONS: await readD1Migrations(here('../../migrations')),
          },
          workers: [
            { name: 'proappstore-admin-stub', modules: [{ type: 'ESModule' as const, path: here('./stubs/admin-stub.js') }], compatibilityDate: COMPATIBILITY_DATE },
            echo('proappstore-api-echo'),
            echo('proappstore-kb-echo'),
          ],
        },
      },
    },
  },
}));
