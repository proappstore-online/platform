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
  it('signed out: a navigation to / goes to sign-in, an asset is 403, and neither is served from the edge cache', async () => {
    await seedApp('vis-anon', 'private');
    const nav = await get('https://vis-anon.proappstore.online/', navigate);
    expect(nav.res.status).toBe(302);
    const location = new URL(nav.res.headers.get('Location')!);
    expect(location.origin).toBe('https://vis-anon.proappstore.online');
    expect(location.pathname).toBe('/.pas/auth/start');
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

  it('gates the data-<app> hostname by Bearer: none → 401, not allowed → 403, allowed → proxied', async () => {
    await seedApp('vis-data', 'private');
    const url = 'https://data-vis-data.proappstore.online/v1/query';
    expect((await get(url, {}, 'POST')).res.status).toBe(401);
    expect((await get(url, { Authorization: 'Bearer member-token' }, 'POST')).res.status).toBe(403);
    const ok = await get(url, { Authorization: 'Bearer owner-token' }, 'POST');
    expect(ok.res.status).toBe(200);
    expect(ok.res.headers.get('X-Stub-Worker')).toBe('outbound-echo');
    expect(JSON.parse(ok.text).host).toBe('pas-data-vis-data.test.workers.dev');
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
});
