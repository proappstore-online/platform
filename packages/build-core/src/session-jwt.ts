/**
 * PAS session tokens — self-contained HS256 JWTs minted + verified with the
 * platform's own SESSION_SIGNING_KEY. This is the keystone of PAS owning its
 * identity: the auth service (backend/routes/auth.ts) mints these on OAuth
 * callback, and every PAS worker (backend, agent-teams, data-worker, mcp)
 * verifies them LOCALLY with this helper — no network round-trip, no FAS.
 *
 * Standard base64url JWTs (`header.payload.signature`). UTF-8 safe.
 */

export interface SessionClaims {
  /** Stable user id, e.g. "gh:1234" or "google:sub". */
  sub: string;
  /** Display handle (GitHub login, Google name, or email local-part). */
  login: string;
  /** Avatar URL, when the provider gives one. */
  avatarUrl?: string | null;
  /** Platform roles: 'user' | 'creator' | 'admin'. */
  roles: string[];
  /** Per-app roles: { appId: ['moderator', ...] }. */
  appRoles?: Record<string, string[]>;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Issuer — always "proappstore". */
  iss: string;
}

/** Claims the caller supplies; iat/exp/iss are filled in by mintSession. */
export type NewSession = Omit<SessionClaims, 'iat' | 'exp' | 'iss'>;

const ISSUER = 'proappstore';
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(s: string): string {
  return b64urlFromBytes(enc.encode(s));
}

function bytesFromB64url(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stringFromB64url(s: string): string {
  return dec.decode(bytesFromB64url(s));
}

async function hmacKey(signingKey: string, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(signingKey) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** Mint a signed session token for the given claims. */
export async function mintSession(claims: NewSession, signingKey: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds, iss: ISSUER };
  const header = b64urlFromString(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlFromString(JSON.stringify(payload));
  const key = await hmacKey(signingKey, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${body}`) as BufferSource);
  return `${header}.${body}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

/**
 * Verify a session token's signature, issuer, and expiry. Returns the claims on
 * success, or null on any failure (bad shape, bad signature, wrong issuer,
 * expired). Never throws.
 */
export async function verifySession(token: string, signingKey: string): Promise<SessionClaims | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts as [string, string, string];
    const key = await hmacKey(signingKey, 'verify');
    const ok = await crypto.subtle.verify('HMAC', key, bytesFromB64url(sig) as BufferSource, enc.encode(`${header}.${body}`) as BufferSource);
    if (!ok) return null;
    const claims = JSON.parse(stringFromB64url(body)) as SessionClaims;
    if (claims.iss !== ISSUER) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (!claims.sub) return null;
    claims.roles = claims.roles ?? ['user'];
    claims.appRoles = claims.appRoles ?? {};
    return claims;
  } catch {
    return null;
  }
}
