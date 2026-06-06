import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must import after stubbing fetch. The module has global state (tokenCache),
// so we reimport fresh for each test via resetModules.
let getOAuth2Token: typeof import('./proxy-oauth2.js')['getOAuth2Token'];

beforeEach(async () => {
  mockFetch.mockReset();
  // Reset the module to clear the in-memory tokenCache between tests
  vi.resetModules();
  vi.stubGlobal('fetch', mockFetch);
  const mod = await import('./proxy-oauth2.js');
  getOAuth2Token = mod.getOAuth2Token;
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

  it('deduplicates concurrent requests for the same cacheKey', async () => {
    mockTokenResponse('tok-dedup', 3600);
    const [t1, t2] = await Promise.all([getOAuth2Token(opts), getOAuth2Token(opts)]);
    expect(t1).toBe('tok-dedup');
    expect(t2).toBe('tok-dedup');
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
