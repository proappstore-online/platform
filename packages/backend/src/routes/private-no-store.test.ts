import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #378: owner-only reads carry `Cache-Control: private, no-store`, so neither a
// shared cache nor the next account on the same browser is ever served them.

const TOK = await testToken('gh:1');

/** gh:1 created myapp; every other read is empty. */
function db() {
  const stmt = (sql: string) => {
    const st = {
      bind: () => st,
      first: async () => (/FROM apps\b/.test(sql) ? { id: 'myapp', creator_id: 'gh:1' } : null),
      all: async () => ({ results: [] }),
      run: async () => ({ meta: { changes: 0 } }),
      raw: async () => [],
    };
    return st;
  };
  return { prepare: (sql: string) => stmt(sql), batch: async () => [] } as unknown as D1Database;
}

describe('owner-only reads are never cached (#378)', () => {
  it.each([
    '/v1/apps/myapp/logs',
    '/v1/apps/myapp/logs/groups',
    '/v1/apps/myapp/team',
    '/v1/apps/myapp/qa/flows',
    '/v1/apps/myapp/qa/runs',
    '/v1/submissions',
    '/v1/me/is-admin',
  ])('GET %s', async (path) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ DB: db() }));
    expect(res.status).toBeLessThan(500);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
