import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { TEST_SK, testToken } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function stmt(first: unknown = null, all: unknown = { results: [] }) {
  return { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue(first), all: vi.fn().mockResolvedValue(all) };
}

function env(...statements: ReturnType<typeof stmt>[]) {
  const prepare = vi.fn();
  for (const item of statements) prepare.mockReturnValueOnce(item);
  prepare.mockReturnValue(stmt());
  return {
    DB: { prepare } as unknown as D1Database, STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh', SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf', CF_ACCOUNT_ID: 'acct', DATA_WORKER_HOST: 'workers.test',
  };
}

describe('GET /v1/apps/:appId/scheduled-runs (#123)', () => {
  it('is owner-only and returns private history with optional status filter', async () => {
    const database = env(
      stmt({ creator_id: 'gh:1' }),
      stmt(null, { results: [{ run_id: 'r1', app_id: 'chess', action_name: 'reap', source: 'code', due_at: 1, claimed_at: 2, finished_at: 3, status: 'failed', changes: null, error: 'timeout' }] }),
    );
    const res = await app.request('/v1/apps/chess/scheduled-runs?status=failed&limit=10', { headers: { Authorization: `Bearer ${TOK}` } }, database);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toMatchObject({ runs: [{ action_name: 'reap', status: 'failed', error: 'timeout' }] });
    expect(database.DB.prepare).toHaveBeenLastCalledWith(expect.stringContaining('AND status = ?'));
  });

  it('refuses a signed-in user who does not own the app, before reading any run', async () => {
    // chess is owned by gh:9; gh:1 is not on its team.
    const database = env(stmt({ creator_id: 'gh:9' }), stmt(null));
    const res = await app.request('/v1/apps/chess/scheduled-runs', { headers: { Authorization: `Bearer ${TOK}` } }, database);
    expect(res.status).toBe(403);
    expect(database.DB.prepare).not.toHaveBeenCalledWith(expect.stringContaining('scheduled_action_runs'));
  });

  it("refuses another app's owner: owning one app grants nothing on another", async () => {
    // gh:1 owns `bingo`, then asks for `chess` (owned by gh:9).
    const own = env(stmt({ creator_id: 'gh:1' }));
    expect((await app.request('/v1/apps/bingo/scheduled-runs', { headers: { Authorization: `Bearer ${TOK}` } }, own)).status).toBe(200);
    const other = env(stmt({ creator_id: 'gh:9' }), stmt(null));
    expect((await app.request('/v1/apps/chess/scheduled-runs', { headers: { Authorization: `Bearer ${TOK}` } }, other)).status).toBe(403);
  });

  it('scopes the history query to the requested app', async () => {
    const runs = stmt(null, { results: [] });
    const database = env(stmt({ creator_id: 'gh:1' }), runs);
    const res = await app.request('/v1/apps/bingo/scheduled-runs', { headers: { Authorization: `Bearer ${TOK}` } }, database);
    expect(res.status).toBe(200);
    expect(database.DB.prepare).toHaveBeenLastCalledWith(expect.stringContaining('FROM scheduled_action_runs WHERE app_id = ?'));
    expect(runs.bind.mock.calls[0]![0]).toBe('bingo');
  });

  it('rejects invalid statuses after authenticating the owner', async () => {
    const res = await app.request('/v1/apps/chess/scheduled-runs?status=nope', { headers: { Authorization: `Bearer ${TOK}` } }, env(stmt({ creator_id: 'gh:1' })));
    expect(res.status).toBe(400);
  });
});
