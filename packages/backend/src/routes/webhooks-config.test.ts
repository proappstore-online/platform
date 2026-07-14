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
