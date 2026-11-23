import { SELF, env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

// #628 part A on workerd: the Android companion's "Open {app}" lands on
// `?install=1`, and only then does the page get the same-origin install script.
// Without the parameter the page is unchanged. A private app serves the script
// only to people it admits (stubs/echo-stub.js: owner-token is admitted for vis-*).

const TAG = '<script src="/.pas/install.js" defer></script>';
const PAGE = '<!doctype html><html><head><title>Run</title><link rel="manifest" href="/manifest.webmanifest"></head><body>run</body></html>';

async function seedRoute(slug: string, visibility?: 'private'): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
  if (visibility) {
    await env.DB.prepare("INSERT OR REPLACE INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, ?, '[\"viewer\"]', ?)")
      .bind(slug, visibility, Date.now()).run();
  }
  await env.APPS.put(`apps/${slug}/index.html`, PAGE, { httpMetadata: { contentType: 'text/html' } });
}

/** Fetch and always read the body: the host tees served bodies into the edge cache. */
async function get(url: string, init: RequestInit = {}) {
  const res = await SELF.fetch(url, { redirect: 'manual', ...init });
  return { res, text: await res.text() };
}

afterEach(async () => {
  for (const t of ['routes', 'app_visibility']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: install handoff (#628)', () => {
  it('serves /.pas/install.js as text/javascript; HEAD has no body', async () => {
    await seedRoute('run');
    const script = await get('https://run.proappstore.online/.pas/install.js');
    expect(script.res.status).toBe(200);
    expect(script.res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(script.text).toContain('beforeinstallprompt');
    const head = await get('https://run.proappstore.online/.pas/install.js', { method: 'HEAD' });
    expect(head.res.status).toBe(200);
    expect(head.text).toBe('');
  });

  it('?install=1 puts the script tag immediately before </head>; without it the page is byte-identical to before', async () => {
    await seedRoute('run');
    const plain = await get('https://run.proappstore.online/');
    expect(plain.text).not.toContain('/.pas/install.js');

    const hinted = await get('https://run.proappstore.online/?install=1');
    expect(hinted.res.status).toBe(200);
    expect(hinted.text).toContain(`${TAG}</head>`);
    expect(hinted.text.split('/.pas/install.js')).toHaveLength(2);
    // The only difference is the tag: every other rewrite is the same.
    expect(hinted.text.replace(TAG, '')).toBe(plain.text);

    for (const q of ['?install=0', '?install=true', '?install']) {
      expect((await get(`https://run.proappstore.online/${q}`)).text, q).not.toContain('/.pas/install.js');
    }
  });

  it('a page without </head> still gets the tag, once, at the end', async () => {
    await seedRoute('run');
    await env.APPS.put('apps/run/index.html', '<!doctype html><title>Run</title><p>run', { httpMetadata: { contentType: 'text/html' } });
    const hinted = await get('https://run.proappstore.online/?install=1');
    expect(hinted.text.endsWith(TAG)).toBe(true);
    expect(hinted.text.split('/.pas/install.js')).toHaveLength(2);
  });

  it('a private app refuses the script and the hinted page to a signed-out caller, and serves both to an admitted one', async () => {
    await seedRoute('vis-install', 'private');
    const anonymous = await get('https://vis-install.proappstore.online/.pas/install.js');
    expect([401, 403, 302, 303]).toContain(anonymous.res.status);
    expect(anonymous.text).not.toContain('beforeinstallprompt');

    const session = { Cookie: '__Host-pas_session=owner-token' };
    const admitted = await get('https://vis-install.proappstore.online/.pas/install.js', { headers: session });
    expect(admitted.res.status).toBe(200);
    expect(admitted.text).toContain('beforeinstallprompt');
    const page = await get('https://vis-install.proappstore.online/?install=1', { headers: session });
    expect(page.text).toContain(`${TAG}</head>`);
  });
});
