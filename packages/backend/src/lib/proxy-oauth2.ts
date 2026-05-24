/**
 * OAuth2 client_credentials token cache for the proxy.
 *
 * Worker global memory (per-isolate) with deduplication of concurrent
 * refreshes. Tokens are cached for (expires_in - 60s) to avoid using
 * a token that's about to expire.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Per-isolate in-memory cache keyed by "appId:secretName"
const tokenCache = new Map<string, CachedToken>();

// Dedup concurrent refreshes: only one inflight token request per cache key
const inflightRefresh = new Map<string, Promise<string>>();

/**
 * Get a valid OAuth2 access token, refreshing if expired or missing.
 * Uses worker memory cache with concurrent-request deduplication.
 */
export async function getOAuth2Token(opts: {
  cacheKey: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const { cacheKey, tokenUrl, clientId, clientSecret } = opts;

  // Check memory cache
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  // Deduplicate concurrent refreshes
  const existing = inflightRefresh.get(cacheKey);
  if (existing) return existing;

  const promise = refreshToken(tokenUrl, clientId, clientSecret)
    .then(({ accessToken, expiresIn }) => {
      // Cache with 60s safety margin, minimum 10s to avoid tight refresh loops
      const ttlSeconds = Math.max(10, expiresIn - 60);
      const expiresAt = Date.now() + ttlSeconds * 1000;
      tokenCache.set(cacheKey, { accessToken, expiresAt });
      inflightRefresh.delete(cacheKey);
      return accessToken;
    })
    .catch((err) => {
      // Clear stale cache and inflight on failure so next request retries
      tokenCache.delete(cacheKey);
      inflightRefresh.delete(cacheKey);
      throw err;
    });

  inflightRefresh.set(cacheKey, promise);
  return promise;
}

async function refreshToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    // Log details server-side but don't surface upstream error body to the client
    const text = await res.text().catch(() => '');
    console.error(`OAuth2 token refresh failed: ${res.status} ${text.slice(0, 500)}`);
    throw new Error(`OAuth2 token request failed (${res.status})`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('OAuth2 token response missing access_token');
  }

  return {
    accessToken: data.access_token,
    // Default to 30 min if not provided (common for OAuth2)
    expiresIn: data.expires_in ?? 1800,
  };
}
