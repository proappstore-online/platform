import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import {
  LEDGER_RETENTION_DAYS, PRUNE_BATCH_LIMIT, RATE_LIMIT_LEDGERS, RETENTION_DAYS, WEBHOOK_DELIVERY_RETENTION_DAYS, cutoffMs,
} from './logs-prune.js';

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

  it('prunes the per-day and per-window counters (#27) on their own column and unit, by rowid', async () => {
    const db = ledgerDb();
    expect((await prune('internal-tok', db)).status).toBe(200);
    const cutoff = cutoffMs(NOW, LEDGER_RETENTION_DAYS);
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10); // UTC YYYY-MM-DD
    expect(cutoffDay).toBe('2027-01-13'); // NOW = 2027-01-15T08:00Z, minus 2 days
    for (const [table, column, bound] of [
      ['app_proxy_usage', 'day', cutoffDay],
      ['app_proxy_usage_user', 'day', cutoffDay],
      ['ai_daily_budget', 'date', cutoffDay],
      ['license_validate_attempts', 'window_start', cutoff], // milliseconds
      ['provision_attempts', 'window_start', cutoff], // milliseconds
    ] as const) {
      const { sql, bind } = ledgerCall(db, table);
      expect(sql).toBe(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ? LIMIT ?)`);
      expect(bind).toEqual([bound, PRUNE_BATCH_LIMIT]);
    }
  });

  it('keeps every counter window: retention outlives the 24 h provision window and the UTC day', () => {
    // A day-string cutoff two days back never reaches today's or yesterday's row.
    const cutoffDay = new Date(cutoffMs(NOW, LEDGER_RETENTION_DAYS)).toISOString().slice(0, 10);
    const today = new Date(NOW).toISOString().slice(0, 10);
    const yesterday = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
    expect(yesterday < cutoffDay || today < cutoffDay).toBe(false);
    expect(LEDGER_RETENTION_DAYS * 86_400_000).toBeGreaterThan(24 * 3_600_000);
  });

  it('reports counter deletions and backlog alongside the ledgers', async () => {
    let body = await (await prune('internal-tok', ledgerDb({ app_proxy_usage_user: 300, license_validate_attempts: 41 }))).json();
    expect(body).toMatchObject({
      ledgerRowsDeleted: { app_proxy_usage_user: 300, license_validate_attempts: 41, ai_daily_budget: 0, provision_attempts: 0, app_proxy_usage: 0 },
      ledgerBacklog: false, ledgerErrors: {},
    });
    body = await (await prune('internal-tok', ledgerDb({ ai_daily_budget: PRUNE_BATCH_LIMIT }))).json();
    expect(body).toMatchObject({ ledgerBacklog: true });
  });

  it('a counter failing never blocks the ledgers or the other counters', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await prune('internal-tok', ledgerDb({
      provision_attempts: new Error('no such table: provision_attempts'), maps_usage: 2, ai_daily_budget: 5,
    }))).json();
    expect(body).toMatchObject({
      deleted: 5,
      ledgerRowsDeleted: { maps_usage: 2, ai_daily_budget: 5 },
      ledgerErrors: { provision_attempts: 'no such table: provision_attempts' },
    });
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

// #27: the webhook delivery log (full payloads, never read) is pruned too.
describe('POST /v1/internal/logs/prune — webhook deliveries (#27)', () => {
  const NOW = 1_800_000_000_000;
  const isExpired = (sql: string) => sql.startsWith('DELETE FROM webhook_deliveries ') && sql.includes('created_at < ?');
  const isOrphaned = (sql: string) => sql.startsWith('DELETE FROM webhook_deliveries ') && sql.includes('NOT EXISTS');
  const deliveriesDb = (r: { expired?: number | Error; orphaned?: number | Error; maps?: number } = {}) => {
    const db = pruneDb({ deleted: 5 });
    const base = db.prepare.getMockImplementation();
    db.prepare.mockImplementation((sql: string) => {
      const v = isExpired(sql) ? r.expired ?? 0 : isOrphaned(sql) ? r.orphaned ?? 0
        : sql.startsWith('DELETE FROM maps_usage ') ? r.maps : undefined;
      if (v === undefined) return base ? base(sql) : mockStmt();
      const stmt = mockStmt({ run: { meta: { changes: v instanceof Error ? 0 : v } } });
      if (v instanceof Error) stmt.run.mockRejectedValue(v);
      return stmt;
    });
    return db;
  };
  const call = (db: ReturnType<typeof deliveriesDb>, match: (sql: string) => boolean) => {
    const i = db.prepare.mock.calls.findIndex((c) => match(String(c[0])));
    expect(i).toBeGreaterThanOrEqual(0);
    return { sql: String(db.prepare.mock.calls[i][0]), bind: db.prepare.mock.results[i].value.bind.mock.calls[0] as unknown[] };
  };
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('deletes rows older than 7 days on created_at, in seconds, batch-bounded', async () => {
    const db = deliveriesDb();
    expect((await prune('internal-tok', db)).status).toBe(200);
    const expired = call(db, isExpired);
    expect(WEBHOOK_DELIVERY_RETENTION_DAYS).toBe(7);
    expect(expired.bind).toEqual([Math.floor(cutoffMs(NOW, 7) / 1000), PRUNE_BATCH_LIMIT]);
    expect(expired.sql).toContain('LIMIT ?');
  });

  it('deletes rows whose webhook no longer exists, batch-bounded', async () => {
    const db = deliveriesDb();
    await prune('internal-tok', db);
    const orphaned = call(db, isOrphaned);
    expect(orphaned.sql).toContain('FROM app_webhooks w WHERE w.id = webhook_deliveries.webhook_id');
    expect(orphaned.bind).toEqual([PRUNE_BATCH_LIMIT]);
  });

  it('reports both counts with the retention; a full batch flags a backlog', async () => {
    let body = await (await prune('internal-tok', deliveriesDb({ expired: 12, orphaned: 3 }))).json();
    expect(body).toMatchObject({
      webhookDeliveryRetentionDays: 7,
      ledgerRowsDeleted: { webhook_deliveries: 12, webhook_deliveries_orphaned: 3 },
      ledgerBacklog: false, ledgerErrors: {},
    });
    body = await (await prune('internal-tok', deliveriesDb({ expired: PRUNE_BATCH_LIMIT }))).json();
    expect(body).toMatchObject({ ledgerBacklog: true });
    body = await (await prune('internal-tok', deliveriesDb({ orphaned: PRUNE_BATCH_LIMIT }))).json();
    expect(body).toMatchObject({ ledgerBacklog: true });
  });

  it('a delivery-log failure is reported and never blocks the other prunes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await prune('internal-tok', deliveriesDb({ expired: new Error('D1_ERROR: database locked'), orphaned: 2, maps: 9 }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ledgerRowsDeleted: Record<string, number> };
    expect(body).toMatchObject({
      deleted: 5,
      ledgerRowsDeleted: { maps_usage: 9, webhook_deliveries_orphaned: 2 },
      ledgerErrors: { webhook_deliveries: 'D1_ERROR: database locked' },
    });
    expect(body.ledgerRowsDeleted).not.toHaveProperty('webhook_deliveries');
  });

  it('a ledger failure does not stop the delivery-log prune', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = deliveriesDb({ expired: 4 });
    const base = db.prepare.getMockImplementation()!;
    db.prepare.mockImplementation((sql: string) => {
      if (!sql.startsWith('DELETE FROM sms_usage ')) return base(sql);
      const stmt = mockStmt();
      stmt.run.mockRejectedValue(new Error('no such table: sms_usage'));
      return stmt;
    });
    const body = await (await prune('internal-tok', db)).json();
    expect(body).toMatchObject({ ledgerRowsDeleted: { webhook_deliveries: 4 }, ledgerErrors: { sms_usage: 'no such table: sms_usage' } });
  });
});
