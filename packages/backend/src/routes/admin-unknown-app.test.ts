import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #378: a platform admin's bypass applies to apps that exist. For an unknown or
// deleted id the worker routes answer 404 — never a 200 over orphaned history,
// nor a rotate or delete acting on orphaned rows — and write nothing.

const ADMIN = await testToken('gh:7', { roles: ['user', 'admin'] });

/** No app rows; records every statement prepared. */
function db() {
  const sql: string[] = [];
  const stmt = (q: string) => {
    const st = { bind: () => st, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) };
    return st;
  };
  return { sql, DB: { prepare: (q: string) => { sql.push(q); return stmt(q); }, batch: async () => [] } as unknown as D1Database };
}

describe('the admin bypass needs an app that exists (#378)', () => {
  it.each([
    ['GET', '/v1/apps/ghost/worker'],
    ['DELETE', '/v1/apps/ghost/worker'],
    ['POST', '/v1/apps/ghost/worker/rotate'],
  ])('%s %s answers 404 and writes nothing', async (method, path) => {
    const d = db();
    const res = await app.request(path, { method, headers: { Authorization: `Bearer ${ADMIN}` } }, makeEnv({ DB: d.DB }));
    expect(res.status).toBe(404);
    expect(d.sql.filter((q) => /^\s*(UPDATE|DELETE|INSERT)/i.test(q))).toEqual([]);
  });
});
