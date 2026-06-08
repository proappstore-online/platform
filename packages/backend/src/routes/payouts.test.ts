import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { computeMonthPreview } from './payouts.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockStmt(opts: { first?: unknown; all?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
  };
}

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
    expect(r.estimatedCents).toBe(810); // full $8.10 / 810c
    expect(r.perApp).toEqual([{ appId: 'meetup', estimatedCents: 810 }]);
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
    // 0.8 * 810 = 648
    expect(r.estimatedCents).toBe(648);
    expect(r.perApp).toEqual([{ appId: 'meetup', estimatedCents: 648 }]);
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
    // gh:1: 810 → meetup
    // gh:2: 405 → meetup, 405 → dating
    // gh:3: 0 (not in owned set)
    expect(r.activeUsers).toBe(3); // active in any app (the third is counted but doesn't contribute)
    expect(r.estimatedCents).toBe(810 + 405 + 405);
    const meetup = r.perApp.find((p) => p.appId === 'meetup')!;
    const dating = r.perApp.find((p) => p.appId === 'dating')!;
    expect(meetup.estimatedCents).toBe(810 + 405);
    expect(dating.estimatedCents).toBe(405);
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
    expect(body.subscriberPriceCents).toBe(900);
    expect(body.months.length).toBe(1);
    expect(body.months[0]!.estimatedCents).toBe(0);
    expect(body.months[0]!.activeUsers).toBe(0);
  });

  it('returns the requested number of months (clamped to [1, 12])', async () => {
    const apps1 = mockStmt({ all: { results: [{ id: 'meetup' }] } });
    const usage = mockStmt({ all: { results: [] } });
    const db = mockD1(apps1, usage, usage, usage); // owned + N month queries
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
    // One subscriber, 100% in meetup.
    const usage = mockStmt({
      all: { results: [{ user_id: 'gh:99', app_id: 'meetup', sec: 1000 }] },
    });
    const db = mockD1(ownedApps, usage);
    const res = await app.request(
      '/v1/payouts/me/preview?months=1',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { months: { estimatedCents: number; perApp: { appId: string; estimatedCents: number }[] }[] };
    expect(body.months[0]!.estimatedCents).toBe(810);
    expect(body.months[0]!.perApp).toEqual([{ appId: 'meetup', estimatedCents: 810 }]);
  });
});
