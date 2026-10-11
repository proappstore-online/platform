import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #379: per-app account deletion. Real D1 + R2 coverage, including another app
// surviving, is in runtime-tests (per-app-deletion.test.ts).

/** A D1 where gh:1 created `stash`, and an R2 holding `keys`; both record what they are asked. */
function fixture(keys: string[], deleted: { deleted_at: number } | null = null) {
  const sql: string[] = [];
  const stmt = (q: string) => ({
    bind: () => stmt(q),
    first: async () => (q.includes('creator_id') ? { creator_id: 'gh:1' } : q.includes('FROM apps') ? { 1: 1 } : q.includes('per_app_deleted_users') ? deleted : null),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
    q,
  });
  const DB = { prepare: (q: string) => { sql.push(q); return stmt(q); }, batch: async (s: { q: string }[]) => { sql.push(...s.map((x) => `batch:${x.q}`)); return []; } };
  const objects = new Set(keys);
  const STORAGE = {
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date(0) })),
      truncated: false,
    }),
    delete: async (k: string[]) => { for (const key of k) objects.delete(key); },
  };
  return { sql, objects, env: makeEnv({ DB, STORAGE }) };
}

const call = async (method: string, path: string, uid: string, env: unknown) =>
  app.request(`/v1/apps/stash/users/${encodeURIComponent('gh:2')}/${path}`, { method, headers: { Authorization: `Bearer ${await testToken(uid)}` } }, env as never);

const FILES = ['stash/gh:2/id.pdf', 'stash/_public/u/gh:2/a.jpg', 'stash/_review/u/gh:2/p.pdf', 'stash/gh:3/x', 'notes/gh:2/x'];

describe('DELETE /apps/:appId/users/:userId/account (#379)', () => {
  it('purges the user\'s files in this app only, clears their platform rows and records the deletion', async () => {
    const f = fixture(FILES);
    const res = await call('DELETE', 'account', 'gh:2', f.env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, files: 3 });
    expect([...f.objects].sort()).toEqual(['notes/gh:2/x', 'stash/gh:3/x']);
    const batch = f.sql.filter((q) => q.startsWith('batch:'));
    for (const t of ['kv', 'app_roles', 'app_group_admin_grants', 'push_subscriptions', 'user_app_tokens']) {
      expect(batch.some((q) => q.includes(`DELETE FROM ${t} WHERE app_id = ? AND user_id = ?`)), t).toBe(true);
    }
    expect(batch.some((q) => q.includes('INSERT INTO per_app_deleted_users'))).toBe(true);
  });

  it('lets the app creator delete another user, and refuses a stranger before touching anything', async () => {
    const f = fixture(FILES);
    expect((await call('DELETE', 'account', 'gh:9', f.env)).status).toBe(403);
    expect(f.objects.size).toBe(FILES.length);
    expect((await call('DELETE', 'account', 'gh:1', f.env)).status).toBe(200);
    expect(f.objects.size).toBe(2);
  });

  it('needs a session', async () => {
    const f = fixture(FILES);
    expect((await app.request('/v1/apps/stash/users/gh%3A2/account', { method: 'DELETE' }, f.env as never)).status).toBe(401);
  });
});

describe('GET account status and public files (#379)', () => {
  it('reports whether the user deleted their account in this app', async () => {
    expect(await (await call('GET', 'account', 'gh:2', fixture([], { deleted_at: 5 }).env)).json()).toEqual({ deleted: true, deleted_at: 5 });
    expect(await (await call('GET', 'account', 'gh:2', fixture([]).env)).json()).toEqual({ deleted: false, deleted_at: null });
  });

  it('lists only the user\'s public uploads in this app, by their publicUrl path', async () => {
    const res = await call('GET', 'public-files', 'gh:2', fixture(FILES).env);
    expect(await res.json()).toEqual({ files: [{ key: 'u/gh:2/a.jpg', size: 1, uploaded: new Date(0).toISOString() }], count: 1 });
    expect((await call('GET', 'public-files', 'gh:9', fixture(FILES).env)).status).toBe(403);
  });
});
