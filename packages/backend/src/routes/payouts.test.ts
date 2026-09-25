import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { computeMonthPreview } from './payouts.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'q', CF_ANALYTICS_API_TOKEN: 'analytics-token' }, db);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
});

afterEach(() => vi.unstubAllGlobals());

// ── Pure-math unit tests on computeMonthPreview ─────────────────────────

const fakeBucket = {
  month: '2026-05',
  startDay: '2026-05-01',
  endDay: '2026-05-31',
  isCurrent: true,
  daysCovered: 20,
  totalDays: 31,
};

describe('computeMonthPreview', () => {
  it('returns zeros when there are no usage rows', () => {
    const r = computeMonthPreview(fakeBucket, new Set(['meetup']), []);
    expect(r.activeUsers).toBe(0);
    expect(r.estimatedCents).toBe(0);
    expect(r.perApp).toEqual([]);
  });

  it('sends 100% of a subscriber’s pool slice to a sole-app creator', () => {
    // One user, all 1000s of their usage in `meetup` (creator owns meetup only).
    const r = computeMonthPreview(
      fakeBucket,
      new Set(['meetup']),
      [{ user_id: 'gh:42', app_id: 'meetup', sec: 1000 }],
    );
    expect(r.activeUsers).toBe(1);
    expect(r.estimatedCents).toBe(450); // full $4.50 / 450c
    expect(r.perApp).toEqual([{ appId: 'meetup', estimatedCents: 450 }]);
  });

  it('splits proportionally when a user spends time across multiple apps', () => {
    // gh:42 spent 80% in meetup, 20% in dating. Creator owns meetup only.
    const r = computeMonthPreview(
      fakeBucket,
      new Set(['meetup']),
      [
        { user_id: 'gh:42', app_id: 'meetup', sec: 800 },
        { user_id: 'gh:42', app_id: 'dating', sec: 200 },
      ],
    );
    // 0.8 * 450 = 360
    expect(r.estimatedCents).toBe(360);
    expect(r.perApp).toEqual([{ appId: 'meetup', estimatedCents: 360 }]);
  });

  it('aggregates across multiple subscribers and multiple owned apps', () => {
    const r = computeMonthPreview(
      fakeBucket,
      new Set(['meetup', 'dating']),
      [
        // gh:1 — 100% meetup
        { user_id: 'gh:1', app_id: 'meetup', sec: 500 },
        // gh:2 — 50/50 meetup/dating
        { user_id: 'gh:2', app_id: 'meetup', sec: 100 },
        { user_id: 'gh:2', app_id: 'dating', sec: 100 },
        // gh:3 — uses a non-owned app only; should contribute 0 to this creator
        { user_id: 'gh:3', app_id: 'other-app', sec: 999 },
      ],
    );
    // gh:1: 450 → meetup
    // gh:2: 225 → meetup, 225 → dating
    // gh:3: 0 (not in owned set)
    expect(r.activeUsers).toBe(3); // active in any app (the third is counted but doesn't contribute)
    expect(r.estimatedCents).toBe(450 + 225 + 225);
    const meetup = r.perApp.find((p) => p.appId === 'meetup')!;
    const dating = r.perApp.find((p) => p.appId === 'dating')!;
    expect(meetup.estimatedCents).toBe(450 + 225);
    expect(dating.estimatedCents).toBe(225);
  });

  it('ignores users whose only usage is on apps the creator doesn’t own', () => {
    const r = computeMonthPreview(
      fakeBucket,
      new Set(['meetup']),
      [
        { user_id: 'gh:1', app_id: 'dating', sec: 1000 },
        { user_id: 'gh:2', app_id: 'other-app', sec: 500 },
      ],
    );
    // activeUsers counts everyone with usage in the window — the share calc just
    // ends up at zero for this creator.
    expect(r.activeUsers).toBe(2);
    expect(r.estimatedCents).toBe(0);
    expect(r.perApp).toEqual([]);
  });

  it('handles zero-second rows without dividing by zero', () => {
    const r = computeMonthPreview(
      fakeBucket,
      new Set(['meetup']),
      [{ user_id: 'gh:1', app_id: 'meetup', sec: 0 }],
    );
    expect(r.estimatedCents).toBe(0);
    expect(r.perApp).toEqual([]);
  });
});

// ── HTTP route tests ────────────────────────────────────────────────────

describe('GET /v1/payouts/me/preview', () => {
  it('returns zero months when the caller owns no apps', async () => {
    const ownedApps = mockStmt({ all: { results: [] } });
    const db = mockD1(ownedApps);
    const res = await app.request(
      '/v1/payouts/me/preview?months=1',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      months: { estimatedCents: number; activeUsers: number }[];
      subscriberPriceCents: number;
    };
    expect(body.subscriberPriceCents).toBe(500);
    expect(body.months.length).toBe(1);
    expect(body.months[0]!.estimatedCents).toBe(0);
    expect(body.months[0]!.activeUsers).toBe(0);
  });

  it('returns the requested number of months (clamped to [1, 12])', async () => {
    const apps1 = mockStmt({ all: { results: [{ id: 'meetup' }] } });
    const db = mockD1(apps1);
    const res = await app.request(
      '/v1/payouts/me/preview?months=100',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { months: unknown[] };
    expect(body.months.length).toBe(12);
  });

  it('aggregates real usage rows to a creator share', async () => {
    const ownedApps = mockStmt({ all: { results: [{ id: 'meetup' }] } });
    const db = mockD1(ownedApps);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url: string, init: RequestInit) => {
      const sql = String(init.body);
      return new Response(JSON.stringify({ data: sql.includes("blob3 = 'usage'")
        ? [{ actor: 'subscriber-hash', app_id: 'meetup', session_seconds: 1000 }]
        : [{ app_id: 'meetup', provider: 'anthropic', model: 'claude-sonnet-4-6', cost_usd: 0.25, tokens_in: 100, tokens_out: 50 }] }), { status: 200 });
    });
    const res = await app.request(
      '/v1/payouts/me/preview?months=1',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { months: { estimatedCents: number; perApp: { appId: string; estimatedCents: number }[]; aiCosts: { provider: string; costUsd: number }[] }[] };
    expect(body.months[0]!.estimatedCents).toBe(450);
    expect(body.months[0]!.perApp).toEqual([{ appId: 'meetup', estimatedCents: 450 }]);
    expect(body.months[0]!.aiCosts).toEqual([expect.objectContaining({ provider: 'anthropic', costUsd: 0.25 })]);
  });

  it('reads the immutable Analytics Engine ledger, not the legacy D1 meter', async () => {
    const ownedApps = mockStmt({ all: { results: [{ id: 'meetup' }] } });
    const db = mockD1(ownedApps);

    await app.request(
      '/v1/payouts/me/preview?months=1',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );

    const d1Sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(d1Sql.some((sql) => /usage_daily/i.test(sql))).toBe(false);
    const aeSql = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[1]?.body));
    expect(aeSql.some((sql) => /pas_payout_meter/i.test(sql))).toBe(true);
    expect(aeSql.some((sql) => /GROUP BY app_id, actor, event_key/i.test(sql))).toBe(true);
  });
});
