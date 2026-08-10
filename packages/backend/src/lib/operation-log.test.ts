import { describe, expect, it, vi } from 'vitest';
import {
  classifyOperation,
  recordAuthFailure,
  recordOperationFailure,
  shouldLogOperationFailure,
} from './operation-log.js';
import { resetBurstState } from './log-quota.js';

const NOW = 1_800_000_000_000;

function fakeDb(dayCount = 0) {
  const inserts: unknown[][] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      if (sql.includes('INSERT INTO app_logs')) inserts.push(args);
      return {
        first: vi.fn().mockResolvedValue(sql.includes('app_log_usage') ? { count: dayCount } : null),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
    }),
  }));
  return { DB: { prepare } as unknown as D1Database, inserts, prepare };
}

function fakeErrors() {
  const points: Array<{ indexes: string[]; blobs: string[]; doubles: number[] }> = [];
  return {
    points,
    ERRORS: {
      writeDataPoint: (p: unknown) => points.push(p as never),
    } as unknown as AnalyticsEngineDataset,
  };
}

const failure = {
  appId: 'chess-academy',
  userId: 'gh:7',
  method: 'POST',
  routePath: '/v1/apps/:appId/actions/:name',
  params: { appId: 'chess-academy', name: 'provision_student' },
  status: 403,
  message: 'Only creators can provision',
};

describe('shouldLogOperationFailure', () => {
  it('logs mutation failures from 400 up', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(shouldLogOperationFailure(m, 403)).toBe(true);
      expect(shouldLogOperationFailure(m, 500)).toBe(true);
    }
  });

  it('ignores read failures below 500 as browsing noise', () => {
    expect(shouldLogOperationFailure('GET', 401)).toBe(false);
    expect(shouldLogOperationFailure('GET', 404)).toBe(false);
    expect(shouldLogOperationFailure('GET', 500)).toBe(true);
  });

  it('ignores successes', () => {
    expect(shouldLogOperationFailure('POST', 200)).toBe(false);
    expect(shouldLogOperationFailure('POST', 302)).toBe(false);
  });

  it('excludes the log endpoints so a failed upload cannot write a log row', () => {
    expect(shouldLogOperationFailure('POST', 400, '/v1/apps/:appId/logs')).toBe(false);
    expect(shouldLogOperationFailure('GET', 500, '/v1/apps/:appId/logs/groups')).toBe(false);
    // Neighbouring routes are unaffected.
    expect(shouldLogOperationFailure('POST', 400, '/v1/apps/:appId/actions/:name')).toBe(true);
  });
});

describe('classifyOperation', () => {
  it('names the action that failed, not just "an action"', () => {
    expect(classifyOperation(failure)).toEqual({
      category: 'action',
      operation: 'provision_student',
    });
  });

  it('maps known route families to categories', () => {
    expect(classifyOperation({ method: 'POST', routePath: '/v1/apps/:appId/db/query', params: {} }).category).toBe('db');
    expect(classifyOperation({ method: 'POST', routePath: '/v1/apps/:appId/invites', params: {} }).category).toBe('invites');
    expect(classifyOperation({ method: 'POST', routePath: '/v1/apps/:appId/roles', params: {} }).category).toBe('roles');
  });

  it('falls back to the segment for an unmapped route rather than dropping it', () => {
    const out = classifyOperation({ method: 'POST', routePath: '/v1/apps/:appId/widgets/x', params: {} });
    expect(out.category).toBe('widgets');
  });

  it('handles a route with no app segment at all', () => {
    expect(classifyOperation({ method: 'POST', routePath: '/v1/health', params: {} }).category).toBe('app');
  });
});

describe('recordOperationFailure', () => {
  it('writes one app_logs row with structured context', async () => {
    resetBurstState();
    const db = fakeDb();
    const errors = fakeErrors();
    await recordOperationFailure({ DB: db.DB, ERRORS: errors.ERRORS }, failure, NOW);

    expect(db.inserts).toHaveLength(1);
    const row = db.inserts[0];
    expect(row[0]).toBe('chess-academy');
    expect(row[1]).toBe('gh:7');
    const data = JSON.parse(row[6] as string);
    expect(data).toMatchObject({ operation: 'provision_student', status: 403, authMode: 'legacy-bearer' });
  });

  it('uses warn for 4xx and error for 5xx', async () => {
    resetBurstState();
    const warn = fakeDb();
    await recordOperationFailure({ DB: warn.DB }, failure, NOW);
    expect(warn.inserts[0][3]).toBe('warn');

    resetBurstState();
    const err = fakeDb();
    await recordOperationFailure({ DB: err.DB }, { ...failure, status: 500 }, NOW);
    expect(err.inserts[0][3]).toBe('error');
  });

  it('infers platform-cookie auth mode from the mediation header', async () => {
    resetBurstState();
    const db = fakeDb();
    await recordOperationFailure({ DB: db.DB }, { ...failure, mediated: true }, NOW);
    expect(JSON.parse(db.inserts[0][6] as string).authMode).toBe('platform-cookie');
  });

  it('never logs request params, bodies, or SQL', async () => {
    resetBurstState();
    const db = fakeDb();
    await recordOperationFailure(
      { DB: db.DB },
      { ...failure, message: 'insert failed for password=hunter2' },
      NOW,
    );
    const row = db.inserts[0].join(' ');
    expect(row).not.toContain('hunter2');
    expect(row).toContain('[redacted]');
    // The data payload is a fixed set of keys — no passthrough of caller input.
    expect(Object.keys(JSON.parse(db.inserts[0][6] as string)).sort()).toEqual(
      ['authMode', 'cfRay', 'method', 'operation', 'route', 'status'],
    );
  });

  it('groups the same operation failure across users', async () => {
    resetBurstState();
    const a = fakeDb();
    await recordOperationFailure({ DB: a.DB }, failure, NOW);
    resetBurstState();
    const b = fakeDb();
    await recordOperationFailure({ DB: b.DB }, { ...failure, userId: 'gh:99' }, NOW);
    expect(a.inserts[0][7]).toBe(b.inserts[0][7]);
  });

  it('counts in AE but skips the row when the app is over its daily budget', async () => {
    resetBurstState();
    const db = fakeDb(999_999);
    const errors = fakeErrors();
    await recordOperationFailure({ DB: db.DB, ERRORS: errors.ERRORS }, failure, NOW);
    expect(errors.points).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('counts but never persists a row for an unauthenticated caller', async () => {
    // Otherwise anyone could POST junk to /v1/apps/<victim>/actions/x, take the
    // 400, and mint a source='server' row in that app's log — the cross-app
    // spoofing #108 closed, via the most-trusted tier.
    resetBurstState();
    const db = fakeDb();
    const errors = fakeErrors();
    await recordOperationFailure(
      { DB: db.DB, ERRORS: errors.ERRORS },
      { ...failure, userId: null },
      NOW,
    );
    expect(errors.points).toHaveLength(1);
    expect(db.inserts).toHaveLength(0);
  });

  it('never throws when the database fails', async () => {
    resetBurstState();
    const DB = {
      prepare: () => {
        throw new Error('D1 down');
      },
    } as unknown as D1Database;
    await expect(recordOperationFailure({ DB }, failure, NOW)).resolves.toBeUndefined();
  });
});

describe('recordAuthFailure', () => {
  it('counts a lockout under the platform index with no identifier', async () => {
    const errors = fakeErrors();
    await recordAuthFailure(errors.ERRORS ? { ERRORS: errors.ERRORS } : {}, {
      reason: 'lockout',
      status: 429,
      cfRay: 'ray-1',
    });
    expect(errors.points).toHaveLength(1);
    expect(errors.points[0].indexes).toEqual(['platform']);
    expect(errors.points[0].blobs).toContain('auth.credentials');
    expect(errors.points[0].blobs.join(' ')).not.toContain('@');
  });

  it('uses one reason for both invalid-login branches so metrics cannot enumerate accounts', async () => {
    const a = fakeErrors();
    await recordAuthFailure({ ERRORS: a.ERRORS }, { reason: 'invalid_credentials', status: 401 });
    const b = fakeErrors();
    await recordAuthFailure({ ERRORS: b.ERRORS }, { reason: 'invalid_credentials', status: 401 });
    expect(a.points[0].blobs).toEqual(b.points[0].blobs);
  });

  it('is a no-op without the dataset binding', async () => {
    await expect(recordAuthFailure({}, { reason: 'lockout', status: 429 })).resolves.toBeUndefined();
  });
});
