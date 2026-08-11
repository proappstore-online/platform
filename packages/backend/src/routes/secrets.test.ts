import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(overrides, db ?? mockD1());
}

// GET /v1/apps/:appId/secrets

describe('GET /v1/apps/:appId/secrets', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when app does not exist', async () => {
    const db = mockD1(mockStmt({ first: null })); // apps table lookup returns null
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns empty secrets list for app owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ all: { results: [] } }), // secrets query
    );
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [] });
  });

  it('returns secret names with timestamps but no values', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [{ name: 'OPENWEATHER_KEY', created_at: 1000, last_used_at: null }] } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { secrets: { name: string }[] };
    expect(body.secrets[0]!.name).toBe('OPENWEATHER_KEY');
  });
});

// PUT /v1/apps/:appId/secrets/:name

describe('PUT /v1/apps/:appId/secrets/:name', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid secret name (lowercase)', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/bad_name', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('uppercase');
  });

  it('returns 400 for invalid secret name (starts with digit)', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/1INVALID', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when value is empty string', async () => {
    // Name passes validation; owner check passes; then value check fires
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: '' }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('non-empty string');
  });

  it('returns 400 when value exceeds 4096 chars', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(4097) }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('too long');
  });

  it('returns 503 when APP_SECRET_KEK is not configured', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'some-value' }),
    }, makeEnv({}, db)); // no APP_SECRET_KEK
    expect(res.status).toBe(503);
  });

  it('returns 409 when app has reached the secrets cap', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ first: null }), // secret does not exist yet (new entry)
      mockStmt({ first: { n: 5 } }), // count = 5 (at the cap)
    );
    const res = await app.request('/v1/apps/myapp/secrets/NEW_KEY', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'value' }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(409);
  });
});

// DELETE /v1/apps/:appId/secrets/:name

describe('DELETE /v1/apps/:appId/secrets/:name', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when secret does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ run: { meta: { changes: 0 } } }), // DELETE returns 0 changes
    );
    const res = await app.request('/v1/apps/myapp/secrets/MISSING_KEY', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 204 on successful delete', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/OLD_KEY', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(204);
  });
});

// GET /v1/apps/:appId/allowlist

describe('GET /v1/apps/:appId/allowlist', () => {
  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns empty rules array for app owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [] } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });
});

// PUT /v1/apps/:appId/allowlist

describe('PUT /v1/apps/:appId/allowlist', () => {
  it('returns 400 when pattern does not start with https://', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'http://api.example.com',
        injectKind: 'header',
        injectName: 'X-Api-Key',
        secretName: 'API_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('https://');
  });

  it('returns 400 for invalid injectKind', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'magic', // invalid
        injectName: 'X-Api-Key',
        secretName: 'API_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });

  it('returns 400 when referenced secret does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ first: null }), // secret lookup: not found
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'bearer',
        injectName: '',
        secretName: 'MISSING_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 400 when methods array is empty', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'bearer',
        injectName: '',
        secretName: 'API_KEY',
        methods: [], // empty — invalid
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });
});

// DELETE /v1/apps/:appId/allowlist

describe('DELETE /v1/apps/:appId/allowlist', () => {
  it('returns 400 when pattern is not provided', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('pattern is required');
  });

  it('returns 404 when rule does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 0 } } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'https://api.example.com' }),
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 204 on successful delete', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'https://api.example.com' }),
    }, makeEnv({}, db));
    expect(res.status).toBe(204);
  });
});

// The proxy is deliberately callable by any signed-in user — an app's end users
// are not team members, and there is no "user U is a user of app A" record to
// check. That is why a mediated request's app claim is load-bearing: it is the
// one signal that says which app a call actually came from.
describe('ALL /v1/apps/:appId/proxy/* — app context (#80)', () => {
  it('rejects a mediated request that claims a different app', async () => {
    // X-PAS-App is set by the host from the resolved route, with any
    // client-supplied copy stripped first — so a mismatch means a page on one
    // app is driving another app's proxy, spending its secrets and its quota.
    const res = await app.request('/v1/apps/victimapp/proxy/api.example.com/v1/thing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOK}`, 'X-PAS-App': 'attackerapp' },
    }, makeEnv());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'app context mismatch' });
  });

  it('does not reject when the mediated app matches the path', async () => {
    // Should fall through to normal handling (no allowlist rule → 403 with a
    // different message), NOT the context-mismatch rejection.
    const res = await app.request('/v1/apps/myapp/proxy/api.example.com/v1/thing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOK}`, 'X-PAS-App': 'myapp' },
    }, makeEnv());
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('app context mismatch');
  });

  it('does not reject an unmediated request (absence proves nothing)', async () => {
    // A direct legacy-bearer caller sends no header. Rejecting on absence would
    // break every app not yet on the platform-cookie path (#20); the per-user
    // sub-cap is what bounds this case instead.
    const res = await app.request('/v1/apps/myapp/proxy/api.example.com/v1/thing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv());
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toBe('app context mismatch');
  });
});
