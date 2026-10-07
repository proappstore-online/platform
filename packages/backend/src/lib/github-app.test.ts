import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appJwt, installationToken, proveInstallationControl, signConnectorState, verifyConnectorState, TOKEN_REFRESH_MARGIN_MS,
  type GhInstallation,
} from './github-app.js';
import type { Env } from '../types.js';

// #258: the vendored GitHub App client. GitHub is a stubbed fetch; D1 is a tiny SQL-prefix router.

const KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
let PEM: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  PEM = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----`;
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Handler = (args: unknown[]) => { first?: unknown; changes?: number };
function fakeDb(routes: Record<string, Handler>): D1Database {
  return {
    prepare: (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      const hit = Object.entries(routes).find(([prefix]) => s.startsWith(prefix));
      if (!hit) throw new Error(`unexpected SQL: ${s}`);
      return { bind: (...args: unknown[]) => ({
        first: async () => hit[1](args).first ?? null,
        run: async () => ({ meta: { changes: hit[1](args).changes ?? 1 } }),
      }) };
    },
  } as unknown as D1Database;
}

const baseEnv = (over: Partial<Env> = {}) => ({
  GH_APP_ID: '123', GH_APP_CLIENT_ID: 'Iv1.x', GH_APP_CLIENT_SECRET: 'cs', GH_APP_PRIVATE_KEY: PEM, GH_APP_SLUG: 'pas-connector', GH_APP_WEBHOOK_SECRET: 'wh',
  APP_SECRET_KEK: KEK, SESSION_SIGNING_KEY: 'sk', ...over,
}) as unknown as Env;

describe('appJwt', () => {
  it('is an RS256 JWT for the App id that verifies against the public key', async () => {
    const jwt = await appJwt(baseEnv(), 1_700_000_000_000);
    const [h, p, s] = jwt.split('.') as [string, string, string];
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')));
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(dec(p)).toMatchObject({ iss: '123', iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540 });
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, new TextEncoder().encode(`${h}.${p}`))).toBe(true);
  });
  it('refuses when the App is not configured', async () => {
    await expect(appJwt({ GH_APP_ID: '1' })).rejects.toThrow(/not configured/);
  });
});

describe('connector state', () => {
  const env = { SESSION_SIGNING_KEY: 'sk' };
  it('round-trips and expires', async () => {
    const state = await signConnectorState(env, 'app-a', 'gh:1', 1000);
    expect(await verifyConnectorState(env, state, 1100)).toEqual({ appId: 'app-a', userId: 'gh:1', exp: 1600 });
    expect(await verifyConnectorState(env, state, 1600)).toBeNull();
  });
  it('rejects a tampered body, another key, and junk', async () => {
    const state = await signConnectorState(env, 'app-a', 'gh:1', 1000);
    const [body, sig] = state.split('.') as [string, string];
    const forged = btoa(JSON.stringify({ appId: 'app-b', userId: 'gh:1', exp: 9999999999 })).replace(/=+$/, '');
    expect(await verifyConnectorState(env, `${forged}.${sig}`, 1100)).toBeNull();
    expect(await verifyConnectorState({ SESSION_SIGNING_KEY: 'other' }, state, 1100)).toBeNull();
    expect(await verifyConnectorState(env, body, 1100)).toBeNull();
    expect(await verifyConnectorState(env, 'a.b.c', 1100)).toBeNull();
  });
});

describe('installationToken cache', () => {
  function tokenEnv() {
    const cache = new Map<string, unknown[]>();
    const db = fakeDb({
      'SELECT token_ct': ([id, scope]) => {
        const r = cache.get(`${id}|${scope}`);
        return { first: r ? { token_ct: r[2], token_dek: r[3], token_iv: r[4], expires_at: r[5] } : null };
      },
      'INSERT INTO github_installation_tokens': (args) => { cache.set(`${args[0]}|${args[1]}`, args); return {}; },
    });
    return { env: baseEnv({ DB: db }), cache };
  }
  const minted: { body: unknown }[] = [];
  function stubGithub(expiresInMs: number) {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/access_tokens')) throw new Error(`unexpected ${url}`);
      minted.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ token: `ghs_${++n}`, expires_at: new Date(Date.now() + expiresInMs).toISOString() }, { status: 201 });
    }));
  }

  it('keeps one entry per (installation, scope): a token for repo X never answers repo Y or an unscoped ask', async () => {
    minted.length = 0;
    stubGithub(60 * 60 * 1000);
    const { env } = tokenEnv();
    const x = await installationToken(env, 7, 'org/x');
    const y = await installationToken(env, 7, 'org/y');
    const all = await installationToken(env, 7);
    expect(new Set([x, y, all]).size).toBe(3);
    expect(minted.map((m) => m.body)).toEqual([{ repositories: ['x'] }, { repositories: ['y'] }, null]);
    // Within the window each scope is a cache hit — no new mint.
    expect(await installationToken(env, 7, 'org/x')).toBe(x);
    expect(await installationToken(env, 7, 'ORG/Y')).toBe(y);
    expect(await installationToken(env, 7)).toBe(all);
    expect(minted).toHaveLength(3);
  });

  it('stores the token encrypted, and re-mints within 5 minutes of expiry', async () => {
    minted.length = 0;
    stubGithub(TOKEN_REFRESH_MARGIN_MS - 1000);
    const { env, cache } = tokenEnv();
    const first = await installationToken(env, 9);
    const row = cache.get('9|') as unknown[];
    expect(new TextDecoder().decode(row[2] as Uint8Array)).not.toContain(first!);
    expect(await installationToken(env, 9)).not.toBe(first);
    expect(minted).toHaveLength(2);
  });

  it('is null when GitHub refuses to mint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 422 })));
    expect(await installationToken(tokenEnv().env, 1, 'org/gone')).toBeNull();
  });
});

describe('proveInstallationControl', () => {
  const org: GhInstallation = { id: 5, account: { id: 900, login: 'acme', type: 'Organization' } };
  const personal: GhInstallation = { id: 6, account: { id: 42, login: 'serge', type: 'User' } };
  const userRow = (row: unknown) => baseEnv({ DB: fakeDb({ 'SELECT provider, provider_id FROM users': () => ({ first: row }) }) });

  function stubGithub(opts: { codeToken?: string | null; userInstalls?: number[]; membership?: unknown; login?: string }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === 'https://github.com/login/oauth/access_token') return Response.json(opts.codeToken ? { access_token: opts.codeToken } : { error: 'bad_verification_code' });
      if (url.startsWith('https://api.github.com/user/installations')) return Response.json({ installations: (opts.userInstalls ?? []).map((id) => ({ id })) });
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'ghs_x', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
      if (/\/user\/\d+$/.test(url)) return Response.json({ login: opts.login ?? 'alice' });
      if (url.includes('/memberships/')) return opts.membership ? Response.json(opts.membership) : new Response('', { status: 404 });
      throw new Error(`unexpected ${url}`);
    }));
  }

  it('with a code: the installation must be in GET /user/installations', async () => {
    const env = userRow(null);
    stubGithub({ codeToken: 'ghu_1', userInstalls: [5] });
    expect(await proveInstallationControl(env, { id: 'gh:1' }, org, 'code')).toEqual({ ok: true });
    stubGithub({ codeToken: 'ghu_1', userInstalls: [99] });
    expect(await proveInstallationControl(env, { id: 'gh:1' }, org, 'code')).toMatchObject({ ok: false });
    stubGithub({ codeToken: null });
    expect(await proveInstallationControl(env, { id: 'gh:1' }, org, 'stale')).toMatchObject({ ok: false });
  });

  it('without a code: a Google user is refused whatever their login is', async () => {
    stubGithub({});
    const r = await proveInstallationControl(userRow({ provider: 'google', provider_id: '1234' }), { id: 'google:1234' }, org, null);
    expect(r).toEqual({ ok: false, error: 'sign in with GitHub to connect an installation' });
    expect(await proveInstallationControl(userRow(null), { id: 'x' }, personal, null)).toMatchObject({ ok: false });
  });

  it('without a code, personal install: provider_id must equal the account id', async () => {
    stubGithub({});
    expect(await proveInstallationControl(userRow({ provider: 'github', provider_id: '42' }), { id: 'gh:42' }, personal, null)).toEqual({ ok: true });
    expect(await proveInstallationControl(userRow({ provider: 'github', provider_id: '43' }), { id: 'gh:43' }, personal, null)).toMatchObject({ ok: false });
  });

  it('without a code, org install: only an active admin passes; a plain member does not', async () => {
    const env = userRow({ provider: 'github', provider_id: '7' });
    stubGithub({ membership: { state: 'active', role: 'admin' } });
    expect(await proveInstallationControl(env, { id: 'gh:7' }, org, null)).toEqual({ ok: true });
    stubGithub({ membership: { state: 'active', role: 'member' } });
    expect(await proveInstallationControl(env, { id: 'gh:7' }, org, null)).toMatchObject({ ok: false });
    stubGithub({ membership: { state: 'pending', role: 'admin' } });
    expect(await proveInstallationControl(env, { id: 'gh:7' }, org, null)).toMatchObject({ ok: false });
    stubGithub({});
    expect(await proveInstallationControl(env, { id: 'gh:7' }, org, null)).toMatchObject({ ok: false });
  });
});
