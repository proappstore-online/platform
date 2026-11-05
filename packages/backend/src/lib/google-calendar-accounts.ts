import type { Env } from '../types.js';
import { toUint8 } from './bytes.js';
import { openSecret, sealSecret } from './encryption.js';
import { callbackUrl, GoogleCalendarError, googleConfigured, googleJson, hashState, pkceVerifier, randomState, textInput } from './google-calendar-common.js';
import { GOOGLE_CONSENT_VERSION, googleCapabilities, googleDisclosure, googlePolicy, googleScopes, type GoogleCapability } from './google-calendar-policy.js';

interface Account {
  user_id: string; version: number; status: string; email: string | null; google_subject: string | null;
  credential_ct: unknown; credential_dek: unknown; credential_iv: unknown; credential_revision: number; scopes_json: string;
}
interface Credential { userId: string; subject: string; version: number; refreshToken: string; accessToken: string; expiresAt: number }
export interface AppGoogleAuthorization {
  account_version: number; authorization_version: number; capabilities_json: string; contract_hash: string;
  consent_version: number; consented_at: number | null;
}
export interface OAuthState {
  state_hash: string;
  app_id: string; user_id: string; account_version: number; authorization_version: number;
  callback_url: string; return_to: string; expires_at: number; consumed_at: number | null;
  capabilities_json: string; contract_hash: string; disclosure_json: string | null; browser_hash: string | null; consented_at: number | null;
}
export const account = (env: Env, userId: string) => env.DB.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').bind(userId).first<Account>();
async function appAuthorization(env: Env, appId: string, userId: string) {
  return env.DB.prepare(`SELECT auth.* FROM google_calendar_app_authorizations auth
    JOIN google_calendar_accounts a ON a.user_id = auth.user_id AND a.version = auth.account_version AND a.status = 'connected'
    JOIN app_connectors k ON k.app_id = auth.app_id AND k.kind = 'google_calendar' AND k.contract_hash = auth.contract_hash
    WHERE auth.app_id = ? AND auth.user_id = ?
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users d WHERE d.app_id = auth.app_id AND d.user_id = auth.user_id)`)
    .bind(appId, userId).first<AppGoogleAuthorization>();
}
export async function accountStatus(env: Env, appId: string, userId: string) {
  const auth = await appAuthorization(env, appId, userId), row = auth ? await account(env, userId) : null;
  return { configured: googleConfigured(env), connected: !!auth, email: row?.email ?? null, version: row?.version ?? 0,
    authorization_version: auth?.authorization_version ?? 0, capabilities: auth ? JSON.parse(auth.capabilities_json) as GoogleCapability[] : [],
    consent_version: auth?.consent_version ?? 0, consented_at: auth?.consented_at ?? null };
}
export async function requireAppAuthorization(env: Env, appId: string, userId: string, capability: GoogleCapability = 'calendar.read') {
  const auth = await appAuthorization(env, appId, userId);
  if (!auth) throw new GoogleCalendarError('reconnect_required', 409);
  if (!googleCapabilities(JSON.parse(auth.capabilities_json)).includes(capability)) throw new GoogleCalendarError('capability_not_granted', 403);
  return auth;
}
export async function assertAppAuthorization(env: Env, appId: string, userId: string, expected: AppGoogleAuthorization) {
  const current = await requireAppAuthorization(env, appId, userId);
  if (current.account_version !== expected.account_version || current.authorization_version !== expected.authorization_version) throw new GoogleCalendarError('connection_changed', 409);
}
function configured(env: Env) {
  if (!googleConfigured(env)) throw new GoogleCalendarError('google_not_configured', 503);
}
async function seal(env: Env, credential: Credential) { return sealSecret(JSON.stringify(credential), env.APP_SECRET_KEK!); }

/** Credentials remain platform-held. A refresh may never overwrite a newer consent. */
export async function accountToken(env: Env, userId: string, expectedVersion?: number, attempt = 0): Promise<string> {
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
  if (typeof token.scope === 'string' && !(JSON.parse(row.scopes_json) as string[]).every(s => token.scope.split(' ').includes(s))) throw new GoogleCalendarError('missing_google_permissions');
  credential.accessToken = token.access_token;
  credential.expiresAt = Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000;
  const sealed = await seal(env, credential);
  const saved = await env.DB.prepare("UPDATE google_calendar_accounts SET credential_ct = ?, credential_dek = ?, credential_iv = ?, credential_revision = credential_revision + 1 WHERE user_id = ? AND version = ? AND credential_revision = ? AND status = 'connected'")
    .bind(sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, userId, row.version, row.credential_revision).run();
  if (!saved.meta.changes) {
    if (!attempt) return accountToken(env, userId, row.version, 1);
    throw new GoogleCalendarError('connection_changed', 409);
  }
  return credential.accessToken;
}

function appUrl(appId: string, path: unknown): string {
  const value = textInput(path, /^\/(?!\/)[^\\#\r\n]{0,1800}$/);
  const base = `https://${appId}.proappstore.online`, url = new URL(value, base);
  if (url.origin !== base || url.pathname.startsWith('/.pas/')) throw new GoogleCalendarError('invalid_return_to');
  return url.href;
}
export async function beginGoogleOAuth(env: Env, appId: string, userId: string, callback: unknown, returnTo: unknown, requested?: unknown) {
  configured(env);
  if (await env.DB.prepare('SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind(appId, userId).first()) throw new GoogleCalendarError('app_account_deleted', 403);
  const policy = await googlePolicy(env, appId);
  const declared = googleCapabilities(JSON.parse(policy.capabilities_json));
  const capabilities = requested === undefined ? declared : googleCapabilities(requested);
  if (!capabilities.every(c => declared.includes(c))) throw new GoogleCalendarError('capability_not_declared', 403);
  googleDisclosure(policy.disclosure_json ? JSON.parse(policy.disclosure_json) : null);
  const callback_url = appUrl(appId, callback), return_to = appUrl(appId, returnTo);
  const now = Date.now(), state = randomState();
  await env.DB.prepare('INSERT OR IGNORE INTO google_calendar_accounts (user_id, updated_at) VALUES (?, ?)').bind(userId, now).run();
  const row = (await account(env, userId))!;
  const auth = await env.DB.prepare('SELECT authorization_version FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ?').bind(appId, userId).first<{ authorization_version: number }>();
  await env.DB.prepare('DELETE FROM google_calendar_oauth_states WHERE state_hash IN (SELECT state_hash FROM google_calendar_oauth_states WHERE expires_at < ? LIMIT 100)').bind(now - 86_400_000).run();
  const pending = await env.DB.prepare(`INSERT INTO google_calendar_oauth_states
    (state_hash, app_id, user_id, account_version, authorization_version, callback_url, return_to, expires_at, capabilities_json, contract_hash, disclosure_json)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
    .bind(await hashState(state), appId, userId, row.version, auth?.authorization_version ?? 0, callback_url, return_to, now + 600_000, JSON.stringify(capabilities), policy.contract_hash, policy.disclosure_json, appId, userId).run();
  if (!pending.meta.changes) throw new GoogleCalendarError('app_account_deleted', 403);
  return { authorization_url: `${(env.APP_BASE || 'https://api.proappstore.online').replace(/\/$/, '')}/v1/connectors/google-calendar/consent?state=${state}` };
}
export async function oauthState(env: Env, state: unknown): Promise<OAuthState> {
  const value = textInput(state, /^[A-Za-z0-9_-]{43}$/);
  const row = await env.DB.prepare('SELECT * FROM google_calendar_oauth_states WHERE state_hash = ?').bind(await hashState(value)).first<OAuthState>();
  if (!row || row.consumed_at !== null || row.expires_at <= Date.now()) throw new GoogleCalendarError('expired_or_used_callback', 409);
  const policy = await googlePolicy(env, row.app_id);
  if (policy.contract_hash !== row.contract_hash) throw new GoogleCalendarError('connector_contract_changed', 409);
  return row;
}
export async function googleAuthorizationUrl(env: Env, state: string, pending: OAuthState) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: callbackUrl(env), response_type: 'code', scope: googleScopes(googleCapabilities(JSON.parse(pending.capabilities_json))).join(' '),
    include_granted_scopes: 'true', access_type: 'offline', prompt: 'consent', state,
    code_challenge_method: 'S256', code_challenge: await hashState(await pkceVerifier(env, state)) }).toString();
  return url.href;
}

/** Both platform browser consent and authenticated initiating app/user are mandatory. */
export async function completeGoogleOAuth(env: Env, appId: string, userId: string, state: unknown, code: unknown) {
  configured(env);
  const row = await oauthState(env, state);
  const authCode = textInput(code, /^[^\s]{1,4096}$/);
  if (row.app_id !== appId || row.user_id !== userId) throw new GoogleCalendarError('forbidden', 403);
  if (row.consented_at === null || !row.browser_hash) throw new GoogleCalendarError('platform_consent_required', 403);
  const stateHash = await hashState(state as string);
  const claimed = await env.DB.prepare('UPDATE google_calendar_oauth_states SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?').bind(Date.now(), stateHash, Date.now()).run();
  if (!claimed.meta.changes) throw new GoogleCalendarError('expired_or_used_callback', 409);
  const token = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: callbackUrl(env), code: authCode, grant_type: 'authorization_code', code_verifier: await pkceVerifier(env, state as string) }),
  });
  const scopes = new Set(String(token.scope ?? '').split(' '));
  const required = googleScopes(googleCapabilities(JSON.parse(row.capabilities_json))).filter(s => s.startsWith('https://'));
  if (!required.every(s => scopes.has(s))) throw new GoogleCalendarError('missing_google_permissions');
  if (typeof token.refresh_token !== 'string' || !token.refresh_token || typeof token.access_token !== 'string' || !token.access_token) throw new GoogleCalendarError('reconnect_required', 409);
  const profile = await googleJson('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (typeof profile.sub !== 'string' || !/^\d+$/.test(profile.sub) || profile.email_verified !== true || typeof profile.email !== 'string') throw new GoogleCalendarError('google_identity_unverified');
  const current = await account(env, userId);
  if (!current || current.version !== row.account_version) throw new GoogleCalendarError('connection_changed', 409);
  const connected = current.status === 'connected';
  if (connected && current.google_subject !== profile.sub) throw new GoogleCalendarError('google_account_mismatch', 409);
  if (connected && !(JSON.parse(current.scopes_json) as string[]).every(s => scopes.has(s))) throw new GoogleCalendarError('missing_google_permissions');
  const version = connected ? current.version : current.version + 1;
  const authorizationVersion = row.authorization_version + 1;
  const retainedScopes = [...new Set([...required, ...(connected ? JSON.parse(current.scopes_json) as string[] : [])])];
  const sealed = await seal(env, { userId, subject: profile.sub, version, refreshToken: token.refresh_token, accessToken: token.access_token, expiresAt: Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000 });
  const [saved, authorized] = await env.DB.batch([
    env.DB.prepare(`UPDATE google_calendar_accounts SET version = ?, status = 'connected', google_subject = ?, email = ?, credential_ct = ?, credential_dek = ?, credential_iv = ?, updated_at = ?, scopes_json = ?, credential_revision = credential_revision + 1
      WHERE user_id = ? AND version = ? AND credential_revision = ?
      AND EXISTS (SELECT 1 FROM google_calendar_oauth_states s JOIN app_connectors k ON k.app_id = s.app_id AND k.kind = 'google_calendar' AND k.contract_hash = s.contract_hash WHERE s.state_hash = ? AND s.consumed_at IS NOT NULL)
      AND COALESCE((SELECT authorization_version FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ?), 0) = ?
      AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
      .bind(version, profile.sub, profile.email, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now(), JSON.stringify(retainedScopes), userId, row.account_version, current.credential_revision, stateHash, appId, userId, row.authorization_version, appId, userId),
    env.DB.prepare(`INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version, authorization_version, capabilities_json, contract_hash, disclosure_json, consent_version, consented_at)
      SELECT app_id, user_id, ?, ?, capabilities_json, contract_hash, disclosure_json, ?, consented_at FROM google_calendar_oauth_states WHERE state_hash = ? AND changes() = 1
      ON CONFLICT(app_id, user_id) DO UPDATE SET account_version = excluded.account_version, authorization_version = excluded.authorization_version,
      capabilities_json = excluded.capabilities_json, contract_hash = excluded.contract_hash, disclosure_json = excluded.disclosure_json, consent_version = excluded.consent_version, consented_at = excluded.consented_at`)
      .bind(version, authorizationVersion, GOOGLE_CONSENT_VERSION, stateHash),
    env.DB.prepare('DELETE FROM google_calendar_grants WHERE app_id = ? AND user_id = ? AND changes() > 0').bind(appId, userId),
  ]);
  if (!saved?.meta.changes || !authorized?.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { return_to: new URL(row.return_to).pathname + new URL(row.return_to).search, email: profile.email };
}
export async function disconnectGoogleApp(env: Env, appId: string, userId: string, expectedVersion: unknown) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const result = await env.DB.prepare('DELETE FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ? AND authorization_version = ?').bind(appId, userId, expectedVersion).run();
  if (!result.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}
export async function disconnectGoogleAccount(env: Env, userId: string, expectedVersion: unknown) {
  if (!Number.isSafeInteger(expectedVersion)) throw new GoogleCalendarError('invalid_version');
  const changed = await env.DB.prepare("UPDATE google_calendar_accounts SET version = version + 1, status = 'disconnected', google_subject = NULL, email = NULL, credential_ct = NULL, credential_dek = NULL, credential_iv = NULL, scopes_json = '[]', credential_revision = credential_revision + 1, updated_at = ? WHERE user_id = ? AND version = ?")
    .bind(Date.now(), userId, expectedVersion).run();
  if (!changed.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
  return { disconnected: true };
}
