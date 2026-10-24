import { describe, expect, it, vi } from 'vitest';
import { egressFetch, egressHostVerdict, egressVerdict, MAX_EGRESS_REDIRECTS, recordEgress } from './app-worker-egress.js';

// #267 / ADR-009 §6 B.5: what the AppWorkerEgress gateway lets an app worker reach.

const BLOCKED: [string, string][] = [
  ['https://proappstore.online/', 'platform origin'],
  ['https://api.proappstore.online/v1/apps', 'platform origin'],
  ['https://API.ProAppStore.Online./x', 'platform origin'],
  ['https://duperdash.proappstore.online/', 'platform origin'],
  ['https://pas-data-kanban.serge-the-dev.workers.dev/health', "another app's worker"],
  ['https://pas-app-duperdash.serge-the-dev.workers.dev/', "another app's worker"],
  ['http://10.0.0.1/', 'private'], ['http://10.255.255.255/', 'private'],
  ['http://172.16.0.1/', 'private'], ['http://172.31.255.1/', 'private'],
  ['http://192.168.1.1/', 'private'],
  ['http://127.0.0.1:8787/', 'private'], ['http://127.9.9.9/', 'private'],
  ['http://169.254.169.254/latest/meta-data', 'private'],
  ['http://0.0.0.0/', 'private'],
  ['http://[::1]/', 'IPv6'], ['http://[fc00::1]/', 'IPv6'], ['http://[fd12:3456::1]/', 'IPv6'], ['http://[fe80::1]/', 'IPv6'],
  ['http://[::ffff:127.0.0.1]/', 'IPv6'],
  ['http://2130706433/', 'private'], // normalised by URL to 127.0.0.1
  ['http://localhost/', 'internal'], ['http://printer.local/', 'internal'], ['http://db.internal/', 'internal'],
  ['ftp://example.com/', 'scheme'], ['not a url', 'invalid'],
];

const ALLOWED = [
  'https://api.github.com/graphql',
  'https://example.com/',
  'https://other-workers.serge-the-dev.workers.dev/', // a workers.dev script that is not a PAS app
  'https://notproappstore.online/', // a different registrable domain
  'https://proappstore.online.evil.example/', // suffix lookalike
  'https://172.15.0.1/', 'https://172.32.0.1/', // just outside 172.16/12
  'http://11.0.0.1/',
];

describe('egress policy', () => {
  it.each(BLOCKED)('blocks %s', (url, why) => {
    const v = egressVerdict(url);
    expect(v.allowed, url).toBe(false);
    expect(v.allowed ? '' : v.reason.toLowerCase()).toContain(why.toLowerCase().split(' ')[0]!);
  });

  it.each(ALLOWED)('allows %s', (url) => {
    expect(egressVerdict(url), url).toEqual({ allowed: true });
  });

  it('judges the host alone', () => {
    expect(egressHostVerdict('')).toMatchObject({ allowed: false });
    expect(egressHostVerdict('api.github.com')).toEqual({ allowed: true });
  });
});

const gateway = () => {
  const points: unknown[] = [];
  const env = { APP_WORKER_EGRESS: { writeDataPoint: (p: unknown) => points.push(p) } };
  return { env, points };
};

describe('egressFetch', () => {
  it('forwards an allowed request and records it per app: method and host, never the path', async () => {
    const { env, points } = gateway();
    const upstream = vi.fn(async () => new Response('ok'));
    const res = await egressFetch(env, 'duperdash', new Request('https://api.github.com/graphql?token=secret', { method: 'POST', body: '{}' }), upstream as never);
    expect(await res.text()).toBe('ok');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(points).toEqual([{ indexes: ['duperdash'], blobs: ['POST', 'api.github.com', 'allow', ''], doubles: [1] }]);
    expect(JSON.stringify(points)).not.toContain('secret');
  });

  it("answers 403 for another app's worker and the platform's origins, without fetching, and records the block", async () => {
    const { env, points } = gateway();
    const upstream = vi.fn(async () => new Response('should not happen'));
    for (const url of ['https://pas-data-kanban.serge-the-dev.workers.dev/health', 'https://pas-app-b.x.workers.dev/', 'https://api.proappstore.online/v1/apps/b/secrets']) {
      const res = await egressFetch(env, 'a', new Request(url), upstream as never);
      expect(res.status, url).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'egress_blocked', host: new URL(url).host });
    }
    expect(upstream).not.toHaveBeenCalled();
    expect(points).toHaveLength(3);
    expect(points[0]).toMatchObject({ indexes: ['a'], blobs: ['GET', 'pas-data-kanban.serge-the-dev.workers.dev', 'block', "another app's worker"] });
  });

  it('refuses the metadata address and private ranges', async () => {
    const { env } = gateway();
    const upstream = vi.fn();
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.1.2.3/', 'http://[::1]:8787/']) {
      expect((await egressFetch(env, 'a', new Request(url), upstream as never)).status, url).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('re-checks a redirect: an allowed host cannot bounce a worker onto a blocked one', async () => {
    const { env, points } = gateway();
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://pas-data-b.x.workers.dev/secret' } }));
    const res = await egressFetch(env, 'a', new Request('https://example.com/r'), upstream as never);
    expect(res.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(points.map((p) => (p as { blobs: string[] }).blobs[2])).toEqual(['allow', 'block']);
  });

  it('follows an allowed redirect, dropping credentials across origins', async () => {
    const { env } = gateway();
    const seen: { url: string; auth: string | null }[] = [];
    const upstream = vi.fn(async (input: Request | string, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const headers = new Headers(typeof input === 'string' ? init?.headers : input.headers);
      seen.push({ url, auth: headers.get('authorization') });
      return url.startsWith('https://example.com/') ? new Response(null, { status: 301, headers: { location: 'https://cdn.example.net/x' } }) : new Response('final');
    });
    const res = await egressFetch(env, 'a', new Request('https://example.com/a', { headers: { authorization: 'Bearer t' } }), upstream as never);
    expect(await res.text()).toBe('final');
    expect(seen).toEqual([{ url: 'https://example.com/a', auth: 'Bearer t' }, { url: 'https://cdn.example.net/x', auth: null }]);
  });

  it('hands a redirect back unfollowed to a worker that asked for manual, and for non-GET', async () => {
    const { env } = gateway();
    const redirect = () => new Response(null, { status: 302, headers: { location: 'https://example.com/next' } });
    const upstream = vi.fn(async () => redirect());
    expect((await egressFetch(env, 'a', new Request('https://example.com/a', { redirect: 'manual' }), upstream as never)).status).toBe(302);
    expect((await egressFetch(env, 'a', new Request('https://example.com/a', { method: 'POST', body: 'x' }), upstream as never)).status).toBe(302);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it(`stops after ${MAX_EGRESS_REDIRECTS} redirects`, async () => {
    const { env } = gateway();
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/loop' } }));
    const res = await egressFetch(env, 'a', new Request('https://example.com/loop'), upstream as never);
    expect(res.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(MAX_EGRESS_REDIRECTS + 1);
  });

  it('still forwards when the Analytics Engine write throws or the binding is absent', async () => {
    const upstream = async () => new Response('ok');
    const throwing = { APP_WORKER_EGRESS: { writeDataPoint: () => { throw new Error('ae down'); } } };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await (await egressFetch(throwing, 'a', new Request('https://example.com/'), upstream as never)).text()).toBe('ok');
    expect(await (await egressFetch({}, 'a', new Request('https://example.com/'), upstream as never)).text()).toBe('ok');
    recordEgress({}, 'a', 'GET', 'example.com', { allowed: true });
  });
});
