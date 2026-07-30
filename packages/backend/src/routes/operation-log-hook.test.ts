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
 * Operation logging is deliberately OFF the response path — `waitUntil` in a real
 * Worker, a floating promise when Hono is dispatched without an ExecutionContext
 * (as `app.request` does). So a test must let it settle before asserting; a
 * response alone proves nothing either way.
 */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** A D1 mock that answers by SQL shape and records every app_logs insert. */
function recordingDb() {
  const inserts: unknown[][] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      if (sql.includes('INSERT INTO app_logs')) inserts.push(args);
      const first = sql.includes('app_log_usage')
        ? { count: 0 }
        : sql.includes('FROM apps')
          ? { id: 'chess-academy', creator_id: 'gh:7' }
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

function callAction(token: string | null, db: ReturnType<typeof recordingDb>) {
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
  );
}

describe('failed app operations are logged server-side', () => {
  it('writes an app_logs row naming the action and status for a signed-in caller', async () => {
    resetBurstState();
    const db = recordingDb();
    const res = await callAction(TOK, db);
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
    const res = await callAction(null, db);
    expect(res.status).toBeGreaterThanOrEqual(400);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });

  it('does not log a failed log upload, which would be circular', async () => {
    resetBurstState();
    const db = recordingDb();
    const res = await app.request(
      '/v1/apps/chess-academy/logs',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notEntries: true }),
      },
      sharedMakeEnv({}, db as never),
    );
    expect(res.status).toBe(400);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });

  it('leaves successful requests alone', async () => {
    resetBurstState();
    const db = recordingDb();
    const res = await app.request('/health', {}, sharedMakeEnv({}, db as never));
    expect(res.status).toBe(200);
    await settle();
    expect(db.inserts).toHaveLength(0);
  });
});
