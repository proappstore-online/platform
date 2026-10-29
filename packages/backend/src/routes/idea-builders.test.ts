import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { CLAIM_ACTIVE_S, MAX_ACTIVE_CLAIMS } from './idea-builders.js';

const ALICE = await testToken('gh:1');
const BOB = await testToken('gh:2');

let db: ReturnType<typeof sqliteD1>;
let env: ReturnType<typeof makeEnv>;

beforeEach(() => {
  db = sqliteD1();
  env = makeEnv({ DB: db });
});

const nowS = () => Math.floor(Date.now() / 1000);

function call(method: string, path: string, token?: string) {
  return app.request(path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }, env);
}
const claim = (idea: string, token?: string) => call('POST', `/v1/store/ideas/${idea}/builder`, token);
const unclaim = (idea: string, token?: string) => call('DELETE', `/v1/store/ideas/${idea}/builder`, token);
const seed = (idea: string, user: string, createdAt: number) =>
  db.sql.prepare('INSERT INTO idea_builders (idea_id, user_id, created_at) VALUES (?, ?, ?)').run(idea, user, createdAt);

describe('GET /v1/store/idea-builders', () => {
  it('is public and cacheable, with an empty map when nobody is building', async () => {
    const res = await call('GET', '/v1/store/idea-builders');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({ builders: {} });
  });

  it('counts only claims from the last 90 days', async () => {
    seed('recipe-box', 'gh:1', nowS() - 10);
    seed('recipe-box', 'gh:2', nowS() - CLAIM_ACTIVE_S - 10);
    seed('habit-tracker', 'gh:3', nowS() - CLAIM_ACTIVE_S - 10);
    const res = await call('GET', '/v1/store/idea-builders');
    expect(await res.json()).toEqual({ builders: { 'recipe-box': 1 } });
  });

  it("adds the caller's own active claims, privately, when authenticated", async () => {
    seed('recipe-box', 'gh:1', nowS() - 10);
    seed('habit-tracker', 'gh:1', nowS() - CLAIM_ACTIVE_S - 10);
    seed('habit-tracker', 'gh:2', nowS() - 10);
    const res = await call('GET', '/v1/store/idea-builders', ALICE);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toContain('Authorization');
    expect(await res.json()).toEqual({
      builders: { 'recipe-box': 1, 'habit-tracker': 1 },
      mine: { 'recipe-box': true },
    });
  });

  it('refuses a bad token rather than answering as anonymous', async () => {
    const res = await call('GET', '/v1/store/idea-builders', 'not-a-token');
    expect(res.status).toBe(401);
  });
});

describe('POST/DELETE /v1/store/ideas/:ideaId/builder', () => {
  it('requires auth', async () => {
    expect((await claim('recipe-box')).status).toBe(401);
    expect((await unclaim('recipe-box')).status).toBe(401);
  });

  it('rejects a malformed idea id', async () => {
    for (const bad of ['Recipe', '-recipe', 'a_b', 'x'.repeat(65)]) {
      expect((await claim(bad, ALICE)).status).toBe(400);
      expect((await unclaim(bad, ALICE)).status).toBe(400);
    }
    expect((await claim('x'.repeat(64), ALICE)).status).toBe(200);
  });

  it('claims idempotently and counts every builder', async () => {
    expect(await (await claim('recipe-box', ALICE)).json()).toEqual({ building: true, count: 1 });
    expect(await (await claim('recipe-box', ALICE)).json()).toEqual({ building: true, count: 1 });
    expect(await (await claim('recipe-box', BOB)).json()).toEqual({ building: true, count: 2 });
  });

  it('re-claiming refreshes a stale claim', async () => {
    seed('recipe-box', 'gh:1', nowS() - CLAIM_ACTIVE_S - 10);
    expect(await (await claim('recipe-box', ALICE)).json()).toEqual({ building: true, count: 1 });
    const row = db.sql.prepare('SELECT created_at FROM idea_builders WHERE idea_id = ? AND user_id = ?').get('recipe-box', 'gh:1');
    expect(Number(row?.created_at)).toBeGreaterThan(nowS() - 60);
  });

  it('unclaims idempotently', async () => {
    await claim('recipe-box', ALICE);
    await claim('recipe-box', BOB);
    expect(await (await unclaim('recipe-box', ALICE)).json()).toEqual({ building: false, count: 1 });
    expect(await (await unclaim('recipe-box', ALICE)).json()).toEqual({ building: false, count: 1 });
  });

  it(`caps a user at ${MAX_ACTIVE_CLAIMS} active claims, not counting stale ones`, async () => {
    const old = nowS() - 3600; // outside the rate window, inside the active window
    for (let i = 0; i < MAX_ACTIVE_CLAIMS; i++) seed(`idea-${i}`, 'gh:1', old);
    seed('stale-idea', 'gh:1', nowS() - CLAIM_ACTIVE_S - 10);

    const res = await claim('one-more', ALICE);
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBeTruthy();
    // Refreshing a claim already held is not a new claim.
    expect((await claim('idea-0', ALICE)).status).toBe(200);
    // Releasing one frees a slot.
    await unclaim('idea-1', ALICE);
    expect((await claim('one-more', ALICE)).status).toBe(200);
  });

  it('rate-limits new claims to 10 per minute, counting claims since released', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await claim(`idea-${i}`, ALICE)).status).toBe(200);
      await unclaim(`idea-${i}`, ALICE);
    }
    for (let i = 5; i < 10; i++) expect((await claim(`idea-${i}`, ALICE)).status).toBe(200);
    const res = await claim('idea-10', ALICE);
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBeTruthy();
    // Refreshing a held claim is not a new one; another user has their own window.
    expect((await claim('idea-5', ALICE)).status).toBe(200);
    expect((await claim('idea-10', BOB)).status).toBe(200);
    // A new window opens after 60 s.
    db.sql.exec('UPDATE idea_builder_rate SET window_start = window_start - 61');
    await unclaim('idea-6', ALICE);
    expect((await claim('idea-10', ALICE)).status).toBe(200);
  });
});
