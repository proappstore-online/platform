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

/** Team roles ordered by privilege level (higher index = more access). */
export const TEAM_ROLES = ['viewer', 'po', 'developer', 'admin', 'owner'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Verify the signed-in user has access to the given app. Checks (in order):
 * 1. team_members table (multi-user access)
 * 2. apps.creator_id (legacy single-owner, auto-migrated)
 * 3. Platform admin role in session token
 *
 * Returns the user + their team role. Throws 403/404 otherwise.
 * `minRole` defaults to 'viewer' (any team member). Pass 'owner' for
 * destructive operations, 'developer' for code writes, etc.
 */
export async function requireAppAccess(
  c: Context<{ Bindings: Env }>,
  appId: string,
  minRole: TeamRole = 'viewer',
): Promise<FasUser & { teamRole: TeamRole }> {
  const user = await requireUser(c);

  // Platform admin bypasses everything
  if (user.roles.includes('admin')) {
    return { ...user, teamRole: 'owner' };
  }

  // Fast path: check creator_id first (backwards compatible, most common case)
  const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ creator_id: string }>();
  if (!app) throw new HttpError('app not found', 404);

  let teamRole: TeamRole;

  if (app.creator_id === user.id) {
    teamRole = 'owner'; // creator is always owner
  } else {
    // Check team_members table for multi-user access
    const member = await c.env.DB.prepare(
      'SELECT role FROM team_members WHERE app_id = ? AND user_id = ?',
    )
      .bind(appId, user.id)
      .first<{ role: string }>();

    if (!member) throw new HttpError('not the app owner', 403);
    teamRole = (TEAM_ROLES.includes(member.role as TeamRole) ? member.role : 'viewer') as TeamRole;
  }

  // Check minimum role level
  const userLevel = TEAM_ROLES.indexOf(teamRole);
  const minLevel = TEAM_ROLES.indexOf(minRole);
  if (userLevel < minLevel) {
    throw new HttpError(`requires ${minRole} role (you have ${teamRole})`, 403);
  }

  return { ...user, teamRole };
}

/**
 * Backwards-compatible alias. Checks for owner-level access.
 * Use requireAppAccess(c, appId, 'developer') for write operations,
 * or requireAppAccess(c, appId, 'viewer') for read-only.
 */
export async function requireAppOwner(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<FasUser> {
  return requireAppAccess(c, appId, 'owner');
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
