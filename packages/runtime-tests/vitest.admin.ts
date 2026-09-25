// packages/admin/src/index.ts in workerd: real D1 with the root migrations
// (users, apps, provision_attempts — what the publish guards read) and the
// PROVISION_WORKFLOW Workflows binding bound to the worker's own
// ProvisionWorkflow class.
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { COMPATIBILITY_DATE, INTERNAL_TOKEN, SESSION_SIGNING_KEY } from './config/shared';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineWorkersConfig(async () => ({
  test: {
    name: 'admin',
    include: ['test/admin/**/*.test.ts'],
    setupFiles: ['test/admin/setup.ts'],
    poolOptions: {
      workers: {
        main: here('../admin/src/index.ts'),
        singleWorker: true,
        // The pool refuses isolated storage together with Workflows; tests reset
        // the tables they write in beforeEach.
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: COMPATIBILITY_DATE,
          compatibilityFlags: ['nodejs_compat'],
          d1Databases: ['DB'],
          workflows: { PROVISION_WORKFLOW: { name: 'pas-provision', className: 'ProvisionWorkflow' } },
          bindings: {
            CF_ACCOUNT_ID: 'acct-runtime',
            PAS_ZONE_ID: 'zone-runtime',
            PUBLISHERS_ORG: 'proappstore-online',
            APPS_DOMAIN_BASE: 'proappstore.online',
            CF_API_TOKEN: 'cf-runtime',
            GITHUB_TOKEN: 'gh-runtime',
            SESSION_SIGNING_KEY,
            INTERNAL_TOKEN,
            TEST_MIGRATIONS: await readD1Migrations(here('../../migrations')),
          },
        },
      },
    },
  },
}));
