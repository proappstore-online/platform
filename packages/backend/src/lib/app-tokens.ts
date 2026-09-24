/**
 * Personal app tokens (#154): `pas_at_…` bearers a user mints for one app, to
 * call that app's actions from scripts and integrations. They are verified HERE
 * and only the actions route calls this — never `requireUser` — so a token can
 * never reach kv, storage, roles, or the token-management routes themselves.
 */
import { HttpError, type FasUser } from './auth.js';

export const TOKEN_PREFIX = 'pas_at_';
/** Names shown to the user: a random id, never derived from the token. */
export const TOKEN_ID_RE = /^[a-f0-9]{32}$/;
export const MAX_SCOPED_ACTIONS = 50;
export const ACTION_NAME_RE = /^[a-z][a-z0-9_]*$/;
/** A token minted from a first-party origin (dashboard) may live a year; from an app origin, 90 days (#154 review §3). */
export const MAX_TTL_FIRST_PARTY_SECONDS = 365 * 86_400;
export const MAX_TTL_APP_ORIGIN_SECONDS = 90 * 86_400;
export const MIN_TTL_SECONDS = 60;
/** last_used_at is written at most once a minute per token, off the response path. */
export const LAST_USED_THROTTLE_MS = 60_000;

export interface TokenScopes {
  access: 'read' | 'write';
  /** null = every action of the app. */
  actions: string[] | null;
}

export interface VerifiedToken {
  user: FasUser;
  scopes: TokenScopes;
  tokenHash: string;
  tokenId: string;
}

export function looksLikeAppToken(bearer: string): boolean {
  return bearer.startsWith(TOKEN_PREFIX);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A fresh token: 160 random bits behind the recognisable prefix (secret scanners key on it). */
export function mintTokenString(): string {
  return TOKEN_PREFIX + hex(crypto.getRandomValues(new Uint8Array(20)));
}

export function mintTokenId(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function parseScopes(json: string): TokenScopes {
  const parsed = JSON.parse(json) as Partial<TokenScopes>;
  return {
    access: parsed.access === 'write' ? 'write' : 'read',
    actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a): a is string => typeof a === 'string') : null,
  };
}

interface TokenRow {
  token_id: string;
  user_id: string;
  app_id: string;
  scopes: string;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * Resolve a `pas_at_` bearer for `appId`. The identity is rebuilt from the
 * database, not from claims: roles are fixed to ['user'] (an app-origin session
 * never carries creator/admin either, #56) and `login` comes from `users`, so an
 * app role granted by GitHub login keeps matching. Any failure is a plain 401 —
 * a token for app A must never learn anything about app B.
 */
export async function verifyAppToken(db: D1Database, appId: string, bearer: string, now = Date.now()): Promise<VerifiedToken> {
  const tokenHash = await sha256Hex(bearer);
  const row = await db.prepare(
    'SELECT token_id, user_id, app_id, scopes, expires_at, revoked_at FROM user_app_tokens WHERE token_hash = ?',
  ).bind(tokenHash).first<TokenRow>();
  if (!row || row.app_id !== appId || row.revoked_at !== null || row.expires_at <= now) {
    throw new HttpError('invalid, expired or revoked app token', 401);
  }
  const user = await db.prepare('SELECT login, avatar_url FROM users WHERE id = ?')
    .bind(row.user_id).first<{ login: string; avatar_url: string | null }>();
  let scopes: TokenScopes;
  try { scopes = parseScopes(row.scopes); } catch { throw new HttpError('invalid, expired or revoked app token', 401); }
  return {
    user: { id: row.user_id, login: user?.login ?? row.user_id, avatarUrl: user?.avatar_url ?? null, roles: ['user'] },
    scopes,
    tokenHash,
    tokenId: row.token_id,
  };
}

/** One conditional write per minute per token, meant for waitUntil. Never rejects. */
export async function touchLastUsed(db: D1Database, tokenHash: string, now = Date.now()): Promise<void> {
  try {
    await db.prepare('UPDATE user_app_tokens SET last_used_at = ?1 WHERE token_hash = ?2 AND (last_used_at IS NULL OR last_used_at < ?1 - ?3)')
      .bind(now, tokenHash, LAST_USED_THROTTLE_MS).run();
  } catch (e) {
    console.error(`last_used_at update failed: ${(e as Error).message}`);
  }
}

/**
 * The failure log attributes callers through the session (`optionalUser`); a
 * token request has no session, so the actions route notes the token's user
 * against the request and the error hook reads it back.
 */
const tokenUsers = new WeakMap<Request, string>();
export function rememberTokenUser(req: Request, userId: string): void {
  tokenUsers.set(req, userId);
}
export function tokenUserFor(req: Request): string | null {
  return tokenUsers.get(req) ?? null;
}
