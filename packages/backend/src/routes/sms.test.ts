import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

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
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'auth_test',
    TWILIO_FROM_NUMBER: '+15550000000',
    ...overrides,
  };
}

describe('POST /v1/sms/send', () => {
  it('returns 503 when Twilio is not configured', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: '+15551234567', message: 'hi' }),
      },
      makeEnv({ TWILIO_ACCOUNT_SID: undefined }, mockD1(appsStmt)),
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 when fields missing', async () => {
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-E.164 number', async () => {
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: '555-1234', message: 'hi' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: '+15551234567', message: 'hi' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when caller is not the app creator', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:other' } });
    const db = mockD1(appsStmt);
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: '+15551234567', message: 'hi' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when app does not exist', async () => {
    const appsStmt = mockStmt({ first: null });
    const db = mockD1(appsStmt);
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'noapp', to: '+15551234567', message: 'hi' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('sends a single SMS via Twilio and returns {sent:1, failed:0}', async () => {
    const twilioMock = vi.fn().mockResolvedValue(new Response('{"sid":"SM1"}', { status: 201 }));
    globalThis.fetch = vi.fn().mockImplementation((url: string) => twilioMock(url));

    const rateLimitStmt = mockStmt({ first: { cnt: 0 } });
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(rateLimitStmt, appsStmt);

    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: '+15551234567', message: 'class in 1h' }),
      },
      makeEnv({}, db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0 });
    expect(twilioMock).toHaveBeenCalledTimes(1);

    const [url] = twilioMock.mock.calls[0];
    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json');
  });

  it('broadcasts to many numbers and aggregates results', async () => {
    let twilioCalls = 0;
    const twilioMock = vi.fn().mockImplementation(() => {
      twilioCalls++;
      // Fail the second send, succeed others
      return twilioCalls === 2
        ? Promise.resolve(new Response('', { status: 400 }))
        : Promise.resolve(new Response('{"sid":"SM1"}', { status: 201 }));
    });
    globalThis.fetch = vi.fn().mockImplementation(() => twilioMock());

    const rateLimitStmt = mockStmt({ first: { cnt: 0 } });
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(rateLimitStmt, appsStmt);

    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: 'myapp',
          to: ['+15551111111', '+15552222222', '+15553333333'],
          message: 'reminder',
        }),
      },
      makeEnv({}, db),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 1 });
    expect(twilioMock).toHaveBeenCalledTimes(3);
  });

  it('returns 400 if `to` is an empty array', async () => {
    const res = await app.request(
      '/v1/sms/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: 'myapp', to: [], message: 'hi' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});
