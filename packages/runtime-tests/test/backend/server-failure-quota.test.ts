import { SELF, env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { recordOperationFailure } from '../../../backend/src/lib/operation-log';
import { resetBurstState, SERVER_FAILURE_DAILY_LIMIT } from '../../../backend/src/lib/log-quota';
import { DAILY_ENTRY_LIMIT } from '../../../backend/src/lib/log-ingest';
import { utcDayKey } from '../../../backend/src/lib/day-key';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = testEnv as unknown as Env & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };

// #372 (#303 F10) on real D1: server operation-failure rows (source = 'server')
// meter on app_log_usage.server_count, a budget anonymous POST /logs cannot
// spend. Analytics Engine counting and the authenticated-caller gate stay.

const APP = 'srv';
const day = () => utcDayKey(Date.now());
const usage = () => env.DB.prepare('SELECT count, server_count FROM app_log_usage WHERE app_id = ? AND day = ?').bind(APP, day()).first<{ count: number; server_count: number }>();
const serverRows = async () => (await env.DB.prepare("SELECT user_id, category, level FROM app_logs WHERE app_id = ? AND source = 'server'").bind(APP).all<{ user_id: string }>()).results ?? [];
/** A failed mutation on an `:appId` route: a non-owner's tool deletion is a 403, which the operation-log hook records in the background. */
const failingWrite = async (token?: string) => {
  const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/tools`, json('DELETE', undefined, token));
  await res.text();
  return res.status;
};
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
const aeRecorder = () => {
  const points: unknown[] = [];
  return { points, ERRORS: { writeDataPoint: (p: unknown) => points.push(p) } as unknown as AnalyticsEngineDataset };
};
const failure = { appId: APP, userId: 'gh:2', method: 'DELETE', routePath: '/v1/apps/:appId/tools', params: { appId: APP }, status: 403, message: 'not the app owner' };

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  for (const t of ['app_logs', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:owner');
  await seedUser('gh:2');
  await seedApp(APP, 'gh:owner');
});

describe('server operation-failure rows have their own daily budget (#372)', () => {
  it('an anonymous flood that spends the app\'s client-log budget does not silence server rows', async () => {
    // The anonymous flood: the app's client-ingestion budget is spent for today…
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count) VALUES (?, ?, ?)').bind(APP, day(), DAILY_ENTRY_LIMIT).run();
    const anon = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('POST', { clientId: 'server', entries: [{ level: 'error', message: 'flood' }] }));
    expect([200, 202]).toContain(anon.status);
    expect(await anon.json()).toMatchObject({ ingested: 0 });

    // …and a real authenticated failure still lands, on its own counter.
    expect(await failingWrite(await session('gh:2'))).toBe(403);
    const rows = await eventually(serverRows, (r) => r.length > 0);
    expect(rows).toEqual([expect.objectContaining({ user_id: 'gh:2' })]);
    expect(await usage()).toEqual({ count: DAILY_ENTRY_LIMIT, server_count: 1 });
  });

  it('server rows never spend the client-ingestion counter', async () => {
    expect(await failingWrite(await session('gh:2'))).toBe(403);
    await eventually(serverRows, (r) => r.length > 0);
    expect(await usage()).toEqual({ count: 0, server_count: 1 });
  });

  it('the server budget is bounded: at SERVER_FAILURE_DAILY_LIMIT the row is dropped but Analytics Engine still counts', async () => {
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count, server_count) VALUES (?, ?, 0, ?)').bind(APP, day(), SERVER_FAILURE_DAILY_LIMIT - 1).run();
    const ae = aeRecorder();
    await recordOperationFailure({ DB: env.DB, ERRORS: ae.ERRORS }, failure, Date.now());
    expect(await serverRows()).toHaveLength(1);
    expect((await usage())!.server_count).toBe(SERVER_FAILURE_DAILY_LIMIT);

    await recordOperationFailure({ DB: env.DB, ERRORS: ae.ERRORS }, { ...failure, status: 500 }, Date.now());
    expect(await serverRows()).toHaveLength(1); // the cap held
    expect((await usage())!.server_count).toBe(SERVER_FAILURE_DAILY_LIMIT);
    expect(ae.points).toHaveLength(2); // both counted
  });

  it('an unauthenticated caller still cannot mint a source = \'server\' row, and spends no server budget', async () => {
    const ae = aeRecorder();
    await recordOperationFailure({ DB: env.DB, ERRORS: ae.ERRORS }, { ...failure, userId: null }, Date.now());
    expect(ae.points).toHaveLength(1);
    expect(await serverRows()).toEqual([]);
    expect(await usage()).toBeNull();

    expect(await failingWrite()).toBe(401);
    await new Promise((r) => setTimeout(r, 200));
    expect(await serverRows()).toEqual([]);
  });
});

describe('migration 0094 is backwards compatible', () => {
  it('adds server_count NOT NULL DEFAULT 0, so the ingestion route\'s count-only rows keep working', async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0094_'));
    expect(migration?.name).toBe('0094_app_log_usage_server_count.sql');
    const cols = (await env.DB.prepare('PRAGMA table_info(app_log_usage)').all<{ name: string; notnull: number; dflt_value: string | null }>()).results ?? [];
    expect(cols.find((c) => c.name === 'server_count')).toMatchObject({ notnull: 1, dflt_value: '0' });
    // The shape POST /logs writes, unchanged: it names only `count`.
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count) VALUES (?, ?, 5) ON CONFLICT(app_id, day) DO UPDATE SET count = count + 5').bind(APP, day()).run();
    expect(await usage()).toEqual({ count: 5, server_count: 0 });
  });
});
