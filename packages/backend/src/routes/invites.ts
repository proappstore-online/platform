import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireAppAccess, HttpError, TEAM_ROLES } from '../lib/auth.js';
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

/**
 * Create an invite. Requires developer-level app access.
 */
inviteRoutes.post('/apps/:appId/invites', async (c) => {
  try {
    const appId = c.req.param('appId');
    const user = await requireAppAccess(c, appId, 'developer');

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
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(role)) {
      return c.json(
        { error: 'role must be lowercase alphanumeric with hyphens/underscores, 1-50 chars' },
        400,
      );
    }
    if (role === 'owner') {
      return c.json({ error: "cannot invite with 'owner' role" }, 400);
    }
    // Prevent privilege escalation: an invite must not grant a platform team
    // role above the creator's own. Without this a 'developer' (who cannot
    // assign roles directly — that path requires 'admin') could mint an invite
    // granting 'admin' and hand out privileged, action-gating app roles.
    const invitedRank = TEAM_ROLES.indexOf(role as (typeof TEAM_ROLES)[number]);
    if (invitedRank > TEAM_ROLES.indexOf(user.teamRole)) {
      return c.json({ error: `cannot invite with a role above your own (${user.teamRole})` }, 403);
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
 * List active invites for an app. Requires developer-level app access.
 */
inviteRoutes.get('/apps/:appId/invites', async (c) => {
  try {
    const appId = c.req.param('appId');
    await requireAppAccess(c, appId, 'developer');

    const { results } = await c.env.DB.prepare(
      `SELECT id, code, role, group_id, metadata, max_uses, used_count, expires_at, created_by, created_at
       FROM invites WHERE app_id = ? ORDER BY created_at DESC`,
    ).bind(appId).all<{
      id: string; code: string; role: string; group_id: string | null;
      metadata: string | null; max_uses: number; used_count: number;
      expires_at: number; created_by: string; created_at: number;
    }>();

    const invites = (results ?? []).map((r) => ({
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

    return c.json({ invites });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Revoke (delete) an invite. Requires developer-level app access.
 */
inviteRoutes.delete('/apps/:appId/invites/:inviteId', async (c) => {
  try {
    const appId = c.req.param('appId');
    const inviteId = c.req.param('inviteId');
    await requireAppAccess(c, appId, 'developer');

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

    // Idempotency: if this user already redeemed THIS invite (role grant is
    // recorded with granted_by = invite:<id>), return success without burning
    // another use. Otherwise a single user calling redeem N times would exhaust
    // an N-use invite while gaining nothing after the first.
    const alreadyRedeemed = await c.env.DB.prepare(
      'SELECT 1 FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = ? AND granted_by = ? LIMIT 1',
    ).bind(invite.app_id, user.id, invite.role, `invite:${invite.id}`).first();
    if (alreadyRedeemed) {
      return c.json({ ok: true, role: invite.role, group: invite.group_id, alreadyRedeemed: true });
    }

    // Increment used_count atomically (only if still under limit)
    const upd = await c.env.DB.prepare(
      'UPDATE invites SET used_count = used_count + 1 WHERE id = ? AND used_count < max_uses',
    ).bind(invite.id).run();

    if (!upd.meta.changes) return c.json({ error: 'invite fully used' }, 410);

    // Assign role directly in PAS D1 (no FAS round-trip)
    await c.env.DB.prepare(
      `INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    ).bind(invite.app_id, user.id, invite.role, `invite:${invite.id}`).run();

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
