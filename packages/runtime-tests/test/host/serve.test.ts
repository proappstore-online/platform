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

  it('replaces copied homepage og:url with one identity for each declared public record', async () => {
    await seedRoute('record-social');
    const base = shell.replace('</head>', '<meta property="og:url" content="https://record-social.proappstore.online/"><meta property="og:url" content="https://old.example/"></head>');
    await env.APPS.put('apps/record-social/index.html', base);
    await pageMeta('record-social', '/p/:id', 'fixture_product_meta', 'id');
    for (const id of ['first', 'second']) {
      const url = `https://record-social.proappstore.online/p/${id}`;
      const response = await SELF.fetch(url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html.match(/property="og:url"/g)).toHaveLength(1);
      expect(html).toContain(`property="og:url" content="${url}"`);
      expect(html).toContain(`rel="canonical" href="${url}"`);
      expect(html).toContain(`<title>Product ${id}</title>`);
    }
    const root = await (await SELF.fetch('https://record-social.proappstore.online/')).text();
    expect(root).toContain('<title>Trade Port</title>');
    expect(root).not.toContain('Product first');
  });

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

  it('returns real uncached noindex 404s for opted-in missing records, including HEAD', async () => {
    await seedRoute('missing-record');
    await env.APPS.put('apps/missing-record/index.html', shell.replace('</head>', '<link rel="canonical" href="https://missing-record.proappstore.online/"><meta name="robots" content="index, follow"><script src="/assets/app.js"></script></head>').replace('<body>', '<body><div id="app-shell"></div>'));
    await pageMeta('missing-record', '/p/:id', 'fixture_product_meta', 'id');
    await env.DB.prepare('UPDATE app_page_meta SET not_found_status = 404 WHERE app_id = ?').bind('missing-record').run();
    for (const method of ['GET', 'HEAD']) {
      const response = await SELF.fetch('https://missing-record.proappstore.online/p/missing', { method });
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      const html = await response.text();
      if (method === 'HEAD') expect(html).toBe('');
      else {
        expect(html).toContain('Page not found');
        expect(html).not.toContain('rel="canonical"');
        expect(html).toContain('id="app-shell"');
        expect(html).toContain('src="/assets/app.js"');
        expect(html).toContain('name="pas-auth-mode" content="platform-cookie"');
        expect(html).not.toContain('name="pas-visibility"');
        expect(html).not.toContain('content="index, follow"');
        expect(html.match(/name="robots"/g)).toHaveLength(1);
      }
    }
    // A present record, the app root and undeclared signed-in SPA paths remain intact.
    for (const path of ['/p/abc', '/', '/app/inbox']) {
      const response = await SELF.fetch(`https://missing-record.proappstore.online${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text()).not.toContain('Page not found');
    }
  });

  it('never labels opted-in upstream action failures as missing records', async () => {
    await seedRoute('failed-record');
    await env.APPS.put('apps/failed-record/index.html', shell);
    await pageMeta('failed-record', '/p/:id', 'broken_meta', 'id');
    await env.DB.prepare('UPDATE app_page_meta SET not_found_status = 404 WHERE app_id = ?').bind('failed-record').run();
    const response = await SELF.fetch('https://failed-record.proappstore.online/p/missing');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Trade Port</title>');
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

// #350: the console's Code Health panel reads /.vcqa/ cross-origin. Every answer there must
// carry CORS, or the browser hides a 404 / a private app's refusal and the fetch fails with
// "Failed to fetch" instead of showing the status. Other paths keep their own (no) CORS.
describe('host: /.vcqa/ answers are readable cross-origin (#350)', () => {
  const CONSOLE = { Origin: 'https://console.proappstore.online' };
  const read = async (url: string, headers: Record<string, string> = CONSOLE) => {
    const res = await SELF.fetch(url, { headers, redirect: 'manual' });
    await res.text(); // the host tees served bodies into the edge cache
    return res;
  };

  it('a found report, a 304, a missing report and an unknown app all allow any origin', async () => {
    await seedRoute('scanned');
    await seedRoute('unscanned');
    await env.APPS.put('apps/scanned/.vcqa/report.json', '{"score":80}', { httpMetadata: { contentType: 'application/json' } });
    await env.APPS.put('apps/unscanned/index.html', '<html>app</html>');

    const found = await read('https://scanned.proappstore.online/.vcqa/report.json?t=1');
    expect(found.status).toBe(200);
    expect(found.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const notModified = await read('https://scanned.proappstore.online/.vcqa/report.json?t=2', { ...CONSOLE, 'If-None-Match': found.headers.get('ETag')! });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('Access-Control-Allow-Origin')).toBe('*');

    for (const url of ['https://unscanned.proappstore.online/.vcqa/report.json?t=1', 'https://nobody.proappstore.online/.vcqa/report.json']) {
      const missing = await read(url);
      expect(missing.status, url).toBe(404);
      expect(missing.headers.get('Access-Control-Allow-Origin'), url).toBe('*');
    }
  });

  it("a private app's refusal on /.vcqa/ is readable as a status; nothing else gains CORS", async () => {
    await seedRoute('secret');
    await env.DB.prepare("INSERT OR REPLACE INTO app_visibility (app_id, mode, roles, created_at) VALUES ('secret', 'private', '[\"viewer\"]', ?)").bind(Date.now()).run();
    await env.APPS.put('apps/secret/.vcqa/report.json', '{"score":80}');
    try {
      const refused = await read('https://secret.proappstore.online/.vcqa/report.json');
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.headers.get('Access-Control-Allow-Origin')).toBe('*');
      // The report itself is still not served to a signed-out caller.
      const body = await (await SELF.fetch('https://secret.proappstore.online/.vcqa/report.json', { headers: CONSOLE, redirect: 'manual' })).text();
      expect(body).not.toContain('score');
    } finally {
      await env.DB.prepare("DELETE FROM app_visibility WHERE app_id = 'secret'").run();
    }

    await seedRoute('plain');
    await env.APPS.put('apps/plain/assets/app.js', 'console.log(1)');
    expect((await read('https://plain.proappstore.online/assets/app.js')).headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await read('https://plain.proappstore.online/assets/missing.js')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});


it('adds canonical and listing fallback only to approved public roots and declared public routes', async () => {
  await seedRoute('seo-public');
  await env.APPS.put('apps/seo-public/index.html', '<html><head><title>Custom App Title</title></head><body><div id="root"></div></body></html>');
  const response = await SELF.fetch('https://seo-public.proappstore.online/?utm_source=test', { headers: { 'If-None-Match': '"old"' } });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('ETag')).toBeNull();
  expect(html).toContain('<title>Custom App Title</title>');
  expect(html).toContain('<link rel="canonical" href="https://seo-public.proappstore.online/">');
  expect(html).toContain('<meta name="description" content="Approved public description">');
  expect(html).toContain('<div id="root"></div>');
  const deep = await (await SELF.fetch('https://seo-public.proappstore.online/workspace/private-item')).text();
  expect(deep).not.toContain('rel="canonical"');
  expect(deep).not.toContain('Approved public description');
  const sitemap = await SELF.fetch('https://seo-public.proappstore.online/sitemap.xml');
  expect(sitemap.status).toBe(200);
  expect(await sitemap.text()).toContain('<loc>https://seo-public.proappstore.online/</loc>');
  expect(await (await SELF.fetch('https://seo-public.proappstore.online/robots.txt')).text()).toContain('Sitemap: https://seo-public.proappstore.online/sitemap.xml');
});

it('preserves explicit app canonical and noindex instructions without advertising a noindex root', async () => {
  await seedRoute('seo-public');
  await env.APPS.put('apps/seo-public/index.html', '<html><head><meta name="robots" content="noindex"><link rel="canonical" href="https://custom.example/"><meta property="og:url" content="https://custom.example/"><meta name="description" content="Custom description"></head><body></body></html>');
  const html = await (await SELF.fetch('https://seo-public.proappstore.online/')).text();
  expect(html).toContain('name="robots" content="noindex"');
  expect(html).toContain('href="https://custom.example/"');
  expect(html).toContain('name="description" content="Custom description"');
  expect(html).toContain('property="og:url" content="https://custom.example/"');
  const sitemap = await SELF.fetch('https://seo-public.proappstore.online/sitemap.xml');
  expect(sitemap.status).toBe(404);
  await sitemap.text();
});

it('replaces legacy repeated listing placeholders and starter descriptions with approved public copy', async () => {
  await seedRoute('seo-public');
  await seedApp('seo-public');
  await env.APPS.put('apps/seo-public/index.html', '<html><head><title>App</title><meta name="description" content="Explore seo-public."><meta property="og:description" content="seo-public on ProAppStore"><meta name="twitter:description" content="App-owned social description"></head><body></body></html>');
  const cols = await env.DB.prepare('PRAGMA table_info(app_listings)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['app_id', 'tagline', 'icon_url'].includes(c.name)).map((c) => c.name);
  const names = ['app_id', 'tagline', 'icon_url', ...required];
  const values = ['seo-public', 'x'.repeat(60), null, ...required.map((c) => (/_at$/.test(c) ? Date.now() : `x-${c}`))];
  await env.DB.prepare(`INSERT INTO app_listings (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
  const response = await SELF.fetch('https://seo-public.proappstore.online/?source=legacy-copy-test');
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('name="description" content="Approved public description"');
  expect(html).toContain('property="og:description" content="Approved public description"');
  expect(html).toContain('name="twitter:description" content="App-owned social description"');
  expect(html).not.toContain('x'.repeat(60));
});


it('does not advertise a secondary host when an approved app selects its custom domain', async () => {
  await seedRoute('seo-public');
  await env.APPS.put('apps/seo-public/index.html', '<html><head><link rel="canonical" href="https://custom.example/"></head><body>Public app</body></html>');
  const sitemap = await SELF.fetch('https://seo-public.proappstore.online/sitemap.xml');
  expect(sitemap.status).toBe(404);
  await sitemap.text();
  expect(await (await SELF.fetch('https://seo-public.proappstore.online/robots.txt')).text()).toBe('User-agent: *\nAllow: /\n');
  const head = await SELF.fetch('https://seo-public.proappstore.online/', { method: 'HEAD' });
  expect(head.headers.get('ETag')).toBeNull();
  expect(await head.text()).toBe('');
});


// Google treats name/content as case-insensitive and `none` as noindex,
// nofollow. A parameter value (max-image-preview:none) is not that directive.
describe('host: fallback discovery respects app robots directives', () => {
  it.each([
    ['ordinary noindex', '<meta name="robots" content="noindex">', false],
    ['none alias', '<meta name="robots" content="none">', false],
    ['Googlebot none alias', '<meta name="googlebot" content="none">', false],
    ['mixed-case name', '<meta content="NOINDEX, follow" name="RoBoTs">', false],
    ['mixed-case Googlebot', '<META CONTENT="NoNe" NAME="GoogleBot">', false],
    ['restrictive duplicate wins', '<meta name="robots" content="noindex"><meta name="robots" content="index">', false],
    ['preview restriction only', '<meta name="robots" content="max-image-preview:none, index">', true],
    ['image restriction only', '<meta name="robots" content="noimageindex, follow">', true],
    ['other crawler', '<meta name="otherbot" content="noindex">', true],
    ['comments and scripts', '<!-- <meta name="robots" content="noindex"> --><script>const sample = \'<meta name="robots" content="none">\';</script>', true],
  ])('%s', async (_label, meta, indexable) => {
    await seedRoute('seo-public');
    await env.APPS.put('apps/seo-public/index.html', `<html><head>${meta}</head><body>App</body></html>`);
    for (const method of ['GET', 'HEAD']) {
      const sitemap = await SELF.fetch('https://seo-public.proappstore.online/sitemap.xml', { method });
      const xml = await sitemap.text();
      expect(sitemap.status).toBe(indexable ? 200 : 404);
      if (method === 'HEAD') expect(xml).toBe('');
      else if (indexable) expect(xml).toContain('<loc>https://seo-public.proappstore.online/</loc>');
      const robots = await SELF.fetch('https://seo-public.proappstore.online/robots.txt', { method });
      expect(robots.status).toBe(200);
      const text = await robots.text();
      if (method === 'HEAD') expect(text).toBe('');
      else {
        expect(text).toContain('Allow: /');
        expect(text.includes('Sitemap:')).toBe(indexable);
      }
    }
  });
});
