import { Hono } from 'hono';
import { requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

const MAX_COUNTERS_PER_APP = 1000;
const MAX_KEY_LENGTH = 128;
const MAX_INCREMENT = 1000;

export const counterRoutes = new Hono<{ Bindings: Env }>();

counterRoutes.get('/apps/:appId/counters', async (c) => {
  const { appId } = c.req.param();
  const prefix = c.req.query('prefix');
  let query: string;
  let bindings: unknown[];
  if (prefix) {
    query = 'SELECT key, value FROM counters WHERE app_id = ? AND key LIKE ? ORDER BY key';
    bindings = [appId, `${prefix}%`];
  } else {
    query = 'SELECT key, value FROM counters WHERE app_id = ? ORDER BY key';
    bindings = [appId];
  }
  const { results } = await c.env.DB.prepare(query).bind(...bindings).all<{ key: string; value: number }>();
  return c.json(Object.fromEntries(results.map((r) => [r.key, r.value])));
});

counterRoutes.get('/apps/:appId/counters/:key', async (c) => {
  const { appId, key } = c.req.param();
  const row = await c.env.DB.prepare('SELECT value FROM counters WHERE app_id = ? AND key = ?')
    .bind(appId, key).first<{ value: number }>();
  if (!row) return c.json({ value: 0 });
  return c.json({ value: row.value });
});

counterRoutes.post('/apps/:appId/counters/:key', async (c) => {
  await requireUser(c);
  const { appId, key } = c.req.param();
  if (key.length > MAX_KEY_LENGTH) return c.text(`counter key exceeds ${MAX_KEY_LENGTH} chars`, 400);

  const body = await c.req.json<{ increment?: number }>().catch(() => ({ increment: 1 }));
  const increment = body.increment ?? 1;
  if (!Number.isInteger(increment) || Math.abs(increment) > MAX_INCREMENT) {
    return c.text(`increment must be integer between -${MAX_INCREMENT} and +${MAX_INCREMENT}`, 400);
  }

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS cnt FROM counters WHERE app_id = ?')
    .bind(appId).first<{ cnt: number }>();
  if ((count?.cnt ?? 0) >= MAX_COUNTERS_PER_APP) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM counters WHERE app_id = ? AND key = ?')
      .bind(appId, key).first();
    if (!exists) return c.text(`max ${MAX_COUNTERS_PER_APP} counters per app`, 413);
  }

  await c.env.DB.prepare(
    `INSERT INTO counters (app_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, key) DO UPDATE SET value = counters.value + excluded.value, updated_at = excluded.updated_at`,
  ).bind(appId, key, increment, Date.now()).run();

  const row = await c.env.DB.prepare('SELECT value FROM counters WHERE app_id = ? AND key = ?')
    .bind(appId, key).first<{ value: number }>();
  return c.json({ value: row?.value ?? increment });
});
