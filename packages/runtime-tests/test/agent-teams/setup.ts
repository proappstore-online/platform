import { applyD1Migrations, env, fetchMock } from 'cloudflare:test';

// The shared platform D1, migrated with the root sequence: agent_projects (the
// owner's project index) and team_members (the role the router forwards).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
fetchMock.activate();
fetchMock.disableNetConnect();
