import { describe, expect, it, vi, afterEach } from 'vitest';
import { runScheduledActions } from './scheduled-actions.js';

function statement(result: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(result.first ?? null),
    all: vi.fn().mockResolvedValue(result.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(result.run ?? { meta: { changes: 1 } }),
  };
}

function db(...answers: ReturnType<typeof statement>[]) {
  const prepare = vi.fn();
  for (const answer of answers) prepare.mockReturnValueOnce(answer);
  prepare.mockReturnValue(statement());
  return { prepare, batch: vi.fn().mockResolvedValue([]) } as unknown as D1Database;
}

const scheduledManifest = JSON.stringify({
  name: 'reap_stale', description: 'Reap stale rows', operation: 'execute',
  sql: 'DELETE FROM sessions WHERE owner_id != :__user_id AND expires_at < :__now', params: {}, requires_auth: true,
  auth: { caller_unscoped: { reason: 'maintenance has no caller' } },
  schedule: { cron: '*/5 * * * *', params: {} },
});

function env(DB: D1Database) {
  return { DB, DATA_WORKER_HOST: 'workers.test', INTERNAL_TOKEN: 'internal' } as never;
}

/** Small stateful D1 double for the breaker: each failed dispatch increments
 * the persisted streak and the sixth matching tick observes the disabled row. */
function breakerDb() {
  let failures = 0;
  let disabledAt: number | null = null;
  let nextRun = 0;
  let alerts = 0;
  const prepare = vi.fn((sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => { args = values; return stmt; },
      all: async () => {
        if (sql.includes('FROM app_tools')) return { results: [{ app_id: 'chess', name: 'reap_stale', manifest: scheduledManifest, source: 'code' }] };
        return { results: [] }; // stale claims and owner webhooks
      },
      first: async () => {
        if (sql.includes('SELECT schedule_disabled_at')) return disabledAt === null ? null : { schedule_disabled_at: disabledAt };
        if (sql.includes('SELECT 1 AS active')) return null;
        if (sql.includes('SELECT run_id')) return { run_id: `run-${nextRun}` };
        if (sql.includes('SELECT consecutive_failures')) return { consecutive_failures: failures, schedule_disabled_at: disabledAt };
        return null;
      },
      run: async () => {
        if (sql.startsWith('UPDATE scheduled_action_runs SET status = \'claimed\'')) { nextRun += 1; return { meta: { changes: 1 } }; }
        if (sql.startsWith('UPDATE scheduled_action_runs SET status = \'failed\'')) return { meta: { changes: 1 } };
        if (sql.includes('INSERT INTO scheduled_action_state')) {
          failures += 1;
          if (failures >= 5) disabledAt = args.at(-1) as number;
          return { meta: { changes: 1 } };
        }
        if (sql.includes('INSERT OR IGNORE INTO app_alerts')) { alerts += 1; return { meta: { changes: 1 } }; }
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  });
  return { DB: { prepare, batch: vi.fn() } as unknown as D1Database, alertCount: () => alerts };
}

afterEach(() => vi.unstubAllGlobals());

describe('runScheduledActions (#123)', () => {
  it('claims one due minute and executes through the prepared internal data-worker path as system:schedule', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ meta: { changes: 3 } }));
    vi.stubGlobal('fetch', fetch);
    const report = await runScheduledActions({ env: env(db(
      statement({ all: { results: [] } }), // stale claims
      statement({ all: { results: [{ app_id: 'chess', name: 'reap_stale', manifest: scheduledManifest, source: 'code' }] } }),
      statement({ first: null }), // disabled
      statement({ first: null }), // active claim
      statement(), // insert due
      statement({ run: { meta: { changes: 1 } } }), // claim
      statement({ first: { run_id: 'run-1' } }), // read the durable claimed UUID
    )), now: Date.UTC(2026, 8, 25, 10, 5) });

    expect(report).toMatchObject({ due: 1, claimed: 1, succeeded: 1, failed: 0 });
    expect(fetch).toHaveBeenCalledWith('https://pas-data-chess.workers.test/execute', expect.objectContaining({
      headers: { 'X-Internal-Token': 'internal', 'Content-Type': 'application/json' },
    }));
    const body = JSON.parse(fetch.mock.calls[0]![1].body as string) as { params: unknown[] };
    expect(body.params[0]).toBe('system:schedule');
  });

  it('does not backfill a missed minute and skips an action that is still claimed', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const missed = await runScheduledActions({ env: env(db(
      statement({ all: { results: [] } }),
      statement({ all: { results: [{ app_id: 'chess', name: 'reap_stale', manifest: JSON.stringify({ ...JSON.parse(scheduledManifest), schedule: { cron: '*/15 * * * *', params: {} } }), source: 'code' }] } }),
    )), now: Date.UTC(2026, 8, 25, 10, 5) });
    expect(missed).toMatchObject({ due: 0, claimed: 0 });

    const active = await runScheduledActions({ env: env(db(
      statement({ all: { results: [] } }),
      statement({ all: { results: [{ app_id: 'chess', name: 'reap_stale', manifest: scheduledManifest, source: 'code' }] } }),
      statement({ first: null }),
      statement({ first: { active: 1 } }),
    )), now: Date.UTC(2026, 8, 25, 10, 5) });
    expect(active).toMatchObject({ due: 1, claimed: 0, skipped: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses an atomic no-live-claim predicate when it claims a due minute', async () => {
    const database = db(
      statement({ all: { results: [] } }),
      statement({ all: { results: [{ app_id: 'chess', name: 'reap_stale', manifest: scheduledManifest, source: 'code' }] } }),
      statement({ first: null }),
      statement({ first: null }),
      statement(),
      statement({ run: { meta: { changes: 0 } } }),
    );
    await runScheduledActions({ env: env(database), now: Date.UTC(2026, 8, 25, 10, 5) });
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("AND NOT EXISTS (SELECT 1 FROM scheduled_action_runs AS active"));
  });

  it('recovers a stale claim as a durable failure before considering new work', async () => {
    const report = await runScheduledActions({ env: env(db(
      statement({ all: { results: [{ run_id: 'old', app_id: 'chess', action_name: 'reap_stale', source: 'code', claimed_at: 0 }] } }),
      statement({ run: { meta: { changes: 1 } } }), // mark stale run failed
      statement(), // increment failure state
      statement({ first: { consecutive_failures: 1, schedule_disabled_at: null } }),
      statement({ all: { results: [] } }), // tools
    )), now: Date.UTC(2026, 8, 25, 10, 5) });
    expect(report).toMatchObject({ recovered: 1, due: 0 });
  });

  it('disables and alerts after five consecutive failures, then skips later due ticks', async () => {
    const database = breakerDb();
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('data worker unavailable', { status: 503 }))));
    const base = Date.UTC(2026, 8, 25, 10, 0);
    for (let i = 0; i < 5; i++) {
      const report = await runScheduledActions({ env: env(database.DB), now: base + i * 5 * 60_000 });
      expect(report).toMatchObject({ due: 1, claimed: 1, failed: 1 });
    }
    expect(database.alertCount()).toBe(1);
    const disabled = await runScheduledActions({ env: env(database.DB), now: base + 25 * 60_000 });
    expect(disabled).toMatchObject({ due: 1, claimed: 0, skipped: 1 });
  });
});
