import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { resetBurstState } from '../lib/log-quota.js';

/**
 * End-to-end check on the central onError hook: a failed app operation must land
 * in app_logs without the route knowing anything about logging (ADR-008 step 3).
 *
 * This is what makes platform#106 cover actions, db, rooms, invites and roles at
 * once instead of per-route instrumentation that drifts as routes are added.
 */

const TOK = await testToken('gh:7');

/**
 * Operation logging is deliberately OFF the response path: it goes to `waitUntil`.
 * A response alone proves nothing either way, so every request here runs with an
 * ExecutionContext that captures those promises, and `settle` awaits exactly them
 * before asserting. No fixed sleep: a negative assertion is checked after the
 * background work has finished, not after an interval that may be too short (#582).
 */
function context() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.allSettled(pending) };
}

/** A D1 mock that answers by SQL shape and records every app_logs insert. */
function recordingDb() {
  const inserts: unknown[][] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      if (sql.includes('INSERT INTO app_logs')) inserts.push(args);
      const first = sql.includes('app_log_usage')
        ? { count: 0 }
        : sql.includes('FROM apps')
          ? { id: 'chess-academy', creator_id: 'gh:7', owner: 1, team: 0, role: 0 } // #375: the caller owns the app
          : null;
      return {
        first: vi.fn().mockResolvedValue(first),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
    }),
  }));
  return { prepare, batch: vi.fn().mockResolvedValue([]), inserts };
}

function callAction(token: string | null, db: ReturnType<typeof recordingDb>, ctx: ExecutionContext) {
  return app.request(
    '/v1/apps/chess-academy/actions/provision_student',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ params: {} }),
    },
    sharedMakeEnv({}, db as never),
    ctx,
  );
}

describe('failed app operations are logged server-side', () => {
  it('writes an app_logs row naming the action and status for a signed-in caller', async () => {
    resetBurstState();
    const db = recordingDb();
    const { ctx, settle } = context();
    const res = await callAction(TOK, db, ctx);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(db.inserts).toHaveLength(1);

    const row = db.inserts[0];
    expect(row[0]).toBe('chess-academy');
    expect(row[1]).toBe('gh:7');
    const data = JSON.parse(row[6] as string);
    expect(data.operation).toBe('provision_student');
    expect(data.status).toBe(res.status);
    // source column — the trusted tier
    expect(row.length).toBeGreaterThan(8);
  });

  it('does not write a row for an anonymous caller', async () => {
    resetBurstState();
    const db = recordingDb();
    const { ctx, settle } = context();
    const res = await callAction(null, db, ctx);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });

  it('does not log a failed log upload, which would be circular', async () => {
    resetBurstState();
    const db = recordingDb();
    const { ctx, settle } = context();
    const res = await app.request(
      '/v1/apps/chess-academy/logs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notEntries: true }),
      },
      sharedMakeEnv({}, db as never),
      ctx,
    );
    expect(res.status).toBe(400);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });

  it('leaves successful requests alone', async () => {
    resetBurstState();
    const db = recordingDb();
    const { ctx, settle } = context();
    const res = await app.request('/health', {}, sharedMakeEnv({}, db as never), ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });
});
