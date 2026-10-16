/**
 * Owner routes for reliability objectives, incidents and alert delivery (#395).
 * Every route is owner-only and private; lib/reliability.ts is the evaluator.
 *
 *   GET    /v1/apps/:appId/reliability/objectives
 *   PUT    /v1/apps/:appId/reliability/objectives/:family   { target, enabled? }
 *   DELETE /v1/apps/:appId/reliability/objectives/:family
 *   POST   /v1/apps/:appId/reliability/evaluate              dry run: assess, write and notify nothing;
 *                                                            body { objectives?, buckets? } evaluates a fixture
 *   GET    /v1/apps/:appId/reliability/incidents?open=1
 *   POST   /v1/apps/:appId/reliability/incidents/:id/ack
 *   GET    /v1/apps/:appId/reliability/deliveries            app.alert webhook attempts, failures and retries
 */

import { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { REQUEST_METRIC_FAMILIES } from '../lib/metric-aggregates.js';
import {
  ALERT_EVENT,
  assessAll,
  loadObjectives,
  readOutcomesFromAnalytics,
  type Objective,
  type OutcomeBucket,
  type OutcomeReader,
} from '../lib/reliability.js';
import { privateNoStore } from '../lib/route-wrap.js';
import type { Env } from '../types.js';

export const reliabilityRoutes = new Hono<{ Bindings: Env }>();
reliabilityRoutes.use('/apps/:appId/reliability/*', privateNoStore);

const MAX_FIXTURE_BUCKETS = 2000;
const familyOk = (f: string) => REQUEST_METRIC_FAMILIES.has(f);

reliabilityRoutes.get('/apps/:appId/reliability/objectives', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const rows = await c.env.DB.prepare(
    'SELECT family, target, enabled, updated_at FROM app_reliability_objectives WHERE app_id = ? ORDER BY family',
  ).bind(appId).all();
  return c.json({ objectives: rows.results ?? [], families: [...REQUEST_METRIC_FAMILIES] });
});

reliabilityRoutes.put('/apps/:appId/reliability/objectives/:family', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppOwner(c, appId);
  const family = c.req.param('family')!;
  if (!familyOk(family)) throw new HttpError('unknown operation family', 400);
  const body = await c.req.json<{ target?: unknown; enabled?: unknown }>().catch(() => null);
  const target = body?.target;
  if (typeof target !== 'number' || !(target >= 0.5 && target < 1)) throw new HttpError('target must be a number in [0.5, 1)', 400);
  const enabled = body?.enabled === undefined ? 1 : body.enabled === true ? 1 : body.enabled === false ? 0 : -1;
  if (enabled < 0) throw new HttpError('enabled must be a boolean', 400);
  await c.env.DB.prepare(
    `INSERT INTO app_reliability_objectives (app_id, family, target, enabled, updated_at, updated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(app_id, family) DO UPDATE SET target = excluded.target, enabled = excluded.enabled, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(appId, family, target, enabled, Date.now(), user.id).run();
  return c.json({ family, target, enabled: enabled === 1 });
});

reliabilityRoutes.delete('/apps/:appId/reliability/objectives/:family', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const res = await c.env.DB.prepare('DELETE FROM app_reliability_objectives WHERE app_id = ? AND family = ?').bind(appId, c.req.param('family')!).run();
  if (!res.meta?.changes) throw new HttpError('no such objective', 404);
  return c.json({ deleted: true });
});

/**
 * Dry run: what the evaluator would decide now, with nothing written and nothing
 * sent. With a body it evaluates a fixture instead of live telemetry —
 * `objectives` (default: this app's) and `buckets` ({family, start, total, bad}).
 */
reliabilityRoutes.post('/apps/:appId/reliability/evaluate', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const body = await c.req.json<{ objectives?: unknown; buckets?: unknown; now?: unknown }>().catch(() => null);
  const now = typeof body?.now === 'number' && Number.isFinite(body.now) ? body.now : Date.now();

  let objectives: Objective[];
  if (Array.isArray(body?.objectives)) {
    objectives = (body.objectives as { family?: unknown; target?: unknown }[]).flatMap((o) =>
      typeof o.family === 'string' && familyOk(o.family) && typeof o.target === 'number' && o.target >= 0.5 && o.target < 1
        ? [{ app: appId, family: o.family, target: o.target }] : []);
  } else {
    objectives = await loadObjectives(c.env.DB, appId);
  }

  let read: OutcomeReader = readOutcomesFromAnalytics;
  let source = 'analytics';
  if (Array.isArray(body?.buckets)) {
    if (body.buckets.length > MAX_FIXTURE_BUCKETS) throw new HttpError(`at most ${MAX_FIXTURE_BUCKETS} fixture buckets`, 400);
    const fixture: OutcomeBucket[] = (body.buckets as Record<string, unknown>[]).flatMap((b) =>
      typeof b.family === 'string' && typeof b.start === 'number' && typeof b.total === 'number' && typeof b.bad === 'number' && b.bad >= 0 && b.bad <= b.total
        ? [{ app: appId, family: b.family, start: b.start, total: b.total, bad: b.bad }] : []);
    read = async () => fixture;
    source = 'fixture';
  }
  const results = await assessAll(c.env, objectives, now, read);
  return c.json({ dryRun: true, source, evaluatedAt: now, results });
});

reliabilityRoutes.get('/apps/:appId/reliability/incidents', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const open = c.req.query('open') === '1';
  const rows = await c.env.DB.prepare(
    `SELECT id, rule, state, opened_at, last_seen_at, acknowledged_at, acknowledged_by, recovered_at, detail
       FROM app_incidents WHERE app_id = ?${open ? " AND state != 'recovered'" : ''} ORDER BY opened_at DESC LIMIT 100`,
  ).bind(appId).all<Record<string, unknown>>();
  return c.json({
    incidents: (rows.results ?? []).map((r) => {
      let detail: unknown = {};
      try { detail = JSON.parse(String(r.detail)); } catch { /* keep {} */ }
      return { ...r, detail };
    }),
  });
});

reliabilityRoutes.post('/apps/:appId/reliability/incidents/:id/ack', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppOwner(c, appId);
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) throw new HttpError('invalid incident id', 400);
  const res = await c.env.DB.prepare(
    "UPDATE app_incidents SET state = 'acknowledged', acknowledged_at = ?3, acknowledged_by = ?4 WHERE id = ?1 AND app_id = ?2 AND state = 'firing'",
  ).bind(id, appId, Date.now(), user.id).run();
  if (!res.meta?.changes) throw new HttpError('no firing incident with that id', 404);
  return c.json({ acknowledged: true });
});

/** The app's alert-webhook delivery log: attempts, last status and error, next retry. No payload, URL or secret. */
reliabilityRoutes.get('/apps/:appId/reliability/deliveries', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.event, d.status, d.attempts, d.last_attempt_at, d.next_attempt_at, d.last_error, d.created_at
       FROM webhook_deliveries d JOIN app_webhooks w ON w.id = d.webhook_id
      WHERE w.app_id = ? AND d.event = ? ORDER BY d.created_at DESC LIMIT 100`,
  ).bind(appId, ALERT_EVENT).all();
  return c.json({ deliveries: rows.results ?? [] });
});
