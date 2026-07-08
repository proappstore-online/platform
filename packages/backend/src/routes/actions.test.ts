import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1', { login: 'creator', roles: ['user', 'creator'] });
const MANAGER_TOK = await testToken('gh:2', {
  login: 'manager',
  roles: ['user'],
  appRoles: { interns: ['manager'] },
});

function stmt(opts: { first?: unknown; all?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
  };
}

function db(...stmts: ReturnType<typeof stmt>[]) {
  const prepare = vi.fn();
  for (const s of stmts) prepare.mockReturnValueOnce(s);
  prepare.mockReturnValue(stmt());
  return { prepare } as unknown as D1Database;
}

function env(database: D1Database) {
  return {
    DB: database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    INTERNAL_TOKEN: 'internal-secret',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'list_mine',
    description: 'List mine',
    operation: 'query',
    sql: 'SELECT * FROM items WHERE user_id = :__user_id LIMIT :limit',
    params: { limit: { type: 'integer', default: 20, max: 100, optional: true } },
    requires_auth: true,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/apps/:appId/actions/:name', () => {
  it('executes a registered action with server-injected user id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [{ id: 'item-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10, __user_id: 'attacker' } }),
      },
      env(db(stmt({ first: { manifest: manifest() } }))),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 'item-1' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://data-interns.proappstore.online/query',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOK}`,
          'X-Internal-Token': 'internal-secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { sql: string; params: unknown[] };
    expect(body.sql).toBe('SELECT * FROM items WHERE user_id = ? LIMIT ?');
    expect(body.params).toEqual(['gh:1', 10]);
  });

  it('omits X-Internal-Token when INTERNAL_TOKEN is not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const e = env(db(stmt({ first: { manifest: manifest() } }))) as Record<string, unknown>;
    delete e.INTERNAL_TOKEN;

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10 } }),
      },
      e,
    );

    expect(res.status).toBe(200);
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBeUndefined();
  });

  it('requires a PAS session', async () => {
    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      env(db()),
    );

    expect(res.status).toBe(401);
  });

  it('rejects malformed params instead of silently dropping them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: [] }),
      },
      env(db(stmt({ first: { manifest: manifest() } }))),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces manifest app roles before reaching the data worker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/manager_only',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10 } }),
      },
      env(db(
        stmt({ first: { manifest: manifest({ name: 'manager_only', auth: { app_roles: ['manager'] } }) } }),
        stmt({ all: { results: [{ role_name: 'member' }] } }),
      )),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts manifest app roles from signed session claims', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/manager_only',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${MANAGER_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 5 } }),
      },
      env(db(stmt({ first: { manifest: manifest({ name: 'manager_only', auth: { app_roles: ['manager'] } }) } }))),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
