import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { sealSecret } from '../lib/encryption.js';
import { replaceAppTools } from './tools.js';

// #587: per-user app secrets, against real SQLite with every platform migration.

const KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const OWNER = 'gh:1';
const ALICE = 'gh:2';
const BOB = 'gh:3';
const CAROL = 'gh:4';
const TOKENS = { [OWNER]: await testToken(OWNER), [ALICE]: await testToken(ALICE), [BOB]: await testToken(BOB), [CAROL]: await testToken(CAROL) };
const ALICE_KEY = 'sk-alice-0123456789';
const BOB_KEY = 'sk-bob-9876543210';
const APP_KEY = 'sk-the-developers-own';

let db: ReturnType<typeof sqliteD1>;
let limiter: { limit: ReturnType<typeof vi.fn> };

function env() {
  return makeEnv({ APP_SECRET_KEK: KEK, USER_SECRET_RATE_LIMIT: limiter }, db as never);
}

function call(path: string, opts: { as: string; app?: string | null; method?: string; body?: unknown }) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKENS[opts.as]}` };
  if (opts.app !== null) headers['X-PAS-App'] = opts.app ?? 'appx';
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(path, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env());
}

const put = (as: string, value: string, opts: { app?: string | null; appId?: string; name?: string } = {}) =>
  call(`/v1/apps/${opts.appId ?? 'appx'}/user-secrets/${opts.name ?? 'OPENAI_KEY'}`, { as, app: opts.app, method: 'PUT', body: { value } });
const proxy = (as: string, appId = 'appx') => call(`/v1/apps/${appId}/proxy/api.example.com/v1/costs`, { as, app: appId });
const rows = () => db.sql.prepare('SELECT app_id, user_id, name FROM app_user_secrets ORDER BY app_id, user_id, name').all();

function addRule(appId: string, scope: 'app' | 'user', pattern = 'https://api.example.com/') {
  db.sql.prepare(`INSERT INTO app_proxy_allowlist (app_id, pattern, inject_kind, inject_name, secret_name, methods, created_at, secret_scope)
    VALUES (?, ?, 'bearer', '', 'OPENAI_KEY', 'GET', 1, ?)`).run(appId, pattern, scope);
}

async function addAppSecret(appId: string, name: string, value: string) {
  const s = await sealSecret(value, KEK);
  db.sql.prepare('INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at) VALUES (?, ?, ?, ?, ?, 1)')
    .run(appId, name, s.keyCiphertext, s.dekWrapped, s.iv);
}

let upstream: ReturnType<typeof vi.fn>;
const injected = () => upstream.mock.calls.map((c) => new Headers((c[1] as RequestInit).headers).get('Authorization'));

beforeEach(() => {
  db = sqliteD1();
  limiter = { limit: vi.fn(async () => ({ success: true })) };
  for (const id of ['appx', 'appy']) {
    db.sql.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (?, ?, 1)').run(id, OWNER);
    db.sql.prepare("INSERT INTO app_user_secret_decls (app_id, name, label, description, created_at) VALUES (?, 'OPENAI_KEY', 'OpenAI key', 'Reads your usage', 1)").run(id);
  }
  upstream = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('write path: the signed-in user, from the app origin only', () => {
  it('refuses a call without the mediated app origin, and one mediated for another app', async () => {
    const direct = await put(ALICE, ALICE_KEY, { app: null });
    expect(direct.status).toBe(403);
    expect(((await direct.json()) as { error: string }).error).toContain("app's own origin");
    expect((await put(ALICE, ALICE_KEY, { app: 'appy' })).status).toBe(403);
    expect((await call('/v1/apps/appx/user-secrets', { as: ALICE, app: null })).status).toBe(403);
    expect((await call('/v1/apps/appx/user-secrets/OPENAI_KEY', { as: ALICE, app: null, method: 'DELETE' })).status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it('refuses a name the app did not declare in mcp.json user_secrets', async () => {
    const res = await put(ALICE, ALICE_KEY, { name: 'GITHUB_TOKEN' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('not declared');
    expect(rows()).toEqual([]);
  });

  it('refuses a malformed name, an empty value and an oversized one without echoing it', async () => {
    expect((await put(ALICE, ALICE_KEY, { name: 'openai_key' })).status).toBe(400);
    expect((await put(ALICE, '')).status).toBe(400);
    const big = `sk-${'q'.repeat(5000)}`;
    const res = await put(ALICE, big);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('qqqq');
  });

  it('is rate limited per (app, user)', async () => {
    limiter.limit.mockResolvedValueOnce({ success: false });
    expect((await put(ALICE, ALICE_KEY)).status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: `appx:${ALICE}` });
    expect(rows()).toEqual([]);
  });

  it('stores ciphertext only, and list returns names and times, never values', async () => {
    expect((await put(ALICE, ALICE_KEY)).status).toBe(204);
    const stored = db.sql.prepare('SELECT * FROM app_user_secrets').all();
    expect(JSON.stringify(stored)).not.toContain(ALICE_KEY);
    const res = await call('/v1/apps/appx/user-secrets', { as: ALICE });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(ALICE_KEY);
    const body = JSON.parse(text) as { secrets: Record<string, unknown>[] };
    expect(body.secrets).toHaveLength(1);
    expect(Object.keys(body.secrets[0]!).sort()).toEqual(['lastUsedAt', 'name', 'updatedAt']);
    expect(body.secrets[0]!.name).toBe('OPENAI_KEY');
  });
});

describe('isolation between users and apps', () => {
  it("user B cannot list, delete or overwrite user A's secret", async () => {
    await put(ALICE, ALICE_KEY);
    const aliceRow = db.sql.prepare('SELECT key_ciphertext FROM app_user_secrets WHERE user_id = ?').get(ALICE);
    const list = (await (await call('/v1/apps/appx/user-secrets', { as: BOB })).json()) as { secrets: unknown[] };
    expect(list.secrets).toEqual([]);
    expect((await call('/v1/apps/appx/user-secrets/OPENAI_KEY', { as: BOB, method: 'DELETE' })).status).toBe(404);
    expect((await put(BOB, BOB_KEY)).status).toBe(204); // B's own row, beside A's
    expect(db.sql.prepare('SELECT key_ciphertext FROM app_user_secrets WHERE user_id = ?').get(ALICE)).toEqual(aliceRow);
    expect(rows()).toEqual([
      { app_id: 'appx', user_id: ALICE, name: 'OPENAI_KEY' },
      { app_id: 'appx', user_id: BOB, name: 'OPENAI_KEY' },
    ]);
  });

  it("the proxy injects the session user's own secret, never another user's", async () => {
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    await put(BOB, BOB_KEY);
    expect((await proxy(ALICE)).status).toBe(200);
    expect((await proxy(BOB)).status).toBe(200);
    expect(injected()).toEqual([`Bearer ${ALICE_KEY}`, `Bearer ${BOB_KEY}`]);
    const used = db.sql.prepare('SELECT last_used_at FROM app_user_secrets WHERE user_id = ?').get(ALICE) as { last_used_at: number | null };
    expect(used.last_used_at).toBeGreaterThan(0);
  });

  it("app Y cannot use app X's user secrets", async () => {
    addRule('appy', 'user');
    await put(ALICE, ALICE_KEY);
    const res = await proxy(ALICE, 'appy');
    expect(res.status).toBe(412);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('a row copied to another user or another app fails to decrypt (AAD)', async () => {
    addRule('appx', 'user');
    addRule('appy', 'user');
    await put(ALICE, ALICE_KEY);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    db.sql.prepare(`INSERT INTO app_user_secrets (app_id, user_id, name, key_ciphertext, dek_wrapped, iv, created_at, updated_at)
      SELECT app_id, ?, name, key_ciphertext, dek_wrapped, iv, created_at, updated_at FROM app_user_secrets WHERE user_id = ?`).run(BOB, ALICE);
    db.sql.prepare(`INSERT INTO app_user_secrets (app_id, user_id, name, key_ciphertext, dek_wrapped, iv, created_at, updated_at)
      SELECT 'appy', user_id, name, key_ciphertext, dek_wrapped, iv, created_at, updated_at FROM app_user_secrets WHERE user_id = ? AND app_id = 'appx'`).run(ALICE);
    const asBob = await proxy(BOB);
    const otherApp = await proxy(ALICE, 'appy');
    expect(asBob.status).toBe(500);
    expect(otherApp.status).toBe(500);
    expect(await asBob.text()).not.toContain(ALICE_KEY);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('a user rule never falls back to the app secret', () => {
  it('412 user_secret_missing when the caller has none, even with an app secret of that name', async () => {
    await addAppSecret('appx', 'OPENAI_KEY', APP_KEY);
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    const res = await proxy(CAROL);
    expect(res.status).toBe(412);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'user_secret_missing' });
    expect(text).not.toContain(APP_KEY);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('an app rule still injects the app secret (existing rules unchanged)', async () => {
    await addAppSecret('appx', 'OPENAI_KEY', APP_KEY);
    addRule('appx', 'app');
    await put(ALICE, ALICE_KEY);
    expect((await proxy(ALICE)).status).toBe(200);
    expect(injected()).toEqual([`Bearer ${APP_KEY}`]);
  });

  it('the proxy still refuses an unmediated call before touching any secret', async () => {
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    const res = await call('/v1/apps/appx/proxy/api.example.com/v1/costs', { as: ALICE, app: null });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('allowlist rules with secretScope user (owner)', () => {
  const allow = (body: Record<string, unknown>) => call('/v1/apps/appx/allowlist', { as: OWNER, app: null, method: 'PUT',
    body: { pattern: 'https://api.example.com/', injectKind: 'bearer', methods: ['GET'], ...body } });

  it('needs a declared user-secret name, not an app secret', async () => {
    expect((await allow({ secretName: 'UNDECLARED', secretScope: 'user' })).status).toBe(400);
    expect((await allow({ secretName: 'OPENAI_KEY', secretScope: 'user' })).status).toBe(204);
    expect(db.sql.prepare('SELECT secret_scope FROM app_proxy_allowlist').get()).toEqual({ secret_scope: 'user' });
    const list = (await (await call('/v1/apps/appx/allowlist', { as: OWNER, app: null })).json()) as { rules: { secretScope: string }[] };
    expect(list.rules[0]!.secretScope).toBe('user');
  });

  it('refuses oauth2_cc and an unknown scope', async () => {
    expect((await allow({ secretName: 'OPENAI_KEY', secretScope: 'user', injectKind: 'oauth2_cc', secretName2: 'X', tokenUrl: 'https://auth.example.com/t' })).status).toBe(400);
    expect((await allow({ secretName: 'OPENAI_KEY', secretScope: 'everyone' })).status).toBe(400);
  });
});

describe('lifecycle', () => {
  it('mcp.json user_secrets replaces the declared names on registration; stored values stay', async () => {
    await put(ALICE, ALICE_KEY);
    const decl = { name: 'ANTHROPIC_KEY', label: 'Anthropic admin key', description: 'Reads your costs' };
    const ok = await replaceAppTools(db, 'appx', [], undefined, { user_secrets: [decl] });
    expect(ok.status).toBe(200);
    expect(ok.payload.user_secrets).toEqual(['ANTHROPIC_KEY']);
    expect(db.sql.prepare("SELECT name, label, description FROM app_user_secret_decls WHERE app_id = 'appx'").all()).toEqual([decl]);
    expect((await put(ALICE, ALICE_KEY)).status).toBe(400); // OPENAI_KEY no longer declared
    expect((await put(ALICE, ALICE_KEY, { name: 'ANTHROPIC_KEY' })).status).toBe(204);
    expect(rows()).toHaveLength(2);
    const bad = await replaceAppTools(db, 'appx', [], undefined, { user_secrets: [{ name: 'x' }] });
    expect(bad.status).toBe(400);
  });


  it("the user's per-app account deletion removes their secrets in that app only", async () => {
    await put(ALICE, ALICE_KEY);
    await put(ALICE, ALICE_KEY, { app: 'appy', appId: 'appy' });
    await put(BOB, BOB_KEY);
    const bucket = { list: async () => ({ objects: [], truncated: false }), delete: async () => {} };
    const res = await app.request(`/v1/apps/appx/users/${ALICE}/account`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKENS[ALICE]}` } },
      makeEnv({ APP_SECRET_KEK: KEK, STORAGE: bucket }, db as never));
    expect(res.status).toBe(200);
    expect(rows()).toEqual([
      { app_id: 'appx', user_id: BOB, name: 'OPENAI_KEY' },
      { app_id: 'appy', user_id: ALICE, name: 'OPENAI_KEY' },
    ]);
  });

  it("deleting the app removes every user's secrets and its declarations", async () => {
    await put(ALICE, ALICE_KEY);
    await put(ALICE, ALICE_KEY, { app: 'appy', appId: 'appy' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/v1/apps/appx', { as: OWNER, app: null, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ app_id: 'appy', user_id: ALICE, name: 'OPENAI_KEY' }]);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM app_user_secret_decls WHERE app_id = 'appx'").get()).toEqual({ n: 0 });
  });
});

// #587 review (HIGH): a pattern is a URL prefix, so a pattern without a path
// matched any host that starts with it. The caller picks the :host segment.
describe('pattern matching cannot be steered to another host', () => {
  const ownerAllow = (pattern: string) => call('/v1/apps/appx/allowlist', { as: OWNER, app: null, method: 'PUT',
    body: { pattern, injectKind: 'bearer', methods: ['GET'], secretName: 'OPENAI_KEY', secretScope: 'user' } });

  it('refuses a pattern that is not an origin followed by a path', async () => {
    for (const pattern of ['https://api.example.com', 'https://api.example.com:8443/', 'https://user@api.example.com/', 'https://API.example.com/']) {
      expect((await ownerAllow(pattern)).status, pattern).toBe(400);
    }
    expect((await ownerAllow('https://api.example.com/')).status).toBe(204);
  });

  for (const scope of ['app', 'user'] as const) {
    it(`a ${scope} rule's key never reaches a lookalike, userinfo or port host`, async () => {
      await addAppSecret('appx', 'OPENAI_KEY', APP_KEY);
      await put(ALICE, ALICE_KEY);
      addRule('appx', scope, 'https://api.example.com'); // stored before patterns were checked
      for (const host of ['api.example.com.evil.test', 'api.example.com@evil.test', 'api.example.com:8443', 'API.example.com']) {
        const res = await call(`/v1/apps/appx/proxy/${host}/v1/costs`, { as: ALICE });
        expect(res.status, host).not.toBe(200);
      }
      expect(upstream).not.toHaveBeenCalled();
    });
  }

  it('a user rule only allows its methods', async () => {
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    const res = await call('/v1/apps/appx/proxy/api.example.com/v1/costs', { as: ALICE, method: 'POST', body: {} });
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('review follow-ups (#587)', () => {
  it('a proxy response cannot run as a page on the app origin', async () => {
    upstream.mockResolvedValueOnce(new Response('<script>steal()</script>', { headers: { 'Content-Type': 'text/html' } }));
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    const res = await proxy(ALICE);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe('sandbox');
  });

  it('a user rule whose name is no longer declared is refused at proxy time', async () => {
    addRule('appx', 'user');
    await put(ALICE, ALICE_KEY);
    db.sql.prepare("DELETE FROM app_user_secret_decls WHERE app_id = 'appx'").run();
    const res = await proxy(ALICE);
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('DELETE /apps/:appId/tools clears the declared names with the rest of the manifest', async () => {
    const res = await call('/v1/apps/appx/tools', { as: OWNER, app: null, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM app_user_secret_decls WHERE app_id = 'appx'").get()).toEqual({ n: 0 });
  });

  it('refuses control characters in a value', async () => {
    for (const value of ['sk-1\r\nX-Injected: 1', 'sk-1\n', 'sk\u00001', 'sk\u007f', 'sk\t1']) {
      const res = await put(ALICE, value);
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await res.text()).not.toContain('sk-1');
    }
    expect(rows()).toEqual([]);
  });

  it('ignores a forged user id in the query or body: every route acts for the session user', async () => {
    addRule('appx', 'user');
    await put(BOB, BOB_KEY);
    const forged = (path: string, method = 'GET', body?: unknown) =>
      call(`${path}?userId=${encodeURIComponent(BOB)}&user_id=${encodeURIComponent(BOB)}`, { as: ALICE, method, body });
    expect((await forged('/v1/apps/appx/user-secrets/OPENAI_KEY', 'PUT', { value: ALICE_KEY, userId: BOB, user_id: BOB })).status).toBe(204);
    expect((await (await forged('/v1/apps/appx/user-secrets')).json()) as unknown).toMatchObject({ secrets: [{ name: 'OPENAI_KEY' }] });
    expect((await forged('/v1/apps/appx/proxy/api.example.com/v1/costs')).status).toBe(200);
    expect(injected()).toEqual([`Bearer ${ALICE_KEY}`]);
    expect((await forged('/v1/apps/appx/user-secrets/OPENAI_KEY', 'DELETE', { userId: BOB })).status).toBe(204);
    expect(rows()).toEqual([{ app_id: 'appx', user_id: BOB, name: 'OPENAI_KEY' }]);
    const bobStill = await proxy(BOB);
    expect(bobStill.status).toBe(200);
    expect(injected()[1]).toBe(`Bearer ${BOB_KEY}`);
  });
});
