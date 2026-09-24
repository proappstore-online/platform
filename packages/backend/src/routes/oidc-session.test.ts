import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { verifySession } from '@proappstore/build-core';
import { app } from '../index.js';
import { _resetJwksCache, type OidcClaims } from '../lib/github-oidc.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { OIDC_SESSION_TTL_SECONDS, selectGrant, workflowPathOf } from './oidc-session.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUD = 'https://api.proappstore.online';
const KID = 'test-key-1';
const REPO = 'proappstore-online/chess-academy';
const WORKFLOW_REF = `${REPO}/.github/workflows/e2e-full.yml@refs/heads/main`;

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let priv: CryptoKey;
let jwk: JsonWebKey;
async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  priv = pair.privateKey;
}
async function signToken(claims: Partial<OidcClaims> = {}, signer: CryptoKey = priv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: KID });
  const payload = b64urlJson({
    iss: ISSUER, aud: AUD, sub: `repo:${REPO}:ref:refs/heads/main`, repository: REPO, repository_owner: 'proappstore-online',
    ref: 'refs/heads/main', sha: 'deadbeef', workflow_ref: WORKFLOW_REF, run_id: '123', iat: now, nbf: now, exp: now + 300, ...claims,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const makeEnv = (db: ReturnType<typeof mockD1>) => sharedMakeEnv({ ADMIN_GITHUB_IDS: 'gh:42' }, db);
const grant = (o: Record<string, unknown> = {}) => ({ id: 'g1', repository: REPO, workflow: null, ref: 'refs/heads/main', user_id: 'gh:42', label: 'nightly', created_by: 'gh:1', created_at: 1, revoked_at: null, last_minted_at: null, mint_count: 3, ...o });
const e2eUser = () => mockStmt({ first: { id: 'gh:42', login: 'e2e-bot', avatar_url: null } });
const exchange = (bearer: string | null) =>
  ({ method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, body: '{}' });

beforeEach(async () => {
  _resetJwksCache();
  await makeKey();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/.well-known/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`unexpected fetch: ${String(input)}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /v1/auth/exchange/oidc (#146)', () => {
  it('happy path: a granted repository gets a short-lived creator session for the e2e account, and the mint is recorded', async () => {
    const db = mockD1(mockStmt({ all: { results: [grant()] } }), e2eUser());
    const res = await app.request('/v1/auth/exchange/oidc', exchange(await signToken()), makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; expiresAt: number; via: string; user: { id: string; login: string }; grant: { id: string } };
    expect(body).toMatchObject({ via: 'oidc-e2e', user: { id: 'gh:42', login: 'e2e-bot' }, grant: { id: 'g1' } });
    const claims = await verifySession(body.sessionToken, 'test-signing-key');
    expect(claims).toMatchObject({ uid: 'gh:42', login: 'e2e-bot', roles: ['user', 'creator'], via: 'oidc-e2e' });
    // hours, not days — and never admin, even though gh:42 is in ADMIN_GITHUB_IDS
    expect(claims!.exp - claims!.iat).toBe(OIDC_SESSION_TTL_SECONDS);
    expect(claims!.roles).not.toContain('admin');
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(db.batch).toHaveBeenCalledTimes(1);
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.startsWith('INSERT INTO oidc_session_mints'))).toBe(true);
    expect(sqls.some((s) => s.includes('mint_count = mint_count + 1'))).toBe(true);
    const mint = db.prepare.mock.results.find((r, i) => sqls[i]!.startsWith('INSERT INTO oidc_session_mints'))!.value as ReturnType<typeof mockStmt>;
    expect(mint.bind).toHaveBeenCalledWith('g1', REPO, '.github/workflows/e2e-full.yml', 'refs/heads/main', 'deadbeef', '123', 'gh:42', expect.any(Number));
  });

  it('the minted session is accepted by session-authed routes as that user', async () => {
    const db = mockD1(mockStmt({ all: { results: [grant()] } }), e2eUser());
    const { sessionToken } = (await (await app.request('/v1/auth/exchange/oidc', exchange(await signToken()), makeEnv(db))).json()) as { sessionToken: string };
    const me = await app.request('/v1/me/tokens', { headers: { Authorization: `Bearer ${sessionToken}` } }, makeEnv(mockD1(mockStmt({ all: { results: [] } }))));
    expect(me.status).toBe(200);
  });

  it('401 without a bearer, with a tampered signature, with the wrong audience, and when expired', async () => {
    expect((await app.request('/v1/auth/exchange/oidc', exchange(null), makeEnv(mockD1()))).status).toBe(401);
    const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    expect((await app.request('/v1/auth/exchange/oidc', exchange(await signToken({}, other.privateKey)), makeEnv(mockD1()))).status).toBe(401);
    expect((await app.request('/v1/auth/exchange/oidc', exchange(await signToken({ aud: 'https://other.example' })), makeEnv(mockD1()))).status).toBe(401);
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect((await app.request('/v1/auth/exchange/oidc', exchange(await signToken({ iat: past, nbf: past, exp: past + 60 })), makeEnv(mockD1()))).status).toBe(401);
    expect((await app.request('/v1/auth/exchange/oidc', exchange('not-a-jwt'), makeEnv(mockD1()))).status).toBe(401);
  });

  it('403 with no grant, a revoked grant, a foreign org, a ref mismatch, a workflow mismatch, or a vanished account — before any session is minted', async () => {
    const attempts: [Partial<OidcClaims>, ReturnType<typeof mockD1>][] = [
      [{}, mockD1(mockStmt({ all: { results: [] } }))],
      [{}, mockD1(mockStmt({ all: { results: [grant({ revoked_at: 5 })] } }))],
      [{ repository: 'evil-org/chess-academy', repository_owner: 'evil-org' }, mockD1(mockStmt({ all: { results: [grant({ repository: 'evil-org/chess-academy' })] } }))],
      [{ ref: 'refs/heads/feature' }, mockD1(mockStmt({ all: { results: [grant()] } }))],
      [{ workflow_ref: `${REPO}/.github/workflows/deploy.yml@refs/heads/main` }, mockD1(mockStmt({ all: { results: [grant({ workflow: '.github/workflows/e2e-full.yml' })] } }))],
      [{}, mockD1(mockStmt({ all: { results: [grant()] } }), mockStmt({ first: null }))],
    ];
    for (const [claims, db] of attempts) {
      const res = await app.request('/v1/auth/exchange/oidc', exchange(await signToken(claims)), makeEnv(db));
      expect(res.status, JSON.stringify(claims)).toBe(403);
      expect(db.batch).not.toHaveBeenCalled();
    }
  });

  it('a workflow-scoped grant admits its workflow; grant selection ignores revoked rows and other refs', async () => {
    const claims = { repository: REPO, repository_owner: 'proappstore-online', ref: 'refs/heads/main', workflow_ref: WORKFLOW_REF } as unknown as OidcClaims;
    expect(workflowPathOf(claims)).toBe('.github/workflows/e2e-full.yml');
    expect(workflowPathOf({ repository: REPO } as OidcClaims)).toBeNull();
    const scoped = grant({ id: 'g2', workflow: '.github/workflows/e2e-full.yml' });
    expect(selectGrant([grant({ revoked_at: 1 }), grant({ ref: 'refs/heads/dev' }), scoped], claims)?.id).toBe('g2');
    expect(selectGrant([scoped], { ...claims, workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` })).toBeNull();
    const db = mockD1(mockStmt({ all: { results: [scoped] } }), e2eUser());
    expect((await app.request('/v1/auth/exchange/oidc', exchange(await signToken()), makeEnv(db))).status).toBe(200);
  });
});

describe('admin grant management', () => {
  it('platform admins create, list and revoke grants; everyone else is 403', async () => {
    const ADMIN = await testToken('gh:1', { roles: ['user', 'creator', 'admin'] });
    const CREATOR = await testToken('gh:2', { roles: ['user', 'creator'] });
    const body = { repository: REPO, user_id: 'gh:42', workflow: '.github/workflows/e2e-full.yml', label: 'nightly' };
    const json = (token: string, method: string, b?: unknown) => ({ method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(b ? { body: JSON.stringify(b) } : {}) });

    expect((await app.request('/v1/admin/oidc-session-grants', json(CREATOR, 'POST', body), makeEnv(mockD1()))).status).toBe(403);
    expect((await app.request('/v1/admin/oidc-session-grants', json(CREATOR, 'GET'), makeEnv(mockD1()))).status).toBe(403);
    expect((await app.request('/v1/admin/oidc-session-grants/g1', json(CREATOR, 'DELETE'), makeEnv(mockD1()))).status).toBe(403);
    expect((await app.request('/v1/admin/oidc-session-grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, makeEnv(mockD1()))).status).toBe(401);

    const insert = mockStmt();
    const created = await app.request('/v1/admin/oidc-session-grants', json(ADMIN, 'POST', body), makeEnv(mockD1(mockStmt({ first: { id: 'gh:42' } }), insert)));
    expect(created.status).toBe(201);
    const g = ((await created.json()) as { grant: Record<string, unknown> }).grant;
    expect(g).toMatchObject({ repository: REPO, user_id: 'gh:42', workflow: '.github/workflows/e2e-full.yml', ref: 'refs/heads/main', label: 'nightly', created_by: 'gh:1', mint_count: 0 });
    expect(insert.bind.mock.calls[0]![0]).toBe(g.id);

    for (const bad of [{ ...body, repository: 'evil-org/x' }, { ...body, user_id: 'octo' }, { ...body, workflow: 'e2e.yml' }, { ...body, ref: 'main' }]) {
      expect((await app.request('/v1/admin/oidc-session-grants', json(ADMIN, 'POST', bad), makeEnv(mockD1()))).status).toBe(400);
    }
    expect((await app.request('/v1/admin/oidc-session-grants', json(ADMIN, 'POST', body), makeEnv(mockD1(mockStmt({ first: null }))))).status).toBe(404);

    const list = await app.request('/v1/admin/oidc-session-grants', json(ADMIN, 'GET'), makeEnv(mockD1(mockStmt({ all: { results: [grant()] } }))));
    expect(((await list.json()) as { grants: { id: string; mint_count: number }[] }).grants).toEqual([expect.objectContaining({ id: 'g1', mint_count: 3 })]);

    expect((await app.request('/v1/admin/oidc-session-grants/g1', json(ADMIN, 'DELETE'), makeEnv(mockD1(mockStmt({ run: { meta: { changes: 1 } } }))))).status).toBe(200);
    expect((await app.request('/v1/admin/oidc-session-grants/g1', json(ADMIN, 'DELETE'), makeEnv(mockD1(mockStmt({ run: { meta: { changes: 0 } } }))))).status).toBe(404);
  });
});
