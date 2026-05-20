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

/**
 * Verify the signed-in user owns the given app — i.e. they're the
 * creator_id on the apps table row. Admins (per ADMIN_GITHUB_IDS) bypass
 * the check. Returns the user object on success; throws 403 / 404 otherwise.
 *
 * Use on any endpoint that mutates per-app config (listing metadata, asset
 * uploads, etc.) so one dev can't overwrite another dev's app.
 */
export async function requireAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<FasUser> {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ creator_id: string }>();
  if (!row) throw new HttpError('app not found', 404);
  if (row.creator_id === user.id) return user;
  const admins = (c.env.ADMIN_GITHUB_IDS ?? '').split(',').map((s) => s.trim());
  if (admins.includes(user.id)) return user;
  throw new HttpError('not the app owner', 403);
}
