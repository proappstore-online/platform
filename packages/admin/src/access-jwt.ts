/**
 * Cloudflare Access JWT verification (#233, part of #228) — zero-dependency,
 * Web Crypto only, the same shape as the backend's GitHub OIDC verifier.
 *
 * Access terminates at the edge and forwards `Cf-Access-Jwt-Assertion`: an RS256
 * JWT signed by the team's keys (published at
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`), with `iss` set to
 * the team domain and `aud` listing the Access application's AUD tag. A header
 * is just a header — anything can send one — so a request is only trusted as
 * having passed Access once all of that verifies.
 */

const JWKS_TTL_MS = 10 * 60 * 1000; // Access rotates keys; a short cache is safe.
const CLOCK_SKEW_S = 60;
const TEAM_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/;

export interface AccessClaims {
  iss: string;
  aud: string | string[];
  sub?: string;
  email?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  [k: string]: unknown;
}

export interface AccessVerifyOptions {
  /** e.g. `proappstore.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** Override current time (ms) — tests only. */
  now?: number;
  /** Override fetch — tests only. */
  fetchImpl?: typeof fetch;
}

/** A JWKS that could not be fetched: the caller answers 503, not 401. */
export class AccessKeysUnavailable extends Error {}

type Jwk = JsonWebKey & { kid: string };
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

/** Reset the in-memory JWKS cache (tests only). */
export function _resetAccessJwksCache(): void {
  jwksCache.clear();
}

export function isValidTeamDomain(teamDomain: string): boolean {
  return TEAM_DOMAIN.test(teamDomain);
}

function b64urlToBytes(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = t.length % 4;
  if (pad) t += "=".repeat(4 - pad);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function getKeys(teamDomain: string, fetchImpl: typeof fetch, now: number, forceRefresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (!forceRefresh && cached && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  let body: { keys?: Jwk[] };
  try {
    const res = await fetchImpl(`https://${teamDomain}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    body = (await res.json()) as { keys?: Jwk[] };
  } catch (e) {
    throw new AccessKeysUnavailable(`Access JWKS fetch failed: ${(e as Error).message}`);
  }
  if (!body.keys?.length) throw new AccessKeysUnavailable("Access JWKS empty");
  jwksCache.set(teamDomain, { keys: body.keys, fetchedAt: now });
  return body.keys;
}

/**
 * Verify a Cloudflare Access JWT. Throws on any failure (AccessKeysUnavailable
 * when the keys cannot be fetched); returns the validated claims on success.
 */
export async function verifyAccessJwt(token: string, opts: AccessVerifyOptions): Promise<AccessClaims> {
  if (!isValidTeamDomain(opts.teamDomain)) throw new Error("invalid Access team domain");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const nowMs = opts.now ?? Date.now();
  const nowS = Math.floor(nowMs / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const [h, p, s] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: AccessClaims;
  try {
    header = b64urlToJson(h);
    claims = b64urlToJson(p);
  } catch {
    throw new Error("malformed JWT");
  }
  if (header.alg !== "RS256") throw new Error(`unexpected alg: ${header.alg}`);
  if (!header.kid) throw new Error("missing kid");

  let keys = await getKeys(opts.teamDomain, fetchImpl, nowMs);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // A key rotated since the cache was filled: refetch once before refusing.
    keys = await getKeys(opts.teamDomain, fetchImpl, nowMs, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("signing key not found in Access JWKS");

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s) as BufferSource,
    new TextEncoder().encode(`${h}.${p}`) as BufferSource,
  );
  if (!ok) throw new Error("signature verification failed");

  if (claims.iss !== `https://${opts.teamDomain}`) throw new Error(`unexpected issuer: ${claims.iss}`);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(opts.audience)) throw new Error("audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp < nowS - CLOCK_SKEW_S) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf > nowS + CLOCK_SKEW_S) throw new Error("token not yet valid");
  return claims;
}
