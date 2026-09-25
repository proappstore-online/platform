import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

async function seedApp(id: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES ('gh:1', 'github', '1', 'alice', NULL, ?1, ?1)").bind(Date.now()).run();
  const cols = await env.DB.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [id, 'gh:1', ...required.map((c) => (/_at$/.test(c) ? Date.now() : `${id}-${c}`))];
  await env.DB.prepare(`INSERT OR IGNORE INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
}

async function seedRoute(slug: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
}

beforeEach(async () => {
  for (const t of ['routes', 'app_listings', 'apps', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

/** The app-serving path: D1 route lookup → R2 object → headers, on real bindings. */
describe('host: serving a published app from R2', () => {
  it('serves the file behind the route with security headers, an ETag, and 304 on a match', async () => {
    await seedRoute('demo');
    await env.APPS.put('apps/demo/index.html', '<!doctype html><html><head><title>Demo</title></head><body>hi</body></html>', { httpMetadata: { contentType: 'text/html' } });
    await env.APPS.put('apps/demo/assets/app.js', 'console.log(1)');

    const html = await SELF.fetch('https://demo.proappstore.online/');
    expect(html.status).toBe(200);
    expect(html.headers.get('Content-Type')).toContain('text/html');
    expect(html.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await html.text()).toContain('<title>Demo</title>');

    const js = await SELF.fetch('https://demo.proappstore.online/assets/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
    expect(await js.text()).toBe('console.log(1)'); // read every body: the host tees it into the edge cache
    const etag = js.headers.get('ETag')!;
    expect(etag).toBeTruthy();
    const notModified = await SELF.fetch('https://demo.proappstore.online/assets/app.js', { headers: { 'If-None-Match': etag } });
    expect(notModified.status).toBe(304);
    await notModified.text();
    const head = await SELF.fetch('https://demo.proappstore.online/assets/app.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('SPA fallback for extension-less paths, 404 for a missing asset, an unknown slug, and a source map', async () => {
    await seedRoute('spa');
    await env.APPS.put('apps/spa/index.html', '<html>spa</html>');
    await env.APPS.put('apps/spa/assets/app.js.map', '{"version":3}');
    const status = async (url: string, init?: RequestInit) => { const r = await SELF.fetch(url, init); await r.text(); return r.status; };
    expect(await (await SELF.fetch('https://spa.proappstore.online/deep/link')).text()).toBe('<html>spa</html>');
    expect(await status('https://spa.proappstore.online/assets/missing.js')).toBe(404);
    expect(await status('https://spa.proappstore.online/assets/app.js.map')).toBe(404);
    expect(await status('https://nobody.proappstore.online/')).toBe(404);
    expect(await status('https://spa.proappstore.online/', { method: 'POST' })).toBe(405);
  });

  it('injects listing metadata from D1 into the served HTML', async () => {
    await seedRoute('meta');
    await seedApp('meta'); // app_listings.app_id references apps(id)
    await env.APPS.put('apps/meta/index.html', '<!doctype html><html><head><title>Meta App</title></head><body></body></html>');
    const cols = await env.DB.prepare('PRAGMA table_info(app_listings)').all<{ name: string; notnull: number; dflt_value: string | null }>();
    const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['app_id', 'tagline', 'icon_url'].includes(c.name)).map((c) => c.name);
    const names = ['app_id', 'tagline', 'icon_url', ...required];
    const values = ['meta', 'The tagline', 'https://cdn.test/icon.png', ...required.map((c) => (/_at$/.test(c) ? Date.now() : `x-${c}`))];
    await env.DB.prepare(`INSERT INTO app_listings (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();

    const html = await (await SELF.fetch('https://meta.proappstore.online/')).text();
    expect(html).toContain('The tagline');
    expect(html).toContain('https://cdn.test/icon.png');
  });

  it('mediates self-registration on the app origin to the API binding, forwarding the visitor address (#118)', async () => {
    await seedRoute('join');
    const res = await SELF.fetch('https://join.proappstore.online/.pas/auth/credentials/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://join.proappstore.online', 'Sec-Fetch-Site': 'same-origin', 'cf-connecting-ip': '203.0.113.7' },
      body: JSON.stringify({ email: 'a@example.com', password: 'correct-horse-battery', turnstileToken: 'tok' }),
    });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as { worker: string; path: string; headers: Record<string, string>; body: string };
    expect(echo).toMatchObject({ worker: 'api-echo', path: '/v1/auth/credentials/register' });
    expect(echo.headers['cf-connecting-ip']).toBe('203.0.113.7');
    expect(JSON.parse(echo.body)).toEqual({ email: 'a@example.com', password: 'correct-horse-battery', turnstileToken: 'tok' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
