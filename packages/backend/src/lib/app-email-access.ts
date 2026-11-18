import type { Env } from '../types.js';
import type { FasUser } from './auth.js';
import { roleSubjects } from './role-subject.js';

/**
 * Who may send email for an app: its owner, a platform admin, or a holder of the
 * `editor` app role. Shared by the legacy `/v1/email/send` and the verified-email routes.
 *
 * #121: the editor grant lives in `app_roles` (a session claim nothing populated made
 * this branch dead once). Rows may be keyed by user id OR a GitHub login, so the lookup
 * binds both: roleSubjects (#272) gives the login for GitHub sessions only, never a
 * credential/Google display name.
 */
export async function appEmailAccess(env: Pick<Env, 'DB'>, user: FasUser, appId: string): Promise<'ok' | 'not_found' | 'forbidden'> {
  const app = await env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?1').bind(appId).first<{ creator_id: string }>();
  if (!app) return 'not_found';
  if (app.creator_id === user.id || user.roles.includes('admin')) return 'ok';
  const row = await env.DB.prepare(
    `SELECT 1 FROM app_roles
      WHERE app_id = ? AND (user_id = ? OR user_id = ?) AND role_name = 'editor'
      LIMIT 1`,
  ).bind(appId, ...roleSubjects(user)).first();
  return row !== null ? 'ok' : 'forbidden';
}
