import { describe, expect, it, vi } from 'vitest';

// index.ts pulls in the agents/mcp transport (workerd-only modules); stub it
// the same way index-auth.test.ts does so the pure route helpers can load.
vi.mock('agents/mcp', () => ({ McpAgent: class { static serve() { return { fetch: () => new Response('') }; } } }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {} }));

// #149 acceptance: "tests cover app-scope parsing". index-auth.test.ts covers
// the routing end to end (challenge, token binding, 400 on a bad id); this
// pins the parser itself so every edge is explicit.
const { resolveMcpRoute, extractAppScope } = await import('./index.js');

describe('resolveMcpRoute (#149)', () => {
  it('routes the shared endpoint with no app scope', () => {
    expect(resolveMcpRoute('/mcp')).toEqual({ isTransport: true, appScope: null });
    expect(resolveMcpRoute('/mcp/')).toEqual({ isTransport: true, appScope: null });
  });

  it('routes /mcp/apps/:appId to an app-scoped transport, tolerating a trailing slash', () => {
    expect(resolveMcpRoute('/mcp/apps/crm')).toEqual({ isTransport: true, appScope: 'crm' });
    expect(resolveMcpRoute('/mcp/apps/chess-academy/')).toEqual({ isTransport: true, appScope: 'chess-academy' });
    expect(resolveMcpRoute('/mcp/apps/a0-1')).toEqual({ isTransport: true, appScope: 'a0-1' });
  });

  it.each([
    '/mcp/apps/CRM',          // upper case
    '/mcp/apps/CRM!',         // punctuation
    '/mcp/apps/1crm',         // must start with a letter
    '/mcp/apps/-crm',
    '/mcp/apps/crm/extra',    // nested path is not an id
    '/mcp/apps/crm/../shared',
    '/mcp/apps/',             // empty id
    '/mcp/apps/' + 'a'.repeat(59), // over the 58-char cap
  ])('%s is a 400, never a fallthrough to the shared endpoint', (pathname) => {
    const route = resolveMcpRoute(pathname);
    expect(route.isTransport).toBe(false);
    expect(route.appScope).toBeNull();
    expect(route.status).toBe(400);
    expect(route.error).toMatch(/expected \/mcp\/apps\/:appId/);
  });

  it('treats anything outside /mcp and /mcp/apps/ as a non-transport path (404 territory), not an error', () => {
    for (const p of ['/', '/mcpx', '/mcp/other', '/apps/crm', '/.well-known/oauth-authorization-server']) {
      expect(resolveMcpRoute(p), p).toEqual({ isTransport: false, appScope: null });
    }
  });

  it('accepts exactly the 58-char maximum', () => {
    const id = 'a' + 'b'.repeat(57);
    expect(resolveMcpRoute(`/mcp/apps/${id}`)).toEqual({ isTransport: true, appScope: id });
  });
});

describe('extractAppScope (#149)', () => {
  it('returns the scope only when the session props carry a valid app id', () => {
    expect(extractAppScope({ appScope: 'crm' })).toBe('crm');
    expect(extractAppScope({})).toBeNull();
    expect(extractAppScope({ appScope: '' })).toBeNull();
    expect(extractAppScope({ appScope: 'CRM' })).toBeNull();
    expect(extractAppScope({ appScope: 'crm/extra' })).toBeNull();
    expect(extractAppScope({ appScope: 42 })).toBeNull();
    expect(extractAppScope({ appScope: ['crm'] })).toBeNull();
  });
});
