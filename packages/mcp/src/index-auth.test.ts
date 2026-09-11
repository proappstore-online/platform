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

const { default: worker } = await import('./index.js');

const env = {
  API_BASE: 'https://api.proappstore.online',
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
