import type { Env } from '../types.js';
import { account, sealCredential } from './google-calendar-credentials.js';
import { callbackUrl, GoogleCalendarError, googleJson, hashState, pkceVerifier, randomState, requireGoogleConfiguration, textInput } from './google-calendar-common.js';
import { GOOGLE_CONSENT_VERSION, googleCapabilities, googleDisclosure, googlePolicy, googleScopes } from './google-calendar-policy.js';

export interface OAuthState {
  state_hash: string;
  app_id: string; user_id: string; account_version: number; account_status: 'connected' | 'disconnected'; authorization_version: number;
  callback_url: string; return_to: string; expires_at: number; consumed_at: number | null;
  capabilities_json: string; contract_hash: string; disclosure_json: string | null; browser_hash: string | null; browser_verified_at: number | null; consented_at: number | null;
}
function appUrl(appId: string, path: unknown): string {
  const value = textInput(path, /^\/(?!\/)[^\\#\r\n]{0,1800}$/);
  const base = `https://${appId}.proappstore.online`, url = new URL(value, base);
  if (url.origin !== base || url.pathname.startsWith('/.pas/')) throw new GoogleCalendarError('invalid_return_to');
  return url.href;
}
export async function beginGoogleOAuth(env: Env, appId: string, userId: string, callback: unknown, returnTo: unknown, requested?: unknown) {
  requireGoogleConfiguration(env);
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
    (state_hash, app_id, user_id, account_version, authorization_version, callback_url, return_to, expires_at, capabilities_json, contract_hash, disclosure_json, account_status)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM app_connectors k JOIN apps a ON a.id = k.app_id
      WHERE k.app_id = ? AND k.kind = 'google_calendar' AND k.contract_hash = ? AND a.creator_id = ?)
    AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
    .bind(await hashState(state), appId, userId, row.version, auth?.authorization_version ?? 0, callback_url, return_to, now + 600_000, JSON.stringify(capabilities), policy.contract_hash, policy.disclosure_json, row.status, appId, policy.contract_hash, policy.creator_id, appId, userId).run();
  if (!pending.meta.changes) throw new GoogleCalendarError('connection_changed', 409);
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
  requireGoogleConfiguration(env);
  const row = await oauthState(env, state);
  const authCode = textInput(code, /^[^\s]{1,4096}$/);
  if (row.app_id !== appId || row.user_id !== userId) throw new GoogleCalendarError('forbidden', 403);
  if (row.consented_at === null || !row.browser_hash || row.browser_verified_at === null) throw new GoogleCalendarError('platform_consent_required', 403);
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
  await persistConsent(env, row, stateHash, {
    subject: profile.sub, email: profile.email, accessToken: token.access_token, refreshToken: token.refresh_token,
    expiresAt: Date.now() + Math.min(Number(token.expires_in) || 0, 3600) * 1000, scopes,
  });
  return { return_to: new URL(row.return_to).pathname + new URL(row.return_to).search, email: profile.email };
}

interface ConsentCredential {
  subject: string; email: string; accessToken: string; refreshToken: string; expiresAt: number; scopes: Set<string>;
}

/** Retry the encrypted save, never the one-use Google code exchange. */
async function persistConsent(env: Env, row: OAuthState, stateHash: string, credential: ConsentCredential) {
  const { app_id: appId, user_id: userId } = row;
  const required = googleScopes(googleCapabilities(JSON.parse(row.capabilities_json))).filter(s => s.startsWith('https://'));
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await account(env, userId);
    if (!current) throw new GoogleCalendarError('connection_changed', 409);
    const connected = current.status === 'connected';
    const sameEpoch = current.version === row.account_version;
    const firstConnectionWon = row.account_status === 'disconnected' && connected && current.version === row.account_version + 1;
    if (!sameEpoch && !firstConnectionWon) throw new GoogleCalendarError('connection_changed', 409);
    if (connected && current.google_subject !== credential.subject) throw new GoogleCalendarError('google_account_mismatch', 409);
    const previousScopes = connected ? JSON.parse(current.scopes_json) as string[] : [];
    if (!previousScopes.every(scope => credential.scopes.has(scope))) throw new GoogleCalendarError('missing_google_permissions');
    const version = connected ? current.version : current.version + 1;
    const authorizationVersion = row.authorization_version + 1;
    const retainedScopes = [...new Set([...required, ...previousScopes])];
    const sealed = await sealCredential(env, { userId, subject: credential.subject, version, refreshToken: credential.refreshToken, accessToken: credential.accessToken, expiresAt: credential.expiresAt });
    const [saved, authorized] = await env.DB.batch([
      env.DB.prepare(`UPDATE google_calendar_accounts SET version = ?, status = 'connected', google_subject = ?, email = ?, credential_ct = ?, credential_dek = ?, credential_iv = ?, updated_at = ?, scopes_json = ?, credential_revision = credential_revision + 1
        WHERE user_id = ? AND version = ? AND credential_revision = ?
        AND EXISTS (SELECT 1 FROM google_calendar_oauth_states s JOIN app_connectors k ON k.app_id = s.app_id AND k.kind = 'google_calendar' AND k.contract_hash = s.contract_hash WHERE s.state_hash = ? AND s.consumed_at IS NOT NULL)
        AND COALESCE((SELECT authorization_version FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ?), 0) = ?
        AND NOT EXISTS (SELECT 1 FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?)`)
        .bind(version, credential.subject, credential.email, sealed.keyCiphertext, sealed.dekWrapped, sealed.iv, Date.now(), JSON.stringify(retainedScopes), userId, current.version, current.credential_revision, stateHash, appId, userId, row.authorization_version, appId, userId),
      env.DB.prepare(`INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version, authorization_version, capabilities_json, contract_hash, disclosure_json, consent_version, consented_at)
        SELECT app_id, user_id, ?, ?, capabilities_json, contract_hash, disclosure_json, ?, consented_at FROM google_calendar_oauth_states WHERE state_hash = ? AND changes() = 1
        ON CONFLICT(app_id, user_id) DO UPDATE SET account_version = excluded.account_version, authorization_version = excluded.authorization_version,
        capabilities_json = excluded.capabilities_json, contract_hash = excluded.contract_hash, disclosure_json = excluded.disclosure_json, consent_version = excluded.consent_version, consented_at = excluded.consented_at`)
        .bind(version, authorizationVersion, GOOGLE_CONSENT_VERSION, stateHash),
      env.DB.prepare('DELETE FROM google_calendar_grants WHERE app_id = ? AND user_id = ? AND changes() > 0').bind(appId, userId),
    ]);
    if (saved?.meta.changes && authorized?.meta.changes) return;
    const latest = await account(env, userId);
    // Contract changes, deletion and same-app reconnects still fail closed.
    // Only a changed shared credential can make retrying this CAS useful.
    if (!latest || latest.credential_revision === current.credential_revision) break;
  }
  throw new GoogleCalendarError('connection_changed', 409);
}
