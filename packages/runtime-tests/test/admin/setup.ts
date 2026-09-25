import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';

// The shared D1 with the root sequence: users + apps (the ownership guard) and
// provision_attempts (the rate limit) are real tables here.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
fetchMock.activate();
fetchMock.disableNetConnect();
