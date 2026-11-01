import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { makeEnv as sharedMakeEnv, mockD1, mockStmt, TEST_SK } from '../test-helpers.js';
import type { ColumnInfo } from '../lib/endpoint-sql.js';

async function tok(uid: string, authTimeOffsetSeconds: number | null): Promise<string> {
  const authTime = authTimeOffsetSeconds === null ? undefined : Math.floor(Date.now() / 1000) - authTimeOffsetSeconds;
  return mintSession({ uid, login: 'test-user', roles: ['user'], ...(authTime !== undefined ? { auth_time: authTime } : {}) }, TEST_SK);
}

const owner = () => mockStmt({ first: { creator_id: 'gh:1' } });
const notOwner = () => mockStmt({ first: { creator_id: 'gh:999' } }); // then a team_members lookup returning null
const makeEnv = (db: ReturnType<typeof mockD1>) => sharedMakeEnv({ INTERNAL_TOKEN: 'internal-secret' }, db);

const TASKS: ColumnInfo[] = [
  { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
  { name: 'owner_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
];

let schemaByTable: Record<string, ColumnInfo[] | 'down'>;
const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
beforeEach(() => {
  schemaByTable = { tasks: TASKS };
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    if (url.endsWith('/query')) {
      const { sql } = JSON.parse(init!.body as string) as { sql: string };
      const m = /table_info\("([^"]+)"\)/.exec(sql);
      const table = m ? m[1]! : '';
      const rows = schemaByTable[table];
      if (rows === 'down') return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ rows: rows ?? [] }), { status: 200 });
    }
    if (url.endsWith('/batch')) {
      const { statements } = JSON.parse(init!.body as string) as { statements: unknown[] };
      return new Response(JSON.stringify({ results: statements.map(() => ({ rows: [], meta: { changes: 1 } })) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const post = async (appId: string, body: unknown, token: string, db: ReturnType<typeof mockD1>) =>
  app.request(`/v1/apps/${appId}/data/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, makeEnv(db));

const ONE_ROW = { tables: { tasks: [{ id: '1', owner_id: 'gh:1', title: 'a' }] } };

describe('POST /v1/apps/:appId/data/import (#515)', () => {
  it('refuses a non-owner with 403', async () => {
    const res = await post('test-app', ONE_ROW, await tok('gh:1', 0), mockD1(notOwner(), mockStmt({ first: null })));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a stale session (no recent sign-in) with 403 step_up_required, before any schema read', async () => {
    const res = await post('test-app', ONE_ROW, await tok('gh:1', 10_000), mockD1(owner()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('step_up_required');
    expect(calls).toHaveLength(0);
  });

  it('refuses a session with no auth_time at all (minted before step-up existed)', async () => {
    const res = await post('test-app', ONE_ROW, await tok('gh:1', null), mockD1(owner()));
    expect(res.status).toBe(403);
  });

  it('schema mismatch: an unknown table is refused, dry-run or not, and nothing is written', async () => {
    const res = await post('test-app', { tables: { ghosts: [{ id: '1' }] } }, await tok('gh:1', 0), mockD1(owner()));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; mismatches: string[] };
    expect(body.error).toBe('schema mismatch');
    expect(body.mismatches).toContain('table "ghosts" does not exist');
    expect(calls.some((c) => c.url.endsWith('/batch'))).toBe(false);
  });

  it('schema mismatch: a row naming a column the live table lacks is refused even outside dry-run', async () => {
    const res = await post('test-app', { tables: { tasks: [{ id: '1', owner_id: 'gh:1', title: 'a', bogus: 1 }] } }, await tok('gh:1', 0), mockD1(owner()));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { mismatches: string[] }).mismatches).toContain('"tasks"."bogus" does not exist on the live schema');
    expect(calls.some((c) => c.url.endsWith('/batch'))).toBe(false);
  });

  it('dry-run reports row counts per table and writes nothing', async () => {
    const res = await post('test-app', { ...ONE_ROW, dryRun: true }, await tok('gh:1', 0), mockD1(owner()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: true, tables: { tasks: { rows: 1 } } });
    expect(calls.some((c) => c.url.endsWith('/batch'))).toBe(false);
  });

  it('a clean import writes via /batch with the internal token and records one app_logs entry', async () => {
    const db = mockD1(owner(), mockStmt({ run: { meta: { changes: 1 } } }));
    const res = await post('test-app', ONE_ROW, await tok('gh:1', 0), db);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dryRun: false, tables: { tasks: { rows: 1 } } });

    const batchCall = calls.find((c) => c.url.endsWith('/batch'))!;
    expect(batchCall.headers['X-Internal-Token']).toBe('internal-secret');
    const { statements } = JSON.parse(batchCall.body) as { statements: { sql: string }[] };
    expect(statements).toHaveLength(1);
    expect(statements[0]!.sql).toContain('ON CONFLICT ("id") DO NOTHING');

    const logInsert = db.prepare.mock.calls.map((c) => c[0] as string).find((sql) => sql.includes('INSERT INTO app_logs'));
    expect(logInsert).toBeTruthy();
  });

  it('idempotent re-run: the same request sent twice builds byte-identical statements and succeeds both times', async () => {
    const db1 = mockD1(owner(), mockStmt());
    const first = await post('test-app', ONE_ROW, await tok('gh:1', 0), db1);
    const firstStatements = JSON.parse(calls.find((c) => c.url.endsWith('/batch'))!.body) as { statements: unknown[] };
    calls.length = 0;

    const db2 = mockD1(owner(), mockStmt());
    const second = await post('test-app', ONE_ROW, await tok('gh:1', 0), db2);
    const secondStatements = JSON.parse(calls.find((c) => c.url.endsWith('/batch'))!.body) as { statements: unknown[] };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondStatements).toEqual(firstStatements);
  });

  it('chunks a large import into multiple bounded /batch calls', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: String(i), owner_id: 'gh:1', title: 'a' }));
    const db = mockD1(owner(), mockStmt());
    const res = await post('test-app', { tables: { tasks: rows } }, await tok('gh:1', 0), db);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.endsWith('/batch'))).toHaveLength(2);
  });

  it('400 on a malformed body', async () => {
    expect((await post('test-app', { tables: [] }, await tok('gh:1', 0), mockD1(owner()))).status).toBe(400);
    expect((await post('test-app', { tables: { tasks: 'nope' } }, await tok('gh:1', 0), mockD1(owner()))).status).toBe(400);
    expect((await post('test-app', { tables: { tasks: ['nope'] } }, await tok('gh:1', 0), mockD1(owner()))).status).toBe(400);
  });
});
