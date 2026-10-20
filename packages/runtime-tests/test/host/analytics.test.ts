import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #402 on workerd: an app origin serves the analytics loader and its event
// endpoint same-origin, and its HTML points at that loader, so an app whose own
// meta CSP is `connect-src 'self'` can count visits. The API binding is an echo.

async function seedRoute(slug: string, visibility?: 'private'): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES ('gh:1', 'github', '1', 'alice', NULL, ?1, ?1)").bind(Date.now()).run();
  const cols = await env.DB.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [slug, 'gh:1', ...required.map((c) => (/_at$/.test(c) ? Date.now() : `${slug}-${c}`))];
  await env.DB.prepare(`INSERT OR IGNORE INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
  if (visibility) {
    await env.DB.prepare("INSERT OR REPLACE INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, ?, '[\"viewer\"]', ?)").bind(slug, visibility, Date.now()).run();
  }
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
}

// The echo stub's visibility fixtures (stubs/echo-stub.js): for a `vis-*` app,
// owner-token is admitted and member-token is not.
const session = (token: string) => ({ Cookie: `__Host-pas_session=${token}` });
const event = (origin: string, headers: Record<string, string> = {}) => SELF.fetch(`${origin}/.pas/analytics/event`, {
  method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8', ...headers },
  body: '{"kind":"pageview","path":"/"}',
});

const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://cloudflareinsights.com">`;

beforeEach(async () => {
  for (const t of ['routes', 'app_custom_domains', 'app_listings', 'app_visibility', 'apps', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: same-origin analytics (#402)', () => {
  it("rewrites the app's API loader tag to the same-origin loader; the app's own CSP is left as is", async () => {
    await seedRoute('chess-academy');
    await env.APPS.put('apps/chess-academy/index.html',
      `<!doctype html><html><head>${CSP}<script defer src="https://api.proappstore.online/v1/analytics.js?app=chess-academy"></script><script src="https://example.com/other.js"></script></head><body></body></html>`,
      { httpMetadata: { contentType: 'text/html' } });
    const html = await (await SELF.fetch('https://chess-academy.proappstore.online/')).text();
    expect(html).toContain('<script defer src="/.pas/analytics.js"></script>');
    expect(html).not.toContain('api.proappstore.online/v1/analytics.js');
    expect(html).toContain('https://example.com/other.js');
    expect(html).toContain("connect-src 'self' https://cloudflareinsights.com");
  });

  it("serves the loader from the API over HostApi for the route's app, signed out", async () => {
    await seedRoute('chess-academy');
    const res = await SELF.fetch('https://chess-academy.proappstore.online/.pas/analytics.js?app=victim-app');
    expect(res.status).toBe(200);
    const echo = await res.json() as { worker: string; path: string; headers: Record<string, string> };
    expect(echo).toMatchObject({ worker: 'api-echo', path: '/v1/analytics.js' });
    expect(echo.headers['x-pas-app']).toBe('chess-academy');
  });

  it('takes a signed-out same-origin event; refuses a cross-origin one', async () => {
    await seedRoute('chess-academy');
    const ok = await SELF.fetch('https://chess-academy.proappstore.online/.pas/analytics/event', {
      method: 'POST', headers: { Origin: 'https://chess-academy.proappstore.online', 'Content-Type': 'text/plain' }, body: '{"kind":"pageview","path":"/"}',
    });
    expect(ok.status).toBeLessThan(300);
    const cross = await SELF.fetch('https://chess-academy.proappstore.online/.pas/analytics/event', {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: '{}',
    });
    expect(cross.status).toBe(403);
  });

  it('a private app takes no anonymous analytics: the gate runs first', async () => {
    await seedRoute('secret-app', 'private');
    const res = await SELF.fetch('https://secret-app.proappstore.online/.pas/analytics/event', {
      method: 'POST', headers: { Origin: 'https://secret-app.proappstore.online' }, body: '{}',
    });
    expect([401, 403, 302, 303]).toContain(res.status);
    expect(res.headers.get('x-events-accepted')).toBeNull();
  });

  // The upstream echo reaches the client only on the loader path; that the event
  // path forwards no cookie is asserted on the forwarded request in
  // host/src/analytics-mediation.test.ts. The stub answers 200 where the real
  // ingest answers 204, so these assert 2xx.

  it('signed in on a public app: the event is taken and the session cookie never goes upstream', async () => {
    await seedRoute('chess-academy');
    const res = await event('https://chess-academy.proappstore.online', session('owner-token'));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('Set-Cookie')).toBeNull();

    const loader = await SELF.fetch('https://chess-academy.proappstore.online/.pas/analytics.js', { headers: session('owner-token') });
    const echo = await loader.json() as { headers: Record<string, string> };
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers.authorization).toBeUndefined();
    expect(echo.headers['x-pas-app']).toBe('chess-academy');
  });

  it('a private app takes events from a signed-in member it admits, and from no one else', async () => {
    await seedRoute('vis-analytics', 'private');
    const origin = 'https://vis-analytics.proappstore.online';
    const admitted = await event(origin, session('owner-token'));
    expect(admitted.status).toBeGreaterThanOrEqual(200);
    expect(admitted.status).toBeLessThan(300);

    const refused = await event(origin, session('member-token'));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-events-accepted')).toBeNull();

    const anonymous = await event(origin);
    expect([401, 403, 302, 303]).toContain(anonymous.status);
    expect(anonymous.headers.get('x-events-accepted')).toBeNull();
  });

  it("the app's own custom apex and its tenant subdomains get the same-origin loader and take events", async () => {
    await seedRoute('chess-academy');
    await env.DB.prepare("INSERT INTO app_custom_domains (app_id, domain, status, added_at, kind) VALUES ('chess-academy', 'chessclubs.online', 'active', ?, 'wildcard')")
      .bind(Date.now()).run();
    await env.APPS.put('apps/chess-academy/index.html',
      `<!doctype html><html><head>${CSP}<script defer src="https://api.proappstore.online/v1/analytics.js?app=chess-academy"></script></head><body></body></html>`,
      { httpMetadata: { contentType: 'text/html' } });

    for (const origin of ['https://chessclubs.online', 'https://demo.chessclubs.online']) {
      const html = await (await SELF.fetch(`${origin}/`)).text();
      expect(html, origin).toContain('src="/.pas/analytics.js"');
      expect(html, origin).toContain("connect-src 'self' https://cloudflareinsights.com");

      const loader = await SELF.fetch(`${origin}/.pas/analytics.js`);
      expect(((await loader.json()) as { headers: Record<string, string> }).headers['x-pas-app'], origin).toBe('chess-academy');

      const ok = await event(origin);
      expect(ok.status, origin).toBeLessThan(300);
      // A tenant page cannot post as the apex, nor the apex as another app's origin.
      const cross = await event(origin, { Origin: 'https://chess-academy.proappstore.online' });
      expect(cross.status, origin).toBe(403);
    }
  });
});
