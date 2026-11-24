import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { readCapped } from '../routes/hooks.js';
import { actionCallers, type ToolManifest } from './action-sql.js';

export const NATIVE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const NATIVE_LOCATION = 'location.background';
export const NATIVE_HEART_RATE = 'heart_rate.ble';
// ADR-018 §1: platform facts per native capability id. Not consent text and not hashed; a change that would contradict an
// existing disclosure (say, longer retention) must edit that disclosure in the same change.
export const NATIVE_CAPABILITIES = {
  [NATIVE_LOCATION]: { name: 'Location', flow: 'collect', retentionMs: NATIVE_RETENTION_MS },
  [NATIVE_HEART_RATE]: { name: 'Heart rate', flow: 'collect', retentionMs: NATIVE_RETENTION_MS },
} as const satisfies Record<string, { name: string; flow: 'collect' | 'deliver' | 'act'; retentionMs?: number }>;
// Curated, reviewed recipients, one per (app, capability) (list order is /native/me order); app declarations must never grant
// a capability by themselves. Each entry's hash is its contract version (see nativeCatalog): never reshape an existing entry,
// not even to add a field, or every grant for it is revoked.
const NATIVE_CATALOG = [{
  id: 'ski', name: 'Ski', capability: 'location.background', version: '1',
  purpose: 'Automatically record your routes for Ski, including when Ski is closed.',
  disclosure: 'ProAppStore collects precise location in the background to record your routes for Ski. Coordinates are uploaded to the PAS platform and made available to Ski for your account. Platform copies expire after 7 days. You can pause collection or disconnect Ski at any time. Ski may retain rides you save separately.',
}, {
  id: 'run', name: 'Run', capability: 'location.background', version: '1',
  purpose: 'Keep recording your runs and walks while your phone is locked or Run is closed.',
  disclosure: 'ProAppStore collects precise location in the background to record your runs and walks for Run, including while your phone is locked and Run is closed. Coordinates are uploaded to the PAS platform and made available to Run for your account only. Run adds them only to an activity you are recording; it ignores location outside a recording. Platform copies expire after 7 days. You can pause collection or disconnect Run at any time. Runs you save stay in Run until you delete them or your Run account.',
}, {
  id: 'rideshare', name: 'Rideshare', capability: 'location.background', version: '1',
  purpose: 'Keep dispatch and your rider seeing where you are while you drive, including when your phone is locked or Rideshare is closed.',
  disclosure: 'ProAppStore collects precise location in the background and sends each new position to Rideshare for your account, including while your phone is locked and Rideshare is closed. Rideshare shares it with dispatch while you are online as a driver, to offer you nearby rides, and with your rider while you are on their trip, so they can follow you. Rideshare ignores location while you are offline. Platform copies expire after 7 days. Rideshare keeps your position for 24 hours at most. You can pause collection or disconnect Rideshare at any time.',
}, {
  // #631: wording approved by Serge 2026-11-24, verbatim from the issue.
  id: 'run', name: 'Run', capability: 'heart_rate.ble', version: '1',
  purpose: 'Add heart rate from your Bluetooth chest strap to the runs and walks you record, including while your phone is locked.',
  disclosure: 'ProAppStore connects to the Bluetooth heart-rate sensor you choose and reads your heart rate for Run while you wear it, including while your phone is locked and Run is closed. Only beats per minute and the time of each reading are uploaded to the PAS platform and made available to Run for your account only. The sensor\'s name and identifier stay on this phone. Run adds heart rate only to an activity you are recording; it ignores readings outside a recording. Platform copies expire after 7 days. Heart rate is never used for advertising. You can turn this off or disconnect Run at any time. Runs you save stay in Run until you delete them or your Run account.',
}] as const;
/**
 * #654: the app action an entry's accepted points are relayed into, as the device's owner. Kept apart from NATIVE_CATALOG so
 * the hashed entries are untouched; an entry's disclosure must already say who receives its points live. Only this map binds an
 * action to the "native" caller: an app's manifest can list the caller but cannot choose to receive points.
 */
export const NATIVE_RELAYS: Readonly<Record<string, { capability: typeof NATIVE_LOCATION; action: string }>> = {
  rideshare: { capability: NATIVE_LOCATION, action: 'native_driver_location' },
};
/** The app's relay, or undefined. */
export function nativeRelayOf(appId: string) { return Object.hasOwn(NATIVE_RELAYS, appId) ? NATIVE_RELAYS[appId] : undefined; }
/** The params a relay action receives, and the types it must declare for them. */
const NATIVE_RELAY_PARAMS: Record<string, readonly string[]> = { lat: ['number'], lng: ['number'], accuracy: ['number'], at: ['integer', 'timestamp_ms'] };
/**
 * Why `tool` cannot be the app's relay action, or null. Checked at registration and again at every delivery. Callers exactly
 * ["native"]: a location the action receives always came from the companion, never from a session, worker or hook.
 */
export function nativeRelayActionError(appId: string, tool: ToolManifest): string | null {
  const relay = nativeRelayOf(appId);
  if (relay?.action !== tool.name) {
    return `callers "native" is reserved for the action the reviewed native catalog relays to${relay ? ` ("${relay.action}")` : ', and this app has none'}`;
  }
  const callers = actionCallers(tool);
  if (callers.length !== 1 || callers[0] !== 'native') return `"${tool.name}" must declare callers: ["native"] only, so no user, worker or hook can submit a location as the device's owner`;
  if (tool.operation !== 'execute' && tool.operation !== 'batch') return `"${tool.name}" must be an execute or batch action`;
  if (tool.requires_auth !== true) return `"${tool.name}" must require auth: it runs as the device's owner`;
  if (tool.auth?.app_roles?.length || tool.auth?.platform_roles?.length) return `"${tool.name}" cannot be role-gated: the relay holds no role`;
  if (tool.step_up) return `"${tool.name}" cannot require step-up: no one signs in for a relayed point`;
  const params = tool.params ?? {};
  const names = Object.keys(params);
  if (names.length !== 4 || Object.entries(NATIVE_RELAY_PARAMS).some(([n, types]) => !types.includes(params[n]?.type ?? ''))) {
    return `"${tool.name}" must declare exactly the params lat (number), lng (number), accuracy (number) and at (integer or timestamp_ms)`;
  }
  return null;
}
/**
 * The location read's authorization (#613): current publisher, current contract, unexpired device, retention. The relay
 * (#654) uses the same, so a revocation, publisher transfer, disclosure change or device expiry stops both. Binds, in order:
 * app id, user id, contract version, now, retention floor.
 */
export const NATIVE_LOCATION_SCOPE = `FROM native_locations p JOIN native_grants g ON g.id = p.grant_id JOIN native_devices d ON d.id = g.device_id
    JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
    WHERE g.app_id = ? AND g.capability = 'location.background' AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ? AND p.recorded_at >= ?`;

/** The heart-rate read's authorization: the location read's (#613), over native_heart_rate and the heart-rate grant (#631). */
export const NATIVE_HEART_RATE_SCOPE = `FROM native_heart_rate p JOIN native_grants g ON g.id = p.grant_id JOIN native_devices d ON d.id = g.device_id
    JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
    WHERE g.app_id = ? AND g.capability = 'heart_rate.ble' AND d.user_id = ? AND g.contract_version = ? AND d.expires_at > ? AND p.recorded_at >= ?`;

interface NativeDevice { id: string; user_id: string; label: string; expires_at: number; }
interface NativeGrant { id: string; app_id: string; capability: string; consent_at: number; contract_version: string; publisher_id: string; }
interface NativePoint { id: string; at: number; lat: number; lng: number; accuracy: number; grants: string[]; }
interface NativeHeartRateSample { id: string; at: number; bpm: number; grants: string[]; }
export function nativeRandom(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function nativeHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function nativeCatalog() {
  // The receipt is bound to the actual disclosure, not a version an author might forget to bump.
  return Promise.all(NATIVE_CATALOG.map(async a => ({ ...a, version: await nativeHash(JSON.stringify(a)) })));
}
/** The reviewed entry for one (app, capability), or undefined: the only way a route picks an entry. */
export async function nativeEntry(appId: string, capability: string) {
  return (await nativeCatalog()).find(a => a.id === appId && a.capability === capability);
}
/** Display facts of the reviewed native capabilities an app has, for its public listing (ADR-018 §8). */
export function nativeCapabilitiesOf(appId: string): { id: string; name: string }[] {
  return NATIVE_CATALOG.filter(a => a.id === appId).map(a => ({ id: a.capability, name: NATIVE_CAPABILITIES[a.capability].name }));
}
export async function nativeBody(c: Context<{ Bindings: Env }>, max = 4096): Promise<Record<string, unknown>> {
  const bytes = await readCapped(c.req.raw, max);
  if (!bytes) throw new HttpError('Request is too large.', 413);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError('Invalid JSON request.', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('Expected a JSON object.', 400);
  return body as Record<string, unknown>;
}
export async function nativeDevice(c: Context<{ Bindings: Env }>): Promise<NativeDevice> {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
  if (!/^ndev_[a-f0-9]{64}$/.test(token)) throw new HttpError('Connect this device to ProAppStore.', 401);
  const row = await c.env.DB.prepare('SELECT id, user_id, label, expires_at FROM native_devices WHERE token_hash = ? AND expires_at > ?')
    .bind(await nativeHash(token), Date.now()).first<NativeDevice>();
  if (!row) throw new HttpError('Device connection expired or was disconnected.', 401);
  return row;
}
export async function nativeGrants(db: D1Database, deviceId: string): Promise<NativeGrant[]> {
  const rows = await db.prepare(`SELECT g.id, g.app_id, g.capability, g.consent_at, g.contract_version, g.publisher_id
    FROM native_grants g JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
    WHERE g.device_id = ?`).bind(deviceId).all<NativeGrant>();
  const catalog = await nativeCatalog();
  return (rows.results ?? []).filter(g => catalog.some(a => a.id === g.app_id && a.capability === g.capability && a.version === g.contract_version));
}
export function nativePoints(value: unknown, now: number): NativePoint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new HttpError('Send 1 to 100 location points.', 400);
  const ids = new Set<string>();
  return value.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(p.id) || ids.has(p.id)
      || !Number.isSafeInteger(p.at) || p.at < now - NATIVE_RETENTION_MS || p.at > now + 60_000
      || typeof p.lat !== 'number' || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90
      || typeof p.lng !== 'number' || !Number.isFinite(p.lng) || Math.abs(p.lng) > 180
      || typeof p.accuracy !== 'number' || !Number.isFinite(p.accuracy) || p.accuracy < 0 || p.accuracy > 10_000
      || !Array.isArray(p.grants) || p.grants.length < 1 || p.grants.length > 10
      || p.grants.some((g: unknown) => typeof g !== 'string' || !/^[a-f0-9]{64}$/.test(g))) throw new HttpError('Invalid location point.', 400);
    ids.add(p.id);
    return { id: p.id, at: p.at, lat: p.lat, lng: p.lng, accuracy: p.accuracy, grants: [...new Set<string>(p.grants)] };
  });
}
/** A heart-rate batch (#631): 1-300 samples, integer bpm 25-250, the location point's id, time and grant rules. */
export function nativeHeartRateSamples(value: unknown, now: number): NativeHeartRateSample[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 300) throw new HttpError('Send 1 to 300 heart-rate samples.', 400);
  const ids = new Set<string>();
  return value.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(p.id) || ids.has(p.id)
      || !Number.isSafeInteger(p.at) || p.at < now - NATIVE_RETENTION_MS || p.at > now + 60_000
      || !Number.isInteger(p.bpm) || p.bpm < 25 || p.bpm > 250
      || !Array.isArray(p.grants) || p.grants.length < 1 || p.grants.length > 10
      || p.grants.some((g: unknown) => typeof g !== 'string' || !/^[a-f0-9]{64}$/.test(g))) throw new HttpError('Invalid heart-rate sample.', 400);
    ids.add(p.id);
    return { id: p.id, at: p.at, bpm: p.bpm, grants: [...new Set<string>(p.grants)] };
  });
}
export async function pruneNativeData(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM native_locations WHERE recorded_at < ?').bind(now - NATIVE_RETENTION_MS),
    db.prepare('DELETE FROM native_heart_rate WHERE recorded_at < ?').bind(now - NATIVE_RETENTION_MS),
    db.prepare('DELETE FROM native_pairings WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM native_devices WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM native_grants WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = native_grants.app_id AND a.creator_id = native_grants.publisher_id)'),
  ]);
}
