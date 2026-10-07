/**
 * The platform-held users of an app (#246), for the console operator view
 * (#240): every user who holds one of the app's roles or has recorded
 * activity in it — whether or not the app declares an operator contract.
 *
 * Only what the platform itself holds, and nothing more personal than
 * GET /apps/:appId/roles already shows a team admin: the platform user id,
 * login and avatar, the app roles, when the user first appeared (earliest role
 * grant or first active day) and their activity. Never email. `activity` is
 * derived from usage_daily — the platform has no user suspension of its own;
 * an app's suspensions are its contract's `suspensions` resource.
 *
 * Owner-only (requireOperatorOwner). 50 a page, keyset-paged on user_id; `q`
 * is a login prefix or an exact user id. Each read joins the operator audit
 * trail as `read:platform-users`, without its results.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { markAudited, requireOperatorOwner } from '../lib/operator-audit-marks.js';
import { PLATFORM_USERS_READ, writeRow } from './operator-audit.js';
import { textParam } from '../lib/text-param.js';

export const operatorUsersRoutes = new Hono<{ Bindings: Env }>();

const PAGE = 50;
const MAX_SEARCH = 100;
const MAX_CURSOR = 200;
const ACTIVE_DAYS = 30;
const DAY = 86_400_000;

export type PlatformUserActivity = 'active' | 'inactive' | 'never_seen';

interface Row {
  user_id: string;
  login: string | null;
  avatar_url: string | null;
  roles: string | null;
  first_granted: number | null;
  first_day: string | null;
  last_seen: number | null;
}

/** `%`, `_` and `\` in a search are literal, not LIKE wildcards. */
const likePrefix = (q: string) => `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

export function activityOf(lastSeen: number | null, now: number): PlatformUserActivity {
  if (lastSeen === null) return 'never_seen';
  return lastSeen >= now - ACTIVE_DAYS * DAY ? 'active' : 'inactive';
}

/** The earlier of the first role grant (epoch ms) and the first active day (UTC midnight). */
export function joinDateOf(firstGranted: number | null, firstDay: string | null): number | null {
  const day = firstDay ? Date.parse(`${firstDay}T00:00:00Z`) : NaN;
  const candidates = [firstGranted, Number.isFinite(day) ? day : null].filter((v): v is number => v !== null);
  return candidates.length ? Math.min(...candidates) : null;
}

operatorUsersRoutes.get('/apps/:appId/operator/users', async (c) => {
  const appId = c.req.param('appId');
  const owner = await requireOperatorOwner(c, appId);
  const q = textParam(c.req.query('q'), MAX_SEARCH, 'q');
  const cursor = textParam(c.req.query('cursor'), MAX_CURSOR, 'cursor');

  const { results } = await c.env.DB.prepare(
    `WITH granted AS (
       SELECT user_id, MIN(granted_at) AS first_granted FROM app_roles WHERE app_id = ?1 GROUP BY user_id
     ), seen AS (
       SELECT user_id, MIN(day) AS first_day, MAX(last_seen) AS last_seen FROM usage_daily WHERE app_id = ?1 GROUP BY user_id
     ), everyone AS (
       SELECT user_id FROM granted UNION SELECT user_id FROM seen
     )
     SELECT e.user_id, u.login, u.avatar_url, g.first_granted, s.first_day, s.last_seen,
            (SELECT json_group_array(role_name) FROM
               (SELECT role_name FROM app_roles WHERE app_id = ?1 AND user_id = e.user_id ORDER BY role_name)) AS roles
       FROM everyone e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN granted g ON g.user_id = e.user_id
       LEFT JOIN seen s ON s.user_id = e.user_id
      WHERE (?2 IS NULL OR e.user_id > ?2)
        AND (?3 IS NULL OR e.user_id = ?3 OR u.login LIKE ?4 ESCAPE '\\')
      ORDER BY e.user_id
      LIMIT ?5`,
  ).bind(appId, cursor, q, q === null ? null : likePrefix(q), PAGE + 1).all<Row>();

  const now = Date.now();
  const page = (results ?? []).slice(0, PAGE);
  const users = page.map((r) => ({
    user_id: r.user_id,
    login: r.login,
    avatar_url: r.avatar_url,
    roles: r.roles ? (JSON.parse(r.roles) as string[]) : [],
    join_date: joinDateOf(r.first_granted, r.first_day),
    last_active: r.last_seen,
    activity: activityOf(r.last_seen, now),
  }));

  await writeRow(c.env.DB, { appId, actorId: owner.id, role: '', status: 200, operatorAction: PLATFORM_USERS_READ, target: null });
  markAudited(c.req.raw);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ users, next_cursor: (results?.length ?? 0) > PAGE ? page[page.length - 1]!.user_id : null });
});
