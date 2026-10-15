import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork, viaHostApi } from './helpers';

// #402 on workerd: only the host (HostApi entrypoint) may name an analytics
// event's app or get a same-origin loader; a direct caller's X-PAS-App and
// X-PAS-Country are stripped before any route runs (#315).

beforeEach(() => mockNetwork());
const event = (headers: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'text/plain', 'user-agent': 'Mozilla/5.0', 'X-PAS-App': 'chess-academy', 'X-PAS-Country': 'GB', ...headers },
  // No valid app in the body: only a trusted X-PAS-App can make this count.
  body: JSON.stringify({ app: 'Not An App!', kind: 'pageview', path: '/' }),
});

describe('analytics: host-bound app (#402)', () => {
  it('an Internet caller cannot name the app by header', async () => {
    const res = await SELF.fetch(`${BASE}/v1/analytics/event`, event({}));
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('0');
  });

  it("over HostApi the route's app is used", async () => {
    const res = await viaHostApi(`${BASE}/v1/analytics/event`, event({}));
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('1');
  });

  it('the same-origin loader only over HostApi; the public loader still posts to the API', async () => {
    const hosted = await (await viaHostApi(`${BASE}/v1/analytics.js`, { headers: { 'X-PAS-App': 'chess-academy' } })).text();
    expect(hosted).toContain('"/.pas/analytics/event"');
    expect(hosted).toContain('"chess-academy"');
    const pub = await (await SELF.fetch(`${BASE}/v1/analytics.js?app=my-site`, { headers: { 'X-PAS-App': 'chess-academy' } })).text();
    expect(pub).toContain('"https://api.proappstore.online/v1/analytics/event"');
    expect(pub).toContain('"my-site"');
  });
});
