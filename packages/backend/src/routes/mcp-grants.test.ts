import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';

// #457: the console's view of an app's MCP endpoint and the caller's own grants.
// The MCP worker is a mocked service binding; its real KV behaviour is covered in
// packages/mcp.

const ME = await testToken('gh:1');
const ORIGIN = 'https://api.test';
const mcpFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function env(appExists = true) {
  return makeEnv({
    MCP: { fetch: mcpFetch } as unknown as Fetcher,
    INTERNAL_TOKEN: 'internal-secret',
    MCP_ORIGIN: 'https://mcp.proappstore.online',
  }, mockD1(mockStmt({ first: appExists ? { id: 'hiring' } : null }), mockStmt({ first: appExists ? { id: 'hiring' } : null })));
}
const get = (path: string, token: string | null, e = env()) =>
  app.request(`${ORIGIN}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, e);
const del = (path: string, token: string | null, e = env()) =>
  app.request(`${ORIGIN}${path}`, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} }, e);

const grant = { id: 'family-aaaaaaaa', client_name: 'Claude', created_at: 10, last_used_at: 20 };

beforeEach(() => { mcpFetch.mockReset(); });

describe('GET /v1/apps/:appId/mcp (#457)', () => {
  it('requires a signed-in user', async () => {
    expect((await get('/v1/apps/hiring/mcp', null)).status).toBe(401);
    expect(mcpFetch).not.toHaveBeenCalled();
  });

  it('returns the endpoint and only the caller\'s grants, asked for by the session uid', async () => {
    mcpFetch.mockResolvedValue(Response.json({ grants: [{ ...grant, access_token: 'must-not-pass', session: 'nor-this' }] }));
    const res = await get('/v1/apps/hiring/mcp', ME);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      app_id: 'hiring',
      endpoint_url: 'https://mcp.proappstore.online/mcp/apps/hiring',
      grants: [{ id: 'family-aaaaaaaa', client_name: 'Claude', scope: 'app', created_at: 10, last_used_at: 20 }],
    });
    const [url, init] = mcpFetch.mock.calls[0]!;
    expect(url).toBe('https://mcp/internal/users/gh%3A1/apps/hiring/grants');
    expect((init?.headers as Record<string, string>)['X-Internal-Token']).toBe('internal-secret');
  });

  it('404s an unknown app and 503s without the MCP binding', async () => {
    expect((await get('/v1/apps/ghost/mcp', ME, env(false))).status).toBe(404);
    expect((await get('/v1/apps/hiring/mcp', ME, makeEnv({}, mockD1(mockStmt({ first: { id: 'hiring' } }))))).status).toBe(503);
  });

  it('surfaces an MCP worker failure as 502 rather than an empty list', async () => {
    mcpFetch.mockResolvedValue(new Response('boom', { status: 500 }));
    expect((await get('/v1/apps/hiring/mcp', ME)).status).toBe(502);
  });
});

describe('DELETE /v1/apps/:appId/mcp/grants/:grantId (#457)', () => {
  it('requires a signed-in user', async () => {
    expect((await del('/v1/apps/hiring/mcp/grants/family-aaaaaaaa', null)).status).toBe(401);
  });

  it('revokes one of the caller\'s own grants', async () => {
    mcpFetch.mockImplementation(async (_url, init) => init?.method === 'DELETE' ? Response.json({ revoked: true }) : Response.json({ grants: [grant] }));
    const res = await del('/v1/apps/hiring/mcp/grants/family-aaaaaaaa', ME);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true, id: 'family-aaaaaaaa' });
    expect(mcpFetch.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
      'GET https://mcp/internal/users/gh%3A1/apps/hiring/grants',
      'DELETE https://mcp/internal/users/gh%3A1/grants/family-aaaaaaaa',
    ]);
  });

  it('404s a grant that is not the caller\'s on this app, without revoking anything', async () => {
    mcpFetch.mockResolvedValue(Response.json({ grants: [grant] }));
    expect((await del('/v1/apps/hiring/mcp/grants/family-zzzzzzzz', ME)).status).toBe(404);
    expect((await del('/v1/apps/hiring/mcp/grants/bad!id', ME)).status).toBe(404);
    expect(mcpFetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
});
