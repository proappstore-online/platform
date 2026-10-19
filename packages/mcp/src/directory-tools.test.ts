import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * find_apps (#424). A fake McpServer captures the tool; env.API.fetch and
 * env.HOST.fetch are mocked to assert the exact backend query, the bearer
 * token, failure handling, and the live route checks.
 */

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler; description: string }>();
const fakeServer = {
  tool: (name: string, description: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler, description });
  },
};

const apiFetch = vi.fn();
const hostFetch = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  HOST: { fetch: hostFetch } as unknown as Fetcher,
  OAUTH_KV: { put: vi.fn() } as unknown as KVNamespace,
} as Record<string, unknown>;

const { registerDirectoryTools, checkRoute, HEALTH_CHECK_MAX } = await import('./directory-tools.js');

let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerDirectoryTools(fakeServer as never, env as never, () => userCtx);

const find = (args: Record<string, unknown> = {}) => tools.get('find_apps')!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const item = (id: string, lifecycle: string | null = 'live') => ({ id, lifecycle, routeUrl: `https://${id}.proappstore.online`, routeHealth: null });
const directory = (items: unknown[], extra: Record<string, unknown> = {}) =>
  apiFetch.mockResolvedValueOnce(new Response(JSON.stringify({ query: null, lookup: null, total: items.length, items, truncated: false, ...extra }), { status: 200 }));

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
});

describe('find_apps (#424)', () => {
  it('is one read-only tool whose schema validates its filters', () => {
    expect([...tools.keys()]).toEqual(['find_apps']);
    const t = tools.get('find_apps')!;
    expect(t.annotations.readOnlyHint).toBe(true);
    expect(t.description).toMatch(/^Search the app directory\. Supports filtering by lifecycle status and access level\./);
    const schema = z.object(t.schema);
    expect(schema.safeParse({ status: 'live,archived', access: 'mine,transfer', limit: 200 }).success).toBe(true);
    expect(schema.safeParse({ status: 'down' }).success).toBe(false);
    expect(schema.safeParse({ access: 'mine,,team' }).success).toBe(false);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it('returns the directory as the backend sent it, querying with the connection token', async () => {
    directory([item('alpha')], { lookup: { id: 'alpha', status: 'yours' } });
    const r = await find({ q: 'https://alpha.proappstore.online', status: 'live', access: 'mine', limit: 5 });
    expect(r.isError).toBeUndefined();
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.test.com/v1/apps/directory');
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: 'https://alpha.proappstore.online', status: 'live', access: 'mine', limit: '5' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
    expect(body(r)).toMatchObject({ lookup: { id: 'alpha', status: 'yours' }, items: [{ id: 'alpha', routeHealth: null }] });
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('sends no query string when nothing is asked', async () => {
    directory([]);
    await find();
    expect(apiFetch.mock.calls[0]![0]).toBe('https://api.test.com/v1/apps/directory');
  });

  it('refuses without a session and calls nothing', async () => {
    userCtx = { userId: null, token: null };
    const r = await find({ q: 'x' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/Not authenticated/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['an unreachable backend', () => apiFetch.mockRejectedValueOnce(new Error('connection refused')), /App directory unavailable: connection refused/],
    ['a backend error', () => apiFetch.mockResolvedValueOnce(new Response('unknown status "down"', { status: 400 })), /API 400: unknown status "down"/],
    ['a non-JSON reply', () => apiFetch.mockResolvedValueOnce(new Response('<html>', { status: 200 })), /non-JSON/],
  ])('reports %s as isError', async (_label, arrange, message) => {
    arrange();
    const r = await find({ q: 'x' });
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(message);
  });

  describe('check_health', () => {
    it('adds routeHealth through the HOST binding: ok, private-is-ok, down; drafts are skipped', async () => {
      directory([item('up'), item('priv'), item('broken'), item('gone'), item('idea', 'draft')]);
      hostFetch.mockImplementation(async (url: string) => {
        if (url.includes('//up.')) return new Response(null, { status: 200 });
        if (url.includes('//priv.')) return new Response(null, { status: 401, headers: { 'X-PAS-Visibility': 'private' } });
        if (url.includes('//broken.')) return new Response(null, { status: 502 });
        throw new Error('unreachable');
      });
      const r = await find({ check_health: true });
      const health = Object.fromEntries(body(r).items.map((i: any) => [i.id, i.routeHealth]));
      expect(health).toEqual({ up: 'ok', priv: 'ok', broken: 'down', gone: 'down', idea: null });
      expect(body(r).healthChecked).toBe(4);
      expect(hostFetch).toHaveBeenCalledWith('https://up.proappstore.online', { method: 'HEAD' });
      expect(hostFetch).toHaveBeenCalledTimes(4);
    });

    it(`checks at most ${HEALTH_CHECK_MAX} routes, the first results first`, async () => {
      directory(Array.from({ length: HEALTH_CHECK_MAX + 5 }, (_, n) => item(`app${n}`)));
      hostFetch.mockResolvedValue(new Response(null, { status: 200 }));
      const r = await find({ check_health: true });
      expect(hostFetch).toHaveBeenCalledTimes(HEALTH_CHECK_MAX);
      const items = body(r).items;
      expect(items[0].routeHealth).toBe('ok');
      expect(items[HEALTH_CHECK_MAX].routeHealth).toBeNull();
    });

    it('a route that never answers is a timeout', async () => {
      vi.useFakeTimers();
      try {
        const host = { fetch: vi.fn(() => new Promise<Response>(() => {})) } as unknown as Fetcher;
        const pending = checkRoute(host, 'https://slow.proappstore.online', 1000);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(pending).resolves.toBe('timeout');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
