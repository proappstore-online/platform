import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('sets an in-flight cookie on the first browser authorization page', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9876/callback'],
        client_name: 'Codex',
      }),
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

    expect(res?.status).toBe(200);
    expect(res?.headers.get('Location')).toBeNull();
    expect(res?.headers.get('Set-Cookie')).toContain('pas_mcp_oauth_inflight=1');
    const html = await res!.text();
    expect(html).toContain('Connect ProAppStore MCP');
    expect(html).toContain('Codex wants to use ProAppStore MCP tools');
    expect(html).toContain('/authorize/continue?nonce=');
    expect(html).toContain('provider=github');
    expect(html).toContain('provider=google');
  });

  it('redirects to GitHub only after the user continues', async () => {
    const kv = makeKv({
      'authreq:nonce-1': JSON.stringify({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:9876/callback',
        codeChallenge: 'abc',
        state: null,
      }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize/continue?nonce=nonce-1&provider=github'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toContain('https://api.proappstore.online/v1/auth/github/start');
    expect(res?.headers.get('Location')).toContain('response_mode=query');
  });

  it('can redirect to Google when selected on the confirmation page', async () => {
    const kv = makeKv({
      'authreq:nonce-1': JSON.stringify({
        clientId: 'client-1',
        redirectUri: 'http://127.0.0.1:9876/callback',
        codeChallenge: 'abc',
        state: null,
      }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize/continue?nonce=nonce-1&provider=google'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(302);
    expect(res?.headers.get('Location')).toContain('https://api.proappstore.online/v1/auth/google/start');
    expect(res?.headers.get('Location')).toContain('response_mode=query');
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

// #110: `?session=` handed the raw PAS session token to this Worker in a query
// string, where it reaches Cloudflare request logs, Referer headers and browser
// history — and it is a directly reusable Bearer for the life of the session.
// This is precisely why OAuth returns a short-lived single-use code instead.
describe('oauth callback — one-time code (#110)', () => {
  const config = (kv: KVNamespace) => ({
    issuer: 'https://mcp.proappstore.online',
    authStart: 'https://api.proappstore.online/v1/auth/github/start',
    kv,
    sessionSigningKey: 'test-key',
  });

  const authReq = JSON.stringify({
    clientId: 'client-1',
    redirectUri: 'https://client.example/cb',
    codeChallenge: 'challenge',
    state: 'st-1',
  });

  /** Stub global fetch for the code-exchange POST only. */
  function stubExchange(impl: () => Response) {
    // Both params declared so the recorded call tuple carries the RequestInit —
    // one test asserts the exchange is a POST body, not a URL.
    const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/v1/auth/code/exchange')) return impl();
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('redeems ?code= server-to-server and issues an auth code', async () => {
    const session = await mintTestSession();
    const spy = stubExchange(() => Response.json({ token: session }));
    const kv = makeKv({ 'authreq:n1': authReq });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time'),
      config(kv),
    );

    expect(res?.status).toBe(302);
    const location = new URL(res!.headers.get('Location')!);
    expect(location.searchParams.get('code')).toBeTruthy();
    // The PAS session must never appear in the redirect back to the client.
    expect(res!.headers.get('Location')).not.toContain(session);
    expect(spy).toHaveBeenCalled();
  });

  it('exchanges via POST, not a URL', async () => {
    const session = await mintTestSession();
    const spy = stubExchange(() => Response.json({ token: session }));
    await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time'),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('one-time');
  });

  it('400s when the exchange is refused', async () => {
    stubExchange(() => new Response('nope', { status: 400 }));
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=bad'),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    expect(res?.status).toBe(400);
  });

  it('refuses a stale ?session= link now that the fallback is gone', async () => {
    const session = await mintTestSession();
    const res = await handleOAuthRoute(
      new Request(`https://mcp.proappstore.online/oauth/callback?nonce=n1&session=${session}`),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    expect(res?.status).toBe(400);
  });
});

/** A session this provider's verifySession will accept (signing key 'test-key'). */
async function mintTestSession(): Promise<string> {
  const claims = { uid: 'gh:1', login: 'alice', roles: ['user'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-key'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return `${body}.${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
