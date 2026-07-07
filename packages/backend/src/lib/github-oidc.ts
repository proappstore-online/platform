/**
 * GitHub Actions OIDC verification — zero-dependency, Web Crypto only.
 *
 * A workflow with `permissions: id-token: write` can mint a short-lived JWT
 * signed by GitHub (RS256), carrying verifiable claims about *which repo* is
 * running *which workflow*. We verify that JWT here so a repo can authenticate
 * to the platform with NO stored secret — the basis for keyless deploys.
 *
 * Verification: RS256 signature against GitHub's published JWKS, then issuer /
 * audience / expiry checks. Returns the claims (notably `repository` and
 * `repository_owner`) for the caller to authorize against.
 */

const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 10 * 60 * 1000; // GitHub rotates keys; a short cache is safe.
const CLOCK_SKEW_S = 60;

export interface OidcClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  /** e.g. "proappstore-online/aiuniversity" */
  repository: string;
  /** e.g. "proappstore-online" */
  repository_owner: string;
  repository_id?: string;
  ref?: string;
  sha?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  [k: string]: unknown;
}

export interface VerifyOptions {
  /** The audience the workflow requested; must match exactly. */
  audience: string;
  /** Override current time (ms) — tests only. */
  now?: number;
  /** Override fetch — tests only. */
  fetchImpl?: typeof fetch;
}

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

/** Reset the in-memory JWKS cache (tests only). */
export function _resetJwksCache(): void {
  jwksCache = null;
}

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function getKeys(fetchImpl: typeof fetch, now: number): Promise<Jwk[]> {
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  if (!body.keys?.length) throw new Error('JWKS empty');
  jwksCache = { keys: body.keys, fetchedAt: now };
  return body.keys;
}

/**
 * Verify a GitHub Actions OIDC token. Throws on any failure; returns the
 * validated claims on success.
 */
export async function verifyGithubOidc(token: string, opts: VerifyOptions): Promise<OidcClaims> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.now ?? Date.now();
  const nowS = Math.floor(nowMs / 1000);

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [h, p, s] = parts as [string, string, string];

  const header = JSON.parse(b64urlToString(h)) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected alg: ${header.alg}`);
  if (!header.kid) throw new Error('missing kid');

  const keys = await getKeys(fetchImpl, nowMs);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('signing key not found in JWKS');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('signature verification failed');

  const claims = JSON.parse(b64urlToString(p)) as OidcClaims;
  if (claims.iss !== ISSUER) throw new Error('bad issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(opts.audience)) throw new Error('bad audience');
  if (typeof claims.exp !== 'number' || claims.exp < nowS) throw new Error('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > nowS + CLOCK_SKEW_S) throw new Error('token not yet valid');
  if (typeof claims.iat === 'number' && claims.iat > nowS + CLOCK_SKEW_S) throw new Error('token issued in the future');
  if (!claims.repository || !claims.repository_owner) throw new Error('missing repository claims');

  return claims;
}
