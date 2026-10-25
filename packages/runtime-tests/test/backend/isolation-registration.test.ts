import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #452 on real D1 and the real migrations: `isolation` registers with the tools through the public
// PUT route, is replaced by the next registration and is validated before anything is written.

const listMine = {
  name: 'list_mine', description: 'My notes', operation: 'query', requires_auth: true, params: {},
  sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50',
};

async function register(site: Record<string, unknown>): Promise<{ status: number; body: { error?: string } }> {
  fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('PUT', { tools: [listMine], ...site }, await session('gh:admin', { roles: ['user', 'admin'] })));
  return { status: res.status, body: await res.json() };
}
const stored = async () => (await env.DB.prepare("SELECT mode FROM app_isolation WHERE app_id = 'club'").first<{ mode: string }>())?.mode ?? null;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_isolation').run();
  await seedUser('gh:admin', 'admin');
  await seedApp('club', 'gh:admin');
});

describe('isolation registration (#452)', () => {
  it('stores the mode, replaces it on the next registration and clears it when dropped', async () => {
    expect((await register({ isolation: 'cross-origin' })).status).toBe(200);
    expect(await stored()).toBe('cross-origin');
    expect((await register({ isolation: 'cross-origin-strict' })).status).toBe(200);
    expect(await stored()).toBe('cross-origin-strict');
    expect((await register({})).status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('refuses an unknown mode with 400, writes nothing and keeps the previous mode', async () => {
    await register({ isolation: 'cross-origin' });
    for (const bad of ['same-origin', true, { mode: 'cross-origin' }]) {
      const r = await register({ isolation: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error).toContain('isolation must be');
      expect(await stored()).toBe('cross-origin');
    }
  });

  it('the table itself refuses a mode outside the two', async () => {
    await expect(env.DB.prepare("INSERT INTO app_isolation (app_id, mode, created_at) VALUES ('x', 'unsafe-none', 1)").run()).rejects.toThrow();
  });
});
