/**
 * App log ingestion — receives client-side logs from the SDK logger.
 * Vendored from FAS (same schema, same endpoints).
 */

import { Hono } from 'hono';
import { HttpError, requireUser } from '../lib/auth.js';
import type { Env } from '../types.js';

export const logsRoutes = new Hono<{ Bindings: Env }>();

const MAX_BATCH_SIZE = 100;
const MAX_ENTRY_SIZE = 4096;

interface LogEntry {
  ts: number;
  level: string;
  category: string;
  message: string;
  data?: unknown;
  build?: Record<string, unknown>;
}

logsRoutes.post('/apps/:appId/logs', async (c) => {
  const user = await requireUser(c);
  const appId = c.req.param('appId')!;
  const body = await c.req.json<{ entries?: LogEntry[] }>().catch(() => null);
  if (!body?.entries || !Array.isArray(body.entries)) {
    throw new HttpError('entries array required', 400);
  }

  const entries = body.entries.slice(0, MAX_BATCH_SIZE);
  const now = Date.now();

  const stmt = c.env.DB.prepare(
    `INSERT INTO app_logs (app_id, user_id, ts, level, category, message, data, build_meta, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const batch = entries
    .filter(e => e.ts && e.level && e.message)
    .map(e => {
      const msg = String(e.message).slice(0, MAX_ENTRY_SIZE);
      const data = e.data ? JSON.stringify(e.data).slice(0, MAX_ENTRY_SIZE) : null;
      const build = e.build ? JSON.stringify(e.build) : null;
      return stmt.bind(appId, user.id, e.ts, e.level, e.category ?? 'app', msg, data, build, now);
    });

  if (batch.length > 0) {
    await c.env.DB.batch(batch);
  }

  return c.json({ ok: true, ingested: batch.length });
});

logsRoutes.get('/apps/:appId/logs', async (c) => {
  await requireUser(c);
  const appId = c.req.param('appId')!;

  const level = c.req.query('level');
  const category = c.req.query('category');
  const since = c.req.query('since');
  const limit = Math.min(Number(c.req.query('limit') || 100), 500);
  const userId = c.req.query('user_id');

  let sql = 'SELECT ts, level, category, message, data, user_id, build_meta FROM app_logs WHERE app_id = ?';
  const params: unknown[] = [appId];

  if (level) { sql += ' AND level = ?'; params.push(level); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (since) { sql += ' AND ts >= ?'; params.push(Number(since)); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }

  sql += ' ORDER BY ts DESC LIMIT ?';
  params.push(limit);

  const result = await c.env.DB.prepare(sql).bind(...params).all();

  return c.json({
    logs: (result.results ?? []).map((r: Record<string, unknown>) => {
      let data: unknown;
      let build: unknown;
      if (r.data) { try { data = JSON.parse(r.data as string); } catch { data = null; } }
      if (r.build_meta) { try { build = JSON.parse(r.build_meta as string); } catch { build = null; } }
      return {
        ts: r.ts,
        level: r.level,
        category: r.category,
        message: r.message,
        data,
        userId: r.user_id,
        build,
      };
    }),
  });
});

logsRoutes.get('/apps/:appId/logs/build', async (c) => {
  await requireUser(c);
  const appId = c.req.param('appId')!;

  const row = await c.env.DB.prepare(
    `SELECT build_meta, ts FROM app_logs
     WHERE app_id = ? AND build_meta IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  )
    .bind(appId)
    .first<{ build_meta: string; ts: number }>();

  if (!row) return c.json({ build: null });
  let build: unknown = null;
  try { build = JSON.parse(row.build_meta); } catch { /* corrupted JSON — return null */ }
  return c.json({ build, ts: row.ts });
});
