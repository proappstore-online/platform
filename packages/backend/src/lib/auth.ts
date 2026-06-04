import type { Context } from 'hono';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  login: string;
  avatarUrl: string | null;
  /** Platform-level roles from session token: 'user', 'creator', 'admin'. */
  roles: string[];
  /** Per-app roles: { appId: ['moderator', ...] }. */
  appRoles: Record<string, string[]>;
}
/** @deprecated kept as an alias during the de-FAS rename; use SessionUser. */
export type FasUser = SessionUser;

/**
 * Verify the Bearer token as a PAS-signed session JWT (build-core/session-jwt),
 * locally — no network, no FAS. The auth service (routes/auth.ts) minted it.
 */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<SessionUser> {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError('missing bearer token', 401);
  }
  const claims = await verifySession(header.slice(7), c.env.SESSION_SIGNING_KEY);
  if (!claims) {
    throw new HttpError('invalid or expired session', 401);
  }
  return {
    id: claims.sub,
    login: claims.login,
    avatarUrl: claims.avatarUrl ?? null,
    roles: claims.roles ?? ['user'],
    appRoles: claims.appRoles ?? {},
  };
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
