import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #27: at most 10 webhooks per app, enforced by one conditional INSERT on real
// D1, so the boundary and concurrent registrations are exercised for real.
const register = async (appId: string, token: string) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/webhooks`, json('POST', { event: 'storage.uploaded', url: 'https://hooks.example.com/in' }, token));
const hookCount = async (appId: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM app_webhooks WHERE app_id = ?').bind(appId).first<{ n: number }>())!.n;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_webhooks').run();
  await seedUser('gh:1');
  await seedApp('demo', 'gh:1');
  await seedApp('other', 'gh:1');
});

describe('webhooks-per-app cap against real D1', () => {
  it('the 10th registration succeeds, the 11th is 422; other apps are unaffected', async () => {
    const token = await session('gh:1');
    for (let i = 1; i <= 10; i++) expect((await register('demo', token)).status).toBe(200);
    expect(await hookCount('demo')).toBe(10);

    const refused = await register('demo', token);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'webhook_cap_exceeded', limit: 10 });
    expect(await hookCount('demo')).toBe(10);

    expect((await register('other', token)).status).toBe(200);
  });

  it('deleting a webhook frees a slot', async () => {
    const token = await session('gh:1');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(((await (await register('demo', token)).json()) as { id: string }).id);
    expect((await register('demo', token)).status).toBe(422);

    const del = await SELF.fetch(`${BASE}/v1/apps/demo/webhooks/${ids[0]}`, json('DELETE', undefined, token));
    expect(del.status).toBe(200);
    expect((await register('demo', token)).status).toBe(200);
    expect(await hookCount('demo')).toBe(10);
  });

  it('concurrent registrations never exceed the cap', async () => {
    const token = await session('gh:1');
    for (let i = 0; i < 8; i++) expect((await register('demo', token)).status).toBe(200);
    const statuses = (await Promise.all(Array.from({ length: 6 }, () => register('demo', token)))).map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 422)).toHaveLength(4);
    expect(await hookCount('demo')).toBe(10);
  });
});
