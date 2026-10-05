import { afterEach, describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { forgetAppVisibility } from '../lib/visibility.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #276: per-user KV sits behind a private app's gate like every other app route.
// A refused user could otherwise fill their own namespace — free storage billed
// to the private app. Real D1 coverage is in runtime-tests (visibility.test.ts).

const TOK = await testToken('gh:9');

afterEach(() => forgetAppVisibility());

/** A D1 that answers `visibility` for app_visibility and records every SQL it is asked. */
function db(visibility: { mode: string; roles: string } | null) {
  const sql: string[] = [];
  const stmt = (q: string) => ({
    bind: () => stmt(q),
    first: async () => (q.includes('app_visibility') ? visibility : q.includes('SUM(value_size_bytes)') ? { total: 0, keys: 0, key_exists: 0, existing: 0 } : null),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  });
  return { sql, DB: { prepare: (q: string) => { sql.push(q); return stmt(q); } } as unknown as D1Database };
}

const put = (appId: string, env: unknown) =>
  app.request(`/v1/apps/${appId}/kv/x`, { method: 'PUT', headers: { Authorization: `Bearer ${TOK}` }, body: '"v"' }, env as never);

describe('per-user KV behind the private-app gate (#276)', () => {
  it('a user a private app refuses gets 403 on every KV route, and nothing is written', async () => {
    const d = db({ mode: 'private', roles: '["viewer"]' });
    const env = makeEnv({ DB: d.DB });
    expect((await put('diary', env)).status).toBe(403);
    const auth = { headers: { Authorization: `Bearer ${TOK}` } };
    expect((await app.request('/v1/apps/diary/kv/x', auth, env)).status).toBe(403);
    expect((await app.request('/v1/apps/diary/kv', auth, env)).status).toBe(403);
    expect((await app.request('/v1/apps/diary/kv/x', { ...auth, method: 'DELETE' }, env)).status).toBe(403);
    expect(d.sql.some((q) => /\bkv\b/.test(q) && !q.includes('app_visibility'))).toBe(false);
  });

  it('a public app is unchanged and reads its visibility once per isolate, not per request', async () => {
    const d = db(null);
    const env = makeEnv({ DB: d.DB });
    expect((await put('open', env)).status).toBe(204);
    expect((await put('open', env)).status).toBe(204);
    expect(d.sql.filter((q) => q.includes('app_visibility'))).toHaveLength(1);
  });

  it('still answers 401 before any lookup when there is no session', async () => {
    const d = db(null);
    expect((await app.request('/v1/apps/open/kv/x', { method: 'PUT', body: '"v"' }, makeEnv({ DB: d.DB }))).status).toBe(401);
    expect(d.sql).toHaveLength(0);
  });
});
