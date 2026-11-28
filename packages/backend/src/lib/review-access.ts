import { heldAppRoles } from './held-app-roles.js';

/** Documents only: a reviewer opens these on the API origin, so no active content. */
export const REVIEW_CONTENT_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);

const REVIEW_ROLE_NAME = /^[a-z][a-z0-9_-]{0,49}$/;
const MAX_REVIEW_ROLES = 10;

/**
 * A review_roles list as PUT storage-config and mcp.json `storage.review_roles`
 * (#696) both accept it: up to MAX_REVIEW_ROLES app role names, never `member`
 * (every signed-in user holds it, so every review document would be readable by
 * every user of the app). Repeats are dropped. `field` names the list in the error.
 */
export function parseReviewRoles(raw: unknown, field: string): { error: string } | { roles: string[] } {
  if (!Array.isArray(raw) || raw.length > MAX_REVIEW_ROLES || raw.some((r) => typeof r !== 'string' || !REVIEW_ROLE_NAME.test(r))) {
    return { error: `${field} must be an array of up to ${MAX_REVIEW_ROLES} app role names` };
  }
  if (raw.includes('member')) return { error: `${field} cannot include 'member' (every signed-in user holds it)` };
  return { roles: [...new Set(raw as string[])] };
}

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

/**
 * Whether `user` holds one of the app's review roles right now: by an app_roles
 * grant or, for a role the app declares in mcp.json `roles`, by owning the app
 * (heldAppRoles, #696).
 */
export async function holdsReviewRole(db: D1Database, appId: string, user: { id: string; login: string }): Promise<boolean> {
  const roles = await reviewRoles(db, appId);
  if (roles.length === 0) return false;
  const held = await heldAppRoles(db, appId, user);
  return roles.some((r) => held.has(r));
}

/** One row of the reviewer access trail (#208): who read or deleted whose review document. */
export async function recordReviewAccess(db: D1Database, appId: string, ownerId: string, path: string, actorId: string, action: 'read' | 'delete'): Promise<void> {
  await db.prepare(
    'INSERT INTO storage_review_access (app_id, owner_id, path, actor_id, action, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(appId, ownerId, path, actorId, action, Date.now()).run();
}
