import { describe, expect, it } from 'vitest';
import { createBuild, markRunning, finishBuild, listBuilds, rowToBuild } from './builds.ts';

/** Recording mock D1: captures the prepared SQL + bound params, returns canned
 *  rows for .all()/.first(). Lets us assert the queries are well-formed without
 *  a live SQLite. */
function recordingDb(allResults: Record<string, unknown>[] = []) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, params: [] as unknown[] };
      const stmt = {
        bind(...p: unknown[]) {
          call.params = p;
          return stmt;
        },
        async run() {
          calls.push(call);
          return { success: true };
        },
        async all() {
          calls.push(call);
          return { results: allResults };
        },
        async first() {
          calls.push(call);
          return allResults[0] ?? null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, calls };
}

describe('createBuild', () => {
  it('inserts a queued row, idempotent on the delivery id', async () => {
    const { db, calls } = recordingDb();
    await createBuild(db, { id: 'd1', appId: 'clean-up', repo: 'o/clean-up', sha: 'abc', nowMs: 1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/INSERT INTO builds/);
    expect(calls[0]!.sql).toMatch(/ON CONFLICT\(id\) DO NOTHING/);
    expect(calls[0]!.sql).toMatch(/'queued'/);
    expect(calls[0]!.params).toEqual(['d1', 'clean-up', 'o/clean-up', 'abc', 1000]);
  });
});

describe('markRunning', () => {
  it('sets status=running + started_at', async () => {
    const { db, calls } = recordingDb();
    await markRunning(db, 'd1', 2000);
    expect(calls[0]!.sql).toMatch(/UPDATE builds SET status = 'running', started_at = \?2 WHERE id = \?1/);
    expect(calls[0]!.params).toEqual(['d1', 2000]);
  });
});

describe('finishBuild', () => {
  it('sets terminal status, finished_at, reason, and computes duration from started_at', async () => {
    const { db, calls } = recordingDb();
    await finishBuild(db, 'd1', 'failed', 5000, 'NOT_WIRED');
    expect(calls[0]!.sql).toMatch(/UPDATE builds/);
    expect(calls[0]!.sql).toMatch(/duration_ms = CASE WHEN started_at IS NULL THEN NULL ELSE \?3 - started_at END/);
    expect(calls[0]!.params).toEqual(['d1', 'failed', 5000, 'NOT_WIRED']);
  });
  it('defaults reason to null when omitted', async () => {
    const { db, calls } = recordingDb();
    await finishBuild(db, 'd1', 'success', 5000);
    expect(calls[0]!.params).toEqual(['d1', 'success', 5000, null]);
  });
});

describe('listBuilds', () => {
  it('queries recent builds for the app, newest first, and clamps the limit', async () => {
    const { db, calls } = recordingDb();
    await listBuilds(db, 'clean-up', 999); // over the cap
    expect(calls[0]!.sql).toMatch(/WHERE app_id = \?1 ORDER BY created_at DESC LIMIT \?2/);
    expect(calls[0]!.params).toEqual(['clean-up', 100]); // clamped to 100
  });
  it('floors a too-small limit to 1', async () => {
    const { db, calls } = recordingDb();
    await listBuilds(db, 'x', 0);
    expect(calls[0]!.params).toEqual(['x', 1]);
  });
  it('maps rows to the API shape', async () => {
    const { db } = recordingDb([
      { id: 'd1', app_id: 'clean-up', repo: 'o/clean-up', sha: 'abc', status: 'failed', reason: 'NOT_WIRED', created_at: 1000, started_at: 1100, finished_at: 1200, duration_ms: 100 },
    ]);
    const out = await listBuilds(db, 'clean-up');
    expect(out).toEqual([
      { id: 'd1', appId: 'clean-up', repo: 'o/clean-up', sha: 'abc', status: 'failed', reason: 'NOT_WIRED', createdAt: 1000, startedAt: 1100, finishedAt: 1200, durationMs: 100 },
    ]);
  });
});

describe('rowToBuild', () => {
  it('maps snake_case → camelCase and normalizes nulls', () => {
    expect(rowToBuild({ id: 'd', app_id: 'a', repo: 'o/a', sha: 's', status: 'queued', reason: null, created_at: 1, started_at: null, finished_at: null, duration_ms: null })).toEqual({
      id: 'd', appId: 'a', repo: 'o/a', sha: 's', status: 'queued', reason: null, createdAt: 1, startedAt: null, finishedAt: null, durationMs: null,
    });
  });
});
