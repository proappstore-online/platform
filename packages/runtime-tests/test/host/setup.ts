import { applyD1Migrations, env } from 'cloudflare:test';

// The shared D1 carries both sequences the host reads: the root one
// (app_listings, app_custom_domains) and the host's own `routes` table.
// Outbound fetch() goes to the `outbound-echo` worker (vitest.host.ts), never
// to the network.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB, env.TEST_HOST_MIGRATIONS);
