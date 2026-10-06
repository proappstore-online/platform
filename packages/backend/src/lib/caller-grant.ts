/**
 * Request-scoped caller grants (#260, ADR-009 §3). When a signed-in user's
 * browser request reaches an app worker (`/.pas/worker/*`), the platform mints a
 * grant naming that user, and the worker may run actions *as that user* for
 * the life of the request — never otherwise.
 *
 *   caller = { grant_id, user_id, roles, exp, sig }   (envelope field, http events only)
 *
 * `sig` is HMAC-SHA256 over the envelope's `app_id` plus every grant field, with a
 * key derived from SESSION_SIGNING_KEY by HKDF (info `pas-caller-grant`): no new
 * secret to place, and a grant can never be mistaken for a session token, nor
 * replayed into another app's envelope. Grants are stored nowhere and live 30 s.
 * The worker holds no key, so it cannot mint one.
 */
import type { Env } from '../types.js';
import { timingSafeEqual } from './bytes.js';

export const CALLER_GRANT_TTL_SECONDS = 30;
const encoder = new TextEncoder();

export interface CallerGrant {
  grant_id: string;
  user_id: string;
  roles: string[];
  /** Unix seconds. */
  exp: number;
  sig: string;
}

async function grantKey(sessionSigningKey: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(sessionSigningKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('pas-caller-grant') },
    ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
  );
}

/** What the signature covers: the app, then every grant field, unambiguously. */
function signedText(appId: string, g: Omit<CallerGrant, 'sig'>): string {
  return JSON.stringify([appId, g.grant_id, g.user_id, g.roles, g.exp]);
}

async function sign(env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, g: Omit<CallerGrant, 'sig'>): Promise<string> {
  if (!env.SESSION_SIGNING_KEY) throw new Error('SESSION_SIGNING_KEY is not configured');
  const mac = await crypto.subtle.sign('HMAC', await grantKey(env.SESSION_SIGNING_KEY), encoder.encode(signedText(appId, g)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A grant for this user on this app, valid for 30 s. */
export async function mintCallerGrant(
  env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, user: { id: string; roles: string[] }, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CallerGrant> {
  const g = { grant_id: crypto.randomUUID(), user_id: user.id, roles: [...user.roles], exp: nowSeconds + CALLER_GRANT_TTL_SECONDS };
  return { ...g, sig: await sign(env, appId, g) };
}

/**
 * The grant's user if `raw` is a well-formed grant this platform signed for
 * `appId` and it has not expired; null otherwise. Constant-time compare.
 */
export async function verifyCallerGrant(
  env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, raw: unknown, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ id: string; roles: string[] } | null> {
  const g = raw as Partial<CallerGrant> | null;
  if (!g || typeof g !== 'object' || typeof g.grant_id !== 'string' || typeof g.user_id !== 'string' || !g.user_id
    || !Array.isArray(g.roles) || g.roles.some((r) => typeof r !== 'string') || typeof g.exp !== 'number' || typeof g.sig !== 'string') return null;
  if (g.exp <= nowSeconds) return null;
  const expected = await sign(env, appId, { grant_id: g.grant_id, user_id: g.user_id, roles: g.roles, exp: g.exp });
  if (!timingSafeEqual(encoder.encode(g.sig), encoder.encode(expected))) return null;
  return { id: g.user_id, roles: g.roles };
}
