/**
 * #437: the deploy pipeline reports the browser permissions it detected in the
 * app's source (app-deploy.yml, @proappstore/compliance detectPermissions), keyless
 * with the workflow's GitHub OIDC token, like every other deploy step. Declared
 * permissions register with mcp.json (routes/tools.ts); the storefront listing
 * shows both (routes/listings.ts).
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { requireAppDeployOidc } from '../lib/app-deploy-oidc.js';
import { validateDetected } from '../lib/app-permissions.js';

export const appPermissionRoutes = new Hono<{ Bindings: Env }>();

appPermissionRoutes.post('/apps/:appId/permissions/detected', async (c) => {
  const appId = c.req.param('appId');
  await requireAppDeployOidc(c, appId);
  const body = await c.req.json<{ permissions?: unknown }>().catch(() => null);
  const result = validateDetected(body?.permissions);
  if ('error' in result) throw new HttpError(result.error, 400);
  const now = Date.now();
  const stored = await c.env.DB.prepare(
    `INSERT INTO app_permissions (app_id, detected_json, detected_at)
     SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM apps WHERE id = ?1)
     ON CONFLICT(app_id) DO UPDATE SET detected_json = excluded.detected_json, detected_at = excluded.detected_at`,
  ).bind(appId, JSON.stringify(result.detected), now).run();
  if (!stored.meta?.changes) throw new HttpError('app not found', 404);
  return c.json({ ok: true, app: appId, detected: result.detected });
});
