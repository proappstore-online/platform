import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { mirrorApp, mirrorDirtyApps, mirrorStatements, type MirrorRow } from './entitlement-mirror.js';
import { sweepEntitlements } from './entitlement-sweep.js';

// #508: the platform's entitlements are copied into each app's own D1 over the trusted data-worker path; a failed push leaves the rows
// dirty, and the sweep retries and moves the clock-driven transitions. The data worker is a stubbed fetch; the SQL is real.

afterEach(() => vi.unstubAllGlobals());

const ENV = (db: D1Database) => ({ DB: db, DATA_WORKER_HOST: 'workers.test', INTERNAL_TOKEN: 'internal-secret' }) as never;
const row = (over: Partial<MirrorRow> = {}): MirrorRow => ({ product_key: 'term', subject: 'kid', status: 'active', period_end: 9000, grace_until: null, renews: 0, buyer_user_id: 'gh:2', version: 1, updated_at: 1, ...over });

function stubWorker(status = 200) {
  const sent: { url: string; headers: Record<string, string>; body: { statements: { sql: string; params?: unknown[] }[] } }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status });
  }));
  return sent;
}

async function entitlement(db: D1Database, over: Record<string, unknown> = {}) {
  const e = { app: 'club', product: 'term', subject: 'kid', status: 'active', end: 9000, renews: 0, grace: null as number | null, version: 1, mirrored: 0, ...over };
  await db.prepare(
    `INSERT INTO app_entitlements (app_id, product_key, subject, status, period_start, period_end, grace_until, renews, buyer_user_id, purchase_id, version, mirrored_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'gh:2', 'pur_1', ?, ?, 1, 1)`,
  ).bind(e.app, e.product, e.subject, e.status, e.end, e.grace, e.renews, e.version, e.mirrored).run();
}
const mirrored = async (db: D1Database) => (await db.prepare('SELECT subject, mirrored_version, version FROM app_entitlements ORDER BY subject').all<Record<string, number | string>>()).results;

describe('mirrorStatements', () => {
  it('creates the table first, then one version-guarded upsert per row', () => {
    const statements = mirrorStatements([row(), row({ subject: 'kid-b' })]);
    expect(statements).toHaveLength(3);
    expect(statements[0]!.sql).toMatch(/^CREATE TABLE IF NOT EXISTS _pas_entitlements/);
    expect(statements[1]!.sql).toContain('WHERE excluded.version >= _pas_entitlements.version');
    expect(statements[1]!.params).toEqual(['term', 'kid', 'active', 9000, null, 0, 'gh:2', 1, 1]);
    expect(mirrorStatements([])).toHaveLength(1);
  });
});

describe('mirrorApp', () => {
  it('pushes the dirty rows with the trusted token, marks exactly what was pushed, and a second call sends nothing', async () => {
    const db = sqliteD1();
    await entitlement(db);
    await entitlement(db, { subject: 'kid-b', mirrored: 1 });
    const sent = stubWorker();
    expect(await mirrorApp(ENV(db), 'club')).toBe(1);
    expect(sent[0]!.url).toContain('pas-data-club');
    expect(sent[0]!.url).toContain('/batch');
    expect(sent[0]!.headers['X-Internal-Token']).toBe('internal-secret');
    expect(sent[0]!.body.statements).toHaveLength(2);
    expect(await mirrored(db)).toEqual([{ subject: 'kid', mirrored_version: 1, version: 1 }, { subject: 'kid-b', mirrored_version: 1, version: 1 }]);
    expect(await mirrorApp(ENV(db), 'club')).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a refused push and an unreachable app both leave the rows dirty', async () => {
    const db = sqliteD1();
    await entitlement(db);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubWorker(500);
    expect(await mirrorApp(ENV(db), 'club')).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    expect(await mirrorApp(ENV(db), 'club')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    expect((await mirrored(db))[0]).toMatchObject({ mirrored_version: 0 });
  });
});

describe('mirrorDirtyApps and the sweep', () => {
  it('pushes every app that has dirty rows', async () => {
    const db = sqliteD1();
    await entitlement(db);
    await entitlement(db, { app: 'other' });
    stubWorker();
    expect(await mirrorDirtyApps(ENV(db))).toEqual({ apps: 2, rows: 2 });
    expect(await mirrorDirtyApps(ENV(db))).toEqual({ apps: 0, rows: 0 });
  });

  it('moves what the clock ended, leaves the rest alone, then pushes the change', async () => {
    const db = sqliteD1();
    await db.prepare("INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, created_at, updated_at) VALUES ('pur_1', 'club', 'term', 'gh:2', '[\"kid\",\"later\"]', 2, 'one_time', 'paid', 1, 1)").run();
    await db.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES ('purchase:pur_1', 'pur_1', 1000, 100, 'aud', 1)").run();
    await entitlement(db, { end: 5000, mirrored: 1 });
    await entitlement(db, { subject: 'later', end: 5_000_000_000_000, mirrored: 1 });
    const sent = stubWorker();
    const report = await sweepEntitlements(ENV(db), 6_000_000);
    expect(report).toMatchObject({ due: 1, mirroredApps: 1, mirroredRows: 1 });
    expect(report.changed).toBeLessThanOrEqual(1);
    expect(sent).toHaveLength(1);
    expect(await sweepEntitlements(ENV(db), 6_000_001)).toMatchObject({ due: 0, changed: 0 });
  });
});
