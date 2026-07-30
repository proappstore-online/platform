import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { RETENTION_DAYS, cutoffMs } from './logs-prune.js';

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
