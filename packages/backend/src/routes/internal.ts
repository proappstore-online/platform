import { Hono } from 'hono';
import type { Env } from '../types.js';
import { internalTokenOk } from '@proappstore/build-core';
import { checkSessionKeyDrift } from '../lib/session-key-drift.js';

export const internalRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /internal/session-key-drift — the #70 drift check, on demand (the cron runs the
 * same function). Internal-token only: the report names apps and the fan-out state.
 * Moved here from the archived payout cron (#381).
 */
internalRoutes.get('/internal/session-key-drift', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const report = await checkSessionKeyDrift({ env: c.env });
  return c.json(report, report.ok ? 200 : 503);
});
