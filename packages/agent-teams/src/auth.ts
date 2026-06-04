/**
 * Auth — verify PAS session tokens locally (build-core/session-jwt). No network,
 * no FAS: the PAS auth service signs the JWT with SESSION_SIGNING_KEY and every
 * worker verifies it with the same key.
 */

import { verifySession } from '@proappstore/build-core';

export interface AuthUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export async function verifyToken(
  signingKey: string,
  token: string,
): Promise<AuthUser | null> {
  const claims = await verifySession(token, signingKey);
  if (!claims) return null;
  return { id: claims.sub, login: claims.login, avatarUrl: claims.avatarUrl ?? null };
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
