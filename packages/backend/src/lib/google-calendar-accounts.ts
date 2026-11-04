import type { Env } from '../types.js';
import { toUint8 } from './bytes.js';
import { openSecret, sealSecret } from './encryption.js';
import { callbackUrl, GoogleCalendarError, GOOGLE_CALENDAR_SCOPES, googleConfigured, googleJson, hashState, pkceVerifier, randomState, textInput } from './google-calendar-common.js';

interface Account {
  user_id: string; version: number; status: string; email: string | null; google_subject: string | null;
  credential_ct: unknown; credential_dek: unknown; credential_iv: unknown;
}
interface Credential { userId: string; subject: string; version: number; refreshToken: string; accessToken: string; expiresAt: number }
export interface OAuthState { app_id: string; user_id: string; account_version: number; callback_url: string; return_to: string; expires_at: number; consumed_at: number | null }
export const account = (env: Env, userId: string) => env.DB.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').bind(userId).first<Account>();
export async function accountStatus(env: Env, appId: string, userId: string) {
  const row = await account(env, userId);
  const allowed = row?.status === 'connected' && !!await appAuthorization(env, appId, userId, row.version);
  return { configured: googleConfigured(env), connected: !!allowed, email: allowed ? row!.email : null, version: allowed ? row!.version : 0 };
}
const appAuthorization = (env: Env, appId: string, userId: string, version: number) => env.DB.prepare(`SELECT 1 AS allowed FROM google_calendar_app_authorizations auth
  WHERE app_id = ? AND user_id = ? AND account_version = ?
  AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = auth.app_id AND d.user_id = auth.user_id)`).bind(appId, userId, version).first();
export async function requireAppAuthorization(env: Env, appId: string, userId: string) {
  const row = await account(env, userId);
  if (!row || row.status !== 'connected' || !await appAuthorization(env, appId, userId, row.version)) throw new GoogleCalendarError('reconnect_required', 409);
  return row.version;
}
function configured(env: Env) {
  if (!googleConfigured(env)) throw new GoogleCalendarError('google_not_configured', 503);
}
async function seal(env: Env, credential: Credential) { return sealSecret(JSON.stringify(credential), env.APP_SECRET_KEK!); }

/** Access tokens remain inside PAS, including when called by an app worker. */
export async function accountToken(env: Env, userId: string, expectedVersion?: number): Promise<string> {
  configured(env);
  const row = await account(env, userId);
  if (!row || row.status !== 'connected' || (expectedVersion !== undefined && row.version !== expectedVersion)) throw new GoogleCalendarError('reconnect_required', 409);
  let credential: Credential;
  try {
    credential = JSON.parse(await openSecret({ keyCiphertext: toUint8(row.credential_ct), dekWrapped: toUint8(row.credential_dek), iv: toUint8(row.credential_iv) }, env.APP_SECRET_KEK!));
    if (credential.userId !== userId || credential.subject !== row.google_subject || credential.version !== row.version || !credential.refreshToken) throw new Error();
  } catch { throw new GoogleCalendarError('reconnect_required', 409); }
  if (credential.expiresAt > Date.now() + 60_000 && credential.accessToken) return credential.accessToken;
  const token = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
  });
  if (typeof token.access_token !== 'string' || !token.access_token) throw new GoogleCalendarError('google_invalid_response', 502);
  credential.accessToken = token.access_token;
  credential.expiresAt = Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000;
  const sealed = await seal(env, credential);
  const saved = await env.DB.prepare("UPDATE google_calendar_accounts SET credential_ct = ?, credential_dek = ?, credential_iv = ? WHERE user_id = ? AND version = ? AND status = 'connected'")
    .bind(sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, userId, row.version).run();
  if (!saved.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return credential.accessToken;
}

/** Callback and return paths are app-relative; an app cannot select another origin. */
function appUrl(appId: string, path: unknown): string {
  const value = textInput(path, /^\/(?!\/)[^\\#\r\n]{0,1800}$/);
  const base = `https://${appId}.proappstore.online`;
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname.startsWith('/.pas/')) throw new GoogleCalendarError('invalid_return_to');
  return url.href;
}
export async function beginGoogleOAuth(env: Env, appId: string, userId: string, callback: unknown, returnTo: unknown) {
  configured(env);
  if (await env.DB.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, userId).first()) throw new GoogleCalendarError('app_account_deleted', 403);
  const callback_url = appUrl(appId, callback), return_to = appUrl(appId, returnTo);
  const now = Date.now(), state = randomState();
  await env.DB.prepare("INSERT OR IGNORE INTO google_calendar_accounts (user_id, updated_at) VALUES (?, ?)").bind(userId, now).run();
  const row = (await account(env, userId))!;
  // Bounded cleanup: old state contains no credential, and can never be consumed after expiry.
  await env.DB.prepare('DELETE FROM google_calendar_oauth_states WHERE state_hash IN (SELECT state_hash FROM google_calendar_oauth_states WHERE expires_at < ? LIMIT 100)').bind(now - 86_400_000).run();
  const pending = await env.DB.prepare(`INSERT INTO google_calendar_oauth_states (state_hash, app_id, user_id, account_version, callback_url, return_to, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
    .bind(await hashState(state), appId, userId, row.version, callback_url, return_to, now + 600_000, appId, userId).run();
  if (!pending.meta.changes) throw new GoogleCalendarError('app_account_deleted', 403);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: callbackUrl(env), response_type: 'code', scope: GOOGLE_CALENDAR_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge_method: 'S256', code_challenge: await hashState(await pkceVerifier(env, state)) }).toString();
  return { authorization_url: url.href };
}
export async function oauthState(env: Env, state: unknown): Promise<OAuthState> {
  const value = textInput(state, /^[A-Za-z0-9_-]{43}$/);
  const row = await env.DB.prepare('SELECT * FROM google_calendar_oauth_states WHERE state_hash = ?').bind(await hashState(value)).first<OAuthState>();
  if (!row || row.consumed_at !== null || row.expires_at <= Date.now()) throw new GoogleCalendarError('expired_or_used_callback', 409);
  return row;
}

/** The callback forwards only the one-use code. This authenticated completion binds it to the initiating PAS user. */
export async function completeGoogleOAuth(env: Env, appId: string, userId: string, state: unknown, code: unknown) {
  configured(env);
  const row = await oauthState(env, state);
  const authCode = textInput(code, /^[^\s]{1,4096}$/);
  if (row.app_id !== appId || row.user_id !== userId) throw new GoogleCalendarError('forbidden', 403);
  const claimed = await env.DB.prepare('UPDATE google_calendar_oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?')
    .bind(Date.now(), await hashState(state as string), Date.now()).run();
  if (!claimed.meta.changes) throw new GoogleCalendarError('expired_or_used_callback', 409);
  const token = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: callbackUrl(env), code: authCode, grant_type: 'authorization_code', code_verifier: await pkceVerifier(env, state as string) }),
  });
  const scopes = new Set(String(token.scope ?? '').split(' '));
  const required = GOOGLE_CALENDAR_SCOPES.filter(s => s.startsWith('https://'));
  if (!required.every(s => scopes.has(s))) throw new GoogleCalendarError('missing_google_permissions');
  if (typeof token.refresh_token !== 'string' || !token.refresh_token || typeof token.access_token !== 'string' || !token.access_token) throw new GoogleCalendarError('reconnect_required', 409);
  const profile = await googleJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (typeof profile.sub !== 'string' || !/^\d+$/.test(profile.sub) || profile.email_verified !== true || typeof profile.email !== 'string') throw new GoogleCalendarError('google_identity_unverified');
  const version = row.account_version + 1;
  const sealed = await seal(env, { userId, subject: profile.sub, version, refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000 });
  // Serialize with app-account deletion and publisher transfer. An exchange
  // already in flight must not replace a shared account after its state is removed.
  const [saved, authorized] = await env.DB.batch([
    env.DB.prepare(`UPDATE google_calendar_accounts SET version = ?, status = 'connected', google_subject = ?, email = ?, credential_ct = ?, credential_dek = ?, credential_iv = ?, updated_at = ? WHERE user_id = ? AND version = ?
      AND EXISTS (SELECT 1 FROM google_calendar_oauth_states s WHERE s.state_hash = ? AND s.consumed_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
      .bind(version, profile.sub, profile.email, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now(), userId, row.account_version, await hashState(state as string), appId, userId),
    env.DB.prepare(`INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version)
    SELECT app_id, user_id, ? FROM google_calendar_oauth_states WHERE state_hash = ? AND consumed_at IS NOT NULL
    AND changes() = 1
    AND EXISTS (SELECT 1 FROM google_calendar_accounts WHERE user_id = ? AND version = ? AND status = 'connected')
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)
    ON CONFLICT(app_id, user_id) DO UPDATE SET account_version = excluded.account_version`)
      .bind(version, await hashState(state as string), userId, version, appId, userId),
  ]);
  if (!saved?.meta.changes || !authorized?.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { return_to: new URL(row.return_to).pathname + new URL(row.return_to).search, email: profile.email };
}

export async function disconnectGoogleAccount(env: Env, userId: string, expectedVersion: unknown) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const changed = await env.DB.prepare("UPDATE google_calendar_accounts SET version = version + 1, status = 'disconnected', google_subject = NULL, email = NULL, credential_ct = NULL, credential_dek = NULL, credential_iv = NULL, updated_at = ? WHERE user_id = ? AND version = ?")
    .bind(Date.now(), userId, expectedVersion).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}
