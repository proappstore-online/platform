import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthChallenge, handleOAuthRoute, issueBrokerCredential, listGrants, resolveOAuthToken, revokeGrant } from './oauth-provider.js';
import { mintSession, verifySession } from '@proappstore/build-core';

function makeKv(seed: Record<string, string> = {}): KVNamespace {
  const data = new Map(Object.entries(seed));
  return {
    get: async (key: string) => data.get(key) ?? null,
    put: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
    list: async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...data.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
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
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256'),
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
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.proappstore.online%2Fmcp%2Fapps%2Fcrm'),
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
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.proappstore.online%2Fmcp%2Fapps%2FCRM!'),
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
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256'),
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
      new Request('https://mcp.proappstore.online/authorize?response_type=code&client_id=client-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A9876%2Fcallback&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256', {
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

describe('broker credential issuance (#355)', () => {
  it('is request-id stable under concurrent recovery and remains app-resource bound', async () => {
    const kv = makeKv();
    const session = await mintSession({ uid: 'gh:owner', login: 'owner', roles: ['user'] }, 'test-key');
    const config = { issuer: 'https://mcp.proappstore.online', kv, sessionSigningKey: 'test-key' };
    const input = { session, ownerId: 'gh:owner', resource: 'https://mcp.proappstore.online/mcp/apps/crm', requestId: 'req_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' };
    const [first, second] = await Promise.all([issueBrokerCredential(config, input), issueBrokerCredential(config, input)]);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    await expect(resolveOAuthToken(first!, kv)).resolves.toMatchObject({ appId: 'crm', bound: true, brokerRequestId: input.requestId });
    await expect(issueBrokerCredential(config, { ...input, resource: 'https://mcp.proappstore.online/mcp?x=1' })).resolves.toBeNull();
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
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const codeChallenge = await pkceChallenge(verifier);
    const signed = await mintSession({ uid: 'gh:1', login: 'alice', roles: ['user'] }, 'test-key');
    const kv = makeKv({
      'code:code-1': JSON.stringify({
        session: signed,
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
    await expect(resolveOAuthToken(body.access_token, kv)).resolves.toMatchObject({
      session: signed,
      appId: 'crm',
      bound: true,
    });
  });
});

// #418: MCP sign-ins should survive more than 24h without a browser visit.
// Refresh tokens rotate on every use, are single-use, bound to client_id and
// to the resource/appId they were issued for, and last 90 days by default —
// a replayed (already-rotated) token kills the whole family.
describe('refresh tokens (#418)', () => {
  function config(kv: KVNamespace, extra: Record<string, unknown> = {}) {
    return {
      issuer: 'https://mcp.proappstore.online',
      authStart: 'https://api.proappstore.online/v1/auth/github/start',
      kv,
      sessionSigningKey: 'test-key',
      ...extra,
    };
  }

  async function seedAuthCode(kv: KVNamespace, codeChallenge: string): Promise<void> {
    await kv.put('code:code-1', JSON.stringify({
      session: await mintSession({ uid: 'gh:1', login: 'alice', roles: ['user'] }, 'test-key'),
      codeChallenge,
      redirectUri: 'https://client.example/cb',
      clientId: 'client-1',
      appId: 'crm',
    }));
  }

  async function exchangeAuthCode(
    kv: KVNamespace,
    verifier: string,
    cfg: ReturnType<typeof config>,
  ): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
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
      cfg,
    );
    expect(res?.status).toBe(200);
    return res!.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
  }

  function refreshRequest(refreshToken: string, clientId = 'client-1'): Request {
    return new Request('https://mcp.proappstore.online/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
  }

  // #429: refresh re-minted the original claims, roles included, forever (the window
  // slides), so an admin removed from ADMIN_GITHUB_IDS kept admin over MCP. A
  // privileged role now lasts no longer than the session it was signed in with.
  describe('privileged roles do not outlive the authorizing session (#429)', () => {
    async function adminFamily(kv: KVNamespace) {
      const verifier = 'verifier-adminxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      await kv.put('code:code-1', JSON.stringify({
        session: await mintSession({ uid: 'gh:9', login: 'ada', roles: ['user', 'creator', 'admin'] }, 'test-key'),
        codeChallenge: await pkceChallenge(verifier),
        redirectUri: 'https://client.example/cb',
        clientId: 'client-1',
        appId: null,
      }));
      return exchangeAuthCode(kv, verifier, config(kv));
    }
    async function rolesAfterRefresh(kv: KVNamespace, refreshToken: string) {
      const res = await handleOAuthRoute(refreshRequest(refreshToken), config(kv));
      expect(res?.status).toBe(200);
      const body = (await res!.json()) as { access_token: string; refresh_token: string };
      const { session } = JSON.parse((await kv.get(`token:${body.access_token}`))!) as { session: string };
      return { roles: (await verifySession(session, 'test-key'))!.roles, next: body.refresh_token };
    }
    afterEach(() => vi.useRealTimers());

    it('keeps admin while the authorizing session would still be valid', async () => {
      const kv = makeKv();
      const issued = await adminFamily(kv);
      expect((await rolesAfterRefresh(kv, issued.refresh_token!)).roles).toEqual(['user', 'creator', 'admin']);
    });

    it('drops admin, keeping user and creator, once that session would have expired; and keeps it dropped', async () => {
      const kv = makeKv();
      const issued = await adminFamily(kv);
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 31 * 86_400_000);
      const first = await rolesAfterRefresh(kv, issued.refresh_token!);
      expect(first.roles).toEqual(['user', 'creator']);
      expect((await rolesAfterRefresh(kv, first.next)).roles).toEqual(['user', 'creator']);
    });

    it('caps a refreshed privileged session and access token at the original sign-in expiry', async () => {
      const kv = makeKv();
      const issued = await adminFamily(kv);
      const record = JSON.parse((await kv.get(`refresh:${issued.refresh_token}`))!);
      vi.useFakeTimers();
      vi.setSystemTime((record.privilegedUntil - 10) * 1000);
      const response = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
      const body = await response!.json() as { access_token: string; refresh_token: string; expires_in: number };
      expect(body.expires_in).toBe(10);
      const access = JSON.parse((await kv.get(`token:${body.access_token}`))!);
      expect((await verifySession(access.session, 'test-key'))!.exp).toBe(record.privilegedUntil);
      vi.advanceTimersByTime(11_000);
      expect(await verifySession(access.session, 'test-key')).toBeNull();
      expect((await rolesAfterRefresh(kv, body.refresh_token)).roles).toEqual(['user', 'creator']);
    });

    it('a refresh token issued before this field drops admin at once', async () => {
      const kv = makeKv();
      const issued = await adminFamily(kv);
      const key = `refresh:${issued.refresh_token}`;
      const { privilegedUntil: _gone, ...legacy } = JSON.parse((await kv.get(key))!) as Record<string, unknown>;
      await kv.put(key, JSON.stringify(legacy));
      expect((await rolesAfterRefresh(kv, issued.refresh_token!)).roles).toEqual(['user', 'creator']);
    });
  });

  it('issues a refresh token alongside the access token on the authorization_code grant', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));

    const body = await exchangeAuthCode(kv, verifier, config(kv));

    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
  });

  it('happy path: refreshing rotates to a new access + refresh token, same client and appId binding', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv));

    const res = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
    expect(res?.status).toBe(200);
    const refreshed = await res!.json() as { access_token: string; refresh_token: string; expires_in: number };

    expect(refreshed.access_token).not.toBe(issued.access_token);
    expect(refreshed.refresh_token).not.toBe(issued.refresh_token);
    expect(refreshed.expires_in).toBe(86_400);
    await expect(resolveOAuthToken(refreshed.access_token, kv)).resolves.toMatchObject({ appId: 'crm', bound: true });
  });

  it('a lost rotation response is retried idempotently within the bounded grace period', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv));

    const first = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
    const rotation = await first!.json() as { access_token: string; refresh_token: string; expires_in: number };
    const reused = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
    expect(reused?.status).toBe(200);
    const retry = await reused!.json() as { access_token: string; refresh_token: string; expires_in: number };
    expect(retry).toMatchObject({ access_token: rotation.access_token, refresh_token: rotation.refresh_token });
    expect(retry.expires_in).toBeLessThanOrEqual(rotation.expires_in);
  });

  it('reuse detection: replaying a rotated-away token revokes the whole family, including its successor', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv));

    const firstRefresh = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
    const { refresh_token: rotatedToken } = await firstRefresh!.json() as { refresh_token: string };

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    // Replay after the bounded retry grace period.
    const replay = await handleOAuthRoute(refreshRequest(issued.refresh_token!), config(kv));
    expect(replay?.status).toBe(400);
    await expect(replay?.json()).resolves.toEqual({ error: 'invalid_grant' });

    // Its successor — the one legitimately rotated to — is now dead too.
    const afterRevoke = await handleOAuthRoute(refreshRequest(rotatedToken), config(kv));
    expect(afterRevoke?.status).toBe(400);
    await expect(afterRevoke?.json()).resolves.toEqual({ error: 'invalid_grant' });
  });

  it('wrong client_id: refuses a refresh token presented by a different client', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv));

    const res = await handleOAuthRoute(refreshRequest(issued.refresh_token!, 'someone-elses-client'), config(kv));
    expect(res?.status).toBe(400);
    await expect(res?.json()).resolves.toEqual({ error: 'invalid_grant' });
  });

  it('expiry: refuses a refresh token past its 90-day deadline', async () => {
    const kv = makeKv({
      'refresh:expired-token': JSON.stringify({
        claims: { uid: 'gh:1', login: 'alice', roles: ['user'] },
        clientId: 'client-1',
        appId: 'crm',
        familyId: 'family-1',
        usedAt: null,
        expiresAt: Math.floor(Date.now() / 1000) - 1,
      }),
    });

    const res = await handleOAuthRoute(refreshRequest('expired-token'), config(kv));
    expect(res?.status).toBe(400);
    await expect(res?.json()).resolves.toEqual({ error: 'invalid_grant' });
  });

  it('defaults the refresh token deadline to 90 days out', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv));

    const raw = await kv.get(`refresh:${issued.refresh_token}`);
    const record = JSON.parse(raw!) as { expiresAt: number };
    const now = Math.floor(Date.now() / 1000);
    expect(record.expiresAt).toBeGreaterThan(now + 89 * 24 * 60 * 60);
    expect(record.expiresAt).toBeLessThanOrEqual(now + 90 * 24 * 60 * 60);
  });

  it('honours a configured refresh-token TTL instead of the 90-day default', async () => {
    const verifier = 'verifier-1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const kv = makeKv();
    await seedAuthCode(kv, await pkceChallenge(verifier));
    const issued = await exchangeAuthCode(kv, verifier, config(kv, { refreshTokenTtlSeconds: 10 }));

    const raw = await kv.get(`refresh:${issued.refresh_token}`);
    const record = JSON.parse(raw!) as { expiresAt: number };
    const now = Math.floor(Date.now() / 1000);
    expect(record.expiresAt).toBeGreaterThan(now);
    expect(record.expiresAt).toBeLessThanOrEqual(now + 10);
  });

  it('re-mints the session fresh on every refresh, independent of the original session TTL', async () => {
    // A refresh record crafted directly (as if issued long ago) proves the
    // new access token's session comes from re-minting the stored claims,
    // not from reusing any previously-stored session JWT.
    const kv = makeKv({
      'refresh:tok-1': JSON.stringify({
        claims: { uid: 'gh:1', login: 'alice', roles: ['user'] },
        clientId: 'client-1',
        appId: 'crm',
        familyId: 'family-1',
        usedAt: null,
        expiresAt: Math.floor(Date.now() / 1000) + 100,
      }),
    });

    const res = await handleOAuthRoute(refreshRequest('tok-1'), config(kv));
    expect(res?.status).toBe(200);
    const { access_token } = await res!.json() as { access_token: string };

    const resolved = await resolveOAuthToken(access_token, kv);
    expect(resolved?.bound).toBe(true);
    const claims = await verifySession(resolved!.session, 'test-key');
    expect(claims).not.toBeNull();
    // Freshly minted just now, so it's got (near enough) a full 30-day life —
    // nowhere near the refresh record's own 100-second deadline above.
    expect(claims!.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(29 * 24 * 60 * 60);
  });
});

describe('AS metadata and dynamic client registration (#418)', () => {
  it('advertises refresh_token support in the authorization server metadata', async () => {
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/.well-known/oauth-authorization-server'),
      { issuer: 'https://mcp.proappstore.online', authStart: 'https://api.proappstore.online/v1/auth/github/start', kv: makeKv(), sessionSigningKey: 'test-key' },
    );
    await expect(res?.json()).resolves.toMatchObject({
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });

  it('registers dynamic clients with refresh_token in their grant_types', async () => {
    const res = await handleOAuthRoute(
      new Request('https://mcp.proappstore.online/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: ['https://client.example/cb'] }),
      }),
      { issuer: 'https://mcp.proappstore.online', authStart: 'https://api.proappstore.online/v1/auth/github/start', kv: makeKv(), sessionSigningKey: 'test-key' },
    );
    expect(res?.status).toBe(201);
    const body = await res!.json() as { grant_types: string[] };
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
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

// #457: every authorization is a grant, listed per account and endpoint and
// revocable; revoking one kills its live access tokens and its refresh chain.
describe('grants (#457)', () => {
  const cfg = (kv: KVNamespace) => ({
    issuer: 'https://mcp.proappstore.online',
    authStart: 'https://api.proappstore.online/v1/auth/github/start',
    kv,
    sessionSigningKey: 'test-key',
  });

  async function authorize(kv: KVNamespace, uid: string, appId: string | null, n: string) {
    const verifier = `verifier-${n}`.padEnd(43, "x");
    await kv.put(`code:code-${n}`, JSON.stringify({
      session: await mintSession({ uid, login: uid.replace('gh:', ''), roles: ['user'] }, 'test-key'),
      codeChallenge: await pkceChallenge(verifier),
      redirectUri: 'https://client.example/cb',
      clientId: 'client-1',
      appId,
    }));
    const res = await handleOAuthRoute(new Request('https://mcp.proappstore.online/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: `code-${n}`, redirect_uri: 'https://client.example/cb', client_id: 'client-1', code_verifier: verifier }),
    }), cfg(kv));
    return await res!.json() as { access_token: string; refresh_token: string };
  }
  const refresh = (kv: KVNamespace, token: string) => handleOAuthRoute(new Request('https://mcp.proappstore.online/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: 'client-1' }),
  }), cfg(kv));

  it('records a grant per authorization, with no credential in it', async () => {
    const kv = makeKv({ 'client:client-1': JSON.stringify({ redirect_uris: ['https://client.example/cb'], client_name: 'Claude' }) });
    const issued = await authorize(kv, 'gh:1', 'hiring', 'a');
    const grants = await listGrants(kv, 'gh:1', 'hiring');
    expect(grants).toEqual([{ id: expect.any(String), client_name: 'Claude', scope: 'app', app_id: 'hiring', created_at: expect.any(Number), last_used_at: expect.any(Number) }]);
    const stored = JSON.stringify([...(await kv.list({ prefix: 'grant:' })).keys]) + await kv.get(`grant:gh:1:hiring:${grants[0]!.id}`);
    expect(stored).not.toContain(issued.access_token);
    expect(stored).not.toContain(issued.refresh_token);
    await expect(resolveOAuthToken(issued.access_token, kv)).resolves.toMatchObject({ appId: 'hiring', bound: true, familyId: grants[0]!.id });
  });

  it('lists only the asked account and endpoint', async () => {
    const kv = makeKv();
    await authorize(kv, 'gh:1', 'hiring', 'a');
    await authorize(kv, 'gh:2', 'hiring', 'b');
    await authorize(kv, 'gh:1', 'crm', 'c');
    await authorize(kv, 'gh:1', null, 'd');
    expect(await listGrants(kv, 'gh:1', 'hiring')).toHaveLength(1);
    expect(await listGrants(kv, 'gh:2', 'hiring')).toHaveLength(1);
    expect(await listGrants(kv, 'gh:1', null)).toMatchObject([{ scope: 'shared', app_id: null }]);
    expect(await listGrants(kv, 'gh:3', 'hiring')).toEqual([]);
  });

  it('keeps scope and the grant across a refresh, and renews last_used_at', async () => {
    const kv = makeKv();
    const issued = await authorize(kv, 'gh:1', 'hiring', 'a');
    const [before] = await listGrants(kv, 'gh:1', 'hiring');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_600_000);
    try {
      const res = await refresh(kv, issued.refresh_token);
      expect(res?.status).toBe(200);
      const next = await res!.json() as { access_token: string };
      await expect(resolveOAuthToken(next.access_token, kv)).resolves.toMatchObject({ appId: 'hiring', bound: true, familyId: before!.id });
      const after = await listGrants(kv, 'gh:1', 'hiring');
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: before!.id, created_at: before!.created_at });
      expect(after[0]!.last_used_at).toBeGreaterThan(before!.last_used_at);
    } finally { vi.useRealTimers(); }
  });

  it('revoking one grant kills its access and refresh tokens and leaves another account untouched', async () => {
    const kv = makeKv();
    const mine = await authorize(kv, 'gh:1', 'hiring', 'a');
    const theirs = await authorize(kv, 'gh:2', 'hiring', 'b');
    const [grant] = await listGrants(kv, 'gh:1', 'hiring');
    expect(await revokeGrant({ kv }, 'gh:2', grant!.id)).toBe(false); // not their grant
    await expect(resolveOAuthToken(mine.access_token, kv)).resolves.not.toBeNull();
    expect(await revokeGrant({ kv }, 'gh:1', grant!.id)).toBe(true);
    await expect(resolveOAuthToken(mine.access_token, kv)).resolves.toBeNull();
    expect((await refresh(kv, mine.refresh_token))?.status).toBe(400);
    expect(await listGrants(kv, 'gh:1', 'hiring')).toEqual([]);
    await expect(resolveOAuthToken(theirs.access_token, kv)).resolves.toMatchObject({ appId: 'hiring' });
    expect((await refresh(kv, theirs.refresh_token))?.status).toBe(200);
    expect(await revokeGrant({ kv }, 'gh:1', 'not a grant id!')).toBe(false);
  });
});

// Protocol-facing behavior beyond the legacy happy-path fixtures.
describe('OAuth client interoperability and validation', () => {
  const cfg = (kv = makeKv()) => ({ issuer: 'https://mcp.proappstore.online', authStart: 'https://api.proappstore.online/v1/auth/github/start', kv, sessionSigningKey: 'test-key' });
  const registerRequest = (value: unknown) => new Request('https://mcp.proappstore.online/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

  it.each([null, [], { redirect_uris: [1] }, { redirect_uris: ['javascript:alert(1)'] }, { redirect_uris: ['http://remote.example/callback'] }, { redirect_uris: ['https://client.example/cb#fragment'] }, { redirect_uris: ['https://user:password@client.example/cb'] }, { redirect_uris: ['https://client.example/cb'], client_name: [] }])('rejects malformed or unsafe registration metadata: %j', async (value) => {
    expect((await handleOAuthRoute(registerRequest(value), cfg()))?.status).toBe(400);
  });

  it('advertises issuer-bound callbacks, CIMD, refresh and revocation', async () => {
    const response = await handleOAuthRoute(new Request('https://mcp.proappstore.online/.well-known/oauth-authorization-server'), cfg());
    expect(await response!.json()).toMatchObject({ authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true, revocation_endpoint: 'https://mcp.proappstore.online/revoke', grant_types_supported: ['authorization_code', 'refresh_token'] });
  });

  it('accepts a trusted HTTPS client metadata document without DCR and caches it', async () => {
    const id = 'https://chatgpt.com/oauth/codex/client.json';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ client_id: id, client_name: 'Codex', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none' }));
    const config = cfg();
    const query = new URLSearchParams({ client_id: id, response_type: 'code', redirect_uri: 'http://127.0.0.1:49152/callback', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
    for (let i = 0; i < 2; i++) expect((await handleOAuthRoute(new Request(`https://mcp.proappstore.online/authorize?${query}`), config))?.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ redirect: 'error', headers: { Accept: 'application/json' } });
  });

  it('does not fetch client metadata from an untrusted host', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const query = new URLSearchParams({ client_id: 'https://internal.example/client.json', response_type: 'code', redirect_uri: 'https://client.example/cb', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
    expect((await handleOAuthRoute(new Request(`https://mcp.proappstore.online/authorize?${query}`), cfg()))?.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('RFC 7009 revocation is client-bound and immediately invalidates access and refresh', async () => {
    const kv = makeKv({
      'refresh:refresh-1': JSON.stringify({ claims: { uid: 'gh:1' }, clientId: 'client-1', appId: null, familyId: 'family-1', usedAt: null, expiresAt: Math.floor(Date.now() / 1000) + 300 }),
      'token:access-1': JSON.stringify({ session: 'session', clientId: 'client-1', appId: null, familyId: 'family-1' }),
    });
    const revoke = (client_id: string) => handleOAuthRoute(new Request('https://mcp.proappstore.online/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'refresh-1', client_id }) }), cfg(kv));
    expect((await revoke('different-client'))?.status).toBe(200);
    expect(await resolveOAuthToken('access-1', kv)).not.toBeNull();
    const response = await revoke('client-1');
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(await resolveOAuthToken('access-1', kv)).toBeNull();
    expect(await kv.get('revoked-refresh-family:family-1')).toBe('1');
  });
});
