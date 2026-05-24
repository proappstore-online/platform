import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';

const originalFetch = globalThis.fetch;

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0, last_row_id: 42 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
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
    RESEND_API_KEY: 'resend_test_key',
    EMAIL_FROM: 'Test <noreply@proappstore.online>',
    ...overrides,
  };
}

function asUser(id = 'gh:1', extra: Record<string, unknown> = {}) {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ id, login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {}, ...extra }),
      { status: 200 },
    ),
  );
}

beforeEach(() => {
  globalThis.fetch = asUser();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validBody = {
  appId: 'myapp',
  to: 'recipient@example.com',
  subject: 'Hello',
  body: '<p>Hello world</p>',
};

describe('POST /v1/email/send', () => {
  it('returns 503 when RESEND_API_KEY is not set', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({ RESEND_API_KEY: undefined }, mockD1(appsStmt)),
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 for an invalid email address', async () => {
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, to: 'not-an-email' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid email');
  });

  it('returns 400 when subject exceeds 200 characters', async () => {
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, subject: 'x'.repeat(201) }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('subject too long');
  });

  it('returns 400 when body exceeds 50KB', async () => {
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, body: 'x'.repeat(50 * 1024 + 1) }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('body too large');
  });

  it('returns 400 for an invalid replyTo address', async () => {
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...validBody, replyTo: 'not-an-email' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid replyTo');
  });

  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not app owner and not editor', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:other' } });
    const db = mockD1(appsStmt);
    // User gh:1 is neither the owner (gh:other) nor has editor appRole
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('returns 429 when daily rate limit is reached', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    // COUNT(*) returns 100 — at the limit
    const usageStmt = mockStmt({ first: { n: 100 } });
    const db = mockD1(appsStmt, usageStmt);
    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('daily email limit');
  });

  it('returns 200 on success and calls Resend API', async () => {
    const fasMock = asUser('gh:1');
    const resendMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), { status: 200 }),
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('resend.com')) return resendMock(url);
      return fasMock(url);
    });

    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    // COUNT(*) = 0, under limit
    const usageStmt = mockStmt({ first: { n: 0 } });
    // INSERT usage row
    const insertStmt = mockStmt({ run: { meta: { changes: 1, last_row_id: 7 } } });
    const db = mockD1(appsStmt, usageStmt, insertStmt);

    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({}, db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(resendMock).toHaveBeenCalledTimes(1);
  });

  it('inserts usage row BEFORE calling Resend (race condition prevention)', async () => {
    const callOrder: string[] = [];

    const fasMock = asUser('gh:1');
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('resend.com')) {
        callOrder.push('resend');
        return Promise.resolve(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
      }
      return fasMock(url);
    });

    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const usageStmt = mockStmt({ first: { n: 0 } });
    const insertStmt = mockStmt({
      run: {
        meta: {
          changes: 1, last_row_id: 5,
          get _callOrder() {
            callOrder.push('insert');
            return 5;
          },
        },
      },
    });

    // Use a spy-based approach: track D1 prepare call order vs fetch call order
    let insertCalled = false;
    let resendCalledBeforeInsert = false;

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO email_usage')) {
          return {
            bind: vi.fn().mockReturnThis(),
            run: vi.fn().mockImplementation(async () => {
              insertCalled = true;
              return { meta: { changes: 1, last_row_id: 5 } };
            }),
          };
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({ n: 0 }),
          };
        }
        if (sql.includes('SELECT creator_id')) {
          return {
            bind: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({ creator_id: 'gh:1' }),
          };
        }
        // DELETE rollback (not called on success)
        return mockStmt();
      }),
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('resend.com')) {
        resendCalledBeforeInsert = !insertCalled;
        return Promise.resolve(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
      }
      return asUser('gh:1')(url);
    });

    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({ DB: db as unknown as D1Database } as any),
    );

    expect(res.status).toBe(200);
    expect(insertCalled).toBe(true);
    expect(resendCalledBeforeInsert).toBe(false); // insert happened before Resend call
  });

  it('allows an editor role to send email for the app', async () => {
    // gh:1 has appRoles { myapp: ['editor'] } but is NOT the owner
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'gh:1',
          login: 'editor-user',
          avatarUrl: null,
          roles: ['user'],
          appRoles: { myapp: ['editor'] },
        }),
        { status: 200 },
      ),
    );

    const resendMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'e1' }), { status: 200 }),
    );
    const fasMockFn = globalThis.fetch as ReturnType<typeof vi.fn>;
    const originalImpl = fasMockFn.getMockImplementation()!;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('resend.com')) return resendMock(url);
      return originalImpl(url);
    });

    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT creator_id')) {
          return { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ creator_id: 'gh:other' }) };
        }
        if (sql.includes('SELECT COUNT(*)')) {
          return { bind: vi.fn().mockReturnThis(), first: vi.fn().mockResolvedValue({ n: 0 }) };
        }
        if (sql.includes('INSERT INTO email_usage')) {
          return { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ meta: { changes: 1, last_row_id: 1 } }) };
        }
        return mockStmt();
      }),
    };

    const res = await app.request(
      '/v1/email/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody),
      },
      makeEnv({ DB: db as unknown as D1Database } as any),
    );

    expect(res.status).toBe(200);
  });
});
