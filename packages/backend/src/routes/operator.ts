/**
 * Console operator view (#240): the owner-only context for one owned app — the
 * baseline the platform already has, plus the app's declared operator-view
 * contract (child 2, lib/operator-contract.ts) when it registered one. The
 * console renders both generically; it runs the contract's resources and
 * actions through the ordinary actions route, never through this one.
 *
 * Owner-only via requireAppOwner (creator, a team `owner`, or a platform
 * admin). Another app's owner, a lesser team role, and a signed-out caller are
 * refused before any app data is read.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner } from '../lib/auth.js';
import type { OperatorViewContract } from '../lib/operator-contract.js';

export const operatorRoutes = new Hono<{ Bindings: Env }>();

const ACTIVITY_DAYS = 30;

operatorRoutes.get('/apps/:appId/operator', async (c) => {
  const appId = c.req.param('appId');
  const operator = await requireAppOwner(c, appId);

  const since = new Date(Date.now() - (ACTIVITY_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const [app, roles, activity, view] = await Promise.all([
    c.env.DB.prepare('SELECT id, created_at FROM apps WHERE id = ?').bind(appId).first<{ id: string; created_at: number }>(),
    c.env.DB.prepare('SELECT COUNT(DISTINCT user_id) AS users FROM app_roles WHERE app_id = ?')
      .bind(appId).first<{ users: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS users,
              COALESCE(SUM(session_seconds), 0) AS session_seconds,
              COALESCE(SUM(api_calls), 0) AS api_calls
         FROM usage_daily WHERE app_id = ? AND day >= ?`,
    ).bind(appId, since).first<{ users: number; session_seconds: number; api_calls: number }>(),
    c.env.DB.prepare('SELECT contract FROM app_operator_view WHERE app_id = ?').bind(appId).first<{ contract: string }>(),
  ]);

  // Stored only after validation; an unreadable row falls back to the baseline.
  let contract: OperatorViewContract | null = null;
  try {
    contract = view ? (JSON.parse(view.contract) as OperatorViewContract) : null;
  } catch {
    console.error('[operator] unreadable operator_view contract', { appId });
  }

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    app: { id: appId, createdAt: app?.created_at ?? null },
    operator: { userId: operator.id, login: operator.login },
    baseline: {
      usersWithRoles: Number(roles?.users ?? 0),
      activity: {
        days: ACTIVITY_DAYS,
        activeUsers: Number(activity?.users ?? 0),
        sessionSeconds: Number(activity?.session_seconds ?? 0),
        apiCalls: Number(activity?.api_calls ?? 0),
      },
    },
    contract,
  });
});
