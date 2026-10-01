import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

// #259 (part of #251): a private app's WHOLE origin — `/`, assets, /.pas/api,
// /.pas/data, the data-<app> hostname — is served only to callers the backend's
// visibility/me allows, on real D1, R2 and the edge cache. The API binding
// answers visibility/me from the session token (stubs/echo-stub.js):
// owner-token / viewer-token → allowed, member-token → refused,
// expired-token → 401, anything else → 500.

const session = (token: string) => ({ Cookie: `__Host-pas_session=${token}` });
const navigate = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };
const SECRET = 'console.log("private app bundle")';

async function seedApp(slug: string, mode: 'private' | 'public' | null): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
  if (mode) {
    await env.DB.prepare("INSERT OR REPLACE INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, ?, '[\"viewer\"]', ?)")
      .bind(slug, mode, Date.now()).run();
  }
  await env.APPS.put(`apps/${slug}/index.html`, '<html>private diary</html>');
  await env.APPS.put(`apps/${slug}/assets/x.js`, SECRET);
}

/** Fetch and always read the body: the host tees served bodies into the edge cache. */
async function get(url: string, headers: Record<string, string> = {}, method = 'GET') {
  const res = await SELF.fetch(url, { method, headers, redirect: 'manual' });
  return { res, text: await res.text() };
}

afterEach(async () => {
  for (const t of ['routes', 'app_visibility', 'app_operator_gate']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: private apps (#259)', () => {
  it('signed out: a navigation to / goes to the platform sign-in page, an asset is 403, and neither is served from the edge cache', async () => {
    await seedApp('vis-anon', 'private');
    const nav = await get('https://vis-anon.proappstore.online/', navigate);
    expect(nav.res.status).toBe(302);
    const location = new URL(nav.res.headers.get('Location')!);
    expect(location.origin).toBe('https://vis-anon.proappstore.online');
    // The platform page with every method, not /.pas/auth/start (GitHub by default).
    expect(location.pathname).toBe('/.pas/auth/signin');
    expect(location.searchParams.get('return_to')).toBe('/');

    for (let i = 0; i < 2; i++) {
      const asset = await get('https://vis-anon.proappstore.online/assets/x.js');
      expect(asset.res.status).toBe(403);
      expect(asset.text).not.toContain('private app bundle');
      expect(asset.res.headers.get('Cache-Control')).toBe('no-store');
      expect(asset.res.headers.get('cf-cache-status')).not.toBe('HIT');
    }
  });

  it('serves the owner and a declared-role holder, never cacheably — and never replays that to a refused caller', async () => {
    await seedApp('vis-allow', 'private');
    for (const token of ['owner-token', 'viewer-token']) {
      const root = await get('https://vis-allow.proappstore.online/', { ...session(token), ...navigate });
      expect(root.res.status, token).toBe(200);
      expect(root.text).toBe('<html>private diary</html>');
      expect(root.res.headers.get('Cache-Control')).toBe('private, no-store');
      const asset = await get('https://vis-allow.proappstore.online/assets/x.js', session(token));
      expect(asset.res.status, token).toBe(200);
      expect(asset.text).toBe(SECRET);
      expect(asset.res.headers.get('Cache-Control')).toBe('private, no-store');
    }
    // What the owner was just served must not come back to anyone else.
    expect((await get('https://vis-allow.proappstore.online/assets/x.js')).res.status).toBe(403);
    expect((await get('https://vis-allow.proappstore.online/assets/x.js', session('member-token'))).res.status).toBe(403);
    expect(await caches.default.match('https://vis-allow.proappstore.online/assets/x.js')).toBeUndefined();
  });

  it('refuses a signed-in user who holds only member with 403 on /', async () => {
    await seedApp('vis-member', 'private');
    const r = await get('https://vis-member.proappstore.online/', { ...session('member-token'), ...navigate });
    expect(r.res.status).toBe(403);
    expect(r.text).not.toContain('private diary');
  });

  it('gates /.pas/api and /.pas/data, but leaves /.pas/auth reachable so a visitor can sign in', async () => {
    await seedApp('vis-planes', 'private');
    for (const path of ['/.pas/api/v1/kv/x', '/.pas/data/v1/query']) {
      expect((await get(`https://vis-planes.proappstore.online${path}`, session('member-token'))).res.status, path).toBe(403);
      expect((await get(`https://vis-planes.proappstore.online${path}`)).res.status, path).toBe(403);
    }
    const start = await get('https://vis-planes.proappstore.online/.pas/auth/start?provider=github&return_to=/');
    expect(start.res.status).not.toBe(403);
    expect(start.res.status).toBeLessThan(500);
  });

  it('treats a session the backend rejects as no session and clears the cookie', async () => {
    await seedApp('vis-expired', 'private');
    const r = await get('https://vis-expired.proappstore.online/', { ...session('expired-token'), ...navigate });
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get('Set-Cookie')).toContain('__Host-pas_session=; Max-Age=0');
  });

  it('fails closed with 503 when the visibility lookup fails', async () => {
    await seedApp('vis-broken', 'private');
    const r = await get('https://vis-broken.proappstore.online/assets/x.js', session('broken-token'));
    expect(r.res.status).toBe(503);
    expect(r.text).not.toContain('private app bundle');
  });

  it('does not gate the data-<app> hostname: the data worker requires a developer team role itself', async () => {
    // A host check there cost every app a D1 read and protected nothing: every
    // SQL route on the data worker needs developer+ (a subset of who a private
    // app admits), and the worker answers on its own custom domain anyway.
    await seedApp('vis-data', 'private');
    const url = 'https://data-vis-data.proappstore.online/v1/query';
    for (const headers of [{}, { Authorization: 'Bearer member-token' }, { Authorization: 'Bearer broken-token' }]) {
      const r = await get(url, headers, 'POST');
      expect(r.res.status).toBe(200);
      expect(r.res.headers.get('X-Stub-Worker')).toBe('outbound-echo');
      expect(JSON.parse(r.text).host).toBe('pas-data-vis-data.test.workers.dev');
    }
  });

  it('a public app asks nothing: a session that would fail the lookup is irrelevant to it', async () => {
    // `broken-token` 500s visibility/me; a public app never asks, so it is served.
    await seedApp('vis-public', 'public');
    await seedApp('vis-undeclared', null);
    for (const slug of ['vis-public', 'vis-undeclared']) {
      const root = await get(`https://${slug}.proappstore.online/`, { ...session('broken-token'), ...navigate });
      expect(root.res.status, slug).toBe(200);
      expect(root.res.headers.get('Cache-Control'), slug).not.toBe('private, no-store');
      const data = await get(`https://data-${slug}.proappstore.online/v1/query`, { Authorization: 'Bearer broken-token' }, 'POST');
      expect(data.res.status, slug).toBe(200);
    }
  });

  it('a public app with a warm edge cache flips to private: the next request is gated, never served from cache', async () => {
    await seedApp('vis-flip', 'public');
    for (let i = 0; i < 2; i++) {
      const warm = await get('https://vis-flip.proappstore.online/assets/x.js');
      expect(warm.res.status).toBe(200);
    }
    expect(await caches.default.match('https://vis-flip.proappstore.online/assets/x.js')).toBeDefined();

    await env.DB.prepare("INSERT OR REPLACE INTO app_visibility (app_id, mode, roles, created_at) VALUES ('vis-flip', 'private', '[\"viewer\"]', ?)").bind(Date.now()).run();
    const after = await get('https://vis-flip.proappstore.online/assets/x.js');
    expect(after.res.status).toBe(403);
    expect(after.text).not.toContain('private app bundle');
    expect(after.res.headers.get('X-PAS-Visibility')).toBe('private');
    // An allowed caller is served from R2, never the copy cached while public:
    // fails if `privateApp` is dropped from skipEdgeCache.
    await env.APPS.put('apps/vis-flip/assets/x.js', 'console.log("v2")');
    const owner = await get('https://vis-flip.proappstore.online/assets/x.js', session('owner-token'));
    expect(owner.res.status).toBe(200);
    expect(owner.text).toBe('console.log("v2")');
    expect(owner.res.headers.get('Cache-Control')).toBe('private, no-store');
    await caches.default.delete('https://vis-flip.proappstore.online/assets/x.js');
  });

  it('gates a private app reached through an active custom domain (visibility rides on the route lookup)', async () => {
    await seedApp('vis-custom', 'private');
    await env.DB.prepare("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('vis-custom', 'diary.example.com', 'active', ?)").bind(Date.now()).run().catch(async (e) => {
      throw new Error(`seed custom domain: ${String(e)}`);
    });
    const r = await get('https://diary.example.com/assets/x.js');
    expect(r.res.status).toBe(403);
    expect(r.text).not.toContain('private app bundle');
    await env.DB.prepare("DELETE FROM app_custom_domains WHERE app_id = 'vis-custom'").run();
  });
});

const form = (data: Record<string, string>, token?: string, origin = 'https://vis-invite.proappstore.online') => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...(token ? session(token) : {}) },
  body: new URLSearchParams(data).toString(),
});
/** Sign in with email + password through the host, as the sign-in page's script does; returns the session cookie value. */
async function passwordSignIn(app: string, login: string): Promise<string> {
  const res = await SELF.fetch(`https://${app}.proappstore.online/.pas/auth/credentials/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: `https://${app}.proappstore.online` },
    body: JSON.stringify({ login, password: 'pw' }),
  });
  await res.text();
  expect(res.status).toBe(200);
  const cookie = /__Host-pas_session=([^;]+)/.exec(res.headers.get('Set-Cookie') ?? '');
  expect(cookie).not.toBeNull();
  return decodeURIComponent(cookie![1]!);
}

describe('host: platform sign-in and invite pages for private apps (#259 review)', () => {
  it('the sign-in page is reachable on a private app and offers every method — not just GitHub', async () => {
    await seedApp('vis-signin', 'private');
    const r = await get('https://vis-signin.proappstore.online/.pas/auth/signin?return_to=%2Fnotes', navigate);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('Cache-Control')).toBe('no-store');
    expect(r.res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(r.text).toContain('/.pas/auth/start?provider=github&amp;return_to=%2Fnotes');
    expect(r.text).toContain('/.pas/auth/start?provider=google&amp;return_to=%2Fnotes');
    expect(r.text).toContain('id="email-link"');
    expect(r.text).toContain('id="password"');
    expect(r.text).not.toContain('private diary');
    // Google goes to the API's Google start, not GitHub's.
    const google = await get('https://vis-signin.proappstore.online/.pas/auth/start?provider=google&return_to=/notes');
    expect(google.res.status).toBe(302);
    expect(new URL(google.res.headers.get('Location')!).pathname).toBe('/v1/auth/google/start');
  });

  it('a non-GitHub (email + password) user the app is shared with can sign in and open it', async () => {
    await seedApp('vis-cred', 'private');
    expect((await get('https://vis-cred.proappstore.online/', navigate)).res.status).toBe(302);
    const token = await passwordSignIn('vis-cred', 'casey');
    const root = await get('https://vis-cred.proappstore.online/', { ...session(token), ...navigate });
    expect(root.res.status).toBe(200);
    expect(root.text).toBe('<html>private diary</html>');
  });

  it('an invitee with a code can sign in, redeem it, and then open the app', async () => {
    await seedApp('vis-invite', 'private');
    const app = 'https://vis-invite.proappstore.online';

    // 1. The invite link, signed out → the platform sign-in page, returning to it.
    const link = await get(`${app}/join/JOIN42`, navigate);
    expect(link.res.status).toBe(302);
    const signin = new URL(link.res.headers.get('Location')!);
    expect(signin.pathname).toBe('/.pas/auth/signin');
    expect(signin.searchParams.get('return_to')).toBe('/join/JOIN42');
    expect((await get(signin.toString(), navigate)).res.status).toBe(200);

    // 2. Signs in (no GitHub account) and comes back: still refused, so the gate
    //    sends the link to the platform invite page instead of a bare 403.
    const token = await passwordSignIn('vis-invite', 'invitee');
    const back = await get(`${app}/join/JOIN42`, { ...session(token), ...navigate });
    expect(back.res.status).toBe(302);
    expect(back.res.headers.get('Location')).toBe(`${app}/.pas/auth/join?code=JOIN42`);
    const invite = await get(`${app}/.pas/auth/join?code=JOIN42`, { ...session(token), ...navigate });
    expect(invite.res.status).toBe(200);
    expect(invite.res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(invite.text).toContain('Accept invite');
    expect(invite.text).toContain('invitee');
    expect((await get(`${app}/`, session(token))).res.status).toBe(403); // not yet

    // 3. Accepts: redeemed as this session, for THIS app, then sent to the link.
    const accepted = await SELF.fetch(`${app}/.pas/auth/join`, form({ code: 'JOIN42' }, token));
    await accepted.text();
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get('Location')).toBe(`${app}/join/JOIN42`);

    // 4. In — at once, although a refusal for this session was just cached.
    const joined = await get(`${app}/join/JOIN42`, { ...session(token), ...navigate });
    expect(joined.res.status).toBe(200);
    expect(joined.text).toBe('<html>private diary</html>');
    expect((await get(`${app}/assets/x.js`, session(token))).res.status).toBe(200);
  });

  it('redemption is a same-origin POST only, and needs a session', async () => {
    await seedApp('vis-invite-csrf', 'private');
    const app = 'https://vis-invite-csrf.proappstore.online';
    const cross = await SELF.fetch(`${app}/.pas/auth/join`, form({ code: 'JOIN42' }, 'invitee-token', 'https://evil.example'));
    await cross.text();
    expect(cross.status).toBe(403);
    const anon = await SELF.fetch(`${app}/.pas/auth/join`, form({ code: 'JOIN42' }, undefined, app));
    await anon.text();
    expect(anon.status).toBe(303);
    expect(new URL(anon.headers.get('Location')!).pathname).toBe('/.pas/auth/signin');
    // A signed-out GET of the invite page goes to sign-in, returning to the link.
    const page = await get(`${app}/.pas/auth/join?code=JOIN42`, navigate);
    expect(page.res.status).toBe(303);
    expect(new URL(page.res.headers.get('Location')!).searchParams.get('return_to')).toBe('/join/JOIN42');
  });

  it('an unknown code, or one whose role does not open the app, is explained — never a redirect loop', async () => {
    await seedApp('vis-invite-bad', 'private');
    const app = 'https://vis-invite-bad.proappstore.online';
    const unknown = await SELF.fetch(`${app}/.pas/auth/join`, { ...form({ code: 'NOPE99' }, 'invitee-token', app) });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('does not exist for this app');
    const roleless = await SELF.fetch(`${app}/.pas/auth/join`, form({ code: 'JOIN42' }, 'roleless-token', app));
    expect(roleless.status).toBe(200);
    expect(await roleless.text()).toContain('does not open');
  });

  it("stamps a private app's pages with the pas-visibility marker (and only a private app's)", async () => {
    for (const [slug, mode] of [['vis-meta-private', 'private'], ['vis-meta-public', 'public']] as const) {
      await seedApp(slug, mode);
      await env.APPS.put(`apps/${slug}/index.html`, '<html><head><meta name="pas-visibility" content="forged"></head><body>x</body></html>');
      const r = await get(`https://${slug}.proappstore.online/`, { ...session('owner-token'), ...navigate });
      expect(r.res.status, slug).toBe(200);
      expect(r.text.includes('<meta name="pas-visibility" content="private">'), slug).toBe(mode === 'private');
      expect(r.text, slug).not.toContain('forged');
    }
  });
});
