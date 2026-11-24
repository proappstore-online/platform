import { Hono, type Context } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import {
  nativeBody, nativeCatalog, NATIVE_CAPABILITIES, NATIVE_HEART_RATE, NATIVE_LOCATION, NATIVE_RETENTION_MS, nativeDevice,
} from '../lib/native-companion.js';
import { uploadQuota } from './native.js';

/**
 * The user's own native data across apps and devices, and the phone's diagnostics report (#660, ADR-019).
 *
 * Two surfaces with different credentials, kept apart on purpose:
 *   - `/me/native/*` reads: the user's session AND the first-party X-Internal-Token (the MCP over its service binding).
 *     Never a device credential, never an app page.
 *   - `/native/diagnostics`: the device credential, like every other `/native/*` route. It writes and deletes the device's
 *     own report and reads nothing back (ADR-018 §11 stays true).
 */
export const nativeAccountRoutes = new Hono<{ Bindings: Env }>();
const noStore = async (c: Context, next: () => Promise<void>) => { c.header('Cache-Control', 'private, no-store'); await next(); };
nativeAccountRoutes.use('/me/native/*', noStore);
nativeAccountRoutes.use('/native/diagnostics', noStore);

const APP_ID = /^[a-z][a-z0-9-]{0,57}$/;
const DEVICE_ID = /^[a-f0-9]{64}$/;
const DAY = 24 * 60 * 60_000;

// The user's own native data across apps and devices (#660). First-party callers only: a session alone would let any
// app's page read every app's location (app pages hold the session; the host forwards it). Mirrors /auth/me/account
// (#136). Fails CLOSED without INTERNAL_TOKEN. Do not "simplify" this to requireUser (ADR-019 §4).
async function nativeOwner(c: Context<{ Bindings: Env }>): Promise<string> {
  if (!c.env.INTERNAL_TOKEN) throw new HttpError('native account reads are not configured (missing INTERNAL_TOKEN)', 503);
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) throw new HttpError('native account reads require a first-party caller', 403);
  const user = await requireUser(c);
  if (user.credentialContext?.appId) throw new HttpError('An app-bound credential cannot read native data across apps.', 403);
  return user.id;
}

/** An optional `appId` / `deviceId` filter, validated before it reaches SQL. */
function filters(c: Context<{ Bindings: Env }>) {
  const appId = c.req.query('appId') || undefined, deviceId = c.req.query('deviceId') || undefined;
  if (appId !== undefined && !APP_ID.test(appId)) throw new HttpError('Invalid appId.', 400);
  if (deviceId !== undefined && !DEVICE_ID.test(deviceId)) throw new HttpError('Invalid deviceId.', 400);
  return { appId, deviceId };
}

nativeAccountRoutes.get('/me/native/devices', async c => {
  const userId = await nativeOwner(c), now = Date.now();
  const rows = await c.env.DB.prepare(`SELECT d.id, d.label, d.platform, d.app_version AS appVersion, d.created_at AS createdAt,
    d.expires_at AS expiresAt, d.last_seen_at AS lastSeenAt, x.received_at AS receivedAt
    FROM native_devices d LEFT JOIN native_diagnostics x ON x.device_id = d.id AND x.received_at >= ?
    WHERE d.user_id = ? AND d.expires_at > ? ORDER BY d.last_seen_at IS NULL, d.last_seen_at DESC, d.created_at DESC`)
    .bind(now - NATIVE_RETENTION_MS, userId, now)
    .all<{ id: string; label: string; platform: string | null; appVersion: string | null; createdAt: number; expiresAt: number; lastSeenAt: number | null; receivedAt: number | null }>();
  return c.json({ devices: (rows.results ?? []).map(({ receivedAt, ...d }) => ({ ...d, diagnostics: receivedAt === null ? null : { receivedAt } })) });
});

interface GrantRow { id: string; deviceId: string; label: string; appId: string; capability: string; consentAt: number; contractVersion: string; publisherId: string; creatorId: string | null }

/** Every grant of the user's unexpired devices, raw: `nativeGrants()` would drop the obsolete ones this read exists to show. */
async function ownerGrants(db: D1Database, userId: string, now: number, f: { appId?: string | undefined; deviceId?: string | undefined; capability?: string | undefined }) {
  const where = ['d.user_id = ?', 'd.expires_at > ?'], args: unknown[] = [userId, now];
  if (f.appId) { where.push('g.app_id = ?'); args.push(f.appId); }
  if (f.deviceId) { where.push('g.device_id = ?'); args.push(f.deviceId); }
  if (f.capability) { where.push('g.capability = ?'); args.push(f.capability); }
  const rows = await db.prepare(`SELECT g.id, g.device_id AS deviceId, d.label, g.app_id AS appId, g.capability, g.consent_at AS consentAt,
    g.contract_version AS contractVersion, g.publisher_id AS publisherId, a.creator_id AS creatorId
    FROM native_grants g JOIN native_devices d ON d.id = g.device_id LEFT JOIN apps a ON a.id = g.app_id
    WHERE ${where.join(' AND ')} ORDER BY g.consent_at DESC, g.id`).bind(...args).all<GrantRow>();
  return rows.results ?? [];
}

/** `current`: the grant the app's own reads accept, under the same predicates (contract version and publisher). */
const isCurrent = (g: GrantRow, version: string | undefined) => version !== undefined && g.contractVersion === version && g.creatorId === g.publisherId;

nativeAccountRoutes.get('/me/native/grants', async c => {
  const userId = await nativeOwner(c), f = filters(c), catalog = await nativeCatalog();
  const grants = await ownerGrants(c.env.DB, userId, Date.now(), f);
  return c.json({ grants: grants.map(g => {
    const entry = catalog.find(a => a.id === g.appId && a.capability === g.capability);
    return { id: g.id, deviceId: g.deviceId, appId: g.appId, appName: entry?.name ?? g.appId, capability: g.capability, consentAt: g.consentAt,
      contractVersion: g.contractVersion, catalogVersion: entry?.version ?? null, current: isCurrent(g, entry?.version) };
  }) });
});

interface Snapshot {
  collection?: { sessions?: { appId: string; startedAt: number }[]; lastEnded?: { appId: string; at: number; reason: string }[] };
  activity?: { at: number }[];
}

/** The user's current diagnostics reports by device id, within retention. */
async function ownerSnapshots(db: D1Database, userId: string, now: number, deviceId?: string) {
  const rows = await db.prepare(`SELECT d.id AS deviceId, d.label, x.received_at AS receivedAt, x.snapshot
    FROM native_diagnostics x JOIN native_devices d ON d.id = x.device_id
    WHERE d.user_id = ? AND d.expires_at > ? AND x.received_at >= ?${deviceId ? ' AND d.id = ?' : ''} ORDER BY x.received_at DESC`)
    .bind(userId, now, now - NATIVE_RETENTION_MS, ...(deviceId ? [deviceId] : []))
    .all<{ deviceId: string; label: string; receivedAt: number; snapshot: string }>();
  return (rows.results ?? []).map(r => ({ ...r, snapshot: JSON.parse(r.snapshot) as Snapshot }));
}

nativeAccountRoutes.get('/me/native/status', async c => {
  const userId = await nativeOwner(c), { appId } = filters(c), now = Date.now(), catalog = await nativeCatalog();
  const snapshots = new Map((await ownerSnapshots(c.env.DB, userId, now)).map(s => [s.deviceId, s.snapshot]));
  const granted = new Set((await ownerGrants(c.env.DB, userId, now, { appId })).map(g => g.appId));
  const items = [];
  for (const entry of catalog.filter(a => granted.has(a.id))) {
    const collect = NATIVE_CAPABILITIES[entry.capability]; // a constant identifier from reviewed source (ADR-018 §5)
    // #678: a per-grant MAX from the end of the (grant_id, recorded_at, …) index, never a join over the whole buffer.
    const rows = await c.env.DB.prepare(`SELECT g.id, g.device_id AS deviceId, d.label, g.contract_version AS contractVersion,
      g.publisher_id AS publisherId, a.creator_id AS creatorId,
      (SELECT MAX(p.recorded_at) FROM ${collect.table} p WHERE p.grant_id = g.id AND p.recorded_at >= ?) AS lastAt
      FROM native_grants g JOIN native_devices d ON d.id = g.device_id LEFT JOIN apps a ON a.id = g.app_id
      WHERE d.user_id = ? AND d.expires_at > ? AND g.app_id = ? AND g.capability = ? ORDER BY g.consent_at, g.id`)
      .bind(now - collect.retentionMs, userId, now, entry.id, entry.capability).all<GrantRow & { lastAt: number | null }>();
    const devices = (rows.results ?? []).map(g => {
      const current = isCurrent(g, entry.version), collection = snapshots.get(g.deviceId)?.collection;
      // Session state comes only from the user's own report (ADR-019 §6, ADR-020): null when the phone sent none.
      const session = collection?.sessions?.find(s => s.appId === entry.id);
      const ended = collection?.lastEnded?.find(e => e.appId === entry.id);
      return { deviceId: g.deviceId, label: g.label, grantId: g.id, current, lastAt: g.lastAt,
        sharing: collection ? !!session : null, sessionStartedAt: session?.startedAt ?? null,
        lastSessionEnd: ended ? { at: ended.at, reason: ended.reason } : null };
    });
    const live = devices.filter(d => d.current);
    items.push({ appId: entry.id, appName: entry.name, capability: entry.capability, name: collect.name, enabled: live.length > 0,
      lastAt: live.reduce<number | null>((max, d) => d.lastAt !== null && (max === null || d.lastAt > max) ? d.lastAt : max, null), devices });
  }
  return c.json({ status: items });
});

/** The owner's sample read per Collect capability: its id column, its fields and its page cap. Table and retention are the registry's. */
const OWNER_SAMPLES = {
  [NATIVE_LOCATION]: { id: 'point_id', fields: 'p.latitude AS lat, p.longitude AS lng, p.accuracy', max: 500, key: 'points' },
  [NATIVE_HEART_RATE]: { id: 'sample_id', fields: 'p.bpm', max: 1000, key: 'samples' },
} as const;

async function ownerSamples(c: Context<{ Bindings: Env }>, capability: keyof typeof OWNER_SAMPLES) {
  const userId = await nativeOwner(c), f = filters(c), read = OWNER_SAMPLES[capability], collect = NATIVE_CAPABILITIES[capability];
  const after = Number(c.req.query('after') ?? '0'), afterId = c.req.query('afterId') ?? '', limit = Number(c.req.query('limit') ?? read.max);
  if (!Number.isSafeInteger(after) || after < 0 || afterId.length > 160) throw new HttpError('Invalid cursor.', 400);
  if (!Number.isInteger(limit) || limit < 1 || limit > read.max) throw new HttpError(`limit must be 1 to ${read.max}.`, 400);
  const where = ['d.user_id = ?', 'g.capability = ?', 'd.expires_at > ?', 'p.recorded_at >= ?'], now = Date.now();
  const args: unknown[] = [userId, capability, now, now - collect.retentionMs];
  if (f.appId) { where.push('g.app_id = ?'); args.push(f.appId); }
  if (f.deviceId) { where.push('g.device_id = ?'); args.push(f.deviceId); }
  // No contract-version or publisher predicate: the user may see their own samples under a grant the app can no longer
  // read, and /me/native/grants says why. The cursor and order are the app reads' (#678): (at, grant, id) is (at, cursorId).
  const rows = await c.env.DB.prepare(`SELECT p.${read.id} AS id, g.app_id AS appId, g.device_id AS deviceId, p.grant_id AS grantId,
    p.recorded_at AS at, ${read.fields}, p.grant_id || ':' || p.${read.id} AS cursorId
    FROM ${collect.table} p JOIN native_grants g ON g.id = p.grant_id JOIN native_devices d ON d.id = g.device_id
    WHERE ${where.join(' AND ')} AND (p.recorded_at > ? OR (p.recorded_at = ? AND p.grant_id || ':' || p.${read.id} > ?))
    ORDER BY p.recorded_at, p.grant_id, p.${read.id} LIMIT ?`)
    .bind(...args, after, after, afterId, limit).all<{ at: number; cursorId: string }>();
  const results = rows.results ?? [], last = results.at(-1);
  return c.json({ [read.key]: results, next: results.length === limit && last ? { after: last.at, afterId: last.cursorId } : null });
}

nativeAccountRoutes.get('/me/native/locations', c => ownerSamples(c, NATIVE_LOCATION));
nativeAccountRoutes.get('/me/native/heart-rate', c => ownerSamples(c, NATIVE_HEART_RATE));

nativeAccountRoutes.get('/me/native/diagnostics', async c => {
  const userId = await nativeOwner(c), { deviceId } = filters(c), now = Date.now();
  const reports = await ownerSnapshots(c.env.DB, userId, now, deviceId);
  // Activity older than 7 days is dropped at read as well as at upload: a report can be up to 7 days old.
  return c.json({ diagnostics: reports.map(r => ({ ...r, snapshot: { ...r.snapshot, activity: (r.snapshot.activity ?? []).filter(e => e.at >= now - NATIVE_RETENTION_MS) } })) });
});

// ── The phone's diagnostics report (device credential) ────────────────────────────────────────────────────────────────

/** The body cap, and the stored report's (migration 0151's CHECK). The phones cap their activity list to stay under it. */
export const NATIVE_DIAGNOSTICS_MAX = 65_536;

const LOCATION_PERMISSIONS = ['notDetermined', 'denied', 'approximate', 'whenInUse', 'always'] as const;
const BLUETOOTH = ['notDetermined', 'denied', 'allowed', 'off', 'unsupported'] as const;
const NOTIFICATIONS = ['notDetermined', 'denied', 'allowed'] as const;
const LOCATION_SENSOR = ['collecting', 'idle', 'stopped'] as const;
const KEY = /^[a-z][a-z0-9-]{0,57}(\/[a-z_.]{1,40})?$/;

const bad = (field: string): never => { throw new HttpError(`Invalid diagnostics report: ${field}.`, 400); };
const obj = (v: unknown, field: string) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad(field));
const int = (v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER) => (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : bad(field));
const time = (v: unknown, field: string) => (v === null ? null : int(v, field));
const bool = (v: unknown, field: string) => (typeof v === 'boolean' ? v : bad(field));
const optBool = (v: unknown, field: string) => (v === undefined ? undefined : bool(v, field));
const oneOf = <T extends string>(v: unknown, values: readonly T[], field: string) => (values.includes(v as T) ? v as T : bad(field));
const match = (v: unknown, re: RegExp, field: string) => (typeof v === 'string' && re.test(v) ? v : bad(field));
/** Free text (error text, an OS name): control characters dropped and cut to `max`, never rejected for its content. */
const text = (v: unknown, field: string, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : bad(field));
const list = (v: unknown, field: string, max: number) => (Array.isArray(v) && v.length <= max ? v : bad(field));

/**
 * Rebuilds a report from whitelisted fields only (ADR-019 §2): unknown fields are dropped, never stored, so no sample can be
 * smuggled in. `kind` is a pattern, not an enum, so a newer client's event kinds are not rejected. Activity older than
 * 7 days is dropped. A new field needs a change here, reviewed against ADR-019.
 */
export function nativeDiagnosticsSnapshot(value: unknown, now: number) {
  const s = obj(value, 'snapshot');
  if (s.v !== 1) bad('v');
  const at = int(s.at, 'at', now - 7 * DAY, now + 7 * DAY);
  const app = obj(s.app, 'app'), permissions = obj(s.permissions, 'permissions'), sensors = obj(s.sensors, 'sensors');
  const queue = obj(s.queue, 'queue'), sync = obj(s.sync, 'sync'), collection = obj(s.collection, 'collection');
  const heartRateSync = sync.heartRate === undefined ? undefined : obj(sync.heartRate, 'sync.heartRate');
  return {
    v: 1 as const, at,
    app: {
      platform: oneOf(app.platform, ['ios', 'android'] as const, 'app.platform'),
      version: match(app.version, /^[0-9A-Za-z.+-]{1,32}$/, 'app.version'), build: match(app.build, /^[0-9]{1,10}$/, 'app.build'),
      os: text(app.os, 'app.os', 40),
    },
    permissions: {
      location: oneOf(permissions.location, LOCATION_PERMISSIONS, 'permissions.location'), precise: bool(permissions.precise, 'permissions.precise'),
      bluetooth: oneOf(permissions.bluetooth, BLUETOOTH, 'permissions.bluetooth'),
      notifications: permissions.notifications === undefined ? undefined : oneOf(permissions.notifications, NOTIFICATIONS, 'permissions.notifications'),
      batteryOptimized: optBool(permissions.batteryOptimized, 'permissions.batteryOptimized'),
      powerSave: optBool(permissions.powerSave, 'permissions.powerSave'),
      locationServices: optBool(permissions.locationServices, 'permissions.locationServices'),
    },
    sensors: { location: oneOf(sensors.location, LOCATION_SENSOR, 'sensors.location'), heartRate: match(sensors.heartRate, /^[a-z_]{1,24}$/, 'sensors.heartRate') },
    queue: { location: int(queue.location, 'queue.location', 0, 1_000_000), heartRate: int(queue.heartRate, 'queue.heartRate', 0, 1_000_000) },
    sync: {
      lastSuccessAt: time(sync.lastSuccessAt, 'sync.lastSuccessAt'), lastAttemptAt: time(sync.lastAttemptAt, 'sync.lastAttemptAt'),
      lastError: text(sync.lastError, 'sync.lastError', 120),
      // #660 comment: heart rate's own upload health, apart from location's.
      heartRate: heartRateSync && { lastUploadAt: time(heartRateSync.lastUploadAt, 'sync.heartRate.lastUploadAt'), lastError: text(heartRateSync.lastError, 'sync.heartRate.lastError', 120) },
    },
    collection: {
      // Collection sessions (ADR-020) on both platforms: the ones running, and why each app's last one ended. Never shown
      // to an app (ADR-019 §6).
      sessions: list(collection.sessions, 'collection.sessions', 50).map(v => {
        const session = obj(v, 'collection.sessions');
        return { appId: match(session.appId, APP_ID, 'collection.sessions'), startedAt: int(session.startedAt, 'collection.sessions'), lastMovedAt: int(session.lastMovedAt, 'collection.sessions') };
      }),
      lastEnded: list(collection.lastEnded, 'collection.lastEnded', 50).map(v => {
        const ended = obj(v, 'collection.lastEnded');
        return { appId: match(ended.appId, APP_ID, 'collection.lastEnded'), at: int(ended.at, 'collection.lastEnded'), reason: match(ended.reason, /^[a-z_]{1,24}$/, 'collection.lastEnded') };
      }),
      pendingRevocations: list(collection.pendingRevocations, 'collection.pendingRevocations', 50).map(k => match(k, KEY, 'collection.pendingRevocations')),
    },
    activity: list(s.activity, 'activity', 200).map(v => {
      const e = obj(v, 'activity');
      return { at: int(e.at, 'activity.at'), appId: e.appId === null ? null : match(e.appId, APP_ID, 'activity.appId'),
        kind: match(e.kind, /^[a-z_]{1,32}$/, 'activity.kind'), detail: text(e.detail, 'activity.detail', 120) };
    }).filter(e => e.at >= now - NATIVE_RETENTION_MS),
  };
}

nativeAccountRoutes.put('/native/diagnostics', async c => {
  const device = await nativeDevice(c), now = Date.now();
  await uploadQuota(c.env.DB, `native-diag:${device.id}`, now);
  const body = await nativeBody(c, NATIVE_DIAGNOSTICS_MAX);
  const snapshot = JSON.stringify(nativeDiagnosticsSnapshot(body.snapshot, now));
  if (snapshot.length > NATIVE_DIAGNOSTICS_MAX) throw new HttpError('Request is too large.', 413);
  // One row per device, replaced: the activity log carries its own timestamps, so appending would only repeat it.
  await c.env.DB.prepare(`INSERT INTO native_diagnostics (device_id, received_at, snapshot) VALUES (?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET received_at = excluded.received_at, snapshot = excluded.snapshot`).bind(device.id, now, snapshot).run();
  return c.json({ receivedAt: now });
});

nativeAccountRoutes.delete('/native/diagnostics', async c => {
  const device = await nativeDevice(c);
  await c.env.DB.prepare('DELETE FROM native_diagnostics WHERE device_id = ?').bind(device.id).run();
  return c.json({ deleted: true });
});
