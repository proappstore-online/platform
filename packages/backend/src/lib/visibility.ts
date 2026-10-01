/**
 * Private apps (#259, part of #251). An app declares
 * `visibility: { mode: "private", roles: [...] }` in its mcp.json; the whole app
 * — its origin on the host, its actions, its per-app MCP and its storefront
 * listing — is then reachable only by:
 *
 *   - the app's **team**, in the sense of `requireAppAccess(c, appId, 'viewer')`
 *     (lib/auth.ts): the creator, any `team_members` row of the app (whatever
 *     its team role — a developer who can deploy and run SQL must also be able
 *     to open the app and its console), or a platform admin; and
 *   - a user holding one of the declared **app roles** (`app_roles`, granted
 *     through the existing invite flow, routes/invites.ts).
 *
 * Role identity (#272): an `app_roles` row matches the session's id, and its
 * login only for a GitHub (`gh:`) session — a credential or Google account's
 * `login` is a free-text display name anyone can set to `gh:2` or `bob`. This
 * is the same rule as lib/role-subject.ts in the #272 fix, duplicated here so
 * this PR does not depend on that one landing first; fold it into that helper
 * once both are on main.
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
import type { Context } from 'hono';
import type { Env } from '../types.js';
import type { FasUser } from './auth.js';
import { HttpError, requireUser } from './auth.js';

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
 * everyone, signed in or not; a private app allows only its team (creator,
 * team members, platform admins) and holders of a declared role.
 */
export async function visibilityAllows(
  db: D1Database,
  appId: string,
  visibility: AppVisibility,
  user: Pick<FasUser, 'id' | 'login' | 'roles'> | null,
): Promise<boolean> {
  if (visibility.mode === 'public') return true;
  if (!user) return false;
  if (await isAppTeam(db, appId, user)) return true;
  if (visibility.roles.length === 0) return false;
  const placeholders = visibility.roles.map(() => '?').join(', ');
  // A role granted to a GitHub login before first sign-in still counts — for the GitHub session that owns that login only.
  const row = await db
    .prepare(`SELECT 1 FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?) AND role_name IN (${placeholders}) LIMIT 1`)
    .bind(appId, user.id, roleLoginAlias(user), ...visibility.roles)
    .first();
  return row !== null;
}

/**
 * The `app_roles.user_id` a session may match besides its id: the GitHub login
 * for a `gh:` session, else the id again. Same semantics as
 * lib/role-subject.ts `roleLoginAlias` (#272); see the module comment.
 */
export function roleLoginAlias(user: Pick<FasUser, 'id' | 'login'>): string {
  return user.id.startsWith('gh:') && user.login ? user.login : user.id;
}

/**
 * `requireAppAccess(c, appId, 'viewer')` as a predicate: platform admin, the
 * creator, or any `team_members` row of the app. One query for the last two.
 */
async function isAppTeam(db: D1Database, appId: string, user: Pick<FasUser, 'id' | 'roles'>): Promise<boolean> {
  if (user.roles.includes('admin')) return true;
  const row = await db
    .prepare(
      `SELECT 1 FROM apps WHERE id = ?1 AND creator_id = ?2
       UNION ALL
       SELECT 1 FROM team_members WHERE app_id = ?1 AND user_id = ?2
       LIMIT 1`,
    )
    .bind(appId, user.id)
    .first();
  return row !== null;
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

/**
 * For a route that also serves anonymous callers (public storage, counters):
 * a public app passes untouched; a private one needs a session (`Authorization:
 * Bearer`) the gate allows — none is a 401, a refused one a 403. Returns the
 * visibility so the caller can make the response uncacheable for a private app.
 */
export async function requireVisibleCaller(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<AppVisibility> {
  const visibility = await getAppVisibility(c.env.DB, appId);
  if (visibility.mode === 'public') return visibility;
  if (!c.req.header('Authorization')) throw new HttpError('this app is private — sign in', 401);
  await requireVisible(c.env.DB, appId, visibility, await requireUser(c));
  return visibility;
}
