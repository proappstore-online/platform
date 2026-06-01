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
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7);
}
