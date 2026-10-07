import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';

// #275 against real SQLite (node:sqlite), so the atomic upserts, RETURNING and
// the exactly-once alert index behave as they do on D1. The end-to-end paths
// (schedule, hook, http) run on workerd in runtime-tests/…/worker-quotas.test.ts.

vi.mock('./webhook-dispatch.js', () => ({ dispatchWebhook: vi.fn(async () => undefined) }));
const { dispatchWebhook } = await import('./webhook-dispatch.js');
const usage = await import('./app-worker-usage.js');
const {
  AppWorkerQuotaError, DEFAULT_APP_WORKER_QUOTAS, appWorkerUsage, appWorkersOpen, checkAccountCeiling, nearQuota, parseAccountCeiling,
  quotasFrom, recordInvocationUsage, reserveHookDelivery, reserveInvocation, setAppWorkersOpen, validateQuotaOverrides,
} = usage;

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../../../migrations/0071_app_worker_usage.sql', import.meta.url), 'utf8')
  + readFileSync(new URL('../../../../migrations/0075_app_worker_log_usage.sql', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 9, 6, 12, 0);
const TOMORROW = NOW + 86_400_000;

let sqlite: InstanceType<typeof DatabaseSync>;
let failing = false;

/** The slice of D1 this module uses, over node:sqlite. */
function d1(): D1Database {
  return {
    prepare(sql: string) {
      if (failing) throw new Error('D1_ERROR: database unavailable');
      const exec = (args: unknown[]) => ({
        first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
        all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
      });
      return { bind: (...args: unknown[]) => exec(args), ...exec([]) };
    },
  } as unknown as D1Database;
}

let env: Env;
beforeEach(() => {
  failing = false;
  vi.mocked(dispatchWebhook).mockClear();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE app_workers (app_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_worker_invocations (id TEXT PRIMARY KEY, pas_calls INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE app_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, kind TEXT NOT NULL, window_start INTEGER NOT NULL,
      window_end INTEGER NOT NULL, count INTEGER NOT NULL, affected_users INTEGER NOT NULL DEFAULT 0, baseline INTEGER NOT NULL DEFAULT 0,
      top TEXT NOT NULL DEFAULT '{}', build_meta TEXT, created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX idx_app_alerts_bucket ON app_alerts (app_id, kind, window_start);
  `);
  sqlite.exec(MIGRATION);
  env = { DB: d1() } as Env;
});

const q = (over: Partial<typeof DEFAULT_APP_WORKER_QUOTAS> = {}) => ({ ...DEFAULT_APP_WORKER_QUOTAS, ...over });
const row = (day = '2026-10-06') => sqlite.prepare('SELECT invocations, cpu_ms, hook_deliveries, pas_calls FROM app_worker_usage WHERE app_id = ? AND day = ?').get('a', day);
const alerts = () => sqlite.prepare('SELECT app_id, kind, count, baseline FROM app_alerts').all();

describe('invocation quota (#275)', () => {
  it('counts every reservation and refuses the one past the quota until the next UTC day', async () => {
    for (let i = 0; i < 3; i++) await reserveInvocation(env, 'a', q({ invocations: 3 }), NOW);
    const over = await reserveInvocation(env, 'a', q({ invocations: 3 }), NOW).catch((e) => e);
    expect(over).toBeInstanceOf(AppWorkerQuotaError);
    expect(over).toMatchObject({ status: 429, message: 'quota exceeded', quota: 'invocations', retryAfter: 12 * 3600 });
    expect(row()).toMatchObject({ invocations: 3 });
    await reserveInvocation(env, 'a', q({ invocations: 3 }), TOMORROW);
    expect(row('2026-10-07')).toMatchObject({ invocations: 1 });
  });

  it('adds wall-clock ms and the invocation\'s PAS calls; once cpu_ms reaches its quota, the next invoke is refused as cpu_ms', async () => {
    sqlite.prepare("INSERT INTO app_worker_invocations (id, pas_calls) VALUES ('e:1', 7)").run();
    await reserveInvocation(env, 'a', q({ cpu_ms: 1000 }), NOW);
    await recordInvocationUsage(env, 'a', 'e:1', q({ cpu_ms: 1000 }), NOW, NOW + 1200);
    expect(row()).toEqual({ invocations: 1, cpu_ms: 1200, hook_deliveries: 0, pas_calls: 7 });
    await expect(reserveInvocation(env, 'a', q({ cpu_ms: 1000 }), NOW)).rejects.toMatchObject({ quota: 'cpu_ms' });
  });

  it('an unavailable database is never an allow: the check fails closed with 503', async () => {
    failing = true;
    await expect(reserveInvocation(env, 'a', q(), NOW)).rejects.toMatchObject({ status: 503, message: 'quota check unavailable' });
    await expect(reserveHookDelivery(env, 'a', q(), NOW)).rejects.toMatchObject({ status: 503, message: 'quota check unavailable' });
    // Recording a finished invocation never throws.
    await expect(recordInvocationUsage(env, 'a', 'x', q(), NOW, NOW + 1)).resolves.toBeUndefined();
  });
});

describe('hook delivery quota (#275)', () => {
  it('counts deliveries apart from invocations and refuses past the quota', async () => {
    await reserveHookDelivery(env, 'a', q({ hook_deliveries: 2 }), NOW);
    await reserveHookDelivery(env, 'a', q({ hook_deliveries: 2 }), NOW);
    await expect(reserveHookDelivery(env, 'a', q({ hook_deliveries: 2 }), NOW)).rejects.toMatchObject({ quota: 'hook_deliveries', status: 429 });
    expect(row()).toMatchObject({ invocations: 0, hook_deliveries: 2 });
  });
});

describe('80 % alert (#275)', () => {
  it('raises exactly one app_alerts row and one app.alert webhook per app per day', async () => {
    for (let i = 0; i < 10; i++) await reserveInvocation(env, 'a', q({ invocations: 10 }), NOW).catch(() => undefined);
    expect(alerts()).toEqual([{ app_id: 'a', kind: 'app_worker_quota', count: 8, baseline: 10 }]);
    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchWebhook).mock.calls[0]![3]).toMatchObject({ kind: 'app_worker_quota', quota: 'invocations', used: 8, limit: 10 });
    await reserveInvocation(env, 'a', q({ invocations: 10 }), TOMORROW);
    expect(alerts()).toHaveLength(1);
  });

  it('nearQuota names the first quota at or past 80 %', () => {
    expect(nearQuota({ invocations: 7, cpu_ms: 0, hook_deliveries: 0, pas_calls: 0 }, q({ invocations: 10 }))).toBeNull();
    expect(nearQuota({ invocations: 0, cpu_ms: 0, hook_deliveries: 4, pas_calls: 0 }, q({ hook_deliveries: 5 }))).toBe('hook_deliveries');
  });
});

describe('quota overrides (#275)', () => {
  it('apply positive integers over the defaults and ignore anything else', () => {
    expect(quotasFrom(null)).toEqual(DEFAULT_APP_WORKER_QUOTAS);
    expect(quotasFrom('{"invocations":3,"cpu_ms":-1,"hook_deliveries":"9"}')).toEqual({ ...DEFAULT_APP_WORKER_QUOTAS, invocations: 3 });
    expect(quotasFrom('not json')).toEqual(DEFAULT_APP_WORKER_QUOTAS);
  });

  it('validate an admin body', () => {
    expect(validateQuotaOverrides(null)).toEqual({ overrides: null });
    expect(validateQuotaOverrides({ invocations: 3 })).toEqual({ overrides: { invocations: 3 } });
    expect(validateQuotaOverrides({ cpu: 3 })).toHaveProperty('error');
    expect(validateQuotaOverrides({ invocations: 0 })).toHaveProperty('error');
    expect(validateQuotaOverrides([1])).toHaveProperty('error');
  });
});

describe('owner usage view (#275)', () => {
  it('shows quotas with overrides, today (zeroes before any use) and the window, labelling cpu_ms as wall-clock', async () => {
    sqlite.prepare(`INSERT INTO app_workers (app_id, enabled, quota_overrides) VALUES ('a', 1, '{"invocations":3}')`).run();
    const empty = await appWorkerUsage(env, 'a', 30, NOW);
    expect(empty).toMatchObject({ quotas: { invocations: 3 }, cpu_ms_source: 'wall', today: { day: '2026-10-06', invocations: 0 }, days: [] });
    await reserveInvocation(env, 'a', q(), NOW - 86_400_000);
    await reserveInvocation(env, 'a', q(), NOW);
    const view = await appWorkerUsage(env, 'a', 30, NOW);
    expect(view.today).toMatchObject({ day: '2026-10-06', invocations: 1 });
    expect(view.days.map((d) => d.day)).toEqual(['2026-10-06', '2026-10-05']);
    expect((await appWorkerUsage(env, 'a', 1, NOW)).days).toHaveLength(1);
  });
});

describe('account guard: APP_WORKER_OPEN (#275)', () => {
  it('closes new enables once today\'s summed usage passes the ceiling, alerts once, and never reopens itself', async () => {
    env.APP_WORKER_ACCOUNT_CEILING = '{ "cpu_ms": 1000000, "invocations": 2 }';
    expect(await appWorkersOpen(env)).toBe(true);
    await reserveInvocation(env, 'a', q(), NOW);
    await reserveInvocation(env, 'b', q(), NOW);
    expect(await checkAccountCeiling(env, NOW)).toEqual({ closed: false });
    await reserveInvocation(env, 'b', q(), NOW);
    expect(await checkAccountCeiling(env, NOW)).toEqual({ closed: true });
    expect(await checkAccountCeiling(env, NOW + 900_000)).toEqual({ closed: true });
    expect(await appWorkersOpen(env)).toBe(false);
    expect(alerts()).toEqual([{ app_id: '_platform', kind: 'app_worker_account_ceiling', count: 3, baseline: 2 }]);
    expect(sqlite.prepare('SELECT closed_reason FROM app_worker_platform').get()).toMatchObject({ closed_reason: expect.stringContaining('3 invocations') });
    // Only an admin reopens it.
    expect(await setAppWorkersOpen(env, true, null, NOW)).toBe(true);
    expect(await setAppWorkersOpen(env, true, null, NOW)).toBe(false);
    expect(await appWorkersOpen(env)).toBe(true);
  });

  it('is off without a well-formed ceiling; a missing flag row reads as closed', async () => {
    expect(parseAccountCeiling(undefined)).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseAccountCeiling('{"cpu_ms":1}')).toBeNull();
    expect(parseAccountCeiling('nope')).toBeNull();
    expect(await checkAccountCeiling(env, NOW)).toEqual({ closed: false });
    sqlite.exec('DELETE FROM app_worker_platform');
    expect(await appWorkersOpen(env)).toBe(false);
  });
});
