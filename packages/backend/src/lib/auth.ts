import type { Context } from 'hono';
import type { Env } from '../types.js';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

interface FasUser {
  id: string;
  login: string;
  avatarUrl: string | null;
}

/**
 * Verify the Bearer token against the FAS API (/v1/auth/me).
 * Pro identity is built on top of free identity — same user, just
 * subscription state added.
 */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<FasUser> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError('missing bearer token', 401);
  }
  const token = header.slice(7);
  const fasBase = c.env.FAS_API_BASE || 'https://api.freeappstore.online';
  const response = await fetch(`${fasBase}/v1/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new HttpError('invalid or expired session', 401);
  }
  return (await response.json()) as FasUser;
}
