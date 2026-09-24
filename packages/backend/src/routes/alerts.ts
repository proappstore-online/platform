/**
 * Operational alerts for an app (#107): what the scheduled evaluator recorded,
 * an on-demand evaluation, and acknowledgement. Owner-only; the console renders
 * these in the per-app workspace (console#1).
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireAppOwner } from '../lib/auth.js';
import { evaluateErrorSpikes } from '../lib/error-alerts.js';

export const alertRoutes = new Hono<{ Bindings: Env }>();

interface AlertRow {
  id: number; app_id: string; kind: string; window_start: number; window_end: number; count: number; affected_users: number;
  baseline: number; top: string; build_meta: string | null; created_at: number; acknowledged_at: number | null; acknowledged_by: string | null;
}

const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s) as unknown; } catch { return null; } };
const view = (r: AlertRow) => ({ ...r, top: parse(r.top) ?? {}, build: parse(r.build_meta), build_meta: undefined });

// ── GET /v1/apps/:appId/alerts?since&limit&open ──────────────────
alertRoutes.get('/apps/:appId/alerts', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const since = Number(c.req.query('since') || Date.now() - 7 * 24 * 60 * 60_000);
  const limit = Math.min(Number(c.req.query('limit') || 50), 200);
  const openOnly = c.req.query('open') === '1';
  const rows = await c.env.DB.prepare(
    `SELECT id, app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at, acknowledged_at, acknowledged_by
     FROM app_alerts WHERE app_id = ? AND created_at >= ?${openOnly ? ' AND acknowledged_at IS NULL' : ''} ORDER BY created_at DESC LIMIT ?`,
  ).bind(appId, since, limit).all<AlertRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ alerts: (rows.results ?? []).map(view), since });
});

// ── POST /v1/apps/:appId/alerts/evaluate — run the evaluator for this app now ──
alertRoutes.post('/apps/:appId/alerts/evaluate', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const report = await evaluateErrorSpikes({ env: c.env, appId });
  return c.json(report);
});

// ── POST /v1/apps/:appId/alerts/:id/ack ───────────────────────────
alertRoutes.post('/apps/:appId/alerts/:id/ack', async (c) => {
  const appId = c.req.param('appId')!;
  const id = Number(c.req.param('id'));
  const user = await requireAppOwner(c, appId);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid alert id' }, 400);
  const res = await c.env.DB.prepare('UPDATE app_alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND app_id = ? AND acknowledged_at IS NULL')
    .bind(Date.now(), user.id, id, appId).run();
  if (!res.meta?.changes) return c.json({ error: 'alert not found or already acknowledged' }, 404);
  return c.json({ ok: true });
});
