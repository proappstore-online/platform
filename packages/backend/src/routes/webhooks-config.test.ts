import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

// requireAppOwner calls DB after auth, so we need two stmts: apps row for ownership check
function ownerDb(creatorId = 'gh:1') {
  return mockD1(mockStmt({ first: { creator_id: creatorId } }));
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }),
      { status: 200 },
    ),
  );
});
describe('POST /v1/apps/:appId/webhooks — register', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://example.com/hook' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not the app owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:other' } }));
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://example.com/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 for non-HTTPS webhook URL', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'http://example.com/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('HTTPS');
  });

  it('returns 400 for localhost URL', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://localhost/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('private');
  });

  it('returns 400 for 127.0.0.1', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://127.0.0.1/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('private');
  });

  it('returns 400 for 10.x private IP', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://10.0.0.1/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('private');
  });

  it('returns 400 for 192.168.x private IP', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://192.168.1.100/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('private');
  });

  it('returns 400 for AWS metadata IP 169.254.169.254', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://169.254.169.254/latest/meta-data/' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('private');
  });

  it('returns 400 for unsupported event type', async () => {
    const db = ownerDb();
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'user.deleted', url: 'https://example.com/hook' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unsupported event');
  });

  it('returns 200 with id and secret for a valid registration', async () => {
    // First call: apps row for ownership (requireAppOwner)
    // Second call: INSERT
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const insertStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(appsStmt, insertStmt);

    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'storage.uploaded', url: 'https://example.com/hook' }),
      },
      makeEnv({}, db),
    );

    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; secret: string };
    expect(typeof data.id).toBe('string');
    expect(data.id.length).toBeGreaterThan(0);
    expect(typeof data.secret).toBe('string');
    expect(data.secret.length).toBeGreaterThan(0);
  });

  it('accepts notification.sent as a supported event', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const insertStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(appsStmt, insertStmt);

    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'notification.sent', url: 'https://hooks.example.com/pas' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });
});

describe('DELETE /v1/apps/:appId/webhooks/:id — remove', () => {
  it('returns 404 when webhook does not exist', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    // DELETE returns changes: 0 — no row matched
    const deleteStmt = mockStmt({ run: { meta: { changes: 0 } } });
    const db = mockD1(appsStmt, deleteStmt);

    const res = await app.request(
      '/v1/apps/myapp/webhooks/nonexistent-id',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOK}` },
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('not found');
  });

  it('returns 200 when webhook is deleted successfully', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const deleteStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(appsStmt, deleteStmt);

    const res = await app.request(
      '/v1/apps/myapp/webhooks/hook-uuid-123',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOK}` },
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 403 when caller is not the app owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:other' } }));
    const res = await app.request(
      '/v1/apps/myapp/webhooks/hook-uuid-123',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOK}` },
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/apps/:appId/webhooks — list', () => {
  it('returns the list of webhooks for the owner', async () => {
    const appsStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const listStmt = mockStmt({
      all: {
        results: [
          { id: 'w1', event: 'storage.uploaded', url: 'https://example.com/hook', active: 1, created_at: 1000 },
        ],
      },
    });
    const db = mockD1(appsStmt, listStmt);

    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const data = await res.json() as { webhooks: unknown[] };
    expect(data.webhooks).toHaveLength(1);
  });

  it('returns 403 when caller is not the app owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:other' } }));
    const res = await app.request(
      '/v1/apps/myapp/webhooks',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/apps/:appId/webhooks/:id/test — fire a test event (#226)', () => {
  const HOOK_URL = 'https://hooks.example.com/in';

  function hookDb() {
    return mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { url: HOOK_URL, secret: 's3cret', event: 'storage.uploaded' } }),
    );
  }

  /** Route the receiver URL to `receiver`; anything else gets the default mock. */
  function mockReceiver(receiver: (init: RequestInit) => Promise<Response>) {
    const fallback = globalThis.fetch as ReturnType<typeof vi.fn>;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === HOOK_URL ? receiver(init ?? {}) : fallback(input, init));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function receiverCalls(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(([input]) => String(input) === HOOK_URL);
  }

  function fireTest(db = hookDb()) {
    return app.request(
      '/v1/apps/myapp/webhooks/hook-1/test',
      { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
  }

  it('returns the receiver status and body, truncated to 1000 chars', async () => {
    const fetchMock = mockReceiver(async () => new Response('x'.repeat(5000), { status: 200 }));
    const res = await fireTest();
    expect(res.status).toBe(200);
    const data = await res.json() as { status: number; body: string };
    expect(data.status).toBe(200);
    expect(data.body).toHaveLength(1000);
    expect(receiverCalls(fetchMock)).toHaveLength(1);
  });

  it('never follows a redirect: sends redirect "manual" and reports the 3xx', async () => {
    const fetchMock = mockReceiver(async (init) => {
      expect(init.redirect).toBe('manual');
      return new Response('', { status: 302, headers: { Location: 'https://internal.proappstore.online/secret' } });
    });
    const res = await fireTest();
    const data = await res.json() as { status: number; body: string };
    expect(data.status).toBe(302);
    // Only the registered URL was ever fetched — the Location target was not.
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('internal.proappstore.online'))).toBe(false);
    expect(receiverCalls(fetchMock)).toHaveLength(1);
  });

  it('bounds the call with an abort signal and reports a timeout as status 0', async () => {
    let signal: AbortSignal | undefined;
    mockReceiver(async (init) => {
      signal = init.signal ?? undefined;
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const res = await fireTest();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(await res.json()).toEqual({ status: 0, body: 'timed out after 10000 ms' });
  });

  it('reports other network errors as status 0 with the message', async () => {
    mockReceiver(async () => { throw new TypeError('connection refused'); });
    const res = await fireTest();
    expect(await res.json()).toEqual({ status: 0, body: 'connection refused' });
  });

  it('signs the payload and sends the event header', async () => {
    const fetchMock = mockReceiver(async () => new Response('ok', { status: 200 }));
    await fireTest();
    const [, init] = receiverCalls(fetchMock)[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Webhook-Event']).toBe('storage.uploaded');
    expect(headers['X-Webhook-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toMatchObject({ test: true, event: 'storage.uploaded', appId: 'myapp' });
  });

  it('returns 404 for an unknown webhook without calling out', async () => {
    const fetchMock = mockReceiver(async () => new Response('ok'));
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const res = await fireTest(db);
    expect(res.status).toBe(404);
    expect(receiverCalls(fetchMock)).toHaveLength(0);
  });

  it('returns 403 for a non-owner without calling out', async () => {
    const fetchMock = mockReceiver(async () => new Response('ok'));
    const res = await fireTest(mockD1(mockStmt({ first: { creator_id: 'gh:other' } })));
    expect(res.status).toBe(403);
    expect(receiverCalls(fetchMock)).toHaveLength(0);
  });
});
