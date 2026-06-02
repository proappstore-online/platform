/**
 * Auth — verify FAS session tokens for agent-teams requests.
 * Same pattern as the PAS backend: Bearer token → FAS /v1/auth/me.
 */

export interface AuthUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

export async function verifyToken(
  fasApiBase: string,
  token: string,
): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${fasApiBase}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as AuthUser;
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
