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
  for (const t of ['routes', 'app_listings', 'apps', 'users', 'app_page_meta', 'app_sitemap']) await env.DB.prepare(`DELETE FROM ${t}`).run();
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

// #210: per-route link-preview meta and a generated sitemap, from public actions
// the app declared — on the real rewriter, R2, D1 and edge cache. The API binding
// answers `fixture_*` actions (stubs/echo-stub.js); anything else 500s.
describe('host: per-route page meta and sitemap (#210)', () => {
  const pageMeta = (slug: string, path: string, action: string, param: string, position = 0) =>
    env.DB.prepare('INSERT INTO app_page_meta (app_id, position, path_pattern, action_name, param_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(slug, position, path, action, param, Date.now()).run();
  const shell = '<!doctype html><html><head><title>Trade Port</title><meta property="og:title" content="Trade Port"></head><body></body></html>';

  it('rewrites title and og tags for a matching path; the root keeps the app title', async () => {
    await seedRoute('pm1');
    await env.APPS.put('apps/pm1/index.html', shell);
    await pageMeta('pm1', '/p/:id', 'fixture_product_meta', 'id');

    const product = await SELF.fetch('https://pm1.proappstore.online/p/abc');
    expect(product.status).toBe(200);
    const html = await product.text();
    expect(html).toContain('<title>Product abc</title>');
    expect(html).toContain('<meta property="og:title" content="Product abc">');
    expect(html).toContain('content="A fine product"');
    expect(html).toContain('content="https://cdn.test/p.png"');

    const root = await (await SELF.fetch('https://pm1.proappstore.online/')).text();
    expect(root).toContain('<title>Trade Port</title>');
    expect(root).not.toContain('Product');
  });

  it('fails open to app-level meta with a 200 when the action errors or returns no row', async () => {
    await seedRoute('pm2');
    await env.APPS.put('apps/pm2/index.html', shell);
    await pageMeta('pm2', '/p/:id', 'fixture_product_meta', 'id', 0);
    await pageMeta('pm2', '/b/:id', 'broken_meta', 'id', 1);
    for (const path of ['/p/missing', '/b/x']) {
      const res = await SELF.fetch(`https://pm2.proappstore.online${path}`);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain('<title>Trade Port</title>');
      expect(html, path).not.toContain('Product');
    }
  });

  it('serves /sitemap.xml from the declared action, paged by cursor, cached for an hour', async () => {
    await seedRoute('sm1');
    await env.DB.prepare('INSERT INTO app_sitemap (app_id, action_name, created_at) VALUES (?, ?, ?)').bind('sm1', 'fixture_sitemap', Date.now()).run();
    const res = await SELF.fetch('https://sm1.proappstore.online/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/xml');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    const body = await res.text();
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body).toContain('<loc>https://sm1.proappstore.online/p/a</loc><lastmod>2026-09-01T00:00:00.000Z</lastmod>');
    expect(body).toContain('<loc>https://sm1.proappstore.online/p/b</loc>');
    expect(body).toContain('<loc>https://sm1.proappstore.online/p/c&amp;d</loc>');
  });

  it('answers 503 (never an empty, cached sitemap) when the action fails; serves a static file when none is declared', async () => {
    await seedRoute('sm2');
    await env.DB.prepare('INSERT INTO app_sitemap (app_id, action_name, created_at) VALUES (?, ?, ?)').bind('sm2', 'broken_sitemap', Date.now()).run();
    const broken = await SELF.fetch('https://sm2.proappstore.online/sitemap.xml');
    expect(broken.status).toBe(503);
    expect(broken.headers.get('Cache-Control')).toBe('no-store');
    await broken.text();

    await seedRoute('sm3');
    await env.APPS.put('apps/sm3/sitemap.xml', '<urlset>static</urlset>');
    const stat = await SELF.fetch('https://sm3.proappstore.online/sitemap.xml');
    expect(stat.status).toBe(200);
    expect(await stat.text()).toBe('<urlset>static</urlset>');
  });
});
