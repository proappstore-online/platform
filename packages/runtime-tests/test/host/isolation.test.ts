import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #452 on real D1 and R2: an app that opts in gets the headers that make it cross-origin
// isolated — COOP + COEP on its pages, the COEP on its scripts — and no other app, and no
// other kind of file, is touched. (A browser's `crossOriginIsolated` is the live check after deploy.)

const ISOLATION_HEADERS = ['Cross-Origin-Opener-Policy', 'Cross-Origin-Embedder-Policy'] as const;

async function seedApp(slug: string, mode?: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
  if (mode !== undefined) await env.DB.prepare('INSERT OR REPLACE INTO app_isolation (app_id, mode, created_at) VALUES (?, ?, ?)').bind(slug, mode, Date.now()).run();
  await env.APPS.put(`apps/${slug}/index.html`, '<html><head><title>app</title></head><body>app</body></html>');
  await env.APPS.put(`apps/${slug}/assets/app.js`, 'console.log("app")');
  await env.APPS.put(`apps/${slug}/assets/pool.worker.js`, 'self.onmessage=()=>{}');
  await env.APPS.put(`apps/${slug}/assets/style.css`, 'body{color:red}');
  await env.APPS.put(`apps/${slug}/assets/logo.png`, 'png');
}

/** Fetch and read the body: the host tees served bodies into the edge cache. */
async function get(url: string) {
  const res = await SELF.fetch(url);
  await res.text();
  return res;
}
const headersOf = (res: Response) => Object.fromEntries(ISOLATION_HEADERS.map((h) => [h, res.headers.get(h)]));

beforeEach(async () => {
  for (const t of ['routes', 'app_isolation']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: opt-in cross-origin isolation (#452)', () => {
  it('cross-origin: pages get COOP same-origin and COEP credentialless, scripts get the COEP', async () => {
    await seedApp('iso-on', 'cross-origin');
    expect(headersOf(await get('https://iso-on.proappstore.online/'))).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    for (const path of ['/assets/app.js', '/assets/pool.worker.js']) {
      expect(headersOf(await get(`https://iso-on.proappstore.online${path}`)), path).toEqual({ 'Cross-Origin-Opener-Policy': null, 'Cross-Origin-Embedder-Policy': 'credentialless' });
    }
  });

  it('cross-origin-strict uses require-corp', async () => {
    await seedApp('iso-strict', 'cross-origin-strict');
    expect(headersOf(await get('https://iso-strict.proappstore.online/'))).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  });

  it('leaves styles and images alone', async () => {
    await seedApp('iso-assets', 'cross-origin');
    for (const path of ['/assets/style.css', '/assets/logo.png']) {
      expect(headersOf(await get(`https://iso-assets.proappstore.online${path}`)), path).toEqual({ 'Cross-Origin-Opener-Policy': null, 'Cross-Origin-Embedder-Policy': null });
    }
  });

  it('an app that did not opt in is exactly as it was, even beside one that did', async () => {
    await seedApp('iso-open', 'cross-origin');
    await seedApp('iso-closed');
    for (const path of ['/', '/assets/app.js']) {
      const res = await get(`https://iso-closed.proappstore.online${path}`);
      expect(res.status).toBe(200);
      expect(headersOf(res), path).toEqual({ 'Cross-Origin-Opener-Policy': null, 'Cross-Origin-Embedder-Policy': null });
    }
    expect(headersOf(await get('https://iso-open.proappstore.online/'))['Cross-Origin-Opener-Policy']).toBe('same-origin');
  });

  it('opting in changes nothing else about the page', async () => {
    await seedApp('iso-same-a', 'cross-origin');
    await seedApp('iso-same-b');
    const a = await get('https://iso-same-a.proappstore.online/');
    const b = await get('https://iso-same-b.proappstore.online/');
    for (const h of ['Content-Security-Policy', 'X-Frame-Options', 'Permissions-Policy', 'Referrer-Policy', 'Content-Type', 'Cache-Control']) {
      expect(a.headers.get(h), h).toBe(b.headers.get(h));
    }
  });

  it('ignores a stored mode it does not know', async () => {
    await seedApp('iso-junk');
    await env.DB.exec("PRAGMA foreign_keys = OFF");
    await env.DB.prepare('DROP TABLE app_isolation').run();
    await env.DB.prepare('CREATE TABLE app_isolation (app_id TEXT PRIMARY KEY, mode TEXT NOT NULL, created_at INTEGER NOT NULL)').run();
    await env.DB.prepare("INSERT INTO app_isolation (app_id, mode, created_at) VALUES ('iso-junk', 'unsafe-none', 1)").run();
    try {
      expect(headersOf(await get('https://iso-junk.proappstore.online/'))).toEqual({ 'Cross-Origin-Opener-Policy': null, 'Cross-Origin-Embedder-Policy': null });
    } finally {
      await env.DB.prepare('DROP TABLE app_isolation').run();
      await env.DB.prepare("CREATE TABLE app_isolation (app_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK (mode IN ('cross-origin', 'cross-origin-strict')), created_at INTEGER NOT NULL)").run();
    }
  });

  it('stops isolating when the declaration is removed', async () => {
    await seedApp('iso-removed', 'cross-origin');
    expect((await get('https://iso-removed.proappstore.online/')).headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    await env.DB.prepare('DELETE FROM app_isolation WHERE app_id = ?').bind('iso-removed').run();
    // The edge cache may serve the previous page for up to s-maxage (60 s); a different path is uncached.
    await env.APPS.put('apps/iso-removed/other.html', '<html>other</html>');
    expect(headersOf(await get('https://iso-removed.proappstore.online/other.html'))).toEqual({ 'Cross-Origin-Opener-Policy': null, 'Cross-Origin-Embedder-Policy': null });
  });
});
