import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthChallenge, handleOAuthRoute, resolveOAuthToken } from './oauth-provider.js';

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

  it('returns an app-scoped protected-resource challenge', () => {
    const res = createAuthChallenge({ issuer: 'https://mcp.proappstore.online', appId: 'crm' });

    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp/apps/crm"',
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

  it('serves protected resource metadata for an app-scoped MCP endpoint', async () => {
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/.well-known/oauth-protected-resource/mcp/apps/crm'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv: makeKv(),
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    await expect(res?.json()).resolves.toEqual({
      resource: 'https://mcp.proappstore.online/mcp/apps/crm',
      authorization_servers: ['https://mcp.proappstore.online'],
    });
  });

  it('sets a nonce-binding cookie on the browser authorization page', async () => {
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
    expect(res?.headers.get('Set-Cookie')).toContain('pas_mcp_oauth_nonce=');
    const html = await res!.text();
    expect(html).toContain('Connect ProAppStore MCP');
    expect(html).toContain('Codex wants to use ProAppStore MCP tools');
    expect(html).toContain('/authorize/continue?nonce=');
    expect(html).toContain('provider=github');
    expect(html).toContain('provider=google');
  });

  it('uses app-specific consent copy when the OAuth resource is app-scoped', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9876/callback'],
        client_name: 'Codex',
      }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.proappstore.online%2Fmcp%2Fapps%2Fcrm'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    const html = await res!.text();
    expect(html).toContain('Connect CRM MCP');
    expect(html).toContain('Codex wants to use CRM tools as your ProAppStore account');
    expect(html).not.toContain('Codex wants to use ProAppStore MCP tools');
  });

  it('rejects invalid OAuth resource targets instead of falling back to platform consent', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9876/callback'],
        client_name: 'Codex',
      }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.proappstore.online%2Fmcp%2Fapps%2FCRM!'),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(400);
    await expect(res?.text()).resolves.toBe('invalid_target');
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

  it('can hide and reject disabled auth providers', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({
        redirect_uris: ['http://127.0.0.1:9876/callback'],
        client_name: 'Codex',
      }),
    });
    const config = {
      issuer: 'https://mcp.proappstore.online',
      authStart: 'https://api.proappstore.online/v1/auth/github/start',
      authProviders: ['google'] as const,
      kv,
      sessionSigningKey: 'test-key',
    };

    const page = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256'),
      config,
    );
    const html = await page!.text();
    expect(html).toContain('Continue with Google');
    expect(html).not.toContain('Continue with GitHub');

    const nonce = html.match(/nonce=([^&"]+)/)?.[1];
    const github = await handleOAuthRoute(
      new Request(`https://mcp.proappstore.online/authorize/continue?nonce=${nonce}&provider=github`),
      config,
    );
    expect(github?.status).toBe(400);
    await expect(github?.text()).resolves.toBe('auth provider is not enabled');
  });

  it('allows a fresh authorization even when another tab previously started one', async () => {
    const kv = makeKv({
      'client:client-1': JSON.stringify({ redirect_uris: ['http://127.0.0.1:9876/callback'] }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=abc&code_challenge_method=S256', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=older-flow' },
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
    await expect(res?.text()).resolves.toContain('Connect ProAppStore MCP');
    expect(res?.headers.get('Set-Cookie')).toContain('pas_mcp_oauth_nonce=');
  });
});

describe('resolveOAuthToken', () => {
  it('resolves resource-bound OAuth token records', async () => {
    await expect(resolveOAuthToken('tok', makeKv({
      'token:tok': JSON.stringify({ session: 'pas-session', appId: 'crm' }),
    }))).resolves.toEqual({ session: 'pas-session', appId: 'crm', bound: true });
  });

  it('marks legacy raw-session OAuth token records as unbound', async () => {
    await expect(resolveOAuthToken('tok', makeKv({
      'token:tok': 'pas-session',
    }))).resolves.toEqual({ session: 'pas-session', appId: null, bound: false });
  });

  it('rejects malformed bound token records with invalid app ids', async () => {
    await expect(resolveOAuthToken('tok', makeKv({
      'token:tok': JSON.stringify({ session: 'pas-session', appId: 'CRM!' }),
    }))).resolves.toBeNull();
  });

  it('rejects malformed bound token records missing an explicit app binding', async () => {
    await expect(resolveOAuthToken('tok', makeKv({
      'token:tok': JSON.stringify({ session: 'pas-session' }),
    }))).resolves.toBeNull();
  });
});

// #110: `?session=` handed the raw PAS session token to this Worker in a query
// string, where it reaches Cloudflare request logs, Referer headers and browser
// history — and it is a directly reusable Bearer for the life of the session.
// This is precisely why OAuth returns a short-lived single-use code instead.
describe('oauth callback — one-time code (#110)', () => {
  const config = (kv: KVNamespace, api?: Fetcher) => ({
    issuer: 'https://mcp.proappstore.online',
    authStart: 'https://api.proappstore.online/v1/auth/github/start',
    api,
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
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
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
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('one-time');
  });

  it('uses the API service binding for the exchange when provided', async () => {
    const session = await mintTestSession();
    const globalSpy = vi.fn(async () => {
      throw new Error('global fetch should not be used for API exchange');
    });
    vi.stubGlobal('fetch', globalSpy);
    const apiFetch = vi.fn(async () => Response.json({ token: session }));
    const api = { fetch: apiFetch } as unknown as Fetcher;

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      config(makeKv({ 'authreq:n1': authReq }), api),
    );

    expect(res?.status).toBe(302);
    expect(apiFetch).toHaveBeenCalledOnce();
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it('400s when the exchange is refused', async () => {
    stubExchange(() => new Response('nope', { status: 400 }));
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=bad', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    expect(res?.status).toBe(400);
    await expect(res?.text()).resolves.toBe('invalid or expired code');
  });

  it('accepts sessionToken from a compatible exchange response', async () => {
    const session = await mintTestSession();
    stubExchange(() => Response.json({ sessionToken: session }));
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time', {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      config(makeKv({ 'authreq:n1': authReq })),
    );

    expect(res?.status).toBe(302);
  });

  it('requires the nonce-binding browser cookie', async () => {
    const session = await mintTestSession();
    const spy = stubExchange(() => Response.json({ token: session }));
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/oauth/callback?nonce=n1&code=one-time'),
      config(makeKv({ 'authreq:n1': authReq })),
    );

    expect(res?.status).toBe(400);
    await expect(res?.text()).resolves.toBe('authorization flow not bound to this browser');
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a stale ?session= link now that the fallback is gone', async () => {
    const session = await mintTestSession();
    const res = await handleOAuthRoute(
      new Request(`https://mcp.proappstore.online/oauth/callback?nonce=n1&session=${session}`, {
        headers: { Cookie: 'pas_mcp_oauth_nonce=n1' },
      }),
      config(makeKv({ 'authreq:n1': authReq })),
    );
    expect(res?.status).toBe(400);
  });
});

describe('token exchange resource binding', () => {
  it('persists the auth code app binding on the issued access token', async () => {
    const verifier = 'verifier-1';
    const codeChallenge = await pkceChallenge(verifier);
    const kv = makeKv({
      'code:code-1': JSON.stringify({
        session: 'pas-session',
        codeChallenge,
        redirectUri: 'https://client.example/cb',
        clientId: 'client-1',
        appId: 'crm',
      }),
    });

    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'code-1',
          redirect_uri: 'https://client.example/cb',
          client_id: 'client-1',
          code_verifier: verifier,
        }),
      }),
      {
        issuer: 'https://mcp.proappstore.online',
        authStart: 'https://api.proappstore.online/v1/auth/github/start',
        kv,
        sessionSigningKey: 'test-key',
      },
    );

    expect(res?.status).toBe(200);
    const body = await res!.json() as { access_token: string };
    await expect(resolveOAuthToken(body.access_token, kv)).resolves.toEqual({
      session: 'pas-session',
      appId: 'crm',
      bound: true,
    });
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

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
