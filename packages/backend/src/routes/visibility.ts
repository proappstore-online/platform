import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppOwner, requireUser, type FasUser } from '../lib/auth.js';
import { getAppVisibility, visibilityAllows } from '../lib/visibility.js';

export const visibilityRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/apps/:appId/visibility — the app's declared visibility for its owner
 * (#261): `{ mode, allowed_roles }`, the app roles whose holders may use a
 * private app besides the owner (empty for a public app). Owner or platform
 * admin only; an app with no record is a 404 for both. Visitors ask `/me`.
 */
visibilityRoutes.get('/apps/:appId/visibility', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  // requireAppOwner admits a platform admin before it looks the app up.
  if (!(await c.env.DB.prepare('SELECT 1 AS found FROM apps WHERE id = ?').bind(appId).first())) throw new HttpError('app not found', 404);
  const visibility = await getAppVisibility(c.env.DB, appId);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ mode: visibility.mode, allowed_roles: visibility.roles });
});

/**
 * GET /v1/apps/:appId/visibility/me — may the caller use this app? (#259)
 *
 * Asked by the host before it serves any part of a private app's origin, and by
 * the per-app MCP before a session on one. `roles/me` cannot answer it: it does
 * not report ownership, and the owner always passes.
 *
 * Signed out → `{ mode, allowed }` with allowed true only for a public app. A
 * bearer that is present but invalid is a 401, never "signed out": the host
 * clears the cookie and sends the visitor to sign in on that answer.
 */
visibilityRoutes.get('/apps/:appId/visibility/me', async (c) => {
  const appId = c.req.param('appId');
  const user: FasUser | null = c.req.header('Authorization') ? await requireUser(c) : null;
  const visibility = await getAppVisibility(c.env.DB, appId);
  const allowed = await visibilityAllows(c.env, appId, visibility, user);
  // Per-caller: no cache layer may hand one caller's answer to another.
  c.header('Cache-Control', 'private, no-store');
  return c.json({ mode: visibility.mode, allowed });
});
