import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #453 on real D1 and the real migrations: `embed` registers with the tools through the
// public PUT route, is replaced by the next registration and is validated before anything
// is written. (The host side is test/host/embed.test.ts.)

const listMine = {
  name: 'list_mine', description: 'My notes', operation: 'query', requires_auth: true, params: {},
  sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50',
};
const owner = () => session('gh:admin', { roles: ['user', 'admin'] });

async function register(site: Record<string, unknown>): Promise<{ status: number; body: { error?: string } }> {
  fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('PUT', { tools: [listMine], ...site }, await owner()));
  return { status: res.status, body: await res.json() };
}
const stored = async () => (await env.DB.prepare("SELECT origins FROM app_embed WHERE app_id = 'club'").first<{ origins: string }>())?.origins ?? null;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_embed').run();
  await seedUser('gh:admin', 'admin');
  await seedApp('club', 'gh:admin');
});

describe('embed registration (#453)', () => {
  it('stores the normalised list, replaces it on the next registration and clears it when dropped', async () => {
    expect((await register({ embed: { allow: ['https://Example.com', 'https://*.partner.com'] } })).status).toBe(200);
    expect(await stored()).toBe('["https://example.com","https://*.partner.com"]');

    expect((await register({ embed: { allow: ['https://other.example.org'] } })).status).toBe(200);
    expect(await stored()).toBe('["https://other.example.org"]');

    expect((await register({})).status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('refuses an invalid list with 400, writes nothing and keeps the previous list', async () => {
    await register({ embed: { allow: ['https://example.com'] } });
    for (const bad of [
      { allow: ['http://example.com'] },
      { allow: ['https://*.proappstore.online'] },
      { allow: ['https://example.com; frame-ancestors *'] },
      { allow: Array.from({ length: 11 }, (_, i) => `https://s${i}.example.com`) },
    ]) {
      const r = await register({ embed: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.error).toContain('embed');
      expect(await stored()).toBe('["https://example.com"]');
    }
  });
});
