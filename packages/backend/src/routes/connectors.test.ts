import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, makeEnv, TEST_SK } from '../test-helpers.js';
import { signConnectorState } from '../lib/github-app.js';
import * as ghApp from '../lib/github-app.js';
import * as hooks from './hooks.js';
import type { Env } from '../types.js';

// #258: the connect flow and the webhook demux, over a SQL-prefix fake D1. The
// ownership proofs themselves are in lib/github-app.test.ts; here they are stubbed.
// End to end (real D1) is runtime-tests.

const TOK = await testToken('gh:1');
const OTHER = await testToken('gh:2');
const WEBHOOK_SECRET = 'whsec';

type Handler = (args: unknown[]) => { first?: unknown; all?: unknown[]; changes?: number };
let routes: Record<string, Handler>;
let seen: { sql: string; args: unknown[] }[];

function fakeDb(): D1Database {
  const find = (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    const hit = Object.entries(routes).find(([prefix]) => s.startsWith(prefix));
    if (!hit) throw new Error(`unexpected SQL: ${s}`);
    return { s, handler: hit[1] };
  };
  return {
    prepare: (sql: string) => {
      const { s, handler } = find(sql);
      return { bind: (...args: unknown[]) => {
        const call = () => { seen.push({ sql: s, args }); return handler(args); };
        return {
          first: async () => call().first ?? null,
          all: async () => ({ results: call().all ?? [] }),
          run: async () => ({ meta: { changes: call().changes ?? 1 } }),
        };
      } };
    },
    batch: async (stmts: { run: () => Promise<unknown> }[]) => Promise.all(stmts.map((s) => s.run())),
  } as unknown as D1Database;
}

const env = (over: Record<string, unknown> = {}) => makeEnv({
  GH_APP_ID: '1', GH_APP_CLIENT_ID: 'Iv1.x', GH_APP_CLIENT_SECRET: 'cs', GH_APP_PRIVATE_KEY: 'pem', GH_APP_SLUG: 'pas-connector',
  GH_APP_WEBHOOK_SECRET: WEBHOOK_SECRET, APP_SECRET_KEK: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', ...over,
}) as unknown as Env;

const get = (path: string, tok: string | null, e: Env, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers } }, e);

beforeEach(() => {
  seen = [];
  routes = {
    'SELECT creator_id FROM apps': () => ({ first: { creator_id: 'gh:1' } }),
    'SELECT name, modes, pat_secret, events, hook FROM app_connectors': () => ({ first: { name: 'github', modes: '["app"]', pat_secret: null, events: '["issues"]', hook: 'github' } }),
  };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('fails closed until the App is configured', () => {
  it('answers 503 "connector not configured" on every connector route', async () => {
    const e = env({ GH_APP_PRIVATE_KEY: undefined }) as unknown as Env;
    e.DB = fakeDb();
    for (const res of [
      await get('/v1/apps/a/connectors/github/install', TOK, e),
      await get('/v1/connectors/github/setup?installation_id=1&state=x', TOK, e),
      await app.request('/v1/connectors/github/webhook', { method: 'POST', body: '{}' }, e),
    ]) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'connector not configured' });
    }
  });
});

describe('install', () => {
  it('redirects the owner to the App install page with a signed state (JSON for a browser fetch)', async () => {
    const e = env(); e.DB = fakeDb();
    const res = await get('/v1/apps/a/connectors/github/install', TOK, e, { Accept: 'application/json' });
    const { url } = await res.json() as { url: string };
    expect(url).toMatch(/^https:\/\/github\.com\/apps\/pas-connector\/installations\/new\?state=/);
    const state = decodeURIComponent(url.split('state=')[1]!);
    expect(await ghApp.verifyConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, state)).toMatchObject({ appId: 'a', userId: 'gh:1' });
    const redirect = await get('/v1/apps/a/connectors/github/install', TOK, e);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toMatch(/^https:\/\/github\.com\/apps\/pas-connector\//);
  });
  it('is owner-only and needs a declared connector', async () => {
    const e = env(); e.DB = fakeDb();
    routes['SELECT creator_id FROM apps'] = () => ({ first: { creator_id: 'gh:9' } });
    routes['SELECT role FROM team_members'] = () => ({ first: null });
    expect((await get('/v1/apps/a/connectors/github/install', TOK, e)).status).toBe(403);
    routes['SELECT creator_id FROM apps'] = () => ({ first: { creator_id: 'gh:1' } });
    routes['SELECT name, modes, pat_secret, events, hook FROM app_connectors'] = () => ({});
    expect((await get('/v1/apps/a/connectors/github/install', TOK, e)).status).toBe(404);
  });
});

describe('setup', () => {
  const installation = { id: 5, account: { id: 900, login: 'acme', type: 'Organization' } };
  const setup = async (state: string, tok: string | null, code?: string) => {
    const e = env(); e.DB = fakeDb();
    return get(`/v1/connectors/github/setup?installation_id=5&setup_action=install&state=${encodeURIComponent(state)}${code ? `&code=${code}` : ''}`, tok, e);
  };
  const upserts = () => seen.filter((s) => s.sql.startsWith('INSERT INTO app_connector_installations'));
  beforeEach(() => {
    routes['INSERT INTO app_connector_installations'] = () => ({});
    vi.spyOn(ghApp, 'getInstallation').mockResolvedValue(installation);
  });

  it('binds the installation once control is proved, and returns to the console', async () => {
    const prove = vi.spyOn(ghApp, 'proveInstallationControl').mockResolvedValue({ ok: true });
    const res = await setup(await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1'), TOK, 'c0de');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('console.proappstore.online');
    expect(prove.mock.calls[0]![3]).toBe('c0de');
    expect(upserts()).toHaveLength(1);
    expect(upserts()[0]!.args.slice(0, 5)).toEqual(['a', 5, 'acme', 'Organization', 'gh:1']);
  });

  it('403s, writing nothing, when control is not proved (non-admin member, wrong code, Google user)', async () => {
    vi.spyOn(ghApp, 'proveInstallationControl').mockResolvedValue({ ok: false, error: 'reauthorize: reinstall or click Configure to re-run authorization' });
    const res = await setup(await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1'), TOK);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/^reauthorize/) });
    expect(upserts()).toHaveLength(0);
  });

  it('403s a state replayed by another user, an expired state, and a forged one', async () => {
    const prove = vi.spyOn(ghApp, 'proveInstallationControl').mockResolvedValue({ ok: true });
    routes['SELECT creator_id FROM apps'] = () => ({ first: { creator_id: 'gh:2' } });
    expect((await setup(await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1'), OTHER)).status).toBe(403);
    expect((await setup(await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1', 1000), TOK)).status).toBe(403);
    expect((await setup('forged.state', TOK)).status).toBe(403);
    expect(prove).not.toHaveBeenCalled();
    expect(upserts()).toHaveLength(0);
  });

  it('with no session (GitHub\'s own redirect) hands the parameters to the console instead of binding', async () => {
    const prove = vi.spyOn(ghApp, 'proveInstallationControl');
    const res = await setup(await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1'), null, 'c0de');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/console\.proappstore\.online\/#\/connectors\/github\/setup\?installation_id=5.*code=c0de/);
    expect(prove).not.toHaveBeenCalled();
  });

  it('POST completes it signed in and answers JSON', async () => {
    vi.spyOn(ghApp, 'proveInstallationControl').mockResolvedValue({ ok: true });
    const e = env(); e.DB = fakeDb();
    const res = await app.request('/v1/connectors/github/setup', {
      method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installation_id: '5', state: await signConnectorState({ SESSION_SIGNING_KEY: TEST_SK }, 'a', 'gh:1') }),
    }, e);
    expect(await res.json()).toEqual({ ok: true, app_id: 'a', installation_id: 5, account: 'acme' });
  });
});

describe('unbind', () => {
  it('deletes the owner\'s binding; 404 when there is none', async () => {
    const e = env(); e.DB = fakeDb();
    routes['DELETE FROM app_connector_installations'] = () => ({ changes: 1 });
    const del = () => app.request('/v1/apps/a/connectors/github/installations/5', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, e);
    expect((await del()).status).toBe(200);
    routes['DELETE FROM app_connector_installations'] = () => ({ changes: 0 });
    expect((await del()).status).toBe(404);
  });
});

describe('webhook demux', () => {
  async function post(body: unknown, event: string, secret = WEBHOOK_SECRET) {
    const raw = JSON.stringify(body);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const e = env(); e.DB = fakeDb();
    return app.request('/v1/connectors/github/webhook', {
      method: 'POST', body: raw,
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${mac}`, 'X-GitHub-Event': event, 'X-GitHub-Delivery': 'd-1' },
    }, e);
  }
  const bound = (...rows: { app_id: string; events: string; hook: string; target: string }[]) => {
    routes['SELECT i.app_id'] = () => ({ all: rows });
  };
  let ingest: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { ingest = vi.spyOn(hooks, 'ingestVerifiedDelivery').mockResolvedValue(new Response(null, { status: 202 })); });

  it('401s a bad signature and delivers nothing', async () => {
    bound({ app_id: 'a', events: '["issues"]', hook: 'github', target: '"worker"' });
    expect((await post({ installation: { id: 5 } }, 'issues', 'wrong')).status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('202s and drops an event for an unbound installation, and a ping', async () => {
    bound();
    expect((await post({ installation: { id: 5 }, action: 'opened' }, 'issues')).status).toBe(202);
    expect((await post({ zen: 'x' }, 'ping')).status).toBe(202);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('delivers to every bound app whose manifest subscribes to the event, through the #256 pipeline', async () => {
    bound(
      { app_id: 'a', events: '["issues","status"]', hook: 'github', target: '"worker"' },
      { app_id: 'b', events: '["check_suite"]', hook: 'gh', target: '"worker"' },
    );
    const res = await post({ installation: { id: 5 }, action: 'opened' }, 'issues');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, delivered: 1 });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0]!.slice(1, 5)).toEqual(['a', 'github', '"worker"', { replayKey: expect.stringMatching(/^[0-9a-f]{64}$/), deliveryId: 'd-1', event: 'issues' }]);
  });

  it('removes bindings and cached tokens when the installation is deleted', async () => {
    bound();
    routes['DELETE FROM app_connector_installations'] = () => ({});
    routes['DELETE FROM github_installation_tokens'] = () => ({});
    expect((await post({ installation: { id: 5 }, action: 'deleted' }, 'installation')).status).toBe(202);
    expect(seen.map((s) => s.sql)).toEqual(expect.arrayContaining([
      'DELETE FROM app_connector_installations WHERE installation_id = ?', 'DELETE FROM github_installation_tokens WHERE installation_id = ?',
    ]));
  });
});
