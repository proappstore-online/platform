import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q' }, db);
}

/** UTC day key for "today", same way the route computes it. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('POST /v1/usage/ping', () => {
  const active = () => mockStmt({ first: { 1: 1 } }); // active subscription

  it('clamps deltaSeconds to 90 and returns the upserted totals', async () => {
    // app exists -> active subscription -> prior row (none) -> upsert
    const appLookup = mockStmt({ first: { id: 'meetup' } });
    const prior = mockStmt({ first: null });
    const upsert = mockStmt();
    const db = mockD1(appLookup, active(), prior, upsert);

    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'meetup', deltaSeconds: 999 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recorded: boolean; day: string; sessionSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe(true);
    expect(body.sessionSeconds).toBeLessThanOrEqual(90);
    expect(body.day).toBe(todayKey());

    // First ping of the day → clamped to the per-ping cap (90), not 999.
    const boundArgs = (upsert.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(boundArgs[3]).toBe(90); // deltaSeconds
    expect(boundArgs[4]).toBe(0); // deltaApiCalls
  });

  it('does NOT record usage for a non-subscriber (Sybil defence, #58)', async () => {
    const appLookup = mockStmt({ first: { id: 'meetup' } });
    const noSub = mockStmt({ first: null }); // no active subscription
    const db = mockD1(appLookup, noSub);

    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'meetup', deltaSeconds: 90 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; recorded: boolean; sessionSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe(false);
    expect(body.sessionSeconds).toBe(0);
    // Only apps + subscription queries ran — no prior-read, no upsert.
    expect((db.prepare as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('binds recorded session time to REAL elapsed wall-clock (#58)', async () => {
    const appLookup = mockStmt({ first: { id: 'meetup' } });
    // Prior ping was ~2s ago — even though the client claims 90s, only ~2s of
    // real time elapsed, so at most ~2s may be recorded.
    const prior = mockStmt({ first: { session_seconds: 100, api_calls: 0, last_seen: Date.now() - 2000 } });
    const upsert = mockStmt();
    const db = mockD1(appLookup, active(), prior, upsert);

    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'meetup', deltaSeconds: 90 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const boundArgs = (upsert.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(boundArgs[3] as number).toBeGreaterThanOrEqual(2);
    expect(boundArgs[3] as number).toBeLessThanOrEqual(4); // ~2s, never the claimed 90
  });

  it('rejects an unknown app with 400 "unknown app"', async () => {
    const appLookup = mockStmt({ first: null });
    const db = mockD1(appLookup);

    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'does-not-exist', deltaSeconds: 30 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/unknown app/i);
  });

  it('rejects an invalid appId format with 400', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'INVALID_App!', deltaSeconds: 30 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid appId/i);
  });

  it('clamps deltaApiCalls to 1000', async () => {
    const appLookup = mockStmt({ first: { id: 'meetup' } });
    const prior = mockStmt({ first: null });
    const upsert = mockStmt();
    const db = mockD1(appLookup, active(), prior, upsert);

    const res = await app.request(
      '/v1/usage/ping',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'meetup', deltaApiCalls: 99999 }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const boundArgs = (upsert.bind as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(boundArgs[4]).toBe(1000);
  });
});

describe('GET /v1/apps/:id/usage', () => {
  it('404s when the user is not the app owner', async () => {
    // requireAppOwner: SELECT creator_id FROM apps -> null
    const owner = mockStmt({ first: null });
    const db = mockD1(owner);
    const res = await app.request(
      '/v1/apps/somebody-elses/usage',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(404);
  });

  it('clamps days to 1..365', async () => {
    // days=9999 should clamp to 365. We can verify by inspecting the response
    // and the SQL binds for the aggregation query.
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const series = mockStmt({ all: { results: [] } });
    const totals = mockStmt({ first: { session_seconds: 0, api_calls: 0, users: 0 } });
    const db = mockD1(owner, series, totals);

    const res = await app.request(
      '/v1/apps/meetup/usage?days=9999',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; series: unknown[] };
    expect(body.days).toBe(365);
    expect(body.series).toHaveLength(365);
  });

  it('clamps days to a minimum of 1', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const series = mockStmt({ all: { results: [] } });
    const totals = mockStmt({ first: { session_seconds: 0, api_calls: 0, users: 0 } });
    const db = mockD1(owner, series, totals);

    const res = await app.request(
      '/v1/apps/meetup/usage?days=0',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: number; series: unknown[] };
    expect(body.days).toBe(1);
    expect(body.series).toHaveLength(1);
  });

  it('with no data returns a fully-filled zero series and zero totals', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const series = mockStmt({ all: { results: [] } });
    const totals = mockStmt({ first: { session_seconds: 0, api_calls: 0, users: 0 } });
    const db = mockD1(owner, series, totals);

    const res = await app.request(
      '/v1/apps/meetup/usage',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      appId: string;
      days: number;
      series: { day: string; sessionSeconds: number; apiCalls: number; users: number }[];
      totals: { sessionSeconds: number; apiCalls: number; users: number };
    };
    expect(body.appId).toBe('meetup');
    expect(body.days).toBe(30);
    expect(body.series).toHaveLength(30);
    for (const row of body.series) {
      expect(row.sessionSeconds).toBe(0);
      expect(row.apiCalls).toBe(0);
      expect(row.users).toBe(0);
      expect(row.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(body.totals).toEqual({ sessionSeconds: 0, apiCalls: 0, users: 0 });

    // Last entry should be today.
    expect(body.series[body.series.length - 1]!.day).toBe(todayKey());
  });

  it('merges real per-day rows over the zero-filled window and reports totals', async () => {
    const owner = mockStmt({ first: { creator_id: 'gh:1' } });
    const today = todayKey();
    const dailyRow = {
      day: today,
      session_seconds: 1234,
      api_calls: 56,
      users: 12,
    };
    const series = mockStmt({ all: { results: [dailyRow] } });
    const totals = mockStmt({ first: { session_seconds: 1234, api_calls: 56, users: 12 } });
    const db = mockD1(owner, series, totals);

    const res = await app.request(
      '/v1/apps/meetup/usage?days=7',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      series: { day: string; sessionSeconds: number; apiCalls: number; users: number }[];
      totals: { sessionSeconds: number; apiCalls: number; users: number };
    };
    expect(body.days).toBe(7);
    expect(body.series).toHaveLength(7);
    const todayEntry = body.series[body.series.length - 1]!;
    expect(todayEntry.day).toBe(today);
    expect(todayEntry.sessionSeconds).toBe(1234);
    expect(todayEntry.apiCalls).toBe(56);
    expect(todayEntry.users).toBe(12);
    expect(body.totals).toEqual({ sessionSeconds: 1234, apiCalls: 56, users: 12 });
  });
});

describe('GET /v1/usage/me', () => {
  it('returns per-app aggregates for the signed-in user only', async () => {
    const rows = [
      { app_id: 'kanban', session_seconds: 300, api_calls: 10 },
      { app_id: 'meetup', session_seconds: 600, api_calls: 5 },
    ];
    const me = mockStmt({ all: { results: rows } });
    const db = mockD1(me);

    const res = await app.request(
      '/v1/usage/me',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userId: string;
      days: number;
      perApp: { appId: string; sessionSeconds: number; apiCalls: number }[];
      totals: { sessionSeconds: number; apiCalls: number };
    };
    expect(body.userId).toBe('gh:1');
    expect(body.days).toBe(30);
    expect(body.perApp).toEqual([
      { appId: 'kanban', sessionSeconds: 300, apiCalls: 10 },
      { appId: 'meetup', sessionSeconds: 600, apiCalls: 5 },
    ]);
    expect(body.totals).toEqual({ sessionSeconds: 900, apiCalls: 15 });

    // Scoping check: the query must be bound with the authed user's id.
    const bindCalls = (me.bind as ReturnType<typeof vi.fn>).mock.calls;
    expect(bindCalls.length).toBeGreaterThan(0);
    const boundArgs = bindCalls[0] as unknown[];
    expect(boundArgs[0]).toBe('gh:1');
  });

  it('returns empty perApp and zero totals when the user has no rows', async () => {
    const me = mockStmt({ all: { results: [] } });
    const db = mockD1(me);
    const res = await app.request(
      '/v1/usage/me?days=14',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      perApp: unknown[];
      totals: { sessionSeconds: number; apiCalls: number };
    };
    expect(body.days).toBe(14);
    expect(body.perApp).toEqual([]);
    expect(body.totals).toEqual({ sessionSeconds: 0, apiCalls: 0 });
  });
});

describe('GET /v1/usage/owner-summary', () => {
  it('returns all zeros when the caller owns no apps (short-circuits the summary query)', async () => {
    const ownedApps = mockStmt({ all: { results: [] } });
    const db = mockD1(ownedApps);
    const res = await app.request(
      '/v1/usage/owner-summary?days=30',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      appCount: number;
      activeUsers: number;
      sessionSeconds: number;
      apiCalls: number;
    };
    expect(body).toEqual({ days: 30, appCount: 0, activeUsers: 0, sessionSeconds: 0, apiCalls: 0 });
    // Only the apps query should have been prepared; no second query.
    expect((db.prepare as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('aggregates session_seconds + api_calls + distinct users across owned apps', async () => {
    const ownedApps = mockStmt({ all: { results: [{ id: 'meetup' }, { id: 'dating' }] } });
    const summary = mockStmt({
      first: { active_users: 42, session_seconds: 12345, api_calls: 678 },
    });
    const db = mockD1(ownedApps, summary);
    const res = await app.request(
      '/v1/usage/owner-summary?days=30',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      days: number;
      appCount: number;
      activeUsers: number;
      sessionSeconds: number;
      apiCalls: number;
    };
    expect(body).toEqual({
      days: 30,
      appCount: 2,
      activeUsers: 42,
      sessionSeconds: 12345,
      apiCalls: 678,
    });
    // The summary query must bind the app ids before the day window.
    const summaryBindCalls = (summary.bind as ReturnType<typeof vi.fn>).mock.calls;
    const bound = summaryBindCalls[0] as unknown[];
    expect(bound[0]).toBe('meetup');
    expect(bound[1]).toBe('dating');
  });

  it('returns zeros (not nulls) when there are owned apps but no rows in the window', async () => {
    const ownedApps = mockStmt({ all: { results: [{ id: 'meetup' }] } });
    // first() returns the COALESCE-zero row even when no rows match
    const summary = mockStmt({
      first: { active_users: 0, session_seconds: 0, api_calls: 0 },
    });
    const db = mockD1(ownedApps, summary);
    const res = await app.request(
      '/v1/usage/owner-summary',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appCount: number; activeUsers: number };
    expect(body.appCount).toBe(1);
    expect(body.activeUsers).toBe(0);
  });

  it('clamps days too-large → 365', async () => {
    const ownedApps = mockStmt({ all: { results: [] } });
    const db = mockD1(ownedApps);
    const res = await app.request(
      '/v1/usage/owner-summary?days=1000',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(((await res.json()) as { days: number }).days).toBe(365);
  });

  it('clamps days malformed → default 30', async () => {
    const ownedApps = mockStmt({ all: { results: [] } });
    const db = mockD1(ownedApps);
    const res = await app.request(
      '/v1/usage/owner-summary?days=abc',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(((await res.json()) as { days: number }).days).toBe(30);
  });
});
