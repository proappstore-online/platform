import { describe, expect, it } from 'vitest';
import { createAuthChallenge, handleOAuthRoute } from './oauth-provider.js';

const kv = {} as KVNamespace;

describe('createAuthChallenge', () => {
  it('returns an MCP OAuth protected-resource challenge', () => {
    const res = createAuthChallenge({ issuer: 'https://mcp.proappstore.online' });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('can mark invalid bearer tokens', () => {
    const res = createAuthChallenge({ issuer: 'https://mcp.proappstore.online' }, 'invalid_token');

    expect(res.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
  });
});

describe('handleOAuthRoute', () => {
  it('serves protected resource metadata for the MCP endpoint', async () => {
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      resource: 'https://mcp.proappstore.online/mcp',
      authorization_servers: ['https://mcp.proappstore.online'],
    });
  });
});
