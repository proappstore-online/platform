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
    `SELECT r.user_id, r.role_name, r.granted_by, r.granted_at,
            target.login AS user_login, target.avatar_url AS user_avatar_url,
            granter.login AS granted_by_login, granter.avatar_url AS granted_by_avatar_url
       FROM app_roles r
       LEFT JOIN users target ON target.id = r.user_id
       LEFT JOIN users granter ON granter.id = r.granted_by
      WHERE r.app_id = ?
      ORDER BY r.granted_at`,
  )
    .bind(appId)
    .all<{
      user_id: string;
      role_name: string;
      granted_by: string | null;
      granted_at: number;
      user_login: string | null;
      user_avatar_url: string | null;
      granted_by_login: string | null;
      granted_by_avatar_url: string | null;
    }>();

  const roles = (results ?? []).map((r) => ({
    userId: r.user_id,
    roleName: r.role_name,
    grantedBy: r.granted_by,
    grantedAt: r.granted_at,
    userLogin: r.user_login,
    userAvatarUrl: r.user_avatar_url,
    grantedByLogin: r.granted_by_login,
    grantedByAvatarUrl: r.granted_by_avatar_url,
  }));

  return c.json({ roles });
});

/** Assign a role to a user. Requires admin-level app access. */
rolesRoutes.post('/apps/:appId/roles', async (c) => {
  const appId = c.req.param('appId');
  const actor = await requireAppAccess(c, appId, 'admin');

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

  const target = await resolveRoleUser(c.env, body.userId);

  if (target.login && target.login !== target.id) {
    await c.env.DB.prepare('DELETE FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ?')
      .bind(appId, target.login, body.role)
      .run();
  }

  await c.env.DB.prepare(
    `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, user_id, role_name) DO NOTHING`,
  )
    .bind(appId, target.id, body.role, actor.id)
    .run();

  return c.json({ ok: true, appId, userId: target.id, userLogin: target.login, userAvatarUrl: target.avatarUrl, role: body.role });
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

  // Assignments are stored under the canonical id (e.g. gh:12345), so revoking
  // by login must resolve first — otherwise DELETE ... WHERE user_id = 'octocat'
  // matches nothing and the role silently survives. Match id OR login to also
  // clear any legacy login-keyed rows.
  const target = await resolveRoleUser(c.env, body.userId);
  const result = await c.env.DB.prepare(
    'DELETE FROM app_roles WHERE app_id = ? AND user_id IN (?, ?) AND role_name = ?',
  )
    .bind(appId, target.id, target.login ?? target.id, body.role)
    .run();

  const revoked = (result.meta.changes ?? 0) > 0;
  return c.json({ ok: true, revoked, userId: target.id, role: body.role });
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
    'SELECT 1 FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?) AND role_name = ? LIMIT 1',
  )
    .bind(appId, user.id, user.login, role)
    .first();

  return c.json({ has: row !== null, source: 'db' });
});

/** Get the current user's roles in this app. */
rolesRoutes.get('/apps/:appId/roles/me', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');

  const { results } = await c.env.DB.prepare(
    'SELECT role_name FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?)',
  )
    .bind(appId, user.id, user.login)
    .all<{ role_name: string }>();

  return c.json({ roles: (results ?? []).map((r) => r.role_name) });
});

/** Ensure the current user has at least 'member' role. Idempotent. */
rolesRoutes.post('/apps/:appId/roles/ensure-member', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId');

  const existing = await c.env.DB.prepare(
    'SELECT 1 FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?) LIMIT 1',
  )
    .bind(appId, user.id, user.login)
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

interface ResolvedRoleUser {
  id: string;
  login: string | null;
  avatarUrl: string | null;
}

async function resolveRoleUser(env: Env, input: string): Promise<ResolvedRoleUser> {
  const raw = input.trim();
  if (!raw) throw new HttpError('userId is required', 400);

  if (/^[a-z]+:.+/.test(raw) && !raw.startsWith('gh:')) {
    return { id: raw, login: null, avatarUrl: null };
  }

  const githubId = raw.match(/^gh:(\d+)$/)?.[1] ?? (raw.match(/^\d+$/) ? raw : null);
  if (githubId) {
    const existing = await userById(env, `gh:${githubId}`);
    if (existing) return existing;
    const gh = await fetchGithubUser(`https://api.github.com/user/${encodeURIComponent(githubId)}`);
    await upsertGithubUser(env, gh);
    return { id: `gh:${gh.id}`, login: gh.login, avatarUrl: gh.avatar_url ?? null };
  }

  const login = raw.replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) {
    throw new HttpError('userId must be a PAS UID, GitHub login, or numeric GitHub ID', 400);
  }

  const existing = await userByGithubLogin(env, login);
  if (existing) return existing;

  const gh = await fetchGithubUser(`https://api.github.com/users/${encodeURIComponent(login)}`);
  await upsertGithubUser(env, gh);
  return { id: `gh:${gh.id}`, login: gh.login, avatarUrl: gh.avatar_url ?? null };
}

async function userById(env: Env, id: string): Promise<ResolvedRoleUser | null> {
  const row = await env.DB.prepare('SELECT id, login, avatar_url FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: string; login: string | null; avatar_url: string | null }>();
  return row ? { id: row.id, login: row.login, avatarUrl: row.avatar_url } : null;
}

async function userByGithubLogin(env: Env, login: string): Promise<ResolvedRoleUser | null> {
  const row = await env.DB.prepare(
    'SELECT id, login, avatar_url FROM users WHERE provider = ? AND LOWER(login) = LOWER(?) LIMIT 1',
  )
    .bind('github', login)
    .first<{ id: string; login: string | null; avatar_url: string | null }>();
  return row ? { id: row.id, login: row.login, avatarUrl: row.avatar_url } : null;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url?: string | null;
}

async function fetchGithubUser(url: string): Promise<GitHubUser> {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'proappstore-api' },
  });
  if (res.status === 404) throw new HttpError('GitHub user not found', 404);
  if (!res.ok) throw new HttpError(`GitHub lookup failed (${res.status})`, 502);
  const user = (await res.json()) as Partial<GitHubUser>;
  if (!user.id || !user.login) throw new HttpError('GitHub lookup returned an invalid user', 502);
  return { id: user.id, login: user.login, avatar_url: user.avatar_url ?? null };
}

async function upsertGithubUser(env: Env, user: GitHubUser): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, provider, provider_id, login, email, avatar_url, created_at, last_login_at)
     VALUES (?1, 'github', ?2, ?3, NULL, ?4, ?5, ?5)
     ON CONFLICT(id) DO UPDATE SET
       login = excluded.login,
       avatar_url = excluded.avatar_url`,
  )
    .bind(`gh:${user.id}`, String(user.id), user.login, user.avatar_url ?? null, now)
    .run();
}
