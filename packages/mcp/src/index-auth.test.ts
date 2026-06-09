import { describe, expect, it, vi } from 'vitest';
import type { Env } from './env.js';

vi.mock('agents/mcp', () => ({
  McpAgent: class {
    static serve() {
      return {
        fetch: () => new Response('mock mcp transport'),
      };
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {},
}));

const { default: worker } = await import('./index.js');

const env = {
  API_BASE: 'https://api.proappstore.online',
  OAUTH_KV: {} as KVNamespace,
  SESSION_SIGNING_KEY: 'test-key',
} as Env;

const ctx = {} as ExecutionContext;

describe('MCP transport auth', () => {
  it('challenges unauthenticated MCP transport requests', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/mcp'), env, ctx);

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('keeps the public landing page unauthenticated', async () => {
    const res = await worker.fetch(new Request('https://mcp.proappstore.online/'), env, ctx);

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain('ProAppStore MCP Server');
  });
});
