/**
 * Private apps (#259, part of #251). An app declares
 * `visibility: { mode: "private", roles: [...] }` in its mcp.json; the whole app
 * — its origin on the host, its actions, its per-app MCP and its storefront
 * listing — is then reachable only by:
 *
 *   - the app's **owner**, in the sense of `requireAppAccess(c, appId, 'owner')`
 *     (lib/auth.ts): the creator, a `team_members` row with role `owner`, or a
 *     platform admin; and
 *   - a user holding one of the declared **app roles** (`app_roles`, granted
 *     through the existing invite flow, routes/invites.ts).
 *
 * `member` is never an allowed role: every signed-in user can self-grant it
 * (routes/roles.ts `ensure-member`), which is why the operator gate (#229)
 * refuses it too.
 *
 * Failure rule (inherited from #229/#230): a lookup that fails is never an
 * allow. A missing `app_visibility` table means the migration has not reached
 * this database, so nothing can have been declared private — that, and only
 * that, reads as public.
 */
import type { FasUser } from './auth.js';
import { HttpError } from './auth.js';

export type VisibilityMode = 'public' | 'private';

export interface AppVisibility {
  mode: VisibilityMode;
  /** App role names whose holders may use a private app, besides its owner. */
  roles: string[];
}

export const PUBLIC_VISIBILITY: AppVisibility = { mode: 'public', roles: [] };
export const MAX_VISIBILITY_ROLES = 5;

/** The app's declared visibility; public when it declares none. Throws on any lookup error but a missing table. */
export async function getAppVisibility(db: D1Database, appId: string): Promise<AppVisibility> {
  let row: { mode: string; roles: string | null } | null;
  try {
    row = await db
      .prepare('SELECT mode, roles FROM app_visibility WHERE app_id = ?')
      .bind(appId)
      .first<{ mode: string; roles: string | null }>();
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return PUBLIC_VISIBILITY;
    throw e;
  }
  return visibilityFromRow(row?.mode ?? null, row?.roles ?? null);
}

/** An `app_visibility` row (or its absence) as a visibility. Anything but 'private' is public. */
export function visibilityFromRow(mode: string | null, roles: string | null): AppVisibility {
  return mode === 'private' ? { mode: 'private', roles: parseRoles(roles) } : PUBLIC_VISIBILITY;
}

function parseRoles(raw: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]');
    // `member` can never grant access, whatever a row says.
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string' && r !== 'member') : [];
  } catch {
    return []; // a corrupt list grants nobody but the owner
  }
}

/**
 * Whether `user` may use an app with this visibility. Public apps allow
 * everyone, signed in or not; a private app allows only its owner and holders
 * of a declared role.
 */
export async function visibilityAllows(
  db: D1Database,
  appId: string,
  visibility: AppVisibility,
  user: Pick<FasUser, 'id' | 'login' | 'roles'> | null,
): Promise<boolean> {
  if (visibility.mode === 'public') return true;
  if (!user) return false;
  if (await isAppOwner(db, appId, user)) return true;
  if (visibility.roles.length === 0) return false;
  const placeholders = visibility.roles.map(() => '?').join(', ');
  // Same identity match as enforceActionAuth / roles/me: a role granted to the login before first sign-in still counts.
  const row = await db
    .prepare(`SELECT 1 FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?) AND role_name IN (${placeholders}) LIMIT 1`)
    .bind(appId, user.id, user.login, ...visibility.roles)
    .first();
  return row !== null;
}

/** `requireAppAccess(c, appId, 'owner')` as a predicate: platform admin, creator, or a team `owner`. */
async function isAppOwner(db: D1Database, appId: string, user: Pick<FasUser, 'id' | 'roles'>): Promise<boolean> {
  if (user.roles.includes('admin')) return true;
  const app = await db.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  if (app?.creator_id === user.id) return true;
  const member = await db
    .prepare("SELECT 1 FROM team_members WHERE app_id = ? AND user_id = ? AND role = 'owner' LIMIT 1")
    .bind(appId, user.id)
    .first();
  return member !== null;
}

/** Throws 403 unless `user` may use the app. */
export async function requireVisible(
  db: D1Database,
  appId: string,
  visibility: AppVisibility,
  user: Pick<FasUser, 'id' | 'login' | 'roles'> | null,
): Promise<void> {
  if (!(await visibilityAllows(db, appId, visibility, user))) {
    throw new HttpError('this app is private', 403);
  }
}
