import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';

// The root migrations, applied to the real D1 before every test file — the same
// files `wrangler d1 migrations apply pas --remote` runs in deploy-backend.yml.
// A migration that D1 cannot execute fails right here.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// No request leaves workerd: anything the backend fetches must be intercepted.
fetchMock.activate();
fetchMock.disableNetConnect();
