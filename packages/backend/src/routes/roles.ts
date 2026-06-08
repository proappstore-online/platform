import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireAppAccess, HttpError } from '../lib/auth.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * App-level RBAC endpoints. Vendored from FAS, adapted for PAS auth.
 *
 * Default roles (convention, not enforced at DB level):
 *   owner, member, moderator, editor, viewer
 * Custom roles: devs can assign any string as a role name.
 */
export const rolesRoutes = new Hono<{ Bindings: Env }>();

/** List all role assignments for an app. Requires admin-level app access. */
rolesRoutes.get('/apps/:appId/roles', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');

  const { results } = await c.env.DB.prepare(
    'SELECT user_id, role_name, granted_by, granted_at FROM app_roles WHERE app_id = ? ORDER BY granted_at',
  )
    .bind(appId)
    .all<{ user_id: string; role_name: string; granted_by: string | null; granted_at: number }>();

  const roles = (results ?? []).map((r) => ({
    userId: r.user_id,
    roleName: r.role_name,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
  }));

  return c.json({ roles });
});

/** Assign a role to a user. Requires admin-level app access. */
rolesRoutes.post('/apps/:appId/roles', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');

  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: string;
  } | null;

  if (!body?.userId || !body?.role) {
    return c.json({ error: 'userId and role are required' }, 400);
  }

  if (!/^[a-z][a-z0-9_-]{0,49}$/.test(body.role)) {
    return c.json(
      { error: 'role must be lowercase alphanumeric with hyphens/underscores, 1-50 chars' },
      400,
    );
  }

  if (body.role === 'owner') {
    return c.json({ error: "cannot assign 'owner' role — it is managed by the platform" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, body.userId, body.role, (await requireUser(c)).id)
    .run();

  return c.json({ ok: true, appId, userId: body.userId, role: body.role });
});

/** Revoke a role from a user. Requires admin-level app access. */
rolesRoutes.delete('/apps/:appId/roles', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');

  const body = (await c.req.json().catch(() => null)) as {
    userId?: string;
    role?: string;
  } | null;

  if (!body?.userId || !body?.role) {
    return c.json({ error: 'userId and role are required' }, 400);
  }

  if (body.role === 'owner') {
    return c.json({ error: "cannot revoke 'owner' role — transfer ownership instead" }, 400);
  }

  await c.env.DB.prepare('DELETE FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ?')
    .bind(appId, body.userId, body.role)
    .run();

  return c.json({ ok: true });
});

/** Check if the caller has a specific role in an app. */
rolesRoutes.get('/apps/:appId/roles/check/:role', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');
  const role = c.req.param('role');

  const tokenRoles = user.appRoles?.[appId] ?? [];
  if (tokenRoles.includes(role)) {
    return c.json({ has: true, source: 'token' });
  }

  const row = await c.env.DB.prepare(
    'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ? LIMIT 1',
  )
    .bind(appId, user.id, role)
    .first();

  return c.json({ has: row !== null, source: 'db' });
});

/** Get the current user's roles in this app. */
rolesRoutes.get('/apps/:appId/roles/me', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');

  const { results } = await c.env.DB.prepare(
    'SELECT role_name FROM app_roles WHERE app_id = ? AND user_id = ?',
  )
    .bind(appId, user.id)
    .all<{ role_name: string }>();

  return c.json({ roles: (results ?? []).map((r) => r.role_name) });
});

/** Ensure the current user has at least 'member' role. Idempotent. */
rolesRoutes.post('/apps/:appId/roles/ensure-member', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');

  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? LIMIT 1',
  )
    .bind(appId, user.id)
    .first();

  if (existing) return c.json({ ok: true, assigned: false });

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, 'member', NULL)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, user.id)
    .run();

  return c.json({ ok: true, assigned: true });
});
