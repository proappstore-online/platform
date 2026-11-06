import type { Context } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { readCapped } from '../routes/hooks.js';

export const NATIVE_RETENTION_MS = 7 * 24 * 60 * 60_000;
// Curated first integration; app declarations must never grant a capability by themselves.
// A material disclosure change increments the version, invalidating existing grants.
const NATIVE_CATALOG = [{
  id: 'ski', name: 'Ski', capability: 'location.background', version: '1',
  purpose: 'Automatically record your routes for Ski, including when Ski is closed.',
  disclosure: 'ProAppStore collects precise location in the background to record your routes for Ski. Coordinates are uploaded to the PAS platform and made available to Ski for your account. Platform copies expire after 7 days. You can pause collection or disconnect Ski at any time. Ski may retain rides you save separately.',
}] as const;

interface NativeDevice { id: string; user_id: string; label: string; expires_at: number; }
interface NativeGrant { id: string; app_id: string; consent_at: number; contract_version: string; publisher_id: string; }
interface NativePoint { id: string; at: number; lat: number; lng: number; accuracy: number; grants: string[]; }
export function nativeRandom(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''); }
export async function nativeHash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function nativeCatalog() {
  // The receipt is bound to the actual disclosure, not a version an author might forget to bump.
  return Promise.all(NATIVE_CATALOG.map(async a => ({ ...a, version: await nativeHash(JSON.stringify(a)) })));
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
  const rows = await db.prepare(`SELECT g.id, g.app_id, g.consent_at, g.contract_version, g.publisher_id
    FROM native_grants g JOIN apps a ON a.id = g.app_id AND a.creator_id = g.publisher_id
    WHERE g.device_id = ?`).bind(deviceId).all<NativeGrant>();
  const catalog = await nativeCatalog();
  return (rows.results ?? []).filter(g => catalog.some(a => a.id === g.app_id && a.version === g.contract_version));
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
export async function pruneNativeData(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM native_locations WHERE recorded_at < ?').bind(now - NATIVE_RETENTION_MS),
    db.prepare('DELETE FROM native_pairings WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM native_devices WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM native_grants WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = native_grants.app_id AND a.creator_id = native_grants.publisher_id)'),
  ]);
}
