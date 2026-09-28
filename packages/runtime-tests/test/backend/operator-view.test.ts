import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, session, resetTables } from './helpers';

// #240: the console operator view is owner-only, on real D1 with the root
// migrations — the baseline queries must run against the real schema, and
// nobody but the app's owner may enter or read it.

beforeEach(async () => {
  await resetTables();
  await env.DB.prepare('DELETE FROM usage_daily').run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedUser('gh:3', 'teammate');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen) VALUES ('stash', 'gh:10', ?1, 60, 5, 0), ('stash', 'gh:11', ?1, 30, 2, 0), ('bingo', 'gh:12', ?1, 999, 999, 0)",
  ).bind(today).run();
  await env.DB.prepare(
    "INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:10', 'member'), ('stash', 'gh:10', 'moderator'), ('bingo', 'gh:12', 'member')",
  ).run();
});

const view = (appId: string, token?: string) => SELF.fetch(`${BASE}/v1/apps/${appId}/operator`, json('GET', undefined, token));

describe('console operator view (#240)', () => {
  it("gives the owner their app's baseline, counting only that app", async () => {
    const res = await view('stash', await session('gh:1'));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      app: { id: 'stash' },
      operator: { userId: 'gh:1' },
      baseline: { usersWithRoles: 1, activity: { days: 30, activeUsers: 2, sessionSeconds: 90, apiCalls: 7 } },
    });
  });

  it('refuses a signed-out caller', async () => {
    const res = await view('stash');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('usersWithRoles');
  });

  it("refuses another app's owner", async () => {
    const res = await view('stash', await session('gh:2'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('usersWithRoles');
  });

  it('refuses a team member below owner, and admits a team owner', async () => {
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:3', 'admin', 0)").run();
    expect((await view('stash', await session('gh:3'))).status).toBe(403);
    await env.DB.prepare("UPDATE team_members SET role = 'owner' WHERE app_id = 'stash' AND user_id = 'gh:3'").run();
    expect((await view('stash', await session('gh:3'))).status).toBe(200);
  });
});
