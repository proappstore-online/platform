import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { sealSecret } from '../lib/encryption.js';
import { OAUTH2_TOKEN_TIMEOUT_MS } from '../lib/proxy-oauth2.js';
import { PROXY_UPSTREAM_TIMEOUT_MS } from './secrets-proxy.js';

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
// check. That is why the mediated app claim is load-bearing: it is the one
// signal that says which app a call actually came from, so the proxy requires it.
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

  it('rejects an unmediated request before touching secrets', async () => {
    // A direct bearer call names its app in the URL and nothing vouches for it:
    // a session obtained anywhere could spend any app's secrets. The host strips
    // a client-supplied X-PAS-App on the direct api.* path, so absence is what a
    // direct caller looks like.
    const db = mockD1();
    const res = await app.request('/v1/apps/victimapp/proxy/api.example.com/v1/thing', {
      method: 'GET',
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("app's own origin");
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

// #225: the proxy's outbound calls are bounded; a timeout is a 504 and a failed
// OAuth2 exchange a 502, never an unhandled 500 or a hung request.
describe('ALL /v1/apps/:appId/proxy/* — outbound bounds (#225)', () => {
  const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  let seq = 0;
  const setup = async (kind: 'header' | 'oauth2_cc') => {
    const appId = `app${++seq}`; // distinct OAuth2 token-cache key per test
    const sealed = {
      KEY: await sealSecret('client-id-or-key', KEK),
      KEY2: await sealSecret('client-secret-value', KEK),
    };
    const rule = {
      pattern: 'https://api.example.com/', inject_kind: kind, inject_name: kind === 'header' ? 'X-Api-Key' : null,
      secret_name: 'KEY', secret_name_2: kind === 'oauth2_cc' ? 'KEY2' : null,
      token_url: kind === 'oauth2_cc' ? 'https://auth.example.com/token' : null,
      methods: 'GET', created_at: 1,
    };
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => ({ results: sql.includes('FROM app_proxy_allowlist') ? [rule] : [] }),
          first: async () => {
            if (sql.includes('FROM app_secrets')) {
              const s = sealed[args[1] as 'KEY' | 'KEY2'];
              return { key_ciphertext: s.keyCiphertext, dek_wrapped: s.dekWrapped, iv: s.iv };
            }
            return sql.includes('SELECT count') ? { count: 0 } : null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
      batch: async () => [],
    };
    const call = () => app.request(`/v1/apps/${appId}/proxy/api.example.com/v1/thing`, {
      method: 'GET', headers: { Authorization: `Bearer ${TOK}`, 'X-PAS-App': appId },
    }, sharedMakeEnv({ APP_SECRET_KEK: KEK }, db as never));
    return call;
  };
  const hang = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  const timeoutControl = () => {
    const signals: { ms: number; ac: AbortController }[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const ac = new AbortController();
      signals.push({ ms, ac });
      return ac.signal;
    });
    const fire = (ms: number) => signals.find((s) => s.ms === ms)!.ac.abort(new DOMException('timeout', 'TimeoutError'));
    return { signals, fire };
  };
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('success path unchanged: injects the key, bounded by the upstream timeout, never follows redirects', async () => {
    const f = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', f);
    const res = await (await setup('header'))();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('X-Api-Key')).toBe('client-id-or-key');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('an upstream that never answers is a 504 after PROXY_UPSTREAM_TIMEOUT_MS', async () => {
    const t = timeoutControl();
    vi.stubGlobal('fetch', vi.fn(hang));
    const pending = (await setup('header'))();
    await vi.waitFor(() => expect(t.signals.map((s) => s.ms)).toContain(PROXY_UPSTREAM_TIMEOUT_MS));
    t.fire(PROXY_UPSTREAM_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: `upstream timed out after ${PROXY_UPSTREAM_TIMEOUT_MS} ms` });
  });

  it('a hung OAuth2 token endpoint is a 504 and the upstream is never called', async () => {
    const t = timeoutControl();
    const f = vi.fn(hang);
    vi.stubGlobal('fetch', f);
    const pending = (await setup('oauth2_cc'))();
    await vi.waitFor(() => expect(t.signals.map((s) => s.ms)).toContain(OAUTH2_TOKEN_TIMEOUT_MS));
    t.fire(OAUTH2_TOKEN_TIMEOUT_MS);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: `OAuth2 token endpoint timed out after ${OAUTH2_TOKEN_TIMEOUT_MS} ms` });
    expect(f).toHaveBeenCalledTimes(1); // only the token endpoint
  });

  it('a redirecting token endpoint is a 502: the secret is not re-sent and nothing leaks to the caller', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn(async () => new Response('secret-ish upstream detail', { status: 307, headers: { Location: 'https://attacker.example/' } }));
    vi.stubGlobal('fetch', f);
    const res = await (await setup('oauth2_cc'))();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'OAuth2 token exchange failed' });
    expect(text).not.toContain('client-secret-value');
    expect(text).not.toContain('upstream detail');
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });
});
