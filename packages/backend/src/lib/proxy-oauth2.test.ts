import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after stubbing fetch. The module has global state (tokenCache),
// so we reimport fresh for each test via resetModules.
let getOAuth2Token: typeof import('./proxy-oauth2.js')['getOAuth2Token'];
let OAUTH2_TOKEN_TIMEOUT_MS: number;

beforeEach(async () => {
  mockFetch.mockReset();
  // Reset the module to clear the in-memory tokenCache between tests
  vi.resetModules();
  vi.stubGlobal('fetch', mockFetch);
  const mod = await import('./proxy-oauth2.js');
  getOAuth2Token = mod.getOAuth2Token;
  OAUTH2_TOKEN_TIMEOUT_MS = mod.OAUTH2_TOKEN_TIMEOUT_MS;
});

function mockTokenResponse(accessToken: string, expiresIn = 3600) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ access_token: accessToken, expires_in: expiresIn }),
  } as Response);
}

const opts = {
  cacheKey: 'app1:MY_KEY',
  tokenUrl: 'https://auth.example.com/oauth/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

describe('getOAuth2Token', () => {
  it('fetches a token via client_credentials grant', async () => {
    mockTokenResponse('tok-1');
    const token = await getOAuth2Token(opts);
    expect(token).toBe('tok-1');

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.example.com/oauth/token');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('grant_type=client_credentials');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it('caches tokens and reuses on second call', async () => {
    mockTokenResponse('tok-cached', 3600);
    const t1 = await getOAuth2Token(opts);
    const t2 = await getOAuth2Token(opts);
    expect(t1).toBe('tok-cached');
    expect(t2).toBe('tok-cached');
    expect(mockFetch).toHaveBeenCalledTimes(1); // only one fetch
  });

  it('gives each caller that misses the cache together its own exchange, never a shared in-flight one (#655)', async () => {
    // A promise awaited by a request other than the one that created it fails once
    // that request ends (#616), so concurrent callers must not share one refresh.
    const releases: ((r: Response) => void)[] = [];
    mockFetch.mockImplementation(() => new Promise<Response>((resolve) => { releases.push(resolve); }));
    const a = getOAuth2Token(opts);
    const b = getOAuth2Token(opts);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    for (const release of releases) release({ ok: true, json: () => Promise.resolve({ access_token: 'tok-own', expires_in: 3600 }) } as Response);
    expect(await Promise.all([a, b])).toEqual(['tok-own', 'tok-own']);
    // Once one has landed, later callers use the cache.
    await expect(getOAuth2Token(opts)).resolves.toBe('tok-own');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 401,
      text: () => Promise.resolve('Unauthorized'),
    } as Response);
    await expect(getOAuth2Token(opts)).rejects.toThrow(/401/);
  });

  it('throws when response is missing access_token', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token_type: 'bearer' }), // no access_token
    } as Response);
    await expect(getOAuth2Token(opts)).rejects.toThrow(/missing access_token/);
  });

  it('defaults expires_in to 1800 when not provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ access_token: 'tok-noexp' }), // no expires_in
    } as Response);
    const token = await getOAuth2Token(opts);
    expect(token).toBe('tok-noexp');
  });

  it('uses separate cache entries for different cacheKeys', async () => {
    mockTokenResponse('tok-a');
    mockTokenResponse('tok-b');
    const a = await getOAuth2Token({ ...opts, cacheKey: 'app1:KEY_A' });
    const b = await getOAuth2Token({ ...opts, cacheKey: 'app1:KEY_B' });
    expect(a).toBe('tok-a');
    expect(b).toBe('tok-b');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// #225: the client secret never follows a redirect, and a hung token endpoint
// fails the exchange instead of holding the caller forever.
describe('getOAuth2Token hardening (#225)', () => {
  it('refuses a redirect: one fetch, redirect manual, nothing cached, next call retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://attacker.example/steal' } }));
    await expect(getOAuth2Token(opts)).rejects.toThrow('OAuth2 token request failed (307)');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect((mockFetch.mock.calls[0] as [string, RequestInit])[1].redirect).toBe('manual');
    mockTokenResponse('tok-after');
    await expect(getOAuth2Token(opts)).resolves.toBe('tok-after');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('bounds the exchange with a timeout; a hung endpoint rejects and the next call retries', async () => {
    const timeouts: AbortController[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      expect(ms).toBe(OAUTH2_TOKEN_TIMEOUT_MS);
      const ac = new AbortController();
      timeouts.push(ac);
      return ac.signal;
    });
    try {
      mockFetch.mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
      const a = getOAuth2Token(opts);
      await vi.waitFor(() => expect(timeouts).toHaveLength(1));
      timeouts[0]!.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      await expect(a).rejects.toMatchObject({ name: 'TimeoutError' });
      mockTokenResponse('tok-retry');
      await expect(getOAuth2Token(opts)).resolves.toBe('tok-retry');
    } finally {
      spy.mockRestore();
    }
  });
});
