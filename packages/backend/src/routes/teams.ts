import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireAppAccess, TEAM_ROLES, type TeamRole, HttpError } from '../lib/auth.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const teamRoutes = new Hono<{ Bindings: Env }>();

/**
 * List team members for an app. Any team member can see the list.
 */
teamRoutes.get('/apps/:appId/team', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppAccess(c, appId, 'viewer');

    const { results } = await c.env.DB.prepare(
      'SELECT user_id, role, created_at FROM team_members WHERE app_id = ? ORDER BY created_at',
    )
      .bind(appId)
      .all<{ user_id: string; role: string; created_at: number }>();

    return c.json({ appId, members: results ?? [] });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Add or update a team member. Requires admin or owner role.
 */
teamRoutes.put('/apps/:appId/team/:userId', async (c) => {
  try {
    const appId = c.req.param('appId');
    const userId = c.req.param('userId');
    const user = await requireAppAccess(c, appId, 'admin');

    const body = await c.req.json<{ role?: string }>();
    const role = (body.role ?? 'viewer') as TeamRole;

    // Owner role can only be assigned via ownership transfer
    if (role === 'owner') {
      return c.text('Use ownership transfer to assign owner role', 400);
    }

    if (!TEAM_ROLES.includes(role)) {
      return c.text(`Invalid role. Must be one of: ${TEAM_ROLES.join(', ')}`, 400);
    }

    // Can't assign a role higher than your own
    if (TEAM_ROLES.indexOf(role) > TEAM_ROLES.indexOf(user.teamRole)) {
      return c.text(`Cannot assign ${role} role (you are ${user.teamRole})`, 403);
    }

    // Can't modify someone with equal or higher role (unless you're owner)
    const target = await c.env.DB.prepare(
      'SELECT role FROM team_members WHERE app_id = ? AND user_id = ?',
    ).bind(appId, userId).first<{ role: string }>();
    if (target && user.teamRole !== 'owner') {
      const targetLevel = TEAM_ROLES.indexOf(target.role as TeamRole);
      const userLevel = TEAM_ROLES.indexOf(user.teamRole);
      if (targetLevel >= userLevel) {
        return c.text(`Cannot modify a ${target.role} (you are ${user.teamRole})`, 403);
      }
    }

    await c.env.DB.prepare(
      `INSERT INTO team_members (app_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, user_id) DO UPDATE SET role = excluded.role`,
    )
      .bind(appId, userId, role, user.id, Date.now())
      .run();

    return c.json({ ok: true, appId, userId, role });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Remove a team member. Requires admin or owner role.
 * Cannot remove the last owner.
 */
teamRoutes.delete('/apps/:appId/team/:userId', async (c) => {
  try {
    const appId = c.req.param('appId');
    const userId = c.req.param('userId');
    const user = await requireAppAccess(c, appId, 'admin');

    const member = await c.env.DB.prepare(
      'SELECT role FROM team_members WHERE app_id = ? AND user_id = ?',
    )
      .bind(appId, userId)
      .first<{ role: string }>();

    if (!member) return c.text('Member not found', 404);

    // Can't remove someone with equal or higher role (unless you're owner)
    if (user.teamRole !== 'owner') {
      const targetLevel = TEAM_ROLES.indexOf(member.role as TeamRole);
      const userLevel = TEAM_ROLES.indexOf(user.teamRole);
      if (targetLevel >= userLevel) {
        return c.text(`Cannot remove a ${member.role} (you are ${user.teamRole})`, 403);
      }
    }

    // Prevent removing the last owner
    if (member.role === 'owner') {
      const ownerCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as c FROM team_members WHERE app_id = ? AND role = 'owner'",
      )
        .bind(appId)
        .first<{ c: number }>();
      if ((ownerCount?.c ?? 0) <= 1) {
        return c.text('Cannot remove the last owner. Transfer ownership first.', 400);
      }
    }

    await c.env.DB.prepare(
      'DELETE FROM team_members WHERE app_id = ? AND user_id = ?',
    )
      .bind(appId, userId)
      .run();

    return c.json({ ok: true, removed: userId });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Create an invite link. Returns a token that can be shared.
 * Requires admin or owner role.
 */
teamRoutes.post('/apps/:appId/team/invite', async (c) => {
  try {
    const appId = c.req.param('appId');
    const user = await requireAppAccess(c, appId, 'admin');

    const body = await c.req.json<{ role?: string; email?: string }>();
    const role = (body.role ?? 'viewer') as TeamRole;
    if (!TEAM_ROLES.includes(role) || role === 'owner') {
      return c.text(`Invalid invite role. Must be one of: ${TEAM_ROLES.filter(r => r !== 'owner').join(', ')}`, 400);
    }

    const id = crypto.randomUUID();
    const token = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days

    await c.env.DB.prepare(
      `INSERT INTO team_invites (id, app_id, role, invited_by, email, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, appId, role, user.id, body.email ?? null, token, expiresAt, Date.now())
      .run();

    return c.json({
      ok: true,
      inviteUrl: `https://console.proappstore.online/invite/${token}`,
      token,
      role,
      expiresAt,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Accept an invite. The signed-in user joins the team.
 */
teamRoutes.post('/team/accept/:token', async (c) => {
  try {
    const token = c.req.param('token');
    const user = await requireUser(c);

    const invite = await c.env.DB.prepare(
      'SELECT * FROM team_invites WHERE token = ?',
    )
      .bind(token)
      .first<{ id: string; app_id: string; role: string; expires_at: number; invited_by: string }>();

    if (!invite) return c.text('Invite not found', 404);
    if (invite.expires_at < Date.now()) {
      await c.env.DB.prepare('DELETE FROM team_invites WHERE id = ?').bind(invite.id).run();
      return c.text('Invite expired', 410);
    }

    // Add to team
    await c.env.DB.prepare(
      `INSERT INTO team_members (app_id, user_id, role, invited_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(app_id, user_id) DO UPDATE SET role = excluded.role`,
    )
      .bind(invite.app_id, user.id, invite.role, invite.invited_by, Date.now())
      .run();

    // Delete the invite
    await c.env.DB.prepare('DELETE FROM team_invites WHERE id = ?').bind(invite.id).run();

    return c.json({ ok: true, appId: invite.app_id, role: invite.role });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
