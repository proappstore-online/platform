import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const ADMIN_TOKEN = await testToken('gh:1', { roles: ['user', 'admin'], login: 'owner' });

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 1 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(db: ReturnType<typeof mockD1>) {
  return {
    DB: db as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('app roles', () => {
  it('lists role assignments with user and grantor display metadata', async () => {
    const rolesStmt = mockStmt({
      all: {
        results: [{
          user_id: 'gh:42',
          role_name: 'moderator',
          granted_by: 'gh:1',
          granted_at: 1760000000000,
          user_login: 'octocat',
          user_avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4',
          granted_by_login: 'owner',
          granted_by_avatar_url: null,
        }],
      },
    });
    const res = await app.request('/v1/apps/service-exchange/roles', {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    }, makeEnv(mockD1(rolesStmt)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roles: [{
        userId: 'gh:42',
        roleName: 'moderator',
        grantedBy: 'gh:1',
        grantedAt: 1760000000000,
        userLogin: 'octocat',
        userAvatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
        grantedByLogin: 'owner',
        grantedByAvatarUrl: null,
      }],
    });
  });

  it('resolves a GitHub login to a PAS UID when assigning a role', async () => {
    const lookupStmt = mockStmt({ first: null });
    const upsertStmt = mockStmt();
    const deleteLegacyStmt = mockStmt();
    const insertRoleStmt = mockStmt();
    const db = mockD1(lookupStmt, upsertStmt, deleteLegacyStmt, insertRoleStmt);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 42,
      login: 'octocat',
      avatar_url: 'https://avatars.githubusercontent.com/u/42?v=4',
    }), { status: 200 })));

    const res = await app.request('/v1/apps/service-exchange/roles', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: 'octocat', role: 'moderator' }),
    }, makeEnv(db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      appId: 'service-exchange',
      userId: 'gh:42',
      userLogin: 'octocat',
      userAvatarUrl: 'https://avatars.githubusercontent.com/u/42?v=4',
      role: 'moderator',
    });
    expect(deleteLegacyStmt.bind).toHaveBeenCalledWith('service-exchange', 'octocat', 'moderator');
    expect(insertRoleStmt.bind).toHaveBeenCalledWith('service-exchange', 'gh:42', 'moderator', 'gh:1');
  });

  it('checks legacy raw-login role rows for signed-in users', async () => {
    const token = await testToken('gh:42', { roles: ['user'], login: 'octocat' });
    const roleStmt = mockStmt({ first: { 1: 1 } });

    const res = await app.request('/v1/apps/service-exchange/roles/check/moderator', {
      headers: { Authorization: `Bearer ${token}` },
    }, makeEnv(mockD1(roleStmt)));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ has: true, source: 'db' });
    expect(roleStmt.bind).toHaveBeenCalledWith('service-exchange', 'gh:42', 'octocat', 'moderator');
  });
});
