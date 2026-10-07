/**
 * Request-scoped caller grants (#260, ADR-009 §3). When a signed-in user's
 * browser request reaches an app worker (`/.pas/worker/*`), the platform mints a
 * grant naming that user, and the worker may run actions *as that user* for
 * the life of the request — never otherwise.
 *
 *   caller = { grant_id, event_id, attempt, user_id, roles, exp, sig }   (envelope field, http events only)
 *
 * `sig` is HMAC-SHA256 over the envelope's `app_id` plus every grant field, with a
 * key derived from SESSION_SIGNING_KEY by HKDF (info `pas-caller-grant`): no new
 * secret to place, and a grant can never be mistaken for a session token, nor
 * replayed into another app's envelope. Grants are stored nowhere and live 30 s.
 * The worker holds no key, so it cannot mint one.
 *
 * Bound to its request (#318): `event_id` and `attempt` are the envelope the
 * grant was minted for, and a call may use the grant only with
 * `ctx.invocation === '<event_id>:<attempt>'`. That invocation must still be
 * running, and the call is counted against its budget. So a grant kept in module
 * state cannot act as its user from a schedule, a hook, another user's request,
 * another attempt, or after its own request has finished or timed out.
 */
import type { Env } from '../types.js';
import { timingSafeEqual } from './bytes.js';

export const CALLER_GRANT_TTL_SECONDS = 30;
const encoder = new TextEncoder();

export interface CallerGrant {
  grant_id: string;
  /** The envelope the grant was minted for (#318): only `<event_id>:<attempt>` may use it. */
  event_id: string;
  attempt: number;
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

/** What the signature covers: the app, then every grant field, unambiguously. `v2`: grants before #318 never verify. */
function signedText(appId: string, g: Omit<CallerGrant, 'sig'>): string {
  return JSON.stringify(['v2', appId, g.grant_id, g.event_id, g.attempt, g.user_id, g.roles, g.exp]);
}

/** The invocation a grant belongs to — the app_worker_invocations id of its envelope. */
export const grantInvocation = (g: Pick<CallerGrant, 'event_id' | 'attempt'>) => `${g.event_id}:${g.attempt}`;

async function sign(env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, g: Omit<CallerGrant, 'sig'>): Promise<string> {
  if (!env.SESSION_SIGNING_KEY) throw new Error('SESSION_SIGNING_KEY is not configured');
  const mac = await crypto.subtle.sign('HMAC', await grantKey(env.SESSION_SIGNING_KEY), encoder.encode(signedText(appId, g)));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A grant for this user on this app, for the envelope `event` only, valid for 30 s. */
export async function mintCallerGrant(
  env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, user: { id: string; roles: string[] },
  event: { id: string; attempt: number }, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CallerGrant> {
  const g = {
    grant_id: crypto.randomUUID(), event_id: event.id, attempt: event.attempt,
    user_id: user.id, roles: [...user.roles], exp: nowSeconds + CALLER_GRANT_TTL_SECONDS,
  };
  return { ...g, sig: await sign(env, appId, g) };
}

/**
 * The grant's user if `raw` is a well-formed grant this platform signed for
 * `appId`, for exactly the invocation `invocation` (#318), and it has not
 * expired; null otherwise. Constant-time compare. The caller must still check
 * that `invocation` is running (authorizeWorkerCall does, in its budget UPDATE).
 */
export async function verifyCallerGrant(
  env: Pick<Env, 'SESSION_SIGNING_KEY'>, appId: string, raw: unknown, invocation: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ id: string; roles: string[] } | null> {
  const g = raw as Partial<CallerGrant> | null;
  if (!g || typeof g !== 'object' || typeof g.grant_id !== 'string' || typeof g.event_id !== 'string' || !g.event_id
    || typeof g.attempt !== 'number' || !Number.isInteger(g.attempt) || g.attempt < 1 || typeof g.user_id !== 'string' || !g.user_id
    || !Array.isArray(g.roles) || g.roles.some((r) => typeof r !== 'string') || typeof g.exp !== 'number' || typeof g.sig !== 'string') return null;
  if (g.exp <= nowSeconds) return null;
  const expected = await sign(env, appId, { grant_id: g.grant_id, event_id: g.event_id, attempt: g.attempt, user_id: g.user_id, roles: g.roles, exp: g.exp });
  if (!timingSafeEqual(encoder.encode(g.sig), encoder.encode(expected))) return null;
  // Signed, so event_id and attempt are the platform's: the call must come from that very invocation.
  if (invocation !== grantInvocation({ event_id: g.event_id, attempt: g.attempt })) return null;
  return { id: g.user_id, roles: g.roles };
}
