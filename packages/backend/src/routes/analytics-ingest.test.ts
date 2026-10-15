import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv } from '../test-helpers.js';

// #402: events the host forwards from an app origin are that route's app's,
// whatever the body claims. `app` here is the inner Hono app, which does not strip
// host headers; that the Internet cannot send them is covered on workerd
// (runtime-tests analytics-same-origin.test.ts).

function capture() {
  const points: { indexes: string[]; blobs: string[] }[] = [];
  return { points, ANALYTICS: { writeDataPoint: (p: never) => points.push(p) } };
}
const post = (body: unknown, headers: Record<string, string>, env: ReturnType<typeof makeEnv>) =>
  app.request('/v1/analytics/event', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '198.51.100.7', ...headers }, body: JSON.stringify(body) }, env);

describe('POST /v1/analytics/event — host-bound app (#402)', () => {
  it("a host-forwarded event, single or batched, is the route's app, not the body's", async () => {
    const { points, ANALYTICS } = capture();
    const env = makeEnv({ ANALYTICS });
    const res = await post({ events: [{ app: 'victim-app', kind: 'pageview', path: '/' }, { kind: 'signup', path: '/join' }] }, { 'X-PAS-App': 'chess-academy', 'X-PAS-Country': 'GB' }, env);
    expect(res.status).toBe(204);
    expect(res.headers.get('x-events-accepted')).toBe('2');
    expect(points.map((p) => [p.indexes[0], p.blobs[1], p.blobs[4]])).toEqual([['chess-academy', 'pageview', 'GB'], ['chess-academy', 'signup', 'GB']]);
  });

  it('a direct event keeps naming its app in the body, and gets no country from a header', async () => {
    const { points, ANALYTICS } = capture();
    const res = await post({ app: 'my-site', kind: 'pageview', path: '/' }, { 'X-PAS-Country': 'GB' }, makeEnv({ ANALYTICS }));
    expect(res.status).toBe(204);
    expect(points.map((p) => [p.indexes[0], p.blobs[4]])).toEqual([['my-site', '']]);
  });
});
