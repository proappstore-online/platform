/**
 * Auth — verify PAS session tokens locally (no FAS round-trip).
 * Same HMAC-SHA256 format as build-core/session-jwt.
 */

export interface AuthUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Constant-time string compare for shared secrets (avoids a timing oracle). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyToken(
  sessionSigningKey: string,
  token: string,
): Promise<AuthUser | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(sessionSigningKey) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, enc.encode(body) as BufferSource),
    );
    let b = '';
    for (const byte of expected) b += String.fromCharCode(byte);
    const expectedStr = btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (sig.length !== expectedStr.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expectedStr.charCodeAt(i);
    if (diff !== 0) return null;
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((body.length + 3) % 4);
    const json = dec.decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    const claims = JSON.parse(json) as { uid?: string; login?: string; avatarUrl?: string | null; exp?: number };
    if (!claims.uid) return null;
    if (typeof claims.exp !== 'number' || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: claims.uid, login: claims.login ?? claims.uid, avatarUrl: claims.avatarUrl ?? null };
  } catch {
    return null;
  }
}

export function extractToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) return token;
  }
  // Browser WebSockets can't set an Authorization header, so the WS upgrade
  // passes the session token as ?token=. (Same token as REST; the only added
  // exposure is URL logging — acceptable for the upgrade request.)
  try {
    const qp = new URL(request.url).searchParams.get('token');
    if (qp) return qp.trim() || null;
  } catch { /* malformed url */ }
  return null;
}
