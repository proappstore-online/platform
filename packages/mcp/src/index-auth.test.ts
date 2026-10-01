import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env.js';

const verifyTokenMock = vi.hoisted(() => vi.fn());
const servedMock = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; url: string; props: Record<string, unknown> | undefined }>,
}));

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve(path: string) {
      return {
        fetch: (request: Request, _env: Env, ctx: ExecutionContext & { props?: Record<string, unknown> }) => {
          servedMock.calls.push({ path, url: request.url, props: ctx.props });
          return new Response('mock mcp transport');
        },
      };
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {},
}));

vi.mock('./api-helpers.js', () => ({
  extractToken: (props: { authToken?: string }) => props.authToken ?? null,
  verifyToken: verifyTokenMock,
}));

const { default: worker, clearVisibilityCache, PUBLIC_APP_TTL_MS } = await import('./index.js');

// GET /v1/apps/:id/visibility/me (#259): public unless a test says otherwise.
const visibilityMe = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ mode: 'public', allowed: true }));

const env = {
  API_BASE: 'https://api.proappstore.online',
  API: { fetch: (url: string, init?: RequestInit) => visibilityMe(url, init) } as unknown as Fetcher,
  OAUTH_KV: makeKv(),
  SESSION_SIGNING_KEY: 'test-key',
} as Env;

const ctx = {} as ExecutionContext;

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data = new Map(Object.entries(seed));
  return {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
  } as unknown as KVNamespace;
}

describe('MCP transport auth', () => {
  afterEach(() => {
    verifyTokenMock.mockReset();
    visibilityMe.mockClear();
    clearVisibilityCache();
    servedMock.calls.length = 0;
    delete (ctx as ExecutionContext & { props?: Record<string, unknown> }).props;
  });

  it('turns bearer verifier failures into a clean invalid-token challenge', async () => {
    verifyTokenMock.mockRejectedValueOnce(new Error('verifier exploded'));

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer expired-or-bad-token' },
    }), env, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });

  it('challenges unauthenticated MCP transport requests', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp'), env, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('challenges unauthenticated app-scoped MCP transport requests with app metadata', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/crm'), env, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp/apps/crm"',
    );
  });

  it('keeps the public landing page unauthenticated', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/'), env, ctx);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('ProAppStore MCP Server');
  });

  it('routes app-scoped MCP URLs through the shared transport with appScope props', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'user-1', login: 'serge' });

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/crm', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    }), env, ctx);

    expect(res.status).toBe(200);
    expect(servedMock.calls).toEqual([{
      path: '/mcp',
      url: 'https://mcp.proappstore.online/mcp',
      props: { authToken: 'good-token', appScope: 'crm' },
    }]);
  });

  it('routes app-scoped MCP URLs with matching app-bound OAuth tokens', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'user-1', login: 'serge' });
    const scopedEnv = {
      ...env,
      OAUTH_KV: makeKv({
        'token:oauth-token': JSON.stringify({ session: 'pas-session', appId: 'crm' }),
      }),
    } as Env;

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/crm', {
      method: 'POST',
      headers: { Authorization: 'Bearer oauth-token' },
    }), scopedEnv, ctx);

    expect(res.status).toBe(200);
    expect(verifyTokenMock).toHaveBeenCalledWith('test-key', 'pas-session');
    expect(servedMock.calls).toEqual([{
      path: '/mcp',
      url: 'https://mcp.proappstore.online/mcp',
      props: { authToken: 'pas-session', appScope: 'crm' },
    }]);
  });

  it('rejects app-bound OAuth tokens on the shared platform endpoint', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'user-1', login: 'serge' });
    const scopedEnv = {
      ...env,
      OAUTH_KV: makeKv({
        'token:oauth-token': JSON.stringify({ session: 'pas-session', appId: 'crm' }),
      }),
    } as Env;

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer oauth-token' },
    }), scopedEnv, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
    );
    expect(servedMock.calls).toEqual([]);
  });

  it('rejects app-bound OAuth tokens on a different app endpoint', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'user-1', login: 'serge' });
    const scopedEnv = {
      ...env,
      OAUTH_KV: makeKv({
        'token:oauth-token': JSON.stringify({ session: 'pas-session', appId: 'crm' }),
      }),
    } as Env;

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/jobs', {
      method: 'POST',
      headers: { Authorization: 'Bearer oauth-token' },
    }), scopedEnv, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp/apps/jobs", error="invalid_token"',
    );
    expect(servedMock.calls).toEqual([]);
  });

  it('rejects legacy unbound OAuth tokens so old app grants cannot be widened', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'user-1', login: 'serge' });
    const scopedEnv = {
      ...env,
      OAUTH_KV: makeKv({
        'token:legacy-token': 'pas-session',
      }),
    } as Env;

    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/crm', {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy-token' },
    }), scopedEnv, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp/apps/crm", error="invalid_token"',
    );
    expect(servedMock.calls).toEqual([]);
  });

  it('rejects invalid app-scoped MCP URLs before transport dispatch', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp/apps/CRM!', {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    }), env, ctx);

    expect(res.status).toBe(400);
    expect(servedMock.calls).toEqual([]);
  });
});

// #112: a protocol client pointed at the origin instead of /mcp must get the
// JSON-RPC 405 ("wrong number"), never a 200 with a non-stream body — which a
// client reads as "stream opened, then dropped" and redials ~1/sec forever.
// Every one of those redials is a 200, spends no tokens and never reaches the
// audit log or the tool-call rate limiter, so nothing else would catch it.
describe('landing page refuses MCP protocol clients (#112)', () => {
  const ORIGIN = 'https://mcp.proappstore.online/';
  const expect405 = async (res: Response) => {
    expect(res.status).toBe(405);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    const body = await res.json() as { jsonrpc: string; id: null; error: { code: number; message: string } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain('https://mcp.proappstore.online/mcp');
    expect(servedMock.calls).toEqual([]);
  };

  it('405s the legacy SSE transport: GET / with Accept: text/event-stream', async () => {
    const res = await worker.fetch(new Request(ORIGIN, { headers: { Accept: 'text/event-stream' } }), env, ctx);
    await expect405(res);
  });

  it('405s a JSON-RPC POST to / (streamable transport probing the origin)', async () => {
    const res = await worker.fetch(new Request(ORIGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    }), env, ctx);
    await expect405(res);
  });

  it('405s a browser-ish Accept list that still includes the event stream', async () => {
    const res = await worker.fetch(new Request(ORIGIN, { headers: { Accept: 'text/html, text/event-stream;q=0.9' } }), env, ctx);
    await expect405(res);
  });

  it('still serves a plain GET as the human landing page', async () => {
    const res = await worker.fetch(new Request(ORIGIN, { headers: { Accept: 'text/html' } }), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toContain('ProAppStore MCP Server');
  });

  it('leaves HEAD and OPTIONS alone so CORS preflight is unaffected', async () => {
    for (const method of ['HEAD', 'OPTIONS']) {
      const res = await worker.fetch(new Request(ORIGIN, { method }), env, ctx);
      expect(res.status, method).toBe(200);
    }
  });

  it('does not touch /mcp itself — the transport keeps answering 401 + challenge', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp', { headers: { Accept: 'text/event-stream' } }), env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });
});

// #259: an app-scoped session on a private app is for its team and declared roles only.
describe('MCP app-scoped sessions on private apps (#259)', () => {
  afterEach(() => {
    verifyTokenMock.mockReset();
    visibilityMe.mockReset();
    visibilityMe.mockImplementation(async () => Response.json({ mode: 'public', allowed: true }));
    servedMock.calls.length = 0;
    clearVisibilityCache();
    delete (ctx as ExecutionContext & { props?: Record<string, unknown> }).props;
  });

  const open = (app = 'diary') => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'gh:2', login: 'someone' });
    return worker.fetch(new Request(`https://mcp.proappstore.online/mcp/apps/${app}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer good-token' },
    }), env, ctx);
  };

  it('remembers a public answer for at most 10 s, so a public → private flip is honoured within that bound', async () => {
    expect(PUBLIC_APP_TTL_MS).toBeLessThanOrEqual(10_000);
    vi.useFakeTimers();
    try {
      expect((await open('flip')).status).not.toBe(403);
      visibilityMe.mockImplementation(async () => Response.json({ mode: 'private', allowed: false }));
      vi.advanceTimersByTime(PUBLIC_APP_TTL_MS + 1);
      expect((await open('flip')).status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a caller the backend does not allow with 403, before any session exists', async () => {
    visibilityMe.mockImplementation(async () => Response.json({ mode: 'private', allowed: false }));
    const res = await open();
    expect(res.status).toBe(403);
    expect(servedMock.calls).toEqual([]);
    const [url, init] = visibilityMe.mock.calls[0]!;
    expect(url).toBe('https://api.proappstore.online/v1/apps/diary/visibility/me');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer good-token');
  });

  it('serves an allowed caller, and asks again on the next message (a private answer is never remembered)', async () => {
    visibilityMe.mockImplementation(async () => Response.json({ mode: 'private', allowed: true }));
    expect((await open()).status).toBe(200);
    expect((await open()).status).toBe(200);
    expect(visibilityMe).toHaveBeenCalledTimes(2);
  });

  it('fails closed with 503 when the lookup fails, never an allow', async () => {
    visibilityMe.mockImplementation(async () => new Response('boom', { status: 500 }));
    expect((await open()).status).toBe(503);
    visibilityMe.mockImplementation(async () => { throw new Error('binding down'); });
    expect((await open()).status).toBe(503);
    expect(servedMock.calls).toEqual([]);
  });

  it('a public app is asked once, then remembered — no backend call per message', async () => {
    expect((await open('crm')).status).toBe(200);
    expect((await open('crm')).status).toBe(200);
    expect(visibilityMe).toHaveBeenCalledTimes(1);
  });

  it('the shared /mcp endpoint never asks', async () => {
    verifyTokenMock.mockResolvedValueOnce({ id: 'gh:2', login: 'someone' });
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp', { method: 'POST', headers: { Authorization: 'Bearer good-token' } }), env, ctx);
    expect(res.status).toBe(200);
    expect(visibilityMe).not.toHaveBeenCalled();
  });
});
