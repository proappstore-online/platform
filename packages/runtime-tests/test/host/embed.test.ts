import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #453 on real D1 and R2: an app that opts in names the sites allowed to frame it, the host
// appends exactly those to that app's CSP frame-ancestors, and no other app is touched.

const DEFAULT_FA = "frame-ancestors 'self' https://proappstore.online https://console.proappstore.online https://dashboard.proappstore.online https://admin.proappstore.online https://agents.proappstore.online";

async function seedApp(slug: string, origins?: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
  if (origins !== undefined) await env.DB.prepare('INSERT OR REPLACE INTO app_embed (app_id, origins, created_at) VALUES (?, ?, ?)').bind(slug, origins, Date.now()).run();
  await env.APPS.put(`apps/${slug}/index.html`, '<html><head><title>app</title></head><body>app</body></html>');
  await env.APPS.put(`apps/${slug}/assets/app.js`, 'console.log("app")');
}

/** Fetch and read the body: the host tees served bodies into the edge cache. */
async function get(url: string) {
  const res = await SELF.fetch(url);
  await res.text();
  return res;
}
const frameAncestors = (res: Response) => (res.headers.get('Content-Security-Policy') ?? '').split('; ').find((d) => d.startsWith('frame-ancestors')) ?? '';

beforeEach(async () => {
  for (const t of ['routes', 'app_embed']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: opt-in embedding (#453)', () => {
  it('lets only the listed origins frame an app that opted in', async () => {
    await seedApp('embed-widget', '["https://example.com","https://*.partner.com"]');
    const res = await get('https://embed-widget.proappstore.online/');
    expect(res.status).toBe(200);
    expect(frameAncestors(res)).toBe(`${DEFAULT_FA} https://example.com https://*.partner.com`);
    expect(frameAncestors(res)).not.toMatch(/ \*( |$)/); // never a bare wildcard
  });

  it('leaves an app that did not opt in exactly as it was, even beside one that did', async () => {
    await seedApp('embed-open', '["https://example.com"]');
    await seedApp('embed-closed');
    const closed = await get('https://embed-closed.proappstore.online/');
    expect(closed.status).toBe(200);
    expect(frameAncestors(closed)).toBe(DEFAULT_FA);
    expect(closed.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect((await get('https://embed-open.proappstore.online/')).headers.get('Content-Security-Policy')).toContain('https://example.com');
    // And the other way round: the open app's list did not leak into the closed one.
    expect(closed.headers.get('Content-Security-Policy')).not.toContain('example.com');
  });

  it('only changes the page; an asset keeps the default', async () => {
    await seedApp('embed-asset', '["https://example.com"]');
    expect(frameAncestors(await get('https://embed-asset.proappstore.online/assets/app.js'))).toBe(DEFAULT_FA);
  });

  it('drops a corrupt or hostile stored list instead of serving it', async () => {
    await seedApp('embed-bad-json', 'not json');
    await seedApp('embed-hostile', JSON.stringify(['https://ok.example.com', 'https://x.com; script-src *', 'http://plain.example.com', '*']));
    expect(frameAncestors(await get('https://embed-bad-json.proappstore.online/'))).toBe(DEFAULT_FA);
    const hostile = await get('https://embed-hostile.proappstore.online/');
    expect(frameAncestors(hostile)).toBe(`${DEFAULT_FA} https://ok.example.com`);
    expect(hostile.headers.get('Content-Security-Policy')).not.toContain('script-src *');
  });

  it('closes the app again when the list is removed', async () => {
    await seedApp('embed-removed', '["https://example.com"]');
    expect(frameAncestors(await get('https://embed-removed.proappstore.online/'))).toContain('https://example.com');
    await env.DB.prepare('DELETE FROM app_embed WHERE app_id = ?').bind('embed-removed').run();
    // The edge cache may serve the previous page for up to s-maxage (60 s); a different path is uncached.
    await env.APPS.put('apps/embed-removed/other.html', '<html>other</html>');
    expect(frameAncestors(await get('https://embed-removed.proappstore.online/other.html'))).toBe(DEFAULT_FA);
  });
});
