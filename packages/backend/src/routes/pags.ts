/**
 * ProAgentStore verifier trial (#456): the signed callback PAGS posts run-state events
 * to, and the owner's app → agent-instance binding. See docs/pags-verifier.md.
 *
 *   POST   /v1/pags/callback              signed (HMAC) run-state event from PAGS
 *   GET    /v1/apps/:appId/qa/pags        the app's binding (owner)
 *   PUT    /v1/apps/:appId/qa/pags        { instanceId, repo?, enabled? } (owner)
 *   DELETE /v1/apps/:appId/qa/pags        remove the binding (owner)
 */
import { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { pagsConfigured, verifyCallback } from '../lib/pags-client.js';
import { applyPagsEvent, parsePagsEvent } from '../lib/pags-runs.js';
import { privateNoStore, wrap } from '../lib/route-wrap.js';
import type { Env } from '../types.js';

export const pagsRoutes = new Hono<{ Bindings: Env }>();
pagsRoutes.use('/apps/:appId/qa/pags', privateNoStore);

const MAX_CALLBACK_BYTES = 16 * 1024;
const INSTANCE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

pagsRoutes.post('/pags/callback', async (c) => {
  if (Number(c.req.header('Content-Length') ?? 0) > MAX_CALLBACK_BYTES) return c.json({ error: 'body too large' }, 413);
  const raw = await c.req.text();
  if (raw.length > MAX_CALLBACK_BYTES) return c.json({ error: 'body too large' }, 413);
  // Verify before any parsing or database work: a bad or stale signature learns nothing.
  const verdict = await verifyCallback(c.env.PAGS_CALLBACK_SECRET, {
    timestamp: c.req.header('X-PAS-Timestamp') ?? null,
    signature: c.req.header('X-PAS-Signature') ?? null,
  }, raw);
  if (verdict === 'unconfigured') return c.json({ error: 'pags callbacks are not configured' }, 503);
  if (verdict !== 'ok') return c.json({ error: 'invalid signature' }, 401, { 'Cache-Control': 'no-store' });

  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: 'body must be JSON' }, 400); }
  const parsed = parsePagsEvent(body);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  const { event } = parsed;

  const run = await c.env.DB.prepare('SELECT run_id, engine, status FROM app_test_runs WHERE pags_job_id = ?1').bind(event.job_id).first<{ run_id: string; engine: string; status: string }>();
  if (!run) return c.json({ error: 'unknown job' }, 404);

  // Idempotent per job: an event id is applied once; a redelivery is a 200 that does nothing.
  const first = await c.env.DB.prepare('INSERT OR IGNORE INTO pags_callback_events (job_id, event_id, received_at) VALUES (?1, ?2, ?3)').bind(event.job_id, event.event_id, Date.now()).run();
  if (!first.meta?.changes) return c.json({ ok: true, duplicate: true });

  if (run.engine !== 'pags') return c.json({ ok: true, ignored: 'superseded: the run fell back to the headless executor' });
  const applied = await applyPagsEvent(c.env.DB, event.job_id, event, Date.now());
  return c.json({ ok: true, applied, ...(applied ? {} : { ignored: 'the run has finished' }) });
});

type BindingRow = { app_id: string; instance_id: string; repo: string | null; enabled: number; updated_by: string; updated_at: number };
const present = (b: BindingRow | null, env: Env) => ({
  // `configured`: this deployment holds the PAGS API URL, token and callback secret.
  // Without them a pags run falls back to the headless executor (pags_not_configured).
  configured: pagsConfigured(env),
  binding: b ? { instanceId: b.instance_id, repo: b.repo, enabled: b.enabled === 1, updatedBy: b.updated_by, updatedAt: b.updated_at } : null,
});

pagsRoutes.get('/apps/:appId/qa/pags', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const row = await c.env.DB.prepare('SELECT * FROM app_pags_bindings WHERE app_id = ?1').bind(appId).first<BindingRow>();
  return c.json(present(row, c.env));
}));

pagsRoutes.put('/apps/:appId/qa/pags', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireAppOwner(c, appId);
  const body = (await c.req.json().catch(() => null)) as { instanceId?: unknown; repo?: unknown; enabled?: unknown } | null;
  if (!body || typeof body.instanceId !== 'string' || !INSTANCE_RE.test(body.instanceId)) throw new HttpError('instanceId must be a ProAgentStore instance id (8-64 letters, digits, - or _)', 400);
  if (body.repo !== undefined && body.repo !== null && (typeof body.repo !== 'string' || !REPO_RE.test(body.repo))) throw new HttpError('repo must be owner/name', 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError('enabled must be a boolean', 400);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO app_pags_bindings (app_id, instance_id, repo, enabled, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(app_id) DO UPDATE SET instance_id = excluded.instance_id, repo = excluded.repo, enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(appId, body.instanceId, (body.repo as string | null | undefined) ?? null, body.enabled === false ? 0 : 1, user.id, now).run();
  const row = await c.env.DB.prepare('SELECT * FROM app_pags_bindings WHERE app_id = ?1').bind(appId).first<BindingRow>();
  return c.json(present(row, c.env));
}));

pagsRoutes.delete('/apps/:appId/qa/pags', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  await c.env.DB.prepare('DELETE FROM app_pags_bindings WHERE app_id = ?1').bind(appId).run();
  return c.json(present(null, c.env));
}));
