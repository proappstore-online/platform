import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { LEDGER_RETENTION_DAYS, PRUNE_BATCH_LIMIT, RATE_LIMIT_LEDGERS, RETENTION_DAYS, cutoffMs } from './logs-prune.js';

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function pruneDb(opts: { deleted?: number; usageDeleted?: number; overdue?: number } = {}) {
  return mockD1(
    mockStmt({ run: { meta: { changes: opts.deleted ?? 0 } } }),
    mockStmt({ run: { meta: { changes: opts.usageDeleted ?? 0 } } }),
    mockStmt({ first: { n: opts.overdue ?? 0 } }),
  );
}

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ INTERNAL_TOKEN: 'internal-tok' }, db ?? pruneDb());
}

function prune(token: string | null, db?: ReturnType<typeof mockD1>) {
  return app.request(
    '/v1/internal/logs/prune',
    { method: 'POST', headers: token ? { 'X-Internal-Token': token } : {} },
    makeEnv(db),
  );
}

describe('cutoffMs', () => {
  it('subtracts whole days', () => {
    const now = 1_800_000_000_000;
    expect(cutoffMs(now, 1)).toBe(now - 86_400_000);
    expect(cutoffMs(now, RETENTION_DAYS)).toBe(now - RETENTION_DAYS * 86_400_000);
  });
});

describe('POST /v1/internal/logs/prune', () => {
  it('rejects a missing internal token', async () => {
    expect((await prune(null)).status).toBe(403);
  });

  it('rejects a wrong internal token', async () => {
    expect((await prune('not-the-token')).status).toBe(403);
  });

  it('reports what it deleted', async () => {
    const res = await prune('internal-tok', pruneDb({ deleted: 120, usageDeleted: 3 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      retentionDays: RETENTION_DAYS,
      deleted: 120,
      usageRowsDeleted: 3,
      stillOverdue: 0,
    });
  });

  it('surfaces a backlog so a capped run is not mistaken for a clean one', async () => {
    // The prune is batch-limited, so one run can leave work behind. Silently
    // returning ok here is how retention stops working without anyone noticing.
    const res = await prune('internal-tok', pruneDb({ deleted: 10_000, overdue: 4_200 }));
    expect(await res.json()).toMatchObject({ deleted: 10_000, stillOverdue: 4_200 });
  });

  it('prunes on ingested_at, not the client-supplied ts', async () => {
    const db = pruneDb();
    await prune('internal-tok', db);
    const deleteSql = db.prepare.mock.calls[0][0] as string;
    expect(deleteSql).toContain('ingested_at <');
    expect(deleteSql).not.toContain('ts <');
  });
});

// #223: append-only rate-limit ledgers are pruned past their windows.
describe('POST /v1/internal/logs/prune — rate-limit ledgers (#223)', () => {
  const NOW = 1_800_000_000_000;
  const ledgerDb = (ledger: Record<string, number | Error> = {}) => {
    const db = pruneDb({ deleted: 5 });
    const base = db.prepare.getMockImplementation();
    db.prepare.mockImplementation((sql: string) => {
      const table = RATE_LIMIT_LEDGERS.find((l) => sql.startsWith(`DELETE FROM ${l.table} `))?.table;
      if (!table) return base ? base(sql) : mockStmt();
      const r = ledger[table] ?? 0;
      const stmt = mockStmt({ run: { meta: { changes: r instanceof Error ? 0 : r } } });
      if (r instanceof Error) stmt.run.mockRejectedValue(r);
      return stmt;
    });
    return db;
  };
  const ledgerCall = (db: ReturnType<typeof ledgerDb>, table: string) => {
    const i = db.prepare.mock.calls.findIndex((c) => String(c[0]).startsWith(`DELETE FROM ${table} `));
    return { sql: String(db.prepare.mock.calls[i][0]), bind: db.prepare.mock.results[i].value.bind.mock.calls[0] as unknown[] };
  };
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('retention outlives every window read (1 h maps, UTC day SMS, 60 s push)', () => {
    expect(LEDGER_RETENTION_DAYS * 86_400_000).toBeGreaterThan(24 * 3_600_000);
  });

  it('prunes each ledger on its own column, in its own time unit, batch-bounded', async () => {
    const db = ledgerDb();
    expect((await prune('internal-tok', db)).status).toBe(200);
    const cutoff = cutoffMs(NOW, LEDGER_RETENTION_DAYS);
    const maps = ledgerCall(db, 'maps_usage');
    expect(maps.sql).toContain('WHERE ts < ?');
    expect(maps.bind).toEqual([Math.floor(cutoff / 1000), PRUNE_BATCH_LIMIT]); // seconds
    const sms = ledgerCall(db, 'sms_usage');
    expect(sms.sql).toContain('WHERE sent_at < ?');
    expect(sms.bind).toEqual([cutoff, PRUNE_BATCH_LIMIT]); // milliseconds
    const push = ledgerCall(db, 'notification_log');
    expect(push.sql).toContain('WHERE sent_at < ?');
    expect(push.bind).toEqual([Math.floor(cutoff / 1000), PRUNE_BATCH_LIMIT]); // seconds
    for (const t of ['maps_usage', 'sms_usage', 'notification_log']) expect(ledgerCall(db, t).sql).toContain('LIMIT ?');
  });

  it('reports rows deleted per ledger; a full batch flags a backlog', async () => {
    let body = await (await prune('internal-tok', ledgerDb({ maps_usage: 40, sms_usage: 2, notification_log: 7 }))).json();
    expect(body).toMatchObject({
      ledgerRetentionDays: LEDGER_RETENTION_DAYS,
      ledgerRowsDeleted: { maps_usage: 40, sms_usage: 2, notification_log: 7 },
      ledgerBacklog: false, ledgerErrors: {},
    });
    body = await (await prune('internal-tok', ledgerDb({ notification_log: PRUNE_BATCH_LIMIT }))).json();
    expect(body).toMatchObject({ ledgerBacklog: true });
  });

  it('one ledger failing never blocks app-log retention or the other ledgers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await prune('internal-tok', ledgerDb({ maps_usage: new Error('no such table: maps_usage'), sms_usage: 3, notification_log: 4 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deleted: 5,
      ledgerRowsDeleted: { sms_usage: 3, notification_log: 4 },
      ledgerErrors: { maps_usage: 'no such table: maps_usage' },
    });
  });

  it('still refuses without the internal token, deleting nothing', async () => {
    const db = ledgerDb();
    expect((await prune(null, db)).status).toBe(403);
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
