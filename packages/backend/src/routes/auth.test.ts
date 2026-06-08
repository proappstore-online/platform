import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const KEY = 'test-signing-key';
const env = () => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, SESSION_SIGNING_KEY: KEY } as never);

describe('GET /v1/auth/me (PAS-owned session verification)', () => {
  it('401s without a bearer token', async () => {
    const res = await app.request('/v1/auth/me', {}, env());
    expect(res.status).toBe(401);
  });

  it('401s on a token signed with a different key', async () => {
    const token = await mintSession({ uid: 'gh:1', login: 'x', roles: ['user'] }, 'wrong-key');
    const res = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } }, env());
    expect(res.status).toBe(401);
  });

  it('returns the user for a valid PAS token', async () => {
    const token = await mintSession({ uid: 'gh:1', login: 'octocat', avatarUrl: 'a.png', roles: ['user', 'creator'] }, KEY);
    const res = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } }, env());
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; login: string; roles: string[]; appRoles: Record<string, unknown> };
    expect(body.id).toBe('gh:1');
    expect(body.login).toBe('octocat');
    expect(body.roles).toEqual(['user', 'creator']);
    expect(body.appRoles).toEqual({});
  });
});

// Minimal in-memory D1 fake covering just the statements the credential
// endpoints + rate limiter issue. Enforces the unique credential_login.
function fakeDb() {
  const users: Array<Record<string, unknown>> = [];
  const attempts = new Map<string, { window_start: number; count: number }>();
  return {
    _users: users,
    _attempts: attempts,
    prepare(sql: string) {
      const stmt: { _args: unknown[]; bind: (...a: unknown[]) => typeof stmt; run: () => Promise<unknown>; first: <T>() => Promise<T | null>; all: <T>() => Promise<{ results: T[] }> } = {
        _args: [],
        bind(...a: unknown[]) { stmt._args = a; return stmt; },
        async run() {
          if (/INSERT INTO users/i.test(sql)) {
            const [uid, display, isChild, login, hash, createdBy, now] = stmt._args as [string, string, number, string, string, string, number];
            if (users.some((u) => u.credential_login === login)) {
              throw new Error('D1_ERROR: UNIQUE constraint failed: users.credential_login');
            }
            users.push({ id: uid, login: display, is_child: isChild, credential_login: login, password_hash: hash, created_by: createdBy, last_login_at: now });
            return { meta: { changes: 1 } };
          }
          if (/UPDATE users SET last_login_at/i.test(sql)) {
            const [now, id] = stmt._args as [number, string];
            const u = users.find((x) => x.id === id);
            if (u) u.last_login_at = now;
            return { meta: { changes: u ? 1 : 0 } };
          }
          if (/INSERT INTO credential_login_attempts/i.test(sql)) {
            const [login, ws, count] = stmt._args as [string, number, number];
            attempts.set(login, { window_start: ws, count });
            return { meta: { changes: 1 } };
          }
          if (/DELETE FROM credential_login_attempts/i.test(sql)) {
            attempts.delete(stmt._args[0] as string);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first<T>() {
          if (/FROM users WHERE credential_login/i.test(sql)) {
            const u = users.find((x) => x.credential_login === (stmt._args[0] as string));
            return (u ? { id: u.id, login: u.login, password_hash: u.password_hash } : null) as T | null;
          }
          if (/FROM credential_login_attempts WHERE login/i.test(sql)) {
            return (attempts.get(stmt._args[0] as string) ?? null) as T | null;
          }
          return null;
        },
        async all<T>() { return { results: [] as T[] }; },
      };
      return stmt;
    },
  };
}

const creatorToken = () => mintSession({ uid: 'gh:adult', login: 'teacher', roles: ['user', 'creator'] }, KEY);
const userToken = () => mintSession({ uid: 'gh:kid', login: 'plainuser', roles: ['user'] }, KEY);

describe('POST /v1/auth/credentials/provision', () => {
  const post = (body: unknown, headers: Record<string, string>, db: ReturnType<typeof fakeDb>) =>
    app.request('/v1/auth/credentials/provision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    }, { DB: db, SESSION_SIGNING_KEY: KEY } as never);

  it('401s without a bearer token', async () => {
    const res = await post({}, {}, fakeDb());
    expect(res.status).toBe(401);
  });

  it('403s for a non-creator (e.g. a provisioned child)', async () => {
    const res = await post({}, { Authorization: `Bearer ${await userToken()}` }, fakeDb());
    expect(res.status).toBe(403);
  });

  it('provisions a child: returns login+password once, records created_by', async () => {
    const db = fakeDb();
    const res = await post({}, { Authorization: `Bearer ${await creatorToken()}` }, db);
    expect(res.status).toBe(200);
    const body = await res.json() as { uid: string; login: string; password: string; isChild: boolean };
    expect(body.uid.startsWith('cred:')).toBe(true);
    expect(body.login).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(body.password.length).toBeGreaterThanOrEqual(6);
    expect(body.isChild).toBe(true);
    expect(db._users[0]!.created_by).toBe('gh:adult');
    expect(db._users[0]!.password_hash).not.toContain(body.password); // hashed
  });

  it('honors a supplied login and 409s on a duplicate', async () => {
    const db = fakeDb();
    const ok = await post({ login: 'rabbit-bear-wolf' }, { Authorization: `Bearer ${await creatorToken()}` }, db);
    expect((await ok.json() as { login: string }).login).toBe('rabbit-bear-wolf');
    const dup = await post({ login: 'rabbit-bear-wolf' }, { Authorization: `Bearer ${await creatorToken()}` }, db);
    expect(dup.status).toBe(409);
  });

  it('400s on an invalid supplied login', async () => {
    const res = await post({ login: 'Has Spaces!' }, { Authorization: `Bearer ${await creatorToken()}` }, fakeDb());
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/auth/credentials/login', () => {
  const provision = async (body: unknown, db: ReturnType<typeof fakeDb>) =>
    app.request('/v1/auth/credentials/provision', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await creatorToken()}` }, body: JSON.stringify(body),
    }, { DB: db, SESSION_SIGNING_KEY: KEY } as never);
  const login = (body: unknown, db: ReturnType<typeof fakeDb>) =>
    app.request('/v1/auth/credentials/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, { DB: db, SESSION_SIGNING_KEY: KEY } as never);

  it('400s when login or password is missing', async () => {
    expect((await login({ login: 'x' }, fakeDb())).status).toBe(400);
    expect((await login({ password: 'x' }, fakeDb())).status).toBe(400);
  });

  it('mints a working PAS JWT for valid credentials (end-to-end)', async () => {
    const db = fakeDb();
    const prov = await (await provision({ login: 'tiger-owl-cat' }, db)).json() as { uid: string; password: string };
    const res = await login({ login: 'tiger-owl-cat', password: prov.password }, db);
    expect(res.status).toBe(200);
    const { token } = await res.json() as { token: string };
    // The minted token must satisfy the unchanged /auth/me verifier.
    const me = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } }, { DB: db, SESSION_SIGNING_KEY: KEY } as never);
    expect(me.status).toBe(200);
    const meBody = await me.json() as { id: string; roles: string[] };
    expect(meBody.id).toBe(prov.uid);
    expect(meBody.roles).toEqual(['user']); // never creator/admin
  });

  it('401s on a wrong password and on an unknown login (no enumeration)', async () => {
    const db = fakeDb();
    await provision({ login: 'duck-duck-goose' }, db);
    expect((await login({ login: 'duck-duck-goose', password: 'wrong' }, db)).status).toBe(401);
    expect((await login({ login: 'no-such-login', password: 'wrong' }, db)).status).toBe(401);
  });

  it('429s after too many failed attempts (rate limit)', async () => {
    const db = fakeDb();
    await provision({ login: 'fox-fox-fox' }, db);
    for (let i = 0; i < 10; i++) {
      const r = await login({ login: 'fox-fox-fox', password: 'wrong' }, db);
      expect(r.status).toBe(401);
    }
    const blocked = await login({ login: 'fox-fox-fox', password: 'wrong' }, db);
    expect(blocked.status).toBe(429);
  });
});

describe('auth provider start', () => {
  it('503s when the provider is not configured', async () => {
    const res = await app.request('/v1/auth/github/start?return_to=https://console.proappstore.online', {}, env());
    expect(res.status).toBe(503);
  });

  it('404s for an unknown provider', async () => {
    const res = await app.request('/v1/auth/twitter/start', {}, env());
    expect(res.status).toBe(404);
  });

  it('redirects to GitHub when configured, with our callback + state', async () => {
    const res = await app.request(
      '/v1/auth/github/start?return_to=https://console.proappstore.online/',
      {},
      { ...env(), GITHUB_CLIENT_ID: 'cid', APP_BASE: 'https://api.proappstore.online' } as never,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.proappstore.online/v1/auth/github/callback');
    expect(loc.searchParams.get('state')).toBeTruthy();
  });

  it('rejects a return_to that is not a proappstore origin (open-redirect guard)', async () => {
    const res = await app.request(
      '/v1/auth/github/start?return_to=https://evil.com',
      {},
      { ...env(), GITHUB_CLIENT_ID: 'cid' } as never,
    );
    expect(res.status).toBe(400);
  });

  it('email sign-in returns 501 (not enabled)', async () => {
    const res = await app.request('/v1/auth/email/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env());
    expect(res.status).toBe(501);
  });
});

describe('auth callback — state decoding (base64url padding regression)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('decodes state of every length (no padding bug) → reaches profile, then bounces back with auth_error', async () => {
    // Token exchange fails → profile null → graceful 302 back to return_to with
    // #auth_error, NOT 400. A broken padding decode would drop return_to → 400.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    // return_to lengths chosen so the state's base64url length hits each n%4 case.
    for (const path of ['/', '/a', '/ab', '/abc']) {
      const ret = `https://console.proappstore.online${path}`;
      const state = b64url(JSON.stringify({ r: ret, n: 'fixed-nonce' }));
      const res = await app.request(
        `/v1/auth/github/callback?code=x&state=${state}`,
        { headers: { Cookie: `pas_oauth_state=${state}` } }, // CSRF cookie matches
        env(),
      );
      expect(res.status, `path ${path} (state len ${state.length})`).toBe(302);
      const loc = res.headers.get('location')!;
      expect(loc.startsWith(ret)).toBe(true);
      expect(loc).toContain('auth_error=profile_fetch_failed');
    }
  });

  it('bounces back with auth_error when the provider denies consent', async () => {
    const ret = 'https://console.proappstore.online/';
    const state = b64url(JSON.stringify({ r: ret, n: 'x' }));
    const res = await app.request(
      `/v1/auth/github/callback?error=access_denied&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=${state}` } },
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('auth_error=access_denied');
  });

  it('400s on a state/cookie mismatch (login CSRF guard)', async () => {
    const state = b64url(JSON.stringify({ r: 'https://console.proappstore.online/', n: 'a' }));
    const res = await app.request(
      `/v1/auth/github/callback?code=x&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=DIFFERENT` } },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('400s when no state cookie is present', async () => {
    const state = b64url(JSON.stringify({ r: 'https://console.proappstore.online/', n: 'a' }));
    const res = await app.request(`/v1/auth/github/callback?code=x&state=${state}`, {}, env());
    expect(res.status).toBe(400);
  });

  it('400s when state carries a disallowed return_to (even with a matching cookie)', async () => {
    const state = b64url(JSON.stringify({ r: 'https://evil.com', n: 'x' }));
    const res = await app.request(
      `/v1/auth/github/callback?code=x&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=${state}` } },
      env(),
    );
    expect(res.status).toBe(400);
  });
});
