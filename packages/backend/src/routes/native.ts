import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import { nativeBody, nativeCatalog, NATIVE_RETENTION_MS, nativeDevice, nativeGrants, nativePoints, nativeRandom } from '../lib/native-companion.js';

export const nativeRoutes = new Hono<{ Bindings: Env }>();
nativeRoutes.use('/native/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });

nativeRoutes.get('/native/me', async c => {
  const device = await nativeDevice(c);
  const user = await c.env.DB.prepare('SELECT id, login FROM users WHERE id = ?').bind(device.user_id).first<{ id: string; login: string }>();
  if (!user) throw new HttpError('Account no longer exists.', 401);
  const grants = await nativeGrants(c.env.DB, device.id);
  const apps = [];
  for (const a of await nativeCatalog()) {
    if (await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(a.id).first()) apps.push({ ...a, grant: grants.find(g => g.app_id === a.id) ?? null });
  }
  return c.json({ user: { id: user.id, name: user.login }, device: { id: device.id, label: device.label, expiresAt: device.expires_at }, apps });
});

nativeRoutes.put('/native/apps/:appId/location', async c => {
  const device = await nativeDevice(c);
  const appId = c.req.param('appId'), definition = (await nativeCatalog()).find(a => a.id === appId);
  if (!definition) throw new HttpError('This app has no reviewed native location capability.', 404);
  const body = await nativeBody(c);
  if (body.enabled !== true || body.version !== definition.version) throw new HttpError('Review the current location disclosure before enabling.', 400);
  const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  if (!app) throw new HttpError('App no longer exists.', 404);
  if (await c.env.DB.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, device.user_id).first()) {
    throw new HttpError('Your account in this app was deleted.', 403);
  }
  const current = (await nativeGrants(c.env.DB, device.id)).find(g => g.app_id === appId);
  if (current) return c.json({ grant: current });
  // Replace an obsolete grant; the FK removes its points. A new consent never adopts old queued points.
  const id = nativeRandom(), now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ?').bind(device.id, appId),
    c.env.DB.prepare(`INSERT INTO native_grants (id, device_id, app_id, publisher_id, capability, contract_version, consent_at)
      SELECT ?, ?, id, creator_id, 'location.background', ?, ? FROM apps WHERE id = ? AND creator_id = ?
      AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users x WHERE x.app_id = apps.id AND x.user_id = ?)`)
      .bind(id, device.id, definition.version, now, appId, app.creator_id, device.user_id),
  ]);
  const grant = (await nativeGrants(c.env.DB, device.id)).find(g => g.id === id);
  if (!grant) throw new HttpError('App changed. Review its disclosure again.', 409);
  return c.json({ grant });
});

nativeRoutes.delete('/native/apps/:appId/location', async c => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ?').bind(device.id, c.req.param('appId')).run();
  return c.json({ revoked: true });
});

nativeRoutes.delete('/native/device', async c => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_devices WHERE id = ?').bind(device.id).run();
  return c.json({ disconnected: true });
});

nativeRoutes.post('/native/locations', async c => {
  const device = await nativeDevice(c), now = Date.now();
  const quota = await c.env.DB.prepare(`INSERT INTO credential_login_attempts (login, window_start, count) VALUES (?1, ?2, 1)
    ON CONFLICT(login) DO UPDATE SET window_start = CASE WHEN ?2 - window_start >= 900000 THEN ?2 ELSE window_start END,
    count = CASE WHEN ?2 - window_start >= 900000 THEN 1 ELSE count + 1 END RETURNING count`)
    .bind(`native-upload:${device.id}`, now).first<{ count: number }>();
  if (!quota || quota.count > 200) throw new HttpError('Upload limit reached. Retry later.', 429);
  const body = await nativeBody(c, 80_000);
  const points = nativePoints(body.points, now);
  const grants = await nativeGrants(c.env.DB, device.id);
  const statements: D1PreparedStatement[] = [];
  for (const point of points) for (const grant of grants) {
    if (!point.grants.includes(grant.id) || point.at < grant.consent_at) continue;
    // Recheck consent and publisher AT THE WRITE, including a revocation concurrent with this request.
    statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy)
      SELECT g.id, ?, ?, ?, ?, ? FROM native_grants g JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
      JOIN native_devices d ON d.id = g.device_id
      WHERE g.id = ? AND g.device_id = ? AND g.contract_version = ? AND d.expires_at > ?`)
      .bind(point.id, point.at, point.lat, point.lng, point.accuracy, grant.id, device.id, grant.contract_version, now));
  }
  if (statements.length) await c.env.DB.batch(statements);
  // Revoked recipients are intentionally discarded, never retried into a subsequent grant.
  return c.json({ acknowledged: points.map(p => p.id) });
});

nativeRoutes.get('/apps/:appId/native/locations', async c => {
  c.header('Cache-Control', 'private, no-store');
  const user = await requireUser(c), appId = c.req.param('appId');
  const boundApp = c.req.header(APP_CONTEXT_HEADER) || user.credentialContext?.appId;
  if (boundApp !== appId) throw new HttpError('Read location through the authorized app.', 403);
  const definition = (await nativeCatalog()).find(a => a.id === appId);
  if (!definition) throw new HttpError('Native location is unavailable for this app.', 404);
  const after = Number(c.req.query('after') ?? '0'), afterId = c.req.query('afterId') ?? '';
  if (!Number.isSafeInteger(after) || after < 0 || afterId.length > 160) throw new HttpError('Invalid location cursor.', 400);
  // Composite cursor remains stable when several devices produce points at the same timestamp.
  const rows = await c.env.DB.prepare(`SELECT p.point_id AS id, p.grant_id AS grantId, p.recorded_at AS at,
    p.latitude AS lat, p.longitude AS lng, p.accuracy, p.grant_id || ':' || p.point_id AS cursorId
    FROM native_locations p JOIN native_grants g ON g.id = p.grant_id JOIN native_devices d ON d.id = g.device_id
    JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
    WHERE g.app_id = ? AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ? AND p.recorded_at >= ?
    AND (p.recorded_at > ? OR (p.recorded_at = ? AND p.grant_id || ':' || p.point_id > ?))
    ORDER BY p.recorded_at, cursorId LIMIT 500`).bind(appId, user.id, definition.version, Date.now(), Date.now() - NATIVE_RETENTION_MS, after, after, afterId).all();
  return c.json({ points: rows.results ?? [] });
});
