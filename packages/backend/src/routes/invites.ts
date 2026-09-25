import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireAppAccess, HttpError, TEAM_ROLES, type FasUser } from '../lib/auth.js';
import { generateQrSvg } from '../lib/qr.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const inviteRoutes = new Hono<{ Bindings: Env }>();

// 30-char alphabet — no ambiguous chars (0/O, 1/I/L)
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function generateCode(length = 6): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new HttpError('invalid duration format (e.g. 30m, 24h, 7d)', 400);
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * multipliers[unit]!;
}

interface CreateBody {
  role?: string;
  group?: string;
  metadata?: Record<string, unknown>;
  uses?: number;
  expiresIn?: string;
}

interface DelegatedPolicyBody {
  delegateRole?: string;
  grantableRole?: string;
}

interface GroupAdminBody {
  userId?: string;
  group?: string;
}

type InviteAccess =
  | { kind: 'team'; user: FasUser & { teamRole: (typeof TEAM_ROLES)[number] } }
  | { kind: 'delegated'; user: FasUser };

const ROLE_NAME = /^[a-z][a-z0-9_-]{0,49}$/;

function validRole(role: string): boolean {
  return ROLE_NAME.test(role) && role !== 'owner';
}

function validGroup(group: unknown): group is string {
  return typeof group === 'string' && group.trim().length > 0 && group.length <= 200;
}

/**
 * Team developers keep their historical, app-wide invite authority. Everyone
 * else must be a configured delegate; individual group grants are checked at
 * the operation that names or enumerates a group.
 */
async function inviteAccess(c: Parameters<typeof requireUser>[0], appId: string): Promise<InviteAccess> {
  try {
    return { kind: 'team', user: await requireAppAccess(c, appId, 'developer') };
  } catch (err) {
    // Keep an absent app a 404 and never turn an invalid session into a
    // delegation attempt. A team viewer may still be an explicitly delegated
    // app user, which is a separate authority by design.
    if (!(err instanceof HttpError) || err.status !== 403) throw err;
  }

  const user = await requireUser(c);
  const eligible = await c.env.DB.prepare(
    `SELECT 1
       FROM app_invite_policies p
       JOIN app_roles r ON r.app_id = p.app_id AND r.role_name = p.delegate_role
      WHERE p.app_id = ? AND (r.user_id = ? OR r.user_id = ?)
      LIMIT 1`,
  ).bind(appId, user.id, user.login).first();
  if (!eligible) throw new HttpError('invite delegation not granted', 403);
  return { kind: 'delegated', user };
}

async function delegatedGroups(env: Env, appId: string, user: FasUser): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT group_id FROM app_group_admin_grants
      WHERE app_id = ? AND user_id = ?
      ORDER BY group_id`,
  ).bind(appId, user.id).all<{ group_id: string }>();
  return (results ?? []).map((row) => row.group_id);
}

async function canDelegateRoleToGroup(
  env: Env,
  appId: string,
  user: FasUser,
  group: string,
  role: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1
       FROM app_group_admin_grants g
       JOIN app_invite_policies p ON p.app_id = g.app_id
       JOIN app_roles r ON r.app_id = p.app_id AND r.role_name = p.delegate_role
      WHERE g.app_id = ? AND g.group_id = ? AND g.user_id = ?
        AND p.grantable_role = ? AND (r.user_id = ? OR r.user_id = ?)
      LIMIT 1`,
  ).bind(appId, group, user.id, role, user.id, user.login).first();
  return row !== null;
}

/**
 * Create an invite. Team developers have app-wide access; configured delegates
 * require both their app role policy and a grant for the requested group.
 */
inviteRoutes.post('/apps/:appId/invites', async (c) => {
  try {
    const appId = c.req.param('appId');
    const access = await inviteAccess(c, appId);
    const user = access.user;

    const body = await c.req.json<CreateBody>().catch(() => ({} as CreateBody));
    const role = body.role ?? 'member';
    const group = body.group ?? null;
    const metadata = body.metadata ? JSON.stringify(body.metadata) : null;
    const maxUses = body.uses ?? 1;
    const expiresIn = body.expiresIn ?? '7d';

    if (maxUses < 1 || maxUses > 10000) {
      return c.json({ error: 'uses must be between 1 and 10000' }, 400);
    }
    // Same role-name shape the direct-assignment endpoint enforces.
    if (!ROLE_NAME.test(role)) {
      return c.json(
        { error: 'role must be lowercase alphanumeric with hyphens/underscores, 1-50 chars' },
        400,
      );
    }
    if (role === 'owner') {
      return c.json({ error: "cannot invite with 'owner' role" }, 400);
    }
    if (access.kind === 'team') {
      // Existing team-role escalation guard remains unchanged for the build
      // authority. Data-role delegates use explicit policy mappings below.
      const invitedRank = TEAM_ROLES.indexOf(role as (typeof TEAM_ROLES)[number]);
      if (invitedRank > TEAM_ROLES.indexOf(access.user.teamRole)) {
        return c.json({ error: `cannot invite with a role above your own (${access.user.teamRole})` }, 403);
      }
    } else {
      if (!validGroup(group)) {
        return c.json({ error: 'delegated invites require a non-empty group' }, 400);
      }
      if (!await canDelegateRoleToGroup(c.env, appId, user, group, role)) {
        return c.json({ error: 'not allowed to invite this role for this group' }, 403);
      }
    }

    const id = crypto.randomUUID();
    const code = generateCode();
    const expiresAt = Date.now() + parseDuration(expiresIn);

    await c.env.DB.prepare(
      `INSERT INTO invites (id, app_id, code, role, group_id, metadata, max_uses, used_count, expires_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(id, appId, code, role, group, metadata, maxUses, expiresAt, user.id, Date.now()).run();

    const link = `https://${appId}.proappstore.online/join/${code}`;
    const qr = generateQrSvg(link);

    return c.json({ id, code, link, qr, role, group, maxUses, usedCount: 0, expiresAt });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * List invites. Delegates see only their explicitly administered groups.
 */
inviteRoutes.get('/apps/:appId/invites', async (c) => {
  try {
    const appId = c.req.param('appId');
    const access = await inviteAccess(c, appId);

    if (access.kind === 'delegated') {
      const groups = await delegatedGroups(c.env, appId, access.user);
      if (!groups.length) return c.json({ invites: [] });
      const placeholders = groups.map(() => '?').join(', ');
      const { results } = await c.env.DB.prepare(
        `SELECT id, code, role, group_id, metadata, max_uses, used_count, expires_at, created_by, created_at
           FROM invites WHERE app_id = ? AND group_id IN (${placeholders}) ORDER BY created_at DESC`,
      ).bind(appId, ...groups).all<InviteRow>();
      return c.json({ invites: inviteList(appId, results ?? []) });
    }

    const { results } = await c.env.DB.prepare(
      `SELECT id, code, role, group_id, metadata, max_uses, used_count, expires_at, created_by, created_at
       FROM invites WHERE app_id = ? ORDER BY created_at DESC`,
    ).bind(appId).all<InviteRow>();

    return c.json({ invites: inviteList(appId, results ?? []) });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Revoke an invite. Delegates may revoke only within an administered group.
 */
inviteRoutes.delete('/apps/:appId/invites/:inviteId', async (c) => {
  try {
    const appId = c.req.param('appId');
    const inviteId = c.req.param('inviteId');
    const access = await inviteAccess(c, appId);

    if (access.kind === 'delegated') {
      const groups = await delegatedGroups(c.env, appId, access.user);
      if (!groups.length) return c.json({ error: 'invite not found' }, 404);
      const placeholders = groups.map(() => '?').join(', ');
      const result = await c.env.DB.prepare(
        `DELETE FROM invites WHERE id = ? AND app_id = ? AND group_id IN (${placeholders})`,
      ).bind(inviteId, appId, ...groups).run();
      if (!result.meta.changes) return c.json({ error: 'invite not found' }, 404);
      return c.json({ ok: true });
    }

    const result = await c.env.DB.prepare(
      'DELETE FROM invites WHERE id = ? AND app_id = ?',
    ).bind(inviteId, appId).run();

    if (!result.meta.changes) return c.json({ error: 'invite not found' }, 404);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Team-admin APIs for the platform-owned delegated-invite policy. */
inviteRoutes.get('/apps/:appId/invite-policies', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');
  const { results } = await c.env.DB.prepare(
    `SELECT delegate_role, grantable_role, created_by, created_at
       FROM app_invite_policies WHERE app_id = ?
      ORDER BY delegate_role, grantable_role`,
  ).bind(appId).all<{ delegate_role: string; grantable_role: string; created_by: string; created_at: number }>();
  return c.json({ policies: (results ?? []).map((row) => ({
    delegateRole: row.delegate_role, grantableRole: row.grantable_role,
    createdBy: row.created_by, createdAt: row.created_at,
  })) });
});

inviteRoutes.post('/apps/:appId/invite-policies', async (c) => {
  const appId = c.req.param('appId');
  const actor = await requireAppAccess(c, appId, 'admin');
  const body = await c.req.json<DelegatedPolicyBody>().catch(() => ({} as DelegatedPolicyBody));
  if (!validRole(body.delegateRole ?? '') || !validRole(body.grantableRole ?? '')) {
    return c.json({ error: 'delegateRole and grantableRole must be valid non-owner app roles' }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO app_invite_policies (app_id, delegate_role, grantable_role, created_by, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, delegate_role, grantable_role) DO NOTHING`,
  ).bind(appId, body.delegateRole, body.grantableRole, actor.id, Date.now()).run();
  return c.json({ ok: true, appId, delegateRole: body.delegateRole, grantableRole: body.grantableRole });
});

inviteRoutes.delete('/apps/:appId/invite-policies', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');
  const body = await c.req.json<DelegatedPolicyBody>().catch(() => ({} as DelegatedPolicyBody));
  if (!validRole(body.delegateRole ?? '') || !validRole(body.grantableRole ?? '')) {
    return c.json({ error: 'delegateRole and grantableRole must be valid non-owner app roles' }, 400);
  }
  const result = await c.env.DB.prepare(
    'DELETE FROM app_invite_policies WHERE app_id = ? AND delegate_role = ? AND grantable_role = ?',
  ).bind(appId, body.delegateRole, body.grantableRole).run();
  return c.json({ ok: true, revoked: Boolean(result.meta.changes) });
});

/** Team-admin APIs for assigning and revoking per-user group administration. */
inviteRoutes.get('/apps/:appId/group-admin-grants', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');
  const { results } = await c.env.DB.prepare(
    `SELECT user_id, group_id, granted_by, granted_at
       FROM app_group_admin_grants WHERE app_id = ?
      ORDER BY group_id, user_id`,
  ).bind(appId).all<{ user_id: string; group_id: string; granted_by: string; granted_at: number }>();
  return c.json({ grants: (results ?? []).map((row) => ({
    userId: row.user_id, group: row.group_id, grantedBy: row.granted_by, grantedAt: row.granted_at,
  })) });
});

inviteRoutes.post('/apps/:appId/group-admin-grants', async (c) => {
  const appId = c.req.param('appId');
  const actor = await requireAppAccess(c, appId, 'admin');
  const body = await c.req.json<GroupAdminBody>().catch(() => ({} as GroupAdminBody));
  const userId = body.userId?.trim();
  if (!userId || userId.length > 255 || !validGroup(body.group)) {
    return c.json({ error: 'userId and a non-empty group are required' }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO app_group_admin_grants (app_id, group_id, user_id, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT(app_id, group_id, user_id) DO NOTHING`,
  ).bind(appId, body.group, userId, actor.id, Date.now()).run();
  return c.json({ ok: true, appId, userId, group: body.group });
});

inviteRoutes.delete('/apps/:appId/group-admin-grants', async (c) => {
  const appId = c.req.param('appId');
  await requireAppAccess(c, appId, 'admin');
  const body = await c.req.json<GroupAdminBody>().catch(() => ({} as GroupAdminBody));
  const userId = body.userId?.trim();
  if (!userId || !validGroup(body.group)) {
    return c.json({ error: 'userId and a non-empty group are required' }, 400);
  }
  const result = await c.env.DB.prepare(
    'DELETE FROM app_group_admin_grants WHERE app_id = ? AND group_id = ? AND user_id = ?',
  ).bind(appId, body.group, userId).run();
  return c.json({ ok: true, revoked: Boolean(result.meta.changes) });
});

/**
 * Redeem an invite code. Any authenticated user.
 * Validates the code, increments used_count, assigns the role in PAS D1.
 */
inviteRoutes.post('/invites/:code/redeem', async (c) => {
  try {
    const code = c.req.param('code').toUpperCase();
    const user = await requireUser(c);

    const invite = await c.env.DB.prepare(
      'SELECT id, app_id, code, role, group_id, metadata, max_uses, used_count, expires_at FROM invites WHERE code = ?',
    ).bind(code).first<{
      id: string; app_id: string; code: string; role: string;
      group_id: string | null; metadata: string | null;
      max_uses: number; used_count: number; expires_at: number;
    }>();

    if (!invite) return c.json({ error: 'invite not found' }, 404);
    if (invite.expires_at < Date.now()) return c.json({ error: 'invite expired' }, 410);
    if (invite.used_count >= invite.max_uses) return c.json({ error: 'invite fully used' }, 410);

    // Backward-compatible idempotency for redemptions made before migration
    // 0054, followed by the durable per-invite redemption key introduced there.
    const alreadyRedeemed = await c.env.DB.prepare(
      `SELECT 1 FROM invite_redemptions WHERE invite_id = ? AND user_id = ?
       UNION ALL
       SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ? AND granted_by = ?
       LIMIT 1`,
    ).bind(invite.id, user.id, invite.app_id, user.id, invite.role, `invite:${invite.id}`).first();
    if (alreadyRedeemed) {
      return c.json({ ok: true, role: invite.role, group: invite.group_id, alreadyRedeemed: true });
    }

    // One conditional INSERT starts the transaction. Migration 0054's triggers
    // increment the use count and grant the role atomically with this row.
    const redeemed = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO invite_redemptions (invite_id, user_id, redeemed_at)
       SELECT id, ?, ? FROM invites
        WHERE id = ? AND expires_at >= ? AND used_count < max_uses`,
    ).bind(user.id, Date.now(), invite.id, Date.now()).run();
    if (!redeemed.meta.changes) return c.json({ error: 'invite no longer available' }, 410);

    return c.json({
      ok: true,
      role: invite.role,
      group: invite.group_id,
      metadata: invite.metadata ? JSON.parse(invite.metadata) : null,
      appId: invite.app_id,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

interface InviteRow {
  id: string; app_id: string; code: string; role: string; group_id: string | null;
  metadata: string | null; max_uses: number; used_count: number;
  expires_at: number; created_by: string; created_at: number;
}

function inviteList(appId: string, rows: InviteRow[]) {
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    link: `https://${appId}.proappstore.online/join/${r.code}`,
    role: r.role,
    group: r.group_id,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    expiresAt: r.expires_at,
    expired: r.expires_at < Date.now(),
    exhausted: r.used_count >= r.max_uses,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}
