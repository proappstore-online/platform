import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { deployRoutes } from './deploy.js';
import { _resetJwksCache } from '../lib/github-oidc.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUD = 'https://api.proappstore.online';
const KID = 'test-key-1';
const ACCOUNT = 'c1089bfcc43c1c6c2aa89e584e86f0bc';

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

async function signToken(repository = 'proappstore-online/aiuniversity', ref = 'refs/heads/main'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: KID });
  const payload = b64urlJson({
    iss: ISSUER, aud: AUD, repository, repository_owner: repository.split('/')[0],
    ref, sha: 'deadbeef', iat: now, nbf: now, exp: now + 300,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

let auditRows: unknown[][];
let migrationRows: unknown[][] = [];
// schema-status test overrides this to serve migration_audit SELECT + ownership.
let selectResults: (sql: string) => { first?: unknown; all?: unknown } = () => ({});
const mockDB = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (sql.includes('deploy_audit')) auditRows.push(args);
        if (sql.includes('migration_audit') && sql.includes('INSERT')) migrationRows.push(args);
        return { success: true };
      },
      first: async () => selectResults(sql).first ?? null,
      all: async () => selectResults(sql).all ?? { results: [] },
    }),
  }),
};
const ENV = { CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: ACCOUNT, R2_PARENT_ACCESS_KEY_ID: 'parent-key-id', DB: mockDB } as never;

describe('POST /apps/:appId/deploy-credentials', () => {
  beforeEach(async () => {
    _resetJwksCache();
    auditRows = [];
    await makeKey();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.includes('/r2/temp-access-credentials')) {
        return new Response(JSON.stringify({
          success: true,
          result: { accessKeyId: 'AKIA_TMP', secretAccessKey: 'secret_tmp', sessionToken: 'session_tmp' },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (appId: string, headers: Record<string, string> = {}) =>
    deployRoutes.request(`/apps/${appId}/deploy-credentials`, { method: 'POST', headers }, ENV);

  it('mints scoped creds for a valid OIDC token', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accessKeyId).toBe('AKIA_TMP');
    expect(body.sessionToken).toBe('session_tmp');
    expect(body.prefix).toBe('apps/aiuniversity/');
    expect(body.endpoint).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    // the CF request must be scoped to this app's prefix only
    const cfCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes('temp-access-credentials'));
    expect(JSON.parse((cfCall![1] as RequestInit).body as string).prefixes).toEqual(['apps/aiuniversity/']);
    // the mint is audited: one row bound with (app_id, repository, ref, ...)
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.slice(0, 3)).toEqual(['aiuniversity', 'proappstore-online/aiuniversity', 'refs/heads/main']);
  });

  it('401 when no token', async () => {
    expect((await call('aiuniversity')).status).toBe(401);
  });

  it('401 on an unverifiable token', async () => {
    expect((await call('aiuniversity', { Authorization: 'Bearer not.a.jwt' })).status).toBe(401);
  });

  it('403 when the OIDC repo does not match the app id', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken('proappstore-online/other-app')}` });
    expect(res.status).toBe(403);
  });

  it('403 when the repo is in a different owner', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken('attacker/aiuniversity')}` });
    expect(res.status).toBe(403);
  });

  it('403 when the deploy is not from the main branch', async () => {
    const res = await call('aiuniversity', {
      Authorization: `Bearer ${await signToken('proappstore-online/aiuniversity', 'refs/heads/dev')}`,
    });
    expect(res.status).toBe(403);
  });

  it('400 on an invalid app id', async () => {
    const res = await call('Bad_ID', { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(400);
  });

  it('503 when parent R2 key is not configured', async () => {
    const res = await deployRoutes.request(
      '/apps/aiuniversity/deploy-credentials',
      { method: 'POST', headers: { Authorization: `Bearer ${await signToken()}` } },
      { CF_API_TOKEN: 'x', CF_ACCOUNT_ID: ACCOUNT } as never,
    );
    expect(res.status).toBe(503);
  });
});

describe('POST /apps/:appId/migrate/oidc', () => {
  let migrateBody: unknown;
  let migrateHeaders: Record<string, string>;
  const MIGRATE_ENV = { DB: mockDB, INTERNAL_TOKEN: 'internal-secret' } as never;

  beforeEach(async () => {
    _resetJwksCache();
    await makeKey();
    migrateBody = undefined;
    migrateHeaders = {};
    migrationRows = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.includes('/migrate')) {
        migrateBody = JSON.parse((init!.body as string));
        migrateHeaders = (init!.headers as Record<string, string>);
        return new Response(JSON.stringify({ applied: ['0001_init'], already: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (appId: string, body: unknown, headers: Record<string, string> = {}) =>
    deployRoutes.request(
      `/apps/${appId}/migrate/oidc`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
      MIGRATE_ENV,
    );

  const additive = { name: '0001_init', sql: 'CREATE TABLE t (id TEXT PRIMARY KEY);\nALTER TABLE t ADD COLUMN note TEXT;' };

  it('forwards additive migrations to the data worker with the internal token', async () => {
    const res = await call('aiuniversity',
      { migrations: [additive] },
      { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.applied).toEqual(['0001_init']);
    // it hit the app's data worker over its custom domain, with the internal token
    const call0 = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes('/migrate'));
    expect(String(call0![0])).toBe('https://data-aiuniversity.proappstore.online/migrate');
    expect(migrateHeaders['X-Internal-Token']).toBe('internal-secret');
    expect(migrateBody).toEqual({ migrations: [additive] });
    // the attempt is audited as applied (#33 — pending/failed migrations visible)
    expect(migrationRows).toHaveLength(1);
    expect(migrationRows[0]!.slice(0, 3)).toEqual(['aiuniversity', 'oidc', 'applied']);
  });

  it('is idempotent — reports already-applied names back from the data worker', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      if (url.includes('/migrate')) return new Response(JSON.stringify({ applied: [], already: ['0001_init'] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await call('aiuniversity', { migrations: [additive] }, { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).already).toEqual(['0001_init']);
  });

  it('422 on a destructive statement (DROP) — never forwarded', async () => {
    const res = await call('aiuniversity',
      { migrations: [{ name: 'x', sql: 'DROP TABLE t;' }] },
      { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(422);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/migrate'))).toBe(false);
  });

  it('422 on ALTER … RENAME and on DELETE/UPDATE', async () => {
    for (const sql of ['ALTER TABLE t RENAME TO u;', 'DELETE FROM t;', 'UPDATE t SET x=1;']) {
      const res = await call('aiuniversity', { migrations: [{ name: 'x', sql }] }, { Authorization: `Bearer ${await signToken()}` });
      expect(res.status).toBe(422);
    }
  });

  it('422 on a non-additive leading statement (SELECT)', async () => {
    const res = await call('aiuniversity',
      { migrations: [{ name: 'x', sql: 'SELECT 1;' }] },
      { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(422);
  });

  it('200 with a no-op note when migrations is empty', async () => {
    const res = await call('aiuniversity', { migrations: [] }, { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).note).toBe('no migrations');
  });

  it('400 when migrations is not an array', async () => {
    const res = await call('aiuniversity', { migrations: 'nope' }, { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(400);
  });

  it('401 when no token', async () => {
    expect((await call('aiuniversity', { migrations: [additive] })).status).toBe(401);
  });

  it('403 when the OIDC repo does not match the app id', async () => {
    const res = await call('aiuniversity', { migrations: [additive] },
      { Authorization: `Bearer ${await signToken('proappstore-online/other-app')}` });
    expect(res.status).toBe(403);
  });

  it('403 when the deploy is not from main', async () => {
    const res = await call('aiuniversity', { migrations: [additive] },
      { Authorization: `Bearer ${await signToken('proappstore-online/aiuniversity', 'refs/heads/dev')}` });
    expect(res.status).toBe(403);
  });

  it('502 when the data worker rejects the migration', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks')) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      if (url.includes('/migrate')) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await call('aiuniversity', { migrations: [additive] }, { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(502);
    // failure is audited too, so unresolved drift is visible in schema-status
    expect(migrationRows).toHaveLength(1);
    expect(migrationRows[0]!.slice(0, 3)).toEqual(['aiuniversity', 'oidc', 'failed']);
  });
});

describe('GET /apps/:appId/schema-status', () => {
  const SK = TEST_SK;
  const STATUS_ENV = { DB: mockDB, SESSION_SIGNING_KEY: SK } as never;

  afterEach(() => { selectResults = () => ({}); });

  const call = (appId: string, headers: Record<string, string> = {}) =>
    deployRoutes.request(`/apps/${appId}/schema-status`, { method: 'GET', headers }, STATUS_ENV);

  it('returns migration history for the owner, flagging unresolved failure', async () => {
    selectResults = (sql) => {
      if (sql.includes('FROM apps')) return { first: { creator_id: 'gh:5' } };
      if (sql.includes('migration_audit')) {
        return { all: { results: [
          { source: 'oidc', status: 'failed', applied: null, already: JSON.stringify(['0001_init']), detail: 'data worker /migrate failed (502)', ran_at: 200 },
          { source: 'oidc', status: 'applied', applied: JSON.stringify(['0001_init']), already: null, detail: null, ran_at: 100 },
        ] } };
      }
      return {};
    };
    const res = await call('aiuniversity', { Authorization: `Bearer ${await testToken('gh:5')}` });
    expect(res.status).toBe(200);
    const body = await res.json() as { hasUnresolvedFailure: boolean; last: { status: string }; history: unknown[] };
    expect(body.hasUnresolvedFailure).toBe(true);
    expect(body.last.status).toBe('failed');
    expect(body.history).toHaveLength(2);
  });

  it('400 on an invalid app id', async () => {
    const res = await call('Bad_ID', { Authorization: `Bearer ${await testToken('gh:5')}` });
    expect(res.status).toBe(400);
  });
});

describe('POST /apps/:appId/migrate/internal', () => {
  let migrateBody: unknown;
  let migrateHeaders: Record<string, string>;
  const INTERNAL_ENV = { DB: mockDB, INTERNAL_TOKEN: 'internal-secret' } as never;
  const additive = { name: '0001_init', sql: 'CREATE TABLE t (id TEXT PRIMARY KEY);' };

  beforeEach(() => {
    migrateBody = undefined;
    migrateHeaders = {};
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/migrate')) {
        migrateBody = JSON.parse((init!.body as string));
        migrateHeaders = (init!.headers as Record<string, string>);
        return new Response(JSON.stringify({ applied: ['0001_init'], already: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (headers: Record<string, string>) =>
    deployRoutes.request(
      '/apps/aiuniversity/migrate/internal',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ migrations: [additive] }) },
      INTERNAL_ENV,
    );

  it('forwards to the data worker with a valid internal token', async () => {
    const res = await call({ 'X-Internal-Token': 'internal-secret' });
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).applied).toEqual(['0001_init']);
    expect(migrateHeaders['X-Internal-Token']).toBe('internal-secret');
    expect(migrateBody).toEqual({ migrations: [additive] });
  });

  it('403 with a wrong internal token — never forwarded', async () => {
    const res = await call({ 'X-Internal-Token': 'nope' });
    expect(res.status).toBe(403);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('403 with no token', async () => {
    expect((await call({})).status).toBe(403);
  });

  it('422 on a destructive statement even over the internal path', async () => {
    const res = await deployRoutes.request(
      '/apps/aiuniversity/migrate/internal',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'internal-secret' }, body: JSON.stringify({ migrations: [{ name: 'x', sql: 'DROP TABLE t;' }] }) },
      INTERNAL_ENV,
    );
    expect(res.status).toBe(422);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('/migrate'))).toBe(false);
  });
});
