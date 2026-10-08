import { roleSubjects } from './role-subject.js';

/** Documents only: a reviewer opens these on the API origin, so no active content. */
export const REVIEW_CONTENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

export const REVIEW_ROLE_NAME = /^[a-z][a-z0-9_-]{0,49}$/;

/** The app's declared review roles, read fresh on every request (revocation is immediate). */
export async function reviewRoles(db: D1Database, appId: string): Promise<string[]> {
  const row = await db.prepare('SELECT review_roles FROM app_storage_config WHERE app_id = ?1').bind(appId).first<{ review_roles: string }>();
  try {
    const roles = JSON.parse(row?.review_roles ?? '[]') as unknown;
    return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string' && REVIEW_ROLE_NAME.test(r) && r !== 'member') : [];
  } catch {
    return [];
  }
}

/** Whether `user` holds one of the app's declared review roles right now. */
export async function holdsReviewRole(db: D1Database, appId: string, user: { id: string; login: string }): Promise<boolean> {
  const roles = await reviewRoles(db, appId);
  if (roles.length === 0) return false;
  return Boolean(await db.prepare(
    `SELECT 1 FROM app_roles WHERE app_id = ?1 AND (user_id = ?2 OR user_id = ?3)
       AND role_name IN (${roles.map((_, i) => `?${i + 4}`).join(', ')}) LIMIT 1`,
  ).bind(appId, ...roleSubjects(user), ...roles).first());
}

/** One row of the reviewer access trail (#208): who read or deleted whose review document. */
export async function recordReviewAccess(db: D1Database, appId: string, ownerId: string, path: string, actorId: string, action: 'read' | 'delete'): Promise<void> {
  await db.prepare(
    'INSERT INTO storage_review_access (app_id, owner_id, path, actor_id, action, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(appId, ownerId, path, actorId, action, Date.now()).run();
}
