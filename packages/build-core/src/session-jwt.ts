/**
 * PAS session tokens — HMAC-SHA256 signed JWTs.
 *
 * Format: a 2-part `body.sig` token where body = base64url(JSON payload) and
 * sig = HMAC-SHA256(body, SESSION_SIGNING_KEY). All PAS workers verify locally
 * (no network round-trip). The payload carries `uid` (e.g. "gh:1234"),
 * `login`, `avatarUrl`, platform `roles`, and per-app `appRoles`.
 */

export interface SessionClaims {
  /** Stable user id, e.g. "gh:1234" or "google:<sub>" — the same scheme as FAS. */
  uid: string;
  /** Display handle (PAS extra; ignored by FAS). */
  login?: string;
  /** Avatar URL (PAS extra; ignored by FAS). */
  avatarUrl?: string | null;
  /** Platform roles: 'user' | 'creator' | 'admin'. */
  roles: string[];
  /** Per-app roles: { appId: ['moderator', ...] }. */
  appRoles?: Record<string, string[]>;
  iat: number;
  exp: number;
}

/** Claims the caller supplies; iat/exp are filled in by mintSession. */
export type NewSession = Omit<SessionClaims, 'iat' | 'exp'>;

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days, matching FAS

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(s: string): string {
  return b64urlBytes(enc.encode(s));
}

/** Decode base64url → UTF-8 string (TextDecoder, so multibyte login/name survive
 *  the round-trip; FAS's ASCII-only payloads decode identically). */
function b64urlDecode(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(data: string, signingKey: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(signingKey) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data) as BufferSource);
  return b64urlBytes(new Uint8Array(sig));
}

/** Mint a signed, FAS-compatible session token. */
export async function mintSession(claims: NewSession, signingKey: string, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionClaims = { ...claims, iat: now, exp: now + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const sig = await hmac(body, signingKey);
  return `${body}.${sig}`;
}

/**
 * Verify a session token's signature + expiry. Returns the claims on success, or
 * null on any failure (bad shape, bad signature, expired). Never throws.
 */
export async function verifySession(token: string, signingKey: string): Promise<SessionClaims | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = await hmac(body, signingKey);
    if (!timingSafeEqual(sig, expected)) return null;
    const claims = JSON.parse(b64urlDecode(body)) as SessionClaims;
    if (!claims.uid) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    claims.roles = claims.roles ?? ['user'];
    claims.appRoles = claims.appRoles ?? {};
    return claims;
  } catch {
    return null;
  }
}
