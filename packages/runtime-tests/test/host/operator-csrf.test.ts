import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

// #300 CSRF regressions on the host's cookie mediation (/.pas/api), the only
// path where a browser's ambient credential (the __Host-pas_session cookie)
// reaches the API. A cross-site or origin-less mutation is refused before the
// API binding; a same-origin one is forwarded with the host's own X-PAS-App,
// which the backend's operator routes refuse (test/backend/operator-matrix).

const ACTION = '/.pas/api/v1/apps/stash/operator/actions/suspend_member';

async function seedRoute(slug: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at) VALUES (?, 'proappstore.online', ?, 'pas', 'r2', ?, ?)")
    .bind(slug, `apps/${slug}`, Date.now(), Date.now()).run();
}

const post = (app: string, headers: Record<string, string>) => SELF.fetch(`https://${app}.proappstore.online${ACTION}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: '__Host-pas_session=owner-session', ...headers },
  body: JSON.stringify({ row: { user_id: 'u1' } }),
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM routes').run();
  await seedRoute('stash');
  await seedRoute('bingo');
});

describe('host: CSRF on mediated operator calls (#300)', () => {
  it('refuses a cross-site, a sibling-app or an origin-less mutation before the API', async () => {
    for (const headers of <Record<string, string>[]>[
      { Origin: 'https://evil.example' },
      { Origin: 'https://bingo.proappstore.online' },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'none' },
      {},
    ]) {
      const res = await post('stash', headers);
      const text = await res.text();
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(text, JSON.stringify(headers)).not.toContain('api-echo');
    }
  });

  it('forwards a same-origin mutation as a Bearer call stamped with the host\'s own app, never the page\'s', async () => {
    // A page on bingo names stash in its own X-PAS-App and sends a forged Authorization: both are replaced.
    const res = await post('bingo', { Origin: 'https://bingo.proappstore.online', 'X-PAS-App': 'stash', Authorization: 'Bearer forged' });
    expect(res.status).toBe(200);
    const echo = (await res.json()) as { worker: string; path: string; headers: Record<string, string> };
    expect(echo).toMatchObject({ worker: 'api-echo', path: '/v1/apps/stash/operator/actions/suspend_member' });
    expect(echo.headers['x-pas-app']).toBe('bingo');
    expect(echo.headers.authorization).toBe('Bearer owner-session');
    expect(echo.headers.cookie).toBeUndefined();
    expect(echo.headers.origin).toBeUndefined();
  });

  it('a read is forwarded only with the X-PAS-App the backend refuses, and carries no CORS grant', async () => {
    const res = await SELF.fetch('https://bingo.proappstore.online/.pas/api/v1/apps/stash/operator/resources/members', {
      headers: { Cookie: '__Host-pas_session=owner-session', Origin: 'https://evil.example' },
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const echo = (await res.json()) as { headers: Record<string, string> };
    expect(echo.headers['x-pas-app']).toBe('bingo');
  });

  it('without the session cookie nothing is forwarded', async () => {
    const res = await SELF.fetch(`https://stash.proappstore.online${ACTION}`, { method: 'POST', headers: { Origin: 'https://stash.proappstore.online', Authorization: 'Bearer owner-session' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('api-echo');
  });
});
