/** Owner-only history for the platform's scheduled registered actions (#123). */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner } from '../lib/auth.js';

export const scheduledRunsRoutes = new Hono<{ Bindings: Env }>();

interface RunRow {
  run_id: string;
  app_id: string;
  action_name: string;
  source: string;
  due_at: number;
  claimed_at: number | null;
  finished_at: number | null;
  status: string;
  changes: number | null;
  error: string | null;
}

scheduledRunsRoutes.get('/apps/:appId/scheduled-runs', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const requested = Number(c.req.query('limit') ?? 50);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
  const status = c.req.query('status');
  if (status && !['due', 'claimed', 'succeeded', 'failed'].includes(status)) return c.json({ error: 'invalid status' }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT run_id, app_id, action_name, source, due_at, claimed_at, finished_at, status, changes, error
     FROM scheduled_action_runs WHERE app_id = ?${status ? ' AND status = ?' : ''}
     ORDER BY due_at DESC LIMIT ?`,
  ).bind(appId, ...(status ? [status] : []), limit).all<RunRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ runs: rows.results ?? [] });
});
