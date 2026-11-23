/**
 * OAuth2 client_credentials token cache for the proxy.
 *
 * Worker global memory (per-isolate). Tokens are cached for (expires_in - 60s)
 * to avoid using a token that's about to expire. Only the token is shared across
 * requests, never an in-flight refresh: a promise awaited by a request other than
 * the one that created it fails once that request ends (#616, #655). Callers that
 * miss the cache together each make their own exchange.
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/** A token endpoint that does not answer in time fails the exchange (#225). */
export const OAUTH2_TOKEN_TIMEOUT_MS = 10_000;

// Per-isolate in-memory cache keyed by "appId:secretName"
const tokenCache = new Map<string, CachedToken>();

/** Get a valid OAuth2 access token, refreshing if expired or missing. */
export async function getOAuth2Token(opts: {
  cacheKey: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const { cacheKey, tokenUrl, clientId, clientSecret } = opts;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  try {
    const { accessToken, expiresIn } = await refreshToken(tokenUrl, clientId, clientSecret);
    // Cache with 60s safety margin, minimum 10s to avoid tight refresh loops
    const ttlSeconds = Math.max(10, expiresIn - 60);
    tokenCache.set(cacheKey, { accessToken, expiresAt: Date.now() + ttlSeconds * 1000 });
    return accessToken;
  } catch (err) {
    // Clear the stale cache on failure so the next request retries
    tokenCache.delete(cacheKey);
    throw err;
  }
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
    // SECURITY (#225): the client secret rides on this request, and tokenUrl is
    // checked only at registration — a 3xx is a failed exchange, never followed.
    redirect: 'manual',
    signal: AbortSignal.timeout(OAUTH2_TOKEN_TIMEOUT_MS),
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
