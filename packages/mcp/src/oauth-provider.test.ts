import { describe, expect, it } from 'vitest';
import { createAuthChallenge, handleOAuthRoute } from './oauth-provider.js';

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data = new Map(Object.entries(seed));
  return {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
  } as unknown as KVNamespace;
}

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
        kv: makeKv(),
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      resource: 'https://mcp.proappstore.online/mcp',
      authorization_servers: ['https://mcp.proappstore.online'],
    });
  });

  it('sets an in-flight cookie on the first browser authorization redirect', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({ redirect_uris: ['http://127.0.0.1:9876/callback'] }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toContain('https://api.proappstore.online/v1/auth/github/start');
    expect(res?.headers.get('Set-Cookie')).toContain('pas_mcp_oauth_inflight=1');
  });

  it('does not redirect duplicate browser authorization tabs to GitHub', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({ redirect_uris: ['http://127.0.0.1:9876/callback'] }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256', {
        headers: { Cookie: 'pas_mcp_oauth_inflight=1' },
      }),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    expect(res?.headers.get('Location')).toBeNull();
    await expect(res?.text()).resolves.toContain('already in progress');
  });
});
