import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppAccess, requireUser, type FasUser, type TeamRole } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';

/**
 * Per-app account deletion (#379, stash#41). Apps are independent: deleting a
 * user's account in one app removes what the platform holds for that user in
 * THAT app only. The shared ProAppStore identity (users row, sign-in), the
 * platform subscription and every other app's data are untouched.
 *
 * Removed for (app, user):
 *   - R2: private files {app}/{uid}/, public uploads {app}/_public/u/{uid}/
 *     (including ones the app no longer references) and review uploads
 *     {app}/_review/u/{uid}/
 *   - D1: kv, app_roles, app_group_admin_grants, push_subscriptions, user_app_tokens
 * Kept: billing, usage, log and audit rows (retention is stash#29), and the
 * app's own per-app database, whose rows only the app understands — the app
 * deletes or anonymises those in its SDK delete handler before calling this.
 *
 * The user is then recorded in per_app_deleted_users so the app can refuse them.
 * Files go first and the marker last, so a partial failure is safe to retry.
 */
export const deleteAppAccountRoutes = new Hono<{ Bindings: Env }>();

/** The user themselves, or the app's team at `minRole` (platform admins included). */
async function authorize(c: Context<{ Bindings: Env }>, minRole: TeamRole): Promise<{ appId: string; userId: string; actor: FasUser }> {
  const appId = c.req.param('appId')!;
  const userId = c.req.param('userId')!;
  if (!userId || userId.includes('/')) throw new HttpError('invalid user id', 400);
  const user = await requireUser(c);
  if (user.id !== userId) return { appId, userId, actor: await requireAppAccess(c, appId, minRole) };
  if (!(await c.env.DB.prepare('SELECT 1 FROM apps WHERE id = ?').bind(appId).first())) throw new HttpError('app not found', 404);
  return { appId, userId, actor: user };
}

async function purgePrefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, ...(cursor && { cursor }) });
    if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
    deleted += listed.objects.length;
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return deleted;
}

/** Delete the user's account in this app. The user, or a team admin. */
deleteAppAccountRoutes.delete('/apps/:appId/users/:userId/account', wrap(async (c) => {
  const { appId, userId, actor } = await authorize(c, 'admin');

  let files = 0;
  for (const prefix of [`${appId}/${userId}/`, `${appId}/_public/u/${userId}/`, `${appId}/_review/u/${userId}/`]) {
    files += await purgePrefix(c.env.STORAGE, prefix);
  }

  const db = c.env.DB;
  const scoped = (table: string) => db.prepare(`DELETE FROM ${table} WHERE app_id = ? AND user_id = ?`).bind(appId, userId);
  await db.batch([
    ...['kv', 'app_roles', 'app_group_admin_grants', 'push_subscriptions', 'user_app_tokens'].map(scoped),
    db.prepare(
      `INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(app_id, user_id) DO UPDATE SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`,
    ).bind(appId, userId, actor.id, Date.now()),
  ]);

  return c.json({ ok: true, files });
}));

/** Whether the user has deleted their account in this app. The user, or any team member. */
deleteAppAccountRoutes.get('/apps/:appId/users/:userId/account', wrap(async (c) => {
  const { appId, userId } = await authorize(c, 'viewer');
  const row = await c.env.DB.prepare('SELECT deleted_at FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?')
    .bind(appId, userId).first<{ deleted_at: number }>();
  return c.json({ deleted: row !== null, deleted_at: row?.deleted_at ?? null });
}));

/**
 * The user's public uploads in this app, including ones the app no longer
 * references. The user, or a team admin (who can take one down with
 * DELETE /storage/_public/u/<uid>/<path>). `key` is the publicUrl path.
 */
deleteAppAccountRoutes.get('/apps/:appId/users/:userId/public-files', wrap(async (c) => {
  const { appId, userId } = await authorize(c, 'admin');
  const prefix = `${appId}/_public/`;
  const files: { key: string; size: number; uploaded: string }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await c.env.STORAGE.list({ prefix: `${prefix}u/${userId}/`, ...(cursor && { cursor }) });
    for (const obj of listed.objects) files.push({ key: obj.key.slice(prefix.length), size: obj.size, uploaded: obj.uploaded.toISOString() });
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return c.json({ files, count: files.length });
}));
