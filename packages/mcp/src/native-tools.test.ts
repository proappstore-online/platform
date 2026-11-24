import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/** #660 / ADR-019: the user's own native companion data. Both credentials, fail closed, read-only, ids-only audit. */

type Result = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
const tools = new Map<string, { schema: z.ZodRawShape; annotations: Record<string, unknown>; handler: Handler }>();
const fakeServer = {
  tool: (name: string, _d: string, schema: z.ZodRawShape, annotations: Record<string, unknown>, handler: Handler) => {
    tools.set(name, { schema, annotations, handler });
  },
};

const apiFetch = vi.fn();
const kvPut = vi.fn();
const env = {
  API_BASE: 'https://api.test.com',
  API: { fetch: apiFetch } as unknown as Fetcher,
  OAUTH_KV: { put: kvPut } as unknown as KVNamespace,
  INTERNAL_TOKEN: 'internal' as string | undefined,
} as Record<string, unknown>;

const { registerNativeTools } = await import('./native-tools.js');
let userCtx: { userId: string | null; token: string | null } = { userId: 'gh:1', token: 'tok-1' };
registerNativeTools(fakeServer as never, env as never, () => userCtx);

const call = (name: string, args: Record<string, unknown> = {}) => tools.get(name)!.handler(args);
const body = (r: Result) => JSON.parse(r.content[0]!.text) as Record<string, any>;
const DEVICE = 'a'.repeat(64);
function sent(n = 0) {
  const [url, init] = apiFetch.mock.calls[n] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return { path: url.replace('https://api.test.com', ''), auth: headers.Authorization, internal: headers['X-Internal-Token'] };
}

beforeEach(() => {
  vi.clearAllMocks();
  userCtx = { userId: 'gh:1', token: 'tok-1' };
  env.INTERNAL_TOKEN = 'internal';
  apiFetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
});

describe('native MCP tools (#660)', () => {
  it('registers exactly the six tools, all read-only', () => {
    expect([...tools.keys()].sort()).toEqual(['native_devices', 'native_diagnostics', 'native_grants', 'native_heart_rate', 'native_locations', 'native_status']);
    for (const [name, t] of tools) expect(t.annotations.readOnlyHint, name).toBe(true);
  });

  it('every tool sends the session AND the internal token to its /v1/me/native route', async () => {
    const paths: Record<string, string> = { native_devices: '/v1/me/native/devices', native_grants: '/v1/me/native/grants', native_status: '/v1/me/native/status',
      native_locations: '/v1/me/native/locations?limit=200', native_heart_rate: '/v1/me/native/heart-rate?limit=500', native_diagnostics: '/v1/me/native/diagnostics' };
    let n = 0;
    for (const [name, path] of Object.entries(paths)) {
      const r = await call(name);
      expect(r.isError, name).toBeUndefined();
      expect(sent(n++)).toEqual({ path, auth: 'Bearer tok-1', internal: 'internal' });
    }
  });

  it('passes filters and the cursor as the backend names them', async () => {
    await call('native_locations', { app_id: 'run', device_id: DEVICE, after: 5, after_id: 'g:p', limit: 10 });
    expect(sent().path).toBe(`/v1/me/native/locations?appId=run&deviceId=${DEVICE}&after=5&afterId=g%3Ap&limit=10`);
  });

  it('refuses without a session, or without INTERNAL_TOKEN, and calls nothing', async () => {
    userCtx = { userId: null, token: null };
    for (const name of tools.keys()) {
      const r = await call(name);
      expect(r.isError, name).toBe(true);
      expect(body(r).error).toMatch(/Not authenticated/);
    }
    userCtx = { userId: 'gh:1', token: 'tok-1' };
    env.INTERNAL_TOKEN = undefined;
    for (const name of tools.keys()) expect(body(await call(name)).error).toBe('native tools are not configured (missing INTERNAL_TOKEN)');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('slug and device-id schemas reject path tricks; page sizes stay under the backend caps', () => {
    const locations = z.object(tools.get('native_locations')!.schema), heart = z.object(tools.get('native_heart_rate')!.schema);
    expect(locations.safeParse({ app_id: 'run', device_id: DEVICE }).success).toBe(true);
    expect(locations.safeParse({ app_id: '../admin' }).success).toBe(false);
    expect(locations.safeParse({ device_id: '../admin' }).success).toBe(false);
    expect(locations.safeParse({ limit: 501 }).success).toBe(false);
    expect(heart.safeParse({ limit: 1000 }).success).toBe(true);
    expect(heart.safeParse({ limit: 1001 }).success).toBe(false);
    expect(z.object(tools.get('native_grants')!.schema).safeParse({ app_id: '../admin' }).success).toBe(false);
  });

  it('surfaces a backend refusal as an error', async () => {
    apiFetch.mockResolvedValueOnce(new Response('{"error":"native account reads require a first-party caller"}', { status: 403 }));
    const r = await call('native_devices');
    expect(r.isError).toBe(true);
    expect(body(r).error).toMatch(/^API 403/);
  });
});
