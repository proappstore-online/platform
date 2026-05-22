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

export interface FasUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  /** Platform-level roles from session token: 'user', 'creator', 'admin'. */
  roles: string[];
  /** Per-app roles: { appId: ['moderator', ...] }. */
  appRoles: Record<string, string[]>;
}

/**
 * Verify the Bearer token against the FAS API (/v1/auth/me).
 * Pro identity is built on top of free identity — same user, just
 * subscription state added. Roles come from the session token claims.
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
  const user = (await response.json()) as FasUser;
  // Ensure roles array exists even if FAS returns an older token format
  user.roles = user.roles ?? ['user'];
  user.appRoles = user.appRoles ?? {};
  return user;
}

/**
 * Verify the signed-in user owns the given app — i.e. they're the
 * creator_id on the apps table row. Admins (role in session token) bypass
 * the check. Returns the user object on success; throws 403 / 404 otherwise.
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
  if (user.roles.includes('admin')) return user;
  throw new HttpError('not the app owner', 403);
}

/**
 * Require a platform admin. Checks 'admin' role in session token claims.
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>): Promise<FasUser> {
  const user = await requireUser(c);
  if (!user.roles.includes('admin')) throw new HttpError('admin only', 403);
  return user;
}

/**
 * Require a specific platform role. Reads from session token claims.
 */
export async function requireRole(c: Context<{ Bindings: Env }>, role: string): Promise<FasUser> {
  const user = await requireUser(c);
  if (!user.roles.includes(role)) throw new HttpError(`requires role: ${role}`, 403);
  return user;
}
