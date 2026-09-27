import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #229 (part of #228): an app's declared operator prefix is served only to a
// signed-in holder of its app role — on real D1, R2 and the edge cache. The API
// binding answers roles/me from the session token (stubs/echo-stub.js):
// operator-token → operator, member-token → member only, expired-token → 401,
// anything else → 500.

const session = (token: string) => ({ Cookie: `__Host-pas_session=${token}` });
const navigate = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };
const BUNDLE = 'console.log("operator bundle")';

async function seedGatedApp(slug: string, gate: { prefix: string; role: string } | null = { prefix: '/admin', role: 'operator' }): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
  if (gate) {
    await env.DB.prepare('INSERT INTO app_operator_gate (app_id, path_prefix, role_name, created_at) VALUES (?, ?, ?, ?)')
      .bind(slug, gate.prefix, gate.role, Date.now()).run();
  }
  await env.APPS.put(`apps/${slug}/index.html`, '<html>main app</html>');
  await env.APPS.put(`apps/${slug}/assets/app.js`, 'console.log("main")');
  await env.APPS.put(`apps/${slug}/admin/index.html`, '<html>operator console</html>');
  await env.APPS.put(`apps/${slug}/admin/assets/console.js`, BUNDLE);
}

/** Fetch and always read the body: the host tees served bodies into the edge cache. */
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(url, { headers, redirect: 'manual' });
  return { res, text: await res.text() };
}

beforeEach(async () => {
  for (const t of ['routes', 'app_operator_gate']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  const listed = await env.APPS.list();
  await Promise.all(listed.objects.map((o) => env.APPS.delete(o.key)));
});

describe('host: operator gate (#229)', () => {
  it('serves the operator prefix to a holder of the declared role, uncacheable', async () => {
    await seedGatedApp('gate-allow');
    const asset = await get('https://gate-allow.proappstore.online/admin/assets/console.js', session('operator-token'));
    expect(asset.res.status).toBe(200);
    expect(asset.text).toBe(BUNDLE);
    expect(asset.res.headers.get('Cache-Control')).toBe('private, no-store');

    // Deep links under the prefix fall back to the console's own index.
    const deep = await get('https://gate-allow.proappstore.online/admin/users/42', { ...session('operator-token'), ...navigate });
    expect(deep.res.status).toBe(200);
    expect(deep.text).toBe('<html>operator console</html>');
  });

  it('refuses a signed-in user without the role with 403, never the bundle', async () => {
    await seedGatedApp('gate-member');
    for (const path of ['/admin', '/admin/', '/admin/users', '/admin/assets/console.js']) {
      const r = await get(`https://gate-member.proappstore.online${path}`, { ...session('member-token'), ...navigate });
      expect(r.res.status, path).toBe(403);
      expect(r.text, path).not.toContain('operator');
      expect(r.res.headers.get('Cache-Control'), path).toBe('no-store');
    }
  });

  it('redirects a navigation with no session to sign-in, and 403s anything else', async () => {
    await seedGatedApp('gate-anon');
    const nav = await get('https://gate-anon.proappstore.online/admin/users?tab=queue', navigate);
    expect(nav.res.status).toBe(302);
    const location = new URL(nav.res.headers.get('Location')!);
    expect(location.origin).toBe('https://gate-anon.proappstore.online');
    expect(location.pathname).toBe('/.pas/auth/start');
    expect(location.searchParams.get('return_to')).toBe('/admin/users?tab=queue');

    const asset = await get('https://gate-anon.proappstore.online/admin/assets/console.js');
    expect(asset.res.status).toBe(403);
    expect(asset.text).not.toContain('operator bundle');
  });

  it('treats a session the backend rejects as no session, and clears the cookie', async () => {
    await seedGatedApp('gate-expired');
    const r = await get('https://gate-expired.proappstore.online/admin/', { ...session('expired-token'), ...navigate });
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get('Set-Cookie')).toContain('__Host-pas_session=; Max-Age=0');
  });

  it('fails closed with 503 when the role lookup fails', async () => {
    await seedGatedApp('gate-broken');
    const r = await get('https://gate-broken.proappstore.online/admin/assets/console.js', session('broken-token'));
    expect(r.res.status).toBe(503);
    expect(r.text).not.toContain('operator bundle');
  });

  it('does not replay an operator response from the edge cache to a refused caller', async () => {
    await seedGatedApp('gate-cache');
    const url = 'https://gate-cache.proappstore.online/admin/assets/console.js';
    expect((await get(url, session('operator-token'))).res.status).toBe(200);
    expect((await get(url, session('member-token'))).res.status).toBe(403);
    expect((await get(url)).res.status).toBe(403);
  });

  it('gates the same object however the path addresses it (leading slashes)', async () => {
    await seedGatedApp('gate-slashes');
    const r = await get('https://gate-slashes.proappstore.online//admin/assets/console.js', session('member-token'));
    expect(r.res.status).toBe(403);
    expect(r.text).not.toContain('operator bundle');
  });

  it('leaves non-operator paths untouched', async () => {
    await seedGatedApp('gate-open');
    const root = await get('https://gate-open.proappstore.online/');
    expect(root.res.status).toBe(200);
    expect(root.text).toBe('<html>main app</html>');
    const asset = await get('https://gate-open.proappstore.online/assets/app.js');
    expect(asset.res.status).toBe(200);
    expect(asset.text).toBe('console.log("main")');
    // A sibling path that merely starts with the same letters is not under the prefix.
    const sibling = await get('https://gate-open.proappstore.online/administrator', navigate);
    expect(sibling.res.status).toBe(200);
    expect(sibling.text).toBe('<html>main app</html>');
  });

  it('changes nothing for an app that declares no gate', async () => {
    await seedGatedApp('gate-none', null);
    const r = await get('https://gate-none.proappstore.online/admin/assets/console.js');
    expect(r.res.status).toBe(200);
    expect(r.text).toBe(BUNDLE);
    const deep = await get('https://gate-none.proappstore.online/admin/users', navigate);
    expect(deep.text).toBe('<html>main app</html>');
  });
});
