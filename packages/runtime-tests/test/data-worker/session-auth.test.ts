import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mintSession } from '@proappstore/build-core';

const bearer = async (uid: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await mintSession({ uid, login: uid, avatarUrl: null, roles: ['user'] }, env.SESSION_SIGNING_KEY)}` },
  body: JSON.stringify({ sql: 'SELECT 1 AS one' }),
});

describe('data worker authorization through the API service binding', () => {
  it('no credentials → 401; a forged session → 401', async () => {
    expect((await SELF.fetch('https://data/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: 'SELECT 1' }) })).status).toBe(401);
    const forged = await mintSession({ uid: 'gh:owner', login: 'owner', avatarUrl: null, roles: ['user'] }, 'some-other-key');
    expect((await SELF.fetch('https://data/query', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${forged}` }, body: JSON.stringify({ sql: 'SELECT 1' }) })).status).toBe(401);
  });

  it('a valid session is authorized against the platform over the service binding: owner runs raw SQL, viewer and outsider fail closed', async () => {
    const owner = await SELF.fetch('https://data/query', await bearer('gh:owner'));
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ rows: [{ one: 1 }] });
    const viewer = await SELF.fetch('https://data/query', await bearer('gh:viewer'));
    expect(viewer.status).toBe(403);
    const outsider = await SELF.fetch('https://data/query', await bearer('gh:stranger'));
    expect(outsider.status).toBe(403);
  });

  it('the internal token bypasses ownership only when it matches', async () => {
    const wrong = await SELF.fetch('https://data/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'nope' }, body: JSON.stringify({ sql: 'SELECT 1 AS one' }) });
    expect(wrong.status).toBe(401);
    const right = await SELF.fetch('https://data/query', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN }, body: JSON.stringify({ sql: 'SELECT 1 AS one' }) });
    expect(right.status).toBe(200);
  });
});
