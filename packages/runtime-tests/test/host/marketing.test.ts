import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #399/#409 on real D1 + R2: about-<app> serves only the active immutable
// revision of any app — private and unlisted ones included (#409) — beside an
// unchanged runnable app origin, and a revision change or an unpublish is seen
// on the very next request.

async function seedApp(id: string): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES ('gh:1', 'github', '1', 'alice', NULL, ?1, ?1)").bind(Date.now()).run();
  const cols = await env.DB.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>();
  const required = (cols.results ?? []).filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [id, 'gh:1', ...required.map((c) => (/_at$/.test(c) ? Date.now() : `${id}-${c}`))];
  await env.DB.prepare(`INSERT OR IGNORE INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
}

async function publish(id: string, revision: string | null, listed = 1): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO app_storefront_publication (app_id, listed, updated_at) VALUES (?, ?, 1)').bind(id, listed).run();
  await env.DB.prepare('INSERT OR REPLACE INTO app_marketing_sites (app_id, active_revision, updated_at) VALUES (?, ?, 1)').bind(id, revision).run();
}

async function artifact(id: string, revision: string, heading: string): Promise<void> {
  const prefix = `marketing/${id}/revisions/${revision}/`;
  await env.APPS.put(`${prefix}index.html`, `<!doctype html><h1>${heading}</h1>`);
  await env.APPS.put(`${prefix}robots.txt`, 'User-agent: *\nAllow: /\n');
  await env.APPS.put(`${prefix}assets/hero.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await env.APPS.put(`${prefix}assets/app.js.map`, '{"version":3}');
  await env.APPS.put(`${prefix}artifact-manifest.json`, '{"schemaVersion":1}');
}

const get = async (url: string, init?: RequestInit) => {
  const r = await SELF.fetch(url, init);
  return { status: r.status, headers: r.headers, body: await r.text() };
};
const ABOUT = 'https://about-shop.proappstore.online';

beforeEach(async () => {
  for (const t of ['routes', 'app_marketing_sites', 'app_storefront_publication', 'app_visibility', 'apps', 'users']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
  await seedApp('shop');
  await seedApp('rival');
  await env.DB.prepare("INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES ('shop', 'proappstore.online', 'apps/shop', 'pas', 'r2', 1, 1)").run();
  await env.APPS.put('apps/shop/index.html', '<html>the runnable app</html>');
  await artifact('shop', 'rev-1', 'Shop v1');
  await artifact('shop', 'rev-2', 'Shop v2');
  await artifact('rival', 'rev-1', 'Rival');
});

describe('host: about-<app> marketing origin (#399)', () => {
  it('serves the active revision with static-site headers, while the app origin is unchanged', async () => {
    await publish('shop', 'rev-1');
    const page = await get(`${ABOUT}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Shop v1');
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');
    expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('X-Frame-Options')).toBe('DENY');
    expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(page.headers.get('X-PAS-Marketing-Revision')).toBe('rev-1');

    const image = await get(`${ABOUT}/assets/hero.png`, { method: 'HEAD' });
    expect(image.status).toBe(200);
    expect(image.headers.get('Content-Type')).toBe('image/png');
    expect(image.body).toBe('');
    const etag = page.headers.get('ETag')!;
    expect((await get(`${ABOUT}/`, { headers: { 'If-None-Match': etag } })).status).toBe(304);

    const app = await get('https://shop.proappstore.online/');
    expect(app.status).toBe(200);
    expect(app.body).toBe('<html>the runnable app</html>');
  });

  it('a revision switch and an unpublish take effect on the next request', async () => {
    await publish('shop', 'rev-1');
    expect((await get(`${ABOUT}/`)).body).toContain('Shop v1');

    await publish('shop', 'rev-2');
    const switched = await get(`${ABOUT}/`);
    expect(switched.body).toContain('Shop v2');
    expect(switched.headers.get('X-PAS-Marketing-Revision')).toBe('rev-2');

    await publish('shop', null);
    const gone = await get(`${ABOUT}/`);
    expect(gone.status).toBe(404); // unpublished
    expect(gone.headers.get('Cache-Control')).toBe('no-store');
  });

  it('#409: a private, unlisted app with an active revision serves its marketing site; its app origin stays private', async () => {
    await publish('shop', 'rev-1', 0);
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop', 'private', '[]', 1)").run();
    const page = await get(`${ABOUT}/`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Shop v1');
    expect((await get(`${ABOUT}/robots.txt`)).status).toBe(200);
    // The runnable app is still gated: signed out, it is never served.
    const app = await get('https://shop.proappstore.online/');
    expect(app.body).not.toBe('<html>the runnable app</html>');
    expect([302, 401, 403]).toContain(app.status);
  });

  it('real 404s: unknown paths, the manifest, source maps, traversal, and another app’s prefix', async () => {
    await publish('shop', 'rev-1');
    for (const path of ['/pricing', '/deep/link', '/artifact-manifest.json', '/assets/app.js.map', '/assets/../../rival/revisions/rev-1/index.html',
      '/assets/%2e%2e/%2e%2e/rival/revisions/rev-1/index.html', '/_astro/..%2f..%2frival', '/.env']) {
      const r = await get(`${ABOUT}${path}`);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toMatch(/Shop|Rival|runnable/);
    }
    // rival has bytes in R2 but no active revision: nothing is served.
    expect((await get('https://about-rival.proappstore.online/')).status).toBe(404);
    expect((await get(`${ABOUT}/`, { method: 'POST' })).status).toBe(405);
  });
});
