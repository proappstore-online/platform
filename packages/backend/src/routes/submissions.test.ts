import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock callAdminProvision so we never actually hit the ADMIN service binding.
vi.mock('../lib/provision-client.js', () => ({
  callAdminProvision: vi.fn().mockResolvedValue({ steps: [], success: true }),
}));

import { app } from '../index.js';
import { callAdminProvision } from '../lib/provision-client.js';

const originalFetch = globalThis.fetch;

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) {
    prepare.mockReturnValueOnce(stmt);
  }
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

interface EnvOverrides {
  ADMIN_GITHUB_IDS?: string;
}

function makeEnv(db?: ReturnType<typeof mockD1>, overrides: EnvOverrides = {}) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: 'sign_key',
    FAS_API_BASE: 'https://api.freeappstore.online',
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ADMIN_GITHUB_IDS: overrides.ADMIN_GITHUB_IDS,
    // Stub ADMIN binding — approve handler checks for it, mocked
    // callAdminProvision is what actually runs.
    ADMIN: { fetch: vi.fn() } as unknown as Fetcher,
  };
}

/** Mock /v1/auth/me to return a specific user. */
function mockAuthAs(userId: string, login = 'testuser') {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: userId, login, avatarUrl: null }), { status: 200 }),
  );
}

beforeEach(() => {
  mockAuthAs('gh:1');
  vi.mocked(callAdminProvision).mockReset().mockResolvedValue({ steps: [], success: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /v1/submissions', () => {
  it('creates a pending submission for the authed user', async () => {
    // existing-app check (null), existing-pending check (null), insert
    const existingApp = mockStmt({ first: null });
    const existingPending = mockStmt({ first: null });
    const insert = mockStmt();
    const db = mockD1(existingApp, existingPending, insert);

    const res = await app.request(
      '/v1/submissions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'kanban',
          name: 'Kanban Board',
          category: 'productivity',
          description: 'A simple kanban app.',
          proFeatures: ['cloud-sync'],
          suggestedMonthlyPriceCents: 500,
        }),
      },
      makeEnv(db),
    );

    expect(res.status).toBe(201);
    const data = (await res.json()) as { submission: { status: string; creator_id: string; app_id: string } };
    expect(data.submission.status).toBe('pending');
    expect(data.submission.creator_id).toBe('gh:1');
    expect(data.submission.app_id).toBe('kanban');

    // Verify the INSERT call.
    const insertSql = db.prepare.mock.calls[2][0] as string;
    expect(insertSql).toContain('INSERT INTO submissions');
    expect(insert.bind).toHaveBeenCalledWith(
      expect.any(String), // id
      'kanban',
      'gh:1',
      'Kanban Board',
      'productivity',
      'A simple kanban app.',
      null, // icon
      null, // iconBg
      JSON.stringify(['cloud-sync']),
      500,
      null, // repoUrl
      expect.any(Number),
    );
  });

  it('rejects an invalid appId', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/submissions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'Bad Id!',
          name: 'x',
          category: 'y',
          description: 'z',
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    // Should never have hit the DB.
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending submission for the same appId', async () => {
    const existingApp = mockStmt({ first: null });
    const existingPending = mockStmt({ first: { id: 'sub_other' } });
    const db = mockD1(existingApp, existingPending);

    const res = await app.request(
      '/v1/submissions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'kanban',
          name: 'Kanban',
          category: 'productivity',
          description: 'desc',
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(409);
  });

  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request(
      '/v1/submissions',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'kanban', name: 'K', category: 'c', description: 'd' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/submissions', () => {
  it('as a non-admin returns only the caller\'s own submissions', async () => {
    const listStmt = mockStmt({
      all: {
        results: [
          {
            id: 'sub1',
            app_id: 'mine',
            creator_id: 'gh:1',
            status: 'pending',
            name: 'Mine',
            category: 'productivity',
            description: 'd',
            icon: null,
            icon_bg: null,
            pro_features: null,
            suggested_monthly_price_cents: null,
            repo_url: null,
            reviewer_id: null,
            rejection_reason: null,
            created_at: 1,
            reviewed_at: null,
          },
        ],
      },
    });
    const db = mockD1(listStmt);

    const res = await app.request(
      '/v1/submissions',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { submissions: { creator_id: string }[] };
    expect(data.submissions).toHaveLength(1);
    expect(data.submissions[0].creator_id).toBe('gh:1');

    // Should filter by creator_id in the SQL.
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain('creator_id = ?');
    expect(listStmt.bind).toHaveBeenCalledWith('gh:1');
  });

  it('as an admin returns all submissions', async () => {
    const listStmt = mockStmt({
      all: {
        results: [
          {
            id: 'a',
            app_id: 'one',
            creator_id: 'gh:1',
            status: 'pending',
            name: 'A',
            category: 'c',
            description: 'd',
            icon: null,
            icon_bg: null,
            pro_features: null,
            suggested_monthly_price_cents: null,
            repo_url: null,
            reviewer_id: null,
            rejection_reason: null,
            created_at: 1,
            reviewed_at: null,
          },
          {
            id: 'b',
            app_id: 'two',
            creator_id: 'gh:2',
            status: 'pending',
            name: 'B',
            category: 'c',
            description: 'd',
            icon: null,
            icon_bg: null,
            pro_features: null,
            suggested_monthly_price_cents: null,
            repo_url: null,
            reviewer_id: null,
            rejection_reason: null,
            created_at: 2,
            reviewed_at: null,
          },
        ],
      },
    });
    const db = mockD1(listStmt);

    const res = await app.request(
      '/v1/submissions',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv(db, { ADMIN_GITHUB_IDS: 'gh:1' }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { submissions: unknown[] };
    expect(data.submissions).toHaveLength(2);

    // No creator_id filter on admin path.
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).not.toContain('creator_id = ?');
  });
});

describe('POST /v1/submissions/:id/approve', () => {
  it('returns 403 for non-admin', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/submissions/sub1/approve',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(db, { ADMIN_GITHUB_IDS: 'gh:9999' }),
    );
    expect(res.status).toBe(403);
    expect(callAdminProvision).not.toHaveBeenCalled();
  });

  it('returns 422 when submission is not pending', async () => {
    const fetchStmt = mockStmt({
      first: {
        id: 'sub1',
        app_id: 'kanban',
        creator_id: 'gh:2',
        status: 'approved',
        name: 'K',
        category: 'c',
        description: 'd',
        icon: null,
        icon_bg: null,
        pro_features: null,
        suggested_monthly_price_cents: null,
        repo_url: null,
        reviewer_id: null,
        rejection_reason: null,
        created_at: 1,
        reviewed_at: null,
      },
    });
    const db = mockD1(fetchStmt);

    const res = await app.request(
      '/v1/submissions/sub1/approve',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(db, { ADMIN_GITHUB_IDS: 'gh:1' }),
    );
    expect(res.status).toBe(422);
    expect(callAdminProvision).not.toHaveBeenCalled();
  });

  it('flips status to published when the provisioner succeeds', async () => {
    const pendingRow = {
      id: 'sub1',
      app_id: 'kanban',
      creator_id: 'gh:2',
      status: 'pending',
      name: 'K',
      category: 'c',
      description: 'd',
      icon: null,
      icon_bg: null,
      pro_features: null,
      suggested_monthly_price_cents: null,
      repo_url: null,
      reviewer_id: null,
      rejection_reason: null,
      created_at: 1,
      reviewed_at: null,
    };
    const fetchStmt = mockStmt({ first: pendingRow });
    const updateApprovedStmt = mockStmt();
    const updatePublishedStmt = mockStmt();
    const finalFetchStmt = mockStmt({
      first: { ...pendingRow, status: 'published', reviewer_id: 'gh:1', reviewed_at: 999 },
    });
    const db = mockD1(fetchStmt, updateApprovedStmt, updatePublishedStmt, finalFetchStmt);

    const res = await app.request(
      '/v1/submissions/sub1/approve',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(db, { ADMIN_GITHUB_IDS: 'gh:1' }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { submission: { status: string } };
    expect(data.submission.status).toBe('published');
    expect(callAdminProvision).toHaveBeenCalledTimes(1);
  });
});

describe('POST /v1/submissions/:id/reject', () => {
  it('rejects without a reason → 400', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/submissions/sub1/reject',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(db, { ADMIN_GITHUB_IDS: 'gh:1' }),
    );
    expect(res.status).toBe(400);
  });
});
