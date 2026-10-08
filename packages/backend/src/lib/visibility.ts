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
 * Platform admins are recognised by id (`ADMIN_GITHUB_IDS`), not only by the
 * session's `admin` role: a session issued to an app origin carries just
 * ['user'] (#56), so a role check alone refused every admin on the very origin
 * the gate guards.
 *
 * Role identity (#272): an `app_roles` row matches the session's id, and its
 * login only for a GitHub (`gh:`) session — a credential or Google account's
 * `login` is a free-text display name anyone can set to `gh:2` or `bob`. This
 * is the shared rule in lib/role-subject.ts (#272).
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
import { roleLoginAlias } from './role-subject.js';

/** What the visibility predicate reads: the database, and who the platform admins are. */
export type VisibilityEnv = Pick<Env, 'DB' | 'ADMIN_GITHUB_IDS'>;

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
  env: VisibilityEnv,
  appId: string,
  visibility: AppVisibility,
  user: Pick<FasUser, 'id' | 'login' | 'roles'> | null,
): Promise<boolean> {
  if (visibility.mode === 'public') return true;
  if (!user) return false;
  const db = env.DB;
  if (isPlatformAdmin(env, user)) return true;
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
 * A platform admin: the session says so (a first-party session), or the user's
 * id is in ADMIN_GITHUB_IDS — the list first-party sessions get the role from
 * (routes/auth.ts rolesFor). App-origin sessions carry only ['user'] (#56).
 */
export function isPlatformAdmin(env: Pick<Env, 'ADMIN_GITHUB_IDS'>, user: Pick<FasUser, 'id' | 'roles'>): boolean {
  if (user.roles.includes('admin')) return true;
  return (env.ADMIN_GITHUB_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean).includes(user.id);
}

/**
 * `requireAppAccess(c, appId, 'viewer')` as a predicate, minus the admin check
 * (isPlatformAdmin): the creator, or any `team_members` row of the app.
 */
async function isAppTeam(db: D1Database, appId: string, user: Pick<FasUser, 'id' | 'roles'>): Promise<boolean> {
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

/**
 * visibilityAllows as a SQL condition over a stored user id, for rows that
 * have no session behind them: push subscriptions and notify-user recipients
 * (#325). Evaluated when a notification is sent, so a revoked role or a
 * public→private flip stops delivery from then on, not only at subscribe time.
 * One statement for a whole broadcast — a per-subscriber visibilityAllows
 * would cost two D1 queries a recipient and hit D1's per-invocation limit.
 *
 * `userCol` is a trusted column expression (e.g. `s.user_id`); the binds are
 * positional `?`, in order. Admins match by id only (ADMIN_GITHUB_IDS): a
 * stored row has no session roles. The login alias is the user's stored
 * GitHub login, for a `gh:` id only, as in roleLoginAlias.
 */
export function visibleUserCondition(
  env: Pick<Env, 'ADMIN_GITHUB_IDS'>,
  appId: string,
  visibility: AppVisibility,
  userCol: string,
): { sql: string; binds: unknown[] } {
  if (visibility.mode === 'public') return { sql: '1', binds: [] };
  const admins = (env.ADMIN_GITHUB_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const parts = [
    `EXISTS (SELECT 1 FROM apps WHERE id = ? AND creator_id = ${userCol})`,
    `EXISTS (SELECT 1 FROM team_members WHERE app_id = ? AND user_id = ${userCol})`,
  ];
  const binds: unknown[] = [appId, appId];
  if (admins.length > 0) {
    parts.push(`${userCol} IN (${admins.map(() => '?').join(', ')})`);
    binds.push(...admins);
  }
  if (visibility.roles.length > 0) {
    parts.push(
      `EXISTS (SELECT 1 FROM app_roles WHERE app_id = ? AND role_name IN (${visibility.roles.map(() => '?').join(', ')})
         AND (user_id = ${userCol} OR (substr(${userCol}, 1, 3) = 'gh:' AND user_id = (SELECT login FROM users WHERE id = ${userCol}))))`,
    );
    binds.push(appId, ...visibility.roles);
  }
  return { sql: `(${parts.join(' OR ')})`, binds };
}

/** Throws 403 unless `user` may use the app. */
export async function requireVisible(
  env: VisibilityEnv,
  appId: string,
  visibility: AppVisibility,
  user: Pick<FasUser, 'id' | 'login' | 'roles'> | null,
): Promise<void> {
  if (!(await visibilityAllows(env, appId, visibility, user))) {
    throw new HttpError('this app is private', 403);
  }
}

/**
 * Per-isolate memory of each app's visibility, for the routes that also serve
 * anonymous callers of PUBLIC apps — public storage, counter reads, room
 * upgrades (#259 review). Without it every one of those requests, on every
 * public app, paid a D1 read it did not have before private apps existed.
 *
 *  - Fresh for VISIBILITY_CACHE_TTL_MS (30 s): a public↔private flip reaches
 *    these routes within that bound. Registering a manifest (routes/tools.ts)
 *    forgets the app in the isolate that handled it at once.
 *  - D1 error: the last known mode is used, however old — a D1 blip must not
 *    take down a public app's images, nor open a private app's.
 *  - D1 error and nothing known: 503. A private app's files are never served
 *    on a guess, so a cold isolate during an outage refuses public apps too.
 *
 * The host's own gate, visibility/me, actions and the storefront do not use
 * this: they read D1 live (or ride an existing read).
 */
export const VISIBILITY_CACHE_TTL_MS = 30_000;
const VISIBILITY_CACHE_MAX = 1000;
const visibilityCache = new Map<string, { visibility: AppVisibility; at: number }>();

export async function getAppVisibilityCached(db: D1Database, appId: string): Promise<AppVisibility> {
  const known = visibilityCache.get(appId);
  if (known && Date.now() - known.at < VISIBILITY_CACHE_TTL_MS) return known.visibility;
  let visibility: AppVisibility;
  try {
    visibility = await getAppVisibility(db, appId);
  } catch (e) {
    if (known) return known.visibility;
    console.warn(`app visibility unavailable for ${appId}: ${(e as Error)?.message ?? e}`);
    throw new HttpError('app visibility unavailable — retry shortly', 503);
  }
  visibilityCache.delete(appId);
  if (visibilityCache.size >= VISIBILITY_CACHE_MAX) visibilityCache.delete(visibilityCache.keys().next().value as string);
  visibilityCache.set(appId, { visibility, at: Date.now() });
  return visibility;
}

/** Forget one app's remembered visibility (its manifest was just registered), or every app's (tests). */
export function forgetAppVisibility(appId?: string): void {
  if (appId === undefined) visibilityCache.clear();
  else visibilityCache.delete(appId);
}

/**
 * For a route that also serves anonymous callers (public storage, counters):
 * a public app passes untouched; a private one needs a session (`Authorization:
 * Bearer`) the gate allows — none is a 401, a refused one a 403. Returns the
 * visibility so the caller can make the response uncacheable for a private app.
 * Reads the per-isolate cache above (see there for the failure mode).
 */
export async function requireVisibleCaller(
  c: Context<{ Bindings: Env }>,
  appId: string,
): Promise<AppVisibility> {
  const visibility = await getAppVisibilityCached(c.env.DB, appId);
  if (visibility.mode === 'public') return visibility;
  if (!c.req.header('Authorization')) throw new HttpError('this app is private — sign in', 401);
  await requireVisible(c.env, appId, visibility, await requireUser(c));
  return visibility;
}

/**
 * For a route that always needs a session (counter writes, per-user KV and
 * private storage, #276): the signed-in caller, refused 403 by a private app's
 * gate. A refused user has no reason to touch even their own rows in an app they
 * cannot open, and must not use it as free storage billed to the app. Reads the
 * per-isolate cache above, so a public app pays no D1 read per request.
 */
export async function requireVisibleUser(c: Context<{ Bindings: Env }>, appId: string): Promise<FasUser> {
  const user = await requireUser(c);
  await requireVisible(c.env, appId, await getAppVisibilityCached(c.env.DB, appId), user);
  return user;
}
