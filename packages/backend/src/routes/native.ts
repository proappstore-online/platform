import { Hono, type Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import {
  nativeBody, nativeCatalog, nativeEntry, NATIVE_CAPABILITIES, NATIVE_HEART_RATE, NATIVE_HEART_RATE_SCOPE, NATIVE_LOCATION, NATIVE_LOCATION_SCOPE,
  nativeDevice, nativeGrants, nativeHeartRateSamples, nativePoints, nativeRandom, nativeRelayOf,
} from '../lib/native-companion.js';
import { armNativeRelay } from '../lib/native-relay.js';
import { claimAttempt } from '../lib/credential-rate-limit.js';

export const nativeRoutes = new Hono<{ Bindings: Env }>();
nativeRoutes.use('/native/*', async (c, next) => { c.header('Cache-Control', 'private, no-store'); await next(); });

nativeRoutes.get('/native/me', async c => {
  const device = await nativeDevice(c);
  const user = await c.env.DB.prepare('SELECT id, login FROM users WHERE id = ?').bind(device.user_id).first<{ id: string; login: string }>();
  if (!user) throw new HttpError('Account no longer exists.', 401);
  await recordDeviceSeen(c.env.DB, device.id, c.req.header(NATIVE_CLIENT_HEADER), Date.now());
  const grants = await nativeGrants(c.env.DB, device.id);
  // ADR-018 §7: `apps` stays location entries only, in the shape shipped clients decode; `capabilities` lists every entry.
  const apps = [], capabilities = [], catalog = await nativeCatalog(), ids = [...new Set(catalog.map(a => a.id))];
  // One lookup for the whole catalog (#683): this runs on every sync of every connected phone.
  const existing = await c.env.DB.prepare(`SELECT id FROM apps WHERE id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all<{ id: string }>();
  const live = new Set((existing.results ?? []).map(r => r.id));
  for (const a of catalog) {
    if (!live.has(a.id)) continue;
    const found = grants.find(g => g.app_id === a.id && g.capability === a.capability), grant = found ? publicGrant(found) : null;
    if (a.capability === NATIVE_LOCATION) apps.push({ ...a, grant });
    capabilities.push({ appId: a.id, appName: a.name, capability: a.capability, name: NATIVE_CAPABILITIES[a.capability].name,
      purpose: a.purpose, disclosure: a.disclosure, version: a.version, grant });
  }
  return c.json({ user: { id: user.id, name: user.login }, device: { id: device.id, label: device.label, expiresAt: device.expires_at }, apps, capabilities });
});

/** `ios/1.4.0 (57)` or `android/1.4.0 (57)`, sent by both clients on every `/native/*` request (#660). */
const NATIVE_CLIENT_HEADER = 'X-PAS-Native-Client';
const NATIVE_CLIENT = /^(ios|android)\/([0-9A-Za-z.+-]{1,32}( \([0-9]{1,10}\))?)$/;

/**
 * Device facts for the user's own device list (#660): platform, app version, and when it last synced (`/native/me` runs on
 * every sync). Device metadata, not diagnostics, so recorded with diagnostics off too. At most one write a minute unless the
 * version changed; a shipped client without the header records the time only.
 */
async function recordDeviceSeen(db: D1Database, deviceId: string, header: string | undefined, now: number) {
  const client = header ? NATIVE_CLIENT.exec(header) : null;
  await (client
    ? db.prepare(`UPDATE native_devices SET platform = ?, app_version = ?, last_seen_at = ?
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ? OR app_version IS NOT ? OR platform IS NOT ?)`)
      .bind(client[1], client[2], now, deviceId, now - 60_000, client[2], client[1])
    : db.prepare('UPDATE native_devices SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)').bind(now, deviceId, now - 60_000)
  ).run();
}

// The grant as the native API has always returned it; the capability is implied by where it is listed.
function publicGrant({ capability, ...grant }: Awaited<ReturnType<typeof nativeGrants>>[number]) { void capability; return grant; }

async function enableCapability(c: Context<{ Bindings: Env }>, capability: string) {
  const device = await nativeDevice(c);
  const appId = c.req.param('appId')!, definition = await nativeEntry(appId, capability);
  const kind = capability === NATIVE_LOCATION ? 'location ' : ''; // the location wording shipped clients already show
  if (!definition) throw new HttpError(`This app has no reviewed native ${kind}capability.`, 404);
  const body = await nativeBody(c);
  if (body.enabled !== true || body.version !== definition.version) throw new HttpError(`Review the current ${kind}disclosure before enabling.`, 400);
  const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  if (!app) throw new HttpError('App no longer exists.', 404);
  if (await c.env.DB.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, device.user_id).first()) {
    throw new HttpError('Your account in this app was deleted.', 403);
  }
  const current = (await nativeGrants(c.env.DB, device.id)).find(g => g.app_id === appId && g.capability === definition.capability);
  if (current) return c.json({ grant: publicGrant(current) });
  // Replace an obsolete grant for THIS capability only; the FK removes its points. A new consent never adopts old queued points.
  // Only an obsolete grant is deleted (#683): a current one inserted by a concurrent enable is the same user's consent to the
  // same reviewed version moments earlier, so it is kept (INSERT OR IGNORE) and answered, not replaced under the first caller.
  // The capability is bound from the reviewed entry, never from the request (ADR-018 §3).
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ? AND capability = ? AND (contract_version <> ? OR publisher_id <> ?)')
      .bind(device.id, appId, definition.capability, definition.version, app.creator_id),
    c.env.DB.prepare(`INSERT OR IGNORE INTO native_grants (id, device_id, app_id, publisher_id, capability, contract_version, consent_at)
      SELECT ?, ?, id, creator_id, ?, ?, ? FROM apps WHERE id = ? AND creator_id = ?
      AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users x WHERE x.app_id = apps.id AND x.user_id = ?)`)
      .bind(nativeRandom(), device.id, definition.capability, definition.version, now, appId, app.creator_id, device.user_id),
  ]);
  const grant = (await nativeGrants(c.env.DB, device.id)).find(g => g.app_id === appId && g.capability === definition.capability);
  if (!grant) throw new HttpError('App changed. Review its disclosure again.', 409);
  return c.json({ grant: publicGrant(grant) });
}

async function revokeCapability(c: Context<{ Bindings: Env }>, capability: string) {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_grants WHERE device_id = ? AND app_id = ? AND capability = ?').bind(device.id, c.req.param('appId'), capability).run();
  return c.json({ revoked: true });
}

// The location paths shipped clients call, unchanged.
nativeRoutes.put('/native/apps/:appId/location', c => enableCapability(c, NATIVE_LOCATION));
nativeRoutes.delete('/native/apps/:appId/location', c => revokeCapability(c, NATIVE_LOCATION));
nativeRoutes.put('/native/apps/:appId/capabilities/:capability', c => enableCapability(c, c.req.param('capability')));
nativeRoutes.delete('/native/apps/:appId/capabilities/:capability', c => revokeCapability(c, c.req.param('capability')));

nativeRoutes.delete('/native/device', async c => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_devices WHERE id = ?').bind(device.id).run();
  return c.json({ disconnected: true });
});

/** 200 uploads per 15 minutes per device, counted separately under each upload's key (diagnostics too, #660). */
export async function uploadQuota(db: D1Database, key: string, now: number) {
  if (!await claimAttempt(db, key, now, 200)) throw new HttpError('Upload limit reached. Retry later.', 429);
}

nativeRoutes.post('/native/locations', async c => {
  const device = await nativeDevice(c), now = Date.now();
  await uploadQuota(c.env.DB, `native-upload:${device.id}`, now);
  const body = await nativeBody(c, 80_000);
  const points = nativePoints(body.points, now);
  // Only location grants: a point naming another capability's grant would only build an INSERT the recheck discards.
  const grants = (await nativeGrants(c.env.DB, device.id)).filter(g => g.capability === NATIVE_LOCATION);
  const statements: D1PreparedStatement[] = [], statementApps: string[] = [];
  for (const point of points) for (const grant of grants) {
    if (!point.grants.includes(grant.id) || point.at < grant.consent_at) continue;
    // Recheck consent and publisher AT THE WRITE, including a revocation concurrent with this request.
    statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy)
      SELECT g.id, ?, ?, ?, ?, ? FROM native_grants g JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
      JOIN native_devices d ON d.id = g.device_id
      WHERE g.id = ? AND g.device_id = ? AND g.capability = 'location.background' AND g.contract_version = ? AND d.expires_at > ?`)
      .bind(point.id, point.at, point.lat, point.lng, point.accuracy, grant.id, device.id, grant.contract_version, now));
    statementApps.push(grant.app_id);
  }
  const saved = statements.length ? await c.env.DB.batch(statements) : [];
  // #654: an app with a reviewed relay gets its newest point run into its action. A relay failure never fails the upload:
  // the points are saved and stay readable, and the next upload arms the relay again.
  for (const appId of new Set(statementApps.filter((appId, i) => saved[i]?.meta?.changes && nativeRelayOf(appId)))) {
    await armNativeRelay(c.env, appId, device.user_id, now).catch(e => console.error(`[native-relay] ${appId}: could not queue a delivery: ${String((e as Error)?.message ?? e)}`));
  }
  // Revoked recipients are intentionally discarded, never retried into a subsequent grant.
  return c.json({ acknowledged: points.map(p => p.id) });
});

// #631: Run's strap heart rate. The location upload's rules, against the heart-rate grant and table.
nativeRoutes.post('/native/heart-rate', async c => {
  const device = await nativeDevice(c), now = Date.now();
  await uploadQuota(c.env.DB, `native-hr:${device.id}`, now);
  // #671: at least the validator's worst case (300 samples, 80-char ids, 10 grants, bpm 250 = 240,013 bytes).
  const samples = nativeHeartRateSamples((await nativeBody(c, 256_000)).samples, now);
  const grants = (await nativeGrants(c.env.DB, device.id)).filter(g => g.capability === NATIVE_HEART_RATE);
  const statements: D1PreparedStatement[] = [];
  for (const sample of samples) for (const grant of grants) {
    if (!sample.grants.includes(grant.id) || sample.at < grant.consent_at) continue;
    // Recheck consent, capability and publisher AT THE WRITE: a sample naming the app's location grant is stored nowhere.
    statements.push(c.env.DB.prepare(`INSERT OR IGNORE INTO native_heart_rate (grant_id, sample_id, recorded_at, bpm)
      SELECT g.id, ?, ?, ? FROM native_grants g JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
      JOIN native_devices d ON d.id = g.device_id
      WHERE g.id = ? AND g.device_id = ? AND g.capability = 'heart_rate.ble' AND g.contract_version = ? AND d.expires_at > ?`)
      .bind(sample.id, sample.at, sample.bpm, grant.id, device.id, grant.contract_version, now));
  }
  if (statements.length) await c.env.DB.batch(statements);
  // Revoked recipients are intentionally discarded, never retried into a subsequent grant.
  return c.json({ acknowledged: samples.map(s => s.id) });
});

// Web reads: only the app's own origin (host-injected X-PAS-App) or an app-bound credential may ask.
async function appUser(c: Context<{ Bindings: Env }>) {
  const user = await requireUser(c), appId = c.req.param('appId')!;
  const boundApp = c.req.header(APP_CONTEXT_HEADER) || user.credentialContext?.appId;
  if (boundApp !== appId) throw new HttpError('Read native data through the authorized app.', 403);
  return { user, appId };
}

nativeRoutes.get('/apps/:appId/native/locations', async c => {
  c.header('Cache-Control', 'private, no-store');
  const { user, appId } = await appUser(c);
  const definition = await nativeEntry(appId, NATIVE_LOCATION);
  if (!definition) throw new HttpError('Native location is unavailable for this app.', 404);
  const after = Number(c.req.query('after') ?? '0'), afterId = c.req.query('afterId') ?? '';
  if (!Number.isSafeInteger(after) || after < 0 || afterId.length > 160) throw new HttpError('Invalid location cursor.', 400);
  // Composite cursor remains stable when several devices produce points at the same timestamp.
  // #678: ordered by columns, not by cursorId, so the (grant_id, recorded_at, point_id) index serves each page without
  // sorting the rest of the buffer. Same order: every grant id is 64 hex chars (nativeRandom), so grant_id || ':' || id
  // compares as grant_id, then id.
  const rows = await c.env.DB.prepare(`SELECT p.point_id AS id, p.grant_id AS grantId, p.recorded_at AS at,
    p.latitude AS lat, p.longitude AS lng, p.accuracy, p.grant_id || ':' || p.point_id AS cursorId
    ${NATIVE_LOCATION_SCOPE}
    AND (p.recorded_at > ? OR (p.recorded_at = ? AND p.grant_id || ':' || p.point_id > ?))
    ORDER BY p.recorded_at, p.grant_id, p.point_id LIMIT 500`)
    .bind(appId, user.id, definition.version, Date.now(), Date.now() - NATIVE_CAPABILITIES[NATIVE_LOCATION].retentionMs, after, after, afterId).all();
  return c.json({ points: rows.results ?? [] });
});

nativeRoutes.get('/apps/:appId/native/heart-rate', async c => {
  c.header('Cache-Control', 'private, no-store');
  const { user, appId } = await appUser(c);
  const definition = await nativeEntry(appId, NATIVE_HEART_RATE);
  if (!definition) throw new HttpError('Native heart rate is unavailable for this app.', 404);
  const after = Number(c.req.query('after') ?? '0'), afterId = c.req.query('afterId') ?? '';
  if (!Number.isSafeInteger(after) || after < 0 || afterId.length > 160) throw new HttpError('Invalid heart-rate cursor.', 400);
  // Ordered like the locations read (#678): (at, grant, sample) is (at, cursorId) for 64-char grant ids.
  const rows = await c.env.DB.prepare(`SELECT p.sample_id AS id, p.recorded_at AS at, p.bpm, p.grant_id || ':' || p.sample_id AS cursorId
    ${NATIVE_HEART_RATE_SCOPE}
    AND (p.recorded_at > ? OR (p.recorded_at = ? AND p.grant_id || ':' || p.sample_id > ?))
    ORDER BY p.recorded_at, p.grant_id, p.sample_id LIMIT 1000`)
    .bind(appId, user.id, definition.version, Date.now(), Date.now() - NATIVE_CAPABILITIES[NATIVE_HEART_RATE].retentionMs, after, after, afterId).all();
  return c.json({ samples: rows.results ?? [] });
});

// Lets the app's web UI show companion state before any point exists. Exposes no device identity.
// Predicates mirror the locations read above, so status never says enabled when that read returns nothing.
nativeRoutes.get('/apps/:appId/native/status', async c => {
  c.header('Cache-Control', 'private, no-store');
  const { user, appId } = await appUser(c);
  const now = Date.now(), capabilities: Record<string, { available: boolean; enabled: boolean; lastAt: number | null }> = {};
  for (const entry of (await nativeCatalog()).filter(a => a.id === appId)) {
    const collect = NATIVE_CAPABILITIES[entry.capability]; // its table is a constant identifier from reviewed source (ADR-018 §5)
    // #678: a per-grant MAX, answered from the end of the (grant_id, recorded_at, …) index, not a join over the whole buffer.
    // Without the sample join each grant is one row, so COUNT(*) counts grants.
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS grants,
      MAX((SELECT MAX(p.recorded_at) FROM ${collect.table} p WHERE p.grant_id = g.id AND p.recorded_at >= ?)) AS lastAt
      FROM native_grants g JOIN native_devices d ON d.id = g.device_id
      JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
      WHERE g.app_id = ? AND g.capability = ? AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ?`)
      .bind(now - collect.retentionMs, appId, entry.capability, user.id, entry.version, now).first<{ grants: number; lastAt: number | null }>();
    capabilities[entry.capability] = { available: true, enabled: (row?.grants ?? 0) > 0, lastAt: row?.lastAt ?? null };
  }
  // The top-level fields stay location's (#613); Run is written against exactly them.
  const location = capabilities[NATIVE_LOCATION];
  return c.json({ available: !!location, enabled: location?.enabled ?? false, lastPointAt: location?.lastAt ?? null, capabilities });
});
