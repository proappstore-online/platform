import { HttpError, type FasUser } from './auth.js';

type Owner = Pick<FasUser, 'id' | 'roles'>;
type Row = { accepting_requests: number; updated_at: number | null };
const result = (appId: string, row: Row) => ({ appId, accepting_requests: row.accepting_requests === 1, updated_at: row.updated_at });

// Exact requireAppOwner authority, rechecked in the read/write statement after
// the route's authorization: current creator, current owner membership, or session admin.
const OWNER = `(?3 = 1 OR a.creator_id = ?2 OR EXISTS
  (SELECT 1 FROM team_members m WHERE m.app_id = a.id AND m.user_id = ?2 AND m.role = 'owner'))`;

export async function readRecruitment(db: D1Database, appId: string, user: Owner) {
  const row = await db.prepare(`SELECT COALESCE(r.accepting_requests, 1) AS accepting_requests, r.updated_at
    FROM apps a LEFT JOIN app_team_recruitment r ON r.app_id = a.id WHERE a.id = ?1 AND ${OWNER}`)
    .bind(appId, user.id, user.roles.includes('admin') ? 1 : 0).first<Row>();
  if (!row) throw new HttpError('current app owner required', 403);
  return result(appId, row);
}

export async function saveRecruitment(db: D1Database, appId: string, user: Owner, accepting: boolean, now: number) {
  const row = await db.prepare(`INSERT INTO app_team_recruitment (app_id, accepting_requests, updated_by, updated_at)
    SELECT a.id, ?4, ?2, ?5 FROM apps a WHERE a.id = ?1 AND ${OWNER}
    ON CONFLICT(app_id) DO UPDATE SET accepting_requests = excluded.accepting_requests,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
    RETURNING accepting_requests, updated_at`)
    .bind(appId, user.id, user.roles.includes('admin') ? 1 : 0, accepting ? 1 : 0, now).first<Row>();
  if (!row) throw new HttpError('current app owner required', 403);
  return result(appId, row);
}

/** Used in the intake INSERT as well as the precheck; closing/private/deleted apps cannot race admission. */
export function teamRequestsOpenCondition(appIdBind: '?1' | '?2'): string {
  return `EXISTS (SELECT 1 FROM apps a WHERE a.id = ${appIdBind})
    AND EXISTS (SELECT 1 FROM app_storefront_publication p WHERE p.app_id = ${appIdBind} AND p.listed = 1)
    AND NOT EXISTS (SELECT 1 FROM app_visibility v WHERE v.app_id = ${appIdBind} AND v.mode = 'private')
    AND NOT EXISTS (SELECT 1 FROM app_team_recruitment r WHERE r.app_id = ${appIdBind} AND r.accepting_requests = 0)`;
}

export async function teamRequestsOpen(db: D1Database, appId: string): Promise<boolean> {
  return (await db.prepare(`SELECT 1 WHERE ${teamRequestsOpenCondition('?1')}`).bind(appId).first()) !== null;
}
