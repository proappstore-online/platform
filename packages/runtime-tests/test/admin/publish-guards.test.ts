import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintSession } from '@proappstore/build-core';

const BASE = 'https://admin.test';
const session = (uid: string, login: string) => mintSession({ uid, login, avatarUrl: null, roles: ['user', 'creator'] }, env.SESSION_SIGNING_KEY);
const publish = (body: unknown, token?: string, extra: Record<string, string> = {}) =>
  SELF.fetch(`${BASE}/api/publish-app`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });

async function seedUser(id: string, login: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES (?1, 'github', ?2, ?3, NULL, ?4, ?4)").bind(id, id.replace(/^gh:/, ''), login, Date.now()).run();
}
async function seedApp(id: string, creator: string): Promise<void> {
  const cols = await env.DB.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [id, creator, ...required.map((c) => (/_at$/.test(c) ? Date.now() : `${id}-${c}`))];
  await env.DB.prepare(`INSERT OR IGNORE INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
}

beforeEach(async () => {
  for (const t of ['provision_attempts', 'apps', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('admin: sessions and the publish guards on real D1', () => {
  it('/health, and /v1/auth/me resolves a backend-minted session to its login', async () => {
    expect(await (await SELF.fetch(`${BASE}/health`)).json()).toMatchObject({ ok: true, worker: 'proappstore-admin' });
    const me = await SELF.fetch(`${BASE}/v1/auth/me`, { headers: { Authorization: `Bearer ${await session('gh:1', 'alice')}` } });
    expect(await me.json()).toEqual({ login: 'alice' });
    expect((await SELF.fetch(`${BASE}/v1/auth/me`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/auth/me`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('publish-app: 401 without a session, 400 without an id, 403 for an app id another creator owns (#83)', async () => {
    expect((await publish({ id: 'x' })).status).toBe(401);
    const alice = await session('gh:1', 'alice');
    expect((await publish({}, alice)).status).toBe(400);

    await seedUser('gh:2', 'bob');
    await seedApp('bobs-app', 'gh:2');
    const squat = await publish({ id: 'bobs-app' }, alice);
    expect(squat.status).toBe(403);
    expect(await squat.json()).toEqual({ error: 'appId already claimed by another user' });
    // A claimed app whose creator has no users row fails closed with a distinct message.
    await seedApp('orphan-app', 'gh:999');
    expect(((await (await publish({ id: 'orphan-app' }, alice)).json()) as { error: string }).error).toContain('could not be resolved');
  });

  it('publish-app: the per-caller rate limit counts attempts in provision_attempts and answers 429 with Retry-After', async () => {
    await seedUser('gh:1', 'alice');
    const alice = await session('gh:1', 'alice');
    // Each attempt past the guards would provision for real (GitHub, CF) — the
    // network is closed, so those calls fail inside handlePublish and the route
    // answers 422. The guard itself has already recorded the attempt.
    let status = 0;
    for (let i = 0; i < 11; i++) {
      status = (await publish({ id: `new-app-${i}` }, alice, { 'CF-Connecting-IP': '203.0.113.5' })).status;
      if (status === 429) break;
    }
    expect(status).toBe(429);
    const rows = await env.DB.prepare('SELECT key, count FROM provision_attempts ORDER BY key').all<{ key: string; count: number }>();
    expect(rows.results?.some((r) => r.key.includes('gh:1') && r.count >= 10)).toBe(true);
    const last = await publish({ id: 'new-app-x' }, alice, { 'CF-Connecting-IP': '203.0.113.5' });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('the PROVISION_WORKFLOW binding creates an instance with a CF-generated id (#24) and reports its status', async () => {
    const res = await SELF.fetch(`${BASE}/api/provision-workflow/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN },
      body: JSON.stringify({ id: 'wf-app', name: 'WF App', files: { 'index.html': '<html></html>' } }),
    });
    expect(res.status).toBe(202);
    const { id, status } = (await res.json()) as { id: string; status: { status: string } };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(['queued', 'running', 'errored', 'complete']).toContain(status.status);
    const poll = await SELF.fetch(`${BASE}/api/provision-workflow/status?id=${id}`, { headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });
    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({ id, status: expect.objectContaining({ status: expect.any(String) }) });
    expect((await SELF.fetch(`${BASE}/api/provision-workflow/status?id=${id}`)).status).toBe(403);
  });
});
